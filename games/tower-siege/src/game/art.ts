/**
 * Towers, enemies and the keep - everything drawn every frame.
 *
 * The ground they stand on is a separate job on a separate schedule and lives
 * in ground.ts: baked once, blitted from then on. What is here is baked per
 * kind and per level and blitted too, with only the parts that actually move
 * drawn live on top - a turret tracking a runner, a keep burning. A ballista
 * is thirty-odd paths, and four keeps' worth of them repainted sixty times a
 * second is not affordable and is not necessary.
 *
 * The style is the one set out in ground.ts: flat saturated colour, one lit
 * face, and a thick outline in the shape's own colour darkened. Two rules on
 * top of that, both about reading the board rather than about taste:
 *
 * - Every enemy has eyes, and they point the way it is going. A rank of
 *   eyeless discs reads as beads on a wire; the same discs with eyes read as
 *   something walking at your keep, and the direction is legible from across
 *   the room without anybody deciding to look for it.
 * - Silhouette carries the threat. A brute is square, a warden is a wedge, a
 *   flyer has wings. Colour alone would be doing that job, and colour is the
 *   first thing to go on a dim phone screen in daylight.
 */
import { KEEP, centreOf } from './map';
import { ENEMIES, TILE, TOWERS } from './rules';
import type { EnemyId, TowerId } from './rules';
import { PALETTE, blob, inked, rounded, shade, tint } from './ground';
import { mulberry32 } from './rules';

// ── the keep ───────────────────────────────────────────────────────────────

/**
 * The keep, drawn live because it changes: it visibly burns as lives run out,
 * which is the one piece of state a player must be able to read without
 * looking away from the board.
 */
