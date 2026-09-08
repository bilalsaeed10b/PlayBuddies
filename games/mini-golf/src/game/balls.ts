/**
 * The eight balls, drawn in code.
 *
 * A golf ball on a top-down green is about eight pixels across, so none of
 * these can be detailed and none of them try to be: a skin is a pattern you
 * can still read at that size, and the seat's colour always shows as the ring
 * around it. Buying one can never take away the thing the green has to say,
 * which is whose ball that is.
 */

export interface BallSkin {
  name: string;
  price: number;
  blurb: string;
}

export const BALLS: readonly BallSkin[] = [
  { name: 'Range', price: 0, blurb: 'Plain white and slightly scuffed.' },
  { name: 'Dimple', price: 0, blurb: 'The classic, pockmarked all over.' },
  { name: 'Stripe', price: 0, blurb: 'One bold alignment band.' },
  { name: 'Sunburst', price: 110, blurb: 'Hard to lose in the rough.' },
  { name: 'Quarters', price: 140, blurb: 'Four panels, two colours.' },
  { name: 'Bullseye', price: 170, blurb: 'A target, in case you forget.' },
  { name: 'Comet', price: 210, blurb: 'Reads as motion even sitting still.' },
  { name: 'Onyx', price: 250, blurb: 'Matte black. Purely for the swagger.' },
];

/** Everything a player owns before spending a coin. */
export const FREE_BALLS = [0, 1, 2];

export interface BallPaint {
  skin: number;
  x: number;
  y: number;
  /** Screen radius. */
  r: number;
  /** The seat's colour, drawn as the ring. */
  ring: string;
  /** 0-1. Lifts the ball and sharpens its shadow while it is the one to play. */
  active?: number;
}

/**
 * The body colour of each skin. Everything else is drawn over it.
 *
 * Onyx is the only one that is not basically white, which is why the ring has
 * a light inner edge — without it a black ball on a dark green loses its
 * outline entirely.
 */
const BODY: Record<number, [string, string]> = {
  0: ['#ffffff', '#d9dee5'],
  1: ['#fdfdfd', '#d2d8e0'],
  2: ['#ffffff', '#dbe1e8'],
  3: ['#fff7d6', '#f5d98a'],
  4: ['#ffffff', '#cfd6df'],
  5: ['#ffffff', '#d5dbe3'],
  6: ['#e8f4ff', '#b9d4ee'],
  7: ['#2c2f36', '#15171b'],
};

export function drawBall(ctx: CanvasRenderingContext2D, p: BallPaint) {
  const r = p.r;
  const lift = p.active ?? 0;
  const [bright, shade] = BODY[p.skin] ?? BODY[0];

  ctx.save();

  // Contact shadow. Offset a little down-right so every ball on the green
  // agrees about where the sun is.
  ctx.globalAlpha = 0.3 + lift * 0.12;
  ctx.fillStyle = '#0d2415';
  ctx.beginPath();
  ctx.ellipse(p.x + r * 0.28, p.y + r * 0.4, r * 1.02, r * 0.82, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // The seat ring, which is the only part that is not cosmetic.
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 1.28, 0, Math.PI * 2);
  ctx.fillStyle = p.ring;
  ctx.fill();

  const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.1, p.x, p.y, r);
  g.addColorStop(0, bright);
  g.addColorStop(1, shade);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();

  // Anything finer than this is mud on the screen at real play size.
  if (r > 3.2) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.clip();

    switch (p.skin) {
      case 1: {
        ctx.fillStyle = 'rgba(120,132,148,0.5)';
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(p.x + Math.cos(a) * r * 0.5, p.y + Math.sin(a) * r * 0.5, r * 0.17, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 2: {
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(p.x - r, p.y - r * 0.22, r * 2, r * 0.44);
        break;
      }
      case 3: {
        ctx.fillStyle = '#f59e0b';
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.arc(p.x, p.y, r, a, a + Math.PI / 8);
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case 4: {
        ctx.fillStyle = '#0ea5e9';
        ctx.fillRect(p.x - r, p.y - r, r, r);
        ctx.fillRect(p.x, p.y, r, r);
        break;
      }
      case 5: {
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = r * 0.26;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#dc2626';
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 6: {
        ctx.fillStyle = 'rgba(56,132,255,0.65)';
        ctx.beginPath();
        ctx.moveTo(p.x - r, p.y - r * 0.5);
        ctx.lineTo(p.x + r, p.y - r * 0.1);
        ctx.lineTo(p.x - r, p.y + r * 0.35);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 7: {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = r * 0.16;
        ctx.beginPath();
        ctx.arc(p.x - r * 0.2, p.y - r * 0.2, r * 0.7, 0.6, 2.4);
        ctx.stroke();
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }

  // Specular pip. Sells "sphere" harder than any of the patterns above.
  ctx.globalAlpha = p.skin === 7 ? 0.5 : 0.85;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(p.x - r * 0.34, p.y - r * 0.36, r * 0.28, r * 0.2, -0.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}
