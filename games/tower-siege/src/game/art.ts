/**
 * Everything that puts pixels on the canvas.
 *
 * The ground, the path and the plot grid never change, so they are baked once
 * into an offscreen canvas and blitted — painting a hundred and seventy-six
 * tiles with their edging twice a frame is exactly the kind of thing that
 * turns a cheap phone into a slideshow, and it is the same trick the rest of
 * the platform uses for its backdrops.
 *
 * Towers and enemies are baked per kind and per level, then drawn as sprites
 * with only their rotation live. A ballista is thirty-odd paths; four keeps'
 * worth of them redrawn every frame is not affordable and is not necessary.
 */
import {
  COLS,
  KEEP,
  PATH,
  ROWS,
  WORLD_H,
  WORLD_W,
  centreOf,
  isBuildable,
} from './map';
import { ENEMIES, TILE, TOWERS, mulberry32 } from './rules';
import type { EnemyId, TowerId } from './rules';

const GROUND_SEED = 0x9e3779b1;

/** The road's width, and the darker rut down the middle of it. */
const ROAD_W = TILE * 0.74;

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ── the ground ─────────────────────────────────────────────────────────────

let ground: HTMLCanvasElement | null = null;

/**
 * Grass, road and plots, baked once for the whole session.
 *
 * Every keep on screen is the same map, so this is one bitmap shared by all
 * four of them rather than one each.
 */
export function bakeGround(): HTMLCanvasElement | null {
  if (ground) return ground;
  try {
    const c = document.createElement('canvas');
    c.width = WORLD_W;
    c.height = WORLD_H;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    paintGround(ctx);
    ground = c;
    return c;
  } catch {
    return null;
  }
}

function paintGround(ctx: CanvasRenderingContext2D) {
  const rnd = mulberry32(GROUND_SEED);

  // Turf, with a slow gradient so the far end of the map reads as further off
  // rather than as the same green repeated a hundred and seventy-six times.
  const turf = ctx.createLinearGradient(0, 0, 0, WORLD_H);
  turf.addColorStop(0, '#2f5d3a');
  turf.addColorStop(0.55, '#28513a');
  turf.addColorStop(1, '#1e4232');
  ctx.fillStyle = turf;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // Tufts. Cheap, and they are what stops the turf reading as felt.
  for (let i = 0; i < 520; i++) {
    const x = rnd() * WORLD_W;
    const y = rnd() * WORLD_H;
    const len = 3 + rnd() * 5;
    ctx.strokeStyle = `rgba(${120 + rnd() * 40 | 0}, ${170 + rnd() * 50 | 0}, ${110 + rnd() * 40 | 0}, ${0.1 + rnd() * 0.14})`;
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 3, y - len);
    ctx.stroke();
  }

  // The road. Drawn as one stroked polyline with round joins, so a corner is
  // a corner rather than two squares meeting at a notch.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.strokeStyle = '#20362b';
  ctx.lineWidth = ROAD_W + 10;
  strokeRoute(ctx);

  ctx.strokeStyle = '#8a7a5e';
  ctx.lineWidth = ROAD_W;
  strokeRoute(ctx);

  ctx.strokeStyle = '#9c8c6d';
  ctx.lineWidth = ROAD_W - 12;
  strokeRoute(ctx);

  // Ruts, so the road reads as walked rather than paved.
  ctx.strokeStyle = 'rgba(90, 76, 54, 0.45)';
  ctx.lineWidth = 3;
  ctx.setLineDash([16, 13]);
  strokeRoute(ctx);
  ctx.setLineDash([]);

  // Gravel along the road, clipped to it so none of it lands on the turf.
  ctx.save();
  ctx.lineWidth = ROAD_W;
  ctx.beginPath();
  routePath(ctx);
  ctx.stroke();
  for (let i = 0; i < 260; i++) {
    const t = rnd();
    const seg = Math.min(PATH.length - 2, Math.floor(t * (PATH.length - 1)));
    const a = PATH[seg];
    const b = PATH[seg + 1];
    const f = rnd();
    const x = a.x + (b.x - a.x) * f + (rnd() - 0.5) * ROAD_W * 0.8;
    const y = a.y + (b.y - a.y) * f + (rnd() - 0.5) * ROAD_W * 0.8;
    ctx.fillStyle = `rgba(${110 + rnd() * 50 | 0}, ${98 + rnd() * 40 | 0}, ${74 + rnd() * 30 | 0}, 0.5)`;
    ctx.beginPath();
    ctx.arc(x, y, 1 + rnd() * 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Plots. A faint dashed square on every buildable tile so a player can see
  // where a tower may go without having to pick one up and find out.
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!isBuildable(c, r)) continue;
      const x = c * TILE;
      const y = r * TILE;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
      rounded(ctx, x + 5, y + 5, TILE - 10, TILE - 10, 8);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  drawBreach(ctx);
}