export function drawKeep(ctx: CanvasRenderingContext2D, lives: number, maxLives: number, clock: number) {
  const p = centreOf(KEEP.col, KEEP.row);
  const hurt = 1 - Math.max(0, Math.min(1, lives / maxLives));
  const x = p.x - TILE * 0.7;
  const y = p.y - TILE * 1.1;
  const w = TILE * 1.4;
  const h = TILE * 1.5;

  ctx.save();

  // Shadow first, so the keep sits on the ground rather than floating over it.
  ctx.fillStyle = 'rgba(40, 80, 40, 0.3)';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + TILE * 0.36, TILE * 0.8, TILE * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();

  // Battlements, drawn before the body so the body's outline closes over
  // their feet and the whole thing reads as one carved block.
  for (let i = 0; i < 4; i++) {
    rounded(ctx, x + 3 + (i * (w - 6)) / 4, y - 15, (w - 6) / 4 - 5, 20, 3);
    inked(ctx, PALETTE.stoneMid, PALETTE.stoneDark, 3.5);
  }

  rounded(ctx, x, y, w, h, 9);
  inked(ctx, PALETTE.stone, PALETTE.stoneDark, 4);

  // The lit face down one side, flat and clipped to the wall.
  ctx.save();
  ctx.clip();
  ctx.fillStyle = PALETTE.stoneMid;
  ctx.fillRect(x + w * 0.62, y, w * 0.38, h);
  // Courses of stone: two short strokes per row rather than a ruled line, so
  // it reads as blocks and not as a ledger.
  ctx.strokeStyle = PALETTE.stoneDark;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.5;
  for (let i = 1; i < 5; i++) {
    const ly = y + (h / 5) * i;
    ctx.beginPath();
    ctx.moveTo(x, ly);
    ctx.lineTo(x + w, ly);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + (i % 2 === 0 ? w * 0.33 : w * 0.66), ly);
    ctx.lineTo(x + (i % 2 === 0 ? w * 0.33 : w * 0.66), ly + h / 5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // Gate: timber, banded, with a round arch. The one warm thing on a grey
  // building, which is what makes it read as the door rather than a window.
  rounded(ctx, p.x - 15, y + h - 38, 30, 38, 14);
  inked(ctx, PALETTE.wood, PALETTE.woodDark, 3.5);
  ctx.strokeStyle = PALETTE.woodDark;
  ctx.lineWidth = 2;
  for (const dy of [12, 24]) {
    ctx.beginPath();
    ctx.moveTo(p.x - 13, y + h - 38 + dy);
    ctx.lineTo(p.x + 13, y + h - 38 + dy);
    ctx.stroke();
  }

  // A flag on the pole, which animates for free off the clock and is the one
  // thing that says this building is still yours.
  const sway = Math.sin(clock * 2.4) * 3;
  ctx.strokeStyle = PALETTE.woodDark;
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(p.x, y - 15);
  ctx.lineTo(p.x, y - 44);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x, y - 42);
  ctx.quadraticCurveTo(p.x + 13, y - 39 + sway, p.x + 24, y - 35);
  ctx.lineTo(p.x + 24, y - 25);
  ctx.quadraticCurveTo(p.x + 13, y - 27 + sway, p.x, y - 26);
  ctx.closePath();
  inked(ctx, hurt > 0.5 ? '#f87171' : '#38bdf8', hurt > 0.5 ? '#991b1b' : '#0c4a6e', 2.5);

  // Damage: scorch, then flame. A keep on its last life is unmistakable from
  // the other side of the room, which is the entire point of drawing it.
  if (hurt > 0.15) {
    ctx.save();
    rounded(ctx, x, y, w, h, 9);
    ctx.clip();
    ctx.fillStyle = `rgba(48, 32, 30, ${Math.min(0.6, hurt * 0.75)})`;
    ctx.fillRect(x, y + h * 0.3, w, h * 0.7);
    ctx.restore();
  }
  if (hurt > 0.5) {
    const flames = Math.round((hurt - 0.5) * 10);
    for (let i = 0; i < flames; i++) {
      const fx = x + 10 + ((i * 37) % (w - 20));
      const wob = Math.sin(clock * 7 + i * 1.9) * 5;
      const tall = 18 + Math.sin(clock * 9 + i) * 8 + hurt * 14;
      // Two flat teardrops, outer orange and inner yellow. A gradient flame is
      // a smudge; two stacked shapes is a flame in every cartoon ever drawn.
      for (const [k, colour] of [[1, '#fb923c'], [0.55, '#fde047']] as [number, string][]) {
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.moveTo(fx - 7 * k, y + 6);
        ctx.quadraticCurveTo(fx - 4 * k + wob, y - tall * k * 0.5, fx + wob * k, y - tall * k);
        ctx.quadraticCurveTo(fx + 4 * k + wob, y - tall * k * 0.5, fx + 7 * k, y + 6);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  ctx.restore();
}

// ── towers ─────────────────────────────────────────────────────────────────

/**
 * One sprite per tower per level, baked on first sight.
 *
 * The base is baked; the head is drawn live because it turns. Splitting them
 * is what lets a tower track a runner without repainting its own stonework
 * sixty times a second.
 */
const towerCache = new Map<string, HTMLCanvasElement>();
const SPRITE = TILE * 1.5;

export function towerBase(kind: TowerId, level: number): HTMLCanvasElement | null {
  const key = `${kind}:${level}`;
  const hit = towerCache.get(key);
  if (hit) return hit;
  try {
    const c = document.createElement('canvas');
    c.width = SPRITE;
    c.height = SPRITE;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.translate(SPRITE / 2, SPRITE / 2);
    paintTowerBase(ctx, kind, level);
    towerCache.set(key, c);
    return c;
  } catch {
    return null;
  }
}

function paintTowerBase(ctx: CanvasRenderingContext2D, kind: TowerId, level: number) {
  const meta = TOWERS[kind];
  const grow = 1 + level * 0.11;
  const r = 22 * grow;

  // A long soft shadow, thrown the same way as every tree's , one light
  // source across the whole board is most of what makes a flat top-down scene
  // read as having depth at all.
  ctx.fillStyle = 'rgba(40, 80, 40, 0.3)';
  ctx.beginPath();
  ctx.ellipse(6, 11, r * 1.15, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // A stone footing, then the shaft above it, so the tower has a base it
  // stands on rather than being a token laid on the grass.
  ctx.beginPath();
  ctx.ellipse(0, 8, r, r * 0.6, 0, 0, Math.PI * 2);
  inked(ctx, PALETTE.stone, PALETTE.stoneDark, 3.5);

  // Blocks around the rim of the footing, as flat wedges of the darker stone.
  // Cheap, and it is what turns a grey ellipse into masonry.
  const blocks = 8;
  ctx.fillStyle = PALETTE.stoneMid;
  for (let i = 0; i < blocks; i++) {
    if (i % 2 !== 0) continue;
    const a = (i / blocks) * Math.PI * 2;
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * r * 0.74, 8 + Math.sin(a) * r * 0.44, 5.5, 3.4, a, 0, Math.PI * 2);
    ctx.fill();
  }

  // The shaft, in the tower's own colour, so the five kinds are told apart at
  // a glance without reading anything. Flat body, flat lit stripe, dark line
  // around the lot.
  rounded(ctx, -r * 0.58, -r * 0.9, r * 1.16, r * 1.38, 8);
  inked(ctx, meta.hue, shade(meta.hue, 0.45), 3.5);
  ctx.save();
  rounded(ctx, -r * 0.58, -r * 0.9, r * 1.16, r * 1.38, 8);
  ctx.clip();
  ctx.fillStyle = tint(meta.hue, 0.32);
  ctx.fillRect(-r * 0.58, -r * 0.9, r * 0.36, r * 1.38);
  ctx.fillStyle = shade(meta.hue, 0.72);
  ctx.fillRect(r * 0.3, -r * 0.9, r * 0.28, r * 1.38);
  ctx.restore();

  // Level pips on the footing: an upgraded tower has to be visibly upgraded
  // without being selected (REQUIREMENTS S2). Stars rather than dots , three
  // gold dots in a row could be anything, three gold stars could not.
  for (let i = 0; i <= level; i++) {
    star(ctx, -8 + i * 8, r * 0.7, 4.6, 2.1);
    inked(ctx, '#ffd93d', '#a16207', 1.6);
  }
}

/** A five-pointed star at (x, y). Used for pips and for muzzle flashes. */
function star(ctx: CanvasRenderingContext2D, x: number, y: number, outer: number, inner: number, points = 5) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? outer : inner;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * The turning half: whatever a tower points at what it is shooting.
 *
 * Drawn in the tower's own rotated frame, so every one of these is written as
 * though it were pointing right.
 */
export function drawTowerHead(
  ctx: CanvasRenderingContext2D,
  kind: TowerId,
  level: number,
  recoil: number,
  clock: number,
) {
  const meta = TOWERS[kind];
  const g = 1 + level * 0.09;
  const kick = -recoil * 4;

  ctx.save();
  ctx.translate(kick, -7);
  ctx.lineJoin = 'round';

  if (kind === 'arrow') {
    // A bow stave with a nocked arrow: chunky, and unmistakably the cheap one.
    rounded(ctx, -5 * g, -4 * g, 23 * g, 8 * g, 4);
    inked(ctx, PALETTE.wood, PALETTE.woodDark, 2.5);
    ctx.beginPath();
    ctx.moveTo(21 * g, 0);
    ctx.lineTo(11 * g, -6.5 * g);
    ctx.lineTo(11 * g, 6.5 * g);
    ctx.closePath();
    inked(ctx, meta.trim, shade(meta.hue, 0.5), 2.5);
  } else if (kind === 'cannon') {
    rounded(ctx, -7 * g, -7 * g, 27 * g, 14 * g, 7);
    inked(ctx, meta.hue, shade(meta.hue, 0.4), 3);
    // A flared muzzle and a black bore. The flare is the whole reason a
    // cartoon cannon reads as a cannon from six feet away.
    ctx.beginPath();
    ctx.arc(20 * g, 0, 7.5 * g, 0, Math.PI * 2);
    inked(ctx, meta.trim, shade(meta.hue, 0.4), 3);
    ctx.fillStyle = '#1b2029';
    ctx.beginPath();
    ctx.arc(21 * g, 0, 4 * g, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'frost') {
    // A floating shard rather than a barrel: it does not fire so much as
    // radiate, and a gun barrel would say the wrong thing about it.
    const bob = Math.sin(clock * 2.2) * 2.5;
    ctx.rotate(clock * 0.7);
    ctx.translate(0, bob);
    star(ctx, 0, 0, 13 * g, 6 * g, 6);
    inked(ctx, '#bdf2ff', meta.hue, 3);
    ctx.globalAlpha = 0.9;
    star(ctx, 0, 0, 7 * g, 3 * g, 6);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (kind === 'tesla') {
    // A coil: a post, two flat rings and a ball that brightens as it charges.
    rounded(ctx, -2.5 * g, -11 * g, 5 * g, 16 * g, 2);
    inked(ctx, shade(meta.hue, 0.8), shade(meta.hue, 0.45), 2);
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.ellipse(0, -2 * g - i * 5 * g, (8.5 - i * 2) * g, 3.2 * g, 0, 0, Math.PI * 2);
      inked(ctx, meta.hue, shade(meta.hue, 0.45), 2.5);
    }
    const spark = 0.45 + Math.abs(Math.sin(clock * 6)) * 0.55;
    ctx.beginPath();
    ctx.arc(0, -14 * g, 5 * g, 0, Math.PI * 2);
    inked(ctx, meta.trim, shade(meta.hue, 0.45), 2.5);
    ctx.globalAlpha = spark;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, -14 * g, 3 * g, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  } else {
    // Ballista: a bow across a stock, and the stock slides back on recoil.
    rounded(ctx, -9 * g, -4 * g, 28 * g, 8 * g, 3);
    inked(ctx, PALETTE.wood, PALETTE.woodDark, 2.5);
    ctx.strokeStyle = shade(meta.hue, 0.55);
    ctx.lineWidth = 5 * g;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(9 * g, 0, 12 * g, -1.15, 1.15);
    ctx.stroke();
    ctx.strokeStyle = '#fff7e0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(13.9 * g, -11 * g);
    ctx.lineTo(2 * g - recoil * 6, 0);
    ctx.lineTo(13.9 * g, 11 * g);
    ctx.stroke();
    // The bolt riding the stock, so a loaded ballista looks loaded.
    if (recoil < 0.3) {
      ctx.beginPath();
      ctx.moveTo(22 * g, 0);
      ctx.lineTo(14 * g, -3.5 * g);
      ctx.lineTo(14 * g, 3.5 * g);
      ctx.closePath();
      inked(ctx, meta.trim, PALETTE.woodDark, 2);
    }
  }

  // Muzzle flash, drawn last so it sits over whatever fired it. A star, not a
  // blurred disc , a soft glow is a lens effect and this board has no lens.
  if (recoil > 0.15 && kind !== 'frost' && kind !== 'tesla') {
    ctx.globalAlpha = Math.min(1, recoil * 1.2);
    star(ctx, 26 * g, 0, 11 * g * recoil, 4.5 * g * recoil, 6);
    ctx.fillStyle = '#ffd93d';
    ctx.fill();
    star(ctx, 26 * g, 0, 6 * g * recoil, 2.4 * g * recoil, 6);
    ctx.fillStyle = '#fffbe8';
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

// ── enemies ────────────────────────────────────────────────────────────────

const enemyCache = new Map<EnemyId, HTMLCanvasElement>();

export function enemySprite(kind: EnemyId): HTMLCanvasElement | null {
  const hit = enemyCache.get(kind);
  if (hit) return hit;
  try {
    const meta = ENEMIES[kind];
    // Roomier than the body needs: the outline, the horns and a flyer's wings
    // all live outside the nominal radius, and a sprite clipped at its own
    // edge looks broken rather than tight.
    const size = Math.ceil(meta.size * 3.8);
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.translate(size / 2, size / 2);
    paintEnemy(ctx, kind);
    enemyCache.set(kind, c);
    return c;
  } catch {
    return null;
  }
}

/**
 * Two eyes looking the way the sprite faces, plus a highlight in each.
 *
 * The highlight is not decoration: a pupil with a white dot in it reads as
 * alive, and a flat black dot reads as a hole. It is one arc per eye and it is
 * the cheapest character in the whole file.
 */
function eyes(ctx: CanvasRenderingContext2D, x: number, spread: number, r: number, angry = false) {
  for (const sgn of [-1, 1] as const) {
    const cy = sgn * spread;
    // Dark disc first, white on top of it, pupil on top of that. Stroking the
    // white instead put a line *over* the eye, and once the pupil rode up
    // against that line the pair read as one dark crescent rather than as two
    // eyes , at the size these are actually drawn there is no room for a
    // pupil and an outline to share an edge.
    ctx.fillStyle = '#1b2433';
    ctx.beginPath();
    ctx.ellipse(x, cy, r * 1.16, r * 1.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(x, cy, r, r * 1.14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1b2433';
    ctx.beginPath();
    ctx.arc(x + r * 0.2, cy, r * 0.56, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x + r * 0.05, cy - r * 0.42, r * 0.26, 0, Math.PI * 2);
    ctx.fill();
  }
  // A brow over each eye turns "creature" into "creature that means it".
  if (angry) {
    ctx.strokeStyle = '#1b2433';
    ctx.lineWidth = Math.max(2, r * 0.5);
    ctx.lineCap = 'round';
    for (const sgn of [-1, 1] as const) {
      ctx.beginPath();
      ctx.moveTo(x - r * 1.1, sgn * (spread + r * 1.5));
      ctx.lineTo(x + r * 1.1, sgn * (spread + r * 0.5));
      ctx.stroke();
    }
  }
}

function paintEnemy(ctx: CanvasRenderingContext2D, kind: EnemyId) {
  const meta = ENEMIES[kind];
  const r = meta.size;
  const line = shade(meta.body, 0.42);
  const rnd = mulberry32(0x5eed + r);
  ctx.lineJoin = 'round';

  // Cast the same way as everything else on the board.
  ctx.fillStyle = 'rgba(30, 60, 36, 0.3)';
  ctx.beginPath();
  ctx.ellipse(r * 0.2, r * 0.72, r * 0.9, r * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();

  if (kind === 'flyer') {
    // Wings, so it reads as airborne at a glance rather than as a fast grunt
    // in a different colour , the one thing a player must not misread, since
    // half the towers cannot touch it.
    for (const sgn of [-1, 1] as const) {
      ctx.beginPath();
      ctx.ellipse(-r * 0.22, sgn * r * 0.85, r * 1.05, r * 0.46, sgn * 0.55, 0, Math.PI * 2);
      inked(ctx, '#e6ddff', shade(meta.body, 0.55), 2.5);
      // A rib down each wing. It is what stops them reading as ears.
      ctx.strokeStyle = shade(meta.body, 0.6);
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(-r * 0.9, sgn * r * 0.62);
      ctx.lineTo(r * 0.5, sgn * r * 1.02);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.74, 0, 0, Math.PI * 2);
    inked(ctx, meta.body, line, 3);
    bellyLight(ctx, meta, r * 0.95, r * 0.7);
    eyes(ctx, r * 0.3, r * 0.3, r * 0.26);
  } else if (kind === 'boss') {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    inked(ctx, meta.body, line, 4);
    bellyLight(ctx, meta, r, r);
    // Horns and plating. It has to be obviously the thing to worry about from
    // the moment it comes through the breach.
    for (const sgn of [-1, 1] as const) {
      ctx.beginPath();
      ctx.moveTo(r * 0.12, sgn * r * 0.64);
      ctx.quadraticCurveTo(r * 1.0, sgn * r * 1.22, r * 1.34, sgn * r * 0.74);
      ctx.quadraticCurveTo(r * 0.88, sgn * r * 0.84, r * 0.36, sgn * r * 0.36);
      ctx.closePath();
      inked(ctx, '#fef3c7', '#78350f', 3);
    }
    // Back plates, as flat scallops rather than stroked arcs.
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(-r * 0.15, 0, r * (0.4 + i * 0.22), -1.2, 1.2);
      ctx.strokeStyle = shade(meta.body, 0.62);
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    eyes(ctx, r * 0.5, r * 0.32, r * 0.21, true);
    // A mouth full of teeth. On the one enemy that ends a run, it is worth it.
    ctx.beginPath();
    ctx.moveTo(r * 0.72, -r * 0.14);
    ctx.lineTo(r * 0.96, 0);
    ctx.lineTo(r * 0.72, r * 0.14);
    ctx.closePath();
    inked(ctx, '#3b0a1e', '#1b0410', 1.6);
  } else if (kind === 'brute') {
    // Square-shouldered, because it is the armoured one. A circle would read
    // as "big grunt" rather than as a different problem needing a different
    // answer.
    rounded(ctx, -r * 0.9, -r * 0.9, r * 1.8, r * 1.8, r * 0.34);
    inked(ctx, meta.body, line, 3.5);
    ctx.save();
    rounded(ctx, -r * 0.9, -r * 0.9, r * 1.8, r * 1.8, r * 0.34);
    ctx.clip();
    ctx.fillStyle = tint(meta.body, 0.26);
    ctx.fillRect(-r * 0.9, -r * 0.9, r * 1.8, r * 0.55);
    ctx.restore();
    // A shield on the leading face, which is the bit the towers are shooting.
    rounded(ctx, r * 0.42, -r * 0.66, r * 0.44, r * 1.32, 5);
    inked(ctx, PALETTE.stone, PALETTE.stoneDark, 3);
    ctx.beginPath();
    ctx.arc(r * 0.64, 0, r * 0.14, 0, Math.PI * 2);
    inked(ctx, '#ffd93d', '#a16207', 2);
    eyes(ctx, r * 0.02, r * 0.36, r * 0.22, true);
  } else if (kind === 'warden') {
    // Angular: armoured like a brute but plainly quick, which is what makes it
    // the nastier of the two.
    ctx.beginPath();
    ctx.moveTo(r * 1.04, 0);
    ctx.lineTo(r * 0.24, -r * 0.9);
    ctx.lineTo(-r * 0.86, -r * 0.62);
    ctx.lineTo(-r * 0.86, r * 0.62);
    ctx.lineTo(r * 0.24, r * 0.9);
    ctx.closePath();
    inked(ctx, meta.body, line, 3.5);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = tint(meta.body, 0.3);
    ctx.beginPath();
    ctx.moveTo(r * 0.95, 0);
    ctx.lineTo(r * 0.2, -r * 0.66);
    ctx.lineTo(-r * 0.3, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // A crest, so the quick armoured one has its own outline in the rank.
    ctx.beginPath();
    ctx.moveTo(-r * 0.2, -r * 0.72);
    ctx.lineTo(-r * 0.05, -r * 1.2);
    ctx.lineTo(r * 0.16, -r * 0.6);
    ctx.closePath();
    inked(ctx, meta.trim, line, 2.5);
    eyes(ctx, r * 0.24, r * 0.3, r * 0.2, true);
  } else {
    // Runner and grunt: a plain body with a snout, so one reads as marching
    // and a rank of them does not read as beads.
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.9, 0, 0, Math.PI * 2);
    inked(ctx, meta.body, line, 3);
    bellyLight(ctx, meta, r, r * 0.9);
    ctx.beginPath();
    ctx.ellipse(r * 0.78, 0, r * 0.36, r * 0.32, 0, 0, Math.PI * 2);
    inked(ctx, tint(meta.body, 0.2), line, 2.5);
    // Two ears, which is most of what separates a runner from a grunt at a
    // glance now that they are the same shape.
    if (kind === 'runner') {
      for (const sgn of [-1, 1] as const) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.1, sgn * r * 0.55);
        ctx.lineTo(-r * 0.5, sgn * r * 1.2);
        ctx.lineTo(-r * 0.62, sgn * r * 0.5);
        ctx.closePath();
        inked(ctx, meta.trim, line, 2);
      }
    }
    eyes(ctx, r * 0.24, r * 0.34, r * 0.24, kind === 'grunt');
  }

  // Armour studs, so "this one shrugs off arrows" is visible on the board
  // rather than a number in a panel nobody opens mid-wave.
  if (meta.armour >= 5) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4 + rnd() * 0.1;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.66, Math.sin(a) * r * 0.66, 2.8, 0, Math.PI * 2);
      inked(ctx, '#e8f2ff', PALETTE.stoneDark, 1.6);
    }
  }
}

/** A flat lighter cap across the top of a body. One shape, clipped to it. */
function bellyLight(ctx: CanvasRenderingContext2D, meta: { body: string }, rx: number, ry: number) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = tint(meta.body, 0.28);
  blob(ctx, -rx * 0.2, -ry * 0.45, rx * 0.72, 0.55, 0.2, mulberry32(0x1234), 9);
  ctx.fill();
  ctx.restore();
}

/** Reset every baked sprite. Only used when a tab regains a lost context. */
export function dropCaches() {
  towerCache.clear();
  enemyCache.clear();
}
