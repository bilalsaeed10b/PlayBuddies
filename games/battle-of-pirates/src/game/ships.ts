/**
 * The ships: eight hulls, three free, the rest bought with the coins the rest
 * of PlayBuddies pays out.
 *
 * They are skins and nothing else. Not one of them fires further, turns faster
 * or takes less damage, and none ever will: this is a game two people play
 * against each other, and a shop that sells an advantage in a head-to-head
 * game is worse than no shop at all. Volley Clash learned that the long way
 * round and the same rule applies here.
 *
 * Each hull is baked into an offscreen sprite the first time it is asked for
 * and blitted afterwards. A galleon is thirty-odd paths, and painting thirty
 * paths twice a frame is exactly the kind of thing that turns a cheap phone
 * into a slideshow. Only the cannon barrel and the flag are drawn live,
 * because only they move.
 */
import { BALANCE, clamp } from './rules';

export interface ShipSkin {
  name: string;
  blurb: string;
  price: number;
  hull: string;
  hullDark: string;
  trim: string;
  deck: string;
  sail: string;
  sailShade: string;
  flag: string;
  /** Drawn on the sail. Kept to a handful of primitives so it bakes cheaply. */
  emblem: 'skull' | 'cross' | 'moon' | 'star' | 'anchor' | 'none';
}

export const SHIPS: ShipSkin[] = [
  {
    name: 'Salt Dog', blurb: 'Every captain starts here.', price: 0,
    hull: '#8b5a2b', hullDark: '#5c3a1a', trim: '#d9a441', deck: '#c89b62',
    sail: '#f2e8d5', sailShade: '#d9cbb0', flag: '#e0453c', emblem: 'none',
  },
  {
    name: 'Reef Runner', blurb: 'Shallow keel, quick on the eye.', price: 0,
    hull: '#2f6f6a', hullDark: '#1d4642', trim: '#8fd6c8', deck: '#a9c9bf',
    sail: '#eafaf5', sailShade: '#c2ded6', flag: '#14b8a6', emblem: 'star',
  },
  {
    name: 'Old Barnacle', blurb: 'Held together by paint and spite.', price: 0,
    hull: '#5b6462', hullDark: '#373d3c', trim: '#9aa6a3', deck: '#8b8f86',
    sail: '#ddd9cb', sailShade: '#b6b2a4', flag: '#94a3b8', emblem: 'anchor',
  },
  {
    name: 'Crimson Corsair', blurb: 'Painted the colour of a bad morning.', price: 320,
    hull: '#a52a2a', hullDark: '#6b1717', trim: '#f2b544', deck: '#d59a5f',
    sail: '#ffe9e2', sailShade: '#e6bfb4', flag: '#f97316', emblem: 'cross',
  },
  {
    name: 'Black Kraken', blurb: 'Something below the waterline is watching.', price: 480,
    hull: '#232733', hullDark: '#0f1218', trim: '#7c3aed', deck: '#3b4152',
    sail: '#2c3040', sailShade: '#191c26', flag: '#a78bfa', emblem: 'skull',
  },
  {
    name: 'Golden Doubloon', blurb: 'Sails low in the water. Wonder why.', price: 650,
    hull: '#8a6510', hullDark: '#5a4109', trim: '#fbbf24', deck: '#e0b357',
    sail: '#fff4cf', sailShade: '#e4cf95', flag: '#fbbf24', emblem: 'star',
  },
  {
    name: 'Frost Galleon', blurb: 'Rigging still rimed from the far south.', price: 800,
    hull: '#3f5f7a', hullDark: '#243a4d', trim: '#bae6fd', deck: '#93b4c9',
    sail: '#f0fbff', sailShade: '#c7e4f2', flag: '#38bdf8', emblem: 'moon',
  },
  {
    name: 'Ghost of the Deep', blurb: 'Nobody has seen her crew. Nobody wants to.', price: 1100,
    hull: '#2b4a45', hullDark: '#152b28', trim: '#6ee7b7', deck: '#4a6f68',
    sail: '#d6fff2', sailShade: '#9fd8c6', flag: '#34d399', emblem: 'skull',
  },
];

export const FREE_SHIPS = SHIPS.reduce<number[]>((free, ship, i) => {
  if (ship.price === 0) free.push(i);
  return free;
}, []);

/** Sprite geometry. The origin is the point where the hull meets the water. */
const SPR = { w: 320, h: 340, ox: 160, oy: 268 };

const cache = new Map<string, HTMLCanvasElement>();

/**
 * A baked hull, facing right, in world units.
 *
 * Returns null when the canvas could not be made. A device short enough on
 * memory to refuse one still gets a playable game through the live path.
 */
