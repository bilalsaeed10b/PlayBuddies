/**
 * The green on screen: the balls, the turn order, and the drawing of both.
 *
 * It knows nothing about React, the network or the shop. It is handed seats
 * and a seed, it is fed putts as an angle and a power, and it reports where
 * every ball came to rest — which is exactly what travels on the wire, so the
 * same code path serves a round against a bot and a round against three
 * strangers.
 */
import { BALL_R, HOLE_R, PHYSICS, SEATS, TURF, clamp, scoreName } from '../game/rules';
import type { HoleCount, PlayerCount, Shout } from '../game/rules';
import { blockDistance, buildCourse, dist, insideShape, pickupAt } from '../game/course';
import type { Block, Course, Vec } from '../game/course';
import { advance, launch, noEvents, surfaceAt } from '../game/physics';
import type { Ball, ShotEvents } from '../game/physics';
import { drawBall } from '../game/balls';
import type { Control, FirePacket, Phase, ShotPacket } from '../types/game';

export interface Seat {
  /** The lobby uid online, a made-up id offline. Stable, and how a `bye` finds its ball. */
  id: string;
  name: string;
  control: Control;
  /** Only meaningful when control is 'ai'. */
  aiLevel: number;
  /** Index into BALLS. Cosmetic, always. */
  skin: number;
}

/** Everything the caller needs to put a finished putt on the wire. */
export interface ShotReport {
  hole: number;
  seat: number;
  angle: number;
  power: number;
  x: number[];
  y: number[];
  k: number[];
  f: number[];
  tot: number[];
  next: number;
}

/** Where the course sits inside the canvas. World units times `scale`, plus an offset. */
interface View {
  scale: number;
  ox: number;
  oy: number;
}

interface Roll {
  seat: number;
  angle: number;
  power: number;
  /** Where the ball was struck from. A drowned ball is played again from here. */
  from: Vec;
  events: ShotEvents;
  t: number;
  local: boolean;
}

/** How long the scorecard sits on screen between holes. */
const CARD_MS = 3400;
const TRAIL = 26;

export class GolfEngine {
  readonly seats: Seat[];
  readonly players: PlayerCount;
  readonly holes: HoleCount;
  readonly hazards: boolean;
  /**
   * Which round this is, stamped onto every packet the caller sends.
   *
   * A player's update document outlives the round that wrote it, so the first
   * snapshot after subscribing can be last night's final putt. The caller
   * compares this against a packet's own tag and drops the stale ones.
   */
  readonly seedTag: number;
  private readonly seed: number;
  private readonly firstSeat: number;

  holeIndex = 0;
  course: Course;
  balls: Ball[] = [];
  /** Strokes taken on the hole in play. */
  strokes: number[] = [];
  /** Holed out, or picked up at the stroke limit. */
  done: boolean[] = [];
  /** Strokes on every *completed* hole. The running total is this plus `strokes`. */
  totals: number[] = [];
  /** Per hole, per seat. Blank for holes this client never saw. */
  card: (number | null)[][] = [];
  turn: number;
  phase: Phase = 'aim';
  /** Lowest total once the round is over. -1 until then. */
  winner = -1;

  /** Live aim, written straight from the pad and read by the draw. */
  aimAngle = 0;
  aimPower = 0.5;
  dragging = false;

  private view: View = { scale: 1, ox: 0, oy: 0 };
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private ctx: CanvasRenderingContext2D | null = null;

  private roll: Roll | null = null;
  private acc = 0;
  private trail: number[] = [];
  /** An authoritative result that landed while its own replay was still running. */
  private pendingSnap: ShotPacket | null = null;
  private holeOverAt = 0;
  private clock = 0;
  /** The last hole banked into `totals`, so it can never be banked twice. */
  private recordedHole = -1;
  /** Flag sway and water shimmer, so the green is not a still image between putts. */
  private idleT = 0;

