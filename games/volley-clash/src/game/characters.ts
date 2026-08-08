/**
 * The roster.
 *
 * Nothing here is a downloaded image. Every character is a handful of numbers
 * and a `draw` case — eight of them cost about four kilobytes, where eight
 * sprite sheets cost megabytes. Fish Eat Fish shipped 11.6 MB of PNGs before
 * anyone noticed; this is that lesson applied up front.
 *
 * The stats are the point of the roster, and they are constrained: every
 * character's three stats add up to exactly 3.00, and none is outside
 * 0.80–1.20. That guarantees the paid characters are *different*, not better,
 * which is the only version of a shop that is fair in a competitive game.
 */

export type Accessory = 'none' | 'band' | 'cap' | 'visor' | 'horns' | 'crown' | 'shades' | 'bolt';

export interface Character {
  name: string;
  /** Multiplies run speed and jump height and hit power respectively. */
  speed: number;
  jump: number;
  power: number;
  price: number;
  body: string;
  trim: string;
  accessory: Accessory;
  blurb: string;
}

export const CHARACTERS: Character[] = [
  {
    name: 'Rookie',
    speed: 1.0, jump: 1.0, power: 1.0, price: 0,
    body: '#f8fafc', trim: '#94a3b8', accessory: 'none',
    blurb: 'No weaknesses, no tricks. Learn the game on this one.',
  },
  {
    name: 'Sprint',
    speed: 1.2, jump: 0.95, power: 0.85, price: 0,
    body: '#facc15', trim: '#a16207', accessory: 'band',
    blurb: 'Covers the whole court. Hits like a polite suggestion.',
  },
  {
    name: 'Hops',
    speed: 0.9, jump: 1.2, power: 0.9, price: 0,
    body: '#4ade80', trim: '#15803d', accessory: 'cap',
    blurb: 'Lives above the net. Getting there is the slow part.',
  },
  {
    name: 'Hammer',
    speed: 0.85, jump: 0.95, power: 1.2, price: 400,
    body: '#f43f5e', trim: '#881337', accessory: 'horns',
    blurb: 'One clean spike ends the rally. Getting to the ball does not.',
  },
  {
    name: 'Comet',
    speed: 1.15, jump: 1.05, power: 0.8, price: 600,
    body: '#38bdf8', trim: '#075985', accessory: 'bolt',
    blurb: 'Fast and springy. You will win on retrieval, not on force.',
  },
  {
    name: 'Tower',
    speed: 0.85, jump: 1.15, power: 1.0, price: 800,
    body: '#c084fc', trim: '#6b21a8', accessory: 'visor',
    blurb: 'A wall at the net. Do not ask it to chase a drop shot.',
  },
  {
    name: 'Gale',
    speed: 1.1, jump: 0.9, power: 1.0, price: 1100,
    body: '#2dd4bf', trim: '#0f766e', accessory: 'shades',
    blurb: 'Ground game. Dash in, dash out, never leave the sand.',
  },
  {
    name: 'Titan',
    speed: 0.9, jump: 0.9, power: 1.2, price: 1500,
    body: '#fb923c', trim: '#7c2d12', accessory: 'crown',
    blurb: 'Slow, heavy, and the hardest hit in the game.',
  },
];

export const FREE_CHARACTERS = CHARACTERS.map((c, i) => (c.price === 0 ? i : -1)).filter((i) => i >= 0);

/**
 * Draws a character at world scale.
 *
 * Everything is relative to `r`, so the Giant power-up works by changing one
 * number rather than by swapping to a bigger sprite.
 */
