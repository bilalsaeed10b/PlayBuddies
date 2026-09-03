/**
 * The board: the position, the turn order, and the drawing of both.
 *
 * It knows nothing about React, the network or the shop. It is handed seats
 * and a first player, it is fed moves as plain integers, and it hands back a
 * move list — which is exactly what travels on the wire, so the same code path
 * serves a game against a bot and a game against three strangers.
 */
import {
  HORIZONTAL,
  LINES,
  Position,
  SIDES,
  SIZE,
  VERTICAL,
  applyMove,
  clamp,
  colOf,
  decodeWall,
  distanceToGoal,
  emptyPosition,
  encodeStep,
  encodeWall,
  isWallMove,
  moveLegal,
  pawnMoves,
  rowOf,
  wallLegal,
  winnerOf,
} from '../game/rules';
import type { Orientation, PlayerCount } from '../game/rules';
import { drawPawn } from '../game/pawns';
import type { Control } from '../types/game';

export interface Seat {
  /** The lobby uid online, a made-up id offline. Stable, and how a `bye` finds its pawn. */
  id: string;
  name: string;
  control: Control;
  /** Only meaningful when control is 'ai'. */
  aiLevel: number;
  /** Index into PAWNS. Cosmetic, always. */
  skin: number;
}

export type Sfx = 'step' | 'wall' | 'deny' | 'turn';

/** Where the board sits inside the canvas, in CSS pixels. */
interface View {
  x0: number;
  y0: number;
  /** The side of one square. */
  cell: number;
  /** The groove between two squares, which is also a wall's thickness. */
  gap: number;
  size: number;
}

interface Slide {
  seat: number;
  from: number;
  to: number;
  /** 0 to 1. */
  t: number;
}

const SLIDE_MS = 260;
const WALL_MS = 260;

/** Warm paper and wood. The whole palette lives here so nothing drifts. */
const PAINT = {
  plate: '#e2c9a0',
  plateEdge: '#b08d5c',
  square: '#f6ecd8',
  squareAlt: '#f0e3ca',
  groove: '#cbae83',
};

export class QuoridorEngine {
  readonly seats: Seat[];
  readonly players: PlayerCount;
  /** The seat that moved first. Needed to replay a move list from nothing. */
  readonly first: number;
  /**
   * Which game this is, stamped onto every packet the caller sends.
   *
   * A player's update document outlives the game that wrote it, so the first
   * snapshot after subscribing can be last night's final move. The caller
   * compares this against a packet's own tag and drops the stale ones.
   */
  readonly seedTag: number;

  pos: Position;
  turn: number;
  winner = -1;
  /** Every move played, in order. This is the game; everything else is derived. */
  history: number[] = [];

  /** What the local player is doing with the board right now. */
  mode: 'move' | 'wall' = 'move';
  /** Set from settings by the caller each frame; the engine only reads it. */
  showHints = true;
  /** The wall slot under the pointer, if any, and whether it could be dropped. */
  hover: { o: Orientation; r: number; c: number; ok: boolean } | null = null;
  /** The square under the pointer in move mode, when it is a legal target. */
  hoverCell = -1;

  private view: View = { x0: 0, y0: 0, cell: 1, gap: 0, size: 1 };
  private dpr = 1;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private slide: Slide | null = null;
  private wallPop: { code: number; t: number } | null = null;
  private denied = 0;

  private targetCache: { turn: number; stamp: number; list: number[] } | null = null;
  /** Bumped on every move, so the cache above can be invalidated in O(1). */
  private stamp = 0;

  constructor(
    private opts: {
      seats: Seat[];
      players: PlayerCount;
      first: number;
      seedTag: number;
      onSfx?: (kind: Sfx) => void;
      /** Fired for a move made on this device, so the caller can put it on the wire. */
      onLocalMove?: (history: number[]) => void;
      onOver?: (winner: number) => void;
    },
  ) {
    this.seats = opts.seats;
    this.players = opts.players;
    this.first = first(opts.first, opts.players);
    this.seedTag = opts.seedTag;
    this.turn = this.first;
    this.pos = emptyPosition(opts.players);
  }

  // -- the game ---------------------------------------------------------------

  /** True when the board is waiting on somebody sitting at this device. */
  get awaitingLocal(): boolean {
    return this.winner < 0 && !this.slide && this.seats[this.turn]?.control === 'local';
  }