  constructor(
    private opts: {
      seats: Seat[];
      players: PlayerCount;
      holes: HoleCount;
      hazards: boolean;
      seed: number;
      first: number;
      onSfx?: (kind: 'putt' | 'wall' | 'splash' | 'drop' | 'sand') => void;
      onShout?: (kind: Shout) => void;
      /** A ball went in. The caller turns this into HOLE IN ONE!, BIRDIE and so on. */
      onHoled?: (seat: number, strokes: number, par: number) => void;
      /** Fired the moment a local putt is struck, so the far side can start rolling too. */
      onLocalFire?: (seat: number, angle: number, power: number, hole: number) => void;
      /** Fired once a local putt has settled and the green is authoritative. */
      onLocalShot?: (report: ShotReport) => void;
      onOver?: (winner: number, totals: number[]) => void;
    },
  ) {
    this.seats = opts.seats;
    this.players = opts.players;
    this.holes = opts.holes;
    this.hazards = opts.hazards;
    this.seed = opts.seed;
    this.seedTag = opts.seed;
    this.firstSeat = clamp(Math.trunc(opts.first), 0, opts.players - 1);
    this.turn = this.firstSeat;
    this.totals = new Array(opts.players).fill(0);
    this.course = this.makeCourse(0);
    this.resetHole();
  }

  // -- the round --------------------------------------------------------------

  private makeCourse(hole: number): Course {
    const course = buildCourse(this.seed, hole, this.players);
    if (!this.hazards) {
      // Stripping ponds and bunkers can only ever *open* a green up, so a
      // course that passed the reachability check with them still passes
      // without. That is why this is safe to do after the fact rather than
      // having to thread a flag all the way through the generator.
      course.sand = [];
      course.water = [];
    }
    return course;
  }

  private resetHole() {
    const spread = BALL_R * 2.8;
    this.balls = [];
    for (let i = 0; i < this.players; i++) {
      // Fanned out around the tee, because four balls on the same pixel is not
      // a tee box, it is one ball.
      const a = (i / this.players) * Math.PI * 2 + 0.6;
      let x = this.course.tee.x + Math.cos(a) * spread;
      let y = this.course.tee.y + Math.sin(a) * spread;
      if (!insideShape(this.course.shape, this.course.w, this.course.h, x, y, BALL_R)) {
        x = this.course.tee.x;
        y = this.course.tee.y;
      }
      this.balls.push({ x, y, vx: 0, vy: 0, moving: false });
    }
    this.strokes = new Array(this.players).fill(0);
    this.done = new Array(this.players).fill(false);
    this.roll = null;
    this.pendingSnap = null;
    this.trail = [];
    this.phase = 'aim';
    this.aimPower = 0.5;
    this.aimAngle = Math.atan2(this.course.hole.y - this.balls[this.turn].y, this.course.hole.x - this.balls[this.turn].x);
    this.fitView();
  }

  /** True when the green is waiting on somebody sitting at this device. */
  get awaitingLocal(): boolean {
    return this.phase === 'aim' && !this.roll && this.seats[this.turn]?.control === 'local';
  }

  /** True when the green is waiting on a bot this device is responsible for. */
  awaitingAI(driving: boolean): boolean {
    return driving && this.phase === 'aim' && !this.roll && this.seats[this.turn]?.control === 'ai';
  }

  /** Running total for a seat: completed holes plus whatever this one has cost so far. */
  total(seat: number): number {
    return (this.totals[seat] ?? 0) + (this.strokes[seat] ?? 0);
  }

  /** Par for every hole this client has actually seen, for the card's footer. */
  get par(): number {
    return this.course.par;
  }

  /**
   * A putt struck here, on this device.
   *
   * Rejected rather than queued while anything is still rolling — a second
   * swing landing mid-shot is a double-hit, and the wire has no way to express
   * one.
   */
  putt(angle: number, power: number): boolean {
    if (!this.awaitingLocal && !this.awaitingAI(true)) return false;
    const seat = this.turn;
    this.beginRoll(seat, angle, power, true);
    this.opts.onLocalFire?.(seat, angle, power, this.holeIndex);
    return true;
  }

  private beginRoll(seat: number, angle: number, power: number, local: boolean) {
    const from = { x: this.balls[seat].x, y: this.balls[seat].y };
    const struck = launch(from, angle, clamp(power, PHYSICS.MIN_POWER, 1));
    this.balls[seat] = struck;
    this.strokes[seat] += 1;
    this.roll = { seat, angle, power, from, events: noEvents(), t: 0, local };
    this.acc = 0;
    this.trail = [struck.x, struck.y];
    this.phase = 'rolling';
    this.opts.onSfx?.('putt');
  }