export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  x: number,
  y: number,
  r: number,
  facing: 1 | -1,
  /** 0–1. Rings the body and tints the trim. */
  charge: number,
  teamColor: string,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing, 1);

  // Charge ring. Drawn under the body so it reads as an aura, not a hat.
  if (charge > 0.02) {
    ctx.beginPath();
    ctx.arc(0, 0, r * (1.15 + charge * 0.25), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 220, 120, ${0.25 + charge * 0.55})`;
    ctx.lineWidth = 3 + charge * 7;
    ctx.stroke();
  }

  // Team ring: in 2v2 you must be able to tell sides apart at a glance, and
  // the character colours alone cannot carry that.
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.04, 0, Math.PI * 2);
  ctx.fillStyle = teamColor;
  ctx.fill();

  // Body: a dome, because a full circle bounces around like a beach ball and
  // reads as an object rather than a player.
  ctx.beginPath();
  ctx.arc(0, 0, r, Math.PI, 0);
  ctx.lineTo(r, r * 0.55);
  ctx.quadraticCurveTo(0, r * 0.95, -r, r * 0.55);
  ctx.closePath();
  ctx.fillStyle = ch.body;
  ctx.fill();
  ctx.strokeStyle = ch.trim;
  ctx.lineWidth = Math.max(2, r * 0.07);
  ctx.stroke();

  // Eye. One is plenty at this size and it makes the facing obvious.
  ctx.beginPath();
  ctx.arc(r * 0.34, -r * 0.22, r * 0.17, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(r * 0.4, -r * 0.22, r * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = '#0f172a';
  ctx.fill();

  drawAccessory(ctx, ch, r);
  ctx.restore();
}

function drawAccessory(ctx: CanvasRenderingContext2D, ch: Character, r: number) {
  ctx.fillStyle = ch.trim;
  ctx.strokeStyle = ch.trim;
  ctx.lineWidth = Math.max(2, r * 0.08);

  switch (ch.accessory) {
    case 'band':
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.92, Math.PI * 1.12, Math.PI * 1.88);
      ctx.lineWidth = r * 0.2;
      ctx.stroke();
      break;
    case 'cap':
      ctx.beginPath();
      ctx.arc(0, -r * 0.1, r * 0.78, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(r * 0.1, -r * 0.16, r * 0.95, r * 0.14);
      break;
    case 'visor':
      ctx.beginPath();
      ctx.ellipse(r * 0.1, -r * 0.3, r * 0.95, r * 0.3, -0.1, Math.PI, 0);
      ctx.fill();
      break;
    case 'horns':
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * r * 0.5, -r * 0.72);
        ctx.quadraticCurveTo(s * r * 0.85, -r * 1.35, s * r * 0.35, -r * 1.25);
        ctx.quadraticCurveTo(s * r * 0.5, -r * 0.95, s * r * 0.5, -r * 0.72);
        ctx.fill();
      }
      break;
    case 'crown':
      ctx.beginPath();
      ctx.moveTo(-r * 0.6, -r * 0.72);
      ctx.lineTo(-r * 0.45, -r * 1.25);
      ctx.lineTo(-r * 0.15, -r * 0.92);
      ctx.lineTo(r * 0.15, -r * 1.3);
      ctx.lineTo(r * 0.45, -r * 0.92);
      ctx.lineTo(r * 0.6, -r * 1.25);
      ctx.lineTo(r * 0.7, -r * 0.7);
      ctx.closePath();
      ctx.fillStyle = '#fbbf24';
      ctx.fill();
      break;
    case 'shades':
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(-r * 0.15, -r * 0.38, r * 0.95, r * 0.26);
      break;
    case 'bolt':
      ctx.beginPath();
      ctx.moveTo(-r * 0.1, -r * 0.75);
      ctx.lineTo(r * 0.35, -r * 1.3);
      ctx.lineTo(r * 0.12, -r * 1.05);
      ctx.lineTo(r * 0.5, -r * 1.5);
      ctx.lineTo(-r * 0.05, -r * 1.0);
      ctx.lineTo(r * 0.18, -r * 1.05);
      ctx.closePath();
      ctx.fillStyle = '#fde047';
      ctx.fill();
      break;
    case 'none':
      break;
  }
}
