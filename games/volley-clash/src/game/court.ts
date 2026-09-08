/**
 * The court, baked once.
 *
 * The sky, the sea, the crowd, the sand and the net never change during a
 * match, so they are painted into an offscreen canvas at start-up and blitted
 * with a single `drawImage` every frame. Fish Eat Fish learned this the
 * expensive way: a per-frame vector background is where the frame budget goes,
 * and none of it is animation anybody looks at.
 *
 * Only the ball, the players, the particles and the HUD are drawn live.
 */
import { Arena } from './rules';

/** Deterministic, so both players in a room see the same crowd. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CROWD = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#c084fc', '#fb7185', '#fdba74'];

export function bakeCourt(arena: Arena): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = arena.w;
    canvas.height = arena.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    paint(ctx, arena);
    return canvas;
  } catch {
    // A device that cannot spare a ~4 MB canvas still gets a playable game.
    return null;
  }
}

/** Sky and sand only, for when the bake could not be made. */
export function drawFallbackCourt(ctx: CanvasRenderingContext2D, arena: Arena) {
  const sky = ctx.createLinearGradient(0, 0, 0, arena.floor);
  sky.addColorStop(0, '#0c4a6e');
  sky.addColorStop(1, '#7dd3fc');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, arena.w, arena.floor);
  ctx.fillStyle = '#e9c893';
  ctx.fillRect(0, arena.floor, arena.w, arena.h - arena.floor);
  drawNet(ctx, arena);
}

