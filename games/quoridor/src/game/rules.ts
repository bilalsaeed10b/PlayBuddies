/**
 * Quoridor, as rules rather than as pixels.
 *
 * Nothing in this file touches React, a canvas or the network. It is the whole
 * game — where a pawn may step, where a wall may go, and whether a board is
 * still solvable — expressed over two plain arrays, so the engine, the bot and
 * a test can all ask the same questions of the same position.
 */

/** Nine by nine. Every index in this file is a row 0-8 and a column 0-8. */
export const SIZE = 9;
/** Grooves between squares: eight of them each way, and a wall sits in one. */
export const LINES = SIZE - 1;
export const CELLS = SIZE * SIZE;

export type Orientation = 0 | 1;
/** A wall lying along a row groove, blocking movement up and down. */
export const HORIZONTAL: Orientation = 0;
/** A wall standing in a column groove, blocking movement left and right. */
export const VERTICAL: Orientation = 1;

/** A cell as one number, which is how pawns, moves and the BFS all carry it. */
export const cell = (r: number, c: number) => r * SIZE + c;
export const rowOf = (i: number) => (i / SIZE) | 0;
export const colOf = (i: number) => i % SIZE;
export const inBoard = (r: number, c: number) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;

/** Up, down, left, right. Diagonals are never a step — only ever a jump. */
export const DIRS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * The four seats, in the order play goes round.
 *
 * A two-player game is the first two entries and nothing else, which is what
 * makes it a duel across the board rather than two people sharing a side. The
 * pair after that is the other axis, so a four-player game alternates between
 * the two axes instead of letting one pair race unopposed.
 */
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

export const SIDES: readonly SideMeta[] = [
  {
    name: 'Amber',
    start: cell(SIZE - 1, 4),
    goal: (r) => r === 0,
    main: '#f59e0b',
    light: '#fcd34d',
    dark: '#b45309',
    home: 'south',
  },
  {
    name: 'Azure',
    start: cell(0, 4),
    goal: (r) => r === SIZE - 1,
    main: '#0ea5e9',
    light: '#7dd3fc',
    dark: '#0369a1',
    home: 'north',
  },
  {
    name: 'Jade',
    start: cell(4, 0),
    goal: (_r, c) => c === SIZE - 1,
    main: '#10b981',
    light: '#6ee7b7',
    dark: '#047857',
    home: 'west',
  },
  {
    name: 'Rose',
    start: cell(4, SIZE - 1),
    goal: (_r, c) => c === 0,
    main: '#f43f5e',
    light: '#fda4af',
    dark: '#be123c',
    home: 'east',
  },
];

/** Two or four. An odd count cannot be given opposite starts. */
export type PlayerCount = 2 | 4;

/**
 * Which pair a seat belongs to in a 2v2, and the pair's own colours.
 *
 * Seats alternate axes -- south, north, west, east -- so pairing on turn
 * parity puts one pawn of each pair on each axis. Partners therefore never
 * face each other down the same lane, and the turn order alternates sides
 * every single move instead of letting one pair take two in a row.
 */
export function teamOf(seat: number): 0 | 1 {
  return (seat % 2) as 0 | 1;
}

export const TEAMS: readonly { name: string; main: string; light: string; dark: string }[] = [
  { name: 'Gold', main: '#f59e0b', light: '#fcd34d', dark: '#b45309' },
  { name: 'Blue', main: '#0ea5e9', light: '#7dd3fc', dark: '#0369a1' },
];

/**
 * Walls in hand at the start.
 *
 * Twenty walls exist either way; a duel splits them two ways and a four-hander
 * splits the same twenty four ways, which is what keeps the board's total
 * capacity for mischief the same in both games.
 */
export function wallsFor(players: PlayerCount): number {
  return players === 2 ? 10 : 5;
}

/**
 * A position, small enough to copy cheaply.
 *
 * `h[r * LINES + c]` is a horizontal wall lying on the groove below row `r`,
 * covering columns `c` and `c + 1`. `v[r * LINES + c]` stands in the groove
 * right of column `c`, covering rows `r` and `r + 1`. Both are 1 for the seat
 * that owns the wall plus one, 0 for empty — the owner is only ever used to
 * colour it, but storing it here is free and saves a parallel array.
 */
