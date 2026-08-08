/**
 * The reef, drawn rather than photographed.
 *
 * The old background was a single 1408×768 image stretched across a 3000×2200
 * world — a 2.1× upscale before the camera zoom is even applied, which is why
 * it looked pixelated. Vector art has no native resolution, so it stays sharp
 * at any zoom and on any screen, and it drops a 367 KB download.
 *
 * Everything is laid out from a fixed seed, so every player in a room is
 * looking at exactly the same reef.
 */

/** Small, fast, and identical in every browser — Math.random() would give each player a different reef. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rock {
  x: number;
  y: number;
  w: number;
  h: number;
  points: [number, number][];
}

interface Weed {
  x: number;
  y: number;
  h: number;
  lean: number;
  phase: number;
  hue: number;
  /** Stroke width, and how dark it is drawn — the back rank is thinner and duller. */
  thick: number;
  back: boolean;
}

/** A stone on the seabed. Cheap silhouettes that break up the flat sand. */
interface Pebble {
  x: number;
  y: number;
  rx: number;
  ry: number;
  tone: number;
}

interface Coral {
  x: number;
  y: number;
  r: number;
  arms: number;
  color: string;
  phase: number;
}

interface Shaft {
  x: number;
  w: number;
  lean: number;
  phase: number;
  alpha: number;
}

export interface Reef {
  width: number;
  height: number;
  floor: number;
  dunes: [number, number][];
  far: Rock[];
  near: Rock[];
  weeds: Weed[];
  corals: Coral[];
  pebbles: Pebble[];
  shafts: Shaft[];
  /** Built on first draw and reused. Gradients are the expensive part of this. */
  cache?: { water: CanvasGradient; sand: CanvasGradient; depth: CanvasGradient };
}

/** The slice of world currently on screen, so nothing off-camera gets drawn. */
export interface ViewBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const CORAL_COLOURS = ['#e8698f', '#f0a04b', '#d95d8f', '#e8894b', '#c65b9c'];

/** Builds the layout once. Cheap, but there is no reason to redo it every frame. */
export function buildReef(width: number, height: number): Reef {
  const rnd = mulberry32(0x5eaf00d);
  const floor = height * 0.82;

  const jaggedRock = (x: number, y: number, w: number, h: number): Rock => {
    const points: [number, number][] = [];
    const steps = 6 + Math.floor(rnd() * 4);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // A rough dome: sine for the silhouette, noise for the crags.
      const lift = Math.sin(t * Math.PI) * h * (0.7 + rnd() * 0.5);
      points.push([x + t * w, y - lift]);
    }
    return { x, y, w, h, points };
  };

  const far: Rock[] = [];
  for (let i = 0; i < 9; i++) {
    const w = 380 + rnd() * 520;
    far.push(jaggedRock(rnd() * width - w * 0.3, floor + 30, w, 220 + rnd() * 260));
  }

  const near: Rock[] = [];
  for (let i = 0; i < 7; i++) {
    const w = 260 + rnd() * 420;
    near.push(jaggedRock(rnd() * width - w * 0.3, floor + 90, w, 140 + rnd() * 200));
  }

  // Counts are generous because none of this costs a frame any more — the reef
  // is painted once into an offscreen canvas and blitted from then on. A sparse
  // seabed was a compromise for a per-frame renderer that no longer exists.
  const weeds: Weed[] = [];
  for (let i = 0; i < 150; i++) {
    // Two thirds go in the back rank: thinner, duller, taller, drawn before the
    // rocks-to-sand transition so the bed has depth instead of one flat row.
    const back = i < 100;
    weeds.push({
      x: rnd() * width,
      y: floor + (back ? 10 : 40) + rnd() * (height - floor - 60),
      h: (back ? 120 : 90) + rnd() * (back ? 260 : 220),
      // A generous lean. Near-vertical strokes read as sticks; sea grass wants
      // to look like it is being pushed by a current.
      lean: (rnd() - 0.5) * (back ? 220 : 150),
      phase: rnd() * Math.PI * 2,
      hue: 130 + rnd() * 40,
      thick: back ? 4 + rnd() * 4 : 7 + rnd() * 6,
      back,
    });
  }

  const corals: Coral[] = [];
  for (let i = 0; i < 72; i++) {
    corals.push({
      x: rnd() * width,
      y: floor + 60 + rnd() * (height - floor - 80),
      r: 22 + rnd() * 62,
      arms: 4 + Math.floor(rnd() * 4),
      color: CORAL_COLOURS[Math.floor(rnd() * CORAL_COLOURS.length)],
      phase: rnd() * Math.PI * 2,
    });
  }

  const pebbles: Pebble[] = [];
  for (let i = 0; i < 220; i++) {
    const rx = 5 + rnd() * 22;
    pebbles.push({
      x: rnd() * width,
      y: floor + 30 + rnd() * (height - floor - 30),
      rx,
      ry: rx * (0.45 + rnd() * 0.3),
      tone: rnd(),
    });
  }

  const shafts: Shaft[] = [];
  for (let i = 0; i < 7; i++) {
    shafts.push({
      x: (i + 0.5) * (width / 7) + (rnd() - 0.5) * 160,
      w: 90 + rnd() * 190,
      lean: (rnd() - 0.5) * 420,
      phase: rnd() * Math.PI * 2,
      alpha: 0.04 + rnd() * 0.05,
    });
  }

  // A gently rolling sand line rather than a ruler-straight one.
  const dunes: [number, number][] = [];
  for (let x = -100; x <= width + 100; x += 120) {
    dunes.push([x, floor + Math.sin(x * 0.0021) * 26 + Math.sin(x * 0.0007) * 44]);
  }

  return { width, height, floor, dunes, far, near, weeds, corals, pebbles, shafts };
}

