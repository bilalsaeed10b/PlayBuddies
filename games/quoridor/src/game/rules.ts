/**
 * Quoridor, as rules rather than as pixels.
 *
 * Nothing in this file touches React, a canvas or the network. It is the whole
 * game — where a pawn may step, where a wall may go, and whether a board is
 * still solvable — expressed over two plain arrays, so the engine, the bot and
 * a test can all ask the same questions of the same position.
 *
 * The board is not one fixed size any more. A duel and a four-way free-for-all
 * are played on the classic nine squares; a 2v2 is played on eleven, because
 * two pawns sharing a starting edge need lanes of their own to run in. What
 * makes that bearable is that the *index space* never changes size — see
 * STRIDE below.
 */

/**
 * The largest board any mode uses, and the row stride of every cell index.
 *
 * Cell 0 is always the top-left square and `cell(r, c)` is always
 * `r * STRIDE + c`, whether the board underneath measures nine squares or
 * eleven. Indices on a small board are therefore sparse — a 9x9 game never
 * mentions column 9 — and that is the point: `rowOf`, `colOf`, `encodeStep`
 * and `encodeWall` are the same functions for every board size, so a move list
 * means one thing everywhere and the wire format does not fork per mode.
 * `inBoard` is the single place that knows how wide the board actually is.
 */
export const MAX_SIZE = 13;
const STRIDE = MAX_SIZE;
/** Grooves along one edge of the largest board. Wall slots are indexed by this. */
const WALL_STRIDE = MAX_SIZE - 1;
export const MAX_CELLS = STRIDE * STRIDE;
const WALL_SLOTS = WALL_STRIDE * WALL_STRIDE;

/** The classic board: a duel, and a four-way free-for-all. */
export const DUEL_SIZE = 9;
/**
 * The 2v2 board.
 *
 * Two more squares each way than the classic. Partners start on the same edge,
 * so they need room to run without shouldering each other the whole way, and
 * the extra length is what stops a pair from simply out-tempoing a wall.
 */
export const PAIRS_SIZE = 11;

export type Orientation = 0 | 1;
/** A wall lying along a row groove, blocking movement up and down. */
export const HORIZONTAL: Orientation = 0;
/** A wall standing in a column groove, blocking movement left and right. */
export const VERTICAL: Orientation = 1;

/** A cell as one number, which is how pawns, moves and the BFS all carry it. */
export const cell = (r: number, c: number) => r * STRIDE + c;
export const rowOf = (i: number) => (i / STRIDE) | 0;
export const colOf = (i: number) => i % STRIDE;
export const inBoard = (r: number, c: number, size: number) =>
  r >= 0 && r < size && c >= 0 && c < size;

/** Where a wall lives in `Position.h` / `Position.v`. Constant stride, like cells. */
export const wallSlot = (r: number, c: number) => r * WALL_STRIDE + c;

/** Up, down, left, right. Diagonals are never a step — only ever a jump. */
export const DIRS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** Two or four. An odd count cannot be given opposite starts. */
export type PlayerCount = 2 | 4;

export interface SideMeta {
  /** Which way this pawn is trying to get. Purely for the HUD's wording. */
  name: string;
  /** Where the pawn starts. */
  start: number;
  /** True on any square that wins the game for this seat. */
  goal: (r: number, c: number) => boolean;
  /** Main colour, a lighter one for text on dark, and a darker one for edges. */
  main: string;
  light: string;
  dark: string;
  /** Which board edge is this seat's home, for drawing the goal strip. */
  home: 'south' | 'north' | 'west' | 'east';
}

/** A colour set, kept apart from the seating so the two layouts can share them. */
const INK = {
  amber: { main: '#f59e0b', light: '#fcd34d', dark: '#b45309' },
  azure: { main: '#0ea5e9', light: '#7dd3fc', dark: '#0369a1' },
  jade: { main: '#10b981', light: '#6ee7b7', dark: '#047857' },
  rose: { main: '#f43f5e', light: '#fda4af', dark: '#be123c' },
  ember: { main: '#ea580c', light: '#fdba74', dark: '#9a3412' },
  indigo: { main: '#6366f1', light: '#a5b4fc', dark: '#4338ca' },
};

