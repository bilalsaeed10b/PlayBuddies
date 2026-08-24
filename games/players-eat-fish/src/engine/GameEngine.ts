import { Fish, GameSettings, PlayerPacket, EnemyPacket, Vector2D } from '../types/game';
import {
  FISH_ASSETS,
  BOSS_ASSET,
  assetForSize,
  isShoalingSize,
  SHOAL_MAX_SIZE,
  fishSrc,
} from '../game/fish';

import { audioService } from '../services/audio';
import { QualityGovernor } from '../game/quality';

/**
 * ONE PLACE TO TUNE THE GAME.
 *
 * Every number that decides how the ocean feels lives here. Times are seconds,
 * distances are world units, speeds are world units per second — the simulation
 * has no notion of frames, which is what makes it identical at 30, 60 and 144Hz.
 */
export const BALANCE = {
  // World
  WORLD_W: 3000,
  WORLD_H: 2200,
  /**
   * Constant *visible area*, not a constant width or height.
   *
   * The old code pinned 1200 world units to whichever screen edge was shorter,
   * so a phone in portrait saw more than twice the ocean a laptop did — the
   * same fish was a different size, and a player on a tall screen could see
   * predators coming that a player on a wide screen could not. Fixing the area
   * makes every fish cover the same fraction of every screen.
   */
  VIEW_AREA: 1200 * 900,
  /** Clamps daft aspect ratios (a 21:9 ultrawide) from seeing halfway across the map. */
  VIEW_MAX_EDGE: 2000,
  /**
   * How far the camera pulls back as the local fish grows, at most.
   *
   * The view used to be a fixed size no matter how big you got, so a bigger
   * fish simply filled more and more of a screen that never widened to match
   * -- the run felt like it was zooming in on you rather than you growing
   * into a bigger ocean. `zoomFor` below eases the view outward at roughly
   * the same rate the sprite itself grows, so a fish covers about the same
   * share of the screen at size 6 as it does at size 200. Capped well short
   * of "the whole map is always visible", which would make the reef feel
   * small rather than the fish feel big.
   */
  ZOOM_MAX: 2.4,

  // Player
  PLAYER_ACCEL: 1400,
  PLAYER_BASE_SPEED: 190,
  PLAYER_SPEED_PER_SIZE: 0.55,
  /** Water is denser vertically than the arcade feel wants. */
  PLAYER_VERTICAL_DAMPEN: 0.85,
  PLAYER_FRICTION: 0.9,
  START_SIZE: 6,
  /**
   * A safety ceiling, not a target anyone is meant to reach. It used to sit at
   * 200 -- close enough that a serious run stalled out well before the enemy
   * population's own top end (see spawnEnemy), so a maxed-out fish became
   * uneatable by anything but the scripted boss and the run turned into
   * dodging a timer instead of playing the game. Lifted far out of reach so
   * growth never visibly stops.
   */
  MAX_SIZE: 900,
  /**
   * Growth is by area, not by radius: size² accumulates. Eating your first few
   * fish is dramatic and eating your hundredth barely moves the needle, which
   * is what keeps a long run from ending with one fish filling the screen.
   * Lowered from 0.55 so that curve stretches out much further -- size climbs
   * noticeably slower across a whole run, not just at the high end.
   */
  GROWTH: 0.24,
  /** Score climbs a little slower than size does -- its own dial, not tied to GROWTH. */
  SCORE_RATE: 0.8,
  SPAWN_PROTECTION: 2.5,

  // AI population
  ENEMY_BASE: 26,
  ENEMY_PER_PLAYER: 6,
  ENEMY_MAX: 70,
  ENEMY_MIN_SPEED: 55,
  ENEMY_MAX_SPEED: 135,
  /** Spawn ring, as a multiple of the view's half-diagonal — just out of sight. */
  SPAWN_RING: 1.15,
  /** Beyond this (same units) a fish nobody can see is recycled. */
  CULL_RING: 2.1,
  /**
   * AI fish ignore players entirely — they neither hunt you nor flee from you.
   * A predator that beelines at you is a timer, not a game, and prey that
   * scatters on sight is never catchable. They swim their own routes; a big one
   * is dangerous because it is *there*.
   */
  /** How long a fish holds a heading before choosing a new one, in seconds. */
  TURN_EVERY_MIN: 2.5,
  TURN_EVERY_MAX: 7,
  /** How sharply it swings onto a new heading. */
  TURN_RATE: 1.1,
  /** Shoal cohesion, alignment and personal space. */
  SCHOOL_PULL: 0.55,
  SCHOOL_ALIGN: 0.9,
  SCHOOL_SPACING: 80,
  SCHOOL_SPREAD: 300,
  /** Share of spawns that arrive as a shoal rather than a lone fish. */
  SHOAL_CHANCE: 0.3,
  SHOAL_MIN: 5,
  SHOAL_MAX: 9,

  // Boss
  BOSS_INTERVAL: 90,
  BOSS_DURATION: 18,
  /** Slow enough to outswim. It is a hazard to steer around, not a death sentence. */
  BOSS_SPEED: 100,
  BOSS_SIZE: 190,

  /**
   * Whether players can eat each other.
   *
   * Off by request: the run is a race to grow against the reef, and two players
   * who meet simply bump apart. One constant, so turning the arena back into a
   * free-for-all is a one-word change.
   */
  PVP_EATING: false,

  // Presentation
  BUBBLES: 60,
  VISUAL_SCALE: 1.3,
  /**
   * Steepest a fish ever tilts, in radians (~85°) -- most of the way to
   * straight up or down, so swimming vertically actually reads as vertically.
   *
   * This used to sit at 0.62 (~35°), which kept a fish nearly level even
   * when its heading was dead vertical: pushing straight up never made it
   * look up. That cap existed for a *different* bug -- the old renderer
   * rotated by the full heading and mirrored *vertically* past ±90°, which
   * is what actually went upside down, and it happened however small this
   * number was. The fix for that was switching to a horizontal-only mirror
   * (see drawFish): pitch is now rotation on top of that mirror, not a
   * substitute for it, so it stays right-side up at any pitch up to a true
   * ±90° -- this is stopped just short of that, purely so the sprite never
   * looks perfectly nose-on.
   */
  MAX_PITCH: 1.48,
} as const;

const CONTROL_SCHEMES = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' },
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' },
  { up: 'KeyI', down: 'KeyK', left: 'KeyJ', right: 'KeyL' },
];

export interface EngineConfig {
  canvas: HTMLCanvasElement;
  /** One id for online play; two or three for couch co-op on one keyboard. */
  localIds: string[];
  localFish: Record<string, number>;
  localNames: Record<string, string>;
  settings: GameSettings;
  /** True when this client owns the AI: solo play, or the host of a room. */
  simulateAI: boolean;
  onEat: (score: number, size: number) => void;
  /** `eaterId` is set only when another player did it, so they can be credited. */
  onDeath: (id: string, killedBy: string, eaterId?: string, size?: number) => void;
  onLocalState: (id: string, packet: PlayerPacket) => void;
  onEnemyEaten: (enemyId: number) => void;
  onProgress?: (p: number) => void;
}

interface Bubble {
  x: number;
  y: number;
  r: number;
  speed: number;
  alpha: number;
  phase: number;
  sway: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  max: number;
}

