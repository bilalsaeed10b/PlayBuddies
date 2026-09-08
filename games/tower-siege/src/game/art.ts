/**
 * Towers, enemies and the keep - everything drawn every frame.
 *
 * The ground they stand on is a separate job on a separate schedule and lives
 * in ground.ts: baked once, blitted from then on. What is here is baked per
 * kind and per level and blitted too, with only the parts that actually move
 * drawn live on top - a turret tracking a runner, a keep burning. A ballista
 * is thirty-odd paths, and four keeps' worth of them repainted sixty times a
 * second is not affordable and is not necessary.
 */
import { KEEP, centreOf } from './map';
import { ENEMIES, TILE, TOWERS } from './rules';
import type { EnemyId, TowerId } from './rules';
import { rounded } from './ground';

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
  ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + TILE * 0.34, TILE * 0.78, TILE * 0.24, 0, 0, Math.PI * 2);
  ctx.fill();

  const stone = ctx.createLinearGradient(x, y, x, y + h);
  stone.addColorStop(0, '#8b93a3');
  stone.addColorStop(0.5, '#69707e');
  stone.addColorStop(1, '#474d59');
  ctx.fillStyle = stone;
  rounded(ctx, x, y, w, h, 8);
  ctx.fill();

  // Battlements.
  ctx.fillStyle = '#7b8391';
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(x + 4 + i * (w - 8) / 4, y - 12, (w - 8) / 4 - 5, 14);
  }

  // Gate, and the courses of stone.
  ctx.fillStyle = '#2f333c';
  rounded(ctx, p.x - 13, y + h - 34, 26, 34, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.lineWidth = 1.5;
  for (let i = 1; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(x + 3, y + (h / 5) * i);
    ctx.lineTo(x + w - 3, y + (h / 5) * i);
    ctx.stroke();
  }

  // Damage: scorch, then flame. A keep on its last life is unmistakable from
  // the other side of the room, which is the entire point of drawing it.
  if (hurt > 0.15) {
    ctx.fillStyle = `rgba(30, 20, 18, ${Math.min(0.55, hurt * 0.7)})`;
    rounded(ctx, x, y + h * 0.35, w, h * 0.65, 8);
    ctx.fill();
  }
  if (hurt > 0.5) {
    const flames = Math.round((hurt - 0.5) * 10);
    for (let i = 0; i < flames; i++) {
      const fx = x + 8 + ((i * 37) % (w - 16));
      const wob = Math.sin(clock * 7 + i * 1.9) * 4;
      const tall = 16 + Math.sin(clock * 9 + i) * 7 + hurt * 12;
      const g = ctx.createLinearGradient(fx, y - tall, fx, y + 6);
      g.addColorStop(0, 'rgba(255, 214, 120, 0)');
      g.addColorStop(0.45, 'rgba(255, 168, 60, 0.85)');
      g.addColorStop(1, 'rgba(220, 70, 30, 0.9)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(fx - 6, y + 6);
      ctx.quadraticCurveTo(fx - 3 + wob, y - tall * 0.5, fx + wob, y - tall);
      ctx.quadraticCurveTo(fx + 3 + wob, y - tall * 0.5, fx + 6, y + 6);
      ctx.closePath();
      ctx.fill();
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

  // A long soft shadow, thrown the same way as every tree's — one light
  // source across the whole board is most of what makes a flat top-down scene
  // read as having depth at all.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
  ctx.beginPath();
  ctx.ellipse(5, 10, r * 1.15, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // A stone footing, then the shaft above it, so the tower has a base it
  // stands on rather than being a token laid on the grass.
  const foot = ctx.createLinearGradient(0, -r * 0.4, 0, r * 0.8);
  foot.addColorStop(0, '#8e8879');
  foot.addColorStop(0.6, '#665f52');
  foot.addColorStop(1, '#3f3a32');
  ctx.fillStyle = foot;
  ctx.beginPath();
  ctx.ellipse(0, 7, r, r * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.32)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Blocks around the rim of the footing. Cheap, and it is what turns a grey
  // ellipse into masonry.
  const blocks = 9;
  for (let i = 0; i < blocks; i++) {
    const a = (i / blocks) * Math.PI * 2;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * r * 0.78, 7 + Math.sin(a) * r * 0.46, 4.5, 3, a, 0, Math.PI * 2);
    ctx.fill();
  }

  // The shaft, in the tower's own colour, so the five kinds are told apart at
  // a glance without reading anything.
  const body = ctx.createLinearGradient(-r * 0.5, -r * 0.9, r * 0.5, r * 0.4);
  body.addColorStop(0, meta.trim);
  body.addColorStop(0.5, meta.hue);
  body.addColorStop(1, shade(meta.hue, 0.62));
  ctx.fillStyle = body;
  rounded(ctx, -r * 0.56, -r * 0.86, r * 1.12, r * 1.32, 7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.38)';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // A lit edge down one side, matching the shadow's direction.
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  rounded(ctx, -r * 0.5, -r * 0.8, r * 0.3, r * 1.18, 5);
  ctx.fill();

  // Level pips on the footing: an upgraded tower has to be visibly upgraded
  // without being selected (REQUIREMENTS S2).
  for (let i = 0; i <= level; i++) {
    ctx.fillStyle = '#ffe07a';
    ctx.beginPath();
    ctx.arc(-7 + i * 7, r * 0.66, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Darken a hex colour toward black by `k`. Used for the shaded face. */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `rgb(${r}, ${g}, ${b})`;
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
  ctx.translate(kick, -6);

  if (kind === 'arrow') {
    ctx.fillStyle = '#5e4526';
    rounded(ctx, -4 * g, -3.5 * g, 22 * g, 7 * g, 3);
    ctx.fill();
    ctx.fillStyle = meta.trim;
    ctx.beginPath();
    ctx.moveTo(18 * g, 0);
    ctx.lineTo(10 * g, -5 * g);
    ctx.lineTo(10 * g, 5 * g);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'cannon') {
    ctx.fillStyle = '#2f343c';
    rounded(ctx, -6 * g, -6 * g, 26 * g, 12 * g, 6);
    ctx.fill();
    ctx.fillStyle = '#767f8c';
    ctx.beginPath();
    ctx.arc(19 * g, 0, 6.2 * g, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#151a20';
    ctx.beginPath();
    ctx.arc(20 * g, 0, 3.6 * g, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'frost') {
    // A floating shard rather than a barrel: it does not fire so much as
    // radiate, and a gun barrel would say the wrong thing about it.
    const bob = Math.sin(clock * 2.2) * 2;
    ctx.rotate(clock * 0.8);
    ctx.fillStyle = meta.trim;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const rr = (i % 2 === 0 ? 11 : 6) * g;
      const px = Math.cos(a) * rr;
      const py = Math.sin(a) * rr + bob;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  } else if (kind === 'tesla') {
    ctx.strokeStyle = '#8e7cc8';
    ctx.lineWidth = 3 * g;
    ctx.beginPath();
    ctx.moveTo(0, 4 * g);
    ctx.lineTo(0, -10 * g);
    ctx.stroke();
    // Coil rings, and a spark between them that gets brighter as it charges.
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = i === 2 ? meta.trim : '#6f5fae';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, -2 * g - i * 4 * g, (7 - i * 1.5) * g, 2.6 * g, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const spark = 0.35 + Math.abs(Math.sin(clock * 6)) * 0.65;
    ctx.fillStyle = `rgba(220, 210, 255, ${spark})`;
    ctx.beginPath();
    ctx.arc(0, -13 * g, 3.4 * g, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Ballista: a bow across a stock, and the stock slides back on recoil.
    ctx.fillStyle = '#4a3320';
    rounded(ctx, -8 * g, -3 * g, 26 * g, 6 * g, 2);
    ctx.fill();
    ctx.strokeStyle = meta.trim;
    ctx.lineWidth = 3 * g;
    ctx.beginPath();
    ctx.arc(9 * g, 0, 11 * g, -1.15, 1.15);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(240,230,210,0.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(13.4 * g, -10 * g);
    ctx.lineTo(2 * g - recoil * 5, 0);
    ctx.lineTo(13.4 * g, 10 * g);
    ctx.stroke();
  }

  // Muzzle flash, drawn last so it sits over whatever fired it.
  if (recoil > 0.15 && kind !== 'frost' && kind !== 'tesla') {
    ctx.globalAlpha = recoil;
    ctx.fillStyle = '#ffe6a8';
    ctx.beginPath();
    ctx.arc(24 * g, 0, 5 * g * recoil, 0, Math.PI * 2);
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
    const size = Math.ceil(meta.size * 3.2);
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

function paintEnemy(ctx: CanvasRenderingContext2D, kind: EnemyId) {
  const meta = ENEMIES[kind];
  const r = meta.size;

  // Cast the same way as everything else on the board.
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(r * 0.22, r * 0.68, r * 0.92, r * 0.36, 0, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createRadialGradient(-r * 0.34, -r * 0.4, r * 0.14, 0, 0, r * 1.15);
  body.addColorStop(0, meta.trim);
  body.addColorStop(0.55, meta.body);
  body.addColorStop(1, shade(meta.body, 0.6));

  if (kind === 'flyer') {
    // Wings, so it reads as airborne at a glance rather than as a fast grunt
    // in a different colour — the one thing a player must not misread, since
    // half the towers cannot touch it.
    ctx.fillStyle = 'rgba(205, 198, 255, 0.5)';
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(-r * 0.24, sgn * r * 0.8, r * 1.02, r * 0.44, sgn * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(160, 150, 235, 0.7)';
    ctx.lineWidth = 1.4;
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(-r * 0.24, sgn * r * 0.8, r * 1.02, r * 0.44, sgn * 0.55, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.98, r * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'boss') {
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    // Horns and plating. It has to be obviously the thing to worry about from
    // the moment it comes through the breach.
    ctx.fillStyle = shade(meta.body, 0.55);
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(r * 0.16, sgn * r * 0.62);
      ctx.quadraticCurveTo(r * 0.95, sgn * r * 1.15, r * 1.28, sgn * r * 0.72);
      ctx.quadraticCurveTo(r * 0.85, sgn * r * 0.82, r * 0.4, sgn * r * 0.38);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(-r * 0.12, 0, r * (0.38 + i * 0.24), -1.15, 1.15);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffd36e';
    ctx.beginPath();
    ctx.arc(r * 0.46, -r * 0.28, r * 0.14, 0, Math.PI * 2);
    ctx.arc(r * 0.46, r * 0.28, r * 0.14, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'brute') {
    // Square-shouldered, because it is the armoured one. A circle would read
    // as "big grunt" rather than as a different problem needing a different
    // answer.
    ctx.fillStyle = body;
    rounded(ctx, -r * 0.88, -r * 0.88, r * 1.76, r * 1.76, r * 0.36);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    rounded(ctx, -r * 0.55, -r * 0.66, r * 1.1, r * 0.42, 4);
    ctx.fill();
    // A shield on the leading face, which is the bit the towers are shooting.
    ctx.fillStyle = shade(meta.body, 0.5);
    rounded(ctx, r * 0.42, -r * 0.6, r * 0.4, r * 1.2, 4);
    ctx.fill();
  } else if (kind === 'warden') {
    // Angular: armoured like a brute but plainly quick, which is what makes it
    // the nastier of the two.
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(r * 0.24, -r * 0.86);
    ctx.lineTo(-r * 0.82, -r * 0.6);
    ctx.lineTo(-r * 0.82, r * 0.6);
    ctx.lineTo(r * 0.24, r * 0.86);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(r * 0.9, 0);
    ctx.lineTo(r * 0.2, -r * 0.62);
    ctx.lineTo(-r * 0.2, 0);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.98, r * 0.86, 0, 0, Math.PI * 2);
    ctx.fill();
    // A snout toward the front, so a runner visibly points the way it is
    // going and a rank of them reads as marching rather than as beads.
    ctx.beginPath();
    ctx.ellipse(r * 0.7, 0, r * 0.34, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Armour studs, so "this one shrugs off arrows" is visible on the board
  // rather than a number in a panel nobody opens mid-wave.
  if (meta.armour >= 5) {
    ctx.fillStyle = 'rgba(232, 242, 255, 0.85)';
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.42)';
  ctx.lineWidth = 1.7;
  ctx.stroke();
}

/** Reset every baked sprite. Only used when a tab regains a lost context. */
export function dropCaches() {
  towerCache.clear();
  enemyCache.clear();
}
