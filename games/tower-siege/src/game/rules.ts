/**
 * Every number the siege is made of, in one file.
 *
 * The engine reads these and nothing else, so a balance change is a one-line
 * edit here rather than a hunt through the simulation. Where REQUIREMENTS.md
 * quotes a figure, it is this figure.
 */

/** Tile size in world units. The whole map is laid out in multiples of it. */
export const TILE = 64;

export const BALANCE = {
  /** Simulation step. Fixed, so a slow frame is caught up rather than skipped. */
  STEP: 1 / 60,
  /** Lives a keep starts with in Siege. Co-op pools these across the party. */
  LIVES: 20,
  /** Gold in hand at the first build phase. Two arrows and change. */
  START_GOLD: 260,
  /** Seconds of build time before wave one, and between every wave after it. */
  BUILD_TIME: 18,
  /** Clearing a wave without a single leak pays this on top of the kills. */
  CLEAN_BONUS: 40,
  /** Per wave, on top of CLEAN_BONUS, so late waves fund late towers. */
  CLEAR_PER_WAVE: 12,
  /** Refund on selling, as a share of everything sunk into the tower. */
  SELL_BACK: 0.7,
  /**
   * How much of a hit armour eats, flat, before it lands.
   *
   * Flat and not a percentage on purpose: it makes a fast weak tower genuinely
   * poor against a brute instead of merely slower, which is the whole reason
   * the brute is in the game.
   */
  ARMOUR_FLOOR: 1,
  /** A leak costs this many lives. A boss reaching the keep costs more. */
  LEAK_COST: 1,
  BOSS_LEAK_COST: 5,
} as const;

// ── towers ─────────────────────────────────────────────────────────────────

export type TowerId = 'arrow' | 'cannon' | 'frost' | 'tesla' | 'ballista';

export interface TowerLevel {
  /** Damage per shot, before the target's armour is subtracted. */
  damage: number;
  /** World units. Measured from the tower's centre to the enemy's. */
  range: number;
  /** Seconds between shots. */
  cooldown: number;
  /** What it costs to reach this level from the one below. Level 0 is the build cost. */
  cost: number;
}

export interface TowerMeta {
  id: TowerId;
  name: string;
  blurb: string;
  /** What it is for, in four words, under the name in the build bar. */
  role: string;
  /** Whether it can shoot something that is not walking the path. */
  air: boolean;
  /** Splash radius in world units. 0 for a single-target tower. */
  splash: number;
  /** Multiplier on a target's speed while it is hit, and for how long. */
  slow: number;
  slowFor: number;
  /** Extra enemies a bolt jumps to, and how far it will jump. */
  chain: number;
  chainRange: number;
  /** World units per second. Infinity is a hitscan beam. */
  shotSpeed: number;
  levels: [TowerLevel, TowerLevel, TowerLevel];
  /** Body and trim, used by the sprite baker and by the build bar alike. */
  hue: string;
  trim: string;
}

/**
 * Five towers, each answering a different problem.
 *
 * Deliberately not five points on one line: the arrow tower has the best
 * damage per gold in the game and cannot touch a brute's armour, the ballista
 * has the worst and does not care about armour at all. A player who works out
 * which of those the wave in front of them is should beat one who buys the
 * biggest number.
 */