  private nextTurn(from: number): number {
    for (let i = 1; i <= this.players; i++) {
      const seat = (from + i) % this.players;
      if (!this.done[seat]) return seat;
    }
    return -1;
  }

  /**
   * A putt has stopped. Score it, say something about it, and pass the turn.
   *
   * When an authoritative result for this same shot has already arrived from
   * its owner, everything worked out here is thrown away in favour of theirs —
   * the local replay exists to be watched, not to be believed.
   */
  private settle() {
    const roll = this.roll;
    if (!roll) return;
    this.roll = null;

    const seat = roll.seat;
    const events = roll.events;
    const limit = pickupAt(this.course.par);

    if (events.splash) {
      // Stroke and distance, which is the real rule and the one that makes a
      // pond frightening: a shot penalty, and the ball goes back to the spot it
      // was played from rather than being dropped on the near bank. Dropping on
      // the bank quietly rewarded going in — the far bank of a pond that sits
      // between you and the flag is *progress* — so the safe way round was the
      // slow way round and nobody ever took it.
      this.strokes[seat] += 1;
      const ball = this.balls[seat];
      ball.x = roll.from.x;
      ball.y = roll.from.y;
      ball.vx = 0;
      ball.vy = 0;
      ball.moving = false;
      this.trail = [];
      this.opts.onSfx?.('splash');
    } else if (events.holed) {
      this.opts.onSfx?.('drop');
    } else if (events.bounces > 0) {
      this.opts.onSfx?.('wall');
    }

    if (events.holed) this.done[seat] = true;
    else if (this.strokes[seat] >= limit) this.done[seat] = true;

    this.shoutFor(seat, events);

    const next = this.nextTurn(seat);
    this.turn = next < 0 ? seat : next;
    this.phase = next < 0 ? 'holeOver' : 'aim';
    if (next < 0) this.holeOverAt = this.clock;
    this.aimAt(this.turn);

    if (events.holed) this.opts.onHoled?.(seat, this.strokes[seat], this.course.par);

    if (roll.local) {
      this.opts.onLocalShot?.({
        hole: this.holeIndex,
        seat,
        angle: roll.angle,
        power: roll.power,
        x: this.balls.map((b) => b.x),
        y: this.balls.map((b) => b.y),
        k: this.strokes.slice(),
        f: this.done.map((d) => (d ? 1 : 0)),
        tot: this.totals.slice(),
        next,
      });
    }

    if (this.pendingSnap) {
      const snap = this.pendingSnap;
      this.pendingSnap = null;
      this.applySnapshot(snap);
    }

    if (this.phase === 'holeOver') this.recordHole();
  }

  /** The commentary, which is most of the reason anyone watches somebody else's putt. */
  private shoutFor(seat: number, events: ShotEvents) {
    if (events.holed) return;
    if (events.splash) return this.opts.onShout?.('splash');
    if (events.lipped) return this.opts.onShout?.('lip');
    if (events.endedInSand) {
      this.opts.onSfx?.('sand');
      return this.opts.onShout?.('bunker');
    }

    const gap = dist(this.balls[seat], this.course.hole);
    if (gap < HOLE_R * 1.6) return this.opts.onShout?.('gimme');
    if (gap < HOLE_R * 3.2) return this.opts.onShout?.('close');
    if (events.endedInRough) return this.opts.onShout?.('rough');
    if (events.bounces >= 2) return this.opts.onShout?.('wall');
  }

  /**
   * Bank this hole's strokes into the card and the totals.
   *
   * Idempotent per hole, and it has to be: a remote putt that finishes a hole
   * reaches here twice — once when this client's own replay of it settles, and
   * again when the shooter's authoritative green is applied on top. Without
   * the guard the second pass added every score a second time and the round
   * ended with doubled totals.
   */
  private recordHole() {
    if (this.recordedHole === this.holeIndex) return;
    this.recordedHole = this.holeIndex;
    while (this.card.length <= this.holeIndex) this.card.push(new Array(this.players).fill(null));
    for (let i = 0; i < this.players; i++) {
      this.card[this.holeIndex][i] = this.strokes[i];
      this.totals[i] += this.strokes[i];
    }
    this.strokes = new Array(this.players).fill(0);
  }

