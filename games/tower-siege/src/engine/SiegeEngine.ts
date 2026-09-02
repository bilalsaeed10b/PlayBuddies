/**
 * One keep, simulated.
 *
 * Deliberately one keep and not the whole match: a four-player siege is four
 * of these running side by side on every device, which is what makes
 * spectating cost nothing at all (R4) — the keep you are watching is already
 * being simulated, it just was not the one being drawn.
 *
 * Nothing in here knows about React, Firestore or a canvas. It takes a wave
 * list and a stream of build orders and it produces enemies, shots and a
 * count of lives. The rendering reads its arrays; the wire feeds it orders.
 */
import {
  BALANCE,
  ENEMIES,
  TOWERS,
  clamp,
  investedIn,
  mulberry32,
} from '../game/rules';
import type { EnemyId, TowerId, Wave } from '../game/rules';
import {
  AIR_LENGTH,
  COLS,
  PATH_LENGTH,
  airPointAt,
  centreOf,
  headingAt,
  isBuildable,
  pointAt,
} from '../game/map';
import type { Vec } from '../game/map';
import { AIR_FROM, AIR_TO } from '../game/map';

/** Flyers all cross on the same straight line, so this is a constant. */
const AIR_HEADING = Math.atan2(AIR_TO.y - AIR_FROM.y, AIR_TO.x - AIR_FROM.x);
import type { Control, Phase } from '../types/game';

export interface Enemy {
  id: number;
  kind: EnemyId;
  hp: number;
  maxHp: number;
  /** Distance walked from the breach. Flyers measure along their own line. */
  at: number;
  x: number;
  y: number;
  /** Radians. Which way the sprite points. */
  face: number;
  /** Seconds of chill left, and how hard. 1 is unslowed. */
  chill: number;
  chillMul: number;
  /** Decays. Drives the white flash on a hit. */
  flash: number;
  /** Set the frame it dies, so the view can burst it before it is dropped. */
  dead: boolean;
  /** Cosmetic wobble, fixed per enemy so a rank of them does not march in step. */
  phase: number;
}

export interface Tower {
  /** Plot index: row * COLS + col. Unique, and what the wire names. */
  plot: number;
  kind: TowerId;
  level: number;
  x: number;
  y: number;
  /** Radians. Eased toward whatever it is shooting. */
  face: number;
  cool: number;
  /** Decays. Drives the muzzle flash and the recoil. */
  fired: number;
  /** Kills, shown when the tower is selected. Nothing reads it but the panel. */
  kills: number;
}

export interface Shot {
  x: number;
  y: number;
  /** Where it is heading. Recomputed while the target lives, then held. */
  tx: number;
  ty: number;
  target: number;
  /**
   * The plot that fired it.
   *
   * Carried rather than looked up on landing: `towers.find(kind === ...)`
   * returns the *first* tower of that kind on the map, so on a board with
   * four arrow nests every kill was credited to whichever one happened to be
   * built first.
   */
  from: number;
  kind: TowerId;
  level: number;
  speed: number;
  alive: boolean;
  age: number;
  /** Only set on an arc coil's bolt: the chain it drew, for one frame of paint. */
  arc: Vec[] | null;
}

export interface Burst {
  x: number;
  y: number;
  r: number;
  max: number;
  life: number;
  kind: 'hit' | 'splash' | 'frost' | 'death' | 'leak';
  color: string;
}

export interface EngineConfig {
  /** Who holds this keep. */
  control: Control;
  name: string;
  /** Index into SEATS. Also this keep's slot in the match. */
  seat: number;
  /** Every wave, already built from the match seed. Identical on every client. */
  waves: Wave[];
  /** Salts this keep's own cosmetic rolls. Nothing that decides the fight. */
  seed: number;
  lives: number;
  gold: number;
  onSfx?: (kind: 'build' | 'sell' | 'shoot' | 'boom' | 'leak' | 'clear' | 'fall') => void;
  /** Fired when this keep's own wave ends, so the owner can publish a summary. */
  onWaveEnd?: (wave: number, lives: number, gold: number, down: boolean) => void;
}

