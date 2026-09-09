/** Procedural special cinematics. All motion is a closed-form function of age
 * in seconds: no simulation writes, live particles, random draws or wall clock.
 * Draw in arena coordinates. Both entry points restore the caller's context.
 */
import type { Arena } from './rules';
import { clamp, mulberry32 } from './rules';
import type { Quality } from './quality';
import { fxSprites } from './sea';
import { SPECIALS } from './specials';

export interface SpecialVisual {
  kind: 'torpedo' | 'acid-rain' | 'heal';
  /** Seconds since activation. */
  age: number;
  duration: number;
  enemyTeam: 0 | 1;
  /** World coordinates at the hull's waterline, including its fleet row. */
  origin: { x: number; y: number };
  targets: { x: number; y: number }[];
}

type Effect = SpecialVisual | null | undefined;
type Sprite = HTMLCanvasElement | null;
const TAU = Math.PI * 2;
const SUNSET_END = 1.5;
const RAIN_END = 4.5;
const ACID_END = SPECIALS['acid-rain'].duration;
const smooth = (n: number) => { const t = clamp(n, 0, 1); return t * t * (3 - 2 * t); };
const fract = (n: number) => n - Math.floor(n);

// Prefix-stable: lowering quality removes decoration without moving survivors.
const field = new Float32Array(192 * 4);
const random = mulberry32(0x51ec1a1);
for (let i = 0; i < field.length; i++) field[i] = random();
const seed = (i: number, lane = 0) => field[(i % 192) * 4 + lane];
const budget = (q: Quality, count: number) => Math.max(1, Math.round(count * clamp(q.particles, 0, 1)));

function active(effect: Effect): effect is SpecialVisual {
  return !!effect && Number.isFinite(effect.age) && effect.age >= 0
    && effect.age < (effect.kind === 'acid-rain' ? ACID_END : effect.duration);
}

/** Pass this to sea.drawSky BEFORE the transparent backdrop. Exactly six
 * seconds: 0–1.5 sunset, 1.5–4.5 night/rain, 4.5–6 sunrise. */
export function specialNightAmount(effect: Effect): number {
  if (!active(effect) || effect.kind !== 'acid-rain') return 0;
  if (effect.age < SUNSET_END) return smooth(effect.age / SUNSET_END);
  if (effect.age <= RAIN_END) return 1;
  return 1 - smooth((effect.age - RAIN_END) / (ACID_END - RAIN_END));
}

/** After backdrop, waves and ordinary weather; BEFORE rocks and ships. */
export function drawSpecialSky(ctx: CanvasRenderingContext2D, arena: Arena, effect: Effect, q: Quality) {
  if (!active(effect) || effect.kind !== 'acid-rain') return;
  const night = specialNightAmount(effect);
  if (night <= 0) return;
  ctx.save();
  const alpha = ctx.globalAlpha;
  // Darken the original fair-weather clouds without touching the cached scene.
  // Its headlands, wave detail and any storm banks remain visible underneath.
  ctx.globalAlpha = alpha * night;
  ctx.fillStyle = 'rgba(3, 12, 33, 0.52)';
  ctx.fillRect(0, 0, arena.w, arena.seaY);
  ctx.fillStyle = 'rgba(2, 12, 28, 0.18)';
  ctx.fillRect(0, arena.seaY, arena.w, arena.h - arena.seaY);

  const moonLight = smooth((night - 0.28) / 0.72);
  const moonX = arena.w * (effect.enemyTeam === 1 ? 0.24 : 0.76);
  const moonY = arena.seaY * (0.24 + (1 - night) * 0.15);
  const moonR = arena.seaY * 0.065;
  ctx.globalAlpha = alpha * moonLight;
  ctx.fillStyle = '#d9f0ff';
  ctx.beginPath();
  for (let i = 0; i < budget(q, 54); i++) {
    const x = seed(i) * arena.w;
    const y = (0.06 + seed(i, 1) * 0.58) * arena.seaY;
    const r = 1 + seed(i, 2) * 1.6;
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, TAU);
  }
  ctx.fill();
  const art = sprites();
  if (q.fancy) glow(ctx, art.blue, moonX, moonY, moonR * 7, moonR * 7, 0.28);
  if (art.moon) ctx.drawImage(art.moon, moonX - moonR, moonY - moonR, moonR * 2, moonR * 2);
  else {
    ctx.beginPath(); ctx.arc(moonX, moonY, moonR, 0, TAU); ctx.fill();
  }
  // Broken moonlight, not a solid cone: broadens toward the viewer.
  ctx.strokeStyle = '#8ad7ef';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < (q.fancy ? 15 : 6); i++) {
    const t = i / (q.fancy ? 15 : 6);
    const y = arena.seaY + 6 + t * (arena.h - arena.seaY) * 0.68;
    const x = moonX + Math.sin(effect.age * 1.7 + i * 2.4) * (8 + t * 28);
    const length = 10 + t * 65;
    ctx.moveTo(x - length, y); ctx.lineTo(x + length, y);
  }
  ctx.globalAlpha = alpha * moonLight * 0.17;
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.globalAlpha = alpha;
  drawAcidClouds(ctx, arena, effect, q);
  if (effect.age >= SUNSET_END && effect.age < RAIN_END) {
    const rain = rainStrength(effect.age);
    // The denser veil sits behind the hulls; bright individual drops are in front.
    drawRain(ctx, arena, effect, q, false, rain);
    clipEnemy(ctx, arena, effect.enemyTeam);
    ctx.globalAlpha = alpha * rain;
    for (const target of effect.targets) {
      if (q.fancy) glow(ctx, art.green, target.x, target.y + 5, 380, 92, 0.5);
    }
  }
  ctx.restore();
}

