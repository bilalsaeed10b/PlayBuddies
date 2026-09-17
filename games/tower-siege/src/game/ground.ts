/**
 * The ground: turf, road, scenery, and the plot grid.
 *
 * Split out of art.ts because it is a different job on a different schedule ,
 * all of this is painted exactly once into an offscreen bitmap and blitted
 * from then on, where the towers and enemies in art.ts are drawn every frame.
 *
 * The look is deliberately cartoon, and every rule below follows from that.
 * Flat saturated colour rather than gradients; big shapes rather than fine
 * texture; and a thick dark outline around anything that is meant to read as
 * an object. The pass before this one chased realism , grass blades, cobble
 * noise, a heavy vignette , and the result was muddy at the size it is
 * actually played at. Detail you cannot see from across the board is not
 * detail, it is dirt on the lens, and the vignette was literally dimming the
 * corners of a game whose whole appeal is that it is bright.
 */
import {
  COLS,
  PATH,
  PATH_LENGTH,
  ROWS,
  SCENERY,
  WORLD_H,
  WORLD_W,
  centreOf,
  isBuildable,
  pointAt,
} from './map';
import { TILE, mulberry32 } from './rules';

const GROUND_SEED = 0x9e3779b1;
const ROAD_W = TILE * 0.78;

/**
 * The palette, in one place.
 *
 * Named rather than inlined because the whole point of a cartoon board is that
 * a handful of colours repeat everywhere , the same green in the turf and the
 * tree, the same brown in the road and the trunk. Scattering hex codes through
 * the paint code is how that quietly stops being true.
 */
export const PALETTE = {
  grass: '#7ed957',
  grassLight: '#a6ee6b',
  grassDark: '#57bf50',
  grassDeep: '#3fa04a',
  dirt: '#f2c876',
  dirtMid: '#dda551',
  dirtDark: '#b3752f',
  ink: '#2f4a2c',
  stone: '#cbd5e4',
  stoneMid: '#9aa8bf',
  stoneDark: '#4f5c74',
  wood: '#a9703c',
  woodDark: '#6b4423',
  water: '#4ecdf0',
  waterDark: '#1f9fce',
} as const;

