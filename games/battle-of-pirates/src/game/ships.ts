/**
 * The ships: fourteen hulls, three free, the rest bought with the coins the rest
 * of PlayBuddies pays out.
 *
 * They are skins and nothing else. Not one of them fires further, turns faster
 * or takes less damage, and none ever will: this is a game two people play
 * against each other, and a shop that sells an advantage in a head-to-head
 * game is worse than no shop at all. Volley Clash learned that the long way
 * round and the same rule applies here.
 *
 * A skin is a silhouette now, not a palette. Eight recolours of one outline
 * meant that at the distance these are actually seen at -- two fleets across
 * 1850px of water on a phone -- every ship on the board was the same ship in a
 * different shirt, and the one thing a skin is for is being recognisable.
 * So each carries a `rig` (what is above the deck: square canvas, a lateen
 * triangle, junk battens, a two-masted clipper, a galleon's stacked topsail,
 * or a ghost's shredded rags) and a `shape` (what is below it: full-bellied,
 * fine-lined, or slab-sided).
 *
 * None of that touches the fight. The hull and rigging hitboxes live in
 * BattleEngine and are the same rectangle for every hull on the water; the
 * silhouettes are all drawn to fit inside them, so a ship that reads as
 * slimmer is not a smaller target, it just looks like one. That is the point:
 * paint may vary, the target may not.
 *
 * Each hull is baked into an offscreen sprite the first time it is asked for
 * and blitted afterwards. A galleon is thirty-odd paths, and painting thirty
 * paths twice a frame is exactly the kind of thing that turns a cheap phone
 * into a slideshow. The cannon, flag and Eclipse Monarch's small celestial
 * effect are drawn live; premium silhouette details stay in the cached sprite.
 */
import { BALANCE, clamp } from './rules';

/** What is above the deck. The half of the silhouette you read from a distance. */
export type Rig = 'square' | 'lateen' | 'junk' | 'clipper' | 'galleon' | 'tattered';
/** What is below it. Same hitbox either way -- see the note at the top. */
export type Shape = 'round' | 'sharp' | 'blocky';

export interface ShipSkin {
  name: string;
  blurb: string;
  price: number;
  rig: Rig;
  shape: Shape;
  hull: string;
  hullDark: string;
  trim: string;
  deck: string;
  sail: string;
  sailShade: string;
  flag: string;
  /** Drawn on the sail. Kept to a handful of primitives so it bakes cheaply. */
  emblem: 'skull' | 'cross' | 'moon' | 'star' | 'anchor' | 'bug' | 'bolt' | 'none';
  /**
   * A halo baked in behind the whole ship.
   *
   * Bought hulls only, and deliberately: it is the loudest thing a skin can
   * do, so it is what the coins are actually for. It is also still only
   * light -- a glowing ship is hit exactly as easily as a plain one.
   */
  glow?: string;
  ornament?: 'dragon' | 'coral' | 'forge' | 'seraph' | 'leviathan' | 'eclipse' | 'firefly' | 'tempest';
  /**
   * Not for sale: flown only by a captain holding this PlayBuddies badge.
   *
   * The badge is the price. Both tester tiers are earned by getting bug
   * reports approved, and an admin grants them (see src/lib/badges.ts), so
   * these hulls are the one thing in the shop coins cannot reach. Still paint:
   * the same hitbox, the same guns, the same everything that decides a fight.
   */
  badge?: ShipBadge;
}

/** The two tester tiers, by their grant key on the account. */
export type ShipBadge = 'tester' | 'testerPlus';

/** What the account holds, as the lobby page reports it. Absent means no. */
export type ShipGrants = Partial<Record<ShipBadge, boolean>>;

export const BADGE_LABEL: Record<ShipBadge, string> = { tester: 'Tester', testerPlus: 'Tester+' };

/**
 * Whether a captain may fly a badge hull.
 *
 * Tester+ covers Tester's ship as well. The badges are tiers of the same
 * thing, and a captain who climbed to the higher one should not find the
 * lower one's ship locked because an admin only ever flipped the top grant.
 */
export function badgeAllows(badge: ShipBadge, grants: ShipGrants): boolean {
  if (badge === 'tester') return grants.tester === true || grants.testerPlus === true;
  return grants.testerPlus === true;
}

/** Badge hulls this captain may fly, by index. */
export function badgeShipsFor(grants: ShipGrants): number[] {
  return SHIPS.reduce<number[]>((out, ship, i) => {
    if (ship.badge && badgeAllows(ship.badge, grants)) out.push(i);
    return out;
  }, []);
}