/** Snapshot smoothing constant: share of remaining error closed per second. */
const NET_CATCHUP = 0.00001;
/** Never dead-reckon further ahead than this. */
const NET_MAX_EXTRAPOLATION = 0.4;

export class GameEngine {
  private ctx: CanvasRenderingContext2D;
  private images = new Map<number, HTMLImageElement>();
  /** The static background image. */
  private backdrop: HTMLImageElement | null = null;

  private locals = new Map<string, Fish>();
  private remotes = new Map<string, Fish>();
  private enemies = new Map<number, Fish>();
  private boss: Fish | null = null;

  /**
   * Decides how much of the decoration this device can afford, and keeps
   * deciding: the first guess comes from what the browser reports, the rest
   * from how long frames are actually taking. See game/quality.ts.
   */
  private governor: QualityGovernor;
  /** Last tier acted on, so a change can trigger exactly one resize. */
  private tier = 0;
  private bubbles: Bubble[] = [];
  private particles: Particle[] = [];

  private keys = new Set<string>();
  private joystick: Vector2D = { x: 0, y: 0 };

  private running = false;
  private raf = 0;
  private lastTime = 0;
  /** Kept so draw() can ease the camera per unit of time rather than per frame. */
  private lastDt = 1 / 60;
  private bossTimer = 0;
  private bossLife = 0;
  private nextEnemyId = 1;
  private nextShoalId = 1;
  /** Enemies eaten since the last time the host published a removal batch. */
  private pendingKills: number[] = [];

  /** Base view size for the current screen aspect, at zoom 1. Set by resize() only. */
  private viewW = 1200;
  private viewH = 900;
  /** Eased zoom-out multiplier, from `zoomFor`. 1 = base view, grows as the local fish does. */
  private zoom = 1;
  /** `viewW`/`viewH` times the current `zoom` -- what the camera and spawner actually use. */
  private effViewW = 1200;
  private effViewH = 900;
  private cameraX = BALANCE.WORLD_W / 2;
  private cameraY = BALANCE.WORLD_H / 2;

  private settings: GameSettings;
  private simulateAI: boolean;
  private ambient: { stop: () => void } | null = null;

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
    // Arrow keys scroll the page inside the platform's iframe otherwise.
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onBlur = () => this.keys.clear();

  constructor(private config: EngineConfig) {
    this.ctx = config.canvas.getContext('2d', { alpha: false })!;
    this.settings = config.settings;
    this.simulateAI = config.simulateAI;
    // Built before resize() and initBubbles() below, both of which read it.
    this.governor = new QualityGovernor(config.settings.lowPower);
    this.tier = this.governor.quality.tier;

    config.localIds.forEach((id, i) => {
      const asset = config.localFish[id] ?? 0;
      const fish = this.makeFish(id, 'player', FISH_ASSETS[asset].size, asset);
      // Players all move at exactly the same rate. `pace` exists to stop a
      // shoal of AI fish swimming as one rigid block; applying it to a person
      // would hand one player a third more top speed than another for no
      // reason they could see.
      fish.pace = 1;
      fish.name = config.localNames[id] ?? `Player ${i + 1}`;
      // Spread couch co-op players out so they don't spawn inside each other.
      const spread = config.localIds.length + 1;
      fish.x = (BALANCE.WORLD_W / spread) * (i + 1);
      fish.y = BALANCE.WORLD_H / 2;
      this.locals.set(id, fish);
    });

    this.resize();
    this.initBubbles();
    this.loadImages();
    if (this.simulateAI) this.seedEnemies();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  start() {
    if (this.running) return;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    audioService.playAmbientRumble().then((r) => {
      this.ambient = r;
    });
    this.running = true;
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.ambient?.stop();
    this.ambient = null;
  }

  updateSettings(settings: GameSettings) {
    this.settings = settings;
  }

  setJoystick(v: Vector2D) {
    this.joystick = v;
  }

  /**
   * Whoever owns the AI can change mid-match: if the host drops the platform
   * promotes someone else, and a guest that cannot reach the host at all falls
   * back to running its own ocean so it isn't left staring at empty water.
   */
  setSimulateAI(on: boolean) {
    if (this.simulateAI === on) return;
    this.simulateAI = on;
    if (on) {
      if (this.enemies.size === 0) this.seedEnemies();
    } else {
      // Hand authority back: drop the locally invented fish so the host's next
      // snapshot lands on a clean slate instead of doubling the population.
      this.enemies.clear();
      this.pendingKills = [];
    }
  }

  get runningAI(): boolean {
    return this.simulateAI;
  }

  // ── networking surface ───────────────────────────────────────────────────

  setRemotePlayer(id: string, p: PlayerPacket, name: string) {
    let fish = this.remotes.get(id);
    if (!fish) {
      fish = this.makeFish(id, 'player', p[4], p[6]);
      fish.pace = 1;
      fish.x = p[0];
      fish.y = p[1];
      this.remotes.set(id, fish);
    }
    fish.name = name;
    fish.size = p[4];
    fish.score = p[5];
    fish.asset = p[6];
    fish.angle = p[7];
    fish.dead = p[8] === 1;
    fish.net = { x: p[0], y: p[1], vx: p[2], vy: p[3], at: performance.now() / 1000 };
  }

  removeRemotePlayer(id: string) {
    this.remotes.delete(id);
  }

  /** Guests replace their whole AI population from the host's snapshot. */
  applyEnemies(list: EnemyPacket[], boss: EnemyPacket | null) {
    if (this.simulateAI) return;
    const now = performance.now() / 1000;
    const seen = new Set<number>();

    for (const p of list) {
      seen.add(p[0]);
      let fish = this.enemies.get(p[0]);
      if (!fish) {
        fish = this.makeFish(String(p[0]), 'enemy', p[5], p[6]);
        fish.x = p[1];
        fish.y = p[2];
        this.enemies.set(p[0], fish);
      }
      fish.size = p[5];
      fish.asset = p[6];
      fish.net = { x: p[1], y: p[2], vx: p[3], vy: p[4], at: now };
    }

    // Anything the host stopped mentioning has been eaten or recycled. Only
    // prune against a full snapshot, which is what this always is.
    for (const id of [...this.enemies.keys()]) {
      if (!seen.has(id)) this.enemies.delete(id);
    }

    if (boss) {
      if (!this.boss) this.boss = this.makeFish('boss', 'boss', BALANCE.BOSS_SIZE, BOSS_ASSET);
      this.boss.size = boss[5];
      this.boss.opacity = 1;
      this.boss.net = { x: boss[1], y: boss[2], vx: boss[3], vy: boss[4], at: now };
    } else {
      this.boss = null;
    }
  }

  /** Host side: the AI state to publish, culled to what this peer could see. */
  enemyPacketsFor(peer: { x: number; y: number } | null): EnemyPacket[] {
    const radius = this.viewRadius() * BALANCE.CULL_RING;
    const out: EnemyPacket[] = [];
    for (const [id, f] of this.enemies) {
      if (peer) {
        const dx = f.x - peer.x;
        const dy = f.y - peer.y;
        // Sending a fish 3000 units behind someone costs bandwidth and buys
        // nothing — they cannot see it and cannot reach it before the next
        // snapshot corrects them.
        if (dx * dx + dy * dy > radius * radius) continue;
      }
      out.push([id, Math.round(f.x), Math.round(f.y), Math.round(f.vx), Math.round(f.vy), Math.round(f.size), f.asset]);
    }
    return out;
  }

  bossPacket(): EnemyPacket | null {
    const b = this.boss;
    if (!b) return null;
    return [0, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), Math.round(b.size), BOSS_ASSET];
  }

