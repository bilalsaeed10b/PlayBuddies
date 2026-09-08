/**
 * The ground: turf, road, scenery, and the plot grid.
 *
 * Split out of art.ts because it is a different job on a different schedule —
 * all of this is painted exactly once into an offscreen bitmap and blitted
 * from then on, where the towers and enemies in art.ts are drawn every frame.
 *
 * The first pass at this was the worst-looking thing in the game and it is
 * worth saying why, because both faults were the same mistake. The turf was
 * one flat green: real ground varies at a scale you notice from across the
 * board, not at the scale of a blade of grass. And a faint rounded square was
 * baked onto every one of the hundred-odd buildable tiles, which turned a
 * field into a spreadsheet — that grid is information a player wants while
 * they are deciding where a tower goes and at no other time, so it now lives
 * in `drawPlots` and appears only then.
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

// ── the bake ───────────────────────────────────────────────────────────────

let ground: HTMLCanvasElement | null = null;

/**
 * Baked once for the whole session, and shared by every keep on screen — they
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

  // Turf.
  //
  // Painted as a base wash plus soft-edged blobs, and emphatically *not* as a
  // grid of noise-sampled cells, which is what it was first. A cell grid
  // quantises: each block is one flat colour, and with a noise lattice only a
  // couple of cells wide the steps between them line up into vertical banding
  // you cannot unsee once you have noticed it. A radial gradient has no edge
  // to band along.
  const base = ctx.createLinearGradient(0, 0, WORLD_W * 0.25, WORLD_H);
  base.addColorStop(0, '#4a8449');
  base.addColorStop(0.5, '#3d7440');
  base.addColorStop(1, '#2d5a35');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // Patches: lighter meadow, darker shade, and dry yellowed ground. Sized in
  // multiples of a tile so they read at the scale the board is looked at.
  const patches: [string, number, number][] = [
    ['rgba(122, 172, 96, 0.5)', 30, 150],
    ['rgba(38, 82, 46, 0.45)', 26, 170],
    ['rgba(150, 168, 88, 0.3)', 16, 120],
  ];
  for (const [colour, count, size] of patches) {
    for (let i = 0; i < count; i++) {
      const x = rnd() * WORLD_W;
      const y = rnd() * WORLD_H;
      const r = size * (0.5 + rnd() * 0.9);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, colour);
      g.addColorStop(1, colour.replace(/[\d.]+\)$/, '0)'));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.6 + rnd() * 0.5), rnd() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Trodden earth spreading out from the road, so the road belongs to the
  // ground rather than being a ribbon laid across it. Stroked in widening
  // passes rather than sampled per cell, for the same reason as above.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 6; i >= 1; i--) {
    ctx.strokeStyle = `rgba(126, 106, 72, ${0.06 + (6 - i) * 0.015})`;
    ctx.lineWidth = ROAD_W + i * 26;
    strokeRoute(ctx);
  }
  // And a few dry scuffs off the shoulder, so the wear is not a perfect band.
  for (let i = 0; i < 40; i++) {
    const d = rnd() * PATH_LENGTH;
    const p = pointAt(d);
    const r = 22 + rnd() * 40;
    const x = p.x + (rnd() - 0.5) * 120;
    const y = p.y + (rnd() - 0.5) * 120;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(134, 114, 78, 0.35)');
    g.addColorStop(1, 'rgba(134, 114, 78, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Blades, and only where the turf is actually turf.
  ctx.lineCap = 'round';
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * WORLD_W;
    const y = rnd() * WORLD_H;
    if (distToRoad(x, y) < 32) continue;
    const len = 3 + rnd() * 6;
    ctx.strokeStyle = `rgba(${(148 + rnd() * 62) | 0}, ${(194 + rnd() * 52) | 0}, ${(118 + rnd() * 52) | 0}, ${0.07 + rnd() * 0.13})`;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 3.5, y - len);
    ctx.stroke();
  }

  paintRoad(ctx, rnd);
  paintScenery(ctx);
  paintVignette(ctx);
  paintBreach(ctx);
}

function routePath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(PATH[0].x, PATH[0].y);
  for (let i = 1; i < PATH.length; i++) ctx.lineTo(PATH[i].x, PATH[i].y);
}

function strokeRoute(ctx: CanvasRenderingContext2D) {
  routePath(ctx);
  ctx.stroke();
}

function paintRoad(ctx: CanvasRenderingContext2D, rnd: () => number) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // A soft shadow under the whole road, so it sits *in* the ground.
  ctx.strokeStyle = 'rgba(12, 22, 16, 0.5)';
  ctx.lineWidth = ROAD_W + 16;
  strokeRoute(ctx);

  ctx.strokeStyle = '#6b5a3f';
  ctx.lineWidth = ROAD_W + 4;
  strokeRoute(ctx);
  ctx.strokeStyle = '#8d7952';
  ctx.lineWidth = ROAD_W;
  strokeRoute(ctx);
  ctx.strokeStyle = '#9c8760';
  ctx.lineWidth = ROAD_W - 16;
  strokeRoute(ctx);

  // Cobbles, laid by walking the route so every one is genuinely on the road
  // however it bends. Scattering them over the map and rejecting the misses
  // would be slower and would never quite fill the corners.
  for (let d = 0; d < PATH_LENGTH; d += 11) {
    const p = pointAt(d);
    const ahead = pointAt(Math.min(PATH_LENGTH, d + 6));
    const ang = Math.atan2(ahead.y - p.y, ahead.x - p.x);
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    for (let k = -2; k <= 2; k++) {
      if (rnd() < 0.35) continue;
      const off = k * (ROAD_W / 5.4) + (rnd() - 0.5) * 5;
      const shade = 118 + rnd() * 46;
      ctx.save();
      ctx.translate(p.x + nx * off + (rnd() - 0.5) * 4, p.y + ny * off + (rnd() - 0.5) * 4);
      ctx.rotate(ang + (rnd() - 0.5) * 0.5);
      ctx.fillStyle = `rgba(${shade | 0}, ${(shade * 0.88) | 0}, ${(shade * 0.66) | 0}, 0.5)`;
      rounded(ctx, -5, -3.4, 10, 6.8, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(60, 48, 32, 0.28)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  // Wheel ruts worn down the middle.
  ctx.strokeStyle = 'rgba(74, 60, 40, 0.28)';
  ctx.lineWidth = 4;
  ctx.setLineDash([22, 16]);
  strokeRoute(ctx);
  ctx.setLineDash([]);
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
    const rx = (x1 - x0) / 2 - 5;
    const ry = (y1 - y0) / 2 - 5;

    ctx.fillStyle = 'rgba(24, 44, 30, 0.8)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 4, rx + 8, ry + 8, 0, 0, Math.PI * 2);
    ctx.fill();

    const water = ctx.createRadialGradient(cx - rx * 0.3, cy - ry * 0.35, 4, cx, cy, rx);
    water.addColorStop(0, '#4aa3c4');
    water.addColorStop(0.55, '#2b7495');
    water.addColorStop(1, '#154868');
    ctx.fillStyle = water;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    // Two still highlights. Water with no light on it is a hole.
    ctx.strokeStyle = 'rgba(210, 245, 255, 0.38)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(cx - rx * 0.2, cy - ry * 0.32, rx * 0.42, ry * 0.16, -0.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.ellipse(cx + rx * 0.26, cy + ry * 0.3, rx * 0.26, ry * 0.1, 0.15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Reeds on the near bank, which is what stops it reading as a blue puddle.
    const rnd = mulberry32(0x9077d);
    for (let i = 0; i < 22; i++) {
      const a = rnd() * Math.PI * 2;
      const px = cx + Math.cos(a) * rx * (0.94 + rnd() * 0.14);
      const py = cy + Math.sin(a) * ry * (0.94 + rnd() * 0.14);
      ctx.strokeStyle = `rgba(${(96 + rnd() * 50) | 0}, ${(140 + rnd() * 50) | 0}, ${(72 + rnd() * 40) | 0}, 0.75)`;
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + (rnd() - 0.5) * 5, py - 8 - rnd() * 9);
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
  const h = 30 + rnd() * 10;

  // Thrown to one side, so every tree on the board agrees where the light is.
  ctx.fillStyle = 'rgba(10, 20, 14, 0.42)';
  ctx.beginPath();
  ctx.ellipse(x + 8, y + 11, 20, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#4a3524';
  rounded(ctx, x - 4, y - 4, 8, 16, 3);
  ctx.fill();

  // Three overlapping blobs rather than one circle: a circle reads as a bush.
  for (const [dx, dy, r] of [[-9, -h * 0.55, 15], [9, -h * 0.5, 14], [0, -h * 0.85, 17]] as [number, number, number][]) {
    const g = ctx.createRadialGradient(x + dx - r * 0.35, y + dy - r * 0.4, 2, x + dx, y + dy, r);
    g.addColorStop(0, '#63a24d');
    g.addColorStop(0.6, '#3d7135');
    g.addColorStop(1, '#254a25');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, r * (0.9 + rnd() * 0.2), 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintRock(ctx: CanvasRenderingContext2D, x: number, y: number, rnd: () => number) {
  ctx.fillStyle = 'rgba(10, 20, 14, 0.4)';
  ctx.beginPath();
  ctx.ellipse(x + 6, y + 9, 19, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  for (const [dx, dy, r] of [[-8, 2, 12], [7, 4, 10], [0, -6, 14]] as [number, number, number][]) {
    const g = ctx.createLinearGradient(x + dx, y + dy - r, x + dx, y + dy + r);
    g.addColorStop(0, '#9aa2ac');
    g.addColorStop(0.55, '#6d757f');
    g.addColorStop(1, '#434952');
    ctx.fillStyle = g;
    ctx.beginPath();
    // Faceted rather than round, so it reads as stone and not as a boulder
    // drawn with the same tool as the tree canopy.
    const sides = 6;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + rnd() * 0.3;
      const rr = r * (0.78 + rnd() * 0.32);
      const px = x + dx + Math.cos(a) * rr;
      const py = y + dy + Math.sin(a) * rr * 0.82;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(30, 34, 40, 0.4)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
}

/** Darkens the rim, so the eye settles on the middle of the board. */
function paintVignette(ctx: CanvasRenderingContext2D) {
  const g = ctx.createRadialGradient(
    WORLD_W * 0.45,
    WORLD_H * 0.42,
    WORLD_H * 0.25,
    WORLD_W * 0.5,
    WORLD_H * 0.5,
    WORLD_W * 0.74,
  );
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(1, 'rgba(4, 10, 8, 0.5)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
}

/** Where the enemies come in. A broken gatehouse, so it reads as a breach. */
function paintBreach(ctx: CanvasRenderingContext2D) {
  const y = PATH[0].y;
  ctx.save();
  for (const [ty, th] of [
    [y - TILE * 1.6, TILE * 1.05],
    [y + TILE * 0.55, TILE * 1.05],
  ] as [number, number][]) {
    const g = ctx.createLinearGradient(0, ty, 28, ty);
    g.addColorStop(0, '#3d3d48');
    g.addColorStop(1, '#23232c');
    ctx.fillStyle = g;
    rounded(ctx, -8, ty, 28, th, 4);
    ctx.fill();
    // Rubble at the broken end, which is what says breach rather than gate.
    ctx.fillStyle = '#4a4a56';
    ctx.beginPath();
    ctx.arc(17, ty + th - 6, 6, 0, Math.PI * 2);
    ctx.arc(22, ty + 9, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ── the plot grid ──────────────────────────────────────────────────────────

/**
 * The buildable plots, drawn live and only while a tower is being placed.
 *
 * Baked into the ground this was the worst thing on the board — a hundred-odd
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
      ctx.fillStyle = 'rgba(190, 255, 210, 0.06)';
      rounded(ctx, x + 7, y + 7, TILE - 14, TILE - 14, 7);
      ctx.fill();
      // Corner ticks rather than a full border: it marks the plot without
      // drawing a cage around every square inch of the map.
      ctx.strokeStyle = 'rgba(190, 255, 210, 0.28)';
      ctx.lineWidth = 2;
      const k = 9;
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
