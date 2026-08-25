/**
 * Building a hole, and proving it can be finished.
 *
 * Every course is drawn from one integer, so a host and three guests all lay
 * out the identical green from the seed alone and nothing about the layout
 * ever has to travel on the wire.
 *
 * The interesting part is the last step. Scattering ponds and blocks across a
 * green will, sooner or later, ring the flag in water or seal it behind a
 * wall, and a hole nobody can finish is not a hard hole — it is a broken
 * build. So the generator does not trust itself: it flood-fills a grid from
 * the tee and refuses to hand back any course whose cup it cannot actually
 * reach, retrying with less scenery each time and, in the last resort,
 * clearing the green entirely.
 */
import { BALL_R, HOLE_R, PICKUP_OVER_PAR, clamp } from './rules';
import type { PlayerCount } from './rules';

export interface Vec {
  x: number;
  y: number;
}

/**
 * A solid thing on the green.
 *
 * The rect is centre-based and carries a rotation, which is not decoration: a
 * barrier has to be able to lie *across* the line from the tee to the cup
 * whatever angle that line happens to be, and an axis-aligned box cannot. `a`
 * is the direction of its long axis in radians.
 */
export type Block =
  | { kind: 'rect'; cx: number; cy: number; w: number; h: number; a: number }
  | { kind: 'circle'; x: number; y: number; r: number };

/** A soft area that changes how the ball behaves without stopping it. */
export interface Patch {
  x: number;
  y: number;
  r: number;
}

/** A plain rectangle. The bounding box *is* the green. */
interface RectShape {
  kind: 'rect';
}

/**
 * A half-round green.
 *
 * `n` is the inward normal of the flat cut, which passes through the centre —
 * so the green is exactly the half of the disc lying on `n`'s side. Four
 * orientations are used rather than a free angle, purely so the bounding box
 * stays axis-aligned and the whole course still fits the canvas without a
 * rotation in the middle of every draw.
 */
interface SemiShape {
  kind: 'semi';
  cx: number;
  cy: number;
  r: number;
  nx: number;
  ny: number;
}

export type Shape = RectShape | SemiShape;

export interface Course {
  /** Bounding box in world units. Everything below sits inside it. */
  w: number;
  h: number;
  shape: Shape;
  tee: Vec;
  hole: Vec;
  par: number;
  blocks: Block[];
  sand: Patch[];
  water: Patch[];
  /** Mowing-stripe angle. Cosmetic, and the only thing here the physics ignores. */
  stripe: number;
}

/** Deterministic, portable, and fast. The same integer builds the same green everywhere. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

// -- the shape ----------------------------------------------------------------

/**
 * Is this point far enough inside the green's outer wall?
 *
 * `pad` is normally the ball's radius: the centre has to keep a ball's width
 * clear of the boards, not merely be inside them.
 */
export function insideShape(shape: Shape, w: number, h: number, x: number, y: number, pad: number): boolean {
  if (shape.kind === 'rect') {
    return x >= pad && x <= w - pad && y >= pad && y <= h - pad;
  }
  const dx = x - shape.cx;
  const dy = y - shape.cy;
  if (Math.hypot(dx, dy) > shape.r - pad) return false;
  return dx * shape.nx + dy * shape.ny >= pad;
}

// -- obstacles ----------------------------------------------------------------

/** Turns a world point into a rotated block's own frame, where it is axis-aligned again. */
export function toBlockLocal(b: Extract<Block, { kind: 'rect' }>, x: number, y: number): { lx: number; ly: number } {
  const dx = x - b.cx;
  const dy = y - b.cy;
  const c = Math.cos(-b.a);
  const s = Math.sin(-b.a);
  return { lx: dx * c - dy * s, ly: dx * s + dy * c };
}

/**
 * Distance from a point to a block's surface. Negative inside it.
 *
 * The rect case is the standard box signed-distance field, evaluated in the
 * block's own frame — which is what lets one function serve a barrier at any
 * angle without the physics, the reachability check or the bot knowing that
 * rotation exists at all.
 */
export function blockDistance(b: Block, x: number, y: number): number {
  if (b.kind === 'circle') return Math.hypot(x - b.x, y - b.y) - b.r;
  const { lx, ly } = toBlockLocal(b, x, y);
  const qx = Math.abs(lx) - b.w / 2;
  const qy = Math.abs(ly) - b.h / 2;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside;
}