function sprite(skinIndex: number, accent: string): HTMLCanvasElement | null {
  const key = `${skinIndex}|${accent}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SPR.w;
    canvas.height = SPR.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.translate(SPR.ox, SPR.oy);
    paintHull(ctx, SHIPS[clamp(skinIndex, 0, SHIPS.length - 1)], accent);
    cache.set(key, canvas);
    return canvas;
  } catch {
    return null;
  }
}

export interface ShipDraw {
  skin: number;
  /** Hull centre and the waterline it is sitting on, in world coordinates. */
  x: number;
  y: number;
  /** 1 faces right, -1 faces left. */
  facing: 1 | -1;
  /** Team colour, painted into the stripe and the pennant. */
  accent: string;
  /** Barrel direction in world radians, or null to leave it level. */
  aim: number | null;
  /** Hull roll: recoil, swell, and the list of a ship that is losing. */
  lean: number;
  /** 0 to 1, fading. Whites out the hull on the frame it is struck. */
  flash: number;
  /** Drives the flag flutter. Any monotonic clock will do. */
  clock: number;
  scale?: number;
}

export function drawShip(ctx: CanvasRenderingContext2D, d: ShipDraw) {
  const skin = SHIPS[clamp(d.skin, 0, SHIPS.length - 1)];
  const s = d.scale ?? 1;
  ctx.save();
  ctx.translate(d.x, d.y);
  if (s !== 1) ctx.scale(s, s);
  ctx.rotate(d.lean);

  const baked = sprite(d.skin, d.accent);
  ctx.save();
  if (d.facing < 0) ctx.scale(-1, 1);
  if (baked) ctx.drawImage(baked, -SPR.ox, -SPR.oy);
  else paintHull(ctx, skin, d.accent);
  drawFlag(ctx, skin, d.clock);
  ctx.restore();

  // The barrel is drawn unmirrored so a world-space aim angle can be handed
  // straight to rotate() without the caller having to know which way the hull
  // is pointing.
  drawCannon(ctx, d);

  if (d.flash > 0) {
    ctx.globalAlpha = Math.min(0.75, d.flash);
    ctx.fillStyle = '#fff';
    hullPath(ctx, d.facing);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/** Hull outline on its own, reused for the damage flash. */
function hullPath(ctx: CanvasRenderingContext2D, facing: 1 | -1) {
  const halfW = BALANCE.HULL_W / 2;
  const top = -44;
  const keel = 26;
  ctx.beginPath();
  ctx.moveTo(-halfW * facing, top);
  ctx.lineTo(halfW * facing, top);
  ctx.quadraticCurveTo(halfW * 1.12 * facing, top + 34, halfW * 0.66 * facing, keel);
  ctx.lineTo(-halfW * 0.72 * facing, keel);
  ctx.quadraticCurveTo(-halfW * 1.06 * facing, top + 36, -halfW * facing, top);
  ctx.closePath();
}

function drawCannon(ctx: CanvasRenderingContext2D, d: ShipDraw) {
  ctx.save();
  ctx.translate(d.facing * BALANCE.MUZZLE_X, BALANCE.MUZZLE_Y);

  // Carriage. Sits square on the deck whichever way the barrel points.
  ctx.fillStyle = '#3f2d1c';
  ctx.fillRect(-16, 2, 32, 14);
  ctx.fillStyle = '#2a1d12';
  ctx.beginPath();
  ctx.arc(-9, 16, 6, 0, Math.PI * 2);
  ctx.arc(9, 16, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(d.aim ?? (d.facing > 0 ? -0.5 : Math.PI + 0.5));
  const barrel = ctx.createLinearGradient(0, -9, 0, 9);
  barrel.addColorStop(0, '#6b7280');
  barrel.addColorStop(0.45, '#374151');
  barrel.addColorStop(1, '#111827');
  ctx.fillStyle = barrel;
  ctx.beginPath();
  ctx.moveTo(-14, -11);
  ctx.lineTo(52, -8);
  ctx.lineTo(52, 8);
  ctx.lineTo(-14, 11);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#0b0f16';
  ctx.beginPath();
  ctx.ellipse(52, 0, 3, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Live, because it is the one part of the rig that is supposed to move. */
function drawFlag(ctx: CanvasRenderingContext2D, skin: ShipSkin, clock: number) {
  const x = -12;
  const y = -232;
  const wave = Math.sin(clock * 3.1) * 5;
  const wave2 = Math.sin(clock * 3.1 + 1.2) * 7;
  ctx.fillStyle = skin.flag;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x + 26, y - 6 + wave, x + 52, y + 2 + wave2);
  ctx.lineTo(x + 52, y + 18 + wave2);
  ctx.quadraticCurveTo(x + 26, y + 12 + wave, x, y + 20);
  ctx.closePath();
  ctx.fill();
}

// -- the bake ---------------------------------------------------------------

function paintHull(ctx: CanvasRenderingContext2D, skin: ShipSkin, accent: string) {
  const halfW = BALANCE.HULL_W / 2;
  const top = -44;
  const keel = 26;

  // Mast and rigging first, so the deck edge overlaps their feet.
  ctx.strokeStyle = '#4a361f';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-12, top + 4);
  ctx.lineTo(-12, -238);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(60, 44, 26, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-12, -226);
  ctx.lineTo(halfW * 0.8, top - 2);
  ctx.moveTo(-12, -226);
  ctx.lineTo(-halfW * 0.82, top - 2);
  ctx.stroke();

  // Yard and mainsail. The billow is a pair of curves rather than a rectangle,
  // because a flat sail reads as a signpost.
  ctx.strokeStyle = '#4a361f';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(-86, -206);
  ctx.lineTo(66, -206);
  ctx.stroke();

  ctx.fillStyle = skin.sail;
  ctx.beginPath();
  ctx.moveTo(-84, -204);
  ctx.quadraticCurveTo(24, -186, 64, -204);
  ctx.lineTo(58, -76);
  ctx.quadraticCurveTo(16, -52, -74, -78);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = skin.sailShade;
  ctx.beginPath();
  ctx.moveTo(20, -192);
  ctx.quadraticCurveTo(48, -188, 64, -204);
  ctx.lineTo(58, -76);
  ctx.quadraticCurveTo(38, -62, 16, -62);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = accent;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(-80, -160);
  ctx.quadraticCurveTo(20, -142, 62, -160);
  ctx.stroke();

  drawEmblem(ctx, skin);

  // Foresail, small, in front of the mast.
  ctx.fillStyle = skin.sailShade;
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  ctx.moveTo(-14, -214);
  ctx.quadraticCurveTo(76, -150, 104, -58);
  ctx.lineTo(-14, -60);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  // -- the hull --
  const body = ctx.createLinearGradient(0, top, 0, keel);
  body.addColorStop(0, skin.hull);
  body.addColorStop(1, skin.hullDark);
  ctx.fillStyle = body;
  hullPath(ctx, 1);
  ctx.fill();

  // Team stripe. The one place the hull says which side it is on, and
  // deliberately the widest flat area on the ship.
  ctx.fillStyle = accent;
  ctx.fillRect(-halfW * 0.96, top + 9, halfW * 1.9, 11);
  ctx.fillStyle = skin.trim;
  ctx.fillRect(-halfW * 0.96, top + 4, halfW * 1.9, 5);

  // Gun ports.
  ctx.fillStyle = 'rgba(12, 10, 8, 0.78)';
  for (let i = -1; i <= 1; i++) ctx.fillRect(i * 46 - 11, top + 28, 22, 16);

  // Deck and stern castle.
  ctx.fillStyle = skin.deck;
  ctx.fillRect(-halfW, top - 8, BALANCE.HULL_W, 10);
  ctx.fillStyle = skin.hullDark;
  ctx.beginPath();
  ctx.moveTo(-halfW, top - 8);
  ctx.lineTo(-halfW, top - 62);
  ctx.lineTo(-halfW + 54, top - 52);
  ctx.lineTo(-halfW + 54, top - 8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = skin.trim;
  ctx.fillRect(-halfW + 4, top - 46, 46, 5);

  // Bowsprit.
  ctx.strokeStyle = '#4a361f';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(halfW - 14, top - 4);
  ctx.lineTo(halfW + 58, top - 30);
  ctx.stroke();

  // Waterline shadow, so the hull sits in the sea instead of on it.
  ctx.fillStyle = 'rgba(6, 24, 42, 0.35)';
  ctx.beginPath();
  ctx.ellipse(0, keel - 2, halfW * 0.92, 9, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawEmblem(ctx: CanvasRenderingContext2D, skin: ShipSkin) {
  if (skin.emblem === 'none') return;
  const cx = -6;
  const cy = -118;
  ctx.save();
  ctx.fillStyle = 'rgba(24, 22, 30, 0.72)';
  ctx.strokeStyle = 'rgba(24, 22, 30, 0.72)';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';

  if (skin.emblem === 'skull') {
    ctx.beginPath();
    ctx.arc(cx, cy - 6, 19, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - 11, cy + 10, 22, 11);
    ctx.fillStyle = skin.sail;
    ctx.beginPath();
    ctx.arc(cx - 7, cy - 8, 5, 0, Math.PI * 2);
    ctx.arc(cx + 7, cy - 8, 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (skin.emblem === 'cross') {
    ctx.beginPath();
    ctx.moveTo(cx - 16, cy - 16);
    ctx.lineTo(cx + 16, cy + 16);
    ctx.moveTo(cx + 16, cy - 16);
    ctx.lineTo(cx - 16, cy + 16);
    ctx.stroke();
  } else if (skin.emblem === 'moon') {
    ctx.beginPath();
    ctx.arc(cx, cy, 20, 0.5, 5.1);
    ctx.arc(cx + 9, cy - 3, 17, 4.9, 0.9, true);
    ctx.fill();
  } else if (skin.emblem === 'star') {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 21 : 9;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(cx, cy - 20);
    ctx.lineTo(cx, cy + 16);
    ctx.moveTo(cx - 14, cy - 8);
    ctx.lineTo(cx + 14, cy - 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy + 8, 15, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }
  ctx.restore();
}