  /**
   * On to the next hole, or to the clubhouse.
   *
   * Every client does this on its own clock once the card has been up long
   * enough. They do not have to agree on the exact moment: whoever has honours
   * plays first, and their putt is stamped with the hole number, so anybody
   * still looking at the card is pulled forward by the first shot that lands.
   */
  advanceHole() {
    if (this.phase !== 'holeOver') return;
    if (this.holeIndex + 1 >= this.holes) {
      this.finish();
      return;
    }
    // Honours: lowest score on the hole just played tees off next, ties going
    // to the earlier seat. Every client computes the identical answer.
    const played = this.card[this.holeIndex] ?? [];
    let best = 0;
    for (let i = 1; i < this.players; i++) {
      if ((played[i] ?? 99) < (played[best] ?? 99)) best = i;
    }
    this.holeIndex += 1;
    this.turn = best;
    this.course = this.makeCourse(this.holeIndex);
    this.resetHole();
  }

  private finish() {
    this.phase = 'over';
    let best = 0;
    for (let i = 1; i < this.players; i++) if (this.totals[i] < this.totals[best]) best = i;
    this.winner = best;
    this.opts.onOver?.(best, this.totals.slice());
  }

  /** Points the aim straight at the flag, which is where anybody starts from. */
  private aimAt(seat: number) {
    const b = this.balls[seat];
    if (!b) return;
    this.aimAngle = Math.atan2(this.course.hole.y - b.y, this.course.hole.x - b.x);
    this.aimPower = clamp(dist(b, this.course.hole) / 140, 0.25, 1);
  }

  /** The putt the turn clock plays for somebody who ran out of time. */
  timeoutShot(): { angle: number; power: number } {
    const b = this.balls[this.turn];
    const angle = Math.atan2(this.course.hole.y - b.y, this.course.hole.x - b.x);
    return { angle, power: clamp(dist(b, this.course.hole) / 135, 0.2, 1) };
  }

  // -- the wire ---------------------------------------------------------------

  /** Somebody else swung. Start rolling their ball now rather than in three seconds. */
  applyFire(p: FirePacket) {
    if (p.s !== this.seedTag) return;
    if (p.hl > this.holeIndex) this.jumpToHole(p.hl);
    if (p.hl !== this.holeIndex) return;
    if (this.roll || this.phase !== 'aim') return;
    if (p.b < 0 || p.b >= this.players) return;
    if (this.done[p.b]) return;
    this.turn = p.b;
    this.beginRoll(p.b, p.a, p.p, false);
  }

  /** The settled truth for a putt somebody else took. */
  applyShot(p: ShotPacket) {
    if (p.s !== this.seedTag) return;
    if (p.hl > this.holeIndex) this.jumpToHole(p.hl);
    if (p.hl !== this.holeIndex) return;
    // Its own replay is still running: let it finish, then take the numbers.
    if (this.roll && this.roll.seat === p.b) {
      this.pendingSnap = p;
      return;
    }
    this.applySnapshot(p);
  }