  /** Host side: a guest claims it ate this fish. */
  removeEnemy(id: number): boolean {
    if (!this.enemies.has(id)) return false;
    this.enemies.delete(id);
    this.pendingKills.push(id);
    return true;
  }

  takePendingKills(): number[] {
    if (this.pendingKills.length === 0) return [];
    const out = this.pendingKills;
    this.pendingKills = [];
    return out;
  }

  removeEnemies(ids: number[]) {
    for (const id of ids) this.enemies.delete(id);
  }

  /** A remote player reports we ate them; take the growth here so both sides agree. */
  creditKill(eaterId: string, size: number) {
    const fish = this.locals.get(eaterId);
    if (!fish || fish.dead) return;
    this.grow(fish, size);
    this.burst(fish.x, fish.y, 18);
    this.config.onEat(fish.score, fish.size);
  }

  /** True once every local seat has been eaten — the cue to show the defeat screen. */
  allLocalsDead(): boolean {
    for (const fish of this.locals.values()) if (!fish.dead) return false;
    return true;
  }

  /** Puts a local player back in the water after a death. */
  respawn(id: string) {
    const fish = this.locals.get(id);
    // Only the dead: in couch co-op the survivors must keep the size they earned.
    if (!fish || !fish.dead) return;
    const asset = this.config.localFish[id] ?? 0;
    fish.size = FISH_ASSETS[asset].size;
    fish.asset = asset;
    fish.score = 0;
    fish.dead = false;
    fish.vx = 0;
    fish.vy = 0;
    fish.bornAt = performance.now() / 1000;
    // Away from the edges, and away from whatever just ate them.
    fish.x = BALANCE.WORLD_W * (0.25 + Math.random() * 0.5);
    fish.y = BALANCE.WORLD_H * (0.25 + Math.random() * 0.5);
  }

  /**
   * Starts the reef over at the size the players are *now*.
   *
   * The spawner sizes every fish against `referenceSize()`, the average of
   * everyone alive — so a reef grown around a size-150 player is still full of
   * size-150 fish the moment that player restarts at size 6. Nothing culls
   * them either: they are recycled only when they drift out of view, so a fresh
   * run opened surrounded by leftover giants from the last one and died to the
   * first thing it touched.
   *
   * Only meaningful for whoever owns the AI. A guest's population is replaced
   * wholesale by the host's next snapshot regardless.
   */
  resetReef() {
    if (!this.simulateAI) return;
    this.enemies.clear();
    this.boss = null;
    this.bossTimer = 0;
    this.bossLife = 0;
    this.particles = [];
    this.seedEnemies();
  }

  localFish(id: string): Fish | undefined {
    return this.locals.get(id);
  }

  /** Everyone in the water, biggest first — the in-game scoreboard. */
  leaderboard(): { id: string; name: string; size: number; score: number; local: boolean }[] {
    const rows: { id: string; name: string; size: number; score: number; local: boolean }[] = [];
    for (const [id, f] of this.locals) {
      rows.push({ id, name: f.name ?? 'You', size: f.size, score: f.score, local: true });
    }
    for (const [id, f] of this.remotes) {
      if (f.dead) continue;
      rows.push({ id, name: f.name ?? 'Player', size: f.size, score: f.score, local: false });
    }
    return rows.sort((a, b) => b.size - a.size);
  }

  // ── sizing ───────────────────────────────────────────────────────────────

  resize() {
    const parent = this.config.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    // Capped device pixel ratio: a 3x phone screen would otherwise ask a mobile
    // GPU to fill nine times the pixels for a barely visible gain. The cap now
    // moves with the measured frame rate rather than being a fixed 2.
    const dpr = Math.min(window.devicePixelRatio || 1, this.governor.quality.maxDpr);

    this.ctx.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.ctx.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.config.canvas.style.width = `${rect.width}px`;
    this.config.canvas.style.height = `${rect.height}px`;

    const aspect = this.ctx.canvas.width / this.ctx.canvas.height || 1;
    this.viewW = Math.min(BALANCE.VIEW_MAX_EDGE, Math.sqrt(BALANCE.VIEW_AREA * aspect));
    this.viewH = Math.min(BALANCE.VIEW_MAX_EDGE, Math.sqrt(BALANCE.VIEW_AREA / aspect));
    this.effViewW = this.viewW * this.zoom;
    this.effViewH = this.viewH * this.zoom;
  }

  /**
   * Eases `zoom` toward `zoomFor` of the local fleet's average size, and
   * refreshes `effViewW`/`effViewH` from it.
   *
   * Runs once per frame, before anything that reads the view size -- spawning,
   * culling and drawing all have to agree on the same view this frame, not a
   * mix of this frame's camera and last frame's spawn ring.
   */
  private updateZoom(dt: number) {
    let target = 1;
    const alive = [...this.locals.values()].filter((f) => !f.dead);
    if (alive.length) {
      const avgSize = alive.reduce((s, f) => s + f.size, 0) / alive.length;
      target = zoomFor(avgSize);
    }
    const k = 1 - Math.pow(0.05, dt);
    this.zoom += (target - this.zoom) * k;
    this.effViewW = this.viewW * this.zoom;
    this.effViewH = this.viewH * this.zoom;
  }

  private viewRadius() {
    return Math.hypot(this.effViewW, this.effViewH) / 2;
  }

  // ── main loop ────────────────────────────────────────────────────────────

  private loop = (time: number) => {
    if (!this.running) return;
    // Clamped at the top so a backgrounded tab doesn't resume with one enormous
    // step that teleports every fish across the map, and at the bottom because
    // the first rAF timestamp can precede the performance.now() captured in
    // start() — a negative dt runs the whole simulation backwards for a frame.
    const dt = Math.max(0, Math.min(0.05, (time - this.lastTime) / 1000));
    this.lastTime = time;
    this.lastDt = dt;

    this.governor.sample(dt);
    if (this.governor.quality.tier !== this.tier) {
      // The tier sets the backing-store size, so a change only means anything
      // once the canvas has been rebuilt at the new scale.
      this.tier = this.governor.quality.tier;
      this.resize();
    }

    this.update(dt);
    this.draw();

    this.raf = requestAnimationFrame(this.loop);
  };

  private update(dt: number) {
    this.updateZoom(dt);
    this.updateLocals(dt);
    if (this.simulateAI) {
      this.simulateEnemies(dt);
      this.simulateBoss(dt);
    } else {
      this.interpolate(this.enemies.values(), dt);
      if (this.boss) this.applyNet(this.boss, dt);
    }
    this.interpolate(this.remotes.values(), dt);
    this.updateBubbles(dt);
    this.updateParticles(dt);
    this.checkCollisions();
  }