  /** True when the board is waiting on a bot this device is responsible for. */
  awaitingAI(driving: boolean): boolean {
    return driving && this.winner < 0 && !this.slide && this.seats[this.turn]?.control === 'ai';
  }

  /** Squares the pawn whose turn it is may step to. Cached; this is read every frame. */
  targets(): number[] {
    if (this.targetCache?.turn === this.turn && this.targetCache.stamp === this.stamp) {
      return this.targetCache.list;
    }
    const list = this.winner >= 0 ? [] : pawnMoves(this.pos, this.turn);
    this.targetCache = { turn: this.turn, stamp: this.stamp, list };
    return list;
  }

  /** Steps still to go for each seat, for the HUD. Cheap enough to call per render. */
  distances(): number[] {
    return this.seats.map((_, seat) => distanceToGoal(this.pos, seat, this.players));
  }

  /**
   * A move made here, on this device.
   *
   * A move arriving mid-slide is swallowed rather than refused: the pawn is
   * still travelling, the board is a quarter of a second from being ready, and
   * buzzing at somebody for being early is not the same as telling them their
   * move was illegal.
   */
  play(move: number): boolean {
    if (this.winner >= 0 || this.slide) return false;
    if (this.seats[this.turn]?.control === 'remote') return false;
    if (!this.commit(move, true)) {
      this.denied = 1;
      this.opts.onSfx?.('deny');
      return false;
    }
    this.opts.onLocalMove?.(this.history.slice());
    return true;
  }

  /** Convenience for the two things the board's pointer can produce. */
  playStep(target: number) {
    return this.play(encodeStep(target));
  }

  playWall(o: Orientation, r: number, c: number) {
    return this.play(encodeWall(o, r, c));
  }

  /**
   * Take on a move list from somebody else.
   *
   * Three cases, in order of how often they happen: it is what we already
   * have, in which case nothing moves; it extends what we have, in which case
   * the new tail is played out with the last move animated; or it disagrees
   * with what we have, in which case ours was wrong and the whole thing is
   * rebuilt from square one. That last branch is why a client can miss any
   * number of snapshots, sleep, or reload and still end up on the right board.
   */
  syncHistory(remote: number[]): boolean {
    if (!Array.isArray(remote)) return false;
    const shared = prefixLength(this.history, remote);

    // Nothing here we do not already have. This is the common case with three
    // or more players: everybody's document holds the game as of *their* last
    // move, so most snapshots are older than the board already on screen, and
    // rebuilding from one would roll live moves back off it.
    if (shared === remote.length) return false;

    if (shared === this.history.length) {
      for (let i = shared; i < remote.length; i++) {
        // The last one is the move that just happened, so it gets the slide;
        // anything before it is catch-up and should simply appear.
        if (!this.commit(remote[i], i === remote.length - 1)) {
          // A move we consider illegal means our board and theirs have parted
          // company. Rebuilding from their list is the only honest answer.
          this.rebuild(remote);
          return true;
        }
      }
      return true;
    }

    this.rebuild(remote);
    return true;
  }

  /** Replays a whole move list onto a fresh board, silently. */
  private rebuild(moves: number[]) {
    this.pos = emptyPosition(this.players);
    this.turn = this.first;
    this.winner = -1;
    this.history = [];
    this.slide = null;
    this.wallPop = null;
    this.stamp++;
    for (const move of moves) {
      if (!this.commit(move, false, true)) break;
    }
  }

  /**
   * The one place a move is validated, applied and the turn handed on.
   *
   * `animate` decides whether the piece slides; `silent` suppresses the sound
   * and the game-over callback, which is what a rebuild wants.
   */
  private commit(move: number, animate: boolean, silent = false): boolean {
    if (this.winner >= 0) return false;
    const seat = this.turn;
    if (!moveLegal(this.pos, seat, move, this.players)) return false;

    if (isWallMove(move)) {
      applyMove(this.pos, seat, move);
      if (animate) this.wallPop = { code: move, t: 0 };
      if (!silent) this.opts.onSfx?.('wall');
    } else {
      const from = this.pos.pawns[seat];
      applyMove(this.pos, seat, move);
      if (animate) this.slide = { seat, from, to: move, t: 0 };
      if (!silent) this.opts.onSfx?.('step');
    }

    this.history.push(move);
    this.stamp++;

    const won = winnerOf(this.pos, this.players);
    if (won >= 0) {
      this.winner = won;
      if (!silent) this.opts.onOver?.(won);
      return true;
    }

    this.turn = (seat + 1) % this.players;
    if (!silent && this.seats[this.turn]?.control === 'local') this.opts.onSfx?.('turn');
    return true;
  }