export const SHIPS: ShipSkin[] = [
  {
    name: 'Salt Dog', blurb: 'Square-rigged, round-bellied, every captain starts here.', price: 0,
    rig: 'square', shape: 'round',
    hull: '#8b5a2b', hullDark: '#5c3a1a', trim: '#d9a441', deck: '#c89b62',
    sail: '#f2e8d5', sailShade: '#d9cbb0', flag: '#e0453c', emblem: 'none',
  },
  {
    name: 'Reef Runner', blurb: 'One lateen triangle over a shallow keel. Quick on the eye.', price: 0,
    rig: 'lateen', shape: 'sharp',
    hull: '#2f6f6a', hullDark: '#1d4642', trim: '#8fd6c8', deck: '#a9c9bf',
    sail: '#eafaf5', sailShade: '#c2ded6', flag: '#14b8a6', emblem: 'star',
  },
  {
    name: 'Old Barnacle', blurb: 'Battened junk sails on a slab of a hull. Paint and spite.', price: 0,
    rig: 'junk', shape: 'blocky',
    hull: '#5b6462', hullDark: '#373d3c', trim: '#9aa6a3', deck: '#8b8f86',
    sail: '#ddd9cb', sailShade: '#b6b2a4', flag: '#94a3b8', emblem: 'anchor',
  },
  {
    name: 'Crimson Corsair', blurb: 'Two masts, fine lines, painted the colour of a bad morning.', price: 320,
    rig: 'clipper', shape: 'sharp',
    hull: '#a52a2a', hullDark: '#6b1717', trim: '#f2b544', deck: '#d59a5f',
    sail: '#ffe9e2', sailShade: '#e6bfb4', flag: '#f97316', emblem: 'cross',
  },
  {
    name: 'Black Kraken', blurb: 'Rags for canvas and a light under the waterline that should not be there.', price: 480,
    rig: 'tattered', shape: 'blocky',
    hull: '#232733', hullDark: '#0f1218', trim: '#7c3aed', deck: '#3b4152',
    sail: '#2c3040', sailShade: '#191c26', flag: '#a78bfa', emblem: 'skull',
    glow: '#8b5cf6',
  },
  {
    name: 'Golden Doubloon', blurb: 'Stacked topsail, high stern, and she sails low. Wonder why.', price: 650,
    rig: 'galleon', shape: 'round',
    hull: '#8a6510', hullDark: '#5a4109', trim: '#fbbf24', deck: '#e0b357',
    sail: '#fff4cf', sailShade: '#e4cf95', flag: '#fbbf24', emblem: 'star',
    glow: '#fbbf24',
  },
  {
    name: 'Frost Galleon', blurb: 'Rigging still rimed from the far south, and glowing with it.', price: 800,
    rig: 'galleon', shape: 'sharp',
    hull: '#3f5f7a', hullDark: '#243a4d', trim: '#bae6fd', deck: '#93b4c9',
    sail: '#f0fbff', sailShade: '#c7e4f2', flag: '#38bdf8', emblem: 'moon',
    glow: '#38bdf8',
  },
  {
    name: 'Ghost of the Deep', blurb: 'Nobody has seen her crew. Nobody wants to.', price: 1100,
    rig: 'tattered', shape: 'sharp',
    hull: '#2b4a45', hullDark: '#152b28', trim: '#6ee7b7', deck: '#4a6f68',
    sail: '#d6fff2', sailShade: '#9fd8c6', flag: '#34d399', emblem: 'skull',
    glow: '#34d399',
  },
  {
    name: 'Dragon Emperor', blurb: 'Crimson battened sails, gilded dragon horns and an imperial prow.', price: 1200,
    rig: 'junk', shape: 'sharp', ornament: 'dragon',
    hull: '#701c31', hullDark: '#280b19', trim: '#ffd17a', deck: '#a96040',
    sail: '#b83345', sailShade: '#591329', flag: '#ffd17a', emblem: 'star', glow: '#f59e0b',
  },
  {
    name: 'Coral Sovereign', blurb: 'A living reef of rose coral and turquoise crystal sails.', price: 1350,
    rig: 'lateen', shape: 'round', ornament: 'coral',
    hull: '#126b71', hullDark: '#083339', trim: '#ffb6bd', deck: '#348b89',
    sail: '#b7fff3', sailShade: '#45bab8', flag: '#fb7185', emblem: 'moon', glow: '#2dd4bf',
  },
  {
    name: 'Iron Inferno', blurb: 'An armoured furnace ship with brass plating and twin smokestacks.', price: 1500,
    rig: 'square', shape: 'blocky', ornament: 'forge',
    hull: '#434854', hullDark: '#151822', trim: '#ffac54', deck: '#6a4b3b',
    sail: '#342f39', sailShade: '#17151e', flag: '#ff683d', emblem: 'cross', glow: '#f97316',
  },
  {
    name: 'Celestial Swan', blurb: 'Ivory wings, sapphire silk and a silver-plated racing hull.', price: 1650,
    rig: 'clipper', shape: 'sharp', ornament: 'seraph',
    hull: '#ddeaf5', hullDark: '#617997', trim: '#fff0b9', deck: '#91a7bb',
    sail: '#879ff5', sailShade: '#425cad', flag: '#fef3c7', emblem: 'star', glow: '#a5b4fc',
  },
  {
    name: 'Leviathan King', blurb: 'A sea-monster flagship crowned with emerald spines and curling tentacles.', price: 1850,
    rig: 'tattered', shape: 'blocky', ornament: 'leviathan',
    hull: '#203752', hullDark: '#0b1529', trim: '#78f0b7', deck: '#355267',
    sail: '#497b83', sailShade: '#203a51', flag: '#6ee7b7', emblem: 'skull', glow: '#34d399',
  },
  {
    name: 'Eclipse Monarch', blurb: 'The ultimate flagship. A revolving celestial crown, pulsing eclipse and drifting stardust.', price: 2000,
    rig: 'galleon', shape: 'sharp', ornament: 'eclipse',
    hull: '#30204d', hullDark: '#110c23', trim: '#ffda8b', deck: '#60416e',
    sail: '#5c398b', sailShade: '#24153f', flag: '#f0abfc', emblem: 'moon', glow: '#c084fc',
  },
  // Badge hulls go last, so every index above keeps meaning the ship it
  // always has in saved purses and lobby documents.
  {
    name: 'Firefly Warden', blurb: 'Tester only. Lanterns on the rail, a swarm of fireflies in the rigging and a spark that jumps mast to mast.', price: 0,
    rig: 'clipper', shape: 'sharp', ornament: 'firefly', badge: 'tester',
    hull: '#1d5a37', hullDark: '#0a2616', trim: '#bef264', deck: '#3d7a4d',
    sail: '#effcd6', sailShade: '#a7d98a', flag: '#a3e635', emblem: 'bug', glow: '#84cc16',
  },
  {
    name: 'Tempest Sovereign', blurb: 'Tester+ only. Sails under her own storm: lightning on call, a spinning energy crown and a shield that hums.', price: 0,
    rig: 'galleon', shape: 'sharp', ornament: 'tempest', badge: 'testerPlus',
    hull: '#0d3a4a', hullDark: '#04151d', trim: '#67e8f9', deck: '#1d5468',
    sail: '#d5fbff', sailShade: '#63c6d6', flag: '#22d3ee', emblem: 'bolt', glow: '#22d3ee',
  },
];

/** Every captain's opening fleet. Badge hulls cost nothing but are not free. */
export const FREE_SHIPS = SHIPS.reduce<number[]>((free, ship, i) => {
  if (ship.price === 0 && !ship.badge) free.push(i);
  return free;
}, []);

/** Ornaments that move, so a preview card knows to keep repainting itself. */
export const ANIMATED_ORNAMENTS = ['seraph', 'leviathan', 'eclipse', 'firefly', 'tempest'];

/**
 * The handful of numbers that differ per rig but belong to the hull under it.
 *
 * Every rig hangs its canvas somewhere else, so the three things that have to
 * agree with it -- where the pennant flies, where the emblem lands on actual
 * cloth, and how much ship there is fore and aft to balance it -- cannot be
 * the constants they were when there was only one rig.
 */
interface RigSpec {
  /** Where the pennant flies, at the head of the tallest spar. */
  flag: { x: number; y: number };
  /** Where the emblem sits, and how big, on whatever canvas this rig has. */
  emblem: { x: number; y: number; scale: number };
  /** Stern castle height above the deck. */
  castle: number;
  /** Bowsprit reach past the stem. */
  bowsprit: number;
}

const RIGS: Record<Rig, RigSpec> = {
  square: { flag: { x: -12, y: -232 }, emblem: { x: -6, y: -118, scale: 1 }, castle: 54, bowsprit: 58 },
  // Forward and high, where a triangle is actually deep enough to hold it.
  lateen: { flag: { x: -16, y: -180 }, emblem: { x: 42, y: -142, scale: 0.7 }, castle: 30, bowsprit: 62 },
  // Small and sat squarely in the gap between two battens: anything bigger
  // lands on a spar and reads as a sticker rather than as painted canvas.
  junk: { flag: { x: -20, y: -222 }, emblem: { x: -18, y: -152, scale: 0.55 }, castle: 76, bowsprit: 26 },
  clipper: { flag: { x: -34, y: -234 }, emblem: { x: -34, y: -114, scale: 0.72 }, castle: 34, bowsprit: 62 },
  galleon: { flag: { x: -12, y: -236 }, emblem: { x: -8, y: -108, scale: 0.95 }, castle: 82, bowsprit: 54 },
  tattered: { flag: { x: -12, y: -226 }, emblem: { x: -6, y: -136, scale: 0.85 }, castle: 62, bowsprit: 50 },
};

/**
 * Sprite geometry. The origin is the point where the hull meets the water.
 *
 * Roomier than the outline strictly needs. A glow is a shadow stamped around
 * the ship, and a shadow that runs off the edge of its own canvas is a hull
 * with the halo sliced flat down one side.
 */