/**
 * Which pair a seat belongs to in a 2v2.
 *
 * Parity, so the turn order alternates between the pairs every single move
 * rather than letting one of them take two in a row. Seats 0 and 2 are one
 * side, 1 and 3 the other.
 */
export function teamOf(seat: number): 0 | 1 {
  return (seat % 2) as 0 | 1;
}

export const TEAMS: readonly { name: string; main: string; light: string; dark: string }[] = [
  { name: 'Gold', ...INK.amber },
  { name: 'Blue', ...INK.azure },
];

/**
 * Everything about a match that follows from its rules, worked out once.
 *
 * The board size, the seating and the wall allowance all move together — a
 * 2v2 is a bigger board *and* a different set of starts *and* a fatter hand of
 * walls — so they travel as one object rather than as three arguments that
 * could disagree. Every function below that used to take a `PlayerCount` takes
 * this instead, which is what stopped "how many players" from standing in for
 * "what shape is the board".
 */
export interface Layout {
  players: PlayerCount;
  /** True only in a four-player pairs game. */
  teams: boolean;
  /** Squares along one edge. */
  size: number;
  /** Grooves along one edge, which is where walls go: `size - 1`. */
  lines: number;
  /** One entry per seat, in turn order. Exactly `players` long. */
  sides: readonly SideMeta[];
  /** Walls each seat starts with. */
  walls: number;
}

/** True when the rules ask for the big board: four players, played as pairs. */
export const isPairs = (players: PlayerCount, teams: boolean) => players === 4 && teams;

export function boardSize(players: PlayerCount, teams: boolean): number {
  return isPairs(players, teams) ? PAIRS_SIZE : DUEL_SIZE;
}

/**
 * Walls in hand at the start.
 *
 * Twenty walls exist in a classic game either way; a duel splits them two ways
 * and a four-hander splits the same twenty four ways, which keeps the board's
 * total capacity for mischief the same in both. The pairs board has 100 wall
 * slots against the classic board's 64, so it gets seven each — twenty-eight
 * walls over a board half again as large is very nearly the same density, and
 * anything less left a bigger board feeling emptier rather than longer.
 */
export function wallsFor(players: PlayerCount, teams = false): number {
  if (isPairs(players, teams)) return 7;
  return players === 2 ? 10 : 5;
}

/**
 * The four classic seats, in the order play goes round.
 *
 * A two-player game is the first two entries and nothing else, which is what
 * makes it a duel across the board rather than two people sharing a side. The
 * pair after that is the other axis, so a four-player free-for-all alternates
 * between the two axes instead of letting one pair race unopposed.
 */
function freeForAllSides(size: number): SideMeta[] {
  const last = size - 1;
  const mid = (size - 1) / 2;
  return [
    { name: 'Amber', start: cell(last, mid), goal: (r) => r === 0, ...INK.amber, home: 'south' },
    { name: 'Azure', start: cell(0, mid), goal: (r) => r === last, ...INK.azure, home: 'north' },
    { name: 'Jade', start: cell(mid, 0), goal: (_r, c) => c === last, ...INK.jade, home: 'west' },
    { name: 'Rose', start: cell(mid, last), goal: (_r, c) => c === 0, ...INK.rose, home: 'east' },
  ];
}

/**
 * The 2v2 seating: partners shoulder to shoulder, both facing the same way.
 *
 * Gold (seats 0 and 2) lines up along the south edge and runs north; Blue
 * (1 and 3) lines up along the north edge and runs south. Either partner
 * reaching the far side takes the game for both, so a pair is one race run
 * twice rather than two separate ones — a wall spent slowing one Blue pawn is
 * wasted if the other is the one that gets home.
 *
 * The two lanes sit a few columns in from each rim rather than side by side in
 * the middle. Partners packed together spend the opening treading on one
 * another, and a lane hard against the edge is trivially sealed with two
 * walls; three squares in, on an eleven-wide board, gives each pawn a lane of
 * its own and leaves the middle as contested ground both pairs have to cross.
 */