export const TOWERS: Record<TowerId, TowerMeta> = {
  arrow: {
    id: 'arrow',
    name: 'Arrow Nest',
    role: 'Cheap, fast, everywhere',
    blurb: 'Fires often for very little. Best value in the game against anything thin-skinned, and nearly useless against armour.',
    air: true,
    splash: 0,
    slow: 1,
    slowFor: 0,
    chain: 0,
    chainRange: 0,
    shotSpeed: 720,
    hue: '#a3702f',
    trim: '#f0c079',
    levels: [
      { damage: 9, range: 170, cooldown: 0.55, cost: 80 },
      { damage: 15, range: 190, cooldown: 0.46, cost: 90 },
      { damage: 24, range: 215, cooldown: 0.38, cost: 150 },
    ],
  },
  cannon: {
    id: 'cannon',
    name: 'Bombard',
    role: 'Slow, heavy, splashes',
    blurb: 'A lobbed shell that hurts everything near where it lands. Cannot be raised high enough to reach a flyer.',
    air: false,
    splash: 62,
    slow: 1,
    slowFor: 0,
    chain: 0,
    chainRange: 0,
    shotSpeed: 430,
    hue: '#5b6470',
    trim: '#aebbc9',
    levels: [
      { damage: 26, range: 195, cooldown: 1.55, cost: 150 },
      { damage: 42, range: 215, cooldown: 1.42, cost: 160 },
      { damage: 68, range: 245, cooldown: 1.28, cost: 260 },
    ],
  },
  frost: {
    id: 'frost',
    name: 'Frost Spire',
    role: 'Slows, barely scratches',
    blurb: 'Chills whatever it touches to a crawl. It will not win a wave on its own and it makes every other tower on the map better.',
    air: true,
    splash: 46,
    slow: 0.5,
    slowFor: 1.6,
    chain: 0,
    chainRange: 0,
    shotSpeed: 560,
    hue: '#2e6d86',
    trim: '#a5e8ff',
    levels: [
      { damage: 4, range: 165, cooldown: 1.1, cost: 120 },
      { damage: 7, range: 185, cooldown: 0.95, cost: 110 },
      { damage: 11, range: 210, cooldown: 0.82, cost: 180 },
    ],
  },
  tesla: {
    id: 'tesla',
    name: 'Arc Coil',
    role: 'Short reach, jumps',
    blurb: 'A bolt that leaps between everything standing close together. Short-ranged, so it belongs where the path doubles back on itself.',
    air: true,
    splash: 0,
    slow: 1,
    slowFor: 0,
    chain: 3,
    chainRange: 118,
    shotSpeed: Infinity,
    hue: '#4c3a86',
    trim: '#c4b5fd',
    levels: [
      { damage: 13, range: 138, cooldown: 0.9, cost: 175 },
      { damage: 21, range: 152, cooldown: 0.8, cost: 170 },
      { damage: 33, range: 170, cooldown: 0.68, cost: 280 },
    ],
  },
  ballista: {
    id: 'ballista',
    name: 'Ballista',
    role: 'Long reach, one big hit',
    blurb: 'Reaches most of the map and drives a bolt straight through armour. Reloads slowly enough that a swarm walks past it.',
    air: false,
    splash: 0,
    slow: 1,
    slowFor: 0,
    chain: 0,
    chainRange: 0,
    shotSpeed: 1150,
    hue: '#6b4a2f',
    trim: '#e0b184',
    levels: [
      { damage: 62, range: 320, cooldown: 2.1, cost: 210 },
      { damage: 96, range: 360, cooldown: 1.95, cost: 200 },
      { damage: 152, range: 410, cooldown: 1.75, cost: 320 },
    ],
  },
};

export const TOWER_ORDER: TowerId[] = ['arrow', 'cannon', 'frost', 'tesla', 'ballista'];

/** Everything sunk into a tower at its current level, which is what a sale refunds a share of. */
export function investedIn(id: TowerId, level: number): number {
  const meta = TOWERS[id];
  let total = 0;
  for (let i = 0; i <= level; i++) total += meta.levels[i].cost;
  return total;
}

// ── enemies ────────────────────────────────────────────────────────────────

export type EnemyId = 'runner' | 'grunt' | 'brute' | 'flyer' | 'warden' | 'boss';

export interface EnemyMeta {
  id: EnemyId;
  name: string;
  hp: number;
  /** World units per second along the path. */
  speed: number;
  /** Subtracted from every hit before it lands. See BALANCE.ARMOUR_FLOOR. */
  armour: number;
  /** Crosses the map in a straight line instead of walking the path. */
  flying: boolean;
  /** Gold for the kill. */
  bounty: number;
  /** Drawn radius, and the radius a shot has to reach to connect. */
  size: number;
  body: string;
  trim: string;
}

