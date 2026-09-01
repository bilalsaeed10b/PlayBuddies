/**
 * The sea and everything painted on it.
 *
 * The sky, the sun, the clouds, the far islands and the body of the water do
 * not change for the whole match, so they are painted once into an offscreen
 * canvas and blitted with a single drawImage every frame. Fish Eat Fish paid
 * for that lesson: a per-frame vector background is where the frame budget
 * goes, and none of it is animation anybody is looking at.
 *
 * What IS animated is deliberately tiny -- a handful of sine strokes at the
 * waterline and, on a machine that can spare it, some glitter on the swell.
 *
 * The explosion sprites live here for the same reason. Building a radial
 * gradient per particle per frame is the single most expensive thing a canvas
 * game can do; three baked sprites drawn with an alpha and a scale look the
 * same and cost a blit.
 */
import { Arena, BALANCE, clamp, mulberry32 } from './rules';
import type { Rock } from '../types/game';

/** Deterministic, so two players in a room see the same horizon. */
const SEED = 0x5eaf00d;

export function bakeSea(arena: Arena, fancy: boolean, storm = false): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = arena.w;
    canvas.height = arena.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    paint(ctx, arena, fancy);
    // Painted over the finished fair-weather sea rather than as a second
    // palette threaded through every gradient below. It is one composite on
    // a canvas that is baked exactly once a match, and it keeps the calm sea
    // -- the one nearly every battle is fought on -- untouched.
    if (storm) foulWeather(ctx, arena);
    return canvas;
  } catch {
    // A device that cannot spare a canvas this size still gets a playable
    // game -- see drawFallbackSea.
    return null;
  }
}

/** Sky and water only, for when the bake could not be made. */
export function drawFallbackSea(ctx: CanvasRenderingContext2D, arena: Arena) {
  const sky = ctx.createLinearGradient(0, 0, 0, arena.seaY);
  sky.addColorStop(0, '#0b2a46');
  sky.addColorStop(1, '#8fc7e8');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, arena.w, arena.seaY);
  ctx.fillStyle = '#12558a';
  ctx.fillRect(0, arena.seaY, arena.w, arena.h - arena.seaY);
}

function paint(ctx: CanvasRenderingContext2D, arena: Arena, fancy: boolean) {
  const rnd = mulberry32(SEED);
  const { w, seaY, h } = arena;

  // -- sky ------------------------------------------------------------------
  const sky = ctx.createLinearGradient(0, 0, 0, seaY);
  sky.addColorStop(0, '#071b33');
  sky.addColorStop(0.34, '#14507f');
  sky.addColorStop(0.68, '#4f9dc7');
  sky.addColorStop(0.88, '#a9d8e8');
  sky.addColorStop(1, '#ffd9a8');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, seaY);

  // A low sun just off centre, so the two halves of the arena are not mirror
  // images of each other and each side gets a different-looking sky.
  const sunX = w * 0.66;
  const sunY = seaY * 0.68;
  const bloom = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, seaY * 0.62);
  bloom.addColorStop(0, 'rgba(255, 236, 178, 0.9)');
  bloom.addColorStop(0.3, 'rgba(255, 200, 130, 0.3)');
  bloom.addColorStop(1, 'rgba(255, 190, 120, 0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, w, seaY);
  ctx.beginPath();
  ctx.arc(sunX, sunY, seaY * 0.075, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 250, 226, 0.95)';
  ctx.fill();

  // -- clouds ---------------------------------------------------------------
  for (let i = 0; i < 9; i++) {
    const cx = rnd() * w;
    const cy = 60 + rnd() * (seaY * 0.5);
    const scale = 0.5 + rnd() * 1.1;
    const warm = cy > seaY * 0.4;
    puff(ctx, cx, cy, scale, warm ? 'rgba(255, 226, 196, 0.72)' : 'rgba(226, 240, 250, 0.5)');
  }

  // -- far headlands --------------------------------------------------------
  headland(ctx, arena, rnd, seaY - 10, '#0e3550', 0.55, 5);
  headland(ctx, arena, rnd, seaY - 4, '#0a2b42', 0.75, 4);

  // Two silhouettes on the horizon. Nothing but scenery, and they sell the
  // idea that this is one fight in a much larger sea.
  farShip(ctx, w * 0.14, seaY - 16, 0.7);
  farShip(ctx, w * 0.86, seaY - 12, 0.5);

  // -- the water ------------------------------------------------------------
  const sea = ctx.createLinearGradient(0, seaY, 0, h);
  sea.addColorStop(0, '#2f8fb8');
  sea.addColorStop(0.18, '#1a6a96');
  sea.addColorStop(0.62, '#0e4670');
  sea.addColorStop(1, '#062744');
  ctx.fillStyle = sea;
  ctx.fillRect(0, seaY, w, h - seaY);

  // Sun road: a widening band of reflected light running down the water.
  const road = ctx.createLinearGradient(0, seaY, 0, h);
  road.addColorStop(0, 'rgba(255, 220, 160, 0.42)');
  road.addColorStop(1, 'rgba(255, 200, 130, 0)');
  ctx.fillStyle = road;
  ctx.beginPath();
  ctx.moveTo(sunX - 26, seaY);
  ctx.lineTo(sunX + 26, seaY);
  ctx.lineTo(sunX + 230, h);
  ctx.lineTo(sunX - 230, h);
  ctx.closePath();
  ctx.fill();

  // Static swell. Deeper water gets longer, lazier strokes, which is what
  // gives the flat fill any sense of distance at all.
  ctx.lineCap = 'round';
  const rows = fancy ? 26 : 14;
  for (let i = 0; i < rows; i++) {
    const t = i / rows;
    const y = seaY + 12 + t * (h - seaY);
    const len = 30 + t * 130;
    const alpha = 0.16 - t * 0.08;
    ctx.strokeStyle = `rgba(190, 232, 255, ${Math.max(0.03, alpha)})`;
    ctx.lineWidth = 1.5 + t * 3;
    const count = Math.round(4 + t * 7);
    for (let j = 0; j < count; j++) {
      const x = rnd() * w;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + len * 0.5, y - 4 - t * 4, x + len, y);
      ctx.stroke();
    }
  }

  // Foam line right at the horizon, where the eye expects the break.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, seaY + 1);
  ctx.lineTo(w, seaY + 1);
  ctx.stroke();

  // -- vignette -------------------------------------------------------------
  if (fancy) {
    const vig = ctx.createRadialGradient(w / 2, arena.seaY * 0.7, arena.seaY * 0.5, w / 2, arena.seaY * 0.7, w * 0.72);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(2, 10, 22, 0.42)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  }
}