function rockPath(ctx: CanvasRenderingContext2D, rock: Rock, bottom: number) {
  ctx.beginPath();
  ctx.moveTo(rock.points[0][0], bottom);
  for (const [px, py] of rock.points) ctx.lineTo(px, py);
  ctx.lineTo(rock.points[rock.points.length - 1][0], bottom);
  ctx.closePath();
}

/**
 * Renders the reef once into an offscreen canvas, to be blitted every frame.
 *
 * Drawing the vectors live cost real frames on a mid-range phone: 46 weed
 * strokes, 150-odd coral quadratics, and — the expensive part — seven light
 * shafts that each rebuilt a gradient and composited in `lighter` mode, which
 * mobile GPUs handle badly. Baking it turns all of that into a single
 * drawImage per frame.
 *
 * The trade is that the weeds no longer sway. That is a fair price for a
 * background nobody is looking at, and it is what was asked for.
 *
 * Resolution is chosen against the device: a phone gets a smaller texture
 * because a 3000×2200 canvas is 26 MB of memory it may not want to spare.
 */
export function bakeReef(reef: Reef): HTMLCanvasElement | null {
  // deviceMemory is Chromium-only; absent elsewhere, so treat unknown as "fine".
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const small = (memory !== undefined && memory <= 4) || Math.min(screen.width, screen.height) < 700;
  const scale = small ? 0.66 : 1;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(reef.width * scale);
    canvas.height = Math.round(reef.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(scale, scale);
    // The whole world is "in view" for the bake.
    drawReef(ctx, reef, 0, { left: -1e6, top: -1e6, right: 1e6, bottom: 1e6 });
    return canvas;
  } catch {
    // Out of memory on a very constrained device — the caller falls back to a
    // plain gradient, which costs nothing and still looks like water.
    return null;
  }
}

/** Just the water gradient, for when the bake could not be made. */
export function drawFallbackWater(ctx: CanvasRenderingContext2D, reef: Reef) {
  const water = ctx.createLinearGradient(0, 0, 0, reef.height);
  water.addColorStop(0, '#5ad0f0');
  water.addColorStop(0.35, '#2196c9');
  water.addColorStop(0.75, '#0d6398');
  water.addColorStop(1, '#0a4468');
  ctx.fillStyle = water;
  ctx.fillRect(0, 0, reef.width, reef.height);
}

/**
 * Draws the reef in world coordinates, painting from (0,0) to (width,height)
 * but only the parts inside `view`. Called once by the bake; the culling stays
 * because it also makes the bake itself quick when the view is the whole world.
 */