  private updateLocals(dt: number) {
    const ids = this.config.localIds;
    this.locals.forEach((fish, id) => {
      if (fish.dead) {
        // Still published, so the rest of the room learns we are out of the
        // water. Skipping this left a corpse swimming on everyone else's
        // screen at whatever velocity it died with.
        this.publish(id, fish);
        return;
      }

      const index = ids.indexOf(id);
      const scheme = CONTROL_SCHEMES[(index + this.settings.controlScheme) % CONTROL_SCHEMES.length];

      let ix = 0;
      let iy = 0;
      if (this.keys.has(scheme.left)) ix -= 1;
      if (this.keys.has(scheme.right)) ix += 1;
      if (this.keys.has(scheme.up)) iy -= 1;
      if (this.keys.has(scheme.down)) iy += 1;

      // The joystick drives player one; it is analogue, so it wins outright
      // rather than being added to a digital key press.
      if (index === 0 && (this.joystick.x !== 0 || this.joystick.y !== 0)) {
        ix = this.joystick.x;
        iy = this.joystick.y;
      }

      const maxSpeed = (BALANCE.PLAYER_BASE_SPEED + fish.size * BALANCE.PLAYER_SPEED_PER_SIZE) * fish.pace;
      const mag = Math.hypot(ix, iy);

      if (mag > 0.01) {
        // Normalised, so diagonals aren't 41% faster, and scaled by magnitude
        // so a half-pushed joystick means half speed.
        const push = Math.min(1, mag);
        fish.vx += (ix / mag) * push * BALANCE.PLAYER_ACCEL * dt;
        fish.vy += (iy / mag) * push * BALANCE.PLAYER_ACCEL * BALANCE.PLAYER_VERTICAL_DAMPEN * dt;

        const speed = Math.hypot(fish.vx, fish.vy);
        const cap = maxSpeed * push;
        if (speed > cap) {
          fish.vx = (fish.vx / speed) * cap;
          fish.vy = (fish.vy / speed) * cap;
        }
      } else {
        const friction = Math.pow(BALANCE.PLAYER_FRICTION, dt * 60);
        fish.vx *= friction;
        fish.vy *= friction;
        if (Math.abs(fish.vx) < 2) fish.vx = 0;
        if (Math.abs(fish.vy) < 2) fish.vy = 0;
      }

      fish.x += fish.vx * dt;
      fish.y += fish.vy * dt;

      // Bounce off the world edge instead of sticking to it, so a player pinned
      // in a corner by a predator still has somewhere to go.
      if (fish.x < 0) { fish.x = 0; fish.vx = Math.abs(fish.vx) * 0.4; }
      if (fish.x > BALANCE.WORLD_W) { fish.x = BALANCE.WORLD_W; fish.vx = -Math.abs(fish.vx) * 0.4; }
      if (fish.y < 0) { fish.y = 0; fish.vy = Math.abs(fish.vy) * 0.4; }
      if (fish.y > BALANCE.WORLD_H) { fish.y = BALANCE.WORLD_H; fish.vy = -Math.abs(fish.vy) * 0.4; }

      this.face(fish, dt, 10);
      this.publish(id, fish);
    });
  }

  /** Rounded before it goes on the wire: sub-pixel precision costs bytes and buys nothing. */
  private publish(id: string, fish: Fish) {
    this.config.onLocalState(id, [
      Math.round(fish.x),
      Math.round(fish.y),
      Math.round(fish.vx),
      Math.round(fish.vy),
      Math.round(fish.size * 10) / 10,
      fish.score,
      fish.asset,
      Math.round(fish.angle * 100) / 100,
      fish.dead ? 1 : 0,
    ]);
  }

  // ── AI ───────────────────────────────────────────────────────────────────

  private seedEnemies() {
    const target = this.enemyTarget();
    // A couple of shoals from the outset, so the reef looks inhabited rather
    // than evenly sprinkled.
    this.spawnShoal();
    this.spawnShoal();
    while (this.enemies.size < target) {
      const fish = this.spawnEnemy();
      // The opening population is scattered across the map rather than pushed
      // in from the edge, so the first ten seconds aren't an empty ocean.
      fish.x = Math.random() * BALANCE.WORLD_W;
      fish.y = Math.random() * BALANCE.WORLD_H;
    }
  }

  private enemyTarget() {
    const players = this.locals.size + this.remotes.size;
    return Math.min(BALANCE.ENEMY_MAX, BALANCE.ENEMY_BASE + players * BALANCE.ENEMY_PER_PLAYER);
  }

  /** Average size of everyone alive — the yardstick the spawner balances against. */
  private referenceSize() {
    let total = 0;
    let count = 0;
    const add = (f: Fish) => {
      if (f.dead) return;
      total += f.size;
      count++;
    };
    this.locals.forEach(add);
    this.remotes.forEach(add);
    return count ? total / count : BALANCE.START_SIZE;
  }

  private spawnEnemy(): Fish {
    const ref = this.referenceSize();
    const roll = Math.random();

    // How far into a run the local fleet already is: 0 at a fresh spawn, 1
    // once comfortably grown. Predators lean in as this climbs, so a brand
    // new fish gets a gentler reef and pressure ramps up to match a player
    // who has already grown, instead of a fixed 30% predator chance from the
    // first second of the run.
    const grown = clamp((ref - BALANCE.START_SIZE) / 250, 0, 1);
    const preyCut = 0.5 - grown * 0.15;
    const peerCut = preyCut + 0.3;

    let size: number;
    if (roll < preyCut) {
      // Prey: always something to eat, so a run never stalls.
      size = ref * (0.25 + Math.random() * 0.6);
    } else if (roll < peerCut) {
      // Peers: can't eat you, you can't eat them. They make the water feel busy.
      size = ref * (0.85 + Math.random() * 0.3);
    } else {
      // Predators: the reason you keep moving.
      size = ref * (1.2 + Math.random() * 1.0);
    }
    // Bounded by what a player can actually grow to (MAX_SIZE), not by a
    // fixed fraction of it -- the old 0.9 multiplier put a hard ceiling at
    // 180 that never moved, so a fish that grew past it became uneatable by
    // anything except the scripted boss.
    size = Math.max(4, Math.min(BALANCE.MAX_SIZE * 1.1, size));

    const id = this.nextEnemyId++;
    const fish = this.makeFish(String(id), 'enemy', size, assetForSize(size));

    // Just outside somebody's view, on the far side of a random angle.
    const anchor = this.spawnAnchor();
    const angle = Math.random() * Math.PI * 2;
    const radius = this.viewRadius() * BALANCE.SPAWN_RING;
    fish.x = clamp(anchor.x + Math.cos(angle) * radius, -200, BALANCE.WORLD_W + 200);
    fish.y = clamp(anchor.y + Math.sin(angle) * radius, -200, BALANCE.WORLD_H + 200);

    const speed = BALANCE.ENEMY_MIN_SPEED + Math.random() * (BALANCE.ENEMY_MAX_SPEED - BALANCE.ENEMY_MIN_SPEED);
    // Head roughly back toward the action rather than straight off the map.
    const toward = Math.atan2(anchor.y - fish.y, anchor.x - fish.x) + (Math.random() - 0.5) * 1.6;
    fish.vx = Math.cos(toward) * speed * fish.pace;
    fish.vy = Math.sin(toward) * speed * fish.pace * 0.6;
    fish.angle = toward;
    fish.heading = toward;

    this.enemies.set(id, fish);
    return fish;
  }