function pairsSides(size: number): SideMeta[] {
  const last = size - 1;
  const nearLane = 3;
  const farLane = last - 3;
  return [
    { name: 'Amber', start: cell(last, nearLane), goal: (r) => r === 0, ...INK.amber, home: 'south' },
    { name: 'Azure', start: cell(0, nearLane), goal: (r) => r === last, ...INK.azure, home: 'north' },
    { name: 'Ember', start: cell(last, farLane), goal: (r) => r === 0, ...INK.ember, home: 'south' },
    { name: 'Indigo', start: cell(0, farLane), goal: (r) => r === last, ...INK.indigo, home: 'north' },
  ];
}

/**
 * The classic seating, for the lobby's sake.
 *
 * A pawn card in the picker has to be drawn in *some* colour before anybody
 * has settled on a mode. This is that fallback, and nothing that plays a match
 * should reach for it — ask `layoutFor` instead.
 */
export const DEFAULT_SIDES: readonly SideMeta[] = freeForAllSides(DUEL_SIZE);

/** The one place a set of rules becomes a board. */
export function layoutFor(rules: { players: PlayerCount; teams: boolean }): Layout {
  const teams = isPairs(rules.players, rules.teams);
  const size = boardSize(rules.players, rules.teams);
  const sides = (teams ? pairsSides(size) : freeForAllSides(size)).slice(0, rules.players);
  return {
    players: rules.players,
    teams,
    size,
    lines: size - 1,
    sides,
    walls: wallsFor(rules.players, rules.teams),
  };
}

/**
 * A position, small enough to copy cheaply.
 *
 * `h[wallSlot(r, c)]` is a horizontal wall lying on the groove below row `r`,
 * covering columns `c` and `c + 1`. `v[wallSlot(r, c)]` stands in the groove
 * right of column `c`, covering rows `r` and `r + 1`. Both are 1 for the seat
 * that owns the wall plus one, 0 for empty — the owner is only ever used to
 * colour it, but storing it here is free and saves a parallel array.
 *
 * Both arrays are cut to the largest board rather than to this one, for the
 * same reason cell indices are: 144 bytes is nothing, and it means a slot
 * index means the same thing in every mode.
 */
export interface Position {
  pawns: number[];
  h: Uint8Array;
  v: Uint8Array;
  stock: number[];
}

export function emptyPosition(layout: Layout): Position {
  return {
    pawns: layout.sides.map((s) => s.start),
    h: new Uint8Array(WALL_SLOTS),
    v: new Uint8Array(WALL_SLOTS),
    stock: new Array(layout.players).fill(layout.walls),
  };
}

export function clonePosition(p: Position): Position {
  return {
    pawns: p.pawns.slice(),
    h: p.h.slice(),
    v: p.v.slice(),
    stock: p.stock.slice(),
  };
}

// -- what a wall blocks -------------------------------------------------------

/**
 * Is the step from (r,c) by (dr,dc) walled off?
 *
 * A wall covers two squares' worth of groove, so a step is blocked by either
 * of the two slots that can reach it — which is the whole reason the check
 * cannot be a single array lookup.
 */
export function walled(
  pos: Position,
  r: number,
  c: number,
  dr: number,
  dc: number,
  layout: Layout,
): boolean {
  const lines = layout.lines;
  if (dr !== 0) {
    // The groove below the upper of the two rows.
    const line = dr > 0 ? r : r - 1;
    if (line < 0 || line >= lines) return false;
    return (
      (c < lines && pos.h[wallSlot(line, c)] !== 0) ||
      (c > 0 && pos.h[wallSlot(line, c - 1)] !== 0)
    );
  }
  const line = dc > 0 ? c : c - 1;
  if (line < 0 || line >= lines) return false;
  return (
    (r < lines && pos.v[wallSlot(r, line)] !== 0) ||
    (r > 0 && pos.v[wallSlot(r - 1, line)] !== 0)
  );
}