export interface Position {
  pawns: number[];
  h: Uint8Array;
  v: Uint8Array;
  stock: number[];
}

export function emptyPosition(players: PlayerCount): Position {
  return {
    pawns: SIDES.slice(0, players).map((s) => s.start),
    h: new Uint8Array(LINES * LINES),
    v: new Uint8Array(LINES * LINES),
    stock: new Array(players).fill(wallsFor(players)),
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
export function walled(pos: Position, r: number, c: number, dr: number, dc: number): boolean {
  if (dr !== 0) {
    // The groove below the upper of the two rows.
    const line = dr > 0 ? r : r - 1;
    if (line < 0 || line >= LINES) return false;
    return (
      (c < LINES && pos.h[line * LINES + c] !== 0) ||
      (c > 0 && pos.h[line * LINES + c - 1] !== 0)
    );
  }
  const line = dc > 0 ? c : c - 1;
  if (line < 0 || line >= LINES) return false;
  return (
    (r < LINES && pos.v[r * LINES + line] !== 0) ||
    (r > 0 && pos.v[(r - 1) * LINES + line] !== 0)
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
export function pawnMoves(pos: Position, seat: number): number[] {
  const from = pos.pawns[seat];
  const r = rowOf(from);
  const c = colOf(from);
  const out: number[] = [];

  for (const [dr, dc] of DIRS) {
    const nr = r + dr;
    const nc = c + dc;
    if (!inBoard(nr, nc) || walled(pos, r, c, dr, dc)) continue;

    const next = cell(nr, nc);
    if (pawnAt(pos, next) < 0) {
      out.push(next);
      continue;
    }

    // Somebody is standing there. Try to vault them.
    const br = nr + dr;
    const bc = nc + dc;
    const behindOpen =
      inBoard(br, bc) && !walled(pos, nr, nc, dr, dc) && pawnAt(pos, cell(br, bc)) < 0;

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
      if (!inBoard(sr, sc) || walled(pos, nr, nc, pr, pc)) continue;
      const side = cell(sr, sc);
      if (pawnAt(pos, side) < 0 && !out.includes(side)) out.push(side);
    }
  }

  return out;
}

// -- walls --------------------------------------------------------------------

export const wallCode = (o: Orientation, r: number, c: number) => o * LINES * LINES + r * LINES + c;

/**
 * Does a wall physically fit here, ignoring whether it would trap anyone?
 *
 * Three ways it does not: something already crosses this slot, a wall of the
 * same orientation overlaps half of it, or the slot is off the grid.
 */
export function wallFits(pos: Position, o: Orientation, r: number, c: number): boolean {
  if (r < 0 || r >= LINES || c < 0 || c >= LINES) return false;
  const i = r * LINES + c;
  // A horizontal and a vertical wall in the same slot would cross at their
  // midpoints, which no wall can do.
  if (pos.h[i] !== 0 || pos.v[i] !== 0) return false;

  if (o === HORIZONTAL) {
    if (c > 0 && pos.h[i - 1] !== 0) return false;
    if (c < LINES - 1 && pos.h[i + 1] !== 0) return false;
  } else {
    if (r > 0 && pos.v[i - LINES] !== 0) return false;
    if (r < LINES - 1 && pos.v[i + LINES] !== 0) return false;
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
export function hasPath(pos: Position, seat: number, players: PlayerCount): boolean {
  return distanceToGoal(pos, seat, players) >= 0;
}

const queue = new Int16Array(CELLS);
const seen = new Uint8Array(CELLS);
let seenStamp = 0;
const stamps = new Int32Array(CELLS);

/**
 * Steps from this pawn to its nearest goal square, or -1 when there are none.
 *
 * The bot leans on this hard — a few hundred calls per turn — so the visited
 * set is a stamped array reused between calls rather than a fresh Set each
 * time. Not reentrant, which is fine: nothing here is async.
 */
export function distanceToGoal(pos: Position, seat: number, players: PlayerCount): number {
  const side = SIDES[seat % players];
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
      if (!inBoard(nr, nc) || walled(pos, r, c, dr, dc)) continue;
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
export function stepTowardGoal(pos: Position, seat: number, players: PlayerCount): number {
  const options = pawnMoves(pos, seat);
  if (options.length === 0) return -1;

  const side = SIDES[seat % players];
  let best = -1;
  let bestScore = Infinity;
  const probe = clonePosition(pos);

  for (const option of options) {
    if (side.goal(rowOf(option), colOf(option))) return option;
    probe.pawns[seat] = option;
    const d = distanceToGoal(probe, seat, players);
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
 * reaches, which the hot path the bot runs has no use for. The board draws
 * this as a line of dots under the pawn whose turn it is, so it is recomputed
 * once per move rather than once per frame.
 */
export function routeToGoal(pos: Position, seat: number, players: PlayerCount): number[] {
  const side = SIDES[seat % players];
  const start = pos.pawns[seat];
  if (side.goal(rowOf(start), colOf(start))) return [];

  const prev = new Int16Array(CELLS).fill(-1);
  const visited = new Uint8Array(CELLS);
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
      if (!inBoard(nr, nc) || walled(pos, r, c, dr, dc)) continue;
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
 * so no amount of building can ever end the game by suffocation.
 */
export function wallLegal(
  pos: Position,
  seat: number,
  o: Orientation,
  r: number,
  c: number,
  players: PlayerCount,
): boolean {
  if (pos.stock[seat] <= 0) return false;
  if (!wallFits(pos, o, r, c)) return false;

  const i = r * LINES + c;
  const grid = o === HORIZONTAL ? pos.h : pos.v;
  grid[i] = seat + 1;
  let ok = true;
  for (let p = 0; p < players; p++) {
    if (!hasPath(pos, p, players)) {
      ok = false;
      break;
    }
  }
  grid[i] = 0;
  return ok;
}

/** Every wall this seat could legally drop right now. Used by the bot. */
export function legalWalls(pos: Position, seat: number, players: PlayerCount): number[] {
  if (pos.stock[seat] <= 0) return [];
  const out: number[] = [];
  for (let o = 0 as Orientation; o <= 1; o = (o + 1) as Orientation) {
    for (let r = 0; r < LINES; r++) {
      for (let c = 0; c < LINES; c++) {
        if (wallLegal(pos, seat, o, r, c, players)) out.push(wallCode(o, r, c));
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
 * 0-80 is "step onto that square". 81 and up is a wall, unpacked by
 * `decodeWall`. Nothing else is a legal move, so a packet that decodes to
 * neither is simply dropped.
 */
export const STEP_CODES = CELLS;

export const encodeStep = (target: number) => target;
export const encodeWall = (o: Orientation, r: number, c: number) => STEP_CODES + wallCode(o, r, c);
export const isWallMove = (move: number) => move >= STEP_CODES;

export function decodeWall(move: number): { o: Orientation; r: number; c: number } {
  const code = move - STEP_CODES;
  return {
    o: (code >= LINES * LINES ? VERTICAL : HORIZONTAL) as Orientation,
    r: ((code % (LINES * LINES)) / LINES) | 0,
    c: code % LINES,
  };
}

/** Rejects anything that is not a legal move for this seat in this position. */
export function moveLegal(pos: Position, seat: number, move: number, players: PlayerCount): boolean {
  if (!Number.isInteger(move) || move < 0 || move >= STEP_CODES + 2 * LINES * LINES) return false;
  if (!isWallMove(move)) return pawnMoves(pos, seat).includes(move);
  const { o, r, c } = decodeWall(move);
  return wallLegal(pos, seat, o, r, c, players);
}

/** Applies a move that has already been checked. Mutates. */
export function applyMove(pos: Position, seat: number, move: number) {
  if (!isWallMove(move)) {
    pos.pawns[seat] = move;
    return;
  }
  const { o, r, c } = decodeWall(move);
  const grid = o === HORIZONTAL ? pos.h : pos.v;
  grid[r * LINES + c] = seat + 1;
  pos.stock[seat] = Math.max(0, pos.stock[seat] - 1);
}

/** The seat that has just won, or -1. Checked after every move. */
export function winnerOf(pos: Position, players: PlayerCount): number {
  for (let seat = 0; seat < players; seat++) {
    const at = pos.pawns[seat];
    if (SIDES[seat].goal(rowOf(at), colOf(at))) return seat;
  }
  return -1;
}

export const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