function puff(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, 90 * scale, 26 * scale, 0, 0, Math.PI * 2);
  ctx.ellipse(x - 52 * scale, y + 8 * scale, 54 * scale, 18 * scale, 0, 0, Math.PI * 2);
  ctx.ellipse(x + 58 * scale, y + 6 * scale, 62 * scale, 20 * scale, 0, 0, Math.PI * 2);
  ctx.ellipse(x + 10 * scale, y - 18 * scale, 58 * scale, 24 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
}

function headland(
  ctx: CanvasRenderingContext2D,
  arena: Arena,
  rnd: () => number,
  baseY: number,
  color: string,
  alpha: number,
  peaks: number,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-40, baseY);
  for (let i = 0; i <= peaks; i++) {
    const x = (arena.w / peaks) * i + (rnd() - 0.5) * 90;
    const height = 40 + rnd() * 95;
    ctx.quadraticCurveTo(x - arena.w / peaks / 2, baseY - height, x, baseY - height * 0.35);
  }
  ctx.lineTo(arena.w + 40, baseY);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function farShip(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = '#08243a';
  ctx.beginPath();
  ctx.moveTo(-38, 0);
  ctx.lineTo(38, 0);
  ctx.lineTo(26, 12);
  ctx.lineTo(-28, 12);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-4, -2);
  ctx.lineTo(-4, -54);
  ctx.lineTo(26, -12);
  ctx.closePath();
  ctx.moveTo(-8, -2);
  ctx.lineTo(-8, -46);
  ctx.lineTo(-32, -10);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The only part of the water that moves.
 *
 * Three to six strokes, scaled by the quality tier. It reads as a live sea for
 * a fraction of what an animated gradient would cost, and on the cheapest tier
 * it degrades to two strokes rather than to nothing, because a completely
 * still sea looks broken in a way that a slow one does not.
 */
