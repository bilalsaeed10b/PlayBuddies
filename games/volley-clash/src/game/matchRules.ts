/**
 * How a match is played, and how it reaches everyone playing it.
 *
 * These used to sit in the settings modal beside the volume sliders, which
 * meant every device kept its own copy. Online that was quietly wrong: the
 * host is the only machine that scores and decides a match is over, so a guest
 * that took a stalled match over (MatchEngine.promote) finished it to whatever
 * target *it* happened to have.
 *
 * They are the room's rules now: the host sets them on the match setup page
 * and publishes them to the lobby, and everyone builds their engine from the
 * same numbers.
 */
import { TIERS } from '../engine/ai';
import type { MatchRules } from '../types/game';

/** The three lengths of match this game offers. */
export const TARGET_POINTS = [5, 7, 11];

export const DEFAULT_RULES: MatchRules = {
  targetPoints: 7,
  winByTwo: false,
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
 * number read as a string. A target score of 6, or a bot rank of 4, would not
 * be refused anywhere further down , it would simply be a match nobody can
 * win, or `TIERS[4].label` throwing as the roster draws.
 */
export function cleanRules(raw: Partial<MatchRules> | null | undefined): MatchRules {
  if (!raw) return DEFAULT_RULES;
  const target = Number(raw.targetPoints);
  const level = Number(raw.aiLevel);
  return {
    targetPoints: TARGET_POINTS.includes(target) ? target : DEFAULT_RULES.targetPoints,
    winByTwo: typeof raw.winByTwo === 'boolean' ? raw.winByTwo : DEFAULT_RULES.winByTwo,
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
 *   bits 3-4  bot rank
 *   bit  5    two a side
 *
 * Bits 3 upward moved down when power-ups were removed, rather than leaving a
 * hole where the on/off flag and the frequency used to sit. Safe because the
 * host rewrites this field in the same document update that moves the room to
 * the match page, and a guest only reads it from that point on , a number
 * packed by an older build is never one anybody unpacks.
 */
export function packRules(rules: MatchRules): number {
  const clean = cleanRules(rules);
  return (
    Math.max(0, TARGET_POINTS.indexOf(clean.targetPoints)) |
    (clean.winByTwo ? 4 : 0) |
    (clean.aiLevel << 3) |
    (clean.doubles ? 32 : 0)
  );
}

export function unpackRules(bits: number | undefined): MatchRules {
  if (typeof bits !== 'number' || !Number.isFinite(bits)) return DEFAULT_RULES;
  return cleanRules({
    targetPoints: TARGET_POINTS[bits & 3],
    winByTwo: (bits & 4) !== 0,
    aiLevel: (bits >> 3) & 3,
    doubles: (bits & 32) !== 0,
  });
}

/**
 * The match in one line, for the setup page's header.
 *
 * The format is left to the caller: offline it is "Solo" or "Couch 1v1", which
 * is the seat count at this device rather than anything in `rules`.
 */
export function rulesSummary(rules: MatchRules): string {
  return [`first to ${rules.targetPoints}`, rules.winByTwo ? 'win by two' : null]
    .filter(Boolean)
    .join(' · ');
}