export function drawReef(ctx: CanvasRenderingContext2D, reef: Reef, time: number, view: ViewBounds) {
  const { width, height, floor } = reef;

  if (!reef.cache) {
    // Open water: bright at the surface, deep and cold at the bottom.
    const water = ctx.createLinearGradient(0, 0, 0, height);
    water.addColorStop(0, '#5ad0f0');
    water.addColorStop(0.35, '#2196c9');
    water.addColorStop(0.75, '#0d6398');
    water.addColorStop(1, '#0a4468');

    const sand = ctx.createLinearGradient(0, floor - 40, 0, height);
    sand.addColorStop(0, '#e3d3a1');
    sand.addColorStop(1, '#b99f68');

    const depth = ctx.createLinearGradient(0, height * 0.45, 0, height);
    depth.addColorStop(0, 'rgba(6, 50, 80, 0)');
    depth.addColorStop(1, 'rgba(6, 50, 80, 0.32)');

    reef.cache = { water, sand, depth };
  }

  const visible = (x: number, y: number, pad: number) =>
    x + pad >= view.left && x - pad <= view.right && y + pad >= view.top && y - pad <= view.bottom;

  ctx.fillStyle = reef.cache.water;
  ctx.fillRect(0, 0, width, height);

  // Sun shafts. Drawn before the rocks so they read as light in the water
  // rather than as something painted on top of the scenery.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const s of reef.shafts) {
    if (!visible(s.x + s.lean / 2, floor / 2, s.w * 2 + Math.abs(s.lean) + floor)) continue;
    const sway = Math.sin(time * 0.12 + s.phase) * 55;
    const grad = ctx.createLinearGradient(s.x, 0, s.x + s.lean, floor);
    grad.addColorStop(0, `rgba(190, 245, 255, ${s.alpha})`);
    grad.addColorStop(1, 'rgba(190, 245, 255, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(s.x - s.w / 2 + sway, -50);
    ctx.lineTo(s.x + s.w / 2 + sway, -50);
    ctx.lineTo(s.x + s.lean + s.w * 1.5 + sway, floor + 120);
    ctx.lineTo(s.x + s.lean - s.w * 1.5 + sway, floor + 120);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Two rock layers. The far one is washed out toward the water colour, which
  // is what sells depth underwater.
  ctx.fillStyle = '#14638f';
  for (const rock of reef.far) {
    if (!visible(rock.x + rock.w / 2, rock.y - rock.h / 2, rock.w / 2 + rock.h)) continue;
    rockPath(ctx, rock, height + 100);
    ctx.fill();
  }

  ctx.fillStyle = '#0f4d72';
  for (const rock of reef.near) {
    if (!visible(rock.x + rock.w / 2, rock.y - rock.h / 2, rock.w / 2 + rock.h)) continue;
    rockPath(ctx, rock, height + 100);
    ctx.fill();
  }

  // Seabed.
  ctx.fillStyle = reef.cache.sand;
  ctx.beginPath();
  ctx.moveTo(-100, height + 100);
  for (const [dx, dy] of reef.dunes) ctx.lineTo(dx, dy);
  ctx.lineTo(width + 100, height + 100);
  ctx.closePath();
  ctx.fill();

  // A darker lip along the dune line. Without it the sand meets the water on a
  // hard tan-on-blue edge that looks like two flat shapes rather than a seabed.
  ctx.strokeStyle = 'rgba(120, 100, 62, 0.45)';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(reef.dunes[0][0], reef.dunes[0][1]);
  for (const [dx, dy] of reef.dunes) ctx.lineTo(dx, dy);
  ctx.stroke();

  // Sand ripples, then stones. Both are flat washes over the seabed gradient;
  // without them the floor is a single colour and reads as a painted backdrop.
  ctx.save();
  ctx.strokeStyle = 'rgba(150, 126, 78, 0.28)';
  ctx.lineWidth = 5;
  for (let i = 0; i < 34; i++) {
    const y = floor + 60 + i * ((height - floor) / 34);
    if (y < view.top - 60 || y > view.bottom + 60) continue;
    ctx.beginPath();
    ctx.moveTo(-100, y);
    for (let x = -100; x <= width + 100; x += 160) {
      ctx.lineTo(x, y + Math.sin(x * 0.004 + i) * 9);
    }
    ctx.stroke();
  }
  ctx.restore();

  for (const p of reef.pebbles) {
    if (!visible(p.x, p.y, p.rx * 2)) continue;
    ctx.fillStyle = p.tone < 0.5 ? 'rgba(120, 100, 62, 0.5)' : 'rgba(240, 228, 190, 0.45)';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, p.rx, p.ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Weeds sway together, offset by phase so it looks like a current and not a
  // single animation played 150 times. The bake freezes them at t=0, but each
  // one keeps its own phase, so they still lean at different angles.
  ctx.lineCap = 'round';
  const drawWeeds = (back: boolean) => {
    for (const w of reef.weeds) {
      if (w.back !== back) continue;
      if (!visible(w.x, w.y - w.h / 2, w.h)) continue;
      const sway = Math.sin(time * 0.8 + w.phase) * 22;
      ctx.strokeStyle = back ? `hsl(${w.hue}, 42%, 26%)` : `hsl(${w.hue}, 55%, 34%)`;
      ctx.lineWidth = w.thick;
      ctx.beginPath();
      ctx.moveTo(w.x, w.y);
      ctx.quadraticCurveTo(w.x + w.lean * 0.4 + sway * 0.5, w.y - w.h * 0.55, w.x + w.lean + sway, w.y - w.h);
      ctx.stroke();
    }
  };
  drawWeeds(true);
  drawWeeds(false);

  for (const c of reef.corals) {
    if (!visible(c.x, c.y, c.r * 2)) continue;
    ctx.fillStyle = c.color;
    for (let i = 0; i < c.arms; i++) {
      const spread = (i / (c.arms - 1) - 0.5) * 1.5;
      const wobble = Math.sin(time * 0.6 + c.phase + i) * 5;
      const tipX = c.x + spread * c.r * 1.1 + wobble;
      const tipY = c.y - c.r * (0.75 + Math.cos(spread) * 0.4);
      ctx.beginPath();
      ctx.moveTo(c.x - 7, c.y + 6);
      ctx.quadraticCurveTo(c.x + spread * c.r * 0.5, c.y - c.r * 0.5, tipX, tipY);
      ctx.quadraticCurveTo(c.x + spread * c.r * 0.5 + 9, c.y - c.r * 0.45, c.x + 7, c.y + 6);
      ctx.closePath();
      ctx.fill();
    }
  }

  // A cool wash over the lower half, so depth reads even where rocks don't cover.
  ctx.fillStyle = reef.cache.depth;
  ctx.fillRect(0, height * 0.45, width, height * 0.55);
}