  /**
   * Somebody left. Their pawn keeps their name and is played by a bot from
   * here on, which is a great deal better than a game that cannot continue.
   */
  handOverToAI(seat: number, aiLevel: number) {
    const s = this.seats[seat];
    if (!s || s.control === 'local') return;
    s.control = 'ai';
    s.aiLevel = aiLevel;
  }

  /** They're back. Take the pawn off the bot and give it back to the wire. */
  reclaimControl(seat: number) {
    const s = this.seats[seat];
    if (!s || s.control !== 'ai') return;
    s.control = 'remote';
  }

  // -- geometry ---------------------------------------------------------------

  resize(canvas: HTMLCanvasElement, cssW: number, cssH: number) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    // The board is square and centred. 0.88 rather than something closer to 1
    // because the grid is not the whole picture: the wooden rim around it is
    // 0.42 of a square wide, it carries the goal bands, and it has a drop
    // shadow under it. Sized to the grid alone, all three fell off the canvas.
    const size = Math.max(80, Math.min(cssW, cssH) * 0.88);
    const cell = size / (SIZE + (SIZE - 1) * 0.26);
    this.view = {
      x0: (cssW - size) / 2,
      y0: (cssH - size) / 2,
      cell,
      gap: cell * 0.26,
      size,
    };
  }

  /** The top-left of a square, in CSS pixels. */
  private squareX(c: number) {
    return this.view.x0 + c * (this.view.cell + this.view.gap);
  }

  private squareY(r: number) {
    return this.view.y0 + r * (this.view.cell + this.view.gap);
  }

  private centreX(c: number) {
    return this.squareX(c) + this.view.cell / 2;
  }

  private centreY(r: number) {
    return this.squareY(r) + this.view.cell / 2;
  }

  /** The square under a point, or -1 when the point is in a groove or off the board. */
  pickCell(px: number, py: number): number {
    const { x0, y0, cell, gap } = this.view;
    const step = cell + gap;
    const c = Math.floor((px - x0) / step);
    const r = Math.floor((py - y0) / step);
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return -1;
    // Inside the square itself, not the groove after it. A little slack, so a
    // fingertip that lands a pixel into the groove still counts.
    if (px - this.squareX(c) > cell + gap * 0.5) return -1;
    if (py - this.squareY(r) > cell + gap * 0.5) return -1;
    return r * SIZE + c;
  }

  /**
   * The wall slot nearest a point, and which way it should lie.
   *
   * A wall covers two squares, so it is centred on the crossing between four
   * of them: the same (r, c) names both the horizontal and the vertical
   * candidate, and only the orientation is in question. That is settled by
   * which of the two grooves the point is actually nearer — press along a row
   * and you get a wall along that row.
   */
  pickSlot(px: number, py: number, forced?: Orientation): { o: Orientation; r: number; c: number } | null {
    const { x0, y0, cell, gap, size } = this.view;
    const step = cell + gap;
    // A generous margin: dropping a wall on the board's rim is a common aim.
    if (px < x0 - cell || px > x0 + size + cell || py < y0 - cell || py > y0 + size + cell) return null;

    const c = Math.round((px - x0 - cell - gap / 2) / step);
    const r = Math.round((py - y0 - cell - gap / 2) / step);
    const cc = clamp(c, 0, LINES - 1);
    const rr = clamp(r, 0, LINES - 1);

    if (forced !== undefined) return { o: forced, r: rr, c: cc };

    const grooveY = y0 + rr * step + cell + gap / 2;
    const grooveX = x0 + cc * step + cell + gap / 2;
    const o: Orientation = Math.abs(py - grooveY) <= Math.abs(px - grooveX) ? HORIZONTAL : VERTICAL;
    return { o, r: rr, c: cc };
  }

  /** Points the hover ghost at a slot, working out for itself whether it is legal. */
  setHoverSlot(slot: { o: Orientation; r: number; c: number } | null) {
    if (!slot) {
      this.hover = null;
      return;
    }
    const ok = this.awaitingLocal && wallLegal(this.pos, this.turn, slot.o, slot.r, slot.c, this.players);
    this.hover = { ...slot, ok };
  }

  setHoverCell(target: number) {
    this.hoverCell = target >= 0 && this.targets().includes(target) ? target : -1;
  }

  // -- drawing ----------------------------------------------------------------

  draw(dtMs: number) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    if (this.slide) {
      this.slide.t += dtMs / SLIDE_MS;
      if (this.slide.t >= 1) this.slide = null;
    }
    if (this.wallPop) {
      this.wallPop.t += dtMs / WALL_MS;
      if (this.wallPop.t >= 1) this.wallPop = null;
    }
    if (this.denied > 0) this.denied = Math.max(0, this.denied - dtMs / 320);

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, canvas.width / this.dpr, canvas.height / this.dpr);

    this.drawPlate(ctx);
    this.drawGoals(ctx);
    this.drawSquares(ctx);
    this.drawTargets(ctx);
    this.drawWalls(ctx);
    this.drawGhost(ctx);
    this.drawPawns(ctx);

    ctx.restore();
  }

  private drawPlate(ctx: CanvasRenderingContext2D) {
    const { x0, y0, size, cell } = this.view;
    const pad = cell * 0.42;
    const r = cell * 0.5;
    ctx.save();
    ctx.shadowColor = 'rgba(60,42,20,0.28)';
    ctx.shadowBlur = cell * 0.7;
    ctx.shadowOffsetY = cell * 0.18;
    const g = ctx.createLinearGradient(x0, y0 - pad, x0 + size, y0 + size + pad);
    g.addColorStop(0, '#eddcbd');
    g.addColorStop(0.5, PAINT.plate);
    g.addColorStop(1, '#cdae82');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(x0 - pad, y0 - pad, size + pad * 2, size + pad * 2, r);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = PAINT.plateEdge;
    ctx.lineWidth = Math.max(1, cell * 0.045);
    ctx.beginPath();
    ctx.roundRect(x0 - pad, y0 - pad, size + pad * 2, size + pad * 2, r);
    ctx.stroke();
  }

  /**
   * A tinted band on the edge every seat is trying to reach.
   *
   * Reading which way you are going off the pawn's starting square is a thing
   * players get wrong constantly in a four-hander, and it is the one piece of
   * state the board can state outright rather than imply.
   */
  private drawGoals(ctx: CanvasRenderingContext2D) {
    const { x0, y0, size, cell } = this.view;
    // Painted *on* the wooden rim rather than floating outside it, which is
    // both the better picture and the reason the board no longer has to leave
    // a strip of empty canvas around itself for them.
    const band = cell * 0.22;
    const gapFromGrid = cell * 0.1;
    const near = gapFromGrid + band;

    for (let seat = 0; seat < this.players; seat++) {
      const side = SIDES[seat];
      const won = this.winner === seat;
      ctx.save();
      ctx.globalAlpha = won ? 0.95 : 0.6;
      ctx.fillStyle = side.main;
      // The goal is the far edge from home.
      if (side.home === 'south') ctx.fillRect(x0, y0 - near, size, band);
      else if (side.home === 'north') ctx.fillRect(x0, y0 + size + gapFromGrid, size, band);
      else if (side.home === 'west') ctx.fillRect(x0 + size + gapFromGrid, y0, band, size);
      else ctx.fillRect(x0 - near, y0, band, size);
      ctx.restore();
    }
  }

  private drawSquares(ctx: CanvasRenderingContext2D) {
    const { cell, gap } = this.view;
    ctx.save();
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const x = this.squareX(c);
        const y = this.squareY(r);
        ctx.fillStyle = (r + c) % 2 === 0 ? PAINT.square : PAINT.squareAlt;
        ctx.beginPath();
        ctx.roundRect(x, y, cell, cell, cell * 0.16);
        ctx.fill();
        // A hairline of groove colour under each square reads as a milled
        // channel rather than a gap between tiles.
        ctx.strokeStyle = PAINT.groove;
        ctx.lineWidth = Math.max(0.5, gap * 0.12);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawTargets(ctx: CanvasRenderingContext2D) {
    if (!this.showHints || this.mode !== 'move' || !this.awaitingLocal) return;
    const { cell } = this.view;
    const side = SIDES[this.turn];

    for (const target of this.targets()) {
      const x = this.centreX(colOf(target));
      const y = this.centreY(rowOf(target));
      const hot = target === this.hoverCell;
      ctx.save();
      ctx.globalAlpha = hot ? 0.4 : 0.22;
      ctx.fillStyle = side.main;
      ctx.beginPath();
      ctx.roundRect(x - cell / 2, y - cell / 2, cell, cell, cell * 0.16);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = hot ? 0.95 : 0.7;
      ctx.fillStyle = side.dark;
      ctx.beginPath();
      ctx.arc(x, y, cell * (hot ? 0.2 : 0.14), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private wallRect(o: Orientation, r: number, c: number) {
    const { cell, gap } = this.view;
    if (o === HORIZONTAL) {
      return {
        x: this.squareX(c),
        y: this.squareY(r) + cell,
        w: cell * 2 + gap,
        h: gap,
      };
    }
    return {
      x: this.squareX(c) + cell,
      y: this.squareY(r),
      w: gap,
      h: cell * 2 + gap,
    };
  }

  private paintWall(
    ctx: CanvasRenderingContext2D,
    o: Orientation,
    r: number,
    c: number,
    colour: string,
    dark: string,
    alpha: number,
    grow = 1,
  ) {
    const box = this.wallRect(o, r, c);
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const w = box.w * (o === HORIZONTAL ? grow : 1);
    const h = box.h * (o === VERTICAL ? grow : 1);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(50,34,16,0.4)';
    ctx.shadowBlur = this.view.gap * 0.9;
    ctx.shadowOffsetY = this.view.gap * 0.25;
    const g = ctx.createLinearGradient(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
    g.addColorStop(0, colour);
    g.addColorStop(1, dark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy - h / 2, w, h, Math.min(w, h) * 0.45);
    ctx.fill();
    ctx.restore();
  }

  private drawWalls(ctx: CanvasRenderingContext2D) {
    const popped = this.wallPop ? decodeWall(this.wallPop.code) : null;
    const grow = this.wallPop ? 0.35 + 0.65 * easeOut(this.wallPop.t) : 1;

    for (let o = 0 as Orientation; o <= 1; o = (o + 1) as Orientation) {
      const grid = o === HORIZONTAL ? this.pos.h : this.pos.v;
      for (let r = 0; r < LINES; r++) {
        for (let c = 0; c < LINES; c++) {
          const owner = grid[r * LINES + c];
          if (owner === 0) continue;
          const side = SIDES[(owner - 1) % SIDES.length];
          const isPop = popped && popped.o === o && popped.r === r && popped.c === c;
          this.paintWall(ctx, o, r, c, side.light, side.dark, 1, isPop ? grow : 1);
        }
      }
    }
  }

  private drawGhost(ctx: CanvasRenderingContext2D) {
    const hover = this.hover;
    if (!hover || this.mode !== 'wall' || !this.awaitingLocal) return;
    const side = SIDES[this.turn];
    if (hover.ok) {
      this.paintWall(ctx, hover.o, hover.r, hover.c, side.light, side.main, 0.62);
      return;
    }
    // An illegal slot still gets a ghost, in red. Showing nothing at all reads
    // as an unresponsive board rather than as "not there".
    this.paintWall(ctx, hover.o, hover.r, hover.c, '#fca5a5', '#b91c1c', 0.45 + this.denied * 0.3);
  }

  private drawPawns(ctx: CanvasRenderingContext2D) {
    const { cell } = this.view;
    const radius = cell * 0.4;

    for (let seat = 0; seat < this.players; seat++) {
      const side = SIDES[seat];
      const at = this.pos.pawns[seat];
      let x = this.centreX(colOf(at));
      let y = this.centreY(rowOf(at));

      if (this.slide && this.slide.seat === seat) {
        const k = easeOut(this.slide.t);
        const fx = this.centreX(colOf(this.slide.from));
        const fy = this.centreY(rowOf(this.slide.from));
        x = fx + (x - fx) * k;
        y = fy + (y - fy) * k;
        // A small hop, so a jump over somebody reads as a jump.
        y -= Math.sin(Math.PI * this.slide.t) * cell * 0.18;
      }

      const active = seat === this.turn && this.winner < 0;
      drawPawn(ctx, {
        skin: this.seats[seat]?.skin ?? 0,
        x,
        y,
        r: radius,
        main: side.main,
        light: side.light,
        dark: side.dark,
        lift: active ? 1 : 0,
        glow: active ? 1 : 0,
      });
    }
  }
}

/** Keeps a first-player index inside the seats that actually exist. */
function first(value: number, players: PlayerCount): number {
  return Number.isInteger(value) ? ((value % players) + players) % players : 0;
}

function prefixLength(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

const easeOut = (t: number) => 1 - (1 - clamp(t, 0, 1)) ** 3;
