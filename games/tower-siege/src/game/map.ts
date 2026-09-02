/**
 * The one map, hand-laid.
 *
 * Deliberately not generated. R2 says every player fights the same ground, and
 * a generated map is a different map — two players' runs are only comparable
 * if the thing they ran at is identical. One layout also means it can be tuned
 * by hand until the interesting plots are actually interesting, which no
 * generator was going to manage.
 *
 * The path doubles back twice. That is the whole design: the plots inside the
 * hairpins cover two or three stretches at once and are worth fighting over,
 * the plots out on the rim cover one and are what you fall back on. A player
 * who works that out beats one who builds left to right.
 */
import { TILE } from './rules';

export const COLS = 16;
export const ROWS = 11;

export const WORLD_W = COLS * TILE;
export const WORLD_H = ROWS * TILE;

/**
 * The route, as tile coordinates, from the breach to the keep.
 *
 * Straight runs only — every turn is a right angle, so the walked line is
 * exactly the drawn line and a player can read reach off the picture.
 */
const ROUTE: [number, number][] = [
  [-1, 1],
  [12, 1],
  [12, 3],
  [3, 3],
  [3, 5],
  [13, 5],
  [13, 8],
  [2, 8],
  [2, 10],
  [15, 10],
];

/** Where the keep stands. The last leg of the route walks into it. */
export const KEEP = { col: 15, row: 10 };

export interface Vec {
  x: number;
  y: number;
}

/** Tile centre in world units. */
export function centreOf(col: number, row: number): Vec {
  return { x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 };
}

/**
 * The route as world-space corners, with the distance along it to each.
 *
 * Precomputed once at module load: every enemy on every one of the four
 * simulated keeps walks this same list, so working it out per enemy — or per
 * frame — would be the same answer several thousand times a second.
 */
export interface PathNode extends Vec {
  /** Distance from the breach to this corner. */
  at: number;
}

export const PATH: PathNode[] = (() => {
  const out: PathNode[] = [];
  let run = 0;
  for (let i = 0; i < ROUTE.length; i++) {
    const [c, r] = ROUTE[i];
    const p = centreOf(c, r);
    if (i > 0) {
      const prev = out[i - 1];
      run += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
    }
    out.push({ x: p.x, y: p.y, at: run });
  }
  return out;
})();

/** Total walking distance from the breach to the keep. */
export const PATH_LENGTH = PATH[PATH.length - 1].at;

/**
 * Where something standing `d` units along the route is.
 *
 * Clamped at both ends rather than wrapping: an enemy that has reached the
 * keep stays at the keep for the frame it takes to be removed, and one that
 * has not yet emerged from the breach sits in it.
 */
export function pointAt(d: number): Vec {
  if (d <= 0) return PATH[0];
  const last = PATH[PATH.length - 1];
  if (d >= last.at) return last;

  // Linear scan. The route has a dozen corners and an enemy advances a few
  // units a step, so a binary search would cost more in branches than it saves.
  for (let i = 1; i < PATH.length; i++) {
    const b = PATH[i];
    if (d > b.at) continue;
    const a = PATH[i - 1];
    const span = b.at - a.at;
    const t = span <= 0 ? 0 : (d - a.at) / span;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return last;
}

/** Which way something at `d` is facing, for the sprite. */
export function headingAt(d: number): number {
  const a = pointAt(d);
  const b = pointAt(Math.min(PATH_LENGTH, d + 8));
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * The straight line a flyer takes: in at the breach's height, out at the keep.
 *
 * Its own start and end rather than the route's, because a flyer that entered
 * at the breach and then flew the path would not be a flyer. It crosses the
 * whole board diagonally, which is what makes a layout hugging one side of
 * the map a real mistake rather than a style.
 */
export const AIR_FROM: Vec = { x: -TILE, y: TILE * 1.5 };
export const AIR_TO: Vec = centreOf(KEEP.col, KEEP.row);
export const AIR_LENGTH = Math.hypot(AIR_TO.x - AIR_FROM.x, AIR_TO.y - AIR_FROM.y);

export function airPointAt(d: number): Vec {
  const t = Math.max(0, Math.min(1, d / AIR_LENGTH));
  return { x: AIR_FROM.x + (AIR_TO.x - AIR_FROM.x) * t, y: AIR_FROM.y + (AIR_TO.y - AIR_FROM.y) * t };
}

/**
 * Which tiles a tower may stand on.
 *
 * Built by walking the route and blocking out every tile it passes through
 * plus the keep, rather than by listing plots by hand — a hand list drifts
 * out of step with the route the first time the route is nudged, and a plot
 * sitting under the path is the kind of bug that only shows up when an enemy
 * walks through a tower.
 */
export const BUILDABLE: boolean[] = (() => {
  const blocked = new Set<number>();
  const key = (c: number, r: number) => r * COLS + c;

  // A tower directly beside the path is fine; one *on* it is not, and neither
  // is one on the tile a corner turns through.
  const block = (c: number, r: number) => {
    // Guarded, and not merely tidiness: the route starts at column -1, out in
    // the breach, and `key` would fold that onto the last tile of the row
    // above -- quietly forbidding a plot on the far side of the map for no
    // reason anyone looking at the picture could have worked out.
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return;
    blocked.add(key(c, r));
  };

  for (let i = 1; i < ROUTE.length; i++) {
    const [c0, r0] = ROUTE[i - 1];
    const [c1, r1] = ROUTE[i];
    const dc = Math.sign(c1 - c0);
    const dr = Math.sign(r1 - r0);
    let c = c0;
    let r = r0;
    block(c, r);
    // Every leg is axis-aligned by construction, so exactly one of these is
    // non-zero and the walk always terminates.
    while (c !== c1 || r !== r1) {
      c += dc;
      r += dr;
      block(c, r);
    }
  }
  block(KEEP.col, KEEP.row);
  block(KEEP.col - 1, KEEP.row);

  const out: boolean[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) out.push(!blocked.has(key(c, r)));
  }
  return out;
})();

export function isBuildable(col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return false;
  return BUILDABLE[row * COLS + col];
}

/** How many plots the map has. Useful to the bot, and to a sanity check. */
export const PLOT_COUNT = BUILDABLE.filter(Boolean).length;