// -- pawns --------------------------------------------------------------------

const pawnAt = (pos: Position, target: number) => pos.pawns.indexOf(target);

/**
 * Every square this seat may step to, jumps included.
 *
 * The plain move is one square up, down, left or right — never diagonally.
 * Facing another pawn with no wall between turns that step into a jump:
 * straight over them and onto the square behind. When that square is off the
 * board, walled off, or already has somebody standing on it, the jump bends
 * instead and lands to either side of the pawn being jumped — which is the
 * only way a diagonal is ever legal.
 */
export function pawnMoves(pos: Position, seat: number, layout: Layout): number[] {
  const from = pos.pawns[seat];
  const r = rowOf(from);
  const c = colOf(from);
  const size = layout.size;
  const out: number[] = [];

  for (const [dr, dc] of DIRS) {
    const nr = r + dr;
    const nc = c + dc;
    if (!inBoard(nr, nc, size) || walled(pos, r, c, dr, dc, layout)) continue;

    const next = cell(nr, nc);
    if (pawnAt(pos, next) < 0) {
      out.push(next);
      continue;
    }

    // Somebody is standing there. Try to vault them.
    const br = nr + dr;
    const bc = nc + dc;
    const behindOpen =
      inBoard(br, bc, size) &&
      !walled(pos, nr, nc, dr, dc, layout) &&
      pawnAt(pos, cell(br, bc)) < 0;

    if (behindOpen) {
      out.push(cell(br, bc));
      continue;
    }

    // A wall, the board's edge, or a third pawn is directly behind them, so
    // the jump turns sideways rather than being lost.
    for (const [pr, pc] of DIRS) {
      // Only the two directions across the jump, never along it.
      if (pr === dr && pc === dc) continue;
      if (pr === -dr && pc === -dc) continue;
      const sr = nr + pr;
      const sc = nc + pc;
      if (!inBoard(sr, sc, size) || walled(pos, nr, nc, pr, pc, layout)) continue;
      const side = cell(sr, sc);
      if (pawnAt(pos, side) < 0 && !out.includes(side)) out.push(side);
    }
  }

  return out;
}

// -- walls --------------------------------------------------------------------

export const wallCode = (o: Orientation, r: number, c: number) => o * WALL_SLOTS + wallSlot(r, c);

/**
 * Does a wall physically fit here, ignoring whether it would trap anyone?
 *
 * Three ways it does not: something already crosses this slot, a wall of the
 * same orientation overlaps half of it, or the slot is off the grid.
 */
export function wallFits(
  pos: Position,
  o: Orientation,
  r: number,
  c: number,
  layout: Layout,
): boolean {
  const lines = layout.lines;
  if (r < 0 || r >= lines || c < 0 || c >= lines) return false;
  const i = wallSlot(r, c);
  // A horizontal and a vertical wall in the same slot would cross at their
  // midpoints, which no wall can do.
  if (pos.h[i] !== 0 || pos.v[i] !== 0) return false;

  if (o === HORIZONTAL) {
    if (c > 0 && pos.h[wallSlot(r, c - 1)] !== 0) return false;
    if (c < lines - 1 && pos.h[wallSlot(r, c + 1)] !== 0) return false;
  } else {
    if (r > 0 && pos.v[wallSlot(r - 1, c)] !== 0) return false;
    if (r < lines - 1 && pos.v[wallSlot(r + 1, c)] !== 0) return false;
  }
  return true;
}

/**
 * Can this seat still get home?
 *
 * Breadth-first over squares, ignoring other pawns entirely: a pawn is never a
 * permanent obstacle, because you can always jump one. Walls are the only
 * thing that closes a route.
 */
export function hasPath(pos: Position, seat: number, layout: Layout): boolean {
  return distanceToGoal(pos, seat, layout) >= 0;
}

