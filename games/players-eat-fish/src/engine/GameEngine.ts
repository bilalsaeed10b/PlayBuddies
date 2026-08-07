import { Fish, GameSettings, PlayerPacket, EnemyPacket, Vector2D } from '../types/game';
import {
  FISH_ASSETS,
  BOSS_ASSET,
  assetForSize,
  lineOf,
  fishSrc,
  BACKGROUND_SRC,
} from '../game/fish';
import { audioService } from '../services/audio';

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

  // Player
  PLAYER_ACCEL: 1400,
  PLAYER_BASE_SPEED: 190,
  PLAYER_SPEED_PER_SIZE: 0.55,
  /** Water is denser vertically than the arcade feel wants. */
  PLAYER_VERTICAL_DAMPEN: 0.85,
  PLAYER_FRICTION: 0.9,
  START_SIZE: 6,
  MAX_SIZE: 200,
  /**
   * Growth is by area, not by radius: size² accumulates. Eating your first few
   * fish is dramatic and eating your hundredth barely moves the needle, which
   * is what keeps a long run from ending with one fish filling the screen.
   */
  GROWTH: 0.55,
  SPAWN_PROTECTION: 2.5,
  /**
   * A fish must be this much bigger to eat. Inside the margin neither side can
   * eat the other, so two evenly matched players circle instead of trading a
   * coin-flip decided by floating point noise.
   */
  EAT_MARGIN: 1.06,

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
  /** How far an AI fish looks for something to chase or run from. */
  AWARENESS: 340,
  FLEE_WEIGHT: 2.4,
  CHASE_WEIGHT: 1.5,
  SCHOOL_WEIGHT: 0.5,
  WANDER_WEIGHT: 0.8,

  // Boss
  BOSS_INTERVAL: 90,
  BOSS_DURATION: 18,
  BOSS_SPEED: 155,
  BOSS_SIZE: 190,

  // Presentation
  BUBBLES: 60,
  VISUAL_SCALE: 1.3,
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
  private background: HTMLImageElement | null = null;

  private locals = new Map<string, Fish>();
  private remotes = new Map<string, Fish>();
  private enemies = new Map<number, Fish>();
  private boss: Fish | null = null;

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
  /** Enemies eaten since the last time the host published a removal batch. */
  private pendingKills: number[] = [];

  private viewW = 1200;
  private viewH = 900;
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

    config.localIds.forEach((id, i) => {
      const asset = config.localFish[id] ?? 0;
      const fish = this.makeFish(id, 'player', FISH_ASSETS[asset].size, asset);
      // Players all move at exactly the same rate. `pace` exists to stop a
      // shoal of AI fish swimming as one rigid block; applying it to a person
      // would hand one player a third more top speed than another for no
      // reason they could see.
      fish.pace = 1;
      fish.line = lineOf(asset);
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
   * Whoever owns the AI can change mid-match: if the host drops, the platform
   * promotes someone else and this flips on for them.
   */
  setSimulateAI(on: boolean) {
    if (this.simulateAI === on) return;
    this.simulateAI = on;
    if (on && this.enemies.size === 0) this.seedEnemies();
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
    fish.line = lineOf(asset);
    fish.score = 0;
    fish.dead = false;
    fish.vx = 0;
    fish.vy = 0;
    fish.bornAt = performance.now() / 1000;
    // Away from the edges, and away from whatever just ate them.
    fish.x = BALANCE.WORLD_W * (0.25 + Math.random() * 0.5);
    fish.y = BALANCE.WORLD_H * (0.25 + Math.random() * 0.5);
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
    // GPU to fill nine times the pixels for a barely visible gain.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.ctx.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.ctx.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.config.canvas.style.width = `${rect.width}px`;
    this.config.canvas.style.height = `${rect.height}px`;

    const aspect = this.ctx.canvas.width / this.ctx.canvas.height || 1;
    this.viewW = Math.min(BALANCE.VIEW_MAX_EDGE, Math.sqrt(BALANCE.VIEW_AREA * aspect));
    this.viewH = Math.min(BALANCE.VIEW_MAX_EDGE, Math.sqrt(BALANCE.VIEW_AREA / aspect));
  }

  private viewRadius() {
    return Math.hypot(this.viewW, this.viewH) / 2;
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

    this.update(dt);
    this.draw();

    this.raf = requestAnimationFrame(this.loop);
  };

  private update(dt: number) {
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
    for (let i = 0; i < target; i++) {
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

    let size: number;
    if (roll < 0.45) {
      // Prey: always something to eat, so a run never stalls.
      size = ref * (0.25 + Math.random() * 0.6);
    } else if (roll < 0.7) {
      // Peers: can't eat you, you can't eat them. They make the water feel busy.
      size = ref * (0.85 + Math.random() * 0.3);
    } else {
      // Predators: the reason you keep moving.
      size = ref * (1.2 + Math.random() * 1.0);
    }
    size = Math.max(4, Math.min(BALANCE.MAX_SIZE * 0.9, size));

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
   * Steering. Each fish sums a few weighted urges and turns toward the result:
   * run from anything that could eat it, chase anything it could eat, drift
   * with fish its own size, and wander when nothing else is going on.
   *
   * The previous version simply picked a direction at spawn and swam in a
   * straight line until it left the map — which is why the ocean felt like a
   * screensaver rather than somewhere anything lived.
   */
  private simulateEnemies(dt: number) {
    const players: Fish[] = [];
    this.locals.forEach((f) => !f.dead && players.push(f));
    this.remotes.forEach((f) => !f.dead && players.push(f));

    const awareSq = BALANCE.AWARENESS * BALANCE.AWARENESS;
    const cull = this.viewRadius() * BALANCE.CULL_RING;
    const cullSq = cull * cull;
    const enemies = [...this.enemies.values()];

    for (const fish of enemies) {
      let sx = 0;
      let sy = 0;

      for (const other of players) {
        const dx = fish.x - other.x;
        const dy = fish.y - other.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > awareSq || distSq < 1) continue;
        const dist = Math.sqrt(distSq);
        // Closer means stronger, so a predator two body-lengths away dominates
        // whatever else the fish was thinking about.
        const urgency = 1 - dist / BALANCE.AWARENESS;

        if (other.size > fish.size * BALANCE.EAT_MARGIN) {
          sx += (dx / dist) * BALANCE.FLEE_WEIGHT * urgency;
          sy += (dy / dist) * BALANCE.FLEE_WEIGHT * urgency;
        } else if (fish.size > other.size * BALANCE.EAT_MARGIN) {
          sx -= (dx / dist) * BALANCE.CHASE_WEIGHT * urgency;
          sy -= (dy / dist) * BALANCE.CHASE_WEIGHT * urgency;
        }
      }

      // Shoaling with fish of a similar size. Sampled rather than exhaustive:
      // with 70 fish a full pairwise pass every frame is 4,900 comparisons for
      // an effect nobody can distinguish from this.
      for (let i = 0; i < 4; i++) {
        const mate = enemies[(Math.random() * enemies.length) | 0];
        if (!mate || mate === fish) continue;
        const dx = mate.x - fish.x;
        const dy = mate.y - fish.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > 30000 || distSq < 1) continue;
        const similar = Math.abs(mate.size - fish.size) < fish.size * 0.4;
        if (!similar) continue;
        const dist = Math.sqrt(distSq);
        // Cohere, but keep a body length of personal space.
        const pull = dist > 90 ? 1 : -1;
        sx += (dx / dist) * BALANCE.SCHOOL_WEIGHT * pull;
        sy += (dy / dist) * BALANCE.SCHOOL_WEIGHT * pull;
      }

      fish.wander += dt * (0.6 + fish.pace);
      sx += Math.cos(fish.wander * 1.3) * BALANCE.WANDER_WEIGHT;
      sy += Math.sin(fish.wander) * BALANCE.WANDER_WEIGHT * 0.5;

      // Turn away from the walls before hitting them.
      const margin = 160;
      if (fish.x < margin) sx += 2;
      if (fish.x > BALANCE.WORLD_W - margin) sx -= 2;
      if (fish.y < margin) sy += 2;
      if (fish.y > BALANCE.WORLD_H - margin) sy -= 2;

      const steer = Math.hypot(sx, sy);
      const cruise = (BALANCE.ENEMY_MIN_SPEED + fish.size * 0.35) * fish.pace;
      if (steer > 0.001) {
        const targetVx = (sx / steer) * cruise;
        const targetVy = (sy / steer) * cruise;
        // Ease toward the desired heading so fish arc rather than snap.
        const k = 1 - Math.pow(0.0005, dt);
        fish.vx += (targetVx - fish.vx) * k;
        fish.vy += (targetVy - fish.vy) * k;
      }

      fish.x += fish.vx * dt;
      fish.y += fish.vy * dt;
      this.face(fish, dt, 5);
    }

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
    // A few per frame, not all at once, so a big cull doesn't cause a visible
    // wall of fish appearing together.
    for (let i = 0; i < 3 && this.enemies.size < target; i++) this.spawnEnemy();
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
        if (me.size > enemy.size * BALANCE.EAT_MARGIN) {
          // Removed straight away so eating feels instant. If we are a guest,
          // the host is told and confirms it to everyone else; the worst case
          // is that two players briefly both believe they got the same fish.
          this.enemies.delete(id);
          if (this.simulateAI) this.pendingKills.push(id);
          this.grow(me, enemy.size);
          this.burst(enemy.x, enemy.y, 12);
          this.config.onEnemyEaten(id);
          this.config.onEat(me.score, me.size);
        } else if (enemy.size > me.size * BALANCE.EAT_MARGIN && !invulnerable) {
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
      //
      // Only ever decided by the fish that *loses*. Both clients run this same
      // check on their own player, so having the victim announce the death is
      // the only version where the two can never disagree about who ate whom.
      const others: [string, Fish][] = [];
      this.locals.forEach((f, id) => id !== myId && others.push([id, f]));
      this.remotes.forEach((f, id) => others.push([id, f]));

      for (const [otherId, other] of others) {
        if (other.dead || !overlaps(me, other)) continue;
        if (other.size > me.size * BALANCE.EAT_MARGIN) {
          if (invulnerable) continue;
          this.kill(myId, me, other.name ?? 'another fish', otherId);
          return;
        }
        if (me.size <= other.size * BALANCE.EAT_MARGIN) separate(me, other);
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
    fish.score += Math.round(eatenSize);
    fish.size = Math.min(
      BALANCE.MAX_SIZE,
      Math.sqrt(fish.size * fish.size + eatenSize * eatenSize * BALANCE.GROWTH),
    );
    fish.asset = assetForSize(fish.size, fish.line);
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
      wander: Math.random() * Math.PI * 2,
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
    for (let i = 0; i < BALANCE.BUBBLES; i++) {
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
    for (let i = 0; i < count; i++) {
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
    bg.src = BACKGROUND_SRC;
    bg.onload = () => {
      this.background = bg;
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
    ctx.scale(cw / this.viewW, ch / this.viewH);

    // Camera follows the centroid of whoever is alive locally, and is clamped
    // so the view never slides off the world into empty space.
    let tx = BALANCE.WORLD_W / 2;
    let ty = BALANCE.WORLD_H / 2;
    const alive = [...this.locals.values()].filter((f) => !f.dead);
    if (alive.length) {
      tx = alive.reduce((s, f) => s + f.x, 0) / alive.length;
      ty = alive.reduce((s, f) => s + f.y, 0) / alive.length;
    }
    tx = clampView(tx, this.viewW, BALANCE.WORLD_W);
    ty = clampView(ty, this.viewH, BALANCE.WORLD_H);
    // Same easing per unit of time regardless of frame rate: at 144Hz the
    // camera must not converge nearly three times faster than at 60Hz.
    const k = 1 - Math.pow(0.05, this.lastDt);
    this.cameraX += (tx - this.cameraX) * k;
    this.cameraY += (ty - this.cameraY) * k;

    ctx.translate(this.viewW / 2 - this.cameraX, this.viewH / 2 - this.cameraY);

    if (this.background) {
      ctx.drawImage(this.background, 0, 0, BALANCE.WORLD_W, BALANCE.WORLD_H);
    } else {
      const grad = ctx.createLinearGradient(0, 0, 0, BALANCE.WORLD_H);
      grad.addColorStop(0, '#4facfe');
      grad.addColorStop(1, '#00639b');
      ctx.fillStyle = grad;
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

    this.enemies.forEach((f) => this.drawFish(f, false));
    if (this.boss) this.drawBoss();
    this.remotes.forEach((f) => !f.dead && this.drawFish(f, false, true));
    this.locals.forEach((f) => !f.dead && this.drawFish(f, true));

    ctx.restore();
  }

  private drawFish(fish: Fish, isLocal: boolean, isRemotePlayer = false) {
    const ctx = this.ctx;
    const now = performance.now() / 1000;

    ctx.save();
    ctx.translate(fish.x, fish.y);
    ctx.rotate(fish.angle);
    // Sprites face right; rotating past vertical would otherwise draw them
    // upside down, so mirror instead of rotating all the way round.
    if (Math.abs(fish.angle) > Math.PI / 2) ctx.scale(1, -1);
    if (fish.opacity !== undefined) ctx.globalAlpha = fish.opacity;

    if (isLocal) {
      const age = now - fish.bornAt;
      if (age < BALANCE.SPAWN_PROTECTION) {
        const pulse = Math.sin(age * 8) * 0.5 + 0.5;
        ctx.beginPath();
        ctx.arc(0, 0, fish.size * 1.5 + pulse * 12, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${0.15 + pulse * 0.25})`;
        ctx.fill();
      }
    }

    const img = this.images.get(fish.asset);
    if (img) {
      const aspect = img.naturalWidth / img.naturalHeight || 1;
      const visual = 10 + Math.pow(fish.size, 0.75) * BALANCE.VISUAL_SCALE;
      const w = visual * 2.5;
      const h = w / aspect;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      ctx.fillStyle = isLocal ? '#4ade80' : '#94a3b8';
      ctx.beginPath();
      ctx.arc(0, 0, fish.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Labels are drawn upright, outside the fish's own rotation.
    if (fish.kind === 'boss') return;
    ctx.save();
    ctx.translate(fish.x, fish.y - fish.size - 14);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.max(13, fish.size * 0.45)}px system-ui, sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.fillStyle = isLocal ? '#bbf7d0' : isRemotePlayer ? '#fde68a' : '#ffffff';
    const label = fish.kind === 'player' && fish.name ? `${fish.name} · ${Math.floor(fish.size)}` : String(Math.floor(fish.size));
    ctx.strokeText(label, 0, 0);
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  private drawBoss() {
    const boss = this.boss!;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = boss.opacity ?? 1;
    ctx.translate(boss.x, boss.y);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, boss.size * 1.4);
    grad.addColorStop(0, 'rgba(255,0,0,0.25)');
    grad.addColorStop(1, 'rgba(255,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, boss.size * 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this.drawFish(boss, false);
  }
}

// ── free functions ─────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Keeps the camera inside the world, or centres it when the view is bigger. */
function clampView(target: number, view: number, world: number) {
  if (view >= world) return world / 2;
  return clamp(target, view / 2, world - view / 2);
}

/**
 * Fish are longer than they are tall, so a circle is a poor hitbox: it lets a
 * fish be eaten by something level with its tail. This stretches the test into
 * an ellipse that matches the sprite.
 */
function overlaps(a: Fish, b: Fish): boolean {
  const dx = (a.x - b.x) / 1.4;
  const dy = (a.y - b.y) / 0.8;
  const reach = (a.size + b.size) * 0.8;
  return dx * dx + dy * dy < reach * reach;
}

/** Two fish that cannot eat each other push apart instead of overlapping. */
function separate(a: Fish, b: Fish) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dist = Math.hypot(dx, dy) || 1;
  const overlap = (a.size + b.size) * 0.8 - dist;
  if (overlap <= 0) return;
  a.x += (dx / dist) * overlap * 0.5;
  a.y += (dy / dist) * overlap * 0.5;
}
