/**
 * The eight pawns, drawn in code.
 *
 * Every one of them is painted in its seat's colour rather than its own, so
 * the shop can never take the one thing the board has to communicate at a
 * glance — whose pawn that is — and trade it for a nicer silhouette. What a
 * skin changes is the shape, and only the shape.
 */

export interface PawnSkin {
  name: string;
  price: number;
  blurb: string;
}

export const PAWNS: readonly PawnSkin[] = [
  { name: 'Pebble', price: 0, blurb: 'A smooth river stone. Gets there first anyway.' },
  { name: 'Cap', price: 0, blurb: 'A domed head with a brim. Sensible.' },
  { name: 'Pillar', price: 0, blurb: 'A little column with a collar.' },
  { name: 'Crown', price: 120, blurb: 'Three points, worn without irony.' },
  { name: 'Lantern', price: 150, blurb: 'Carries its own light down the corridor.' },
  { name: 'Fox', price: 180, blurb: 'Two ears up, listening for walls.' },
  { name: 'Obelisk', price: 220, blurb: 'A faceted spike. Casts a long shadow.' },
  { name: 'Orb', price: 260, blurb: 'Hovers a fraction above the square.' },
];

/** Everything a player owns before spending a coin. */
export const FREE_PAWNS = [0, 1, 2];

export interface PawnPaint {
  skin: number;
  x: number;
  /** The centre of the square. The pawn sits on it, drawing upward. */
  y: number;
  /** Half the square, roughly — every shape scales off this. */
  r: number;
  main: string;
  light: string;
  dark: string;
  /** 0-1. Lifts the piece and deepens its shadow while it is the active pawn. */
  lift?: number;
  /** 0-1. A ring of the seat colour, for "it is your turn". */
  glow?: number;
}

/** A soft contact shadow, so a pawn sits on the board instead of over it. */
function shadow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, lift: number) {
  ctx.save();
  ctx.globalAlpha = 0.28 - lift * 0.08;
  ctx.fillStyle = '#3f2d1a';
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.72, r * (0.78 + lift * 0.18), r * (0.26 + lift * 0.06), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function body(ctx: CanvasRenderingContext2D, p: PawnPaint, cy: number, r: number) {
  const g = ctx.createLinearGradient(p.x - r, cy - r, p.x + r * 0.4, cy + r);
  g.addColorStop(0, p.light);
  g.addColorStop(0.55, p.main);
  g.addColorStop(1, p.dark);
  ctx.fillStyle = g;
}

/** A highlight on the upper left, which is what stops a flat disc reading flat. */
function sheen(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(x - r * 0.28, y - r * 0.34, r * 0.3, r * 0.19, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawPawn(ctx: CanvasRenderingContext2D, p: PawnPaint) {
  const lift = p.lift ?? 0;
  const r = p.r;
  const cy = p.y - lift * r * 0.22;

  if (p.glow) {
    ctx.save();
    ctx.globalAlpha = 0.32 * p.glow;
    ctx.strokeStyle = p.light;
    ctx.lineWidth = r * 0.22;
    ctx.beginPath();
    ctx.arc(p.x, p.y + r * 0.06, r * 1.02, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  shadow(ctx, p.x, p.y, r, lift);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(28,18,8,0.45)';
  ctx.lineWidth = Math.max(1, r * 0.08);

  switch (p.skin) {
    case 1: {
      // Cap — a dome with a brim.
      body(ctx, p, cy, r);
      ctx.beginPath();
      ctx.ellipse(p.x, cy + r * 0.32, r * 0.92, r * 0.24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, cy + r * 0.1, r * 0.66, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      sheen(ctx, p.x, cy - r * 0.1, r);
      break;
    }
    case 2: {
      // Pillar — a tapered column with a collar.
      body(ctx, p, cy, r);
      ctx.beginPath();
      ctx.moveTo(p.x - r * 0.52, cy + r * 0.6);
      ctx.lineTo(p.x - r * 0.34, cy - r * 0.62);
      ctx.lineTo(p.x + r * 0.34, cy - r * 0.62);
      ctx.lineTo(p.x + r * 0.52, cy + r * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(p.x, cy - r * 0.6, r * 0.46, r * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 3: {
      // Crown — a disc under three points.
      body(ctx, p, cy, r);
      ctx.beginPath();
      ctx.arc(p.x, cy + r * 0.14, r * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - r * 0.66, cy - r * 0.1);
      ctx.lineTo(p.x - r * 0.5, cy - r * 0.8);
      ctx.lineTo(p.x - r * 0.18, cy - r * 0.36);
      ctx.lineTo(p.x, cy - r * 0.95);
      ctx.lineTo(p.x + r * 0.18, cy - r * 0.36);
      ctx.lineTo(p.x + r * 0.5, cy - r * 0.8);
      ctx.lineTo(p.x + r * 0.66, cy - r * 0.1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      sheen(ctx, p.x, cy + r * 0.1, r);
      break;
    }
    case 4: {
      // Lantern — a dome with a lit core.
      body(ctx, p, cy, r);
      ctx.beginPath();
      ctx.roundRect(p.x - r * 0.56, cy - r * 0.72, r * 1.12, r * 1.42, r * 0.34);
      ctx.fill();
      ctx.stroke();
      ctx.save();
      ctx.globalAlpha = 0.9;
      const core = ctx.createRadialGradient(p.x, cy, 0, p.x, cy, r * 0.5);
      core.addColorStop(0, '#fffbe8');
      core.addColorStop(1, 'rgba(255,251,232,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(p.x, cy, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 5: {
      // Fox — a rounded body and two ears.
      body(ctx, p, cy, r);
      ctx.beginPath();
      ctx.moveTo(p.x - r * 0.62, cy - r * 0.18);
      ctx.lineTo(p.x - r * 0.44, cy - r * 0.96);
      ctx.lineTo(p.x - r * 0.08, cy - r * 0.44);
      ctx.closePath();
      ctx.moveTo(p.x + r * 0.62, cy - r * 0.18);
      ctx.lineTo(p.x + r * 0.44, cy - r * 0.96);
      ctx.lineTo(p.x + r * 0.08, cy - r * 0.44);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, cy + r * 0.06, r * 0.74, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      sheen(ctx, p.x, cy, r);
      break;
    }
    case 6: {
      // Obelisk — a faceted spike, with the near face lighter.
      ctx.fillStyle = p.dark;
      ctx.beginPath();
      ctx.moveTo(p.x, cy - r * 1.05);
      ctx.lineTo(p.x + r * 0.52, cy + r * 0.62);
      ctx.lineTo(p.x - r * 0.52, cy + r * 0.62);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = p.main;
      ctx.beginPath();
      ctx.moveTo(p.x, cy - r * 1.05);
      ctx.lineTo(p.x, cy + r * 0.62);
      ctx.lineTo(p.x - r * 0.52, cy + r * 0.62);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 7: {
      // Orb — a sphere sitting above its own ring.
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = p.dark;
      ctx.lineWidth = r * 0.14;
      ctx.beginPath();
      ctx.ellipse(p.x, cy + r * 0.62, r * 0.62, r * 0.2, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      body(ctx, p, cy - r * 0.2, r);
      ctx.beginPath();
      ctx.arc(p.x, cy - r * 0.16, r * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      sheen(ctx, p.x, cy - r * 0.2, r);
      break;
    }
    default: {
      // Pebble — a plain domed disc.
      body(ctx, p, cy, r);
      ctx.beginPath();
      ctx.arc(p.x, cy, r * 0.78, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      sheen(ctx, p.x, cy, r);
    }
  }

  ctx.restore();
}