export const inPatch = (p: Patch, x: number, y: number) => Math.hypot(x - p.x, y - p.y) <= p.r;

// -- can it be finished? ------------------------------------------------------

/**
 * The distance a ball actually has to travel to get from the tee to the cup,
 * or -1 when it cannot get there at all.
 *
 * Water counts as a wall, and that is the whole point of the check: a rolling
 * ball cannot cross a pond, so a flag ringed by one is unreachable even though
 * nothing solid is in the way. Blocks are grown by a ball's radius so a "gap"
 * the ball could never fit through is not mistaken for a route.
 *
 * It returns a length rather than a yes/no because par is worked out from the
 * same walk. Judging par on the straight line from tee to cup stopped meaning
 * anything once barriers were deliberately laid across that line — every hole
 * came back "blocked, add a stroke" and nine in ten were par 4. What a hole is
 * worth is how far the ball has to go *round* things, which is exactly what
 * this already knows.
 */
function routeCost(course: Course): number {
  const cell = BALL_R * 1.5;
  const cols = Math.ceil(course.w / cell);
  const rows = Math.ceil(course.h / cell);
  const open = new Uint8Array(cols * rows);

  const passable = (cx: number, cy: number) => {
    const x = (cx + 0.5) * cell;
    const y = (cy + 0.5) * cell;
    if (!insideShape(course.shape, course.w, course.h, x, y, BALL_R)) return false;
    for (const b of course.blocks) if (blockDistance(b, x, y) < BALL_R) return false;
    for (const p of course.water) if (inPatch(p, x, y)) return false;
    return true;
  };

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) open[cy * cols + cx] = passable(cx, cy) ? 1 : 0;
  }

  const cellOf = (v: Vec) => {
    const cx = clamp(Math.floor(v.x / cell), 0, cols - 1);
    const cy = clamp(Math.floor(v.y / cell), 0, rows - 1);
    return cy * cols + cx;
  };
  const from = cellOf(course.tee);
  const to = cellOf(course.hole);
  if (!open[from] || !open[to]) return -1;

  // Eight-connected, so a diagonal run is not measured as a staircase — a
  // four-connected walk reports a straight diagonal as 40% longer than it is,
  // which would push every angled hole up a stroke for no reason.
  const STRAIGHT = 1;
  const DIAGONAL = Math.SQRT2;
  const best = new Float32Array(cols * rows).fill(Infinity);
  const queued = new Uint8Array(cols * rows);
  const queue: number[] = [from];
  best[from] = 0;
  queued[from] = 1;

  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    queued[at] = 0;
    const cx = at % cols;
    const cy = (at / cols) | 0;
    for (let d = 0; d < 8; d++) {
      const dx = d < 4 ? [1, -1, 0, 0][d] : [1, 1, -1, -1][d - 4];
      const dy = d < 4 ? [0, 0, 1, -1][d] : [1, -1, 1, -1][d - 4];
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const i = ny * cols + nx;
      if (!open[i]) continue;
      const step = d < 4 ? STRAIGHT : DIAGONAL;
      const cost = best[at] + step;
      if (cost < best[i] - 1e-4) {
        best[i] = cost;
        if (!queued[i]) {
          queued[i] = 1;
          queue.push(i);
        }
      }
    }
  }

  return best[to] === Infinity ? -1 : best[to] * cell;
}

// -- generation ---------------------------------------------------------------

/**
 * One hole, built from a seed and its number in the round.
 *
 * `players` only widens the green a little for a crowd — four balls on a green
 * built for one is a scrum around the tee.
 */
export function buildCourse(seed: number, holeIndex: number, players: PlayerCount): Course {
  // Each hole of a round gets its own stream, so hole 3 of one round is not
  // hole 3 of every round that happens to share a seed prefix.
  const rand = mulberry32((seed ^ (holeIndex * 0x9e3779b9)) >>> 0);
  const range = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length) % list.length];

  const roomy = 1 + (players - 1) * 0.06;

  // Try the full-scenery build first, then progressively plainer ones. In
  // practice the first attempt almost always passes; the ladder exists so that
  // "unfinishable" is impossible rather than unlikely.
  for (let attempt = 0; attempt < 6; attempt++) {
    const generosity = 1 - attempt / 6;
    const course = layout(rand, range, pick, roomy, generosity);
    const route = routeCost(course);
    if (route > 0) {
      course.par = parFor(route);
      return course;
    }
  }

  // Nothing survived the check. A bare green always can: it is convex, and the
  // only thing on it is the flag.
  const bare = layout(rand, range, pick, roomy, 0);
  bare.blocks = [];
  bare.sand = [];
  bare.water = [];
  bare.par = parFor(Math.max(1, routeCost(bare)));
  return bare;
}

