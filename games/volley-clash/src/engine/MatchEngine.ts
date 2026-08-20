/**
 * The whole match: physics, rules, power-ups and rendering.
 *
 * Two things shape this file more than anything else.
 *
 * 1. **Fixed timestep.** Everything runs at 120 Hz through an accumulator, so a
 *    144 Hz monitor and a 60 Hz laptop play the same game. It also guarantees
 *    the ball never moves further in one step than its own radius, which is
 *    what makes floor detection reliable at spike speed.
 *
 * 2. **The host is the authority.** PlayBuddies is a static site with no game
 *    server, so one of the players is the server. The host runs every rule;
 *    everyone else runs the same physics purely so the picture is smooth, and
 *    is continuously corrected toward the host's snapshots. Rules — points,
 *    phase changes, power-up spawns — are host-only, and guarded as such.
 */
import { bakeCourt, drawFallbackCourt } from '../game/court';
import { CHARACTERS, drawCharacter } from '../game/characters';
import { Arena, BALANCE, POWER_META, TEAM_COLORS, clamp } from '../game/rules';
import { newBrain, thinkFor } from './ai';
import type { Quality } from '../game/quality';
import {
  ActivePower,
  Ball,
  Control,
  FloatingPower,
  Input,
  NO_INPUT,
  Phase,
  Player,
  PowerKind,
  Snapshot,
  Team,
} from '../types/game';

export interface Seat {
  id: string;
  name: string;
  team: Team;
  character: number;
  control: Control;
  aiLevel?: number;
}

export interface EngineConfig {
  arena: Arena;
  seats: Seat[];
  targetPoints: number;
  winByTwo: boolean;
  powerUps: boolean;
  /** Multiplier on how often power-ups drop. 1 is the stock pace. */
  powerRate: number;
  isHost: boolean;
  onPoint?: (team: Team, score: [number, number], call: string) => void;
  onOver?: (team: Team) => void;
  onHit?: (power: number) => void;
  onWhistle?: () => void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

const POWER_KINDS: PowerKind[] = ['rocket', 'feather', 'giant', 'freeze'];

export class MatchEngine {
  readonly arena: Arena;
  readonly players: Player[] = [];
  readonly ball: Ball;

  score: [number, number] = [0, 0];
  phase: Phase = 'serve';
  phaseTimer: number = BALANCE.SERVE_DELAY;
  serving: Team = 0;
  winner: Team | null = null;
  /** Big centred text — "SPIKE!", "MATCH POINT". Fades on its own. */
  call = '';
  callLeft = 0;

  powers: ActivePower[] = [];
  floating: FloatingPower[] = [];

  private cfg: EngineConfig;
  private backdrop: HTMLCanvasElement | null = null;
  private acc = 0;
  private shake = 0;
  private particles: Particle[] = [];
  private trail: { x: number; y: number }[] = [];
  private powerTimer = 0;
  /** Multiplier on every particle burst, set once a frame from the governor. */
  private budget = 1;
  /** Touches in the current rally, for the ACE call. */
  private touches = 0;
  /** True until the serve has been struck. See BALANCE.SERVE_BONUS. */
  private serveShot = false;
  private lastPower = 0;
  private tick = 0;

  // Viewport → world transform, recomputed on resize.
  private scale = 1;
  private offX = 0;
  private offY = 0;

  /** Targets from the newest snapshot. Empty on the host. */
  private target: { ball: Ball | null; players: Map<string, { x: number; y: number; r: number }> } = {
    ball: null,
    players: new Map(),
  };

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
    this.arena = cfg.arena;
    this.ball = { x: cfg.arena.netX, y: cfg.arena.floor - 320, vx: 0, vy: 0, spin: 0, lastTeam: null, lastHitter: null };

    for (const seat of cfg.seats) this.players.push(this.makePlayer(seat));
    this.backdrop = bakeCourt(this.arena);
    this.resetPositions();
    this.serveBall();
    this.armPowerTimer();
  }

  // ── setup ─────────────────────────────────────────────────────────────────

  private makePlayer(seat: Seat): Player {
    return {
      id: seat.id,
      team: seat.team,
      name: seat.name,
      character: clamp(seat.character, 0, CHARACTERS.length - 1),
      control: seat.control,
      aiLevel: seat.aiLevel ?? 1,
      x: 0,
      y: this.arena.floor,
      vx: 0,
      vy: 0,
      r: BALANCE.PLAYER_R,
      facing: seat.team === 0 ? 1 : -1,
      onGround: true,
      jumpHeld: -1,
      dashLeft: 0,
      dashCd: 0,
      airDashUsed: false,
      hitCd: 0,
      brain: newBrain(),
    };
  }

  /** A seat whose human left is handed to the AI rather than left standing still. */
  handOverToAI(id: string, level = 1) {
    const p = this.players.find((q) => q.id === id);
    if (!p || p.control === 'ai') return;
    p.control = 'ai';
    p.aiLevel = level;
    p.name = `${p.name} (bot)`;
  }

