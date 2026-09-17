/**
 * How a match is played, and how it reaches everyone playing it.
 *
 * These used to sit in the settings modal beside the volume sliders, which
 * meant every device kept its own copy. Online that was quietly wrong: the
 * host is the only machine that scores, spawns power-ups and decides a match
 * is over, so a guest with power-ups switched off never animated the ones
 * falling on the host's court, and a guest that took a stalled match over
 * (MatchEngine.promote) finished it to whatever target *it* happened to have.
 *
 * They are the room's rules now: the host sets them on the match setup page
 * and publishes them to the lobby, and everyone builds their engine from the
 * same numbers.
 */
import { TIERS } from '../engine/ai';
import { BALANCE } from './rules';
import type { MatchRules } from '../types/game';

/** The three lengths of match this game offers. */
export const TARGET_POINTS = [5, 7, 11];

/** The power-up frequency slider: a multiplier on the base interval. */
export const POWER_RATE_MIN = 0.25;
export const POWER_RATE_MAX = 3;
export const POWER_RATE_STEP = 0.25;

export const DEFAULT_RULES: MatchRules = {
  targetPoints: 7,
  winByTwo: false,
  powerUps: true,
  powerRate: 1,
  aiLevel: 1,
  doubles: false,
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Whatever was stored, unpacked or typed, as rules this game can actually
 * play.
 *
 * Everything here arrives from somewhere that can be wrong: a save from an
 * older build, a lobby document written by a client this one has never met, a
 * slider read as a string. A target score of 6, or a bot rank of 4, would not
 * be refused anywhere further down , it would simply be a match nobody can
 * win, or `TIERS[4].label` throwing as the roster draws.
 */
export function cleanRules(raw: Partial<MatchRules> | null | undefined): MatchRules {
  if (!raw) return DEFAULT_RULES;
  const target = Number(raw.targetPoints);
  const rate = Number(raw.powerRate);
  const level = Number(raw.aiLevel);
  return {
    targetPoints: TARGET_POINTS.includes(target) ? target : DEFAULT_RULES.targetPoints,
    winByTwo: typeof raw.winByTwo === 'boolean' ? raw.winByTwo : DEFAULT_RULES.winByTwo,
    powerUps: typeof raw.powerUps === 'boolean' ? raw.powerUps : DEFAULT_RULES.powerUps,
    powerRate: Number.isFinite(rate)
      ? clamp(Math.round(rate / POWER_RATE_STEP) * POWER_RATE_STEP, POWER_RATE_MIN, POWER_RATE_MAX)
      : DEFAULT_RULES.powerRate,
    aiLevel: Number.isFinite(level) ? clamp(Math.round(level), 0, TIERS.length - 1) : DEFAULT_RULES.aiLevel,
    doubles: typeof raw.doubles === 'boolean' ? raw.doubles : DEFAULT_RULES.doubles,
  };
}

/**
 * The rules as one integer, for the lobby's `matchRules` field.
 *
 * The platform documents that field as a packed number and clears it whenever
 * the room changes game, which is exactly what is wanted here: it costs one
 * field, it is cheap to compare (so the host only writes when something really
 * changed), and it can never be left behind for the next game in the room to
 * read as its own.
 *
 *   bits 0-1  which of TARGET_POINTS
 *   bit  2    win by two
 *   bit  3    power-ups
 *   bits 4-7  power-up rate, in quarter steps (1 = 0.25x ... 12 = 3x)
 *   bits 8-9  bot rank
 *   bit  10   two a side
 */
export function packRules(rules: MatchRules): number {
  const clean = cleanRules(rules);
  return (
    Math.max(0, TARGET_POINTS.indexOf(clean.targetPoints)) |
    (clean.winByTwo ? 4 : 0) |
    (clean.powerUps ? 8 : 0) |
    (Math.round(clean.powerRate / POWER_RATE_STEP) << 4) |
    (clean.aiLevel << 8) |
    (clean.doubles ? 1024 : 0)
  );
}

export function unpackRules(bits: number | undefined): MatchRules {
  if (typeof bits !== 'number' || !Number.isFinite(bits)) return DEFAULT_RULES;
  return cleanRules({
    targetPoints: TARGET_POINTS[bits & 3],
    winByTwo: (bits & 4) !== 0,
    powerUps: (bits & 8) !== 0,
    powerRate: ((bits >> 4) & 15) * POWER_RATE_STEP,
    aiLevel: (bits >> 8) & 3,
    doubles: (bits & 1024) !== 0,
  });
}

/** Plain words for the frequency slider, so it doesn't read as a bare multiplier. */
export function powerRateLabel(rate: number): string {
  if (rate <= 0.4) return 'Rare';
  if (rate <= 0.8) return 'Occasional';
  if (rate <= 1.3) return 'Normal';
  if (rate <= 2.2) return 'Frequent';
  return 'Chaos';
}

/** The interval the engine will actually use, in whole seconds. */
export function powerGapLabel(rate: number): string {
  const mid = (BALANCE.POWER_EVERY_MIN + BALANCE.POWER_EVERY_MAX) / 2 / Math.max(0.05, rate);
  return `${Math.round(mid)}s`;
}

/**
 * The match in one line, for the setup page's header.
 *
 * The format is left to the caller: offline it is "Solo" or "Couch 1v1", which
 * is the seat count at this device rather than anything in `rules`.
 */
export function rulesSummary(rules: MatchRules): string {
  return [
    `first to ${rules.targetPoints}`,
    rules.winByTwo ? 'win by two' : null,
    rules.powerUps ? `${powerRateLabel(rules.powerRate).toLowerCase()} power-ups` : 'no power-ups',
  ]
    .filter(Boolean)
    .join(' · ');
}