/**
 * Six enemies, and the health numbers are measured rather than chosen.
 *
 * The first pass was simply too hard: simulated over sixteen seeds the best
 * bot died on wave 8 and the worst on 7, against a bar of "holds out past
 * wave 10". Sweeping the health curve found this one, which gives a clean
 * ladder — a Squire holds to about wave 10, a Captain to 17, a Warlord takes
 * all thirty. The boss took the largest cut by far: at its old health it was
 * not a wave, it was a wall, and halving it did not move the median at all
 * because what was actually killing runs was the wardens arriving at wave 9.
 */
export const ENEMIES: Record<EnemyId, EnemyMeta> = {
  runner: {
    id: 'runner', name: 'Runner', hp: 27, speed: 118, armour: 0, flying: false,
    bounty: 6, size: 12, body: '#d97757', trim: '#ffd4b8',
  },
  grunt: {
    id: 'grunt', name: 'Grunt', hp: 60, speed: 66, armour: 1, flying: false,
    bounty: 9, size: 15, body: '#8a9a5b', trim: '#dbe8b0',
  },
  brute: {
    id: 'brute', name: 'Brute', hp: 238, speed: 40, armour: 8, flying: false,
    bounty: 26, size: 22, body: '#7c4a3a', trim: '#e8a87c',
  },
  flyer: {
    id: 'flyer', name: 'Wing', hp: 48, speed: 92, armour: 0, flying: true,
    bounty: 12, size: 13, body: '#6a5acd', trim: '#c9c2ff',
  },
  warden: {
    id: 'warden', name: 'Warden', hp: 120, speed: 88, armour: 5, flying: false,
    bounty: 30, size: 17, body: '#4a5d7e', trim: '#9fc4f0',
  },
  boss: {
    id: 'boss', name: 'Siege Beast', hp: 940, speed: 34, armour: 14, flying: false,
    bounty: 220, size: 34, body: '#5c2f3f', trim: '#ff9bb5',
  },
};

// ── waves ──────────────────────────────────────────────────────────────────

export interface Spawn {
  kind: EnemyId;
  /** Seconds after the wave starts. */
  at: number;
  /** Multiplier on the base hp, so wave 20's grunt is not wave 2's grunt. */
  hpScale: number;
}

export interface Wave {
  index: number;
  spawns: Spawn[];
  /** Shown before the wave starts, so a player can buy for what is coming. */
  preview: { kind: EnemyId; count: number }[];
  boss: boolean;
}

/**
 * Deterministic PRNG. Same generator the rest of the platform uses.
 *
 * Every client builds the identical wave list from the match seed, which is
 * what lets the whole game exchange a few dozen writes instead of a stream of
 * enemy positions. See REQUIREMENTS.md section 7.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * The wave list for a match, built once from the seed.
 *
 * Composition is a schedule rather than a roll: which kinds are legal at a
 * given wave is fixed, and the seed only decides the order they walk in and
 * the small jitter on their spacing. A wave that could roll all-brutes at
 * wave 3 would decide a match on the draw, which R2 exists to prevent.
 */
