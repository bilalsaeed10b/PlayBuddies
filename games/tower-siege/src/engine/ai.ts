/**
 * The bot that holds an empty keep.
 *
 * R1 says an empty berth has to be a real opponent, not a free win, and the
 * bar in REQUIREMENTS.md section 9 is holding out past wave 10. So this is not
 * a random placer: it reads what is walking at it, buys the tower that answers
 * it, and puts it where the path doubles back.
 *
 * It is deliberately *seeded*, not random. Every client simulates every keep,
 * including the bot ones, and two clients rolling different placements for the
 * same bot would be two different keeps wearing one name. Given the seed and
 * the wave number, every device builds the identical tower.
 */
import { ENEMIES, TOWERS, TOWER_ORDER, mulberry32 } from '../game/rules';
import type { TowerId } from '../game/rules';
import { COLS, PATH_LENGTH, ROWS, centreOf, isBuildable, pointAt } from '../game/map';
import type { SiegeEngine } from './SiegeEngine';
import type { BuildOrder } from './SiegeEngine';

export interface Tier {
  label: string;
  /** Share of its gold it will commit in one build phase. */
  spend: number;
  /** How far down its own shortlist of plots it is willing to look. 0 takes the best. */
  slack: number;
  /**
   * How strongly it prefers upgrading what it has to buying another tower.
   *
   * The axis that actually separates good play from bad here, which took
   * measuring to find. Damage per gold is near enough flat across a tower's
   * three levels, so "more towers" and "better towers" look equivalent on
   * paper — and they are not, for two reasons the numbers only show once a
   * whole match is simulated. Upgrades concentrate damage on the plots that
   * see the most road, while each new tower goes on a worse plot than the
   * last; and armour is subtracted flat, so a level-1 arrow nest does 1
   * damage to a brute where a level-3 does 16.
   *
   * The first pass had the tiers differ by how much gold they *spent*, which
   * got the ordering exactly backwards: the tier that spent everything on
   * cheap towers died on wave 9 and the miserly one reached 19.
   */
  upgrade: number;
  /** Whether it looks at what is actually coming before buying. */
  reads: boolean;
}

export const TIERS: Tier[] = [
  { label: 'Squire', spend: 0.85, slack: 0.4, upgrade: 0.12, reads: false },
  { label: 'Captain', spend: 0.9, slack: 0.14, upgrade: 0.5, reads: true },
  { label: 'Warlord', spend: 0.95, slack: 0, upgrade: 0.78, reads: true },
];

/**
 * A middling tower's reach, used to score plots.
 *
 * One number rather than each tower's own: the bot picks the plot before it
 * picks what stands on it, and a ranking that changed with the tower would
 * make the two choices circular.
 */
const NOMINAL_RANGE = 185;

/**
 * The path, as evenly spaced sample points.
 *
 * Coverage is measured against these rather than analytically, because "how
 * much of the road does this plot see" has no closed form once the road bends
 * back on itself — and the bending back is the entire point of the map.
 */
const SAMPLE_STEP = 16;
const SAMPLES: { x: number; y: number }[] = (() => {
  const out: { x: number; y: number }[] = [];
  for (let d = 0; d < PATH_LENGTH; d += SAMPLE_STEP) out.push(pointAt(d));
  return out;
})();

/** Which samples each plot can reach, at a nominal range. */
const PLOT_COVER: Map<number, number[]> = (() => {
  const out = new Map<number, number[]>();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!isBuildable(c, r)) continue;
      const at = centreOf(c, r);
      const seen: number[] = [];
      for (let i = 0; i < SAMPLES.length; i++) {
        const p = SAMPLES[i];
        if (Math.hypot(p.x - at.x, p.y - at.y) <= NOMINAL_RANGE) seen.push(i);
      }
      out.set(r * COLS + c, seen);
    }
  }
  return out;
})();

/**
 * How much road a plot sees, ignoring what is already covered.
 *
 * Kept because the upgrade branch wants it: upgrading the tower that sees the
 * most road is right whether or not another tower sees the same stretch.
 */
export const PLOT_VALUE: Map<number, number> = (() => {
  const out = new Map<number, number>();
  for (const [plot, seen] of PLOT_COVER) out.set(plot, seen.length * SAMPLE_STEP);
  return out;
})();

/**
 * The best empty plot given what is already built, by *marginal* coverage.
 *
 * The first pass at this ranked plots once, by raw coverage, and had the bot
 * work down that list. It made the sharpest tier the worst one: the top ten
 * plots by raw coverage all sit around the same two hairpins, so a Warlord
 * stacked its whole fleet on one corner of the map and let everything walk the
 * other three quarters untouched, while a Squire — which picked sloppily and
 * therefore spread out — accidentally covered more road. Measured over twelve
 * seeds the "best" tier died on wave 8 and the worst reached 11.
 *
 * Scoring what a plot adds rather than what it sees fixes that, and it is also
 * simply how a person plays: you do not put your fifth tower where the first
 * four are already shooting.
 */