const queue = new Int16Array(MAX_CELLS);
const seen = new Uint8Array(MAX_CELLS);
let seenStamp = 0;
const stamps = new Int32Array(MAX_CELLS);

/**
 * Steps from this pawn to its nearest goal square, or -1 when there are none.
 *
 * The bot leans on this hard — a few hundred calls per turn — so the visited
 * set is a stamped array reused between calls rather than a fresh Set each
 * time. Not reentrant, which is fine: nothing here is async.
 */
export function distanceToGoal(pos: Position, seat: number, layout: Layout): number {
  const side = layout.sides[seat];
  if (!side) return -1;
  const size = layout.size;
  const start = pos.pawns[seat];
  if (side.goal(rowOf(start), colOf(start))) return 0;

  seenStamp++;
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  stamps[start] = seenStamp;
  seen[start] = 0;

  while (head < tail) {
    const at = queue[head++];
    const depth = seen[at];
    const r = rowOf(at);
    const c = colOf(at);
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBoard(nr, nc, size) || walled(pos, r, c, dr, dc, layout)) continue;
      const next = cell(nr, nc);
      if (stamps[next] === seenStamp) continue;
      stamps[next] = seenStamp;
      seen[next] = depth + 1;
      if (side.goal(nr, nc)) return depth + 1;
      queue[tail++] = next;
    }
  }
  return -1;
}

/**
 * The next square along a shortest route home, or -1 if there is no route.
 *
 * Walked from the pawn rather than from the goal so pawn-blocking and jumps
 * can be honoured on the very first step: the search itself ignores pawns
 * (they are never permanent), but the square actually stepped onto has to be
 * one the rules allow right now.
 */
export function stepTowardGoal(pos: Position, seat: number, layout: Layout): number {
  const options = pawnMoves(pos, seat, layout);
  if (options.length === 0) return -1;

  const side = layout.sides[seat];
  let best = -1;
  let bestScore = Infinity;
  const probe = clonePosition(pos);

  for (const option of options) {
    if (side.goal(rowOf(option), colOf(option))) return option;
    probe.pawns[seat] = option;
    const d = distanceToGoal(probe, seat, layout);
    if (d < 0) continue;
    if (d < bestScore) {
      bestScore = d;
      best = option;
    }
  }
  return best >= 0 ? best : options[0];
}

/**
 * A whole shortest route home, square by square, or [] when there is none.
 *
 * Separate from `distanceToGoal` because it keeps a parent for every square it
 * reaches, which the hot path the bot runs has no use for.
 */
export function routeToGoal(pos: Position, seat: number, layout: Layout): number[] {
  const side = layout.sides[seat];
  if (!side) return [];
  const size = layout.size;
  const start = pos.pawns[seat];
  if (side.goal(rowOf(start), colOf(start))) return [];

  const prev = new Int16Array(MAX_CELLS).fill(-1);
  const visited = new Uint8Array(MAX_CELLS);
  const q: number[] = [start];
  visited[start] = 1;
  let goal = -1;

  for (let head = 0; head < q.length && goal < 0; head++) {
    const at = q[head];
    const r = rowOf(at);
    const c = colOf(at);
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBoard(nr, nc, size) || walled(pos, r, c, dr, dc, layout)) continue;
      const next = cell(nr, nc);
      if (visited[next]) continue;
      visited[next] = 1;
      prev[next] = at;
      if (side.goal(nr, nc)) {
        goal = next;
        break;
      }
      q.push(next);
    }
  }

  if (goal < 0) return [];
  const out: number[] = [];
  for (let at = goal; at !== -1 && at !== start; at = prev[at]) out.push(at);
  return out.reverse();
}

/**
 * Is this wall legal — fits, affordable, and leaves everybody a way home?
 *
 * The last clause is the rule that makes Quoridor a race rather than a siege.
 * A wall that seals any pawn away from its goal is simply not a legal move,
 * so no amount of building can ever end the game by suffocation. In a 2v2 that
 * check still runs per pawn rather than per pair: sealing off one partner is
 * illegal even when the other still has a road, because the trapped player
 * would otherwise have nothing left to do with their turns.
 */