/** A tower order, from a thumb or from the wire. Applied identically either way. */
export interface BuildOrder {
  plot: number;
  kind: TowerId | null;
  level: number;
}

export class SiegeEngine {
  readonly seat: number;
  name: string;
  control: Control;

  phase: Phase = 'build';
  /** Index into `waves`. Also what the HUD calls "wave N+1". */
  wave = 0;
  lives: number;
  gold: number;

  /**
   * Seconds left of the build phase, or elapsed into the wave.
   *
   * Annotated, because BALANCE is `as const` and the inferred type would
   * otherwise be the literal 18 rather than a number.
   */
  timer: number = BALANCE.BUILD_TIME;

  towers: Tower[] = [];
  enemies: Enemy[] = [];
  shots: Shot[] = [];
  bursts: Burst[] = [];

  /** Enemies pushed in by an opponent, keyed by the wave they land on. */
  private incoming = new Map<number, { kind: EnemyId; count: number }[]>();

  /** Kills and leaks this wave, so the clear bonus knows whether it was clean. */
  leakedThisWave = 0;
  killedThisWave = 0;
  /** Totals for the scoreboard. */
  totalKills = 0;
  totalLeaks = 0;

  private cfg: EngineConfig;
  private spawnCursor = 0;
  private nextId = 1;
  private clock = 0;
  private rng: () => number;
  /** Extra spawns folded in from sends, resolved when the wave starts. */
  private extra: { kind: EnemyId; at: number; hpScale: number }[] = [];

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
    this.seat = cfg.seat;
    this.name = cfg.name;
    this.control = cfg.control;
    this.lives = cfg.lives;
    this.gold = cfg.gold;
    this.rng = mulberry32(cfg.seed ^ 0x7e11);
  }

  get waveCount(): number {
    return this.cfg.waves.length;
  }

  /** The wave about to be fought, or the one being fought. */
  get current(): Wave | undefined {
    return this.cfg.waves[this.wave];
  }

  get alive(): boolean {
    return this.phase !== 'fallen';
  }

  towerAt(plot: number): Tower | undefined {
    return this.towers.find((t) => t.plot === plot);
  }

  // ── orders ───────────────────────────────────────────────────────────────

  /**
   * What building here would cost, or -1 if it cannot be done.
   *
   * Asked by the view before it offers the button and by `apply` before it
   * acts, so a plot that is refused is refused for the same reason on every
   * device rather than only on the one that happened to check.
   */
  costOf(plot: number, kind: TowerId): number {
    const existing = this.towerAt(plot);
    if (existing) {
      if (existing.kind !== kind) return -1;
      if (existing.level >= 2) return -1;
      return TOWERS[kind].levels[existing.level + 1].cost;
    }
    const col = plot % COLS;
    const row = Math.floor(plot / COLS);
    if (!isBuildable(col, row)) return -1;
    return TOWERS[kind].levels[0].cost;
  }

  /** Refund for selling whatever stands on this plot. */
  refundOf(plot: number): number {
    const t = this.towerAt(plot);
    if (!t) return 0;
    return Math.floor(investedIn(t.kind, t.level) * BALANCE.SELL_BACK);
  }

  /**
   * One order, start to finish. The single entry point for a thumb, a bot or
   * the wire, so nothing downstream has to know which it was.
   *
   * Returns the order actually carried out, or null if it was refused —
   * the caller broadcasts what came back rather than what it asked for, which
   * is what stops a refused order from being replayed as a real one on a peer
   * whose gold happened to allow it.
   */
  apply(order: BuildOrder, charge = true): BuildOrder | null {
    if (this.phase === 'fallen' || this.phase === 'won') return null;

    if (order.kind === null) {
      const t = this.towerAt(order.plot);
      if (!t) return null;
      if (charge) this.gold += this.refundOf(order.plot);
      this.towers = this.towers.filter((x) => x.plot !== order.plot);
      this.cfg.onSfx?.('sell');
      return { plot: order.plot, kind: null, level: 0 };
    }

    const existing = this.towerAt(order.plot);
    const cost = this.costOf(order.plot, order.kind);
    if (cost < 0) return null;
    if (charge && this.gold < cost) return null;
    if (charge) this.gold -= cost;

    if (existing) {
      existing.level += 1;
      this.cfg.onSfx?.('build');
      return { plot: order.plot, kind: existing.kind, level: existing.level };
    }

    const col = order.plot % COLS;
    const row = Math.floor(order.plot / COLS);
    const at = centreOf(col, row);
    this.towers.push({
      plot: order.plot,
      kind: order.kind,
      level: 0,
      x: at.x,
      y: at.y,
      // Pointing up the map to start, so a fresh tower does not snap from a
      // default of zero the first time it acquires something.
      face: -Math.PI / 2,
      cool: 0,
      fired: 0,
      kills: 0,
    });
    this.cfg.onSfx?.('build');
    return { plot: order.plot, kind: order.kind, level: 0 };
  }

  /**
   * Force a keep's state to what its owner says it is.
   *
   * Every client simulates every keep and two simulations of one wave can part
   * company by a hair. This is the correction, applied at a wave boundary
   * where nothing is in the air to look wrong. See REQUIREMENTS.md 7.1.
   */
  reconcile(wave: number, lives: number, gold: number, down: boolean) {
    this.lives = lives;
    this.gold = gold;
    if (down && this.phase !== 'fallen') this.fall();
    // A peer that has moved on to a later wave than this copy of their keep
    // has: catch up rather than replay, since the enemies of the wave they
    // are already past are not coming back.
    if (wave + 1 > this.wave && this.phase !== 'fallen') {
      this.wave = wave + 1;
      this.beginBuild();
    }
  }

  /** Fold an opponent's purchase into the wave it was bought against. */
  pushIncoming(wave: number, kind: EnemyId, count: number) {
    const list = this.incoming.get(wave) ?? [];
    list.push({ kind, count });
    this.incoming.set(wave, list);
  }

  /** Skip the rest of the build phase. Only the keep's own holder may. */
  startWaveNow() {
    if (this.phase !== 'build') return;
    this.beginWave();
  }

  // ── the loop ─────────────────────────────────────────────────────────────

  update(dt: number) {
    if (this.phase === 'fallen' || this.phase === 'won') {
      this.stepBursts(dt);
      return;
    }
    this.clock += dt;

    if (this.phase === 'build') {
      this.timer -= dt;
      if (this.timer <= 0) this.beginWave();
      this.stepBursts(dt);
      return;
    }

    this.timer += dt;
    this.spawn();
    this.stepEnemies(dt);
    // The last leak may have taken the keep. Stop here if it did: `fall`
    // empties the enemy list, and the wave-end check below reads an empty list
    // as "wave cleared" -- which handed a keep with nothing left to lose a
    // fresh build phase and let it play on, invulnerable, for the rest of the
    // match. Every run that appeared to survive all thirty waves was one of
    // these.
    if (this.phase !== 'wave') return;
    this.stepTowers(dt);
    this.stepShots(dt);
    this.stepBursts(dt);

    // The wave is over when everything that was going to arrive has, and
    // nothing of it is left standing.
    if (this.spawnCursor >= this.waveSpawns.length && this.enemies.length === 0) {
      this.endWave();
    }
  }

  /** This wave's spawn list, its own plus anything sent at it. */
  private waveSpawns: { kind: EnemyId; at: number; hpScale: number }[] = [];

  private beginBuild() {
    this.phase = 'build';
    this.timer = BALANCE.BUILD_TIME;
  }

  private beginWave() {
    const wave = this.current;
    if (!wave) {
      this.phase = 'won';
      return;
    }
    this.phase = 'wave';
    this.timer = 0;
    this.spawnCursor = 0;
    this.leakedThisWave = 0;
    this.killedThisWave = 0;

    // Sends land here, folded into the list before a single enemy has walked,
    // so every client resolves the same wave whatever order the packets came
    // in. Spread through the wave rather than dumped at the front: a wall of
    // four runners at t=0 is a different problem from four runners arriving
    // among the grunts, and the second one is the interesting one.
    this.extra = [];
    for (const push of this.incoming.get(this.wave) ?? []) {
      const meta = ENEMIES[push.kind];
      for (let i = 0; i < push.count; i++) {
        this.extra.push({
          kind: push.kind,
          at: 1.5 + i * (meta.speed > 100 ? 0.5 : 0.8),
          hpScale: wave.spawns[0]?.hpScale ?? 1,
        });
      }
    }
    this.incoming.delete(this.wave);

    this.waveSpawns = [...wave.spawns, ...this.extra].sort((a, b) => a.at - b.at);
  }

  private endWave() {
    const clean = this.leakedThisWave === 0;
    const bonus = (clean ? BALANCE.CLEAN_BONUS : 0) + BALANCE.CLEAR_PER_WAVE * (this.wave + 1);
    this.gold += bonus;
    this.cfg.onSfx?.('clear');
    this.cfg.onWaveEnd?.(this.wave, this.lives, this.gold, false);

    this.wave += 1;
    if (this.wave >= this.cfg.waves.length) {
      this.phase = 'won';
      return;
    }
    this.beginBuild();
  }

  private fall() {
    this.phase = 'fallen';
    this.enemies = [];
    this.shots = [];
    this.cfg.onSfx?.('fall');
    this.cfg.onWaveEnd?.(this.wave, 0, this.gold, true);
  }

  private spawn() {
    while (this.spawnCursor < this.waveSpawns.length) {
      const next = this.waveSpawns[this.spawnCursor];
      if (next.at > this.timer) break;
      this.spawnCursor++;
      const meta = ENEMIES[next.kind];
      const hp = Math.round(meta.hp * next.hpScale);
      this.enemies.push({
        id: this.nextId++,
        kind: next.kind,
        hp,
        maxHp: hp,
        at: 0,
        x: 0,
        y: 0,
        face: 0,
        chill: 0,
        chillMul: 1,
        flash: 0,
        dead: false,
        phase: this.rng() * Math.PI * 2,
      });
    }
  }

  private stepEnemies(dt: number) {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      // `leak` below can take the last life, and `fall` empties this array
      // outright. Walking backwards survives a splice but not the array being
      // replaced underneath it, so the loop has to notice the keep is gone.
      if (this.phase === 'fallen') return;
      const e = this.enemies[i];
      if (!e) continue;
      const meta = ENEMIES[e.kind];

      if (e.chill > 0) {
        e.chill -= dt;
        if (e.chill <= 0) e.chillMul = 1;
      }
      e.flash = Math.max(0, e.flash - dt * 4);
      e.at += meta.speed * e.chillMul * dt;

      if (meta.flying) {
        const p = airPointAt(e.at);
        e.x = p.x;
        e.y = p.y;
        e.face = AIR_HEADING;
        if (e.at >= AIR_LENGTH) {
          this.leak(e, i);
          continue;
        }
      } else {
        const p = pointAt(e.at);
        e.x = p.x;
        e.y = p.y;
        e.face = headingAt(e.at);
        if (e.at >= PATH_LENGTH) {
          this.leak(e, i);
          continue;
        }
      }
    }
  }

  /** One enemy reaching the keep. */
  private leak(e: Enemy, index: number) {
    this.enemies.splice(index, 1);
    const cost = e.kind === 'boss' ? BALANCE.BOSS_LEAK_COST : BALANCE.LEAK_COST;
    this.lives = Math.max(0, this.lives - cost);
    this.leakedThisWave += cost;
    this.totalLeaks += 1;
    this.burst(e.x, e.y, 42, 'leak', '#f43f5e');
    this.cfg.onSfx?.('leak');
    if (this.lives <= 0) this.fall();
  }

  private stepTowers(dt: number) {
    for (const t of this.towers) {
      const meta = TOWERS[t.kind];
      const lv = meta.levels[t.level];
      t.cool = Math.max(0, t.cool - dt);
      t.fired = Math.max(0, t.fired - dt * 5);

      const target = this.pick(t, meta.air, lv.range);
      if (!target) continue;

      // Turn toward it whether or not it can shoot yet, so a tower visibly
      // tracks what it is about to fire at rather than snapping on the shot.
      const want = Math.atan2(target.y - t.y, target.x - t.x);
      let delta = want - t.face;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      t.face += delta * Math.min(1, dt * 11);

      if (t.cool > 0) continue;
      t.cool = lv.cooldown;
      t.fired = 1;
      this.fire(t, meta.id, target);
    }
  }

  /**
   * What a tower shoots at: whatever is furthest along the path and in reach.
   *
   * Furthest along, not nearest — the enemy about to reach the keep is the one
   * that costs a life, and a tower that helpfully shot the healthy thing behind
   * it would be doing the wrong job well.
   */
  private pick(t: Tower, air: boolean, range: number): Enemy | null {
    let best: Enemy | null = null;
    let bestAt = -1;
    const r2 = range * range;
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (ENEMIES[e.kind].flying && !air) continue;
      const dx = e.x - t.x;
      const dy = e.y - t.y;
      if (dx * dx + dy * dy > r2) continue;
      // Flyers and walkers measure their progress on different lines, so
      // compare how far through their own journey each is rather than raw
      // distance -- otherwise a flyer halfway home always loses to a walker
      // that has barely started down a much longer path.
      const progress = ENEMIES[e.kind].flying ? e.at / AIR_LENGTH : e.at / PATH_LENGTH;
      if (progress > bestAt) {
        bestAt = progress;
        best = e;
      }
    }
    return best;
  }

  private fire(t: Tower, kind: TowerId, target: Enemy) {
    const meta = TOWERS[kind];
    this.cfg.onSfx?.('shoot');

    if (meta.chain > 0) {
      // The coil does not throw anything: it arcs, and the whole chain
      // resolves on the frame it is drawn.
      const chainPts: Vec[] = [{ x: t.x, y: t.y }];
      let from = target;
      const hit = new Set<number>();
      for (let j = 0; j <= meta.chain; j++) {
        if (!from || hit.has(from.id)) break;
        hit.add(from.id);
        chainPts.push({ x: from.x, y: from.y });
        this.hurt(from, meta.levels[t.level].damage, t);
        from = this.nearestUnhit(from, meta.chainRange, hit) as Enemy;
      }
      this.shots.push({
        x: t.x, y: t.y, tx: target.x, ty: target.y, target: target.id, from: t.plot,
        kind, level: t.level, speed: Infinity, alive: true, age: 0, arc: chainPts,
      });
      return;
    }

    this.shots.push({
      x: t.x, y: t.y, tx: target.x, ty: target.y, target: target.id, from: t.plot,
      kind, level: t.level, speed: meta.shotSpeed, alive: true, age: 0, arc: null,
    });
  }

  private nearestUnhit(from: Enemy, range: number, hit: Set<number>): Enemy | null {
    let best: Enemy | null = null;
    let bd = range * range;
    for (const e of this.enemies) {
      if (e.dead || hit.has(e.id)) continue;
      const dx = e.x - from.x;
      const dy = e.y - from.y;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private stepShots(dt: number) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.age += dt;

      if (s.speed === Infinity) {
        // A drawn arc, not a travelling thing. It lives for a few frames of
        // paint and its damage was already dealt when it was created.
        if (s.age > 0.12) this.shots.splice(i, 1);
        continue;
      }

      // Track the target while it lives, so a shot leads a runner instead of
      // sailing through where it used to be. Once it is gone the shot keeps
      // its last aim and lands on empty ground, which is the honest outcome.
      const target = this.enemies.find((e) => e.id === s.target && !e.dead);
      if (target) {
        s.tx = target.x;
        s.ty = target.y;
      }

      const dx = s.tx - s.x;
      const dy = s.ty - s.y;
      const dist = Math.hypot(dx, dy);
      const move = s.speed * dt;

      if (dist <= move || dist < 4) {
        s.x = s.tx;
        s.y = s.ty;
        this.land(s, target ?? null);
        this.shots.splice(i, 1);
        continue;
      }
      s.x += (dx / dist) * move;
      s.y += (dy / dist) * move;

      // Nothing flies forever: a shot chasing something that outran it is a
      // miss rather than a permanent passenger.
      if (s.age > 3) this.shots.splice(i, 1);
    }
  }

  private land(s: Shot, target: Enemy | null) {
    const meta = TOWERS[s.kind];
    const lv = meta.levels[s.level];
    const shooter = this.towerAt(s.from);

    if (meta.splash > 0) {
      this.burst(s.x, s.y, meta.splash, meta.slowFor > 0 ? 'frost' : 'splash', meta.trim);
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (ENEMIES[e.kind].flying && !meta.air) continue;
        const d = Math.hypot(e.x - s.x, e.y - s.y);
        if (d > meta.splash) continue;
        // Falls off toward the rim, so the centre of a shell is worth aiming
        // for rather than anywhere inside the ring being the same hit.
        const falloff = 1 - (d / meta.splash) * 0.55;
        this.hurt(e, lv.damage * falloff, shooter);
        if (meta.slowFor > 0) {
          e.chill = meta.slowFor;
          e.chillMul = meta.slow;
        }
      }
      this.cfg.onSfx?.('boom');
      return;
    }

    if (!target) return;
    this.hurt(target, lv.damage, shooter);
    this.burst(s.x, s.y, 14, 'hit', meta.trim);
    if (meta.slowFor > 0) {
      target.chill = meta.slowFor;
      target.chillMul = meta.slow;
    }
  }

  /**
   * One hit landing.
   *
   * Armour comes off the top, flat, and never takes a hit below
   * ARMOUR_FLOOR — a tower that could be reduced to literally zero would make
   * an armoured wave unkillable rather than merely a poor matchup, which is a
   * stalemate and not a decision.
   */
  private hurt(e: Enemy, amount: number, by?: Tower) {
    if (e.dead) return;
    const armour = ENEMIES[e.kind].armour;
    const dealt = Math.max(BALANCE.ARMOUR_FLOOR, amount - armour);
    e.hp -= dealt;
    e.flash = Math.min(1, e.flash + dealt / 40);
    if (e.hp > 0) return;

    e.dead = true;
    if (by) by.kills += 1;
    this.gold += ENEMIES[e.kind].bounty;
    this.killedThisWave += 1;
    this.totalKills += 1;
    this.burst(e.x, e.y, ENEMIES[e.kind].size * 2.4, 'death', ENEMIES[e.kind].trim);
    const at = this.enemies.indexOf(e);
    if (at >= 0) this.enemies.splice(at, 1);
  }

  private burst(x: number, y: number, r: number, kind: Burst['kind'], color: string) {
    // Capped rather than unbounded: a boss wave dying all at once can ask for
    // a hundred of these in a frame, and past a couple of dozen they are
    // drawing on top of each other anyway.
    if (this.bursts.length > 46) this.bursts.shift();
    this.bursts.push({ x, y, r: r * 0.35, max: r, life: 1, kind, color });
  }

  private stepBursts(dt: number) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life -= dt * 3.4;
      b.r += (b.max - b.r) * Math.min(1, dt * 9);
      if (b.life <= 0) this.bursts.splice(i, 1);
    }
  }

  /** How far through the current wave, 0 to 1. Drives the HUD's wave bar. */
  get waveProgress(): number {
    if (this.phase !== 'wave') return 0;
    const total = this.waveSpawns.length;
    if (total === 0) return 1;
    const done = this.spawnCursor - this.enemies.length;
    return clamp(done / total, 0, 1);
  }
}