function layout(
  rand: () => number,
  range: (lo: number, hi: number) => number,
  pick: <T>(list: readonly T[]) => T,
  roomy: number,
  /** 0 clears the green, 1 furnishes it fully. */
  generosity: number,
): Course {
  const semi = rand() < 0.45;

  let w: number;
  let h: number;
  let shape: Shape;

  if (semi) {
    const r = range(64, 86) * roomy;
    const facing = pick(['up', 'down', 'left', 'right'] as const);
    if (facing === 'up') {
      w = r * 2;
      h = r;
      shape = { kind: 'semi', cx: r, cy: r, r, nx: 0, ny: -1 };
    } else if (facing === 'down') {
      w = r * 2;
      h = r;
      shape = { kind: 'semi', cx: r, cy: 0, r, nx: 0, ny: 1 };
    } else if (facing === 'left') {
      w = r;
      h = r * 2;
      shape = { kind: 'semi', cx: r, cy: r, r, nx: -1, ny: 0 };
    } else {
      w = r;
      h = r * 2;
      shape = { kind: 'semi', cx: 0, cy: r, r, nx: 1, ny: 0 };
    }
  } else {
    w = range(112, 166) * roomy;
    h = range(80, 120) * roomy;
    shape = { kind: 'rect' };
  }

  // Tee and cup: rejection-sampled inside the shape, kept apart, and both kept
  // off the boards so neither is jammed into a corner.
  const margin = 12;
  const spot = (): Vec => {
    for (let i = 0; i < 200; i++) {
      const p = { x: range(margin, w - margin), y: range(margin, h - margin) };
      if (insideShape(shape, w, h, p.x, p.y, margin)) return p;
    }
    return { x: w / 2, y: h / 2 };
  };

  /**
   * Tee and cup, placed as far apart as this particular green allows.
   *
   * The obvious version — resample the cup until it is at least some fraction
   * of the bounding box's diagonal from the tee — is subtly wrong for a
   * half-round, and wrong in a way that only shows up as bad holes. A semi's
   * box is r by 2r, so its diagonal is about 2.24r, but the longest line you
   * can actually draw between two points *inside* it is the chord, around 2r,
   * and less again once both ends have to keep clear of the boards. So the
   * demand was unsatisfiable on those greens: every retry failed, the loop ran
   * out, and the leftover candidate — often a couple of units from the tee —
   * was used. One hole in twenty was a tap-in.
   *
   * Measuring what the shape can actually do removes the guess entirely. Draw
   * a pool of legal spots, find the widest separation any pair of them
   * achieves, and take a random pair within reach of that. Long on a rectangle,
   * long on a half-round, and nothing to re-derive if a third shape is added.
   */
  const pool: Vec[] = [];
  for (let i = 0; i < 40; i++) pool.push(spot());

  let widest = 0;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) widest = Math.max(widest, dist(pool[i], pool[j]));
  }

  // Not the widest pair itself — that would put the flag in the far corner of
  // every green in the round. Anything most of the way there will do, chosen
  // at random from all the pairs that qualify.
  const target = widest * 0.72;
  const far: [Vec, Vec][] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (dist(pool[i], pool[j]) >= target) far.push([pool[i], pool[j]]);
    }
  }
  const chosen = far.length > 0 ? far[Math.floor(rand() * far.length) % far.length] : [pool[0], pool[1] ?? pool[0]];
  // Which end is the tee is a coin toss, so the flag is not always on the same
  // side of the green as the last hole's.
  const [tee, hole] = rand() < 0.5 ? chosen : [chosen[1], chosen[0]];

  const course: Course = {
    w,
    h,
    shape,
    tee,
    hole,
    par: 3,
    blocks: [],
    sand: [],
    water: [],
    stripe: range(0, Math.PI),
  };

  // -- scenery ---------------------------------------------------------------
  //
  // Laid out with respect to the line from the tee to the cup rather than
  // scattered at random. Scattering left the direct shot open on most greens,
  // so every hole was "point at the flag and judge the weight" and the shape
  // of the course never mattered.

  const axX = (hole.x - tee.x) / Math.max(1, dist(tee, hole));
  const axY = (hole.y - tee.y) / Math.max(1, dist(tee, hole));
  /** Across the line. Barriers lie along this; gaps are measured along it. */
  const crossX = -axY;
  const crossY = axX;
  const runLength = dist(tee, hole);

  /**
   * How far the green reaches either way across the line from a point on it.
   *
   * Barrier sizes are worked out from this rather than from the bounding box,
   * so a barrier on a half-round is sized to the room that actually exists
   * where it sits — which is what lets the gap beside it be a promise rather
   * than a hope.
   */
  const spanAcross = (x: number, y: number) => {
    const walk = (sign: number) => {
      let d = 0;
      while (d < 400 && insideShape(shape, w, h, x + crossX * sign * (d + 3), y + crossY * sign * (d + 3), BALL_R * 1.5)) {
        d += 3;
      }
      return d;
    };
    return { fwd: walk(1), back: walk(-1) };
  };

  /**
   * Everything already on the green.
   *
   * One list for blocks, bunkers and ponds together: two obstacles that overlap
   * read as one misshapen thing rather than two, and a pond half swallowed by a
   * boulder is nobody's idea of a hazard.
   */
  const placed: (Block | Patch)[] = [];

  /** Distance from a point to an obstacle's surface, whatever kind it is. */
  const surfaceGap = (o: Block | Patch, x: number, y: number) =>
    'kind' in o ? blockDistance(o, x, y) : Math.hypot(x - o.x, y - o.y) - o.r;

  /**
   * The points a candidate is judged by, each with the clearance it needs.
   *
   * A bounding circle will not do here. A barrier sixty units long has a
   * bounding radius of thirty, so testing it as a disc demanded it stay thirty
   * units clear of everything — and since it lies across the very line the tee
   * and the cup sit on, that rejected almost every one of them. Sampling along
   * its length instead asks the question that was actually meant: is any part
   * of this thing too close to anything else?
   */
  const probesOf = (o: Block | Patch): { x: number; y: number; pad: number }[] => {
    if ('kind' in o && o.kind === 'rect') {
      const ux = Math.cos(o.a);
      const uy = Math.sin(o.a);
      const pts: { x: number; y: number; pad: number }[] = [];
      for (let i = -4; i <= 4; i++) {
        const along = (i / 4) * (o.w / 2);
        pts.push({ x: o.cx + ux * along, y: o.cy + uy * along, pad: o.h / 2 });
      }
      return pts;
    }
    const c = 'kind' in o ? { x: o.x, y: o.y, r: o.r } : o;
    return [{ x: c.x, y: c.y, pad: c.r }];
  };

  const fits = (cand: Block | Patch, gap: number, teeGap: number, cupGap: number) => {
    for (const pt of probesOf(cand)) {
      if (dist(pt, tee) < pt.pad + teeGap) return false;
      if (dist(pt, hole) < pt.pad + cupGap) return false;
      for (const o of placed) if (surfaceGap(o, pt.x, pt.y) < pt.pad + gap) return false;
    }
    return true;
  };

  /**
   * The barriers, and the whole reason a hole is worth playing.
   *
   * Each one is sized to reach from the wall on one side, across the line, and
   * stop short of the far wall — so the straight shot is dead and a gap is
   * left, by construction rather than by luck. Consecutive barriers take
   * alternate sides, which turns a corridor into an S-bend: the ball has to be
   * worked round one and then back round the next.
   */
  const gateCount = generosity <= 0 ? 0 : Math.max(1, Math.round(range(1.2, 3.4) * generosity));
  let side = rand() < 0.5 ? 1 : -1;
  // Kept clear of both ends in world units rather than as a fraction, so a
  // short hole does not get a barrier dropped on top of its own tee.
  const endroom = Math.min(0.42, 32 / Math.max(1, runLength));

  for (let g = 0; g < gateCount; g++) {
    const t = clamp((g + 1) / (gateCount + 1) + range(-0.06, 0.06), endroom, 1 - endroom);
    const lineX = tee.x + axX * runLength * t;
    const lineY = tee.y + axY * runLength * t;
    if (!insideShape(shape, w, h, lineX, lineY, BALL_R * 2)) {
      side = -side;
      continue;
    }

    const span = spanAcross(lineX, lineY);
    const near = side > 0 ? span.fwd : span.back;
    const far = side > 0 ? span.back : span.fwd;
    // The gap is whatever is left of the far side. Below this there is no
    // honest way through and the reachability check would throw the hole out
    // anyway, so skip rather than build something doomed.
    if (far < 26 || near < 6) {
      side = -side;
      continue;
    }

    // Reaching the near wall plus a bite out of the far side guarantees the
    // barrier crosses the line, and leaves at least 55% of the far side open.
    const cover = near + far * range(0.18, 0.45);
    const thickness = range(8, 14);
    const off = side * (near - cover / 2);
    const gate: Block = {
      kind: 'rect',
      cx: lineX + crossX * off,
      cy: lineY + crossY * off,
      w: cover,
      h: thickness,
      a: Math.atan2(crossY, crossX),
    };

    if (fits(gate, 5, 15, HOLE_R + 10)) {
      course.blocks.push(gate);
      placed.push(gate);
    }
    side = -side;
  }

  const rockCount = Math.round(range(0, 2.2) * generosity);
  let rocks = 0;
  for (let i = 0; i < rockCount * 6 && rocks < rockCount; i++) {
    const r = range(6, 13);
    const rock: Block = { kind: 'circle', x: range(margin + r, w - margin - r), y: range(margin + r, h - margin - r), r };
    if (!insideShape(shape, w, h, rock.x, rock.y, r + 5)) continue;
    // A wide berth from everything else: a boulder is scenery to bank off, and
    // one dropped into a barrier's gap would close the only way through.
    if (!fits(rock, 10, 17, HOLE_R + 11)) continue;
    course.blocks.push(rock);
    placed.push(rock);
    rocks++;
  }

  /** Somewhere on the line, pushed off to one side. Hazards want to be in the way. */
  const nearLine = (r: number, lateral: number) => {
    const t = range(0.2, 0.85);
    const lineX = tee.x + axX * runLength * t;
    const lineY = tee.y + axY * runLength * t;
    const off = (rand() < 0.5 ? -1 : 1) * range(0, lateral);
    return { x: lineX + crossX * off, y: lineY + crossY * off, r };
  };

  const sandCount = Math.round(range(0.4, 3) * generosity);
  for (let i = 0; i < sandCount * 8 && course.sand.length < sandCount; i++) {
    const r = range(10, 20);
    const c = nearLine(r, 42);
    // Sand may hug the cup — a greenside bunker is the good version of this —
    // so it only has to clear the tee.
    if (dist(c, tee) < r + 16) continue;
    if (!insideShape(shape, w, h, c.x, c.y, r * 0.5)) continue;
    // Sand may hug the cup, so it is only held off the tee — but it still has
    // to keep out of everything else.
    if (!fits(c, 3, 16, 0)) continue;
    course.sand.push(c);
    placed.push(c);
  }

  const waterCount = Math.round(range(0, 2.2) * generosity);
  for (let i = 0; i < waterCount * 8 && course.water.length < waterCount; i++) {
    const r = range(11, 21);
    const c = nearLine(r, 50);
    if (!insideShape(shape, w, h, c.x, c.y, r * 0.6)) continue;
    if (!fits(c, 6, 18, HOLE_R + 12)) continue;
    course.water.push(c);
    placed.push(c);
  }

  return course;
}

/**
 * Par, from how far the ball actually has to travel.
 *
 * `route` is the length of the real path round the scenery, not the straight
 * line to the flag — so a dogleg is worth a stroke because it *is* longer,
 * rather than because a flag was set on it.
 *
 * A full swing carries roughly 140 units on the green, but reaching the cup
 * and *stopping* at it are different problems: a ball still travelling when it
 * arrives rides over the top. The bands are calibrated against what the bots
 * actually shoot over a thousand generated holes rather than guessed from
 * carry — set them by feel and every card comes back three under, which makes
 * BIRDIE meaningless and PAR a thing nobody ever sees.
 */
function parFor(route: number): number {
  const par = route < 65 ? 2 : route < 110 ? 3 : route < 168 ? 4 : route < 235 ? 5 : 6;
  return clamp(par, 2, 6);
}

/** Strokes at which this hole is written off and the ball picked up. */
export const pickupAt = (par: number) => par + PICKUP_OVER_PAR;