function paint(ctx: CanvasRenderingContext2D, arena: Arena) {
  const rnd = mulberry32(0x0117ba11);
  const { w, h, floor } = arena;

  // ── sky ──────────────────────────────────────────────────────────────────
  const sky = ctx.createLinearGradient(0, 0, 0, floor);
  sky.addColorStop(0, '#0b3f75');
  sky.addColorStop(0.4, '#2f8fd0');
  sky.addColorStop(0.78, '#7fd0f0');
  sky.addColorStop(1, '#ffd9a0');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, floor);

  // Low sun behind the stands, with a soft bloom.
  const sunX = w * 0.74;
  const sunY = floor * 0.52;
  const bloom = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, floor * 0.55);
  bloom.addColorStop(0, 'rgba(255, 236, 170, 0.85)');
  bloom.addColorStop(0.35, 'rgba(255, 206, 130, 0.28)');
  bloom.addColorStop(1, 'rgba(255, 200, 120, 0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, w, floor);
  ctx.beginPath();
  ctx.arc(sunX, sunY, floor * 0.09, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 247, 214, 0.95)';
  ctx.fill();

  // ── headland ─────────────────────────────────────────────────────────────
  const seaY = floor * 0.62;
  ctx.fillStyle = 'rgba(16, 62, 92, 0.55)';
  ctx.beginPath();
  ctx.moveTo(-40, seaY + 12);
  for (let x = -40; x <= w + 40; x += 90) {
    ctx.lineTo(x, seaY - 30 - Math.sin(x * 0.0022) * 46 - Math.sin(x * 0.0009) * 28);
  }
  ctx.lineTo(w + 40, seaY + 20);
  ctx.closePath();
  ctx.fill();

  // ── sea ──────────────────────────────────────────────────────────────────
  const sea = ctx.createLinearGradient(0, seaY, 0, floor);
  sea.addColorStop(0, '#0e6ba8');
  sea.addColorStop(1, '#28a8d8');
  ctx.fillStyle = sea;
  ctx.fillRect(0, seaY, w, floor - seaY);

  // Glitter on the water, brightest under the sun.
  for (let i = 0; i < 260; i++) {
    const x = rnd() * w;
    const y = seaY + rnd() * (floor - seaY);
    const near = 1 - Math.min(1, Math.abs(x - sunX) / (w * 0.45));
    ctx.fillStyle = `rgba(255, 255, 255, ${0.05 + near * 0.3 * rnd()})`;
    ctx.fillRect(x, y, 6 + rnd() * 22, 1.5);
  }

  // ── stands ───────────────────────────────────────────────────────────────
  // Two shallow banks either side of the court, well above the play area so
  // they never compete with the ball for attention.
  const standTop = seaY - 96;
  const standBottom = seaY + 26;
  for (const side of [0, 1]) {
    const x0 = side === 0 ? -20 : w * 0.56;
    const x1 = side === 0 ? w * 0.44 : w + 20;

    ctx.fillStyle = 'rgba(14, 40, 62, 0.72)';
    ctx.beginPath();
    ctx.moveTo(x0, standBottom);
    ctx.lineTo(x0 + (side === 0 ? 0 : 70), standTop);
    ctx.lineTo(x1 - (side === 0 ? 70 : 0), standTop);
    ctx.lineTo(x1, standBottom);
    ctx.closePath();
    ctx.fill();

    // The crowd: dots on four rows. At this size a dot is a person.
    for (let row = 0; row < 4; row++) {
      const y = standTop + 16 + row * 22;
      const inset = 60 - row * 12;
      for (let x = x0 + inset; x < x1 - inset; x += 15 + rnd() * 7) {
        if (rnd() < 0.12) continue;
        ctx.fillStyle = CROWD[Math.floor(rnd() * CROWD.length)];
        ctx.globalAlpha = 0.55 + rnd() * 0.35;
        ctx.beginPath();
        ctx.arc(x, y, 4.5 + rnd() * 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ── sand ─────────────────────────────────────────────────────────────────
  const sand = ctx.createLinearGradient(0, floor - 10, 0, h);
  sand.addColorStop(0, '#f5dcae');
  sand.addColorStop(0.35, '#e7c489');
  sand.addColorStop(1, '#c9a068');
  ctx.fillStyle = sand;
  ctx.fillRect(0, floor, w, h - floor);

  // Wet line where the sand meets the water, so the two do not just abut.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.fillRect(0, floor - 3, w, 4);
  ctx.fillStyle = 'rgba(150, 110, 60, 0.25)';
  ctx.fillRect(0, floor + 3, w, 3);

  // Grain: cheap, one-time, and the difference between sand and a brown box.
  for (let i = 0; i < 2400; i++) {
    const x = rnd() * w;
    const y = floor + rnd() * (h - floor);
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(255, 246, 214, 0.5)' : 'rgba(150, 112, 62, 0.28)';
    ctx.fillRect(x, y, 2 + rnd() * 3, 2);
  }

  // Court boundary, drawn as tape lying on the sand.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = 5;
  const pad = 46;
  ctx.strokeRect(pad, floor + 14, w - pad * 2, h - floor - 30);

  drawNet(ctx, arena);
}

/**
 * The net. Exported because the fallback path needs it too — a court without a
 * visible net is unplayable even if the collision is still there.
 */
function drawNet(ctx: CanvasRenderingContext2D, arena: Arena) {
  const { netX, netW, netTop, floor } = arena;
  const left = netX - netW / 2;

  // Post shadow on the sand, so the net is planted rather than floating.
  ctx.fillStyle = 'rgba(90, 60, 30, 0.28)';
  ctx.beginPath();
  ctx.ellipse(netX, floor + 8, netW * 2.6, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  // Post.
  const post = ctx.createLinearGradient(left, 0, left + netW, 0);
  post.addColorStop(0, '#e2e8f0');
  post.addColorStop(0.45, '#ffffff');
  post.addColorStop(1, '#94a3b8');
  ctx.fillStyle = post;
  ctx.fillRect(left, netTop, netW, floor - netTop);

  // Mesh. Diagonals rather than a grid — it reads as fabric at a glance and is
  // half the strokes.
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, netTop + 14, netW, floor - netTop - 14);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1.5;
  for (let y = netTop; y < floor + netW; y += 9) {
    ctx.beginPath();
    ctx.moveTo(left - 2, y);
    ctx.lineTo(left + netW + 2, y - netW);
    ctx.stroke();
  }
  ctx.restore();

  // Tape along the top: the thing players actually aim over.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(left - 3, netTop, netW + 6, 14);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(left - 3, netTop + 11, netW + 6, 3);
}