function routePath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(PATH[0].x, PATH[0].y);
  for (let i = 1; i < PATH.length; i++) ctx.lineTo(PATH[i].x, PATH[i].y);
}

function strokeRoute(ctx: CanvasRenderingContext2D) {
  routePath(ctx);
  ctx.stroke();
}

/** Where the enemies come in. Broken wall, so the entrance reads as a breach. */
function drawBreach(ctx: CanvasRenderingContext2D) {
  const y = PATH[0].y;
  ctx.save();
  ctx.fillStyle = '#3a3a44';
  ctx.fillRect(0, y - TILE * 1.5, 14, TILE);
  ctx.fillRect(0, y + TILE * 0.5, 14, TILE);
  ctx.fillStyle = '#22222a';
  ctx.fillRect(0, y - TILE * 1.5, 14, 6);
  ctx.fillRect(0, y + TILE * 1.4, 14, 6);
  ctx.restore();
}

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
  const grow = 1 + level * 0.09;
  const r = 19 * grow;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.beginPath();
  ctx.ellipse(0, 9, r * 1.1, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Plinth.
  const stone = ctx.createLinearGradient(0, -r, 0, r);
  stone.addColorStop(0, '#8d8778');
  stone.addColorStop(1, '#4e4a42');
  ctx.fillStyle = stone;
  ctx.beginPath();
  ctx.ellipse(0, 4, r, r * 0.62, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Body, in the tower's own colour so the five are told apart at a glance.
  const body = ctx.createLinearGradient(0, -r, 0, 8);
  body.addColorStop(0, meta.trim);
  body.addColorStop(1, meta.hue);
  ctx.fillStyle = body;
  rounded(ctx, -r * 0.62, -r * 0.72, r * 1.24, r * 1.3, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Level pips, so an upgraded tower is visibly upgraded without being
  // selected. R-S2: a small map has to stay readable late.
  for (let i = 0; i <= level; i++) {
    ctx.fillStyle = '#ffe9a8';
    ctx.beginPath();
    ctx.arc(-6 + i * 6, r * 0.62, 2.3, 0, Math.PI * 2);
    ctx.fill();
  }
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

  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(0, r * 0.62, r * 0.9, r * 0.36, 0, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.2, 0, 0, r * 1.1);
  body.addColorStop(0, meta.trim);
  body.addColorStop(1, meta.body);
  ctx.fillStyle = body;

  if (kind === 'flyer') {
    // Wings, so it reads as airborne at a glance and not merely as a fast
    // grunt in a different colour.
    ctx.fillStyle = 'rgba(200, 195, 255, 0.55)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.2, -r * 0.75, r * 0.95, r * 0.42, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-r * 0.2, r * 0.75, r * 0.95, r * 0.42, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.95, r * 0.68, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'boss') {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    // Plates, and two eyes that make it obviously the thing to worry about.
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(-r * 0.1, 0, r * (0.4 + i * 0.25), -1.1, 1.1);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffd36e';
    ctx.beginPath();
    ctx.arc(r * 0.42, -r * 0.28, r * 0.13, 0, Math.PI * 2);
    ctx.arc(r * 0.42, r * 0.28, r * 0.13, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'brute') {
    // Square-shouldered, because it is the armoured one and a circle would
    // read as "big grunt" rather than as a different problem.
    rounded(ctx, -r * 0.85, -r * 0.85, r * 1.7, r * 1.7, r * 0.4);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    rounded(ctx, -r * 0.5, -r * 0.62, r, r * 0.4, 4);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.95, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Armour studs, so "this one shrugs off arrows" is visible rather than a
  // number in a panel nobody opens mid-wave.
  if (meta.armour >= 5) {
    ctx.fillStyle = 'rgba(230, 240, 255, 0.8)';
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62, 1.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

/** Reset every baked sprite. Only used when the tab regains a lost context. */
export function dropCaches() {
  ground = null;
  towerCache.clear();
  enemyCache.clear();
}