function bestPlot(engine: SiegeEngine, slack: number, rnd: () => number): number | null {
  const covered = new Set<number>();
  for (const t of engine.towers) {
    for (const i of PLOT_COVER.get(t.plot) ?? []) covered.add(i);
  }

  const scored: { plot: number; gain: number }[] = [];
  for (const [plot, seen] of PLOT_COVER) {
    if (engine.towerAt(plot)) continue;
    let gain = 0;
    for (const i of seen) {
      // Road nobody covers is worth full; road already watched still counts
      // for something, because two towers on one stretch kill twice as fast.
      gain += covered.has(i) ? 0.35 : 1;
    }
    if (gain > 0) scored.push({ plot, gain });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.gain - a.gain);

  // `slack` is how far down its own shortlist a tier is willing to look. A
  // Warlord takes the best plot; a Squire takes something decent nearby.
  const window = Math.max(1, Math.round(scored.length * slack));
  return scored[Math.floor(rnd() * window)].plot;
}

/**
 * What the wave coming at this keep is mostly made of, so the bot can answer
 * it rather than build the same thing every time.
 */
function readWave(engine: SiegeEngine): { air: number; armour: number; swarm: number } {
  const wave = engine.current;
  if (!wave) return { air: 0, armour: 0, swarm: 0 };
  let air = 0;
  let armour = 0;
  let swarm = 0;
  let total = 0;
  for (const p of wave.preview) {
    const meta = ENEMIES[p.kind];
    total += p.count;
    if (meta.flying) air += p.count;
    if (meta.armour >= 5) armour += p.count;
    if (meta.speed >= 100) swarm += p.count;
  }
  if (total === 0) return { air: 0, armour: 0, swarm: 0 };
  return { air: air / total, armour: armour / total, swarm: swarm / total };
}

/**
 * What to buy next, or null when it is done spending.
 *
 * Called repeatedly during a build phase until it returns null, so one call is
 * one tower and the caller decides how much of the phase to spend.
 */
export function decide(engine: SiegeEngine, level: number, nth: number): BuildOrder | null {
  const tier = TIERS[Math.max(0, Math.min(TIERS.length - 1, level))];
  const rnd = mulberry32((engine.seat * 7919 + engine.wave * 104729 + nth * 31) >>> 0);

  const budget = engine.gold * tier.spend;
  if (budget < TOWERS.arrow.levels[0].cost) return null;

  const mix = readWave(engine);
  const owned = engine.towers;
  const haveAir = owned.some((t) => TOWERS[t.kind].air);

  // Upgrade the tower that sees the most road, before adding another one on a
  // worse plot. See Tier.upgrade for why this is the axis that matters.
  if (owned.length >= 3 && rnd() < tier.upgrade) {
    const ups = owned
      .filter((t) => t.level < 2 && engine.costOf(t.plot, t.kind) <= budget)
      .sort((a, b) => (PLOT_VALUE.get(b.plot) ?? 0) - (PLOT_VALUE.get(a.plot) ?? 0));
    if (ups.length > 0) {
      const pick = ups[0];
      return { plot: pick.plot, kind: pick.kind, level: pick.level + 1 };
    }
  }

  // What the wave needs. Order matters: no answer to air at all is a losing
  // position no amount of ground damage fixes, so it is checked first. A
  // Squire does not look — it buys the cheap thing and finds out.
  let want: TowerId;
  if (!tier.reads) {
    want = rnd() < 0.7 ? 'arrow' : 'cannon';
    if (mix.air > 0.15 && !haveAir) want = 'arrow';
  } else if (mix.air > 0.15 && !haveAir) want = 'arrow';
  else if (mix.armour > 0.2) want = 'ballista';
  else if (mix.swarm > 0.4) want = 'cannon';
  else if (owned.length >= 4 && !owned.some((t) => t.kind === 'frost')) want = 'frost';
  else if (owned.length >= 6 && rnd() < 0.35) want = 'tesla';
  else want = rnd() < 0.5 ? 'arrow' : 'cannon';

  // Fall back down the list rather than refusing to build: a bot sitting on
  // gold it will not spend is the same as a bot that is not playing.
  const order = [want, ...TOWER_ORDER.filter((k) => k !== want)];
  for (const kind of order) {
    const cost = TOWERS[kind].levels[0].cost;
    if (cost > budget) continue;

    const plot = bestPlot(engine, tier.slack, rnd);
    if (plot === null) return null;
    return { plot, kind, level: 0 };
  }
  return null;
}

/** Distance the bot's own keep has come, so the HUD can rank it honestly. */
export function progressOf(engine: SiegeEngine): number {
  return engine.wave + engine.waveProgress;
}