export function drawWaves(
  ctx: CanvasRenderingContext2D,
  arena: Arena,
  clock: number,
  count: number,
  swell = 1,
) {
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const y = arena.seaY + 8 + t * 120;
    // Faster as well as taller. Big slow water reads as a swell; a storm is
    // short, steep and quick.
    const phase = clock * (0.5 + t * 0.5) * swell + i * 1.7;
    const amp = (4 + t * 5) * swell * swell;
    ctx.strokeStyle = `rgba(214, 244, 255, ${(0.3 - t * 0.16) * (swell > 1 ? 1.5 : 1)})`;
    ctx.lineWidth = (2 + t * 2) * (swell > 1 ? 1.4 : 1);
    ctx.beginPath();
    for (let x = -40; x <= arena.w + 40; x += 80) {
      const yy = y + Math.sin(x * 0.008 + phase) * amp;
      if (x === -40) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The gale, laid over the baked sea.
 *
 * Drains the warmth out of the sky, drops a bank of low cloud across it and
 * puts a cold green cast on the water. Everything here is a fill or a stroke
 * over what `paint` already produced, so it costs one bake and nothing per
 * frame -- the moving half of the weather (rain, and heavier wave strokes)
 * lives in `drawWeather` and `drawWaves` instead.
 */
function foulWeather(ctx: CanvasRenderingContext2D, arena: Arena) {
  const { w, seaY, h } = arena;
  const rnd = mulberry32(SEED ^ 0x5f0a17);

  ctx.save();

  // The sun goes first. A storm with a low golden sun still in it reads as a
  // colour filter rather than as weather.
  const gloom = ctx.createLinearGradient(0, 0, 0, seaY);
  gloom.addColorStop(0, 'rgba(6, 12, 22, 0.92)');
  gloom.addColorStop(0.55, 'rgba(22, 38, 55, 0.82)');
  gloom.addColorStop(1, 'rgba(46, 66, 82, 0.72)');
  ctx.fillStyle = gloom;
  ctx.fillRect(0, 0, w, seaY);

  // Low, torn cloud right down on the horizon.
  for (let i = 0; i < 16; i++) {
    const cx = rnd() * w;
    const cy = seaY * (0.12 + rnd() * 0.72);
    const scale = 0.9 + rnd() * 1.9;
    puff(ctx, cx, cy, scale, `rgba(${28 + rnd() * 26 | 0}, ${38 + rnd() * 28 | 0}, ${52 + rnd() * 30 | 0}, 0.66)`);
  }

  // Cold green-black water, and the sun road with it.
  const water = ctx.createLinearGradient(0, seaY, 0, h);
  water.addColorStop(0, 'rgba(18, 44, 52, 0.74)');
  water.addColorStop(0.5, 'rgba(8, 26, 38, 0.8)');
  water.addColorStop(1, 'rgba(3, 12, 22, 0.88)');
  ctx.fillStyle = water;
  ctx.fillRect(0, seaY, w, h - seaY);

  // A pale seam where the sky meets the water, so the horizon does not
  // vanish entirely into the murk.
  ctx.fillStyle = 'rgba(150, 178, 190, 0.3)';
  ctx.fillRect(0, seaY - 2, w, 3);

  ctx.restore();
}

/**
 * Rain, and the spray coming off the crests. The moving half of the weather.
 *
 * Seeded per column off a fixed integer rather than kept as particles: a few
 * hundred live rain objects is a few hundred more things for the collector to
 * find, and it finds them mid-flight. This is a closed-form position from the
 * clock, so it costs one loop and allocates nothing.
 */
export function drawWeather(
  ctx: CanvasRenderingContext2D,
  arena: Arena,
  clock: number,
  gust: number,
  count: number,
) {
  if (count <= 0) return;
  const { w, h } = arena;
  // Rain leans with the wind, and hard: near-vertical rain in a gale that is
  // visibly pushing the shot sideways looks like two different weathers.
  const lean = clamp(gust / 210, -1, 1) * 0.55;
  ctx.save();
  ctx.strokeStyle = 'rgba(196, 224, 236, 0.3)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const rnd = mulberry32(SEED + i * 2654435761);
    const speed = 900 + rnd() * 700;
    const len = 34 + rnd() * 46;
    const x0 = rnd() * w;
    // Wrapped rather than respawned, so a drop leaving the bottom is the
    // same drop arriving at the top and the field never thins out.
    const y = ((rnd() * h + clock * speed) % (h + 200)) - 100;
    const x = (x0 + y * lean + w) % w;
    ctx.moveTo(x, y);
    ctx.lineTo(x - len * lean, y + len);
  }
  ctx.stroke();
  ctx.restore();
}

// -- the mountain -------------------------------------------------------------

/**
 * How much mountain is left, after the chipping.
 *
 * Exported because the simulation has to agree with the picture. Only the
 * drawing used to shrink, so a mountain two hits in still swallowed shots
 * through forty pixels of water that plainly had nothing in it -- the kind of
 * miss a player reads as the game cheating. Ballistics and paint now ask the
 * same question and get the same number.
 */
export function rockRadius(rock: Rock): number {
  return rock.r * (0.55 + 0.45 * (rock.hp / BALANCE.ROCK_HP));
}

/**
 * The mountain, drawn live because there is only ever the one and it changes
 * shape as it is chipped away. A round boulder reads as an island; this is a
 * wide base tapering to a single jagged summit instead, biased to keep most
 * of its outline inside the collision circle so what looks solid mostly is.
 * The silhouette comes from the rock's own seed, so it is the same mountain
 * on both screens.
 */
export function drawRock(ctx: CanvasRenderingContext2D, rock: Rock) {
  const rnd = mulberry32(rock.seed);
  const r = rockRadius(rock);

  ctx.save();
  ctx.translate(rock.x, rock.y);

  const baseY = r * 0.66;
  const halfBase = r * 0.98;
  const summitX = (rnd() - 0.5) * r * 0.28;
  const summitY = -r * 0.98;

  // Soft shadow spilling past the footprint, so the waterline reads as
  // something the rock sits IN rather than a flat cutout stamped on top of
  // the sea. Drawn before the rock itself, so the fill below covers the
  // part of it that overlaps stone.
  const wet = ctx.createRadialGradient(0, baseY, 0, 0, baseY, halfBase * 1.2);
  wet.addColorStop(0, 'rgba(6, 24, 34, 0.5)');
  wet.addColorStop(0.65, 'rgba(6, 30, 42, 0.22)');
  wet.addColorStop(1, 'rgba(6, 30, 42, 0)');
  ctx.fillStyle = wet;
  ctx.beginPath();
  ctx.ellipse(0, baseY + 3, halfBase * 1.2, r * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  const body = new Path2D();
  body.moveTo(-halfBase, baseY);
  body.lineTo(-halfBase * 0.62 - rnd() * r * 0.08, -r * 0.4 - rnd() * r * 0.1);
  body.lineTo(-halfBase * 0.2 - rnd() * r * 0.06, -r * 0.68 - rnd() * r * 0.08);
  body.lineTo(summitX, summitY);
  body.lineTo(halfBase * 0.3 + rnd() * r * 0.06, -r * 0.6 - rnd() * r * 0.08);
  body.lineTo(halfBase * 0.68 + rnd() * r * 0.08, -r * 0.28 - rnd() * r * 0.1);
  body.lineTo(halfBase, baseY);
  body.closePath();
  ctx.fillStyle = '#38422f';
  ctx.fill(body);

  // Fade the stone into the water instead of ending on a hard flat line --
  // a waterline is a gradient, not an edge.
  ctx.save();
  ctx.clip(body);
  const soak = ctx.createLinearGradient(0, baseY - r * 0.18, 0, baseY);
  soak.addColorStop(0, 'rgba(14, 70, 112, 0)');
  soak.addColorStop(1, 'rgba(14, 70, 112, 0.6)');
  ctx.fillStyle = soak;
  ctx.fillRect(-halfBase, baseY - r * 0.18, halfBase * 2, r * 0.18);
  ctx.restore();

  // Lit face, catching the light from the same side the sun sits on.
  ctx.fillStyle = '#54654a';
  ctx.beginPath();
  ctx.moveTo(summitX, summitY);
  ctx.lineTo(halfBase * 0.3, -r * 0.6);
  ctx.lineTo(summitX + r * 0.1, -r * 0.5);
  ctx.closePath();
  ctx.fill();

  // A pale cap right at the summit -- the one part of it that never gets wet.
  ctx.fillStyle = 'rgba(238, 244, 240, 0.88)';
  ctx.beginPath();
  ctx.moveTo(summitX, summitY);
  ctx.lineTo(summitX + r * 0.13, summitY + r * 0.24);
  ctx.lineTo(summitX - r * 0.13, summitY + r * 0.22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// -- baked effect sprites ---------------------------------------------------

export interface FxSprites {
  fire: HTMLCanvasElement | null;
  smoke: HTMLCanvasElement | null;
  spark: HTMLCanvasElement | null;
  splash: HTMLCanvasElement | null;
}

let fx: FxSprites | null = null;

/** Built on first use and kept for the life of the page. */
export function fxSprites(): FxSprites {
  if (fx) return fx;
  fx = {
    fire: radial(128, [
      [0, 'rgba(255, 255, 240, 1)'],
      [0.2, 'rgba(255, 236, 150, 0.96)'],
      [0.45, 'rgba(255, 156, 46, 0.8)'],
      [0.75, 'rgba(198, 62, 18, 0.34)'],
      [1, 'rgba(120, 30, 8, 0)'],
    ]),
    smoke: radial(96, [
      [0, 'rgba(150, 148, 146, 0.72)'],
      [0.55, 'rgba(108, 106, 106, 0.4)'],
      [1, 'rgba(70, 70, 72, 0)'],
    ]),
    spark: radial(32, [
      [0, 'rgba(255, 250, 224, 1)'],
      [0.4, 'rgba(255, 206, 110, 0.85)'],
      [1, 'rgba(255, 150, 40, 0)'],
    ]),
    splash: radial(96, [
      [0, 'rgba(255, 255, 255, 0.92)'],
      [0.4, 'rgba(206, 238, 255, 0.55)'],
      [1, 'rgba(150, 205, 240, 0)'],
    ]),
  };
  return fx;
}

function radial(size: number, stops: [number, string][]): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const half = size / 2;
    const g = ctx.createRadialGradient(half, half, 0, half, half, half);
    for (const [at, color] of stops) g.addColorStop(at, color);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return canvas;
  } catch {
    return null;
  }
}