export function buildWaves(seed: number, count: number, players: number, coop: boolean): Wave[] {
  const rnd = mulberry32(seed ^ 0x51e6e);
  const waves: Wave[] = [];

  for (let w = 0; w < count; w++) {
    const n = w + 1;
    const boss = n % 5 === 0;
    // Co-op splits one horde across the whole party, so four defenders is
    // harder than one rather than four times easier.
    const partyScale = coop ? 1 + (players - 1) * 0.7 : 1;
    const hpScale = (1 + n * 0.19 + Math.pow(n, 1.8) * 0.006) * partyScale;

    const pool: EnemyId[] = ['grunt'];
    if (n >= 2) pool.push('runner');
    if (n >= 4) pool.push('flyer');
    if (n >= 6) pool.push('brute');
    if (n >= 9) pool.push('warden');

    // How many bodies this wave is worth, before the mix is chosen.
    const budget = Math.round((6 + n * 2.4) * (coop ? 1 + (players - 1) * 0.55 : 1));

    const spawns: Spawn[] = [];
    const tally = new Map<EnemyId, number>();
    let t = 0;

    if (boss) {
      spawns.push({ kind: 'boss', at: 0.5, hpScale: hpScale * 0.85 });
      tally.set('boss', 1);
      t = 2.4;
    }

    // Enemies arrive in short runs of one kind rather than shuffled one by
    // one: five runners together is a problem to solve, five singles spread
    // through the wave is just noise.
    let placed = 0;
    while (placed < budget) {
      const kind = pool[Math.floor(rnd() * pool.length)];
      const run = Math.min(budget - placed, 2 + Math.floor(rnd() * 4));
      const gap = ENEMIES[kind].speed > 100 ? 0.42 : 0.62;
      for (let i = 0; i < run; i++) {
        spawns.push({ kind, at: t, hpScale });
        t += gap;
      }
      tally.set(kind, (tally.get(kind) ?? 0) + run);
      placed += run;
      t += 0.5 + rnd() * 0.9;
    }

    spawns.sort((a, b) => a.at - b.at);
    waves.push({
      index: w,
      spawns,
      preview: [...tally.entries()].map(([kind, c]) => ({ kind, count: c })),
      boss,
    });
  }
  return waves;
}

// ── sending, versus only ───────────────────────────────────────────────────

/**
 * What a player can buy to make everybody else's next wave worse.
 *
 * Priced above what the same enemy pays out in bounty, so sending is a real
 * cost rather than free damage — and it lands on *everyone* else, which keeps
 * a four-player Siege from turning into three players ganging up on one.
 */
export interface SendMeta {
  kind: EnemyId;
  cost: number;
  count: number;
  label: string;
}

export const SENDS: SendMeta[] = [
  { kind: 'runner', cost: 60, count: 4, label: 'Four runners' },
  { kind: 'flyer', cost: 110, count: 3, label: 'Three wings' },
  { kind: 'brute', cost: 190, count: 1, label: 'One brute' },
];

// ── match rules ────────────────────────────────────────────────────────────

export type Mode = 'siege' | 'alliance';
export type PlayerCount = 1 | 2 | 3 | 4;

export interface MatchRules {
  mode: Mode;
  players: PlayerCount;
  /** How many waves before the list runs out and the escalation begins. */
  waves: number;
  /** Sending, Siege only. Off makes it a pure race. */
  sends: boolean;
}

export const WAVE_CHOICES = [10, 20, 30] as const;

export const DEFAULT_RULES: MatchRules = {
  mode: 'siege',
  players: 2,
  waves: 20,
  sends: true,
};

const WAVE_CODES = [10, 20, 30];

/**
 * The rules as one integer.
 *
 * TurnLink stamps a flat `Record<string, number>` onto every packet, so a
 * player who joins after the first wave still learns the match's terms from
 * whatever write happens to be sitting in the document.
 */
export function packRules(r: MatchRules): number {
  return (
    (r.mode === 'alliance' ? 1 : 0) |
    ((r.players - 1) << 1) |
    (Math.max(0, WAVE_CODES.indexOf(r.waves)) << 3) |
    (r.sends ? 32 : 0)
  );
}

export function unpackRules(bits: number | undefined): MatchRules {
  if (typeof bits !== 'number' || !Number.isFinite(bits)) return DEFAULT_RULES;
  return {
    mode: (bits & 1) !== 0 ? 'alliance' : 'siege',
    players: (clamp(((bits >> 1) & 3) + 1, 1, 4) as PlayerCount),
    waves: WAVE_CODES[(bits >> 3) & 3] ?? DEFAULT_RULES.waves,
    sends: (bits & 32) !== 0,
  };
}

/** Seat colours. One per keep, and the spectator frame borrows them. */
export const SEATS = [
  { name: 'Amber', main: '#f59e0b', light: '#fcd34d', dark: '#78350f' },
  { name: 'Violet', main: '#8b5cf6', light: '#c4b5fd', dark: '#4c1d95' },
  { name: 'Teal', main: '#14b8a6', light: '#5eead4', dark: '#134e4a' },
  { name: 'Rose', main: '#f43f5e', light: '#fda4af', dark: '#881337' },
];