export function rounded(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Darken a hex colour toward black by `k`. The outline of anything is its own colour, darkened. */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${Math.round(((n >> 16) & 255) * k)}, ${Math.round(((n >> 8) & 255) * k)}, ${Math.round((n & 255) * k)})`;
}

/** Lighten a hex colour toward white by `k` (0 = unchanged, 1 = white). The lit face of anything. */
export function tint(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * k);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

/**
 * Fill then outline, which is the one move the whole style is built on.
 *
 * A cartoon object is a flat colour with a dark line around it. Doing that by
 * hand is four statements every time and it is the thing most likely to get
 * skipped on the twentieth shape, which is exactly when the board starts
 * looking inconsistent.
 */
export function inked(ctx: CanvasRenderingContext2D, fill: string, line: string, width = 3) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/**
 * A closed wobbly blob: a circle with its radius nudged per vertex.
 *
 * Every organic shape on the board is one of these , canopies, rocks, grass
 * patches. A true circle reads as a token and a bezier cloud is more control
 * points than any of this is worth.
 */
export function blob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  squash: number,
  wobble: number,
  rnd: () => number,
  points = 9,
) {
  // Curved through the midpoints rather than joined corner to corner. Straight
  // segments between jittered vertices give a faceted low-poly edge, which is a
  // different look entirely and not the one this board is going for , at the
  // size a grass patch is actually drawn, every one of those facets is visible.
  const pts: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const rr = r * (1 - wobble / 2 + rnd() * wobble);
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * squash]);
  }
  const mid = (i: number): [number, number] => {
    const a = pts[i % points];
    const b = pts[(i + 1) % points];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  ctx.beginPath();
  const start = mid(points - 1);
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < points; i++) {
    const c = pts[i];
    const end = mid(i);
    ctx.quadraticCurveTo(c[0], c[1], end[0], end[1]);
  }
  ctx.closePath();
}

// ── the bake ───────────────────────────────────────────────────────────────

let ground: HTMLCanvasElement | null = null;

/**
 * Baked once for the whole session, and shared by every keep on screen , they
 * are all the same map. Which is also why it can afford to be this detailed:
 * however long the match runs, this is painted once.
 */
export function bakeGround(): HTMLCanvasElement | null {
  if (ground) return ground;
  try {
    const c = document.createElement('canvas');
    c.width = WORLD_W;
    c.height = WORLD_H;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    paintGround(ctx);
    ground = c;
    return c;
  } catch {
    return null;
  }
}

function paintGround(ctx: CanvasRenderingContext2D) {
  const rnd = mulberry32(GROUND_SEED);

  // Turf: one flat green, then big flat patches of two others. Flat on
  // purpose. A gradient wash makes one corner of the field darker than the
  // other, which at this scale does not read as light , it reads as a stain.
  ctx.fillStyle = PALETTE.grass;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  const patches: [string, number, number, number][] = [
    [PALETTE.grassLight, 14, 130, 0.35],
    [PALETTE.grassDark, 12, 150, 0.3],
    [PALETTE.grassLight, 18, 70, 0.3],
  ];
  for (const [colour, count, size, alpha] of patches) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    for (let i = 0; i < count; i++) {
      blob(ctx, rnd() * WORLD_W, rnd() * WORLD_H, size * (0.55 + rnd() * 0.8), 0.6 + rnd() * 0.35, 0.5, rnd, 11);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Mown stripes, very faint. Free, and it is what says "a field somebody
  // looks after" rather than "a green rectangle".
  ctx.globalAlpha = 0.035;
  ctx.fillStyle = '#ffffff';
  for (let x = 0; x < WORLD_W; x += TILE * 2) ctx.fillRect(x, 0, TILE, WORLD_H);
  ctx.globalAlpha = 1;

  paintRoad(ctx, rnd);
  paintMeadow(ctx, rnd);
  paintScenery(ctx);
  paintBreach(ctx);
}

function routePath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(PATH[0].x, PATH[0].y);
  for (let i = 1; i < PATH.length; i++) ctx.lineTo(PATH[i].x, PATH[i].y);
}

function strokeRoute(ctx: CanvasRenderingContext2D, colour: string, width: number) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  routePath(ctx);
  ctx.stroke();
}

/**
 * The road, as four strokes of the same line.
 *
 * Outline, shadow lip, body, lit inlay , in that order and each narrower than
 * the last, so one polyline becomes a raised path with a dark edge all the way
 * round it. The dark edge is doing most of the work: it is what separates the
 * road from the grass at a glance, and it is the single change that makes the
 * board read as drawn rather than rendered.
 */
function paintRoad(ctx: CanvasRenderingContext2D, rnd: () => number) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  strokeRoute(ctx, PALETTE.ink, ROAD_W + 16);
  strokeRoute(ctx, PALETTE.dirtDark, ROAD_W + 9);
  strokeRoute(ctx, PALETTE.dirt, ROAD_W);
  ctx.globalAlpha = 0.5;
  strokeRoute(ctx, tint(PALETTE.dirt, 0.45), ROAD_W - 22);
  ctx.globalAlpha = 1;

  // A handful of flat stones set into the road. Chunky and sparse: the pass
  // before this laid five per eleven units and the result was gravel, which at
  // arm's length is just noise the eye has to wade through.
  for (let d = 12; d < PATH_LENGTH; d += 46) {
    const p = pointAt(d);
    const ahead = pointAt(Math.min(PATH_LENGTH, d + 6));
    const ang = Math.atan2(ahead.y - p.y, ahead.x - p.x);
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    const n = 1 + Math.floor(rnd() * 2);
    for (let k = 0; k < n; k++) {
      const off = (rnd() - 0.5) * ROAD_W * 0.66;
      ctx.save();
      ctx.translate(p.x + nx * off + (rnd() - 0.5) * 14, p.y + ny * off + (rnd() - 0.5) * 14);
      ctx.rotate(rnd() * Math.PI);
      rounded(ctx, -7, -5, 14, 10, 5);
      inked(ctx, PALETTE.dirtMid, PALETTE.dirtDark, 2);
      ctx.restore();
    }
  }
}

/** Flowers and grass tufts, well clear of the road. Pure colour, and cheap. */
function paintMeadow(ctx: CanvasRenderingContext2D, rnd: () => number) {
  const petals = ['#ffd93d', '#ff7eb6', '#ffffff', '#8be9ff'];
  for (let i = 0; i < 150; i++) {
    const x = rnd() * WORLD_W;
    const y = rnd() * WORLD_H;
    if (distToRoad(x, y) < 44) continue;

    if (rnd() < 0.45) {
      // A tuft: three blades, thick and rounded, in the dark green.
      ctx.strokeStyle = PALETTE.grassDeep;
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let k = -1; k <= 1; k++) {
        ctx.moveTo(x + k * 3.5, y);
        ctx.lineTo(x + k * 6, y - 7 - rnd() * 4);
      }
      ctx.stroke();
      continue;
    }

    const colour = petals[(rnd() * petals.length) | 0];
    ctx.fillStyle = colour;
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * 3.2, y + Math.sin(a) * 3.2, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ffdf5e';
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Distance from a point to the nearest point on the road, in world units. */
function distToRoad(x: number, y: number): number {
  let best = Infinity;
  for (let i = 1; i < PATH.length; i++) {
    const a = PATH[i - 1];
    const b = PATH[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len));
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
  }
  return best;
}

// ── scenery ────────────────────────────────────────────────────────────────

/**
 * Trees, rocks and the pond, baked in with the ground.
 *
 * None of it moves, and a copse of nine trees repainted every frame across
 * four boards at once is a great deal of path-filling for something that will
 * look identical next frame.
 */
function paintScenery(ctx: CanvasRenderingContext2D) {
  // The pond first, and as one shape: four adjacent pond tiles have to read as
  // one body of water rather than as four squares of blue.
  const pond = SCENERY.filter((s) => s.kind === 'pond');
  if (pond.length > 0) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const s of pond) {
      x0 = Math.min(x0, s.col * TILE);
      y0 = Math.min(y0, s.row * TILE);
      x1 = Math.max(x1, s.col * TILE + TILE);
      y1 = Math.max(y1, s.row * TILE + TILE);
    }
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = (x1 - x0) / 2 - 6;
    const ry = (y1 - y0) / 2 - 6;
    const rnd = mulberry32(0x9077d);

    // A grass lip a shade darker, so the water is set into the ground rather
    // than painted on top of it.
    blob(ctx, cx, cy + 3, rx + 9, ry / rx, 0.16, mulberry32(0x9077e), 13);
    ctx.fillStyle = PALETTE.grassDeep;
    ctx.fill();

    blob(ctx, cx, cy, rx, ry / rx, 0.16, mulberry32(0x9077d), 13);
    inked(ctx, PALETTE.water, PALETTE.waterDark, 4);

    // Flat darker water toward the far bank, then hard white sparkles. Two
    // tones and a highlight is the whole of cartoon water; a radial gradient
    // reads as a hole in the ground.
    ctx.save();
    ctx.clip();
    ctx.fillStyle = PALETTE.waterDark;
    ctx.globalAlpha = 0.45;
    blob(ctx, cx + rx * 0.25, cy + ry * 0.45, rx * 0.85, 0.6, 0.3, rnd, 9);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.85;
    for (const [ox, oy, w] of [
      [-0.3, -0.35, 0.36],
      [0.18, -0.12, 0.22],
      [-0.05, 0.3, 0.16],
    ] as [number, number, number][]) {
      ctx.beginPath();
      ctx.moveTo(cx + rx * ox - rx * w * 0.5, cy + ry * oy);
      ctx.quadraticCurveTo(cx + rx * ox, cy + ry * oy - 4, cx + rx * ox + rx * w * 0.5, cy + ry * oy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Lily pads: a green disc with a wedge cut out, which is the one shape
    // everybody reads as a lily pad and nothing else.
    for (const [ox, oy, r] of [
      [-0.54, 0.5, 11],
      [0.58, -0.46, 9],
    ] as [number, number, number][]) {
      const px = cx + rx * ox;
      const py = cy + ry * oy;
      ctx.beginPath();
      ctx.arc(px, py, r, 0.5, Math.PI * 2 + 0.2);
      ctx.lineTo(px, py);
      ctx.closePath();
      inked(ctx, '#5fc85a', '#2f7a3a', 2.5);
    }

    // Reeds on the near bank, which is what stops it reading as a blue puddle.
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2;
      const px = cx + Math.cos(a) * rx * (0.96 + rnd() * 0.12);
      const py = cy + Math.sin(a) * ry * (0.96 + rnd() * 0.12);
      ctx.strokeStyle = rnd() < 0.5 ? PALETTE.grassDeep : '#4fa84c';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + (rnd() - 0.5) * 7, py - 10 - rnd() * 10);
      ctx.stroke();
    }
  }

  for (const s of SCENERY) {
    if (s.kind === 'pond') continue;
    const p = centreOf(s.col, s.row);
    const rnd = mulberry32((s.col * 73856093) ^ (s.row * 19349663));
    if (s.kind === 'tree') paintTree(ctx, p.x, p.y, rnd);
    else paintRock(ctx, p.x, p.y, rnd);
  }
}

function paintTree(ctx: CanvasRenderingContext2D, x: number, y: number, rnd: () => number) {
  const h = 34 + rnd() * 8;

  // One soft shadow, thrown the same way as everything else on the board , a
  // single agreed light source is most of what makes a flat top-down scene
  // read as having depth at all.
  ctx.fillStyle = 'rgba(40, 80, 40, 0.28)';
  ctx.beginPath();
  ctx.ellipse(x + 9, y + 12, 22, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  rounded(ctx, x - 5, y - 6, 10, 18, 4);
  inked(ctx, PALETTE.wood, PALETTE.woodDark, 3);

  // One big canopy blob with two smaller ones tucked behind it, all outlined
  // together , overlapping outlines inside a canopy would cut it into pieces.
  const lobes: [number, number, number][] = [
    [-11, -h * 0.52, 17],
    [12, -h * 0.46, 16],
    [0, -h * 0.88, 20],
  ];
  ctx.beginPath();
  for (const [dx, dy, r] of lobes) {
    ctx.moveTo(x + dx + r, y + dy);
    ctx.arc(x + dx, y + dy, r * (0.92 + rnd() * 0.16), 0, Math.PI * 2);
  }
  inked(ctx, '#4fbf5a', '#25632f', 3.5);

  // The lit side, clipped to the canopy so it never spills onto the grass.
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#7ada6a';
  ctx.beginPath();
  ctx.arc(x - 6, y - h * 0.82, 14, 0, Math.PI * 2);
  ctx.arc(x - 13, y - h * 0.52, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function paintRock(ctx: CanvasRenderingContext2D, x: number, y: number, rnd: () => number) {
  ctx.fillStyle = 'rgba(40, 80, 40, 0.28)';
  ctx.beginPath();
  ctx.ellipse(x + 7, y + 10, 20, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  for (const [dx, dy, r] of [[-9, 3, 13], [8, 5, 11], [0, -6, 15]] as [number, number, number][]) {
    ctx.beginPath();
    const sides = 6;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + rnd() * 0.3;
      const rr = r * (0.8 + rnd() * 0.28);
      const px = x + dx + Math.cos(a) * rr;
      const py = y + dy + Math.sin(a) * rr * 0.84;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    inked(ctx, PALETTE.stoneMid, PALETTE.stoneDark, 3);

    // One flat lit facet across the top. Flat, not a gradient: a boulder lit
    // by a gradient looks like a ball bearing.
    ctx.save();
    ctx.clip();
    ctx.fillStyle = PALETTE.stone;
    ctx.beginPath();
    ctx.ellipse(x + dx - r * 0.25, y + dy - r * 0.42, r * 0.66, r * 0.34, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Where the enemies come in. A broken gatehouse, so it reads as a breach. */
function paintBreach(ctx: CanvasRenderingContext2D) {
  const y = PATH[0].y;
  ctx.save();
  for (const [ty, th] of [
    [y - TILE * 1.7, TILE * 1.15],
    [y + TILE * 0.55, TILE * 1.15],
  ] as [number, number][]) {
    rounded(ctx, -10, ty, 32, th, 6);
    inked(ctx, PALETTE.stoneMid, PALETTE.stoneDark, 4);

    // Courses of stone, and rubble at the broken end , which is what says
    // breach rather than gate.
    ctx.strokeStyle = PALETTE.stoneDark;
    ctx.lineWidth = 2;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(-8, ty + (th / 4) * i);
      ctx.lineTo(20, ty + (th / 4) * i);
      ctx.stroke();
    }
    for (const [rx, ry, rr] of [
      [20, ty + th - 8, 8],
      [27, ty + 12, 6],
      [24, ty + th * 0.55, 5],
    ] as [number, number, number][]) {
      ctx.beginPath();
      ctx.arc(rx, ry, rr, 0, Math.PI * 2);
      inked(ctx, PALETTE.stone, PALETTE.stoneDark, 2.5);
    }
  }
  ctx.restore();
}

// ── the plot grid ──────────────────────────────────────────────────────────

/**
 * The buildable plots, drawn live and only while a tower is being placed.
 *
 * Baked into the ground this was the worst thing on the board , a hundred-odd
 * identical rounded squares over every inch of turf, which is what made a
 * field look like a spreadsheet. It is information a player wants while they
 * are deciding where something goes and at no other moment, so that is when it
 * appears.
 */
export function drawPlots(ctx: CanvasRenderingContext2D, taken: Set<number>) {
  ctx.save();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!isBuildable(c, r)) continue;
      if (taken.has(r * COLS + c)) continue;
      const x = c * TILE;
      const y = r * TILE;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      rounded(ctx, x + 7, y + 7, TILE - 14, TILE - 14, 9);
      ctx.fill();
      // Corner ticks rather than a full border: it marks the plot without
      // drawing a cage around every square inch of the map.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      const k = 10;
      ctx.beginPath();
      for (const [ox, oy, sx, sy] of [
        [7, 7, 1, 1],
        [TILE - 7, 7, -1, 1],
        [7, TILE - 7, 1, -1],
        [TILE - 7, TILE - 7, -1, -1],
      ] as [number, number, number, number][]) {
        ctx.moveTo(x + ox + sx * k, y + oy);
        ctx.lineTo(x + ox, y + oy);
        ctx.lineTo(x + ox, y + oy + sy * k);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Drop the bake. Only used when the tab regains a lost canvas context. */
export function dropGround() {
  ground = null;
}
