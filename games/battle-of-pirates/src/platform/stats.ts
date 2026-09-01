/**
 * The captain's log: what this player has actually done, across every battle.
 *
 * Deliberately local and deliberately small. Coins live in the account because
 * they are spent on things the account owns (see wallet.ts); a record of your
 * own shooting is nobody else's business and nothing else reads it, so it stays
 * in this browser under this game's own key and costs the platform nothing.
 *
 * Every number here is counted from hulls this device actually sailed. A bot
 * that took over an abandoned wheel is not you, and neither is the enemy: a
 * shot only reaches these totals if it was fired by a ship under local control
 * at the moment it left the barrel.
 */
import type { CardId } from '../game/rules';

const KEY = 'pirates_stats_v1';

export interface Stats {
  battles: number;
  wins: number;
  /** Turns taken. One trigger pull, whatever the card put in the air. */
  shots: number;
  /** Shots where at least one ball found hull or rigging. */
  hits: number;
  /** Individual balls fired, and how many landed. Grapeshot makes these five apiece. */
  balls: number;
  ballsLanded: number;
  damage: number;
  /** Enemy hulls put under by a shot of yours. */
  sunk: number;
  /** Longest run of consecutive landed shots, ever. */
  bestStreak: number;
  /** Times each card was fired. */
  cards: Partial<Record<CardId, number>>;
}

export const EMPTY: Stats = {
  battles: 0, wins: 0, shots: 0, hits: 0, balls: 0, ballsLanded: 0,
  damage: 0, sunk: 0, bestStreak: 0, cards: {},
};

/** What one battle added. The engine keeps this; `merge` folds it into the log. */
export type MatchRecord = Omit<Stats, 'battles' | 'wins'>;

export const EMPTY_RECORD: MatchRecord = {
  shots: 0, hits: 0, balls: 0, ballsLanded: 0, damage: 0, sunk: 0, bestStreak: 0, cards: {},
};

export function readStats(): Stats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY, cards: {} };
    const saved = JSON.parse(raw) as Partial<Stats>;
    // Spread over EMPTY rather than trusted wholesale: a log written by an
    // older build is missing whichever counters came later, and a missing
    // counter read as undefined turns every total downstream into NaN.
    return {
      ...EMPTY,
      ...saved,
      cards: typeof saved.cards === 'object' && saved.cards ? saved.cards : {},
    };
  } catch {
    return { ...EMPTY, cards: {} };
  }
}

/** Fold one finished battle into the log and save it. Returns the new totals. */
export function recordBattle(won: boolean, match: MatchRecord): Stats {
  const now = readStats();
  const cards = { ...now.cards };
  for (const [id, n] of Object.entries(match.cards)) {
    cards[id as CardId] = (cards[id as CardId] ?? 0) + (n ?? 0);
  }
  const next: Stats = {
    battles: now.battles + 1,
    wins: now.wins + (won ? 1 : 0),
    shots: now.shots + match.shots,
    hits: now.hits + match.hits,
    balls: now.balls + match.balls,
    ballsLanded: now.ballsLanded + match.ballsLanded,
    damage: Math.round(now.damage + match.damage),
    sunk: now.sunk + match.sunk,
    bestStreak: Math.max(now.bestStreak, match.bestStreak),
    cards,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private browsing: the totals are a nicety, not the game */
  }
  return next;
}

export function clearStats() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

/** Shots landed as a share of shots fired, 0 to 100. Zero shots reads as zero. */
export function accuracy(s: Pick<Stats, 'shots' | 'hits'>): number {
  return s.shots === 0 ? 0 : Math.round((s.hits / s.shots) * 100);
}

/** The card fired most often, or null before anything has been. */
export function favouriteCard(s: Stats): { id: CardId; n: number } | null {
  let best: { id: CardId; n: number } | null = null;
  for (const [id, n] of Object.entries(s.cards)) {
    if ((n ?? 0) > (best?.n ?? 0)) best = { id: id as CardId, n: n ?? 0 };
  }
  return best;
}