const SPR = { w: 380, h: 380, ox: 190, oy: 300 };

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
    const skin = SHIPS[clamp(skinIndex, 0, SHIPS.length - 1)];
    if (skin.glow) paintGlow(ctx, skin, accent);
    paintHull(ctx, skin, accent);
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
  /** Visual kickback, zero at rest and one immediately after firing. */
  recoil?: number;
  effects?: boolean;
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
  if (d.effects !== false) drawAura(ctx, skin, d.clock);
  if (baked) ctx.drawImage(baked, -SPR.ox, -SPR.oy);
  else paintHull(ctx, skin, d.accent);
  drawFlag(ctx, skin, d.clock);
  if (skin.ornament === 'seraph' || skin.ornament === 'leviathan') paintOrnament(ctx, skin, d.clock);
  if (d.effects !== false) drawPremiumEffects(ctx, skin, d.clock);
  ctx.restore();

  // The barrel is drawn unmirrored so a world-space aim angle can be handed
  // straight to rotate() without the caller having to know which way the hull
  // is pointing.
  drawCannon(ctx, d);

  if (d.flash > 0) {
    ctx.globalAlpha = Math.min(0.75, d.flash);
    ctx.fillStyle = '#fff';
    hullPath(ctx, d.facing, skin.shape);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/**
 * Hull outline on its own, reused for the damage flash.
 *
 * All three profiles are the same 200 wide and sit between the same two
 * heights, because that is the box the engine shoots at. What changes is
 * everything in between: how much belly the sides carry and how much of the
 * width survives down at the keel.
 */
function hullPath(ctx: CanvasRenderingContext2D, facing: 1 | -1, shape: Shape) {
  const halfW = BALANCE.HULL_W / 2;
  const top = -44;
  const keel = 26;
  ctx.beginPath();
  ctx.moveTo(-halfW * facing, top);
  ctx.lineTo(halfW * facing, top);
  if (shape === 'sharp') {
    // Fine entry: most of the width is gone by the waterline, which is what
    // makes a hull read as fast rather than as capacious.
    ctx.quadraticCurveTo(halfW * 0.98 * facing, top + 24, halfW * 0.3 * facing, keel + 4);
    ctx.lineTo(-halfW * 0.44 * facing, keel + 4);
    ctx.quadraticCurveTo(-halfW * 1.0 * facing, top + 28, -halfW * facing, top);
  } else if (shape === 'blocky') {
    // Slab sides and a flat bottom. A barge that has been armed.
    ctx.lineTo(halfW * facing, keel - 8);
    ctx.lineTo(halfW * 0.9 * facing, keel);
    ctx.lineTo(-halfW * 0.9 * facing, keel);
    ctx.lineTo(-halfW * facing, keel - 8);
  } else {
    ctx.quadraticCurveTo(halfW * 1.12 * facing, top + 34, halfW * 0.66 * facing, keel);
    ctx.lineTo(-halfW * 0.72 * facing, keel);
    ctx.quadraticCurveTo(-halfW * 1.06 * facing, top + 36, -halfW * facing, top);
  }
  ctx.closePath();
}

function drawCannon(ctx: CanvasRenderingContext2D, d: ShipDraw) {
  ctx.save();
  ctx.translate(d.facing * BALANCE.MUZZLE_X, BALANCE.MUZZLE_Y);
  const recoil = clamp(d.recoil ?? 0, 0, 1);
  // The carriage gives a little with the deck while the barrel travels farther
  // on its slides. The eased return reads as weight instead of a one-frame
  // teleport, but is entirely visual and never moves the actual muzzle.
  ctx.translate(-d.facing * recoil * 3.5, recoil * 1.4);

  // Carriage. Sits square on the deck whichever way the barrel points.
  ctx.fillStyle = '#3f2d1c';
  ctx.fillRect(-16, 2, 32, 14);
  ctx.fillStyle = '#2a1d12';
  ctx.beginPath();
  ctx.arc(-9, 16, 6, 0, Math.PI * 2);
  ctx.arc(9, 16, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(d.aim ?? (d.facing > 0 ? -0.5 : Math.PI + 0.5));
  const barrelKick = 18 * Math.pow(recoil, 1.3);
  ctx.translate(-barrelKick, 0);
  ctx.fillStyle = barrelGradient(ctx);
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
/**
 * `origin` and `color` default to the rig's own masthead and the skin's own
 * decorative colour -- what a living hull always wants. A wreck marker is
 * the one caller that supplies both itself: its own pole rather than a mast
 * partway up a hull that is no longer drawn, and the side's own colour
 * rather than whatever this particular skin happened to be painted, since a
 * skin is shared cosmetic stock and tells you nothing about whose it was.
 */
export function drawFlag(
  ctx: CanvasRenderingContext2D,
  skin: ShipSkin,
  clock: number,
  origin?: { x: number; y: number },
  color?: string,
) {
  const { x, y } = origin ?? RIGS[skin.rig].flag;
  const wave = Math.sin(clock * 3.1) * 5;
  const wave2 = Math.sin(clock * 3.1 + 1.2) * 7;
  ctx.fillStyle = color ?? skin.flag;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x + 26, y - 6 + wave, x + 52, y + 2 + wave2);
  ctx.lineTo(x + 52, y + 18 + wave2);
  ctx.quadraticCurveTo(x + 26, y + 12 + wave, x, y + 20);
  ctx.closePath();
  ctx.fill();
}

// -- the bake ---------------------------------------------------------------

/**
 * The halo, stamped behind a bought hull.
 *
 * Painted from the ship's own outline rather than from a shape drawn to
 * approximate it: the ship is rendered once to a scratch canvas, flooded with
 * the glow colour through `source-in` so only its silhouette survives, and
 * then blitted a few times through a shadow. Every mast, every torn edge and
 * every spar throws its own light, and none of the rigs has to know it is
 * happening. Runs once per skin, at bake time, so the cost never reaches a
 * frame.
 */
function paintGlow(ctx: CanvasRenderingContext2D, skin: ShipSkin, accent: string) {
  const scratch = document.createElement('canvas');
  scratch.width = SPR.w;
  scratch.height = SPR.h;
  const sc = scratch.getContext('2d');
  if (!sc) return;
  sc.translate(SPR.ox, SPR.oy);
  paintHull(sc, skin, accent);
  sc.globalCompositeOperation = 'source-in';
  sc.fillStyle = skin.glow as string;
  sc.fillRect(-SPR.ox, -SPR.oy, SPR.w, SPR.h);

  ctx.save();
  ctx.shadowColor = skin.glow as string;
  ctx.shadowBlur = 22;
  ctx.globalAlpha = 0.45;
  for (let i = 0; i < 3; i++) ctx.drawImage(scratch, -SPR.ox, -SPR.oy);
  ctx.restore();
}

function spar(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, width: number, color = '#4a361f') {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function paintHull(ctx: CanvasRenderingContext2D, skin: ShipSkin, accent: string) {
  // Rigging first, so the deck edge overlaps the feet of the masts.
  if (skin.rig === 'lateen') rigLateen(ctx, skin, accent);
  else if (skin.rig === 'junk') rigJunk(ctx, skin, accent);
  else if (skin.rig === 'clipper') rigClipper(ctx, skin, accent);
  else if (skin.rig === 'galleon') rigGalleon(ctx, skin, accent);
  else if (skin.rig === 'tattered') rigTattered(ctx, skin, accent);
  else rigSquare(ctx, skin, accent);

  paintBody(ctx, skin, accent);
  if (skin.ornament) {
    paintPremiumDetail(ctx, skin);
    if (skin.ornament !== 'seraph' && skin.ornament !== 'leviathan') paintOrnament(ctx, skin);
  }
}

/** Inlaid rails, bevelled gems and lit gunports stay in the cached artwork. */
function paintPremiumDetail(ctx: CanvasRenderingContext2D, skin: ShipSkin) {
  ctx.save();
  ctx.strokeStyle = skin.trim; ctx.lineWidth = 2;
  for (const y of [-33, -23]) {
    ctx.beginPath(); ctx.moveTo(-87, y); ctx.quadraticCurveTo(0, y + 17, 87, y); ctx.stroke();
  }
  for (let x = -66; x <= 66; x += 22) {
    ctx.fillStyle = skin.hullDark; ctx.fillRect(x - 6, -16, 12, 12);
    ctx.fillStyle = skin.trim; ctx.fillRect(x - 3, -13, 6, 5);
    ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.6; ctx.fillRect(x - 3, -13, 6, 1); ctx.globalAlpha = 1;
  }
  const gem = (x: number, y: number, size: number) => {
    ctx.fillStyle = skin.trim; ctx.beginPath(); ctx.moveTo(x, y - size); ctx.lineTo(x + size * 0.6, y);
    ctx.lineTo(x, y + size); ctx.lineTo(x - size * 0.6, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.65;
    ctx.beginPath(); ctx.moveTo(x, y - size); ctx.lineTo(x, y + size); ctx.lineTo(x - size * 0.6, y); ctx.fill(); ctx.globalAlpha = 1;
  };
  gem(-76, -43, 9); gem(77, -43, 9);
  const seal = RIGS[skin.rig].emblem;
  ctx.globalAlpha = 0.6;
  ctx.beginPath(); ctx.arc(seal.x, seal.y, 27 * seal.scale, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

/** Premium silhouette details are cached with the hull, including shop previews. */
function paintOrnament(ctx: CanvasRenderingContext2D, skin: ShipSkin, clock = 0) {
  ctx.save();
  ctx.strokeStyle = skin.trim;
  ctx.fillStyle = skin.trim;
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  if (skin.ornament === 'dragon') {
    for (let i = 0; i < 7; i++) {
      const x = -85 + i * 24;
      ctx.beginPath(); ctx.moveTo(x, -38); ctx.lineTo(x + 5, -60 - i * 2);
      ctx.lineTo(x + 19, -38); ctx.fill();
    }
    ctx.beginPath(); ctx.moveTo(85, -30); ctx.quadraticCurveTo(140, -45, 115, -91);
    ctx.lineTo(142, -80); ctx.lineTo(153, -92); ctx.lineTo(147, -60); ctx.lineTo(113, -33); ctx.fill();
    ctx.fillStyle = '#fff6cf'; ctx.beginPath(); ctx.arc(130, -76, 3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = skin.hullDark; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(134, -65); ctx.lineTo(145, -68); ctx.stroke();
  } else if (skin.ornament === 'coral') {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const x = side * (72 + i * 8);
        ctx.beginPath(); ctx.moveTo(x, -25); ctx.bezierCurveTo(x - 15, -55, x + 17, -65, x + 8, -95 - i * 5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, -60); ctx.lineTo(x - 15, -77); ctx.stroke();
        ctx.fillStyle = '#ffe0e9'; ctx.beginPath(); ctx.arc(x + 8, -95 - i * 5, 4, 0, Math.PI * 2); ctx.fill();
      }
    }
  } else if (skin.ornament === 'forge') {
    for (const x of [-73, 55]) {
      ctx.fillStyle = skin.hullDark; ctx.fillRect(x, -120, 20, 73);
      ctx.fillStyle = skin.trim; ctx.fillRect(x - 4, -125, 28, 9);
      ctx.fillStyle = '#ff793f'; ctx.fillRect(x + 4, -105, 12, 18);
    }
    for (let x = -70; x < 90; x += 28) {
      ctx.strokeRect(x, -30, 23, 25);
      ctx.beginPath(); ctx.arc(x + 4, -25, 2, 0, Math.PI * 2); ctx.fill();
    }
  } else if (skin.ornament === 'seraph') {
    for (const side of [-1, 1]) {
      ctx.save(); ctx.translate(side * 66, -35); ctx.rotate(side * Math.sin(clock * 1.4) * 0.075); ctx.translate(-side * 66, 35);
      for (let i = 0; i < 7; i++) {
      ctx.fillStyle = i % 2 ? '#bdd7f4' : '#f4f8ff';
      ctx.beginPath(); ctx.moveTo(side * 66, -35);
      ctx.quadraticCurveTo(side * (134 - i * 5), -55, side * (142 - i * 10), -122 + i * 12);
      ctx.quadraticCurveTo(side * 95, -65, side * 66, -35); ctx.fill();
      ctx.strokeStyle = '#7c9dc5'; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.restore();
    }
  } else if (skin.ornament === 'leviathan') {
    for (const side of [-1, 1]) {
      ctx.lineWidth = 10;
      const sway = Math.sin(clock * 1.8 + side) * 11;
      ctx.beginPath(); ctx.moveTo(side * 65, 0); ctx.bezierCurveTo(side * 153, 15, side * (148 + sway), -105, side * (110 + sway), -65); ctx.stroke();
      ctx.strokeStyle = '#204e58'; ctx.lineWidth = 5; ctx.stroke(); ctx.strokeStyle = skin.trim;
      ctx.lineWidth = 3;
      for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.arc(side * (99 + i * 6), -10 - i * 9, 3, 0, Math.PI * 2); ctx.stroke(); }
    }
  } else if (skin.ornament === 'firefly') {
    // Circuit traces along the lower hull: a tester's ship is wired.
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(-84, 8); ctx.lineTo(-52, 8); ctx.lineTo(-44, 0); ctx.lineTo(-18, 0);
    ctx.moveTo(-18, 12); ctx.lineTo(20, 12); ctx.lineTo(28, 4); ctx.lineTo(58, 4);
    ctx.moveTo(58, 14); ctx.lineTo(80, 14);
    ctx.stroke();
    for (const [x, y] of [[-84, 8], [-18, 0], [-18, 12], [58, 4], [58, 14], [80, 14]]) {
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Rail lanterns: a dark cage round a lime core, on short posts.
    for (const x of [-66, -4, 60]) {
      spar(ctx, x, -52, x, -66, 3, '#2b3a22');
      ctx.fillStyle = '#1b2a14';
      ctx.fillRect(x - 6, -80, 12, 15);
      ctx.fillStyle = '#d9f99d';
      ctx.fillRect(x - 3.5, -77, 7, 9);
      ctx.fillStyle = skin.trim;
      ctx.fillRect(x - 7, -83, 14, 4);
    }
  } else if (skin.ornament === 'tempest') {
    // Crystal spines along the rail, lit down one face.
    for (let i = 0; i < 6; i++) {
      const x = -74 + i * 30;
      const h = 30 + (i % 2) * 14;
      ctx.fillStyle = skin.trim;
      ctx.beginPath(); ctx.moveTo(x - 8, -48); ctx.lineTo(x, -48 - h); ctx.lineTo(x + 8, -48); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ecfeff';
      ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(x - 8, -48); ctx.lineTo(x, -48 - h); ctx.lineTo(x, -48); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    }
    // Rune chevrons along the lower hull.
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (let x = -72; x <= 72; x += 18) {
      ctx.moveTo(x - 4, 3); ctx.lineTo(x + 3, 9); ctx.lineTo(x - 4, 15);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Lightning rod on the main truck, which the storm above actually uses.
    spar(ctx, -12, -242, -12, -262, 3, '#9adbe6');
    ctx.fillStyle = '#ecfeff';
    ctx.beginPath(); ctx.arc(-12, -264, 4, 0, Math.PI * 2); ctx.fill();
  } else {
    for (let i = 0; i < 7; i++) {
      const x = -65 + i * 21;
      ctx.beginPath(); ctx.moveTo(x, -37); ctx.lineTo(x + 7, -62 - (i % 2) * 10); ctx.lineTo(x + 15, -37); ctx.fill();
    }
    ctx.strokeStyle = '#e9c1ff'; ctx.lineWidth = 2;
    for (const x of [-58, 48]) { ctx.beginPath(); ctx.moveTo(x, -172); ctx.lineTo(x + 10, -115); ctx.lineTo(x, -74); ctx.stroke(); }
  }
  ctx.restore();
}

const AURA: Record<string, string> = {
  seraph: '#aacfff',
  leviathan: '#45edac',
  eclipse: '#bc7cff',
  firefly: '#a3e635',
  tempest: '#22d3ee',
};

const auraSprites = new Map<string, HTMLCanvasElement | null>();
/** One 128px gradient per premium aura, reused at every scale and every frame. */
function drawAura(ctx: CanvasRenderingContext2D, skin: ShipSkin, clock: number) {
  const color = AURA[skin.ornament ?? ''] ?? null;
  if (!color) return;
  if (!auraSprites.has(color)) {
    try {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
      const paint = canvas.getContext('2d');
      if (!paint) auraSprites.set(color, null);
      else {
        const glow = paint.createRadialGradient(64, 64, 0, 64, 64, 64);
        glow.addColorStop(0, color + '75'); glow.addColorStop(0.45, color + '45'); glow.addColorStop(1, color + '00');
        paint.fillStyle = glow; paint.fillRect(0, 0, 128, 128); auraSprites.set(color, canvas);
      }
    } catch { auraSprites.set(color, null); }
  }
  ctx.save();
  const pulse = 1 + Math.sin(clock * 1.35) * 0.06;
  const aura = auraSprites.get(color);
  if (aura) ctx.drawImage(aura, -155 * pulse, -135 - 150 * pulse, 310 * pulse, 300 * pulse);
  ctx.strokeStyle = color; ctx.lineWidth = 1.3;
  ctx.globalAlpha *= 0.2 + Math.sin(clock * 1.1) * 0.06;
  ctx.beginPath(); ctx.ellipse(0, -118, 127 * pulse, 147 * pulse, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

/** Clock-driven effects use fixed geometry, without growing particle pools. */
function drawPremiumEffects(ctx: CanvasRenderingContext2D, skin: ShipSkin, clock: number) {
  if (skin.ornament === 'firefly') return drawFirefly(ctx, clock);
  if (skin.ornament === 'tempest') return drawTempest(ctx, clock);
  if (skin.ornament === 'eclipse') drawEclipse(ctx, clock);
  if (!['seraph', 'leviathan', 'eclipse'].includes(skin.ornament ?? '')) return;
  ctx.save();
  const celestial = skin.ornament === 'seraph';
  const monster = skin.ornament === 'leviathan';
  const color = celestial ? '#c8e5ff' : monster ? '#71ffcb' : '#dfa8ff';
  ctx.strokeStyle = color; ctx.fillStyle = color;
  for (let i = 0; i < 3; i++) {
    const phase = (clock * 0.35 + i / 3) % 1;
    ctx.save();
    ctx.globalAlpha *= 1 - phase;
    ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(0, 19 + phase * 8, 75 + phase * 65, 6 + phase * 11, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  for (let i = 0; i < 10; i++) {
    const phase = (clock * 0.24 + i * 0.137) % 1;
    const x = Math.sin(i * 7.13 + clock * 0.4) * 115;
    const y = 8 - phase * (celestial ? 210 : 95);
    ctx.save(); ctx.globalAlpha *= Math.sin(phase * Math.PI) * 0.75;
    if (monster) { ctx.beginPath(); ctx.arc(x, y, 2 + phase * 3, 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.translate(x, y); ctx.rotate(clock * 0.7 + i); ctx.fillRect(-1, -4, 2, 8); ctx.fillRect(-4, -1, 8, 2); }
    ctx.restore();
  }
  if (celestial) {
    ctx.globalAlpha *= 0.65; ctx.beginPath(); ctx.ellipse(-28, -249, 27, 7, Math.sin(clock) * 0.12, 0, Math.PI * 2); ctx.stroke();
  }
  if (monster) {
    ctx.fillStyle = '#b7ffdd';
    for (const x of [-43, 43]) { ctx.beginPath(); ctx.ellipse(x, -34, 9, 3 + Math.sin(clock * 0.9) ** 12 * 2, x < 0 ? 0.2 : -0.2, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

/** Small fixed particle count: no allocations or random emissions per frame. */
function drawEclipse(ctx: CanvasRenderingContext2D, clock: number) {
  ctx.save();
  ctx.translate(-8, -128);
  const pulse = 0.7 + Math.sin(clock * 2) * 0.15;
  ctx.strokeStyle = '#ffdc95'; ctx.lineWidth = 3;
  ctx.globalAlpha *= pulse;
  ctx.beginPath(); ctx.arc(0, 0, 25, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#140d29'; ctx.beginPath(); ctx.arc(-4, -3, 21, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(clock * 0.35);
  ctx.strokeStyle = '#e9b5ff';
  ctx.beginPath(); ctx.ellipse(0, 0, 41, 14, 0, 0, Math.PI * 2); ctx.stroke();
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6 + clock * 0.18;
    const radius = 43 + (i % 3) * 9;
    const x = Math.cos(a) * radius, y = Math.sin(a) * radius;
    ctx.fillStyle = i % 2 ? '#fde68a' : '#e9d5ff';
    ctx.fillRect(x - 1.5, y - 3, 3, 6); ctx.fillRect(x - 3, y - 1.5, 6, 3);
  }
  ctx.restore();
}

/** A stable 0-1 value for an integer, so a jagged bolt holds its shape for a frame or two. */
function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** A jagged line between two points, two passes: a wide soft glow, then a hot core. */
function bolt(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  seed: number,
  glow: string,
  core: string,
  width: number,
) {
  const steps = 9;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  // Kinks go sideways to the bolt's own direction, whichever way it runs.
  const nx = -dy / len;
  const ny = dx / len;
  for (const [stroke, w] of [[glow, width * 3.2], [core, width]] as const) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = w;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const kink = (hash01(seed * 17 + i) - 0.5) * len * 0.16;
      ctx.lineTo(x0 + dx * t + nx * kink, y0 + dy * t + ny * kink);
    }
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
}

/** A soft dot with a bright centre, the unit every glowing particle here is made of. */
function glowDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, halo: string, core: string) {
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = core;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

/**
 * Firefly Warden, the Tester hull.
 *
 * A swarm drifting through the rigging, each one blinking on its own rhythm,
 * lanterns breathing on the rail, and every couple of seconds a spark that
 * jumps from one masthead to the other. Fixed counts and clock-driven paths,
 * like every other effect in this file: no particle pool to grow or leak.
 */
function drawFirefly(ctx: CanvasRenderingContext2D, clock: number) {
  const base = ctx.globalAlpha;
  ctx.save();

  // Lanterns breathing, over the baked cages.
  const breathe = 0.55 + Math.sin(clock * 2.6) * 0.25;
  ctx.globalAlpha = base * breathe;
  for (const x of [-66, -4, 60]) glowDot(ctx, x, -72, 3, 'rgba(190,242,100,0.28)', '#f7fee7');
  for (const [x, y] of [[-34, -242], [54, -208]]) glowDot(ctx, x, y, 3.5, 'rgba(190,242,100,0.3)', '#ecfccb');

  // The spark: two thirds of a second in every two and a half.
  const cycle = clock % 2.5;
  if (cycle < 0.38) {
    ctx.globalAlpha = base * (1 - cycle / 0.38);
    bolt(ctx, -34, -240, 54, -206, Math.floor(clock * 22), 'rgba(190,242,100,0.35)', '#fbffe9', 2.2);
    // And a little way down each mast, where it earths.
    bolt(ctx, 54, -206, 58, -150, Math.floor(clock * 22) + 5, 'rgba(190,242,100,0.25)', '#ecfccb', 1.4);
  }

  // The swarm.
  for (let i = 0; i < 18; i++) {
    const speed = 0.32 + (i % 5) * 0.07;
    const t = clock * speed + i * 1.7;
    const x = 10 + Math.sin(t * 1.3 + i) * (62 + (i % 4) * 20);
    const y = -142 + Math.sin(t * 0.85 + i * 2.1) * (84 + (i % 3) * 12);
    const blink = Math.sin(clock * (2 + (i % 3) * 0.8) + i * 1.3);
    if (blink <= 0.05) continue;
    ctx.globalAlpha = base * blink;
    glowDot(ctx, x, y, 1.8 + (i % 2) * 0.6, 'rgba(163,230,53,0.3)', i % 4 === 0 ? '#fef9c3' : '#ecfccb');
  }

  // Lime wake.
  ctx.strokeStyle = '#bef264';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 3; i++) {
    const phase = (clock * 0.4 + i / 3) % 1;
    ctx.globalAlpha = base * (1 - phase) * 0.8;
    ctx.beginPath();
    ctx.ellipse(0, 20 + phase * 8, 80 + phase * 60, 6 + phase * 10, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** The thundercloud, as puffs of [x, y, radius] around its own centre. */
const CLOUD_PUFFS: readonly (readonly [number, number, number])[] = [
  [-30, 4, 16], [-10, -6, 21], [14, -2, 19], [32, 6, 14], [4, 10, 17],
];

/**
 * Tempest Sovereign, the Tester+ hull.
 *
 * Carries its own weather: a thundercloud over the stern that throws a bolt
 * every couple of seconds, alternating between the lightning rod on the main
 * truck and the sea off the bow, with the whole ship lit by the flash; a
 * crown of two counter-rotating energy rings round the mast, an orb riding
 * each; a shield dome whose hexes light up in a travelling wave; rain; and a
 * charged wake throwing sparks. Still only light , the hitbox underneath is
 * the same rectangle as a Salt Dog's.
 */
function drawTempest(ctx: CanvasRenderingContext2D, clock: number) {
  const base = ctx.globalAlpha;
  ctx.save();

  const period = 2.1;
  const strikeN = Math.floor(clock / period);
  const since = clock - strikeN * period;
  const striking = since < 0.3;
  const flash = striking ? 1 - since / 0.3 : 0;

  // The flash first, so everything after it reads as lit by it.
  if (flash > 0) {
    ctx.globalAlpha = base * flash * 0.22;
    ctx.fillStyle = '#cffafe';
    ctx.beginPath(); ctx.ellipse(-10, -120, 190, 190, 0, 0, Math.PI * 2); ctx.fill();
  }

  // Shield dome, humming, with a wave of hexes running over it.
  const hum = 0.5 + Math.sin(clock * 3.2) * 0.5;
  ctx.strokeStyle = '#67e8f9';
  ctx.lineWidth = 1.6;
  ctx.globalAlpha = base * (0.16 + hum * 0.12 + flash * 0.3);
  ctx.beginPath(); ctx.ellipse(0, 6, 152, 262, 0, Math.PI, 0); ctx.stroke();
  for (let i = 0; i < 11; i++) {
    const a = Math.PI + ((i + 0.5) / 11) * Math.PI;
    const hx = Math.cos(a) * 152;
    const hy = 6 + Math.sin(a) * 262;
    const lit = Math.sin(clock * 2.6 - i * 0.62);
    if (lit < 0.15) continue;
    ctx.globalAlpha = base * lit * 0.75;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const ang = (Math.PI / 3) * k + Math.PI / 6;
      const px = hx + Math.cos(ang) * 8;
      const py = hy + Math.sin(ang) * 8;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // The crown: two tilted rings round the mast, turning opposite ways.
  for (const k of [0, 1]) {
    const tilt = k ? 0.32 : -0.32;
    const spin = clock * (k ? -1.1 : 1.4);
    const rx = 74 - k * 12;
    const ry = 15;
    const cy = -150 - k * 44;
    ctx.globalAlpha = base * (0.55 + flash * 0.4);
    ctx.strokeStyle = k ? '#a5f3fc' : '#22d3ee';
    ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.ellipse(-12, cy, rx, ry, tilt, spin, spin + Math.PI * 1.35); ctx.stroke();
    // The orb at the leading end of the arc.
    const end = spin + Math.PI * 1.35;
    const ex = Math.cos(end) * rx;
    const ey = Math.sin(end) * ry;
    const ox = -12 + ex * Math.cos(tilt) - ey * Math.sin(tilt);
    const oy = cy + ex * Math.sin(tilt) + ey * Math.cos(tilt);
    ctx.globalAlpha = base;
    glowDot(ctx, ox, oy, 3.2, 'rgba(34,211,238,0.35)', '#f0fdff');
  }

  // Rain, slanting out of the cloud.
  ctx.strokeStyle = '#a5f3fc';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 14; i++) {
    const fall = (clock * 1.6 + i * 0.137) % 1;
    const x = -150 + ((i * 37) % 130) - fall * 18;
    const y = -250 + fall * 250;
    ctx.globalAlpha = base * Math.sin(fall * Math.PI) * 0.45;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 14); ctx.stroke();
  }

  // The cloud, over the stern, clear of the masthead and the health bar.
  const drift = Math.sin(clock * 0.5) * 6;
  const cx = -92 + drift;
  const puffs = CLOUD_PUFFS;
  ctx.globalAlpha = base * 0.92;
  ctx.fillStyle = '#0c2430';
  for (const [px, py, r] of puffs) { ctx.beginPath(); ctx.arc(cx + px, -258 + py, r, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = base * (0.45 + flash * 0.55);
  ctx.strokeStyle = '#67e8f9';
  ctx.lineWidth = 2;
  for (const [px, py, r] of puffs) { ctx.beginPath(); ctx.arc(cx + px, -258 + py, r, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke(); }

  // The strike itself, alternating targets.
  if (striking) {
    ctx.globalAlpha = base * flash;
    if (strikeN % 2 === 0) {
      bolt(ctx, cx + 4, -246, -12, -264, strikeN, 'rgba(103,232,249,0.45)', '#ffffff', 2.6);
      glowDot(ctx, -12, -264, 6 * flash + 2, 'rgba(165,243,252,0.5)', '#ffffff');
    } else {
      bolt(ctx, cx + 10, -246, 150, 18, strikeN, 'rgba(103,232,249,0.4)', '#ffffff', 3);
      ctx.strokeStyle = '#a5f3fc';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(150, 20, 26 * (1 - flash) + 8, 5, 0, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // A charged wake: rings, and sparks climbing out of it.
  ctx.strokeStyle = '#67e8f9';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 3; i++) {
    const phase = (clock * 0.45 + i / 3) % 1;
    ctx.globalAlpha = base * (1 - phase) * 0.85;
    ctx.beginPath(); ctx.ellipse(0, 20 + phase * 8, 84 + phase * 70, 6 + phase * 12, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = '#ecfeff';
  for (let i = 0; i < 10; i++) {
    const phase = (clock * 0.5 + i * 0.173) % 1;
    const x = Math.sin(i * 5.3 + clock * 0.6) * 120;
    const y = 14 - phase * 70;
    ctx.globalAlpha = base * Math.sin(phase * Math.PI) * 0.85;
    ctx.save(); ctx.translate(x, y); ctx.rotate(clock * 2 + i);
    ctx.fillRect(-1, -5, 2, 10); ctx.fillRect(-5, -1, 10, 2);
    ctx.restore();
  }
  ctx.restore();
}

// -- the rigs ---------------------------------------------------------------

/** One mast, one big square course, one headsail. The shape everyone draws. */
function rigSquare(ctx: CanvasRenderingContext2D, skin: ShipSkin, accent: string) {
  spar(ctx, -12, -40, -12, -238, 9);

  ctx.strokeStyle = 'rgba(60, 44, 26, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-12, -226);
  ctx.lineTo(80, -46);
  ctx.moveTo(-12, -226);
  ctx.lineTo(-82, -46);
  ctx.stroke();

  // Yard and mainsail. The billow is a pair of curves rather than a rectangle,
  // because a flat sail reads as a signpost.
  spar(ctx, -86, -206, 66, -206, 6);

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

  ctx.fillStyle = skin.sailShade;
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  ctx.moveTo(-14, -214);
  ctx.quadraticCurveTo(76, -150, 104, -58);
  ctx.lineTo(-14, -60);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * One enormous triangle slung under a raked yard.
 *
 * The mast is deliberately stubby: on a lateen the spar carries the sail, and
 * a tall mast behind it would put the silhouette straight back into square-rig
 * territory, which is the one thing this rig exists not to be.
 */
function rigLateen(ctx: CanvasRenderingContext2D, skin: ShipSkin, accent: string) {
  spar(ctx, -16, -40, -16, -186, 8);
  spar(ctx, -76, -74, 88, -228, 6);

  ctx.fillStyle = skin.sail;
  ctx.beginPath();
  ctx.moveTo(-72, -76);
  ctx.lineTo(84, -224);
  ctx.quadraticCurveTo(80, -140, 56, -66);
  ctx.quadraticCurveTo(-8, -54, -72, -76);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = skin.sailShade;
  ctx.beginPath();
  ctx.moveTo(84, -224);
  ctx.quadraticCurveTo(80, -140, 56, -66);
  ctx.quadraticCurveTo(38, -60, 22, -62);
  ctx.lineTo(52, -102);
  ctx.closePath();
  ctx.fill();

  // The band runs with the foot rather than across the sail: on a triangle,
  // a horizontal stripe cuts off a corner and reads as damage. Kept well clear
  // of the hem, though -- any lower and it lines up with the hull's own stripe
  // and stops reading as canvas at all.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(-34, -98);
  ctx.quadraticCurveTo(2, -102, 36, -110);
  ctx.stroke();

  drawEmblem(ctx, skin);

  // Sheet, from the clew back to the stern quarter.
  ctx.strokeStyle = 'rgba(60, 44, 26, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(56, -66);
  ctx.lineTo(-70, -48);
  ctx.stroke();
}

/**
 * Battens, which are the whole point.
 *
 * A junk sail is a flat panel with a ladder of spars across it, and that
 * ladder is what makes it unmistakable at any distance -- so the panels are
 * kept deliberately flat, with no billow at all, and the battens are drawn
 * heavy enough to survive being scaled down to a shop thumbnail.
 */
function rigJunk(ctx: CanvasRenderingContext2D, skin: ShipSkin, accent: string) {
  spar(ctx, -20, -40, -20, -228, 11);
  // A stump of a foremast, standing at the forward panel's aft edge rather
  // than behind its middle: hidden behind the canvas it would leave that panel
  // floating in mid-air with nothing holding it to the deck.
  spar(ctx, 54, -40, 54, -202, 9);

  battenSail(ctx, skin, accent, [-88, -212], [40, -222], [48, -92], [-82, -84], 5, true);
  battenSail(ctx, skin, accent, [58, -196], [100, -184], [102, -104], [54, -98], 4, false);

  drawEmblem(ctx, skin);
}

/** One flat panel and the ladder of spars across it. */
function battenSail(
  ctx: CanvasRenderingContext2D,
  skin: ShipSkin,
  accent: string,
  aftTop: [number, number],
  foreTop: [number, number],
  foreLow: [number, number],
  aftLow: [number, number],
  battens: number,
  band: boolean,
) {
  ctx.fillStyle = skin.sail;
  ctx.beginPath();
  ctx.moveTo(aftTop[0], aftTop[1]);
  ctx.lineTo(foreTop[0], foreTop[1]);
  ctx.lineTo(foreLow[0], foreLow[1]);
  ctx.lineTo(aftLow[0], aftLow[1]);
  ctx.closePath();
  ctx.fill();

  // Shade the forward third, so the panel has a lit side like every other rig.
  ctx.save();
  ctx.clip();
  ctx.fillStyle = skin.sailShade;
  const lit = foreTop[0] - (foreTop[0] - aftTop[0]) * 0.32;
  ctx.fillRect(lit, -240, 240, 240);
  ctx.restore();

  const at = (t: number): [[number, number], [number, number]] => [
    [aftTop[0] + (aftLow[0] - aftTop[0]) * t, aftTop[1] + (aftLow[1] - aftTop[1]) * t],
    [foreTop[0] + (foreLow[0] - foreTop[0]) * t, foreTop[1] + (foreLow[1] - foreTop[1]) * t],
  ];

  const middle = Math.floor(battens / 2);
  for (let i = 0; i <= battens; i++) {
    const [a, b] = at(i / battens);
    const edge = i === 0 || i === battens;
    const stripe = band && i === middle;
    spar(ctx, a[0], a[1], b[0], b[1], edge ? 6 : stripe ? 6 : 3, stripe ? accent : '#4a361f');
  }
}

/**
 * Two masts, four sails, nothing bigger than it has to be.
 *
 * The busiest silhouette of the six on purpose: a clipper is recognised by
 * having a lot of small canvas rather than one big sheet of it, which is the
 * exact opposite read from the square rig standing next to it.
 */
function rigClipper(ctx: CanvasRenderingContext2D, skin: ShipSkin, accent: string) {
  spar(ctx, -34, -40, -34, -240, 8);
  spar(ctx, 54, -40, 54, -206, 7);

  // Stays, fore and aft, which is most of what says "two masts" at a glance.
  ctx.strokeStyle = 'rgba(60, 44, 26, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-34, -236);
  ctx.lineTo(54, -202);
  ctx.moveTo(54, -202);
  ctx.lineTo(104, -50);
  ctx.moveTo(-34, -236);
  ctx.lineTo(-90, -48);
  ctx.stroke();

  squareSail(ctx, skin, accent, -80, 12, -234, -178, false);
  squareSail(ctx, skin, accent, -88, 22, -172, -84, true);
  squareSail(ctx, skin, accent, 12, 98, -200, -152, false);
  squareSail(ctx, skin, accent, 6, 102, -146, -78, false);

  drawEmblem(ctx, skin);
}

/** One yard with one billowed course under it, between two heights. */
function squareSail(
  ctx: CanvasRenderingContext2D,
  skin: ShipSkin,
  accent: string,
  x0: number,
  x1: number,
  yardY: number,
  footY: number,
  band: boolean,
) {
  spar(ctx, x0, yardY, x1, yardY, 5);
  const mid = (x0 + x1) / 2;
  const belly = (footY - yardY) * 0.16;

  ctx.fillStyle = skin.sail;
  ctx.beginPath();
  ctx.moveTo(x0 + 2, yardY + 2);
  ctx.quadraticCurveTo(mid, yardY + 16, x1 - 2, yardY + 2);
  ctx.lineTo(x1 - 6, footY);
  ctx.quadraticCurveTo(mid, footY + belly, x0 + 6, footY - 2);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = skin.sailShade;
  ctx.beginPath();
  ctx.moveTo(mid + 4, yardY + 10);
  ctx.quadraticCurveTo(x1 - 12, yardY + 8, x1 - 2, yardY + 2);
  ctx.lineTo(x1 - 6, footY);
  ctx.quadraticCurveTo(mid + 12, footY + belly * 0.6, mid, footY + belly * 0.4);
  ctx.closePath();
  ctx.fill();

  if (band) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(x0 + 6, (yardY + footY) / 2 - 8);
    ctx.quadraticCurveTo(mid, (yardY + footY) / 2, x1 - 6, (yardY + footY) / 2 - 8);
    ctx.stroke();
  }
}

/**
 * A tall ship: one heavy mast, a topsail stacked over the course, a crow's
 * nest between them, and (through RIGS) the highest stern castle of the six.
 */
function rigGalleon(ctx: CanvasRenderingContext2D, skin: ShipSkin, accent: string) {
  spar(ctx, -12, -40, -12, -242, 12);

  ctx.strokeStyle = 'rgba(60, 44, 26, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-12, -230);
  ctx.lineTo(88, -46);
  ctx.moveTo(-12, -230);
  ctx.lineTo(-88, -46);
  ctx.stroke();

  squareSail(ctx, skin, accent, -52, 40, -238, -198, false);

  // Crow's nest, sitting between the two sails where it will actually read.
  ctx.fillStyle = '#4a361f';
  ctx.beginPath();
  ctx.moveTo(-36, -190);
  ctx.lineTo(12, -190);
  ctx.lineTo(6, -212);
  ctx.lineTo(-30, -212);
  ctx.closePath();
  ctx.fill();

  squareSail(ctx, skin, accent, -88, 72, -182, -72, true);

  drawEmblem(ctx, skin);

  // Spritsail, slung under the bowsprit. Nothing else has one.
  ctx.fillStyle = skin.sailShade;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(88, -64);
  ctx.lineTo(146, -84);
  ctx.lineTo(142, -50);
  ctx.lineTo(90, -44);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * Canvas that gave up some years ago.
 *
 * The hem is a zigzag and the two holes are real holes -- punched with the
 * even-odd fill rule so the sky shows through them rather than being painted
 * over in a colour that only matches one background.
 */
function rigTattered(ctx: CanvasRenderingContext2D, skin: ShipSkin, accent: string) {
  spar(ctx, -12, -40, -12, -234, 8);
  spar(ctx, -84, -196, 62, -214, 6);

  // Loose rigging, hanging rather than tensioned.
  ctx.strokeStyle = 'rgba(60, 44, 26, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-12, -224);
  ctx.quadraticCurveTo(24, -150, -46, -58);
  ctx.moveTo(-12, -210);
  ctx.quadraticCurveTo(52, -160, 74, -52);
  ctx.stroke();

  ctx.save();
  ctx.globalAlpha = 0.84;
  ctx.fillStyle = skin.sail;
  ctx.beginPath();
  ctx.moveTo(-82, -196);
  ctx.quadraticCurveTo(-12, -180, 60, -212);
  ctx.lineTo(56, -104);
  ctx.lineTo(40, -78);
  ctx.lineTo(28, -112);
  ctx.lineTo(10, -70);
  ctx.lineTo(-4, -106);
  ctx.lineTo(-22, -66);
  ctx.lineTo(-38, -102);
  ctx.lineTo(-54, -74);
  ctx.lineTo(-70, -106);
  ctx.closePath();
  // Two subpaths wound into the same fill: even-odd leaves them empty.
  ctx.moveTo(-36, -176);
  ctx.arc(-46, -176, 10, 0, Math.PI * 2);
  ctx.moveTo(46, -140);
  ctx.arc(34, -140, 12, 0, Math.PI * 2);
  ctx.fill('evenodd');
  ctx.restore();

  // What is left of the band, in two pieces.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 7;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(-74, -158);
  ctx.lineTo(-24, -160);
  ctx.moveTo(4, -162);
  ctx.lineTo(50, -168);
  ctx.stroke();
  ctx.lineCap = 'round';

  drawEmblem(ctx, skin);
}

// -- the hull ---------------------------------------------------------------

/**
 * The barrel's steel, built once per canvas.
 *
 * The hull is baked into a sprite; the barrel is not, because it turns. That
 * left this gradient being rebuilt for every ship on every frame -- a fixed
 * three-stop ramp between two fixed points, recomputed a few hundred times a
 * second to produce the same ramp.
 *
 * Keyed on the context rather than held in a single module-level variable: a
 * CanvasGradient belongs to the context that made it, and the ship portraits
 * in the menu each draw onto a canvas of their own.
 */
const barrelCache = new WeakMap<CanvasRenderingContext2D, CanvasGradient>();

function barrelGradient(ctx: CanvasRenderingContext2D): CanvasGradient {
  let g = barrelCache.get(ctx);
  if (!g) {
    // Local to the barrel's own rotated frame, so the same ramp is correct
    // whichever way it is pointing and wherever the ship has drifted to.
    g = ctx.createLinearGradient(0, -9, 0, 9);
    g.addColorStop(0, '#6b7280');
    g.addColorStop(0.45, '#374151');
    g.addColorStop(1, '#111827');
    barrelCache.set(ctx, g);
  }
  return g;
}

function paintBody(ctx: CanvasRenderingContext2D, skin: ShipSkin, accent: string) {
  const spec = RIGS[skin.rig];
  const halfW = BALANCE.HULL_W / 2;
  const top = -44;
  const keel = 26;

  const body = ctx.createLinearGradient(0, top, 0, keel);
  body.addColorStop(0, skin.hull);
  body.addColorStop(1, skin.hullDark);
  ctx.fillStyle = body;
  hullPath(ctx, 1, skin.shape);
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
  if (spec.castle > 0) {
    const peak = top - 8 - spec.castle;
    ctx.fillStyle = skin.hullDark;
    ctx.beginPath();
    ctx.moveTo(-halfW, top - 8);
    ctx.lineTo(-halfW, peak);
    ctx.lineTo(-halfW + 54, peak + 10);
    ctx.lineTo(-halfW + 54, top - 8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = skin.trim;
    ctx.fillRect(-halfW + 4, peak + 16, 46, 5);
    // A tall castle gets a window, because a fifty-pixel wall of flat colour
    // stops reading as a building.
    if (spec.castle > 60) {
      ctx.fillStyle = 'rgba(12, 10, 8, 0.6)';
      ctx.fillRect(-halfW + 12, peak + 28, 30, 14);
    }
  }

  // Bowsprit.
  if (spec.bowsprit > 0) {
    spar(ctx, halfW - 14, top - 4, halfW + spec.bowsprit, top - spec.bowsprit * 0.52, 7);
  }

  // Waterline shadow, so the hull sits in the sea instead of on it.
  ctx.fillStyle = 'rgba(6, 24, 42, 0.35)';
  ctx.beginPath();
  ctx.ellipse(0, keel - 2, halfW * 0.92, 9, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawEmblem(ctx: CanvasRenderingContext2D, skin: ShipSkin) {
  if (skin.emblem === 'none') return;
  const at = RIGS[skin.rig].emblem;
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.scale(at.scale, at.scale);
  ctx.fillStyle = 'rgba(24, 22, 30, 0.72)';
  ctx.strokeStyle = 'rgba(24, 22, 30, 0.72)';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';

  if (skin.emblem === 'skull') {
    ctx.beginPath();
    ctx.arc(0, -6, 19, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-11, 10, 22, 11);
    ctx.fillStyle = skin.sail;
    ctx.beginPath();
    ctx.arc(-7, -8, 5, 0, Math.PI * 2);
    ctx.arc(7, -8, 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (skin.emblem === 'cross') {
    ctx.beginPath();
    ctx.moveTo(-16, -16);
    ctx.lineTo(16, 16);
    ctx.moveTo(16, -16);
    ctx.lineTo(-16, 16);
    ctx.stroke();
  } else if (skin.emblem === 'moon') {
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0.5, 5.1);
    ctx.arc(9, -3, 17, 4.9, 0.9, true);
    ctx.fill();
  } else if (skin.emblem === 'star') {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 21 : 9;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  } else if (skin.emblem === 'bug') {
    // The Tester badge's own mark: a beetle, legs and all.
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(0, 4, 13, 17, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, -16, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    for (const side of [-1, 1]) {
      for (const y of [-4, 5, 14]) {
        ctx.moveTo(side * 11, y);
        ctx.lineTo(side * 22, y - 5 + (y > 5 ? 8 : 0));
      }
      ctx.moveTo(side * 4, -22);
      ctx.lineTo(side * 11, -31);
    }
    ctx.stroke();
    ctx.strokeStyle = skin.sail;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(0, 20);
    ctx.stroke();
  } else if (skin.emblem === 'bolt') {
    ctx.beginPath();
    ctx.moveTo(6, -26);
    ctx.lineTo(-13, 3);
    ctx.lineTo(-1, 3);
    ctx.lineTo(-7, 26);
    ctx.lineTo(14, -5);
    ctx.lineTo(2, -5);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(0, -20);
    ctx.lineTo(0, 16);
    ctx.moveTo(-14, -8);
    ctx.lineTo(14, -8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 8, 15, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }
  ctx.restore();
}