  /**
   * Take a green exactly as its owner reported it.
   *
   * This is the only place a remote result is believed, and it believes all of
   * it at once — positions, strokes, who is out, whose turn — because a green
   * that is half one client's idea and half another's is worse than either.
   */
  private applySnapshot(p: ShotPacket) {
    const wasDone = this.done.slice();

    for (let i = 0; i < this.players; i++) {
      const b = this.balls[i];
      if (!b) continue;
      if (typeof p.x[i] === 'number') b.x = p.x[i];
      if (typeof p.y[i] === 'number') b.y = p.y[i];
      b.vx = 0;
      b.vy = 0;
      b.moving = false;
      if (typeof p.k[i] === 'number') this.strokes[i] = p.k[i];
      if (typeof p.f[i] === 'number') this.done[i] = p.f[i] === 1;
      if (typeof p.tot?.[i] === 'number') this.totals[i] = p.tot[i];
    }

    this.roll = null;
    this.trail = [];

    // A ball that was in play and now is not went in — unless it hit the
    // stroke limit, which is not something to congratulate anybody for.
    for (let i = 0; i < this.players; i++) {
      if (!wasDone[i] && this.done[i] && this.strokes[i] < pickupAt(this.course.par)) {
        this.opts.onHoled?.(i, this.strokes[i], this.course.par);
      }
    }

    if (p.o < 0) {
      this.turn = p.b;
      this.phase = 'holeOver';
      this.holeOverAt = this.clock;
      this.recordHole();
    } else {
      this.turn = clamp(p.o, 0, this.players - 1);
      this.phase = 'aim';
      this.aimAt(this.turn);
    }
  }

  /**
   * Catch up to a hole this client had not reached yet.
   *
   * Only ever forwards. A packet for an earlier hole is a straggler from
   * somebody whose scorecard was still up, and replaying it would drag
   * everyone back onto a green they have already left.
   */
  private jumpToHole(hole: number) {
    if (hole <= this.holeIndex || hole >= this.holes) return;
    // The holes being skipped were still played; without banking something for
    // them the card would silently renumber. `tot` from the packet overwrites
    // these a moment later anyway.
    while (this.card.length < hole) this.card.push(new Array(this.players).fill(null));
    this.holeIndex = hole;
    this.course = this.makeCourse(hole);
    this.resetHole();
  }

  /**
   * Somebody left. Their ball keeps their name and is played by a bot from
   * here on, which is a great deal better than a round that cannot continue.
   */
  handOverToAI(seat: number, aiLevel: number) {
    const s = this.seats[seat];
    if (!s || s.control === 'local') return;
    s.control = 'ai';
    s.aiLevel = aiLevel;
  }

  // -- geometry ---------------------------------------------------------------

