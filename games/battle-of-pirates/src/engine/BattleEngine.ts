/**
 * The whole battle: ballistics, damage, the turn order and the rendering.
 *
 * Three things shape this file more than anything else.
 *
 * 1. **Fixed timestep.** Physics runs at a fixed 120 Hz through an
 *    accumulator, so a 144 Hz desktop and a 60 Hz phone simulate the identical
 *    flight. That is not only about feel: it is what lets two clients agree on
 *    where a shot went without exchanging a single position update.
 *
 * 2. **Swept collision, always.** A ball at full power crosses many times its
 *    own diameter in a step. Every collision here is a segment test against
 *    the shape, never a point-inside test, so nothing tunnels through a hull
 *    at close range, which is exactly where a hit matters most.
 *
 * 3. **Every random thing is seeded.** The hand you are dealt, the wind, the
 *    drift: all pure functions of (match seed, turn number). Two clients
 *    therefore deal themselves the same match with nothing to negotiate, and
 *    the wire carries turns rather than state.
 */
import { fxSprites, bakeSea, drawFallbackSea, drawRock, drawWaves } from '../game/sea';
import { SHIPS, drawShip } from '../game/ships';
import {
  ARENA,
  BALANCE,
  CARDS,
  CardId,
  TEAM_COLORS,
  clamp,
  dealHand,
  mulberry32,
} from '../game/rules';
import type { Quality } from '../game/quality';
import type {
  Control,
  Phase,
  Projectile,
  Rock,
  Ship,
  Shot,
  ShotPacket,
  Team,
} from '../types/game';

export interface Seat {
  team: Team;
  id: string;
  name: string;
  control: Control;
  aiLevel: number;
  skin: number;
}

export type Sfx = 'fire' | 'hull' | 'splash' | 'rock' | 'deal' | 'burn' | 'sink';

export interface EngineConfig {
  seats: [Seat, Seat];
  seed: number;
  first: Team;
  obstacles: boolean;
  turnTimer: boolean;
  onPhase?: (phase: Phase) => void;
  onTurn?: (team: Team, hand: CardId[]) => void;
  onHp?: (hp: [number, number]) => void;
  /** A shot this device is responsible for, resolved and ready to send. */
  onLocalShot?: (packet: ShotPacket) => void;
  onOver?: (winner: Team) => void;
  onSfx?: (kind: Sfx, power?: number) => void;
}

/** 0 fire, 1 smoke, 2 spark, 3 splash, 4 splinter. */
type ParticleKind = 0 | 1 | 2 | 3 | 4;

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  rot: number;
  spin: number;
  color: string;
}

interface Ring {
  x: number;
  y: number;
  r: number;
  max: number;
  life: number;
  width: number;
}