  private resetPositions() {
    const { netX, w, floor } = this.arena;
    for (const team of [0, 1] as Team[]) {
      const mates = this.players.filter((p) => p.team === team);
      mates.forEach((p, i) => {
        // Two per side stagger front and back; one per side stands mid-court.
        const t = mates.length > 1 ? (i === 0 ? 0.55 : 0.22) : 0.46;
        p.x = team === 0 ? netX * t : w - netX * t;
        p.y = floor;
        p.vx = 0;
        p.vy = 0;
        p.onGround = true;
        p.jumpHeld = -1;
        p.dashLeft = 0;
        p.dashCd = 0;
        p.airDashUsed = false;
        p.hitCd = 0;
        p.facing = team === 0 ? 1 : -1;
        p.r = BALANCE.PLAYER_R;
      });
    }
  }

  private serveBall() {
    const { netX, w, floor } = this.arena;
    // Directly above whoever is serving.
    //
    // It used to drop at a fixed spot the server then had to run to, and since
    // the *conceding* side serves, a team that dropped one point was handed a
    // scramble every single rally after it. AI-vs-AI that produced 7–0 sweeps
    // decided by who lost the first point. Dropping it on their head makes the
    // serve neutral, which is the only version of "loser serves" that is fair.
    const server = this.players.find((p) => p.team === this.serving);
    this.ball.x = server ? server.x : this.serving === 0 ? netX * 0.5 : w - netX * 0.5;
    this.ball.y = floor - 330;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.ball.spin = 0;
    this.ball.lastTeam = null;
    this.ball.lastHitter = null;
    this.trail.length = 0;
    this.touches = 0;
    this.serveShot = true;
  }

  private armPowerTimer() {
    const gap =
      BALANCE.POWER_EVERY_MIN + Math.random() * (BALANCE.POWER_EVERY_MAX - BALANCE.POWER_EVERY_MIN);
    // The setting is a *frequency* multiplier, so it divides the wait: 2 means
    // twice as often, which is half the gap. Guarded against zero so a slider
    // dragged to the bottom cannot produce an infinite timer.
    this.powerTimer = gap / Math.max(0.05, this.cfg.powerRate);
  }