export function wallLegal(
  pos: Position,
  seat: number,
  o: Orientation,
  r: number,
  c: number,
  layout: Layout,
): boolean {
  if (pos.stock[seat] <= 0) return false;
  if (!wallFits(pos, o, r, c, layout)) return false;

  const i = wallSlot(r, c);
  const grid = o === HORIZONTAL ? pos.h : pos.v;
  grid[i] = seat + 1;
  let ok = true;
  for (let p = 0; p < layout.players; p++) {
    if (!hasPath(pos, p, layout)) {
      ok = false;
      break;
    }
  }
  grid[i] = 0;
  return ok;
}

/** Every wall this seat could legally drop right now. Used by the bot. */
export function legalWalls(pos: Position, seat: number, layout: Layout): number[] {
  if (pos.stock[seat] <= 0) return [];
  const out: number[] = [];
  for (let o = 0 as Orientation; o <= 1; o = (o + 1) as Orientation) {
    for (let r = 0; r < layout.lines; r++) {
      for (let c = 0; c < layout.lines; c++) {
        if (wallLegal(pos, seat, o, r, c, layout)) out.push(wallCode(o, r, c));
      }
    }
  }
  return out;
}

// -- moves on the wire --------------------------------------------------------

/**
 * A whole move as one integer, which is what lets a match travel as a plain
 * array of numbers in a single Firestore field.
 *
 * Below STEP_CODES is "step onto that square"; at or above it is a wall,
 * unpacked by `decodeWall`. Both halves are cut to the largest board, so the
 * same number means the same move on a nine-square board and an eleven-square
 * one — a move list reads the same whichever mode produced it, and adding a
 * board size never silently reinterprets a history.
 */
export const STEP_CODES = MAX_CELLS;
export const MOVE_CODES = STEP_CODES + 2 * WALL_SLOTS;

export const encodeStep = (target: number) => target;
export const encodeWall = (o: Orientation, r: number, c: number) => STEP_CODES + wallCode(o, r, c);
export const isWallMove = (move: number) => move >= STEP_CODES;

export function decodeWall(move: number): { o: Orientation; r: number; c: number } {
  const code = move - STEP_CODES;
  const within = code % WALL_SLOTS;
  return {
    o: (code >= WALL_SLOTS ? VERTICAL : HORIZONTAL) as Orientation,
    r: (within / WALL_STRIDE) | 0,
    c: within % WALL_STRIDE,
  };
}

/** Rejects anything that is not a legal move for this seat in this position. */
export function moveLegal(pos: Position, seat: number, move: number, layout: Layout): boolean {
  if (!Number.isInteger(move) || move < 0 || move >= MOVE_CODES) return false;
  if (!isWallMove(move)) return pawnMoves(pos, seat, layout).includes(move);
  const { o, r, c } = decodeWall(move);
  return wallLegal(pos, seat, o, r, c, layout);
}

/** Applies a move that has already been checked. Mutates. */
export function applyMove(pos: Position, seat: number, move: number) {
  if (!isWallMove(move)) {
    pos.pawns[seat] = move;
    return;
  }
  const { o, r, c } = decodeWall(move);
  const grid = o === HORIZONTAL ? pos.h : pos.v;
  grid[wallSlot(r, c)] = seat + 1;
  pos.stock[seat] = Math.max(0, pos.stock[seat] - 1);
}

/**
 * The seat that has just won, or -1. Checked after every move.
 *
 * In a pairs game this is still a seat rather than a team: whoever actually
 * crossed is who the board should name, and it is the caller that decides a
 * partner's crossing pays out for both.
 */
export function winnerOf(pos: Position, layout: Layout): number {
  for (let seat = 0; seat < layout.players; seat++) {
    const at = pos.pawns[seat];
    if (layout.sides[seat].goal(rowOf(at), colOf(at))) return seat;
  }
  return -1;
}

export const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
