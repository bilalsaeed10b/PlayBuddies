import { Fish, GameSettings, PlayerPacket, EnemyPacket, Vector2D } from '../types/game';
import {
  FISH_ASSETS,
  BOSS_ASSET,
  assetForSize,
  isShoalingSize,
  SHOAL_MAX_SIZE,
  STARTING_SIZE,
  fishSrc,
} from '../game/fish';

import { audioService } from '../services/audio';
import { QualityGovernor } from '../game/quality';
import { steadyInterval } from '@shared/net/steadyTimer';

/**
 * ONE PLACE TO TUNE THE GAME.
 *
 * Every number that decides how the ocean feels lives here. Times are seconds,
 * distances are world units, speeds are world units per second , the simulation
 * has no notion of frames, which is what makes it identical at 30, 60 and 144Hz.
 */
export const BALANCE = {
  // World
  WORLD_W: 1600,
  WORLD_H: 900,
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
   * Area growth keeps large fish from exploding in size. 0.16 is deliberately
   * below the original 0.24 pace, but high enough that a run visibly develops
   * instead of leaving the player almost unchanged after many catches.
   */
  GROWTH: 0.16,
  /** Score is immediate progress; restoring the original pace keeps every catch rewarding. */
  SCORE_RATE: 0.8,
  SPAWN_PROTECTION: 2.5,

  // AI population
  /** Enough life to create choices while keeping the calm, single-fish flow. */
  ENEMY_BASE: 9,
  ENEMY_PER_PLAYER: 3,
  /**
   * How many more fish join the reef as the local fleet grows, on top of
   * ENEMY_BASE -- ramped by the same `grown` curve as the predator mix (see
   * PREDATOR_RAMP_SIZE), so the water fills up over a run instead of holding
   * at one fixed headcount from the first second to the last.
   */
  ENEMY_GROWTH_BONUS: 6,
  ENEMY_MAX: 24,
  ENEMY_MIN_SPEED: 48,
  ENEMY_MAX_SPEED: 92,
  /**
   * How much the local fleet has to grow, in size, before the reef reaches
   * its full predator pressure and population -- `grown` in spawnEnemy and
   * enemyTarget both ramp from 0 to 1 across this many size points above
   * START_SIZE.
   *
   * Used to sit at 250, which meant the reef finished escalating by the time
   * a player was barely a third of the way to MAX_SIZE -- sharks showed up
   * "quickly" relative to a whole run, and everything past that point felt
   * flat rather than still climbing. Stretched out to match the much longer
   * runs GROWTH's slower curve now produces, so the big predators are a late-
   * game event, not a mid-game one.
   */
  PREDATOR_RAMP_SIZE: 180,
  /** Spawn ring, as a multiple of the view's half-diagonal , just out of sight. */
  SPAWN_RING: 1.15,
  /** Beyond this (same units) a fish nobody can see is recycled. */
  CULL_RING: 2.1,
  /**
   * AI fish ignore players entirely , they neither hunt you nor flee from you.
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
  /**
   * Share of spawns that arrive as a shoal rather than a lone fish.
   *
   * Raised from 0.3, alongside a bigger SHOAL_MIN/MAX below: shoals are
   * always genuinely small (see SHOAL_MAX_SIZE in fish.ts, and the tiny-prey
   * band in spawnEnemy), so they are the most reliable source of "the water
   * is full of little fish" -- a lone spawnEnemy() prey fish is only small
   * *relative to you*, and stops looking small at all once you've grown.
   */
  SHOAL_CHANCE: 0.45,
  SHOAL_MIN: 7,
  SHOAL_MAX: 13,
  /** Seconds between replacement fish, so a cleared patch stays calm. */
  ENEMY_RESPAWN_DELAY: 1.4,

  // Boss
  BOSS_INTERVAL: 90,
  BOSS_DURATION: 18,
  /** Slow enough to outswim. It is a hazard to steer around, not a death sentence. */
  BOSS_SPEED: 100,
  BOSS_SIZE: 190,

  // Presentation
  BUBBLES: 60,
  VISUAL_SCALE: 0.92,
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
type Scheme = (typeof CONTROL_SCHEMES)[number];

/**
 * A player alone at the keyboard steers with WASD *and* the arrows, at once.
 *
 * The layout setting exists to share one keyboard between two or three
 * people; with one person it only ever took a key set away. Online is always
 * one seat, which is why an online player on the arrows used to get nothing.
 */
const SOLO_SCHEMES: Scheme[] = [CONTROL_SCHEMES[0], CONTROL_SCHEMES[1]];

/** Every movement key there is, to tell steering apart from any other key. */
const MOVE_KEYS = new Set(CONTROL_SCHEMES.flatMap((s) => [s.up, s.down, s.left, s.right]));

/**
 * How the simulation keeps going while the tab is hidden and frames stop: a
 * step every 50ms from a timer background tabs do not throttle (see
 * steadyTimer.ts), taken only once the frame loop has visibly gone quiet.
 */
const BACKGROUND_TICK_MS = 50;
const FRAME_LOOP_QUIET_MS = 120;
/** Mouse steering eases off inside this many units of the pointer, so the fish settles on it. */
const MOUSE_EASE_DISTANCE = 160;

export interface EngineConfig {
  canvas: HTMLCanvasElement;
  /** One id for online play; two or three for couch co-op on one keyboard. */
  localIds: string[];
  localFish: Record<string, number>;
  localNames: Record<string, string>;
  settings: GameSettings;
  friendlyFish?: boolean;
  /** True when this client owns the AI: solo play, or the host of a room. */
  simulateAI: boolean;
  onEat: (score: number, size: number) => void;
  /** `eaterId` is set only when another player did it, so they can be credited. */
  onDeath: (id: string, killedBy: string, eaterId?: string, size?: number) => void;
  onLocalState: (id: string, packet: PlayerPacket) => void;
  onEnemyEaten: (enemyId: number) => void;
  /** Lets the view dismiss its defeat card when movement brings a fish back. */
  onRejoin?: () => void;
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
  /** The mouse pointer, in CSS pixels inside the canvas, while it is over the game. */
  private mouse: Vector2D | null = null;
  /** Mouse steering is live: the mouse has moved since the last movement key. */
  private mouseSteering = false;
  private stopBackground: (() => void) | null = null;

  private running = false;
  private raf = 0;
  private lastTime = 0;


  private bossTimer = 0;
  private bossLife = 0;
  private spawnCursor = 0;
  private nextEnemyId = 1;
  /** Retained for legacy snapshots; ordinary spawning no longer creates shoals. */
  private nextShoalId = 1;
  private enemyRespawnIn = 0;
  /** Enemies eaten since the last time the host published a removal batch. */
  private pendingKills: number[] = [];

  /** Fixed aquarium dimensions, shared by every client. */
  private effViewW = 1200;
  private effViewH = 900;
  private cameraX = BALANCE.WORLD_W / 2;
  private cameraY = BALANCE.WORLD_H / 2;

  private settings: GameSettings;
  private simulateAI: boolean;
  private ambient: { stop: () => void } | null = null;

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
    if (MOVE_KEYS.has(e.code)) this.mouseSteering = false;
    // Arrow keys scroll the page inside the platform's iframe otherwise.
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    this.rejoinFromKey(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onBlur = () => this.keys.clear();

  /**
   * Window-level rather than on the canvas: the touch joystick lies over the
   * whole canvas and would swallow every pointer event aimed at it.
   */
  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const rect = this.config.canvas.getBoundingClientRect();
    this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (this.settings.mouseFollow) this.mouseSteering = true;
  };
  /** The pointer left the game frame: stop chasing the last place it was. */
  private onPointerLeave = () => {
    this.mouse = null;
    this.mouseSteering = false;
  };
  /** A click brings a defeated fish back, for a player steering with the mouse. */
  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && this.settings.mouseFollow) this.rejoinLocal(this.config.localIds[0]);
  };
  /**
   * Hidden means nobody is at the controls. Held keys never see their keyup
   * once the tab is in the background, so they are dropped here, or a fish
   * would swim on into the wall for as long as its player was away.
   */
  private onVisibility = () => {
    if (!document.hidden) return;
    this.keys.clear();
    this.joystick = { x: 0, y: 0 };
    this.mouse = null;
    this.mouseSteering = false;
  };

  constructor(private config: EngineConfig) {
    this.ctx = config.canvas.getContext('2d', { alpha: false })!;
    this.settings = config.settings;
    this.simulateAI = config.simulateAI;
    // Built before resize() and initBubbles() below, both of which read it.
    this.governor = new QualityGovernor(config.settings.lowPower);
    this.tier = this.governor.quality.tier;

    config.localIds.forEach((id, i) => {
      const asset = config.localFish[id] ?? 0;
      const fish = this.makeFish(id, 'player', STARTING_SIZE, asset);
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
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerdown', this.onPointerDown);
    document.documentElement.addEventListener('pointerleave', this.onPointerLeave);
    document.addEventListener('visibilitychange', this.onVisibility);
    audioService.playAmbientRumble().then((r) => {
      this.ambient = r;
    });
    this.running = true;
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    this.stopBackground = steadyInterval(this.backgroundTick, BACKGROUND_TICK_MS);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerdown', this.onPointerDown);
    document.documentElement.removeEventListener('pointerleave', this.onPointerLeave);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopBackground?.();
    this.stopBackground = null;
    this.ambient?.stop();
    this.ambient = null;
  }

  updateSettings(settings: GameSettings) {
    this.settings = settings;
  }

  setJoystick(v: Vector2D) {
    this.joystick = v;
    if (v.x !== 0 || v.y !== 0) this.rejoinLocal(this.config.localIds[0]);
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
    // A remote fish's peak is whatever the packets we've seen from it have
    // shown so far -- there is no local grow() to hook for someone else's
    // fish, and this is the only place their score and size ever arrive.
    if (fish.score > fish.bestScore) fish.bestScore = fish.score;
    if (fish.size > fish.bestSize) fish.bestSize = fish.size;
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
        // nothing , they cannot see it and cannot reach it before the next
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
    if (this.config.friendlyFish) return;
    const fish = this.locals.get(eaterId);
    if (!fish || fish.dead) return;
    this.grow(fish, size);
    this.burst(fish.x, fish.y, 18);
    this.config.onEat(fish.score, fish.size);
  }

  /** True once every local seat has been eaten , the cue to show the defeat screen. */
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
    fish.size = STARTING_SIZE;
    fish.asset = asset;
    fish.score = 0;
    // bestScore/bestSize are deliberately untouched -- that's the whole
    // record a leaderboard is for. See the Fish and leaderboard() comments.
    fish.dead = false;
    fish.vx = 0;
    fish.vy = 0;
    fish.bornAt = performance.now() / 1000;
    // Away from the edges, and away from whatever just ate them.
    fish.x = BALANCE.WORLD_W * (0.25 + Math.random() * 0.5);
    fish.y = BALANCE.WORLD_H * (0.25 + Math.random() * 0.5);
  }

  /** A defeated fish can immediately return by pressing its own movement key. */
  private rejoinFromKey(code: string) {
    const ids = this.config.localIds;
    for (let index = 0; index < ids.length; index++) {
      for (const scheme of this.schemesFor(index)) {
        if (code === scheme.up || code === scheme.down || code === scheme.left || code === scheme.right) {
          this.rejoinLocal(ids[index]);
          return;
        }
      }
    }
  }

  /** The key sets a seat steers with: both main ones alone, its own share on a couch. */
  private schemesFor(index: number): Scheme[] {
    if (this.config.localIds.length === 1) return SOLO_SCHEMES;
    return [CONTROL_SCHEMES[(index + this.settings.controlScheme) % CONTROL_SCHEMES.length]];
  }

  private rejoinLocal(id: string | undefined) {
    if (!id || !this.locals.get(id)?.dead) return;
    this.respawn(id);
    // The reef belongs to the match, not to one life. Clearing it here made a
    // host's whole population teleport whenever that host moved after dying.
    this.config.onRejoin?.();
  }

  /**
   * Starts the reef over at the size the players are *now*.
   *
   * The spawner sizes every fish against `referenceSize()`, the average of
   * everyone alive , so a reef grown around a size-150 player is still full of
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

  /** Any fish , ours or a peer's , for lookups (chat bubbles) that don't care which. */
  fishAt(id: string): Fish | undefined {
    return this.locals.get(id) ?? this.remotes.get(id);
  }

  /**
   * Every seat that has been in the water this match, ranked by the best
   * score they have ever reached in it -- not by their current size, which
   * a respawn quietly wipes back to nothing. `size`/`score` ride along too,
   * for a HUD that also wants to say how someone is doing *right now*, but
   * the ranking itself is the record: it is the whole reason a dead or
   * respawned seat still belongs on this list at all.
   *
   * Includes a dead remote seat rather than dropping it -- a leaderboard
   * that erases someone the instant they're eaten stops being a record of
   * the match and goes back to being a live "who's biggest" readout.
   */
  leaderboard(): { id: string; name: string; size: number; score: number; bestSize: number; bestScore: number; local: boolean }[] {
    const rows: { id: string; name: string; size: number; score: number; bestSize: number; bestScore: number; local: boolean }[] = [];
    for (const [id, f] of this.locals) {
      rows.push({ id, name: f.name ?? 'You', size: f.size, score: f.score, bestSize: f.bestSize, bestScore: f.bestScore, local: true });
    }
    for (const [id, f] of this.remotes) {
      rows.push({ id, name: f.name ?? 'Player', size: f.size, score: f.score, bestSize: f.bestSize, bestScore: f.bestScore, local: false });
    }
    return rows.sort((a, b) => b.bestScore - a.bestScore);
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

    /*
     * Fill the screen instead of letterboxing the 16:9 reef.
     *
     * Mobile browser viewports are often much wider than 16:9 once they are
     * turned sideways. Fitting the whole world left plain blue gutters at
     * both edges and made every fish needlessly small. The camera now shows
     * the largest aspect-correct slice that completely covers the canvas.
     */
    const aspect = Math.max(0.1, rect.width / Math.max(1, rect.height));
    const worldAspect = BALANCE.WORLD_W / BALANCE.WORLD_H;
    if (aspect >= worldAspect) {
      this.effViewW = BALANCE.WORLD_W;
      this.effViewH = BALANCE.WORLD_W / aspect;
    } else {
      this.effViewH = BALANCE.WORLD_H;
      this.effViewW = BALANCE.WORLD_H * aspect;
    }
  }

  /** The camera-sized part of the aquarium currently visible. */

  /**
   * World → viewport pixels, for DOM overlays (chat bubbles) that have to sit
   * over a canvas fish.
   *
   * There is no stored letterbox rect to reuse like the other games' fixed
   * arenas , this camera follows the local player and `draw()` recomputes the
   * scale and offset fresh every frame, so this mirrors that exact chain
   * (letterbox, then the eased camera translate) rather than a snapshot of it,
   * or a bubble over a *remote* fish would drift the moment the local player
   * moved the camera out from under it.
   */
  toClient(x: number, y: number, rect: DOMRect): { x: number; y: number } {
    const cw = this.ctx.canvas.width;
    const ch = this.ctx.canvas.height;
    const scale = Math.min(cw / this.effViewW, ch / this.effViewH);
    const offX = (cw - this.effViewW * scale) / 2;
    const offY = (ch - this.effViewH * scale) / 2;
    // Backing-store px per CSS px, recovered from the canvas itself rather
    // than re-reading devicePixelRatio , the governor's maxDpr cap means the
    // ratio resize() actually used can be lower than the raw device value.
    const dpr = cw / Math.max(1, rect.width);
    return {
      x: rect.left + (offX + scale * (x + this.effViewW / 2 - this.cameraX)) / dpr,
      y: rect.top + (offY + scale * (y + this.effViewH / 2 - this.cameraY)) / dpr,
    };
  }

  /** The inverse of toClient, from CSS pixels inside the canvas, against the camera as it is now. */
  private screenToWorld(px: number, py: number): Vector2D {
    const cw = this.ctx.canvas.width;
    const ch = this.ctx.canvas.height;
    const scale = Math.min(cw / this.effViewW, ch / this.effViewH);
    const offX = (cw - this.effViewW * scale) / 2;
    const offY = (ch - this.effViewH * scale) / 2;
    const dpr = cw / Math.max(1, this.config.canvas.clientWidth);
    return {
      x: (px * dpr - offX) / scale - this.effViewW / 2 + this.cameraX,
      y: (py * dpr - offY) / scale - this.effViewH / 2 + this.cameraY,
    };
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
    // start() , a negative dt runs the whole simulation backwards for a frame.
    const dt = Math.max(0, Math.min(0.05, (time - this.lastTime) / 1000));
    this.lastTime = time;


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

  /**
   * The simulation without the drawing, for while the tab is hidden.
   *
   * The frame loop stops dead in a background tab, and everything that made
   * this a shared ocean stopped with it: the host's reef froze for the whole
   * room, and a guest's fish stopped publishing and stopped checking whether
   * anything had eaten it , so it could still bite a smaller fish that swam
   * in, but nothing could ever bite it back. Stepping here keeps all of that
   * running. It does nothing while frames are arriving on their own.
   */
  private backgroundTick = () => {
    if (!this.running) return;
    const now = performance.now();
    if (now - this.lastTime < FRAME_LOOP_QUIET_MS) return;
    // Capped, so a tab the browser froze outright for minutes does not come
    // back and grind through all of them at once.
    let left = Math.min(0.5, (now - this.lastTime) / 1000);
    this.lastTime = now;
    while (left > 0) {
      const step = Math.min(0.05, left);
      this.update(step);
      left -= step;
    }
  };

  private update(dt: number) {

    this.updateLocals(dt);
    if (this.simulateAI) {
      this.simulateEnemies(dt);
      // The aquarium now stays focused on readable fish traffic. The old
      // hunting boss is intentionally paused rather than interrupting that.
      if (this.boss) this.simulateBoss(dt);
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
      let ix = 0;
      let iy = 0;
      for (const scheme of this.schemesFor(index)) {
        if (this.keys.has(scheme.left)) ix -= 1;
        if (this.keys.has(scheme.right)) ix += 1;
        if (this.keys.has(scheme.up)) iy -= 1;
        if (this.keys.has(scheme.down)) iy += 1;
      }
      // W and ArrowUp held together are one "up", not a double-speed one.
      ix = Math.max(-1, Math.min(1, ix));
      iy = Math.max(-1, Math.min(1, iy));

      // The joystick drives player one; it is analogue, so it wins outright
      // rather than being added to a digital key press.
      if (index === 0 && (this.joystick.x !== 0 || this.joystick.y !== 0)) {
        ix = this.joystick.x;
        iy = this.joystick.y;
      } else if (index === 0 && ix === 0 && iy === 0 && this.mouseSteering && this.mouse && this.settings.mouseFollow) {
        // Toward the pointer, full speed from a distance and easing off as it
        // arrives, so it settles under the cursor instead of orbiting it.
        // Re-projected every frame: the camera follows the fish, so the water
        // under a cursor that has not moved is still moving.
        const target = this.screenToWorld(this.mouse.x, this.mouse.y);
        const dx = target.x - fish.x;
        const dy = target.y - fish.y;
        const dist = Math.hypot(dx, dy);
        const settle = bodyRadius(fish.size) * 0.5;
        if (dist > settle) {
          const push = Math.min(1, (dist - settle) / MOUSE_EASE_DISTANCE);
          ix = (dx / dist) * push;
          iy = (dy / dist) * push;
        }
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
    while (this.enemies.size < target) {
      const fish = this.spawnEnemy();
      // Only the opening fish are placed in the aquarium. Every later fish
      // swims cleanly across it from one side to the other.
      fish.x = Math.random() * BALANCE.WORLD_W;
      fish.y = Math.random() * BALANCE.WORLD_H;
    }
  }

  private enemyTarget() {
    const players = this.locals.size + this.remotes.size;
    const base = BALANCE.ENEMY_BASE + players * BALANCE.ENEMY_PER_PLAYER;
    // The reef fills in as the run goes on, not just with more players --
    // otherwise a solo run sits at the same 32-ish fish from minute one to
    // minute thirty, thinning out rather than building toward anything.
    const bonus = this.grownFor(this.referenceSize()) * BALANCE.ENEMY_GROWTH_BONUS;
    return Math.min(BALANCE.ENEMY_MAX, Math.round(base + bonus));
  }

  /**
   * Average size of everyone alive , used only for the reef's overall
   * population count below, never for how big any individual spawn is (see
   * `spawnEnemy`, which anchors each fish's size to whoever it's actually
   * appearing next to instead).
   */
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

  /**
   * How far into a run the local fleet already is, 0 at a fresh spawn to 1
   * once grown past PREDATOR_RAMP_SIZE -- the single curve both the predator
   * mix (spawnEnemy) and the population size (enemyTarget) ramp against, so
   * the reef fills up and gets dangerous on the same schedule.
   */
  private grownFor(ref: number): number {
    return clamp((ref - BALANCE.START_SIZE) / BALANCE.PREDATOR_RAMP_SIZE, 0, 1);
  }

  private spawnEnemy(): Fish {
    // Just outside somebody's view, on the far side of a random angle. Picked
    // first, not last: everything below sizes this fish against the *anchor
    // it's actually appearing next to*, not the match's global average. That
    // used to be the same `ref` for every spawn anywhere in the world, so the
    // instant one player pulled ahead in size, the whole reef re-centred on
    // them -- a player who hadn't grown much found nothing left they could
    // eat, and nothing they could survive either, no matter where they swam.
    // Anchoring locally means a small player's own neighbourhood keeps
    // spawning things sized for them, regardless of how big someone else in
    // the match has gotten.
    const anchor = this.spawnAnchor();
    const ref = anchor.size;
    const roll = Math.random();

    /**
     * Every neighbourhood offers the same clear risk/reward choice: four fish
     * in ten are food for the player this spawn is anchored to, while six in
     * ten are larger hazards. This ratio is independent for every spawn, so it
     * also stays fair when multiplayer seats have very different sizes.
     */
    const grown = this.grownFor(ref);
    const edible = roll < 0.4;
    const largePredator = !edible && Math.random() < 0.18 * grown;

    let size: number;
    if (edible) {
      // A quarter of food shares the player's displayed number. NPC ties are
      // deliberately edible, so matching the label is a safe, useful catch.
      const foodRoll = Math.random();
      if (foodRoll < 0.25) {
        size = Math.floor(ref) + Math.random();
      } else if (foodRoll < 0.6) {
        // Keep real minnows in an advanced reef instead of eventually turning
        // every edible spawn into the same giant-species sprite.
        size = 4 + Math.random() * Math.min(36, Math.max(0, ref - 4));
      } else {
        size = ref * (0.35 + Math.random() * 0.55);
      }
    } else if (!largePredator) {
      // Most hazards are close enough to become future food after some growth.
      size = ref * (1.12 + Math.random() * 0.48);
    } else {
      // Truly large predators only enter progressively; they never dominate.
      size = ref * (1.8 + Math.random() * 1.2);
    }
    // A safety ceiling, not a real limit -- big enough that a predator's own
    // ref-relative formula above decides its size long before this ever
    // binds, so there is always something bigger out there no matter how big
    // a player actually gets.
    size = Math.max(4, Math.min(600, size));

    const id = this.nextEnemyId++;
    const sharks = [...this.enemies.values()].filter((f) => f.asset === 29 && !f.dead).length;
    // Art follows the fish's real size. The old random predator list included
    // Swordfish, so an 11-point snack could look like an endgame threat.
    // Swordfish, tiger sharks, and the boss are now naturally reserved for
    // the late size bands in the catalogue.
    const shark = largePredator && sharks < 2 && ref >= 100;
    const asset = shark ? 29 : Math.min(28, assetForSize(size));
    const fish = this.makeFish(String(id), 'enemy', size, asset);
    fish.pace *= 1 + grown * 0.2;

    const fromLeft = Math.random() < 0.5;
    fish.x = fromLeft ? -90 : BALANCE.WORLD_W + 90;
    fish.y = 60 + Math.random() * (BALANCE.WORLD_H - 120);

    const speed = BALANCE.ENEMY_MIN_SPEED + Math.random() * (BALANCE.ENEMY_MAX_SPEED - BALANCE.ENEMY_MIN_SPEED);
    // Aquarium fish never chase, flee, cluster or select routes. They are
    // simple left-to-right swimmers, like the reference game.
    const heading = fromLeft ? 0 : Math.PI;
    fish.vx = Math.cos(heading) * speed;
    fish.vy = 0;
    fish.angle = heading;
    fish.heading = heading;

    this.enemies.set(id, fish);
    return fish;
  }

  private spawnAnchor(): { x: number; y: number; size: number } {
    const alive: Fish[] = [];
    this.locals.forEach((f) => !f.dead && alive.push(f));
    this.remotes.forEach((f) => !f.dead && alive.push(f));
    if (alive.length === 0) return { x: BALANCE.WORLD_W / 2, y: BALANCE.WORLD_H / 2, size: BALANCE.START_SIZE };
    return alive[this.spawnCursor++ % alive.length];
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
   * spawn that way) , a tiger shark drifting in the middle of a school of neon
   * tetras looked absurd, so nothing above `isShoalingSize` ever joins one.
   *
   * Players are not an input to any of this. Nothing chases, nothing flees.
   */
  private simulateEnemies(dt: number) {
    // Aquarium fish move in one clear direction until they leave the screen.
    // There is deliberately no flocking, wandering, hunting, or response to
    // nearby players here.
    for (const fish of this.enemies.values()) {
      fish.x += fish.vx * dt;
      this.face(fish, dt, 5);
    }
    for (const [id, fish] of this.enemies) {
      if (fish.x < -140 || fish.x > BALANCE.WORLD_W + 140) this.enemies.delete(id);
    }
    this.enemyRespawnIn -= dt;
    if (this.enemies.size < this.enemyTarget() && this.enemyRespawnIn <= 0) {
      this.spawnEnemy();
      this.enemyRespawnIn = BALANCE.ENEMY_RESPAWN_DELAY;
    }
    return;

    // Kept behind an unreachable branch while older replays that carry shoal
    // metadata age out. New matches never enter this path.
    if (false) {
    const cull = this.viewRadius() * BALANCE.CULL_RING;
    const cullSq = cull * cull;
    const enemies = [...this.enemies.values()];

    // One pass to find where each shoal is and which way it is going, so the
    // steering pass below is O(n) rather than O(n²).
    const shoals = new Map<number, { x: number; y: number; hx: number; hy: number; n: number }>();
    for (const fish of enemies) {
      if (fish.shoal === undefined) continue;
      const s = shoals.get(fish.shoal!) ?? { x: 0, y: 0, hx: 0, hy: 0, n: 0 };
      s.x += fish.x;
      s.y += fish.y;
      s.hx += Math.cos(fish.heading);
      s.hy += Math.sin(fish.heading);
      s.n++;
      shoals.set(fish.shoal!, s);
    }

    for (const fish of enemies) {
      // Pick somewhere new to be, now and then.
      fish.turnIn -= dt;
      if (fish.turnIn <= 0) {
        fish.turnIn = BALANCE.TURN_EVERY_MIN + Math.random() * (BALANCE.TURN_EVERY_MAX - BALANCE.TURN_EVERY_MIN);
        // A change of course, not a reversal , a fish that spins 180° on the
        // spot reads as a glitch.
        fish.heading += (Math.random() - 0.5) * 1.9;
      }

      let hx = Math.cos(fish.heading);
      let hy = Math.sin(fish.heading) * 0.55; // fish travel flatter than they climb

      const shoal =
        fish.shoal !== undefined && isShoalingSize(fish.size) ? shoals.get(fish.shoal!)! : undefined;
      if (shoal !== undefined && shoal!.n > 1) {
        const group = shoal!;
        const cxAvg = group.x / group.n;
        const cyAvg = group.y / group.n;
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

        const align = Math.hypot(group.hx, group.hy) || 1;
        hx += (group.hx / align) * BALANCE.SCHOOL_ALIGN;
        hy += (group.hy / align) * BALANCE.SCHOOL_ALIGN * 0.55;
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
    // of fish appearing together , except for shoals, which arrive as a group
    // because that is the entire point of them.
    for (let i = 0; i < 3 && this.enemies.size < target; i++) {
      if (Math.random() < BALANCE.SHOAL_CHANCE && this.enemies.size + BALANCE.SHOAL_MAX <= target) {
        this.spawnEnemy();
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
  const spawnShoal = () => {
    // Anchor first, same reasoning as spawnEnemy: sized for whoever the shoal
    // is actually appearing next to, not the match's global average, so a
    // player who hasn't grown much still finds an appropriately tiny cloud of
    // minnows near them instead of one sized for however big someone else
    // in the match has gotten.
    const anchor = this.spawnAnchor();
    const ref = anchor.size;
    // Always food, and always small , the whole appeal is a cloud of minnows.
    const size = Math.max(4, Math.min(SHOAL_MAX_SIZE, ref * (0.32 + Math.random() * 0.5)));
    const asset = assetForSize(size);
    const count = BALANCE.SHOAL_MIN + Math.floor(Math.random() * (BALANCE.SHOAL_MAX - BALANCE.SHOAL_MIN + 1));

    const angle = Math.random() * Math.PI * 2;
    const cx = Math.cos(angle) < 0 ? -120 : BALANCE.WORLD_W + 120;
    const cy = 100 + Math.random() * (BALANCE.WORLD_H - 200);
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
  void spawnShoal;
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
        if (canEat(me, enemy, true)) {
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

      // Other players , local co-op partners and everyone online.
      const others: [string, Fish][] = [];
      this.locals.forEach((f, id) => id !== myId && others.push([id, f]));
      this.remotes.forEach((f, id) => others.push([id, f]));

      for (const [otherId, other] of others) {
        if (other.dead || !overlaps(me, other)) continue;

        // Friendly rooms protect other players; enemies remain dangerous.
        if (this.config.friendlyFish) {
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
    // The eater rides along so the App can hand them the growth , the victim is
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
    if (fish.score > fish.bestScore) fish.bestScore = fish.score;
    if (fish.size > fish.bestSize) fish.bestSize = fish.size;
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
      bestScore: 0,
      bestSize: size,
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
    // arc fill every frame , the first thing worth thinning on a slow device.
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
    // WebP, for the same reason the fish are: the JPEG was 775 KB , more than
    // the entire rest of this bundle's assets put together , for an image that
    // is then stretched over a 3000x2200 world and never seen at native size.
    // The WebP is 125 KB and indistinguishable once scaled.
    //
    // BASE_URL rather than a bare filename so it resolves under any deploy
    // prefix, the same way fishSrc() does.
    bg.src = `${import.meta.env.BASE_URL}bg-deep.webp`;
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
    const scale = Math.min(cw / this.effViewW, ch / this.effViewH);
    ctx.translate((cw - this.effViewW * scale) / 2, (ch - this.effViewH * scale) / 2);
    ctx.scale(scale, scale);

    // Follow the local fish through the cropped dimension. This keeps the
    // larger mobile view playable all the way to the reef's boundaries.
    let focusX = 0;
    let focusY = 0;
    let focusCount = 0;
    for (const fish of this.locals.values()) {
      if (fish.dead) continue;
      focusX += fish.x;
      focusY += fish.y;
      focusCount++;
    }
    const wantedX = focusCount ? focusX / focusCount : BALANCE.WORLD_W / 2;
    const wantedY = focusCount ? focusY / focusCount : BALANCE.WORLD_H / 2;
    const minX = this.effViewW / 2;
    const minY = this.effViewH / 2;
    const targetX = this.effViewW >= BALANCE.WORLD_W
      ? BALANCE.WORLD_W / 2
      : clamp(wantedX, minX, BALANCE.WORLD_W - minX);
    const targetY = this.effViewH >= BALANCE.WORLD_H
      ? BALANCE.WORLD_H / 2
      : clamp(wantedY, minY, BALANCE.WORLD_H - minY);
    this.cameraX += (targetX - this.cameraX) * 0.12;
    this.cameraY += (targetY - this.cameraY) * 0.12;

    ctx.translate(this.effViewW / 2 - this.cameraX, this.effViewH / 2 - this.cameraY);

    if (this.backdrop) {
      // Keep the fish crisp while easing the stock scenery back a little.
      ctx.save();
      ctx.filter = 'blur(2px) saturate(0.88)';
      ctx.drawImage(this.backdrop, -5, -5, BALANCE.WORLD_W + 10, BALANCE.WORLD_H + 10);
      ctx.restore();
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
    // population doesn't visibly pop in and out , but that means most of them
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
     * every heading , a fish swimming left is the same fish facing the other
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
    // only, and stroked text is the most expensive call in this whole loop ,
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
    // The aura is a warning, so it stays at every tier , but the cheap tier
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
 * rather than screen-filling. Everything the player can see , the sprite, the
 * hitbox, the name label, the spawn ring , has to be derived from this one
 * function or they drift apart as fish grow. They used to: collision scaled
 * linearly with `size` while the art scaled with `size^0.75`, so by size 150
 * the hitbox was about twice the width of the fish and you were eaten by open
 * water.
 */
export function bodyRadius(size: number): number {
  return 7 + 95 * (1 - Math.exp(-Math.pow(size, 0.75) * BALANCE.VISUAL_SCALE / 95));
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
 * 150 a fish showing "141" was , the bigger you got, the more the game
 * disagreed with its own HUD.
 *
 * Equal NPCs can be eaten because the local player's collision owns that
 * decision. Equal human players remain a tie so two clients cannot both report
 * that they ate each other.
 */
function canEat(predator: Fish, prey: Fish, allowDisplayedTie = false): boolean {
  const predatorLabel = Math.floor(predator.size);
  const preyLabel = Math.floor(prey.size);
  return allowDisplayedTie ? predatorLabel >= preyLabel : predatorLabel > preyLabel;
}

/** Keeps the camera inside the world, or centres it when the view is bigger. */

/**
 * Fish are longer than they are tall, so a circle is a poor hitbox: it lets a
 * fish be eaten by something level with its tail. This is an ellipse sized off
 * `bodyRadius`, the same curve the sprite is drawn from, and deliberately a
 * little tighter than the art , the sprites carry transparent padding, and a
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