  resize(canvas: HTMLCanvasElement, cssW: number, cssH: number) {
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    canvas.width = Math.round(this.cssW * this.dpr);
    canvas.height = Math.round(this.cssH * this.dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    this.fitView();
  }

  /**
   * Fit the whole green on screen, every hole.
   *
   * There is no scrolling camera on purpose: a course is small enough to see
   * at once, and being able to see the flag while you aim at it is the whole
   * appeal of the top-down view.
   */
  private fitView() {
    const pad = 16;
    const scale = Math.min(
      (this.cssW - pad * 2) / this.course.w,
      (this.cssH - pad * 2) / this.course.h,
    );
    this.view = {
      scale,
      ox: (this.cssW - this.course.w * scale) / 2,
      oy: (this.cssH - this.course.h * scale) / 2,
    };
  }

  private sx = (x: number) => this.view.ox + x * this.view.scale;
  private sy = (y: number) => this.view.oy + y * this.view.scale;

  /** Screen point back to world, for the pad's hit-testing. */
  toWorld(px: number, py: number): Vec {
    return { x: (px - this.view.ox) / this.view.scale, y: (py - this.view.oy) / this.view.scale };
  }

  /** Where the ball to play is, on screen. The aim gesture draws from here. */
  activeBallScreen(): { x: number; y: number } | null {
    const b = this.balls[this.turn];
    if (!b) return null;
    return { x: this.sx(b.x), y: this.sy(b.y) };
  }

  // -- the loop ---------------------------------------------------------------

  draw(dtMs: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const dt = Math.min(0.05, dtMs / 1000);
    this.clock += dtMs;
    this.idleT += dt;

    this.stepPhysics(dt);

    if (this.phase === 'holeOver' && this.clock - this.holeOverAt > CARD_MS) this.advanceHole();

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    this.drawSurround(ctx);
    this.drawGreen(ctx);
    this.drawSand(ctx);
    this.drawWater(ctx);
    this.drawBlocks(ctx);
    this.drawTee(ctx);
    this.drawCup(ctx);
    this.drawAim(ctx);
    this.drawTrail(ctx);
    this.drawBalls(ctx);
    this.drawFlag(ctx);

    ctx.restore();
  }

  private stepPhysics(dt: number) {
    const roll = this.roll;
    if (!roll) return;
    const ball = this.balls[roll.seat];
    if (!ball) return;

    this.acc = Math.min(this.acc + dt, 0.25);
    let guard = 0;
    while (this.acc >= PHYSICS.STEP && ball.moving && guard++ < 400) {
      advance(this.course, ball, PHYSICS.STEP, roll.events);
      this.acc -= PHYSICS.STEP;
      roll.t += PHYSICS.STEP;
      this.trail.push(ball.x, ball.y);
      if (this.trail.length > TRAIL * 2) this.trail.splice(0, this.trail.length - TRAIL * 2);
    }

    if (!ball.moving || roll.t > PHYSICS.MAX_FLIGHT) {
      ball.moving = false;
      this.settle();
    }
  }

  // -- drawing ----------------------------------------------------------------

  /** Traces the green's outline in screen space. Used to fill it and to clip to it. */
  private pathShape(ctx: CanvasRenderingContext2D, inset = 0) {
    const s = this.course.shape;
    const k = this.view.scale;
    ctx.beginPath();
    if (s.kind === 'rect') {
      ctx.rect(
        this.sx(inset),
        this.sy(inset),
        (this.course.w - inset * 2) * k,
        (this.course.h - inset * 2) * k,
      );
      return;
    }
    const base = Math.atan2(s.ny, s.nx);
    ctx.arc(this.sx(s.cx), this.sy(s.cy), (s.r - inset) * k, base - Math.PI / 2, base + Math.PI / 2);
    ctx.closePath();
  }

  private drawSurround(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = TURF.rough;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
  }

  private drawGreen(ctx: CanvasRenderingContext2D) {
    const k = this.view.scale;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = TURF.green;
    this.pathShape(ctx);
    ctx.fill();
    ctx.restore();

    // Mowing stripes. Two tones of the same green, banded at the course's own
    // angle, clipped to the shape — the thing that makes a flat fill read as
    // grass rather than as a coloured rectangle.
    ctx.save();
    this.pathShape(ctx);
    ctx.clip();
    const band = 13 * k;
    const diag = Math.hypot(this.course.w, this.course.h) * k;
    ctx.translate(this.sx(this.course.w / 2), this.sy(this.course.h / 2));
    ctx.rotate(this.course.stripe);
    ctx.fillStyle = TURF.greenAlt;
    for (let y = -diag; y < diag; y += band * 2) ctx.fillRect(-diag, y, diag * 2, band);
    ctx.restore();

    // A shaggier ring just inside the wall — the same band the physics slows
    // the ball down in, so the surface you can see is the surface you get.
    ctx.save();
    this.pathShape(ctx);
    ctx.clip();
    ctx.strokeStyle = TURF.fringe;
    ctx.lineWidth = 7 * k * 2;
    this.pathShape(ctx);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = TURF.edge;
    ctx.lineWidth = Math.max(2, 2.6 * k);
    this.pathShape(ctx);
    ctx.stroke();
  }

  private drawSand(ctx: CanvasRenderingContext2D) {
    const k = this.view.scale;
    ctx.save();
    this.pathShape(ctx);
    ctx.clip();
    for (const p of this.course.sand) {
      const g = ctx.createRadialGradient(this.sx(p.x), this.sy(p.y), p.r * k * 0.2, this.sx(p.x), this.sy(p.y), p.r * k);
      g.addColorStop(0, TURF.sand);
      g.addColorStop(1, TURF.sandDark);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(this.sx(p.x), this.sy(p.y), p.r * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,96,52,0.35)';
      ctx.lineWidth = Math.max(1, k * 0.8);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawWater(ctx: CanvasRenderingContext2D) {
    const k = this.view.scale;
    ctx.save();
    this.pathShape(ctx);
    ctx.clip();
    for (const p of this.course.water) {
      ctx.fillStyle = TURF.water;
      ctx.beginPath();
      ctx.arc(this.sx(p.x), this.sy(p.y), p.r * k, 0, Math.PI * 2);
      ctx.fill();
      // Two slow rings. Cheaper than any real ripple and reads the same from
      // this far up.
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = Math.max(1, k * 0.7);
      for (let i = 0; i < 2; i++) {
        const t = (this.idleT * 0.35 + i * 0.5) % 1;
        ctx.globalAlpha = 0.5 * (1 - t);
        ctx.beginPath();
        ctx.arc(this.sx(p.x), this.sy(p.y), p.r * k * (0.25 + t * 0.7), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = TURF.waterLight;
      ctx.lineWidth = Math.max(1.5, k * 1.1);
      ctx.beginPath();
      ctx.arc(this.sx(p.x), this.sy(p.y), p.r * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Traces a block, at whatever angle it lies.
   *
   * The rotation is applied while the path is being built and then unwound —
   * a canvas path bakes the transform in as each segment is added, so a
   * save/rotate/build/restore leaves exactly the rotated shape behind.
   */
  private blockPath(ctx: CanvasRenderingContext2D, b: Block, grow: number) {
    const k = this.view.scale;
    ctx.beginPath();
    if (b.kind === 'circle') {
      ctx.arc(this.sx(b.x), this.sy(b.y), (b.r + grow) * k, 0, Math.PI * 2);
      return;
    }
    const bw = (b.w + grow * 2) * k;
    const bh = (b.h + grow * 2) * k;
    ctx.save();
    ctx.translate(this.sx(b.cx), this.sy(b.cy));
    ctx.rotate(b.a);
    ctx.roundRect(-bw / 2, -bh / 2, bw, bh, Math.min(bw, bh) * 0.22);
    ctx.restore();
  }

  private drawBlocks(ctx: CanvasRenderingContext2D) {
    const k = this.view.scale;
    for (const b of this.course.blocks) {
      // The offset goes on before the path is built, not after: a path takes
      // the transform that was in force as each segment was added, so
      // translating once the shape is already traced moves nothing at all and
      // the shadow sat exactly underneath the block.
      ctx.save();
      ctx.translate(k * 1.6, k * 2.2);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#0d2415';
      this.blockPath(ctx, b, 0.6);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = TURF.block;
      this.blockPath(ctx, b, 0);
      ctx.fill();
      // A lighter cap inset from the edge reads as height from directly above,
      // which a flat fill never does.
      ctx.fillStyle = TURF.blockTop;
      this.blockPath(ctx, b, -1.4);
      ctx.fill();
    }
  }

  private drawTee(ctx: CanvasRenderingContext2D) {
    const k = this.view.scale;
    const t = this.course.tee;
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = Math.max(1, k * 0.7);
    ctx.setLineDash([k * 2.5, k * 2.5]);
    ctx.beginPath();
    ctx.arc(this.sx(t.x), this.sy(t.y), BALL_R * 4.4 * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawCup(ctx: CanvasRenderingContext2D) {
    const k = this.view.scale;
    const h = this.course.hole;

    ctx.fillStyle = 'rgba(9,32,18,0.5)';
    ctx.beginPath();
    ctx.arc(this.sx(h.x), this.sy(h.y), HOLE_R * 1.5 * k, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = TURF.cup;
    ctx.beginPath();
    ctx.arc(this.sx(h.x), this.sy(h.y), HOLE_R * k, 0, Math.PI * 2);
    ctx.fill();
    // A bright crescent on the far rim: from above, the near lip is in shade
    // and the far one catches the light.
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = Math.max(1, k * 0.8);
    ctx.beginPath();
    ctx.arc(this.sx(h.x), this.sy(h.y), HOLE_R * k * 0.94, Math.PI * 1.1, Math.PI * 1.95);
    ctx.stroke();
  }

  /**
   * The aim line: six dots from the ball, out as far as the pull will carry.
   *
   * Always six, and evenly spread over however much room there actually is —
   * the run is cut short at the first thing it would hit, and the dots are
   * fitted to what is left. So the gaps carry two pieces of information at
   * once: wide apart is a hard putt with a clear run, bunched up is a hard
   * putt into something a few units away.
   *
   * Fitting them rather than spacing them at a fixed pitch matters now that
   * barriers are laid deliberately across the line to the flag. A fixed pitch
   * with a hard stop drew one or two dots on most greens and none at all on
   * some, which reads as a broken guide rather than a short one.
   *
   * It deliberately does not predict the bounce past the obstruction. Where
   * the ball goes after the boards is the part worth being good at.
   */
  private drawAim(ctx: CanvasRenderingContext2D) {
    if (this.phase !== 'aim' || this.roll) return;
    if (this.seats[this.turn]?.control !== 'local') return;
    const ball = this.balls[this.turn];
    if (!ball) return;

    const k = this.view.scale;
    const power = clamp(this.aimPower, 0, 1);
    const reach = 26 + power * 118;
    const cos = Math.cos(this.aimAngle);
    const sin = Math.sin(this.aimAngle);
    const start = BALL_R * 2.2;

    // March out until the line meets a wall or a block, and keep that length.
    let clear = reach;
    for (let d = start; d <= reach; d += 2) {
      const x = ball.x + cos * d;
      const y = ball.y + sin * d;
      if (
        !insideShape(this.course.shape, this.course.w, this.course.h, x, y, BALL_R * 0.4) ||
        this.course.blocks.some((b) => blockHit(b, x, y))
      ) {
        clear = d;
        break;
      }
    }

    const count = 6;
    const span = Math.max(2, clear - start);
    // Bunched into a short run means the way ahead is short: dim the line a
    // little so a blocked aim does not look as confident as an open one.
    const crowded = clamp(span / reach, 0.35, 1);

    ctx.save();
    for (let i = 1; i <= count; i++) {
      const t = i / count;
      const x = ball.x + cos * (start + t * span);
      const y = ball.y + sin * (start + t * span);
      ctx.globalAlpha = (this.dragging ? 0.95 : 0.55) * (1 - t * 0.45) * crowded;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(this.sx(x), this.sy(y), Math.max(1.3, (2.1 - t * 0.7) * k * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawTrail(ctx: CanvasRenderingContext2D) {
    if (this.trail.length < 4) return;
    const k = this.view.scale;
    const points = this.trail.length / 2;
    ctx.save();
    for (let i = 0; i < points; i++) {
      const t = i / points;
      ctx.globalAlpha = t * 0.3;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(this.sx(this.trail[i * 2]), this.sy(this.trail[i * 2 + 1]), BALL_R * k * 0.7 * t, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawBalls(ctx: CanvasRenderingContext2D) {
    const k = this.view.scale;
    for (let i = 0; i < this.players; i++) {
      const b = this.balls[i];
      if (!b) continue;
      // A holed ball is in the cup, not on the green. Drawing it on top of the
      // flag looks like it is still in play.
      if (this.done[i] && dist(b, this.course.hole) < HOLE_R) continue;
      const seat = SEATS[i % SEATS.length];
      drawBall(ctx, {
        skin: this.seats[i]?.skin ?? 0,
        x: this.sx(b.x),
        y: this.sy(b.y),
        r: Math.max(3, BALL_R * k),
        ring: this.done[i] ? '#94a3b8' : seat.main,
        active: i === this.turn && this.phase === 'aim' ? 1 : 0,
      });
    }
  }

  private drawFlag(ctx: CanvasRenderingContext2D) {
    const k = this.view.scale;
    const h = this.course.hole;
    const x = this.sx(h.x);
    const y = this.sy(h.y);
    const height = 15 * k;
    const sway = Math.sin(this.idleT * 1.7) * 0.09;

    ctx.save();
    // The stick leans away from the cup so it does not hide the target.
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#0d2415';
    ctx.beginPath();
    ctx.ellipse(x + height * 0.42, y + height * 0.12, height * 0.5, height * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.translate(x, y);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = Math.max(1.4, k * 0.9);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -height);
    ctx.stroke();

    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(0, -height);
    ctx.lineTo(height * 0.62 + sway * height, -height + height * 0.2);
    ctx.lineTo(0, -height + height * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/** Point-in-block, for stopping the aim line at the first thing in its way. */
function blockHit(b: Block, x: number, y: number): boolean {
  return blockDistance(b, x, y) < 0;
}

/** Re-exported so screens can name a score without reaching into game/rules. */
export { scoreName, surfaceAt };