  private spawnAnchor(): { x: number; y: number } {
    const alive: Fish[] = [];
    this.locals.forEach((f) => !f.dead && alive.push(f));
    this.remotes.forEach((f) => !f.dead && alive.push(f));
    if (alive.length === 0) return { x: BALANCE.WORLD_W / 2, y: BALANCE.WORLD_H / 2 };
    return alive[Math.floor(Math.random() * alive.length)];
  }

  /**
   * Steering.
   *
   * Every fish holds a heading and swims along it, re-choosing every few
   * seconds. That single change is what stops the "crazy circling": the old
   * version summed two sine waves to wander, and the sum of two sinusoids is a
   * closed loop, so each fish dutifully orbited its own little ellipse forever.
   *
   * On top of the heading, shoal members pull gently toward their shoal and
   * match its direction. Shoals are always one species of small fish (they
   * spawn that way) — a tiger shark drifting in the middle of a school of neon
   * tetras looked absurd, so nothing above `isShoalingSize` ever joins one.
   *
   * Players are not an input to any of this. Nothing chases, nothing flees.
   */
  private simulateEnemies(dt: number) {
    const cull = this.viewRadius() * BALANCE.CULL_RING;
    const cullSq = cull * cull;
    const enemies = [...this.enemies.values()];

    // One pass to find where each shoal is and which way it is going, so the
    // steering pass below is O(n) rather than O(n²).
    const shoals = new Map<number, { x: number; y: number; hx: number; hy: number; n: number }>();
    for (const fish of enemies) {
      if (fish.shoal === undefined) continue;
      const s = shoals.get(fish.shoal) ?? { x: 0, y: 0, hx: 0, hy: 0, n: 0 };
      s.x += fish.x;
      s.y += fish.y;
      s.hx += Math.cos(fish.heading);
      s.hy += Math.sin(fish.heading);
      s.n++;
      shoals.set(fish.shoal, s);
    }

    for (const fish of enemies) {
      // Pick somewhere new to be, now and then.
      fish.turnIn -= dt;
      if (fish.turnIn <= 0) {
        fish.turnIn = BALANCE.TURN_EVERY_MIN + Math.random() * (BALANCE.TURN_EVERY_MAX - BALANCE.TURN_EVERY_MIN);
        // A change of course, not a reversal — a fish that spins 180° on the
        // spot reads as a glitch.
        fish.heading += (Math.random() - 0.5) * 1.9;
      }

      let hx = Math.cos(fish.heading);
      let hy = Math.sin(fish.heading) * 0.55; // fish travel flatter than they climb

      const shoal =
        fish.shoal !== undefined && isShoalingSize(fish.size) ? shoals.get(fish.shoal) : undefined;
      if (shoal && shoal.n > 1) {
        const cxAvg = shoal.x / shoal.n;
        const cyAvg = shoal.y / shoal.n;
        const dx = cxAvg - fish.x;
        const dy = cyAvg - fish.y;
        const dist = Math.hypot(dx, dy) || 1;

        if (dist > BALANCE.SCHOOL_SPREAD) {
          // Straggler: cut back to the group hard, otherwise shoals slowly
          // smear across the whole map and stop reading as shoals.
          hx += (dx / dist) * 2.2;
          hy += (dy / dist) * 2.2;
        } else if (dist > BALANCE.SCHOOL_SPACING) {
          hx += (dx / dist) * BALANCE.SCHOOL_PULL;
          hy += (dy / dist) * BALANCE.SCHOOL_PULL;
        } else {
          // Personal space, weighted above cohesion so the shoal never
          // collapses into a single point.
          hx -= (dx / dist) * 1.3;
          hy -= (dy / dist) * 1.3;
        }

        const align = Math.hypot(shoal.hx, shoal.hy) || 1;
        hx += (shoal.hx / align) * BALANCE.SCHOOL_ALIGN;
        hy += (shoal.hy / align) * BALANCE.SCHOOL_ALIGN * 0.55;
      }

      // Turn back before hitting a wall rather than bouncing off it.
      const margin = 260;
      if (fish.x < margin) hx += 2.5;
      if (fish.x > BALANCE.WORLD_W - margin) hx -= 2.5;
      if (fish.y < margin) hy += 2.5;
      if (fish.y > BALANCE.WORLD_H - margin) hy -= 2.5;

      const len = Math.hypot(hx, hy) || 1;
      const cruise = (BALANCE.ENEMY_MIN_SPEED + fish.size * 0.35) * fish.pace;
      const targetVx = (hx / len) * cruise;
      const targetVy = (hy / len) * cruise;

      // Ease onto the desired velocity, framerate-independently, so fish arc.
      const k = 1 - Math.pow(0.02, dt * BALANCE.TURN_RATE);
      fish.vx += (targetVx - fish.vx) * k;
      fish.vy += (targetVy - fish.vy) * k;

      fish.x += fish.vx * dt;
      fish.y += fish.vy * dt;
      // Keep `heading` following where the fish actually ended up, so shoal
      // alignment and the next random turn both build on reality.
      fish.heading = Math.atan2(fish.vy, fish.vx);
      this.face(fish, dt, 5);
    }

    const players: Fish[] = [];
    this.locals.forEach((f) => !f.dead && players.push(f));
    this.remotes.forEach((f) => !f.dead && players.push(f));

    // Recycle anything nobody can see, then top the population back up. The old
    // code deleted fish the instant they crossed a world edge, which meant a
    // constant churn of spawns nobody ever saw.
    for (const [id, fish] of this.enemies) {
      let visible = players.length === 0;
      for (const p of players) {
        const dx = fish.x - p.x;
        const dy = fish.y - p.y;
        if (dx * dx + dy * dy < cullSq) {
          visible = true;
          break;
        }
      }
      if (!visible) this.enemies.delete(id);
    }

    const target = this.enemyTarget();
    // Topped up a few at a time, so a big cull doesn't produce a visible wall
    // of fish appearing together — except for shoals, which arrive as a group
    // because that is the entire point of them.
    for (let i = 0; i < 3 && this.enemies.size < target; i++) {
      if (Math.random() < BALANCE.SHOAL_CHANCE && this.enemies.size + BALANCE.SHOAL_MAX <= target) {
        this.spawnShoal();
        break;
      }
      this.spawnEnemy();
    }
  }

  /**
   * A group of one species, arriving together and travelling together.
   *
   * Shoals are built at spawn rather than emerging from the steering rules.
   * Letting them form by proximity is what produced schools with a shark in the
   * middle: the only thing the old rule checked was that sizes were close, and
   * two fish of the same size are very often different species.
   */
  private spawnShoal() {
    const ref = this.referenceSize();
    // Always food, and always small — the whole appeal is a cloud of minnows.
    const size = Math.max(4, Math.min(SHOAL_MAX_SIZE, ref * (0.28 + Math.random() * 0.45)));
    const asset = assetForSize(size);
    const count = BALANCE.SHOAL_MIN + Math.floor(Math.random() * (BALANCE.SHOAL_MAX - BALANCE.SHOAL_MIN + 1));

    const anchor = this.spawnAnchor();
    const angle = Math.random() * Math.PI * 2;
    const radius = this.viewRadius() * BALANCE.SPAWN_RING;
    const cx = clamp(anchor.x + Math.cos(angle) * radius, 150, BALANCE.WORLD_W - 150);
    const cy = clamp(anchor.y + Math.sin(angle) * radius, 150, BALANCE.WORLD_H - 150);
    const heading = Math.atan2(anchor.y - cy, anchor.x - cx) + (Math.random() - 0.5);
    const shoalId = this.nextShoalId++;

    for (let i = 0; i < count; i++) {
      const id = this.nextEnemyId++;
      // A little variation in size within the group, so it isn't a stamped grid.
      const fish = this.makeFish(String(id), 'enemy', size * (0.88 + Math.random() * 0.24), asset);
      fish.x = cx + (Math.random() - 0.5) * 220;
      fish.y = cy + (Math.random() - 0.5) * 150;
      fish.shoal = shoalId;
      fish.heading = heading;
      fish.angle = heading;
      const speed = BALANCE.ENEMY_MIN_SPEED + Math.random() * 40;
      fish.vx = Math.cos(heading) * speed;
      fish.vy = Math.sin(heading) * speed * 0.5;
      this.enemies.set(id, fish);
    }
  }