/** AFTER ships, BEFORE floating damage text and HUD. */
export function drawSpecialForeground(ctx: CanvasRenderingContext2D, arena: Arena, effect: Effect, q: Quality) {
  if (!active(effect)) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (effect.kind === 'torpedo') drawTorpedo(ctx, arena, effect, q);
  else if (effect.kind === 'heal') drawHeal(ctx, effect, q);
  else if (effect.age >= SUNSET_END && effect.age < RAIN_END) {
    clipEnemy(ctx, arena, effect.enemyTeam);
    const strength = rainStrength(effect.age);
    drawRain(ctx, arena, effect, q, true, strength);
    drawAcidImpacts(ctx, effect, q, strength);
  }
  ctx.restore();
}

function clipEnemy(ctx: CanvasRenderingContext2D, arena: Arena, team: 0 | 1) {
  ctx.beginPath();
  ctx.rect(team === 0 ? 0 : arena.w / 2, 0, arena.w / 2, arena.h);
  ctx.clip();
}

function rainStrength(age: number) {
  return smooth((age - SUNSET_END) / 0.18) * (1 - smooth((age - (RAIN_END - 0.22)) / 0.22));
}

function drawAcidClouds(ctx: CanvasRenderingContext2D, arena: Arena, effect: SpecialVisual, q: Quality) {
  const amount = smooth(effect.age / 1.15) * (1 - smooth((effect.age - RAIN_END) / 1.3));
  if (amount <= 0) return;
  ctx.save();
  clipEnemy(ctx, arena, effect.enemyTeam);
  ctx.globalAlpha *= amount;
  const half = arena.w / 2;
  const x = effect.enemyTeam === 0 ? -half * 0.1 : half;
  const width = half * 1.1;
  const height = arena.seaY * 0.49;
  const descent = (1 - amount) * -90;
  const cloud = sprites().cloud;
  if (cloud) {
    ctx.drawImage(cloud, x + Math.sin(effect.age * 0.65) * 14, descent, width, height);
    if (q.fancy) {
      ctx.globalAlpha *= 0.68;
      ctx.drawImage(cloud, x + width * 0.18 - effect.age * 4, descent + height * 0.19, width * 0.88, height * 0.84);
    }
  } else {
    ctx.fillStyle = '#101f2b';
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const cx = x + width * i / 6;
      ctx.moveTo(cx + width * 0.17, height * 0.4);
      ctx.ellipse(cx, height * 0.4, width * 0.17, height * (0.22 + seed(i) * 0.12), 0, 0, TAU);
    }
    ctx.fill();
  }
  // A subdued green underside signals what the bank is carrying.
  if (q.fancy && effect.age >= SUNSET_END && effect.age < RAIN_END) {
    glow(ctx, sprites().green, x + width * 0.58, height * 0.76, width * 0.85, height * 0.42, 0.12);
  }
  ctx.restore();
}

