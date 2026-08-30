/**
 * The bots.
 *
 * Every decision is a pure function of (engine state, seeded rng), keyed on
 * (match seed, round, actions so far, seat) so the host and every guest
 * would compute the identical bot even though only the host actually acts on
 * it. `Math.random()` here would be a desync waiting to happen the first
 * time a second client replays a round.
 *
 * Reaction *timing* is the one thing this file does not decide — that lives
 * in MatchView, which schedules a randomised delay per tier before actually
 * calling into here. This file only ever answers "what would this bot do",
 * never "how fast".
 */
import { ALPHABET, BY_FREQUENCY, LETTER_VALUE } from '../game/rules';
import { answers } from '../game/words';
import type { LastGaspEngine } from './LastGaspEngine';

export interface Tier {
  label: string;
  /** How much of the built-in list a bot's own word choice is allowed to lean on for flavour, purely cosmetic. */
  vocab: number;
  /** How willing it is to chase a chain rather than let the table reopen. */
  boldness: number;
  /** Base reaction delay band for an open guess, in ms — [min, max]. Lower is sharper. */
  reactMs: [number, number];
  /** Reaction band for continuing its own chain, in ms — tight, because the window is only 2000ms. */
  chainMs: [number, number];
}

export const TIERS: Tier[] = [
  { label: 'Doodler', vocab: 0.2, boldness: 0.3, reactMs: [1600, 3400], chainMs: [900, 2200] },
  { label: 'Speller', vocab: 0.55, boldness: 0.55, reactMs: [900, 2200], chainMs: [500, 1500] },
  { label: 'Wordsmith', vocab: 0.9, boldness: 0.8, reactMs: [450, 1300], chainMs: [250, 1000] },
];

function tierOf(level: number): Tier {
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, level))];
}

/** A word for a bot to set or suggest — always from the built-in list, since a bot cannot type something meaningful. */
export function botWord(rnd: () => number): { word: string; category: string } {
  const list = answers();
  return list[Math.floor(rnd() * list.length) % list.length];
}

/** How a bot votes: usually for whichever suggestion looks like a real answer-list word, tie-broken toward its own. */
export function botVote(engine: LastGaspEngine, seat: number, rnd: () => number): number {
  const known = new Set(answers().map((a) => a.word));
  const suggestions = engine.suggestions;
  const scored = suggestions.map((s, i) => ({
    i,
    good: known.has(s.word) ? 1 : 0,
    mine: s.seat === seat ? 1 : 0,
  }));
  scored.sort((a, b) => b.good - a.good || b.mine - a.mine || a.i - b.i);
  // A little noise so a table of bots doesn't vote in perfect lockstep.
  return rnd() < 0.85 ? scored[0].i : scored[Math.floor(rnd() * scored.length)]?.i ?? 0;
}

/** Every built-in answer that still fits the board and the letters already ruled out — empty for a human-typed word, which is expected. */
function candidates(engine: LastGaspEngine): string[] {
  const board = engine.board;
  const called = new Set(engine.called);
  const ruled = [...called].filter((c) => !engine.word.includes(c));
  return answers()
    .map((a) => a.word)
    .filter((w) => {
      if (w.length !== board.length) return false;
      for (let i = 0; i < w.length; i++) {
        if (board[i] !== null && w[i] !== board[i]) return false;
        if (board[i] === null && called.has(w[i])) return false;
      }
      return !ruled.some((c) => w.includes(c));
    });
}

/**
 * The letter a bot would call right now.
 *
 * Falls back to plain letter frequency whenever the pattern fit is empty —
 * which, now that a word is usually typed by a person rather than drawn from
 * the list, is the common case. A bot leaning on list knowledge it has no
 * business having for somebody else's word would be the same unfair
 * dictionary lookup the turn-based version had to be fixed for.
 */
export function botGuess(engine: LastGaspEngine, level: number, rnd: () => number): number {
  const tier = tierOf(level);
  const available = engine.available;
  const fits = rnd() < tier.vocab ? candidates(engine) : [];

  let pool = available;
  if (fits.length > 0 && fits.length <= 12) {
    const counts = new Map<string, number>();
    for (const w of fits) {
      for (const ch of new Set([...w])) {
        if (!available.includes(ch)) continue;
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (ranked.length > 0) pool = ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.6))).map(([ch]) => ch);
  } else {
    pool = BY_FREQUENCY.filter((c) => available.includes(c)).slice(0, 8);
    if (pool.length === 0) pool = available;
  }

  // A sharper bot still likes a rare letter when it is not desperate to just
  // land something safe — same greed as any player watching the values on
  // the keys.
  if (rnd() < tier.boldness * 0.3) {
    const best = [...pool].sort((a, b) => (LETTER_VALUE[b] ?? 1) - (LETTER_VALUE[a] ?? 1) || a.localeCompare(b))[0];
    return ALPHABET.indexOf(best);
  }
  return ALPHABET.indexOf(pool[Math.floor(rnd() * pool.length)] ?? pool[0] ?? available[0]);
}

/** How long this bot takes to react to an open table, in ms. */
export function reactionDelay(level: number, rnd: () => number): number {
  const [lo, hi] = tierOf(level).reactMs;
  return Math.round(lo + rnd() * (hi - lo));
}

/** How long this bot takes to press its luck on its own chain, in ms — may exceed the window, meaning it lets the chain lapse on purpose. */
export function chainDelay(level: number, rnd: () => number): number {
  const [lo, hi] = tierOf(level).chainMs;
  return Math.round(lo + rnd() * (hi - lo));
}

/** Whether a bot bothers continuing its own chain at all, rather than banking what it has. */
export function willChase(level: number, rnd: () => number): boolean {
  return rnd() < tierOf(level).boldness;
}