  /** Lets the settings panel retune a match already in progress. */
  setPowerRate(rate: number) {
    const previous = this.cfg.powerRate;
    this.cfg.powerRate = rate;
    // Rescale whatever is left to run, so dragging the slider takes effect on
    // the pending drop instead of only on the one after it.
    if (previous > 0 && rate > 0) this.powerTimer *= previous / rate;
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  /**
   * Advances the world by real elapsed time.
   *
   * `inputs` carries one entry per human seat — local seats from the keyboard
   * or touch controls, remote seats from the network. AI seats are filled in
   * here, so a caller never has to know which is which.
   */
  update(elapsed: number, inputs: Map<string, Input>) {
    // Real time, always. Match point used to run at 0.72x as "theatre", but the
    // condition that triggered it latched on for the whole end of the match
    // rather than firing for a moment, so the game simply went sluggish from
    // roughly match point onward and never recovered.
    this.acc += Math.min(elapsed, 0.25);

    let steps = 0;
    while (this.acc >= BALANCE.FIXED_DT && steps < BALANCE.MAX_STEPS) {
      this.step(BALANCE.FIXED_DT, inputs);
      this.acc -= BALANCE.FIXED_DT;
      steps++;
    }
    // A tab that was hidden for a minute must not then run a minute of physics.
    if (steps === BALANCE.MAX_STEPS) this.acc = 0;

    this.shake *= Math.pow(0.02, elapsed);
    this.callLeft = Math.max(0, this.callLeft - elapsed);
    if (!this.cfg.isHost) this.reconcile(elapsed, inputs);
  }

  private step(dt: number, inputs: Map<string, Input>) {
    this.tick++;

    if (this.phase === 'point' || this.phase === 'serve') {
      this.phaseTimer -= dt;
      if (this.cfg.isHost && this.phaseTimer <= 0) {
        if (this.phase === 'point') this.beginServe();
        else this.phase = 'rally';
      }
    }

    for (const p of this.players) {
      const input = p.control === 'ai' ? this.aiInput(p, dt) : (inputs.get(p.id) ?? NO_INPUT);
      this.movePlayer(p, input, dt);
    }
    this.separatePlayers();

    // The ball keeps moving through the point delay so its bounce plays out
    // on screen; `contact` is rally-only, so nobody can touch it once the point
    // has been awarded.
    if (this.phase === 'rally' || this.phase === 'point') this.moveBall(dt);
    if (this.phase === 'rally') this.movePowerUps(dt);
    for (const p of this.players) this.contact(p);

    this.expirePowers(dt);
    this.stepParticles(dt);
  }

  private aiInput(p: Player, dt: number): Input {
    if (this.phase === 'over') return NO_INPUT;
    const mates = this.players.filter((q) => q.team === p.team);
    const serveTeam = this.phase === 'serve' ? this.serving : null;
    return thinkFor(p, this.ball, this.arena, dt, mates, this.ballGravity(), serveTeam);
  }

  // ── players ───────────────────────────────────────────────────────────────

  private movePlayer(p: Player, input: Input, dt: number) {
    // Characters are skins. Freeze is the only thing that changes how a body
    // moves, and it applies to a whole team at once.
    const mobility = this.hasPower('freeze', p.team === 0 ? 1 : 0) ? BALANCE.POWER_FREEZE_SLOW : 1;

    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (dir !== 0) p.facing = dir > 0 ? 1 : -1;

    if (p.dashLeft > 0) {
      p.dashLeft -= dt;
      p.vx = p.facing * BALANCE.DASH_SPEED;
    } else {
      const accel = (p.onGround ? BALANCE.RUN_ACCEL : BALANCE.AIR_ACCEL) * mobility;
      const cap = BALANCE.MAX_RUN * mobility;
      if (dir !== 0) {
        p.vx += dir * accel * dt;
        p.vx = clamp(p.vx, -cap, cap);
      } else if (p.onGround) {
        const drop = BALANCE.FRICTION * dt;
        p.vx = Math.abs(p.vx) <= drop ? 0 : p.vx - Math.sign(p.vx) * drop;
      }
    }

    p.dashCd = Math.max(0, p.dashCd - dt);
    if (input.dash && p.dashCd <= 0 && !(!p.onGround && p.airDashUsed)) {
      p.dashLeft = BALANCE.DASH_TIME;
      p.dashCd = BALANCE.DASH_COOLDOWN;
      if (!p.onGround) p.airDashUsed = true;
      this.puff(p.x, p.y, TEAM_COLORS[p.team].light, 8, 130);
    }

    // Variable-height jump: the initial impulse is fixed — all characters jump
    // the same height so nobody is at a fundamental disadvantage. The hold
    // extension (JUMP_HOLD_ACCEL) adds a tiny extra arc if the key stays down,
    // which is what makes a set feel different from a spike.
    if (input.jump && p.onGround) {
      p.vy = -BALANCE.JUMP_V;
      p.onGround = false;
      p.jumpHeld = 0;
      this.puff(p.x, p.y, '#fde68a', 6, 110);
    } else if (!p.onGround && p.jumpHeld >= 0) {
      if (input.jump && p.jumpHeld < BALANCE.JUMP_HOLD) {
        p.vy -= BALANCE.JUMP_HOLD_ACCEL * dt;
        p.jumpHeld += dt;
      } else {
        p.jumpHeld = -1;
      }
    }

    p.vy += BALANCE.PLAYER_GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    if (p.y >= this.arena.floor) {
      if (!p.onGround && p.vy > 700) this.puff(p.x, this.arena.floor, '#e7c489', 7, 150);
      p.y = this.arena.floor;
      p.vy = 0;
      p.onGround = true;
      p.airDashUsed = false;
      p.jumpHeld = -1;
    }

    p.r = BALANCE.PLAYER_R * (this.hasPower('giant', p.team) ? BALANCE.POWER_GIANT_SCALE : 1);

    // Nobody crosses the net. Clamping is enough — a player pressing into it
    // simply stops, which is the behaviour every volleyball game has.
    const { netX, netW, w } = this.arena;
    const lo = p.team === 0 ? p.r : netX + netW / 2 + p.r;
    const hi = p.team === 0 ? netX - netW / 2 - p.r : w - p.r;
    if (p.x < lo) {
      p.x = lo;
      if (p.vx < 0) p.vx = 0;
    } else if (p.x > hi) {
      p.x = hi;
      if (p.vx > 0) p.vx = 0;
    }

    p.hitCd = Math.max(0, p.hitCd - dt);
  }

  /** Teammates push each other apart instead of standing inside one another. */
  private separatePlayers() {
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i];
        const b = this.players[j];
        if (a.team !== b.team) continue;
        const dx = b.x - a.x;
        const min = (a.r + b.r) * 0.8;
        const dist = Math.abs(dx);
        if (dist >= min || dist === 0) continue;
        const push = (min - dist) / 2;
        const s = Math.sign(dx);
        a.x -= s * push;
        b.x += s * push;
      }
    }
  }

  // ── ball ──────────────────────────────────────────────────────────────────

  private ballGravity() {
    return BALANCE.GRAVITY * (this.hasPower('feather') ? BALANCE.POWER_FEATHER_GRAVITY : 1);
  }

  private moveBall(dt: number) {
    const b = this.ball;
    const { w, floor, netX, netW, netTop } = this.arena;
    const R = BALANCE.BALL_R;

    b.vy += this.ballGravity() * dt;

    // Magnus: spin pushes the ball perpendicular to its travel. Small, but it
    // is what makes a hit taken on the run curve rather than fly straight.
    //
    // Rotating the velocity vector is the whole implementation, and it has to
    // be exactly that — a rotation preserves speed, so spin can only ever
    // redirect the ball, never speed it up or hold it against gravity. See
    // MAGNUS_TURN for what happened when this was written as two sequential
    // component updates instead.
    if (b.spin !== 0) {
      const theta = BALANCE.MAGNUS_TURN * b.spin * dt;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const vx = b.vx;
      const vy = b.vy;
      b.vx = vx * cos - vy * sin;
      b.vy = vx * sin + vy * cos;
      b.spin *= Math.pow(BALANCE.SPIN_DECAY, dt);
    }

    const speed = Math.hypot(b.vx, b.vy);
    if (speed > BALANCE.BALL_MAX_SPEED) {
      const k = BALANCE.BALL_MAX_SPEED / speed;
      b.vx *= k;
      b.vy *= k;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    if (b.x < R) {
      b.x = R;
      b.vx = Math.abs(b.vx) * BALANCE.WALL_BOUNCE;
      this.puff(R, b.y, '#ffffff', 5, 120);
    } else if (b.x > w - R) {
      b.x = w - R;
      b.vx = -Math.abs(b.vx) * BALANCE.WALL_BOUNCE;
      this.puff(w - R, b.y, '#ffffff', 5, 120);
    }
    if (b.y < R) {
      b.y = R;
      b.vy = Math.abs(b.vy) * BALANCE.WALL_BOUNCE;
    }

    // Net: a solid bar, not a plane. Clipping the tape and dribbling over is a
    // real outcome and it is the best moment the game has.
    const nx = clamp(b.x, netX - netW / 2, netX + netW / 2);
    const ny = clamp(b.y, netTop, floor);
    const dx = b.x - nx;
    const dy = b.y - ny;
    const d = Math.hypot(dx, dy);
    if (d < R && d > 0.0001) {
      const push = (R - d) / d;
      b.x += dx * push;
      b.y += dy * push;
      const nrmX = dx / d;
      const nrmY = dy / d;
      const dot = b.vx * nrmX + b.vy * nrmY;
      b.vx = (b.vx - 2 * dot * nrmX) * BALANCE.NET_BOUNCE;
      b.vy = (b.vy - 2 * dot * nrmY) * BALANCE.NET_BOUNCE;
      this.puff(b.x, b.y, '#ffffff', 6, 160);
    }

    if (b.y >= floor - R) {
      b.y = floor - R;

      /**
       * The touch *is* the point.
       *
       * The bounce below used to gate it — the rally only ended once the ball
       * had dribbled to a near-stop, so both sides simply kept playing it off
       * the sand and AI-vs-AI rallies ran to 187 touches without a single point
       * being scored. In volleyball the floor ends the rally the instant it is
       * touched, full stop.
       *
       * The hop is kept, because a ball that dies flat looks dead — it just
       * plays out during the point delay now, after the score is already in.
       * `land()` ignores anything but the first call, and `contact()` is
       * rally-only, so nobody can play these bounces.
       */
      this.land();

      if (b.vy > 80) {
        b.vy = -Math.abs(b.vy) * BALANCE.FLOOR_BOUNCE;
        b.vx *= 0.92;
        this.puff(b.x, floor, '#e7c489', 8, 180);
      } else {
        b.vy = 0;
        b.vx *= 0.8;
      }
    }

    this.trail.push({ x: b.x, y: b.y });
    if (this.trail.length > 16) this.trail.shift();
  }

  /** Ball down. Only the host turns that into a point. */
  private land() {
    if (this.phase !== 'rally') return;
    const scorer: Team = this.ball.x < this.arena.netX ? 1 : 0;
    this.puff(this.ball.x, this.arena.floor, '#e7c489', 22, 260);
    this.shake = Math.max(this.shake, 7);
    if (!this.cfg.isHost) {
      // A client shows the bounce but waits to be told the score. Guessing here
      // is how two screens end up disagreeing about who won.
      this.phase = 'point';
      return;
    }
    this.awardPoint(scorer);
  }

  private awardPoint(team: Team) {
    this.score[team]++;
    this.phase = 'point';
    this.phaseTimer = BALANCE.POINT_DELAY;

    const call =
      this.touches <= 1
        ? 'ACE!'
        : this.lastPower > 0.72
          ? 'SPIKE!'
          : this.touches >= 8
            ? 'WHAT A RALLY!'
            : 'POINT';
    this.say(call);
    this.cfg.onPoint?.(team, [...this.score] as [number, number], call);
    this.cfg.onWhistle?.();

    // Loser serves. The reverse of real volleyball, and deliberate — it stops a
    // good server from running away with a seven-point match.
    this.serving = team === 0 ? 1 : 0;

    if (this.wins(team) || this.score[team] >= BALANCE.HARD_CAP) {
      this.phase = 'over';
      this.winner = team;
      this.say(`${TEAM_COLORS[team].name.toUpperCase()} WINS`);
      this.cfg.onOver?.(team);
    }
  }

  private beginServe() {
    this.phase = 'serve';
    this.phaseTimer = BALANCE.SERVE_DELAY;
    this.powers.length = 0;
    this.floating.length = 0;
    this.resetPositions();
    this.serveBall();
    this.armPowerTimer();
    if (this.isMatchPoint()) this.say('MATCH POINT');
  }

  // ── contact ───────────────────────────────────────────────────────────────

  /**
   * A hit is contact, not a button.
   *
   * The outgoing direction is the vector from the player's centre to the ball,
   * which gives the whole control scheme for free: ball above your head goes
   * up (a set), ball off your shoulder goes sideways (a pass), and a ball you
   * have jumped above goes down (a spike). Nothing about that has to be taught.
   */
  private contact(p: Player) {
    if (this.phase !== 'rally' || p.hitCd > 0) return;
    const b = this.ball;
    let dx = b.x - p.x;
    let dy = b.y - p.y;
    const min = p.r + BALANCE.BALL_R;
    const dist = Math.hypot(dx, dy);
    if (dist >= min) return;

    if (dist < 0.001) {
      dx = 0;
      dy = -1;
    } else {
      dx /= dist;
      dy /= dist;
    }

    // On the ground you cannot bury the ball into your own sand. That single
    // clamp is what teaches "spikes happen in the air".
    if (p.onGround && dy > -BALANCE.GROUND_LIFT) {
      dy = -BALANCE.GROUND_LIFT;
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
    }

    const incoming = Math.hypot(b.vx, b.vy);
    // Rocket is the only thing that changes hit power now that the charge meter
    // is gone, and it multiplies the shot directly instead of faking a full
    // wind-up.
    const rocket = this.hasPower('rocket', p.team);
    const power = (rocket ? BALANCE.POWER_ROCKET_HIT : 1) * (this.serveShot ? BALANCE.SERVE_BONUS : 1);
    this.serveShot = false;
    const speed = Math.min(
      BALANCE.BALL_MAX_SPEED,
      BALANCE.HIT_BASE * power + incoming * BALANCE.HIT_RETURN,
    );

    b.x = p.x + dx * (min + 1);
    b.y = p.y + dy * (min + 1);
    b.vx = dx * speed + p.vx * BALANCE.HIT_CARRY;
    b.vy = dy * speed + p.vy * BALANCE.HIT_CARRY * 0.5;

    // The pop. Every touch lifts the ball, on top of whatever the contact
    // normal did — a volleyball coming off a forearm goes *up*, and without
    // this a slightly-off contact skidded away flat and killed the rally.
    // A downward spike keeps most of its bite: it is scaled back, not cancelled.
    // Only balls that are already heading up get the pop. Lifting a downward
    // spike as well was softening the one shot that is supposed to end a rally.
    if (b.vy < 0) {
      b.vy -= BALANCE.BOUNCE_LIFT;
      if (b.vy < -BALANCE.MAX_UP) b.vy = -BALANCE.MAX_UP;
    }

    b.spin = clamp(p.vx * BALANCE.SPIN_FROM_HIT, -BALANCE.MAX_SPIN, BALANCE.MAX_SPIN);
    b.lastTeam = p.team;
    b.lastHitter = p.id;

    p.hitCd = BALANCE.HIT_COOLDOWN;
    this.touches++;

    const outgoing = Math.hypot(b.vx, b.vy);
    const heat = clamp(outgoing / BALANCE.BALL_MAX_SPEED, 0, 1);
    this.lastPower = heat;

    if (rocket) this.dropPower('rocket');

    this.shake = Math.max(this.shake, heat * 9);
    this.puff(b.x, b.y, TEAM_COLORS[p.team].light, 6 + Math.round(heat * 14), 120 + heat * 260);
    this.cfg.onHit?.(heat);
    // A spike is now a fact about the ball rather than about a held key: fast,
    // and heading down into the other half.
    if (heat > 0.7 && b.vy > 120) this.say('SPIKE!');
    else if (this.touches === 6) this.say('RALLY x6');
  }

  // ── power-ups ─────────────────────────────────────────────────────────────

  private movePowerUps(dt: number) {
    if (!this.cfg.powerUps) return;

    // Host only: two machines rolling their own spawns would place them in
    // different halves and hand the match to whoever's screen you watched.
    // Never in the opening rally: the first point of a match should be a clean
    // test of who can actually play, with nothing falling out of the sky.
    const opening = this.score[0] + this.score[1] === 0;
    if (this.cfg.isHost && this.touches > 0 && !opening) {
      this.powerTimer -= dt;
      if (this.powerTimer <= 0) {
        this.armPowerTimer();
        this.floating.push({
          kind: POWER_KINDS[Math.floor(Math.random() * POWER_KINDS.length)],
          x: this.arena.w * (0.16 + Math.random() * 0.68),
          y: 70,
          vy: BALANCE.POWER_FALL,
          spin: Math.random() * Math.PI * 2,
        });
      }
    }

    for (let i = this.floating.length - 1; i >= 0; i--) {
      const f = this.floating[i];
      f.y += f.vy * dt;
      f.spin += dt * 2;
      if (f.y > this.arena.floor - BALANCE.POWER_R) {
        this.floating.splice(i, 1);
        continue;
      }
      // The *ball* collects it, so the reward goes to whoever kept the rally
      // alive rather than to whoever happened to be standing underneath.
      const d = Math.hypot(this.ball.x - f.x, this.ball.y - f.y);
      if (d < BALANCE.POWER_R + BALANCE.BALL_R && this.ball.lastTeam !== null) {
        this.grantPower(f.kind, this.ball.lastTeam);
        this.puff(f.x, f.y, POWER_META[f.kind].color, 20, 240);
        this.floating.splice(i, 1);
      }
    }
  }

  private grantPower(kind: PowerKind, team: Team) {
    this.dropPower(kind);
    this.powers.push({ kind, team, left: BALANCE.DURATION[kind] });
    this.say(POWER_META[kind].label.toUpperCase() + '!');
  }

  private dropPower(kind: PowerKind) {
    const i = this.powers.findIndex((p) => p.kind === kind);
    if (i >= 0) this.powers.splice(i, 1);
  }

  private expirePowers(dt: number) {
    for (let i = this.powers.length - 1; i >= 0; i--) {
      const p = this.powers[i];
      if (p.left === Infinity) continue;
      p.left -= dt;
      if (p.left <= 0) this.powers.splice(i, 1);
    }
  }

  /** `team` omitted means "is this power up at all, for anyone". */
  hasPower(kind: PowerKind, team?: Team) {
    return this.powers.some((p) => p.kind === kind && (team === undefined || p.team === team));
  }

  /** Would this score take the match for `team`? */
  private wins(team: Team, score = this.score[team]): boolean {
    const other = this.score[team === 0 ? 1 : 0];
    if (score < this.cfg.targetPoints) return false;
    return this.cfg.winByTwo ? score - other >= BALANCE.WIN_BY : true;
  }

  /**
   * True only when somebody can actually win with the *next* point.
   *
   * This used to be `score >= target - 1` for either side, which is a different
   * question entirely: it latched on the moment anyone reached 6 of 7 and never
   * cleared, so at 6-6 — where under win-by-two nobody is close to winning — the
   * game still announced match point. It also drove a permanent slow motion over
   * the whole end of every match.
   */
  isMatchPoint() {
    if (this.phase === 'over') return false;
    return ([0, 1] as Team[]).some(
      (t) => this.wins(t, this.score[t] + 1) || this.score[t] + 1 >= BALANCE.HARD_CAP,
    );
  }

  private say(text: string) {
    this.call = text;
    this.callLeft = 1.25;
  }

  // ── networking ────────────────────────────────────────────────────────────

  snapshot(): Snapshot {
    const p: Snapshot['p'] = {};
    for (const q of this.players) {
      p[q.id] = [
        Math.round(q.x),
        Math.round(q.y),
        Math.round(q.vx),
        Math.round(q.vy),
        Math.round(q.r),
        (q.onGround ? 1 : 0) | (q.facing === 1 ? 2 : 0) | (q.dashLeft > 0 ? 4 : 0),
      ];
    }
    return {
      t: 's',
      n: this.tick,
      b: [
        Math.round(this.ball.x),
        Math.round(this.ball.y),
        Math.round(this.ball.vx),
        Math.round(this.ball.vy),
        Math.round(this.ball.spin),
      ],
      p,
      sc: [...this.score] as [number, number],
      ph: this.phase,
      tm: Math.round(this.phaseTimer * 100) / 100,
      pw: this.powers.map((x) => [x.kind, x.team, x.left === Infinity ? -1 : x.left] as [PowerKind, Team, number]),
      fl: this.floating.map((f) => [f.kind, Math.round(f.x), Math.round(f.y)] as [PowerKind, number, number]),
      sv: this.serving,
    };
  }

  /**
   * Takes the host's word for the rules and stores positions as *targets*
   * rather than truth. Snapping straight to them at 20 Hz looks like a
   * slideshow; `reconcile` eases toward them every frame instead.
   */
  applySnapshot(s: Snapshot) {
    if (this.cfg.isHost) return;

    const wasOver = this.phase === 'over';
    this.score = s.sc;
    this.phase = s.ph;
    this.phaseTimer = s.tm;
    this.serving = s.sv;
    if (!wasOver && s.ph === 'over') {
      this.winner = this.score[0] > this.score[1] ? 0 : 1;
      this.cfg.onOver?.(this.winner);
    }

    this.powers = s.pw.map(([kind, team, left]) => ({ kind, team, left: left < 0 ? Infinity : left }));
    this.floating = s.fl.map(([kind, x, y]) => ({ kind, x, y, vy: BALANCE.POWER_FALL, spin: 0 }));

    this.target.ball = {
      x: s.b[0], y: s.b[1], vx: s.b[2], vy: s.b[3], spin: s.b[4],
      lastTeam: this.ball.lastTeam, lastHitter: this.ball.lastHitter,
    };
    this.target.players.clear();
    for (const [id, d] of Object.entries(s.p)) {
      this.target.players.set(id, { x: d[0], y: d[1], r: d[4] });
      const local = this.players.find((q) => q.id === id);
      if (local && local.control !== 'local') {
        // Remote bodies take the host's velocity outright — there is nothing to
        // predict for them, so the smoothest result is to follow exactly.
        local.vx = d[2];
        local.vy = d[3];
        local.onGround = (d[5] & 1) !== 0;
        local.facing = (d[5] & 2) !== 0 ? 1 : -1;
      }
    }
  }

  /**
   * Pulls the local simulation toward the host's last word.
   *
   * The player's own character is eased far more gently than everyone else's:
   * a character that snaps under your own thumb feels broken even when it is
   * technically more accurate.
   */
  private reconcile(dt: number, inputs: Map<string, Input>) {
    const hard = 1 - Math.pow(0.001, dt * (BALANCE.INTERP / 10));
    const soft = 1 - Math.pow(0.001, dt * (BALANCE.RECONCILE / 10));

    if (this.target.ball) {
      const t = this.target.ball;
      this.ball.x += (t.x - this.ball.x) * hard;
      this.ball.y += (t.y - this.ball.y) * hard;
      this.ball.vx = t.vx;
      this.ball.vy = t.vy;
      this.ball.spin = t.spin;
    }

    for (const p of this.players) {
      const t = this.target.players.get(p.id);
      if (!t) continue;
      const k = inputs.has(p.id) ? soft : hard;
      p.x += (t.x - p.x) * k;
      p.y += (t.y - p.y) * k;
      p.r = t.r;
    }
  }

  // ── particles ─────────────────────────────────────────────────────────────

  /** How much of the decoration this device can afford. See game/quality.ts. */
  setBudget(multiplier: number) {
    this.budget = multiplier;
  }

  private puff(x: number, y: number, color: string, count: number, spread: number) {
    // Hard cap: a long rally with power-ups can otherwise queue thousands and
    // the frame cost lands exactly when the action is busiest.
    if (this.particles.length > 320) return;
    // Rounded up, so a burst that was asked for never vanishes entirely — a
    // hit with no puff at all reads as a missed hit.
    const n = Math.max(1, Math.ceil(count * this.budget));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = spread * (0.35 + Math.random() * 0.65);
      const life = 0.25 + Math.random() * 0.45;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 40,
        life,
        max: life,
        size: 3 + Math.random() * 5,
        color,
      });
    }
  }

  private stepParticles(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += 900 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  /**
   * Letterboxes the court into the canvas.
   *
   * The whole court is always visible — a volleyball court that scrolls is
   * unplayable, because you cannot position yourself against a ball you cannot
   * see.
   */
  resize(canvas: HTMLCanvasElement, cssW: number, cssH: number, q: Quality) {
    // The backing store is the whole fill-rate bill: at dpr 2 a 1080p court is
    // four times the pixels of the same court at dpr 1, for no change in what
    // the player can actually see happening.
    const dpr = Math.min(window.devicePixelRatio || 1, q.maxDpr);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    this.scale = Math.min(cssW / this.arena.w, cssH / this.arena.h) * dpr;
    this.offX = (canvas.width - this.arena.w * this.scale) / 2;
    this.offY = (canvas.height - this.arena.h * this.scale) / 2;
  }

  render(ctx: CanvasRenderingContext2D, q: Quality) {
    const { canvas } = ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#06182a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const sx = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offX + sx * this.scale, this.offY + sy * this.scale);

    if (this.backdrop) ctx.drawImage(this.backdrop, 0, 0);
    else drawFallbackCourt(ctx, this.arena);

    // Shadows sell the height of a jump, so they are worth keeping until the
    // cheapest tier: they are decoration that still carries information.
    if (q.fancy) this.drawShadows(ctx);
    this.drawFloating(ctx);
    for (const p of this.players) this.drawPlayer(ctx, p);
    this.drawBall(ctx, q);
    this.drawParticles(ctx);
    this.drawCall(ctx);
  }

  private drawShadows(ctx: CanvasRenderingContext2D) {
    const { floor } = this.arena;
    ctx.save();
    for (const p of this.players) {
      const height = clamp((floor - p.y) / 420, 0, 1);
      ctx.globalAlpha = 0.3 * (1 - height * 0.7);
      ctx.beginPath();
      ctx.ellipse(p.x, floor + 6, p.r * (1 - height * 0.35), p.r * 0.28, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#6b4a24';
      ctx.fill();
    }
    const bh = clamp((floor - this.ball.y) / 520, 0, 1);
    ctx.globalAlpha = 0.28 * (1 - bh * 0.75);
    ctx.beginPath();
    ctx.ellipse(this.ball.x, floor + 6, BALANCE.BALL_R * (1 - bh * 0.4), BALANCE.BALL_R * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#6b4a24';
    ctx.fill();
    ctx.restore();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, p: Player) {
    drawCharacter(
      ctx,
      CHARACTERS[p.character],
      p.x,
      p.y - p.r * 0.55,
      p.r,
      p.facing,
      TEAM_COLORS[p.team].main,
    );

    ctx.save();
    ctx.font = '600 17px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(3, 20, 34, 0.8)';
    ctx.fillStyle = '#fff';
    const label = p.name.length > 12 ? `${p.name.slice(0, 11)}…` : p.name;
    ctx.strokeText(label, p.x, p.y - p.r * 2.05);
    ctx.fillText(label, p.x, p.y - p.r * 2.05);
    ctx.restore();

    // Dash cooldown, as a shrinking bar under the feet. It is the only resource
    // in the game with a cooldown, so it is the only one that gets a meter.
    if (p.dashCd > 0) {
      const t = 1 - p.dashCd / BALANCE.DASH_COOLDOWN;
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(p.x - p.r * 0.7, this.arena.floor + 12, p.r * 1.4, 4);
      ctx.fillStyle = TEAM_COLORS[p.team].light;
      ctx.fillRect(p.x - p.r * 0.7, this.arena.floor + 12, p.r * 1.4 * t, 4);
    }
  }

  private drawBall(ctx: CanvasRenderingContext2D, q: Quality) {
    const b = this.ball;
    const R = BALANCE.BALL_R;
    const speed = Math.hypot(b.vx, b.vy) / BALANCE.BALL_MAX_SPEED;

    // Trail thickens with speed, so a spike reads as fast before you have had
    // time to notice where it went.
    if (q.trails && this.trail.length > 1 && speed > 0.12) {
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 1; i < this.trail.length; i++) {
        const t = i / this.trail.length;
        ctx.strokeStyle = `rgba(255, 238, 190, ${t * 0.5 * speed})`;
        ctx.lineWidth = R * 1.6 * t * speed;
        ctx.beginPath();
        ctx.moveTo(this.trail[i - 1].x, this.trail[i - 1].y);
        ctx.lineTo(this.trail[i].x, this.trail[i].y);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate((b.x + b.y) * 0.012);

    // A fresh gradient object every frame is the one allocation in this
    // renderer that buys nothing on a slow device; the cheap tier takes the
    // flat fill, which at this size is very hard to tell apart in motion.
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    if (q.fancy) {
      const shade = ctx.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.15, 0, 0, R);
      shade.addColorStop(0, '#ffffff');
      shade.addColorStop(0.7, '#f6e7c8');
      shade.addColorStop(1, '#c9a86f');
      ctx.fillStyle = shade;
    } else {
      ctx.fillStyle = '#f2e3c4';
    }
    ctx.fill();

    // Panel seams. Three arcs is all it takes to read as a volleyball.
    ctx.strokeStyle = '#e0563a';
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.92, R * 0.34, (i * Math.PI) / 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    if (this.hasPower('rocket')) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, R * 1.45, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
  }

  private drawFloating(ctx: CanvasRenderingContext2D) {
    for (const f of this.floating) {
      const meta = POWER_META[f.kind];
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(Math.sin(f.spin) * 0.25);
      ctx.beginPath();
      ctx.arc(0, 0, BALANCE.POWER_R * 1.35, 0, Math.PI * 2);
      ctx.fillStyle = `${meta.color}33`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, BALANCE.POWER_R, 0, Math.PI * 2);
      ctx.fillStyle = meta.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.font = '22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(meta.glyph, 0, 1);
      ctx.restore();
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D) {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawCall(ctx: CanvasRenderingContext2D) {
    if (this.phase === 'serve' && this.phaseTimer > 0) {
      const n = Math.ceil(this.phaseTimer);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = '800 92px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeStyle = 'rgba(3,20,34,0.55)';
      ctx.lineWidth = 8;
      const y = this.arena.h * 0.3;
      ctx.strokeText(String(n), this.arena.netX, y);
      ctx.fillText(String(n), this.arena.netX, y);
      ctx.restore();
    }

    if (this.callLeft <= 0 || !this.call) return;
    const t = this.callLeft / 1.25;
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 2.2);
    ctx.textAlign = 'center';
    ctx.font = `800 ${Math.round(64 + (1 - t) * 22)}px system-ui, sans-serif`;
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(3, 20, 34, 0.7)';
    ctx.fillStyle = '#fde68a';
    const y = this.arena.h * 0.22;
    ctx.strokeText(this.call, this.arena.netX, y);
    ctx.fillText(this.call, this.arena.netX, y);
    ctx.restore();
  }
}