function drawRain(ctx: CanvasRenderingContext2D, arena: Arena, effect: SpecialVisual, q: Quality, front: boolean, strength: number) {
  if (!effect.targets.length || strength <= 0) return;
  ctx.save();
  clipEnemy(ctx, arena, effect.enemyTeam);
  ctx.globalAlpha *= strength * (front ? 0.84 : 0.33);
  ctx.strokeStyle = front ? '#bdff79' : '#57d679';
  ctx.lineWidth = front ? 3.2 : 2.5;
  const count = budget(q, front ? 56 : 104);
  const startY = arena.seaY * 0.27;
  const half = arena.w / 2;
  const left = effect.enemyTeam === 0 ? 0 : half;
  ctx.beginPath();
  for (let n = 0; n < count; n++) {
    const i = n + (front ? 104 : 0);
    const target = effect.targets[n % effect.targets.length];
    const endY = Math.min(arena.h, target.y + 24);
    const travel = Math.max(1, endY - startY);
    const speed = 690 + seed(i, 1) * 450;
    const elapsed = effect.age - SUNSET_END;
    const p = fract(seed(i, 2) + elapsed * speed / travel);
    const y = startY + p * travel;
    // Most rain hits the actual fleet, with sparse streaks across its half.
    const endX = n % 4 === 0 ? left + seed(i) * half : target.x + (seed(i) - 0.5) * 330;
    const x = endX - (1 - p) * 44;
    const len = Math.min(18 + seed(i, 3) * (front ? 40 : 30), endY - y);
    ctx.moveTo(x, y);
    ctx.lineTo(x + len * 44 / travel, y + len);
  }
  ctx.stroke();
  ctx.restore();
}