  private simulateBoss(dt: number) {
    if (!this.boss) {
      this.bossTimer += dt;
      if (this.bossTimer < BALANCE.BOSS_INTERVAL) return;
      this.bossTimer = 0;
      this.bossLife = 0;
      const fromLeft = Math.random() > 0.5;
      const boss = this.makeFish('boss', 'boss', BALANCE.BOSS_SIZE, BOSS_ASSET);
      boss.x = fromLeft ? -250 : BALANCE.WORLD_W + 250;
      boss.y = Math.random() * BALANCE.WORLD_H;
      boss.name = 'Zombie Shark';
      boss.opacity = 0;
      this.boss = boss;
      audioService.playBite();
      return;
    }

    this.bossLife += dt;
    const remaining = BALANCE.BOSS_DURATION - this.bossLife;
    // Fades in on arrival and out on departure, so it never simply blinks into
    // existence on top of somebody.
    this.boss.opacity = Math.max(0, Math.min(1, Math.min(this.bossLife / 1.5, remaining / 2)));
    if (remaining <= 0) {
      this.boss = null;
      return;
    }

    let target: Fish | null = null;
    let best = Infinity;
    const consider = (f: Fish) => {
      if (f.dead) return;
      const d = (f.x - this.boss!.x) ** 2 + (f.y - this.boss!.y) ** 2;
      if (d < best) {
        best = d;
        target = f;
      }
    };
    this.locals.forEach(consider);
    this.remotes.forEach(consider);

    if (target) {
      const t = target as Fish;
      const angle = Math.atan2(t.y - this.boss.y, t.x - this.boss.x);
      this.boss.vx = Math.cos(angle) * BALANCE.BOSS_SPEED;
      this.boss.vy = Math.sin(angle) * BALANCE.BOSS_SPEED;
    }
    this.boss.x += this.boss.vx * dt;
    this.boss.y += this.boss.vy * dt;
    this.face(this.boss, dt, 3);
  }

  // ── network smoothing ────────────────────────────────────────────────────

  private interpolate(fishes: Iterable<Fish>, dt: number) {
    for (const fish of fishes) this.applyNet(fish, dt);
  }

  /**
   * Dead reckoning plus error correction. Snapshots arrive several times a
   * second; frames happen sixty times a second. Carrying the last snapshot
   * forward along its own velocity and easing toward it keeps remote fish
   * moving smoothly instead of stepping between packets.
   */
  private applyNet(fish: Fish, dt: number) {
    const net = fish.net;
    if (!net) return;
    const age = Math.min(NET_MAX_EXTRAPOLATION, performance.now() / 1000 - net.at);
    const targetX = net.x + net.vx * age;
    const targetY = net.y + net.vy * age;

    fish.vx = net.vx;
    fish.vy = net.vy;

    const dx = targetX - fish.x;
    const dy = targetY - fish.y;
    if (dx * dx + dy * dy > 500 * 500) {
      // A gap that big is a respawn or a dropped connection, not lag.
      fish.x = targetX;
      fish.y = targetY;
      return;
    }
    const k = 1 - Math.pow(NET_CATCHUP, dt);
    fish.x += dx * k;
    fish.y += dy * k;
    this.face(fish, dt, 6);
  }

  // ── collisions ───────────────────────────────────────────────────────────

  private checkCollisions() {
    const now = performance.now() / 1000;

    this.locals.forEach((me, myId) => {
      if (me.dead) return;
      const protectedUntil = me.bornAt + BALANCE.SPAWN_PROTECTION;
      const invulnerable = now < protectedUntil;

      // AI fish
      for (const [id, enemy] of this.enemies) {
        if (!overlaps(me, enemy)) continue;
        if (canEat(me, enemy)) {
          // Removed straight away so eating feels instant. If we are a guest,
          // the host is told and confirms it to everyone else; the worst case
          // is that two players briefly both believe they got the same fish.
          this.enemies.delete(id);
          if (this.simulateAI) this.pendingKills.push(id);
          this.grow(me, enemy.size);
          this.burst(enemy.x, enemy.y, 12);
          this.config.onEnemyEaten(id);
          this.config.onEat(me.score, me.size);
        } else if (canEat(enemy, me) && !invulnerable) {
          this.kill(myId, me, FISH_ASSETS[enemy.asset].name);
          return;
        } else {
          separate(me, enemy);
        }
      }

      // Boss
      if (this.boss && (this.boss.opacity ?? 1) > 0.5 && overlaps(me, this.boss) && !invulnerable) {
        this.kill(myId, me, 'the Zombie Shark');
        return;
      }

      // Other players — local co-op partners and everyone online.
      const others: [string, Fish][] = [];
      this.locals.forEach((f, id) => id !== myId && others.push([id, f]));
      this.remotes.forEach((f, id) => others.push([id, f]));

      for (const [otherId, other] of others) {
        if (other.dead || !overlaps(me, other)) continue;

        // Players bump apart instead of eating each other. The run is a race to
        // grow against the reef, not a deathmatch.
        if (!BALANCE.PVP_EATING) {
          separate(me, other);
          continue;
        }

        // When it is on, the outcome is only ever decided by the fish that
        // *loses*. Both clients run this same check on their own player, so
        // having the victim announce the death is the only arrangement where
        // the two can never disagree about who ate whom.
        if (canEat(other, me)) {
          if (invulnerable) continue;
          this.kill(myId, me, other.name ?? 'another fish', otherId);
          return;
        }
        if (!canEat(me, other)) separate(me, other);
      }
    });
  }

  private kill(id: string, fish: Fish, killedBy: string, eaterId?: string) {
    const size = fish.size;
    fish.dead = true;
    fish.vx = 0;
    fish.vy = 0;
    this.burst(fish.x, fish.y, 26);
    audioService.playGameOverSound();
    // The eater rides along so the App can hand them the growth — the victim is
    // the only one who can say for certain that it happened.
    this.config.onDeath(id, killedBy, eaterId, Math.round(size));
  }