const STEP = 1 / 120;
const ROCK_HP = 3;
const PARTICLE_CAP = 420;
const RING_CAP = 14;
/** Barrel length, so the ball leaves the muzzle rather than the deck. */
const BARREL = 58;
/** A rigging hit is real but glancing. */
const RIG_MULT = 0.55;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class BattleEngine {
  readonly ships: [Ship, Ship];
  rocks: Rock[] = [];

  phase: Phase = 'deal';
  turn: Team;
  turnNo = 0;
  winner: Team | null = null;
  wind = 0;
  /** Seconds left to aim. Only counted down on the device whose turn it is. */
  turnClock = BALANCE.TURN_TIME;
  hand: CardId[] = [];
  selected: CardId = 'round';
  /** Big centred shout. Fades on its own. */
  call = '';
  callLeft = 0;

  /** Aim the local player is holding, in world radians and 0..1. */
  aimAngle = -0.7;
  aimPower = 0.65;
  /** True while a finger or the mouse is down, so the guide only shows then. */
  aiming = false;
  /**
   * Did this team's last shot actually strike the enemy? null before its first.
   *
   * Deliberately a hit and not a distance. The obvious version compared where
   * the shot landed against the enemy's centre, and it never worked: a hull
   * hit is recorded where the swept segment first touches the box, which is up
   * to a hull's half-width plus a ball radius short of the middle. Every clean
   * hit therefore measured as a near miss, and the bots tightened their aim
   * forever instead of settling.
   */
  lastShotHit: [boolean | null, boolean | null] = [null, null];

  private cfg: EngineConfig;
  private projectiles: Projectile[] = [];
  private particles: Particle[] = [];
  private pool: Particle[] = [];
  private rings: Ring[] = [];
  private backdrop: HTMLCanvasElement | null = null;
  private acc = 0;
  private clock = 0;
  private shake = 0;
  private phaseTimer = 0;
  private botTimer = 0;
  private sinkT = 0;
  private budget = 1;

  /** Burn stacks as they stood before the current shot, so a firebomb cannot tick on itself. */
  private burnBefore: [number, number] = [0, 0];
  /** A shot that arrived over the wire and is waiting for a turn to land in. */
  private pendingRemote: ShotPacket | null = null;
  /** Set while the flight currently in the air came from the wire. */
  private resolving: ShotPacket | null = null;
  private lastShot: Shot | null = null;
  /** Counted separately: one is what we have sent, the other what we have seen. */
  private localSeq = 0;
  private remoteSeq = 0;

  // Viewport transform, recomputed on resize.
  private scale = 1;
  private offX = 0;
  private offY = 0;
  private dpr = 1;

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
    this.turn = cfg.first;

    this.ships = [this.makeShip(cfg.seats[0], 0), this.makeShip(cfg.seats[1], 2.1)];

    const rnd = this.rngFor(0);
    this.wind = (rnd() * 2 - 1) * 0.7;
    this.ships[0].x = this.ships[0].anchorX + (rnd() * 2 - 1) * BALANCE.DRIFT_STEP;
    this.ships[1].x = this.ships[1].anchorX + (rnd() * 2 - 1) * BALANCE.DRIFT_STEP;
    if (cfg.obstacles) this.spawnRocks(rnd);

    this.beginTurn();
  }

  private makeShip(seat: Seat, bobPhase: number): Ship {
    return {
      team: seat.team,
      id: seat.id,
      name: seat.name,
      control: seat.control,
      aiLevel: seat.aiLevel,
      skin: clamp(seat.skin, 0, SHIPS.length - 1),
      hp: BALANCE.MAX_HP,
      anchorX: ARENA.anchor[seat.team],
      x: ARENA.anchor[seat.team],
      burn: 0,
      bobPhase,
      flash: 0,
      lean: 0,
      lastAim: { angle: seat.team === 0 ? -0.72 : -Math.PI + 0.72, power: 0.65 },
    };
  }

  /**
   * One generator per turn, derived from the match seed.
   *
   * Not one long stream: a client replaying a turn to animate it must draw the
   * same hand and the same wind as the client that played it. Keying on the
   * turn number makes every draw reproducible from the two numbers both sides
   * already hold.
   */
  private rngFor(turn: number): () => number {
    return mulberry32((this.cfg.seed ^ Math.imul(turn, 0x9e3779b1)) >>> 0);
  }

  private spawnRocks(rnd: () => number) {
    const count = BALANCE.ROCK_MIN + Math.floor(rnd() * (BALANCE.ROCK_MAX - BALANCE.ROCK_MIN + 1));
    const lo = ARENA.anchor[0] + 340;
    const hi = ARENA.anchor[1] - 340;
    const slot = (hi - lo) / count;
    for (let i = 0; i < count; i++) {
      this.rocks.push({
        x: lo + slot * i + slot * (0.2 + rnd() * 0.6),
        y: ARENA.seaY - 6 - rnd() * 26,
        r: 40 + rnd() * 34,
        hp: ROCK_HP,
        seed: (rnd() * 0xffffff) | 0,
      });
    }
  }

  // -- geometry ---------------------------------------------------------------

  /** Waterline the hull is riding on this instant. The bob is real, not paint. */
  shipY(team: Team): number {
    const ship = this.ships[team];
    return ARENA.seaY + Math.sin(this.clock * BALANCE.BOB_SPEED + ship.bobPhase) * BALANCE.BOB_AMP;
  }

  facing(team: Team): 1 | -1 {
    return team === 0 ? 1 : -1;
  }

  /** The pivot the barrel turns about. */
  private trunnion(team: Team): { x: number; y: number } {
    return {
      x: this.ships[team].x + this.facing(team) * BALANCE.MUZZLE_X,
      y: this.shipY(team) + BALANCE.MUZZLE_Y,
    };
  }

  /** The mouth of the barrel at a given elevation, where a ball actually appears. */
  muzzle(team: Team, angle: number): { x: number; y: number } {
    const t = this.trunnion(team);
    return { x: t.x + Math.cos(angle) * BARREL, y: t.y + Math.sin(angle) * BARREL };
  }

  private hullBox(team: Team): Box {
    const x = this.ships[team].x;
    const y = this.shipY(team);
    return { x0: x - BALANCE.HULL_W / 2, y0: y - 62, x1: x + BALANCE.HULL_W / 2, y1: y + 22 };
  }

  /** Mast and canvas. Worth hitting, worth less than the hull. */
  private rigBox(team: Team): Box {
    const x = this.ships[team].x;
    const y = this.shipY(team);
    const f = this.facing(team);
    const a = x + f * -92;
    const b = x + f * 104;
    return { x0: Math.min(a, b), y0: y - 242, x1: Math.max(a, b), y1: y - 62 };
  }

  // -- the turn ---------------------------------------------------------------

  private beginTurn() {
    const rnd = this.rngFor(this.turnNo + 1);
    this.hand = dealHand(rnd);
    this.selected = this.hand[0];
    this.phase = 'deal';
    this.phaseTimer = 0.5;
    this.turnClock = BALANCE.TURN_TIME;
    const ship = this.ships[this.turn];
    this.aimAngle = ship.lastAim.angle;
    this.aimPower = ship.lastAim.power;
    this.cfg.onSfx?.('deal');
    this.cfg.onTurn?.(this.turn, this.hand);
    this.cfg.onPhase?.(this.phase);
  }

  /** True when the human sitting at this device is the one who has to shoot. */
  get awaitingLocal(): boolean {
    return this.phase === 'aim' && this.ships[this.turn].control === 'local';
  }

  /** True while the turn belongs to somebody at the other end of a wire. */
  get awaitingRemote(): boolean {
    return (
      (this.phase === 'aim' || this.phase === 'deal') && this.ships[this.turn].control === 'remote'
    );
  }

  get hp(): [number, number] {
    return [Math.max(0, Math.round(this.ships[0].hp)), Math.max(0, Math.round(this.ships[1].hp))];
  }

  select(card: CardId) {
    if (this.phase === 'aim' && this.hand.includes(card)) this.selected = card;
  }

  setBudget(scale: number) {
    this.budget = scale;
  }

  /**
   * Fire from the ship whose turn it is.
   *
   * One entry point for every source of a shot: a thumb, a keyboard, the turn
   * clock running out, a bot, or the far end of a wire. Nothing downstream has
   * to know which it was.
   */
  fire(shot: Shot) {
    if (this.phase !== 'aim' && this.phase !== 'deal') return;
    const team = this.turn;
    const ship = this.ships[team];
    const card = CARDS[shot.card] ?? CARDS.round;
    const angle = shot.angle;
    const power = clamp(shot.power, 0.05, 1);

    ship.lastAim = { angle, power };
    this.lastShot = { angle, power, card: card.id };
    this.lastShotHit[team] = false;
    this.burnBefore = [this.ships[0].burn, this.ships[1].burn];

    if (card.heal) {
      ship.hp = Math.min(BALANCE.MAX_HP, ship.hp + card.heal);
      this.cfg.onHp?.(this.hp);
    }

    const speed = (BALANCE.MIN_SPEED + (BALANCE.MAX_SPEED - BALANCE.MIN_SPEED) * power) * card.speed;
    const mouth = this.muzzle(team, angle);

    for (let i = 0; i < card.shots; i++) {
      // Fanned symmetrically about the aim, so a single-shot card is dead on
      // and a five-pellet card still centres where the player pointed.
      const offset = card.shots === 1 ? 0 : (i - (card.shots - 1) / 2) * card.spread;
      const a = angle + offset;
      this.projectiles.push({
        x: mouth.x,
        y: mouth.y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        r: BALANCE.BALL_R * (card.shots > 2 ? 0.62 : 1),
        team,
        damage: BALANCE.DIRECT * card.damage,
        blast: BALANCE.BLAST_R * card.blast,
        gravity: BALANCE.GRAVITY * card.gravity,
        pierce: Boolean(card.pierce),
        windproof: Boolean(card.windproof),
        burn: card.burn ?? 0,
        alive: true,
        armed: false,
        age: 0,
        trail: [],
      });
    }

    // The hull kicks away from the shot and rights itself.
    ship.lean += this.facing(team) * -0.09;
    this.muzzleFlash(mouth.x, mouth.y, angle);
    this.shake = Math.max(this.shake, 6 + power * 8);
    this.phase = 'flight';
    this.cfg.onSfx?.('fire', power);
    this.cfg.onPhase?.(this.phase);
  }

  /**
   * A turn that arrived over the wire.
   *
   * It is not played immediately: our own explosion may still be settling, and
   * firing into that would show two shots at once. It waits for the turn it
   * belongs to and is picked up in update().
   */
  applyShot(packet: ShotPacket) {
    // A player's update document outlives the match that wrote it, so the
    // first snapshot after subscribing can be last night's final shot.
    if (packet.s !== this.cfg.seed) return;
    if (packet.n <= this.remoteSeq) return;
    this.remoteSeq = packet.n;
    this.pendingRemote = packet;
  }

  /** A player who left hands their wheel to a bot rather than stranding the match. */
  handOverToAI(team: Team, level = 1) {
    const ship = this.ships[team];
    if (ship.control !== 'remote') return;
    ship.control = 'ai';
    ship.aiLevel = level;
    ship.name = `${ship.name} (adrift)`;
    this.pendingRemote = null;
    if (this.phase === 'aim' && this.turn === team) this.botTimer = BALANCE.BOT_THINK;
  }

  // -- simulation -------------------------------------------------------------

  update(dt: number, decide?: (team: Team) => Shot) {
    this.clock += dt;
    this.acc += Math.min(dt, 0.25);

    let steps = 0;
    while (this.acc >= STEP && steps < 10) {
      this.acc -= STEP;
      steps++;
      this.step(STEP);
    }
    // A tab that was asleep must not spend a minute on catch-up frames.
    if (this.acc > STEP * 10) this.acc = 0;

    this.decay(dt);

    if (this.phase === 'over') {
      this.sinkT = Math.min(1, this.sinkT + dt * 0.55);
      return;
    }

    if (this.phase === 'deal') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        this.phase = 'aim';
        this.botTimer = BALANCE.BOT_THINK;
        this.cfg.onPhase?.(this.phase);
      }
      return;
    }

    if (this.phase === 'aim') {
      const ship = this.ships[this.turn];

      if (ship.control === 'remote') {
        const packet = this.pendingRemote;
        if (packet) {
          this.pendingRemote = null;
          this.resolving = packet;
          this.fire({ angle: packet.a, power: packet.p, card: packet.c });
        }
        return;
      }

      if (ship.control === 'ai' && decide) {
        this.botTimer -= dt;
        if (this.botTimer <= 0) this.fire(decide(this.turn));
        return;
      }

      if (this.cfg.turnTimer) {
        this.turnClock -= dt;
        if (this.turnClock <= 0) {
          this.shout('out of time');
          this.fire({ angle: this.aimAngle, power: this.aimPower, card: this.selected });
        }
      }
      return;
    }

    if (this.phase === 'impact') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.resolve();
    }
  }

  private step(dt: number) {
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.age += dt;
      if (!p.windproof) p.vx += this.wind * BALANCE.WIND_ACCEL * dt;
      p.vy += p.gravity * dt;

      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;

      // Arms once clear of the ship that fired it. Until then its own hull and
      // rigging are ignored, because the muzzle sits inside both.
      if (!p.armed && !this.insideOwn(p, p.x, p.y)) p.armed = true;

      this.sweep(p, nx, ny);

      if (!p.alive) continue;
      p.x = nx;
      p.y = ny;
      if (p.trail.length > 30) p.trail.splice(0, 2);
      p.trail.push(nx, ny);

      // Off the sides is a miss, not an explosion. Above is fine: gravity
      // brings a lofted mortar back, and despawning at y < 0 is precisely the
      // bug that eats every high shot.
      if (p.x < -260 || p.x > ARENA.w + 260 || p.age > BALANCE.MAX_FLIGHT) p.alive = false;
    }

    if (this.phase === 'flight' && !this.projectiles.some((p) => p.alive)) {
      this.projectiles.length = 0;
      this.phase = 'impact';
      this.phaseTimer = BALANCE.IMPACT_HOLD;
      this.cfg.onPhase?.(this.phase);
    }

    this.stepParticles(dt);
  }

  private insideOwn(p: Projectile, x: number, y: number): boolean {
    return inBox(x, y, this.hullBox(p.team), p.r) || inBox(x, y, this.rigBox(p.team), p.r);
  }

  /**
   * Swept collision for one projectile step.
   *
   * Everything is tested against the segment from where the ball is to where
   * it is about to be, and the earliest hit wins. A point-in-shape test would
   * miss a hull entirely at full power, and it would do it most often on the
   * shots the player cared about.
   */
  private sweep(p: Projectile, nx: number, ny: number) {
    let best = 2;
    let kind: 'hull' | 'rig' | 'rock' | 'water' | null = null;
    let team: Team = 0;
    let struck: Rock | null = null;

    for (const side of [0, 1] as Team[]) {
      if (side === p.team && !p.armed) continue;
      if (this.ships[side].hp <= 0) continue;

      const th = segmentBox(p.x, p.y, nx, ny, this.hullBox(side), p.r);
      if (th !== null && th < best) {
        best = th;
        kind = 'hull';
        team = side;
      }
      const tr = segmentBox(p.x, p.y, nx, ny, this.rigBox(side), p.r);
      if (tr !== null && tr < best) {
        best = tr;
        kind = 'rig';
        team = side;
      }
    }

    if (!p.pierce) {
      for (const rock of this.rocks) {
        if (rock.hp <= 0) continue;
        const t = segmentCircle(p.x, p.y, nx, ny, rock.x, rock.y, rock.r + p.r);
        if (t !== null && t < best) {
          best = t;
          kind = 'rock';
          struck = rock;
        }
      }
    }

    if (p.vy > 0 && ny + p.r >= ARENA.seaY) {
      const denom = ny - p.y;
      const t = clamp(Math.abs(denom) < 1e-6 ? 0 : (ARENA.seaY - (p.y + p.r)) / denom, 0, 1);
      if (t < best) {
        best = t;
        kind = 'water';
      }
    }

    if (!kind) return;

    const ix = p.x + (nx - p.x) * best;
    const iy = p.y + (ny - p.y) * best;
    p.alive = false;

    if (kind === 'hull' || kind === 'rig') {
      const mult = kind === 'rig' ? RIG_MULT : 1;
      const own = team === p.team;
      if (!own) this.lastShotHit[p.team] = true;
      this.damage(team, p.damage * mult * (own ? BALANCE.SELF_MULT : 1), ix);
      if (p.burn > 0 && !own) this.ships[team].burn = p.burn + 1;
      this.explode(ix, iy, p, 'hull');
      this.shout(own ? 'your own hull!' : kind === 'rig' ? 'rigging hit' : 'direct hit!');
      return;
    }

    if (kind === 'rock' && struck) {
      struck.hp -= 1;
      this.explode(ix, iy, p, 'rock');
      this.splashDamage(ix, iy, p);
      return;
    }

    this.explode(ix, ARENA.seaY, p, 'water');
    this.splashDamage(ix, ARENA.seaY, p);
  }

  /** Blast falls off to nothing at the edge, so a near miss still counts for something. */
  private splashDamage(x: number, y: number, p: Projectile) {
    let closest = Infinity;
    for (const side of [0, 1] as Team[]) {
      if (this.ships[side].hp <= 0) continue;
      const box = this.hullBox(side);
      const dx = Math.max(box.x0 - x, 0, x - box.x1);
      const dy = Math.max(box.y0 - y, 0, y - box.y1);
      const dist = Math.hypot(dx, dy);
      if (side !== p.team) closest = Math.min(closest, dist);
      if (dist >= p.blast) continue;

      const falloff = 1 - dist / p.blast;
      const own = side === p.team;
      const dealt =
        BALANCE.BLAST * falloff * falloff * (own ? BALANCE.SELF_MULT : 1) * (p.damage / BALANCE.DIRECT);
      if (dealt > 0.7) this.damage(side, dealt, x);
    }
    if (closest < p.blast) this.shout('close!');
  }

  private damage(team: Team, amount: number, fromX: number) {
    const ship = this.ships[team];
    if (ship.hp <= 0 || amount <= 0) return;
    ship.hp = Math.max(0, ship.hp - amount);
    ship.flash = Math.min(1, ship.flash + amount / 30);
    ship.lean += (fromX < ship.x ? 1 : -1) * Math.min(0.12, amount / 260);
    this.shake = Math.min(34, this.shake + amount * 0.4);
    this.cfg.onSfx?.('hull', clamp(amount / BALANCE.DIRECT, 0.2, 1));
    this.cfg.onHp?.(this.hp);
  }

  /**
   * The turn is over: fires tick, the sea shifts, and the helm changes hands.
   *
   * A shot that came over the wire hands us its own numbers here. We animated
   * the identical flight, but the shooter decides what it did, which is the
   * whole reason the two clients never have to agree on a float.
   */
  private resolve() {
    const packet = this.resolving;
    this.resolving = null;

    for (const side of [0, 1] as Team[]) {
      const ship = this.ships[side];
      if (this.burnBefore[side] > 0 && ship.hp > 0) {
        ship.hp = Math.max(0, ship.hp - BALANCE.BURN_PER_TURN);
        ship.burn = Math.max(0, ship.burn - 1);
        this.burnAt(side);
        this.cfg.onSfx?.('burn');
      }
    }

    const next = this.turnNo + 1;

    if (packet) {
      // Trust here is social, not cryptographic: these are friends in a room,
      // and a static site has no server to be the authority. But a single turn
      // still cannot take more than a turn's worth of hull off, so a tampered
      // client cannot end a match in one write.
      this.ships[0].hp = clampClaim(this.ships[0].hp, packet.hp0);
      this.ships[1].hp = clampClaim(this.ships[1].hp, packet.hp1);
      this.ships[0].burn = clamp(Math.round(packet.f0), 0, 4);
      this.ships[1].burn = clamp(Math.round(packet.f1), 0, 4);
      this.wind = clamp(packet.w, -BALANCE.WIND_MAX, BALANCE.WIND_MAX);
      this.ships[0].x = this.clampDrift(0, packet.d0);
      this.ships[1].x = this.clampDrift(1, packet.d1);
      this.turnNo = next;
      this.turn = packet.o === 1 ? 1 : 0;
    } else {
      const rnd = this.rngFor(next + 977);
      this.wind = clamp(
        this.wind + (rnd() * 2 - 1) * BALANCE.WIND_STEP,
        -BALANCE.WIND_MAX,
        BALANCE.WIND_MAX,
      );
      this.ships[0].x = this.drift(0, rnd);
      this.ships[1].x = this.drift(1, rnd);
      const shooter = this.turn;
      this.turnNo = next;
      this.turn = (1 - shooter) as Team;

      // Only a seat this device is responsible for produces a packet. A bot
      // standing in for someone who left is one of those; an offline match has
      // nobody listening and the hook is simply absent.
      if (this.cfg.onLocalShot && this.lastShot && this.ships[shooter].control !== 'remote') {
        this.cfg.onLocalShot({
          t: 'shot',
          n: ++this.localSeq,
          s: this.cfg.seed,
          a: round3(this.lastShot.angle),
          p: round3(this.lastShot.power),
          c: this.lastShot.card,
          hp0: Math.round(this.ships[0].hp),
          hp1: Math.round(this.ships[1].hp),
          f0: this.ships[0].burn,
          f1: this.ships[1].burn,
          w: round3(this.wind),
          d0: Math.round(this.ships[0].x),
          d1: Math.round(this.ships[1].x),
          o: this.turn,
        });
      }
    }

    this.cfg.onHp?.(this.hp);

    if (this.ships[0].hp <= 0 || this.ships[1].hp <= 0) {
      this.finish();
      return;
    }
    this.beginTurn();
  }

  private clampDrift(team: Team, x: number): number {
    const anchor = ARENA.anchor[team];
    return clamp(x, anchor - BALANCE.DRIFT_MAX, anchor + BALANCE.DRIFT_MAX);
  }

  private drift(team: Team, rnd: () => number): number {
    return this.clampDrift(team, this.ships[team].x + (rnd() * 2 - 1) * BALANCE.DRIFT_STEP);
  }

  private finish() {
    const [a, b] = [this.ships[0].hp, this.ships[1].hp];
    // Both hulls gone is a real outcome: a mortar into your own rigging can do
    // it. Whoever is still floating on more timber takes it; dead level, the
    // one that did not fire survives.
    this.winner = a > b ? 0 : b > a ? 1 : ((1 - this.turn) as Team);
    this.phase = 'over';
    this.sinkT = 0;
    const loser = (1 - this.winner) as Team;
    this.wreck(loser);
    this.shout('she goes down!');
    this.cfg.onSfx?.('sink');
    this.cfg.onPhase?.(this.phase);
    this.cfg.onOver?.(this.winner);
  }

  // -- effects ---------------------------------------------------------------

  /**
   * A pool, not an allocation.
   *
   * A hundred short-lived objects per explosion is a hundred objects for the
   * collector to find later, and it finds them mid-rally. At the cap the
   * oldest live particle is reused rather than the burst being refused: a
   * thinner explosion still reads as an explosion, a missing one does not.
   */
  private take(): Particle {
    if (this.particles.length >= PARTICLE_CAP) {
      const oldest = this.particles.shift() as Particle;
      this.particles.push(oldest);
      return oldest;
    }
    const p =
      this.pool.pop() ??
      ({ kind: 0, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 1, grow: 1, rot: 0, spin: 0, color: '#fff' } as Particle);
    this.particles.push(p);
    return p;
  }

  /** Counts are multiplied by the quality budget, so one tier drop thins every burst. */
  private burst(count: number, kind: ParticleKind, x: number, y: number, make: (p: Particle, t: number) => void) {
    const n = Math.max(1, Math.round(count * this.budget));
    for (let i = 0; i < n; i++) {
      const p = this.take();
      p.kind = kind;
      p.x = x;
      p.y = y;
      p.rot = 0;
      p.spin = 0;
      p.grow = 1;
      p.color = '#fff';
      make(p, n === 1 ? 0 : i / (n - 1));
    }
  }

  private explode(x: number, y: number, p: Projectile, surface: 'hull' | 'water' | 'rock') {
    const power = clamp(p.damage / BALANCE.DIRECT, 0.35, 1.7);
    const scale = p.blast / BALANCE.BLAST_R;

    this.pushRing({ x, y, r: 8, max: 60 * scale + power * 60, life: 1, width: 7 * scale });
    this.shake = Math.min(34, this.shake + 9 * power);

    // Fireball.
    this.burst(11 * power, 0, x, y, (q, t) => {
      const a = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 210 * power;
      q.vx = Math.cos(a) * speed;
      q.vy = Math.sin(a) * speed - 40;
      q.max = 0.32 + Math.random() * 0.36;
      q.life = q.max;
      q.size = (34 + t * 46) * scale;
      q.grow = 1.9;
    });

    // Sparks.
    this.burst(14 * power, 2, x, y, (q) => {
      const a = Math.random() * Math.PI * 2;
      const speed = 180 + Math.random() * 520 * power;
      q.vx = Math.cos(a) * speed;
      q.vy = Math.sin(a) * speed - 90;
      q.max = 0.45 + Math.random() * 0.5;
      q.life = q.max;
      q.size = 7 + Math.random() * 9;
      q.grow = 0.4;
    });

    // Smoke, which is what is still there a second later.
    this.burst(7 * power, 1, x, y, (q) => {
      q.vx = (Math.random() - 0.5) * 130;
      q.vy = -30 - Math.random() * 110;
      q.max = 1.1 + Math.random() * 1.1;
      q.life = q.max;
      q.size = 30 + Math.random() * 46;
      q.grow = 2.4;
    });

    if (surface === 'water') {
      this.burst(15 * power, 3, x, ARENA.seaY, (q) => {
        q.vx = (Math.random() - 0.5) * 340;
        q.vy = -180 - Math.random() * 460 * power;
        q.max = 0.7 + Math.random() * 0.55;
        q.life = q.max;
        q.size = 16 + Math.random() * 30;
        q.grow = 1.5;
      });
      this.pushRing({ x, y: ARENA.seaY, r: 10, max: 120 * scale, life: 1, width: 5 });
      this.cfg.onSfx?.('splash');
    } else if (surface === 'rock') {
      this.debris(x, y, power, '#5b6675');
      this.cfg.onSfx?.('rock');
    } else {
      this.debris(x, y, power, '#8b5a2b');
    }
  }

  private pushRing(ring: Ring) {
    if (this.rings.length >= RING_CAP) this.rings.shift();
    this.rings.push(ring);
  }

  private debris(x: number, y: number, power: number, color: string) {
    this.burst(9 * power, 4, x, y, (q) => {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      const speed = 190 + Math.random() * 430 * power;
      q.vx = Math.cos(a) * speed;
      q.vy = Math.sin(a) * speed;
      q.max = 1 + Math.random() * 0.9;
      q.life = q.max;
      q.size = 5 + Math.random() * 11;
      q.rot = Math.random() * Math.PI;
      q.spin = (Math.random() - 0.5) * 14;
      q.color = color;
    });
  }

  private muzzleFlash(x: number, y: number, angle: number) {
    this.burst(9, 0, x, y, (q) => {
      const a = angle + (Math.random() - 0.5) * 0.7;
      const speed = 200 + Math.random() * 400;
      q.vx = Math.cos(a) * speed;
      q.vy = Math.sin(a) * speed;
      q.max = 0.2 + Math.random() * 0.2;
      q.life = q.max;
      q.size = 26 + Math.random() * 26;
      q.grow = 1.7;
    });
    this.burst(6, 1, x, y, (q) => {
      const a = angle + (Math.random() - 0.5) * 1.1;
      const speed = 90 + Math.random() * 160;
      q.vx = Math.cos(a) * speed;
      q.vy = Math.sin(a) * speed - 30;
      q.max = 0.9 + Math.random() * 0.8;
      q.life = q.max;
      q.size = 22 + Math.random() * 30;
      q.grow = 2.2;
    });
  }

  private burnAt(team: Team) {
    const x = this.ships[team].x + (Math.random() - 0.5) * BALANCE.HULL_W * 0.7;
    const y = this.shipY(team) - 58;
    this.burst(7, 0, x, y, (q) => {
      q.vx = (Math.random() - 0.5) * 60;
      q.vy = -70 - Math.random() * 120;
      q.max = 0.5 + Math.random() * 0.4;
      q.life = q.max;
      q.size = 22 + Math.random() * 22;
      q.grow = 1.4;
    });
  }

  private wreck(team: Team) {
    const ship = this.ships[team];
    this.burst(20, 1, ship.x, this.shipY(team) - 70, (q) => {
      q.vx = (Math.random() - 0.5) * 180;
      q.vy = -40 - Math.random() * 150;
      q.max = 1.8 + Math.random() * 1.4;
      q.life = q.max;
      q.size = 50 + Math.random() * 70;
      q.grow = 2.6;
    });
    this.debris(ship.x, this.shipY(team) - 40, 1.6, '#6b4423');
  }

  private shout(text: string) {
    this.call = text;
    this.callLeft = 1.5;
  }

  private stepParticles(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        this.pool.push(p);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;

      if (p.kind === 1) {
        // Smoke rises and slows.
        p.vy -= 26 * dt;
        p.vx *= 0.985;
        p.vy *= 0.985;
      } else if (p.kind === 0) {
        p.vy -= 90 * dt;
        p.vx *= 0.93;
        p.vy *= 0.93;
      } else {
        p.vy += 900 * dt;
        p.vx *= 0.995;
        // Sparks, spray and splinters all drown when they reach the water.
        if (p.y > ARENA.seaY + 6) {
          this.particles.splice(i, 1);
          this.pool.push(p);
        }
      }
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt * 2.1;
      r.r += (r.max - r.r) * Math.min(1, dt * 7);
      if (r.life <= 0) this.rings.splice(i, 1);
    }
  }

  private decay(dt: number) {
    this.shake = Math.max(0, this.shake - dt * 46);
    this.callLeft = Math.max(0, this.callLeft - dt);
    for (const ship of this.ships) {
      ship.flash = Math.max(0, ship.flash - dt * 3.2);
      // A hull that is losing lists toward the sea; a healthy one rides level.
      const list = ship.hp <= 0 ? 0.55 : (1 - ship.hp / BALANCE.MAX_HP) * 0.09;
      const want = (ship.team === 0 ? 1 : -1) * list;
      ship.lean += (want - ship.lean) * Math.min(1, dt * 3.4);
    }
  }

  // -- aim guide -------------------------------------------------------------

  /**
   * The opening stretch of the arc, and no more.
   *
   * Long enough to read direction and strength at a glance, short enough that
   * it is not a solution. A full trajectory line would remove the only thing
   * this game asks of you.
   */
  previewArc(dots: number): { x: number; y: number }[] {
    const card = CARDS[this.selected] ?? CARDS.round;
    const power = clamp(this.aimPower, 0, 1);
    const speed = (BALANCE.MIN_SPEED + (BALANCE.MAX_SPEED - BALANCE.MIN_SPEED) * power) * card.speed;
    const start = this.muzzle(this.turn, this.aimAngle);
    let vx = Math.cos(this.aimAngle) * speed;
    let vy = Math.sin(this.aimAngle) * speed;
    let x = start.x;
    let y = start.y;
    const out: { x: number; y: number }[] = [];
    const dt = 1 / 60;
    const perDot = 3;
    for (let i = 0; i < dots * perDot; i++) {
      if (!card.windproof) vx += this.wind * BALANCE.WIND_ACCEL * dt;
      vy += BALANCE.GRAVITY * card.gravity * dt;
      x += vx * dt;
      y += vy * dt;
      if (i % perDot === perDot - 1) out.push({ x, y });
      if (y > ARENA.seaY) break;
    }
    return out;
  }

  // -- rendering --------------------------------------------------------------

  resize(canvas: HTMLCanvasElement, cssW: number, cssH: number, q: Quality) {
    // Backing-store pixels, not CSS pixels, are what a weak GPU actually has
    // to fill. Capping the total width is the single biggest thing keeping a
    // cheap phone at a steady rate.
    const maxWidth = q.tier === 0 ? 1280 : q.tier === 1 ? 1800 : 2600;
    let dpr = Math.min(window.devicePixelRatio || 1, q.maxDpr);
    dpr = Math.min(dpr, maxWidth / Math.max(1, cssW));
    this.dpr = Math.max(0.6, dpr);

    canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    // Letterbox. Both ships and the whole arc between them stay on screen at
    // every aspect ratio, because an artillery duel you have to scroll is a
    // guessing game.
    this.scale = Math.min(cssW / ARENA.w, cssH / ARENA.h) * this.dpr;
    this.offX = (canvas.width - ARENA.w * this.scale) / 2;
    this.offY = (canvas.height - ARENA.h * this.scale) / 2;

    if (!this.backdrop) this.backdrop = bakeSea(ARENA, q.fancy);
  }

  /** Screen point to world point, so a drag can be measured in world units. */
  toWorld(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number } {
    const px = (clientX - rect.left) * this.dpr;
    const py = (clientY - rect.top) * this.dpr;
    return { x: (px - this.offX) / this.scale, y: (py - this.offY) / this.scale };
  }

  render(ctx: CanvasRenderingContext2D, q: Quality) {
    const { canvas } = ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#04121f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const sx = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offX + sx * this.scale, this.offY + sy * this.scale);

    if (this.backdrop) ctx.drawImage(this.backdrop, 0, 0);
    else drawFallbackSea(ctx, ARENA);

    drawWaves(ctx, ARENA, this.clock, q.waves);

    for (const rock of this.rocks) if (rock.hp > 0) drawRock(ctx, rock, ROCK_HP);
    for (const side of [0, 1] as Team[]) this.drawOneShip(ctx, side, q);

    this.drawProjectiles(ctx, q);
    this.drawParticles(ctx);
    this.drawRings(ctx);
    if (this.aiming && this.awaitingLocal) this.drawGuide(ctx, q);
    this.drawOffscreenMarkers(ctx);
    this.drawCall(ctx);
  }

  private drawOneShip(ctx: CanvasRenderingContext2D, team: Team, q: Quality) {
    const ship = this.ships[team];
    const sunk = ship.hp <= 0;
    // A sunk hull slides under rather than blinking out, which is the part of
    // the ending anybody actually remembers.
    const settle = sunk ? easeIn(this.sinkT) * 150 : 0;

    // The barrel tracks whoever is shooting; an idle ship rests its gun at the
    // elevation it last used, so it never looks unmanned.
    const live = this.turn === team && (this.phase === 'aim' || this.phase === 'deal');

    drawShip(ctx, {
      skin: ship.skin,
      x: ship.x,
      y: this.shipY(team) + settle,
      facing: this.facing(team),
      accent: TEAM_COLORS[team].main,
      aim: live ? this.aimAngle : ship.lastAim.angle,
      lean: ship.lean,
      flash: ship.flash,
      clock: this.clock,
    });

    if (ship.burn > 0 && q.fancy && Math.random() < 0.35) this.burnAt(team);
    if (!sunk) this.drawHealthBar(ctx, team);
  }

  /**
   * The bar over the hull.
   *
   * On the ship as well as in the HUD on purpose: during a shot your eyes are
   * on the water, not on a corner of the screen, and a number that changes
   * where you are not looking may as well not have changed.
   */
  private drawHealthBar(ctx: CanvasRenderingContext2D, team: Team) {
    const ship = this.ships[team];
    const w = 190;
    const h = 17;
    const x = ship.x - w / 2;
    const y = this.shipY(team) - 300;
    const frac = clamp(ship.hp / BALANCE.MAX_HP, 0, 1);

    ctx.save();
    ctx.fillStyle = 'rgba(4, 16, 28, 0.66)';
    roundRect(ctx, x - 3, y - 3, w + 6, h + 6, 8);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(ctx, x, y, w, h, 6);
    ctx.fill();

    // Red under thirty per cent: the one moment the colour has to carry meaning.
    ctx.fillStyle = frac > 0.55 ? '#4ade80' : frac > 0.3 ? '#fbbf24' : '#f87171';
    roundRect(ctx, x, y, Math.max(4, w * frac), h, 6);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#08121c';
    ctx.font = '800 13px system-ui, sans-serif';
    ctx.fillText(`${Math.ceil(ship.hp)}`, ship.x, y + h / 2 + 1);

    ctx.font = '700 15px system-ui, sans-serif';
    ctx.fillStyle = TEAM_COLORS[team].light;
    ctx.fillText(ship.name.length > 16 ? `${ship.name.slice(0, 15)}.` : ship.name, ship.x, y - 15);

    if (ship.burn > 0) {
      ctx.fillStyle = '#fb923c';
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.fillText(`on fire (${ship.burn})`, ship.x, y + h + 14);
    }
    ctx.restore();
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D, q: Quality) {
    const fx = fxSprites();
    for (const p of this.projectiles) {
      if (!p.alive) continue;

      if (q.trails && p.trail.length > 4) {
        ctx.save();
        ctx.lineCap = 'round';
        for (let i = 2; i < p.trail.length; i += 2) {
          const t = i / p.trail.length;
          ctx.strokeStyle = `rgba(226, 232, 240, ${t * 0.28})`;
          ctx.lineWidth = p.r * 1.5 * t;
          ctx.beginPath();
          ctx.moveTo(p.trail[i - 2], p.trail[i - 1]);
          ctx.lineTo(p.trail[i], p.trail[i + 1]);
          ctx.stroke();
        }
        ctx.restore();
      }

      if (fx.spark && q.fancy) {
        const glow = p.r * 4;
        ctx.globalAlpha = 0.45;
        ctx.drawImage(fx.spark, p.x - glow / 2, p.y - glow / 2, glow, glow);
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = '#12161d';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.beginPath();
      ctx.arc(p.x - p.r * 0.32, p.y - p.r * 0.36, p.r * 0.34, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D) {
    const fx = fxSprites();
    for (const p of this.particles) {
      const t = p.life / p.max;
      const size = p.size * (1 + (1 - t) * (p.grow - 1));

      if (p.kind === 4) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, t * 1.6);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-size / 2, -size / 5, size, size / 2.5);
        ctx.restore();
        continue;
      }

      const sprite = p.kind === 0 ? fx.fire : p.kind === 1 ? fx.smoke : p.kind === 2 ? fx.spark : fx.splash;
      if (!sprite) continue;
      ctx.globalAlpha = p.kind === 1 ? Math.min(0.5, t * 0.7) : Math.min(1, t * 1.5);
      ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  private drawRings(ctx: CanvasRenderingContext2D) {
    for (const r of this.rings) {
      ctx.strokeStyle = `rgba(255, 236, 190, ${Math.max(0, r.life) * 0.55})`;
      ctx.lineWidth = r.width * Math.max(0.2, r.life);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawGuide(ctx: CanvasRenderingContext2D, q: Quality) {
    const arc = this.previewArc(q.aimDots);
    const color = TEAM_COLORS[this.turn].light;
    ctx.save();
    for (let i = 0; i < arc.length; i++) {
      ctx.globalAlpha = 0.85 - (i / arc.length) * 0.6;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(arc[i].x, arc[i].y, Math.max(2, 6 - i * 0.22), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** A shot that has climbed out of the frame still has to be findable. */
  private drawOffscreenMarkers(ctx: CanvasRenderingContext2D) {
    for (const p of this.projectiles) {
      if (!p.alive || p.y > 26) continue;
      const x = clamp(p.x, 30, ARENA.w - 30);
      ctx.fillStyle = 'rgba(255, 244, 214, 0.9)';
      ctx.beginPath();
      ctx.moveTo(x, 12);
      ctx.lineTo(x - 13, 34);
      ctx.lineTo(x + 13, 34);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawCall(ctx: CanvasRenderingContext2D) {
    if (this.callLeft <= 0 || !this.call) return;
    const t = Math.min(1, this.callLeft / 0.4);
    ctx.save();
    ctx.globalAlpha = t;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 62px system-ui, sans-serif';
    ctx.lineWidth = 10;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(4, 16, 28, 0.75)';
    ctx.fillStyle = '#fff7e0';
    const y = 150 - (1 - t) * 26;
    ctx.strokeText(this.call.toUpperCase(), ARENA.w / 2, y);
    ctx.fillText(this.call.toUpperCase(), ARENA.w / 2, y);
    ctx.restore();
  }
}

// -- helpers -----------------------------------------------------------------

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function easeIn(t: number): number {
  return t * t;
}

/** Nothing may take more than one turn's worth of hull off in one write. */
function clampClaim(current: number, claimed: number): number {
  const floor = Math.max(0, current - BALANCE.MAX_TURN_DAMAGE);
  const ceiling = Math.min(BALANCE.MAX_HP, current + 20);
  return clamp(claimed, floor, ceiling);
}

function inBox(x: number, y: number, box: Box, r: number): boolean {
  return x >= box.x0 - r && x <= box.x1 + r && y >= box.y0 - r && y <= box.y1 + r;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Earliest intersection of a moving circle with an axis-aligned box, as a
 * fraction of the step, or null.
 *
 * The box is inflated by the radius, which turns the moving-circle test into a
 * segment-versus-box one. The corners come out square rather than round: a few
 * pixels of generosity at the very corner of a hull, in exchange for a test
 * that is four comparisons instead of four more quadratics.
 */
function segmentBox(x0: number, y0: number, x1: number, y1: number, box: Box, r: number): number | null {
  const minX = box.x0 - r;
  const maxX = box.x1 + r;
  const minY = box.y0 - r;
  const maxY = box.y1 + r;

  if (x0 >= minX && x0 <= maxX && y0 >= minY && y0 <= maxY) return 0;

  const dx = x1 - x0;
  const dy = y1 - y0;
  let tMin = 0;
  let tMax = 1;

  for (let axis = 0; axis < 2; axis++) {
    const p = axis === 0 ? x0 : y0;
    const d = axis === 0 ? dx : dy;
    const lo = axis === 0 ? minX : minY;
    const hi = axis === 0 ? maxX : maxY;

    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return null;
      continue;
    }
    let t1 = (lo - p) / d;
    let t2 = (hi - p) / d;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin <= 1 ? tMin : null;
}

/** The same idea against a circle, for the rocks. */
function segmentCircle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  r: number,
): number | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const fx = x0 - cx;
  const fy = y0 - cy;

  const a = dx * dx + dy * dy;
  if (a < 1e-9) return fx * fx + fy * fy <= r * r ? 0 : null;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const root = Math.sqrt(disc);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}