function drawAcidImpacts(ctx: CanvasRenderingContext2D, effect: SpecialVisual, q: Quality, strength: number) {
  const alpha = ctx.globalAlpha;
  const impact = Math.max(0, 1 - Math.abs(effect.age - SPECIALS['acid-rain'].impact) / 0.24);
  for (let n = 0; n < effect.targets.length; n++) {
    const target = effect.targets[n];
    ctx.globalAlpha = alpha * strength;
    if (q.fancy && impact > 0) glow(ctx, sprites().green, target.x, target.y - 30, 330, 250, impact * 0.75);
    for (let i = 0; i < budget(q, 16); i++) {
      const k = i + n * 23;
      const p = fract((effect.age - SUNSET_END) * (1.3 + seed(k, 2)) + seed(k, 1));
      const x = target.x + (seed(k) - 0.5) * 290;
      const y = target.y + (seed(k, 3) - 0.5) * 27;
      ctx.globalAlpha = alpha * strength * (1 - p) * 0.8;
      ctx.strokeStyle = '#a4f976';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(x, y, 3 + p * 27, 2 + p * 8, 0, 0, TAU);
      ctx.stroke();
      if (p < 0.55) {
        ctx.strokeStyle = '#d8ff9c';
        ctx.beginPath();
        const rise = Math.sin(p / 0.55 * Math.PI) * (14 + seed(k, 2) * 20);
        ctx.moveTo(x - p * 20, y - rise);
        ctx.lineTo(x - p * 20 - 3, y - rise + 6);
        ctx.moveTo(x + p * 18, y - rise * 0.8);
        ctx.lineTo(x + p * 18 + 2, y - rise * 0.8 + 5);
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = alpha;
}

function drawTorpedo(ctx: CanvasRenderingContext2D, arena: Arena, effect: SpecialVisual, q: Quality) {
  const target = effect.targets[0];
  if (!target) return;
  const arrival = SPECIALS.torpedo.impact;
  if (effect.age >= arrival) {
    drawDetonation(ctx, target.x, target.y, effect.age - arrival, Math.max(0.01, effect.duration - arrival), q);
    return;
  }
  const t = effect.age / arrival;
  const dx = target.x - effect.origin.x;
  const dy = target.y - effect.origin.y;
  const distance = Math.hypot(dx, dy);
  const x = effect.origin.x + dx * t;
  const y = effect.origin.y + dy * t + 14;
  const angle = Math.atan2(dy, dx);
  ctx.save();
  // No airborne arc: its nose and widening V-wake skim the water.
  ctx.beginPath(); ctx.rect(0, arena.seaY - 4, arena.w, arena.h - arena.seaY + 4); ctx.clip();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const length = Math.min(distance * t, 330);
  const alpha = ctx.globalAlpha;
  if (q.fancy) glow(ctx, sprites().blue, -length * 0.3, 0, Math.max(80, length * 1.35), 94, 0.6);
  // Five nested foam ridges convey speed even on a very small display.
  for (let i = 0; i < (q.fancy ? 5 : 3); i++) {
    const span = length * (1 - i * 0.15);
    ctx.globalAlpha = alpha * (0.16 + i * 0.12) * smooth(t / 0.08);
    ctx.strokeStyle = i % 2 ? '#d4fbff' : '#55d7f0';
    ctx.lineWidth = 3 + i * 1.5;
    ctx.beginPath();
    ctx.moveTo(-span, -12 - span * 0.11);
    ctx.quadraticCurveTo(-span * 0.36, -8, 22 - i * 8, 0);
    ctx.quadraticCurveTo(-span * 0.36, 8, -span, 12 + span * 0.11);
    ctx.stroke();
  }
  ctx.fillStyle = '#edffff';
  ctx.beginPath();
  for (let i = 0; i < budget(q, 26); i++) {
    const p = fract(seed(i) + effect.age * (1.7 + seed(i, 1)));
    const px = -p * length;
    const py = (seed(i, 2) - 0.5) * (12 + p * 56);
    const r = 1.3 + seed(i, 3) * 2.9;
    ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, TAU);
  }
  ctx.globalAlpha = alpha * 0.68 * smooth(t / 0.08);
  ctx.fill();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#082c3b';
  ctx.beginPath();
  ctx.moveTo(35, 0); ctx.quadraticCurveTo(20, -12, -30, -8);
  ctx.lineTo(-43, -17); ctx.lineTo(-40, 0); ctx.lineTo(-43, 17);
  ctx.lineTo(-30, 8); ctx.quadraticCurveTo(20, 12, 35, 0); ctx.fill();
  ctx.strokeStyle = '#b3faff'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-26, -5); ctx.lineTo(18, -4); ctx.stroke();
  ctx.fillStyle = '#d2fff1';
  ctx.beginPath(); ctx.ellipse(26, 0, 10, 6, 0, 0, TAU); ctx.fill();
  ctx.restore();
}

function drawDetonation(ctx: CanvasRenderingContext2D, x: number, y: number, age: number, duration: number, q: Quality) {
  const t = clamp(age / duration, 0, 1);
  const alpha = ctx.globalAlpha;
  const burst = 1 - (1 - t) ** 3;
  const fade = (1 - t) ** 1.35;
  const fx = fxSprites();
  ctx.globalAlpha = alpha * fade;
  // A water-plane shock ring and a separate spherical flash read as a hit,
  // rather than the generic floating fireball of a cannon shot.
  if (q.fancy) {
    glow(ctx, sprites().blue, x, y + 8, 170 + burst * 410, 65 + burst * 130, 0.8);
    glow(ctx, fx.fire, x, y - 42, 170 + burst * 230, 190 + burst * 240, Math.max(0, 1 - t * 2));
  }
  for (let i = 0; i < 3; i++) {
    const p = clamp((t - i * 0.075) / (1 - i * 0.075), 0, 1);
    if (t < i * 0.075) continue;
    ctx.globalAlpha = alpha * (1 - p) * 0.82;
    ctx.strokeStyle = i === 0 ? '#c5f6ff' : '#59cce7';
    ctx.lineWidth = (7 - i * 1.4) * (1 - p * 0.6);
    ctx.beginPath(); ctx.ellipse(x, y + 12, 24 + p * 240, 8 + p * 69, 0, 0, TAU); ctx.stroke();
  }
  const plume = Math.sin(Math.min(1, t * 1.35) * Math.PI);
  ctx.globalAlpha = alpha * fade * 0.85;
  ctx.fillStyle = '#c1f4ff';
  ctx.beginPath();
  ctx.moveTo(x - 62 - burst * 35, y + 12);
  ctx.quadraticCurveTo(x - 44, y - plume * 80, x - 35, y - 80 - plume * 120);
  ctx.quadraticCurveTo(x - 14, y - plume * 130, x, y - 36 - plume * 240);
  ctx.quadraticCurveTo(x + 25, y - plume * 120, x + 47, y - 40 - plume * 135);
  ctx.quadraticCurveTo(x + 38, y - 12, x + 100, y + 12);
  ctx.closePath(); ctx.fill();
  ctx.globalAlpha = alpha * Math.max(0, 1 - t * 3.5);
  ctx.fillStyle = '#fff4c7';
  ctx.beginPath(); ctx.arc(x, y - 27, 30 + burst * 54, 0, TAU); ctx.fill();
  ctx.globalAlpha = alpha * fade;
  ctx.strokeStyle = '#ddfbff';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  for (let i = 0; i < budget(q, 38); i++) {
    const theta = Math.PI + seed(i) * Math.PI;
    const speed = 120 + seed(i, 1) * 280;
    const px = x + Math.cos(theta) * speed * age;
    const py = y + Math.sin(theta) * speed * age + 160 * age * age;
    ctx.moveTo(px, py);
    ctx.lineTo(px - Math.cos(theta) * (5 + seed(i, 2) * 12), py - Math.sin(theta) * 9);
  }
  ctx.stroke();
  ctx.globalAlpha = alpha;
}

function drawHeal(ctx: CanvasRenderingContext2D, effect: SpecialVisual, q: Quality) {
  const targets = effect.targets.length ? effect.targets : [effect.origin];
  const alpha = ctx.globalAlpha;
  const fade = smooth(effect.age / 0.16) * (1 - smooth((effect.age - effect.duration + 0.45) / 0.45));
  const art = sprites();
  for (const target of targets) {
    ctx.globalAlpha = alpha * fade;
    if (q.fancy) {
      glow(ctx, art.green, target.x, target.y - 90, 390, 410, 0.55);
      glow(ctx, art.green, target.x, target.y + 6, 410, 100, 0.9);
    }
    // Multiple expanding circles envelop the hull; shallow ellipses anchor
    // their light on the water rather than replacing them with a single halo.
    for (let i = 0; i < 4; i++) {
      const elapsed = effect.age - i * 0.23;
      if (elapsed < 0) continue;
      const p = clamp(elapsed / 1.55, 0, 1);
      if (p >= 1) continue;
      const radius = 38 + p * 174;
      const strength = fade * Math.sin(Math.PI * Math.min(1, p * 1.4)) * (1 - p * 0.55);
      ctx.globalAlpha = alpha * strength;
      ctx.strokeStyle = i % 2 ? '#c8ffb9' : '#54eea1';
      ctx.lineWidth = 5 - p * 2;
      ctx.beginPath(); ctx.arc(target.x, target.y - 79, radius, 0, TAU); ctx.stroke();
      ctx.globalAlpha *= 0.56;
      ctx.beginPath(); ctx.ellipse(target.x, target.y + 8, radius * 1.08, radius * 0.25, 0, 0, TAU); ctx.stroke();
    }
    const pulse = Math.max(0, 1 - Math.abs(effect.age - SPECIALS.heal.impact) / 0.23);
    if (pulse > 0 && q.fancy) {
      ctx.globalAlpha = alpha * fade;
      glow(ctx, art.green, target.x, target.y - 75, 440, 320, pulse * 0.6);
    }
    for (let i = 0; i < budget(q, 32); i++) {
      const elapsed = effect.age - seed(i, 1) * 0.62;
      if (elapsed < 0) continue;
      const p = elapsed / (1.05 + seed(i, 2) * 0.65);
      if (p >= 1) continue;
      const x = target.x + (seed(i) - 0.5) * 280 + Math.sin(p * 5 + i) * 14;
      const y = target.y + 12 - p * (175 + seed(i, 3) * 150);
      const size = (3.5 + seed(i, 3) * 4) * Math.sin(Math.PI * p);
      ctx.globalAlpha = alpha * fade * Math.sin(Math.PI * p);
      ctx.fillStyle = i % 3 ? '#b6ffd8' : '#f0ffbc';
      ctx.beginPath();
      ctx.moveTo(x, y - size * 1.8); ctx.lineTo(x + size * 0.45, y - size * 0.4);
      ctx.lineTo(x + size * 1.25, y); ctx.lineTo(x + size * 0.4, y + size * 0.4);
      ctx.lineTo(x, y + size * 1.8); ctx.lineTo(x - size * 0.4, y + size * 0.4);
      ctx.lineTo(x - size * 1.25, y); ctx.lineTo(x - size * 0.45, y - size * 0.4);
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.globalAlpha = alpha;
}

// Tiny, bounded, lazily baked artwork. Low quality skips all soft light blits.
let artwork: { green: Sprite; blue: Sprite; cloud: Sprite; moon: Sprite } | null = null;
function makeSprite(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): Sprite {
  try {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    paint(ctx);
    return canvas;
  } catch { return null; }
}

function softLight(color: string): Sprite {
  return makeSprite(128, 128, ctx => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, `rgba(${color},0.85)`);
    g.addColorStop(0.28, `rgba(${color},0.4)`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  });
}

function sprites() {
  if (artwork) return artwork;
  artwork = {
    green: softLight('80,255,154'), blue: softLight('117,218,255'),
    moon: makeSprite(128, 128, ctx => {
      const g = ctx.createRadialGradient(48, 43, 2, 64, 64, 61);
      g.addColorStop(0, '#f0f8e9'); g.addColorStop(0.65, '#c3dfdf'); g.addColorStop(1, '#72a5b7');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(64, 64, 60, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(58,100,129,0.2)';
      for (let i = 0; i < 14; i++) {
        const angle = seed(i) * TAU;
        const radius = 40 * Math.sqrt(seed(i, 1));
        ctx.beginPath(); ctx.arc(64 + Math.cos(angle) * radius, 64 + Math.sin(angle) * radius, 2 + seed(i, 2) * 9, 0, TAU); ctx.fill();
      }
      // A crescent cutout stays transparent against either day or night sky.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.arc(92, 43, 55, 0, TAU); ctx.fillStyle = '#000'; ctx.fill();
    }),
    cloud: makeSprite(768, 256, ctx => {
      for (let layer = 0; layer < 3; layer++) {
        const g = ctx.createLinearGradient(0, 10, 0, 256);
        g.addColorStop(0, layer ? '#192b40' : '#243b51');
        g.addColorStop(0.62, layer ? '#122232' : '#1a3041');
        g.addColorStop(1, '#1c3b38');
        ctx.fillStyle = g;
        ctx.beginPath();
        for (let i = 0; i < 13; i++) {
          const k = i + layer * 17;
          const x = i * 65 - 18;
          const y = 65 + layer * 29 + seed(k, 1) * 24;
          const rx = 55 + seed(k) * 45;
          const ry = 34 + seed(k, 2) * 26;
          ctx.moveTo(x + rx, y); ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
        }
        ctx.fill();
      }
      const feather = ctx.createLinearGradient(0, 0, 768, 0);
      feather.addColorStop(0, 'transparent'); feather.addColorStop(0.13, '#000');
      feather.addColorStop(0.87, '#000'); feather.addColorStop(1, 'transparent');
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = feather; ctx.fillRect(0, 0, 768, 256);
    }),
  };
  return artwork;
}

function glow(ctx: CanvasRenderingContext2D, sprite: Sprite, x: number, y: number, w: number, h: number, opacity: number) {
  if (!sprite || opacity <= 0) return;
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha *= opacity;
  ctx.drawImage(sprite, x - w / 2, y - h / 2, w, h);
  ctx.globalAlpha = alpha;
}