  private grow(fish: Fish, eatenSize: number) {
    fish.score += Math.round(eatenSize * BALANCE.SCORE_RATE);
    fish.size = Math.min(
      BALANCE.MAX_SIZE,
      Math.sqrt(fish.size * fish.size + eatenSize * eatenSize * BALANCE.GROWTH),
    );
    // `asset` is deliberately untouched. You stay the fish you chose and simply
    // get bigger; swapping the sprite as the score climbed meant players stopped
    // recognising themselves halfway through a run.
    audioService.playEatSound();
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private makeFish(id: string, kind: Fish['kind'], size: number, asset: number): Fish {
    return {
      id,
      kind,
      x: BALANCE.WORLD_W / 2,
      y: BALANCE.WORLD_H / 2,
      vx: 0,
      vy: 0,
      size,
      score: 0,
      asset,
      angle: 0,
      dead: false,
      bornAt: performance.now() / 1000,
      pace: 0.85 + Math.random() * 0.35,
      heading: Math.random() * Math.PI * 2,
      turnIn: BALANCE.TURN_EVERY_MIN + Math.random() * BALANCE.TURN_EVERY_MAX,
    };
  }

  /** Turns a fish toward its heading, at a rate that doesn't depend on frame rate. */
  private face(fish: Fish, dt: number, rate: number) {
    if (Math.abs(fish.vx) < 1 && Math.abs(fish.vy) < 1) return;
    const target = Math.atan2(fish.vy, fish.vx);
    let diff = target - fish.angle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    fish.angle += diff * Math.min(1, rate * dt);
  }

  private initBubbles() {
    this.bubbles = [];
    // Ambient bubbles are pure atmosphere and there are sixty of them, each an
    // arc fill every frame — the first thing worth thinning on a slow device.
    const count = Math.round(BALANCE.BUBBLES * this.governor.quality.particles);
    for (let i = 0; i < count; i++) {
      this.bubbles.push({
        x: Math.random() * BALANCE.WORLD_W,
        y: Math.random() * BALANCE.WORLD_H,
        r: Math.random() * 3 + 1,
        speed: Math.random() * 35 + 12,
        alpha: Math.random() * 0.14 + 0.05,
        phase: Math.random() * Math.PI * 2,
        sway: Math.random() * 16 + 5,
      });
    }
  }

  private updateBubbles(dt: number) {
    for (const b of this.bubbles) {
      b.y -= b.speed * dt;
      b.phase += dt * 2;
      if (b.y < -20) {
        b.y = BALANCE.WORLD_H + 20;
        b.x = Math.random() * BALANCE.WORLD_W;
      }
    }
  }

  private burst(x: number, y: number, count: number) {
    // Never rounded away to nothing: a kill with no splash reads as a bug.
    const n = Math.max(1, Math.round(count * this.governor.quality.particles));
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 110;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: Math.random() * 4 + 2,
        life: 0,
        max: 0.4 + Math.random() * 0.6,
      });
    }
  }

  private updateParticles(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.max) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy -= 45 * dt; // buoyancy
    }
  }

  private async loadImages() {
    const total = FISH_ASSETS.length + 1;
    let loaded = 0;
    const done = () => {
      loaded++;
      this.config.onProgress?.(loaded / total);
    };

    const bg = new Image();
    // WebP, for the same reason the fish are: the JPEG was 775 KB — more than
    // the entire rest of this bundle's assets put together — for an image that
    // is then stretched over a 3000x2200 world and never seen at native size.
    // The WebP is 125 KB and indistinguishable once scaled.
    //
    // BASE_URL rather than a bare filename so it resolves under any deploy
    // prefix, the same way fishSrc() does.
    bg.src = `${import.meta.env.BASE_URL}bg.webp`;
    bg.onload = () => {
      this.backdrop = bg;
      done();
    };
    bg.onerror = done;

    FISH_ASSETS.forEach((_, index) => {
      const img = new Image();
      img.src = fishSrc(index);
      img.onload = () => {
        this.images.set(index, img);
        done();
      };
      img.onerror = done;
    });
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private draw() {
    const ctx = this.ctx;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b4f74';
    ctx.fillRect(0, 0, cw, ch);

    ctx.save();
    ctx.scale(cw / this.effViewW, ch / this.effViewH);

    // Camera follows the centroid of whoever is alive locally, and is clamped
    // so the view never slides off the world into empty space.
    let tx = BALANCE.WORLD_W / 2;
    let ty = BALANCE.WORLD_H / 2;
    const alive = [...this.locals.values()].filter((f) => !f.dead);
    if (alive.length) {
      tx = alive.reduce((s, f) => s + f.x, 0) / alive.length;
      ty = alive.reduce((s, f) => s + f.y, 0) / alive.length;
    }
    tx = clampView(tx, this.effViewW, BALANCE.WORLD_W);
    ty = clampView(ty, this.effViewH, BALANCE.WORLD_H);
    // Same easing per unit of time regardless of frame rate: at 144Hz the
    // camera must not converge nearly three times faster than at 60Hz.
    const k = 1 - Math.pow(0.05, this.lastDt);
    this.cameraX += (tx - this.cameraX) * k;
    this.cameraY += (ty - this.cameraY) * k;

    ctx.translate(this.effViewW / 2 - this.cameraX, this.effViewH / 2 - this.cameraY);

    if (this.backdrop) {
      ctx.drawImage(this.backdrop, 0, 0, BALANCE.WORLD_W, BALANCE.WORLD_H);
    } else {
      ctx.fillStyle = '#0a4468';
      ctx.fillRect(0, 0, BALANCE.WORLD_W, BALANCE.WORLD_H);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 8;
    ctx.strokeRect(0, 0, BALANCE.WORLD_W, BALANCE.WORLD_H);

    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (const b of this.bubbles) {
      ctx.globalAlpha = b.alpha;
      ctx.beginPath();
      ctx.arc(b.x + Math.sin(b.phase) * b.sway, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const p of this.particles) {
      ctx.globalAlpha = 0.6 * (1 - p.life / p.max);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // AI fish stay "alive" out to CULL_RING (2.1x the view radius) so the
    // population doesn't visibly pop in and out — but that means most of them
    // sit well outside what the camera can actually see. Each one drawn costs
    // a save/rotate/drawImage plus a stroked+filled text label, which is real
    // money on a mobile GPU; skipping the ones the player can't see is what
    // keeps a crowded reef from stuttering on a phone.
    const margin = 300;
    const left = this.cameraX - this.effViewW / 2 - margin;
    const right = this.cameraX + this.effViewW / 2 + margin;
    const top = this.cameraY - this.effViewH / 2 - margin;
    const bottom = this.cameraY + this.effViewH / 2 + margin;
    const onScreen = (f: Fish) => f.x > left && f.x < right && f.y > top && f.y < bottom;

    this.enemies.forEach((f) => onScreen(f) && this.drawFish(f, false));
    if (this.boss && onScreen(this.boss)) this.drawBoss();
    this.remotes.forEach((f) => !f.dead && onScreen(f) && this.drawFish(f, false, true));
    this.locals.forEach((f) => !f.dead && this.drawFish(f, true));

    ctx.restore();
  }

  private drawFish(fish: Fish, isLocal: boolean, isRemotePlayer = false) {
    const ctx = this.ctx;
    const now = performance.now() / 1000;

    ctx.save();
    ctx.translate(fish.x, fish.y);

    /**
     * Sprites are drawn facing right and must stay belly-down whichever way
     * the fish swims.
     *
     * This used to rotate by the full heading and then mirror *vertically*
     * once past ±90°, which is the flipping that got reported: the sprite is
     * upside down for the whole left-hand semicircle, and the correction snaps
     * on at the instant the fish crosses vertical rather than easing in.
     *
     * Mirroring horizontally instead keeps the fish the right way up through
     * every heading — a fish swimming left is the same fish facing the other
     * way. The remaining rotation is pitch only, measured against the
     * horizontal and clamped, so a fish climbing or diving still angles into
     * the direction it is going without ever standing on its nose.
     */
    const facingLeft = Math.cos(fish.angle) < 0;
    const pitch = clamp(
      Math.atan2(Math.sin(fish.angle), Math.abs(Math.cos(fish.angle))),
      -BALANCE.MAX_PITCH,
      BALANCE.MAX_PITCH,
    );
    // Scale before rotate: the mirror flips the x axis, so the sprite's nose
    // points left while `pitch` keeps meaning "down the screen is positive".
    if (facingLeft) ctx.scale(-1, 1);
    ctx.rotate(pitch);
    if (fish.opacity !== undefined) ctx.globalAlpha = fish.opacity;

    // Every dimension below comes off bodyRadius, so the ring, the sprite and
    // the label stay glued to the fish at any size.
    const body = bodyRadius(fish.size);

    if (isLocal) {
      const age = now - fish.bornAt;
      if (age < BALANCE.SPAWN_PROTECTION) {
        const pulse = Math.sin(age * 8) * 0.5 + 0.5;
        ctx.beginPath();
        ctx.arc(0, 0, body * 1.35 + pulse * 12, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${0.15 + pulse * 0.25})`;
        ctx.fill();
      }
    }

    const img = this.images.get(fish.asset);
    if (img) {
      const aspect = img.naturalWidth / img.naturalHeight || 1;
      const w = body * SPRITE_HALF_W * 2;
      const h = w / aspect;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      ctx.fillStyle = isLocal ? '#4ade80' : '#94a3b8';
      ctx.beginPath();
      ctx.arc(0, 0, body, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Labels are drawn upright, outside the fish's own rotation.
    if (fish.kind === 'boss') return;
    ctx.save();
    ctx.translate(fish.x, fish.y - body * 0.95 - 14);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.max(13, body * 0.42)}px system-ui, sans-serif`;
    ctx.fillStyle = isLocal ? '#bbf7d0' : isRemotePlayer ? '#fde68a' : '#ffffff';
    const label = fish.kind === 'player' && fish.name ? `${fish.name} · ${Math.floor(fish.size)}` : String(Math.floor(fish.size));
    // The number on a fish is what tells you whether it eats you or you eat it,
    // so the label itself always draws. The outline behind it is legibility
    // only, and stroked text is the most expensive call in this whole loop —
    // on a crowded reef it runs once per visible fish, every frame.
    if (this.governor.quality.outlines) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.strokeText(label, 0, 0);
    }
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  private drawBoss() {
    const boss = this.boss!;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = boss.opacity ?? 1;
    ctx.translate(boss.x, boss.y);
    const aura = bodyRadius(boss.size) * 1.5;
    // The aura is a warning, so it stays at every tier — but the cheap tier
    // pays a flat wash for it rather than building a gradient object a frame.
    ctx.beginPath();
    ctx.arc(0, 0, aura, 0, Math.PI * 2);
    if (this.governor.quality.fancy) {
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, aura);
      grad.addColorStop(0, 'rgba(255,0,0,0.25)');
      grad.addColorStop(1, 'rgba(255,0,0,0)');
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = 'rgba(255,0,0,0.12)';
    }
    ctx.fill();
    ctx.restore();
    this.drawFish(boss, false);
  }
}

// ── free functions ─────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * How big a fish actually *looks*, in world units.
 *
 * `size` is the abstract score-like quantity that grows by area; the sprite is
 * drawn from this compressed curve so that a size-200 whale is impressive
 * rather than screen-filling. Everything the player can see — the sprite, the
 * hitbox, the name label, the spawn ring — has to be derived from this one
 * function or they drift apart as fish grow. They used to: collision scaled
 * linearly with `size` while the art scaled with `size^0.75`, so by size 150
 * the hitbox was about twice the width of the fish and you were eaten by open
 * water.
 */
export function bodyRadius(size: number): number {
  return 10 + Math.pow(size, 0.75) * BALANCE.VISUAL_SCALE;
}

/**
 * How far out the camera should sit for a fish this size, as a multiple of
 * the base view.
 *
 * Tracks `bodyRadius` against the size a run starts at, so the view widens at
 * roughly the rate the sprite itself does and a fish keeps covering about the
 * same share of the screen throughout a run, capped at `ZOOM_MAX` so the reef
 * never shrinks to a speck once someone is huge.
 */
export function zoomFor(size: number): number {
  const ref = bodyRadius(BALANCE.START_SIZE);
  return clamp(bodyRadius(size) / ref, 1, BALANCE.ZOOM_MAX);
}

/** Half-width and half-height of the drawn sprite, at `bodyRadius` scale. */
const SPRITE_HALF_W = 1.25;

/**
 * Who eats whom.
 *
 * The player reads sizes off the labels, which are floored to whole numbers, so
 * the rule is stated in exactly those terms: if the number over their head is
 * lower than the number over yours, you eat them. The old rule needed a 6%
 * edge, which at size 50 meant a fish showing "49" was uneatable and at size
 * 150 a fish showing "141" was — the bigger you got, the more the game
 * disagreed with its own HUD.
 *
 * Equal displayed sizes mean neither can eat the other, so two evenly matched
 * fish still bump apart rather than trading a coin flip on floating point noise.
 */
function canEat(predator: Fish, prey: Fish): boolean {
  return Math.floor(predator.size) > Math.floor(prey.size);
}

/** Keeps the camera inside the world, or centres it when the view is bigger. */
function clampView(target: number, view: number, world: number) {
  if (view >= world) return world / 2;
  return clamp(target, view / 2, world - view / 2);
}

/**
 * Fish are longer than they are tall, so a circle is a poor hitbox: it lets a
 * fish be eaten by something level with its tail. This is an ellipse sized off
 * `bodyRadius`, the same curve the sprite is drawn from, and deliberately a
 * little tighter than the art — the sprites carry transparent padding, and a
 * hitbox that stops just inside the visible fish reads as fair, where one that
 * reaches past it reads as broken.
 */
const HIT_X = 1;
const HIT_Y = 0.62;

function contactRadii(a: Fish, b: Fish): { rx: number; ry: number } {
  const reach = bodyRadius(a.size) + bodyRadius(b.size);
  return { rx: reach * HIT_X, ry: reach * HIT_Y };
}

function overlaps(a: Fish, b: Fish): boolean {
  const { rx, ry } = contactRadii(a, b);
  const dx = (a.x - b.x) / rx;
  const dy = (a.y - b.y) / ry;
  return dx * dx + dy * dy < 1;
}

/** Two fish that cannot eat each other push apart instead of overlapping. */
function separate(a: Fish, b: Fish) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dist = Math.hypot(dx, dy) || 1;
  const { rx } = contactRadii(a, b);
  const overlap = rx - dist;
  if (overlap <= 0) return;
  a.x += (dx / dist) * overlap * 0.5;
  a.y += (dy / dist) * overlap * 0.5;
}
