/**
 * The bots.
 *
 * Every decision is a pure function of (engine state, seeded rng), and the
 * rng is keyed on (match seed, round, actions so far, seat) — so the host and
 * every guest would compute the identical bot even though only the host
 * actually does. `Math.random()` in this file would be a desync waiting for
 * the first time a second client replays a round.
 *
 * A bot that played hangman optimally would be unbeatable and no fun: perfect
 * play here is just "always take the commonest letter that fits the pattern",
 * which never risks anything and never gets hanged. So the ranks differ in
 * how much of the pattern they actually use, and in how much nerve they have
 * as the gallows fills.
 */
import { ALPHABET, BY_FREQUENCY, LETTER_VALUE, PIECES } from '../game/rules';
import { answers } from '../game/words';
import type { Action } from '../types/game';
import type { LastGaspEngine } from './LastGaspEngine';

export interface Tier {
  label: string;
  /**
   * How often it narrows its guess to letters that actually fit the revealed
   * pattern, rather than just taking the next commonest letter in English.
   */
  deduction: number;
  /** How willing it is to call the word once it thinks it knows it. */
  nerve: number;
  /** How much it prefers a high-scoring rare letter over a safe common one. */
  greed: number;
}

export const TIERS: Tier[] = [
  { label: 'Doodler', deduction: 0.15, nerve: 0.12, greed: 0.05 },
  { label: 'Speller', deduction: 0.55, nerve: 0.3, greed: 0.2 },
  { label: 'Wordsmith', deduction: 0.9, nerve: 0.55, greed: 0.4 },
];

/**
 * How much of the word a bot has to be able to *see* before it will call it.
 *
 * This exists because a bot can do something no player at the table can: look
 * the answer up. `candidates()` below filters the real answer list, and on a
 * list this size a pattern with two or three letters showing is very often
 * unique — so without this gate the top rank simply identified the word on
 * its second turn, every turn, and won by dictionary lookup rather than by
 * playing.
 *
 * The measured cost of not having it: across 280 simulated matches, 95% of
 * rounds ended in a called word and the stickman was finished in 1.2% of
 * them. The entire mechanic this game is built on never fired.
 *
 * Requiring half the letters on the board first makes the bot call a word for
 * the reason a person does — because they can nearly read it — rather than
 * because they can search for it.
 */
const CALL_THRESHOLD = 0.5;

/** Every answer that still fits the board and the letters already ruled out. */
function candidates(engine: LastGaspEngine): string[] {
  const board = engine.board;
  const called = new Set(engine.called);
  const ruled = [...called].filter((c) => !engine.word.includes(c));
  return answers()
    .map((a) => a.word)
    .filter((w) => {
      if (w.length !== board.length) return false;
      for (let i = 0; i < w.length; i++) {
        // A revealed square has to match exactly...
        if (board[i] !== null && w[i] !== board[i]) return false;
        // ...and a blank cannot be a letter that has already been called,
        // because that letter would have been revealed if it were there.
        if (board[i] === null && called.has(w[i])) return false;
      }
      // And it cannot contain anything already established as absent.
      return !ruled.some((c) => w.includes(c));
    });
}

/**
 * One bot's turn.
 *
 * Reads in priority order: call the word if it is confident and the prize is
 * worth it, otherwise take a letter — narrowed by the pattern if the rank is
 * good enough to do that, and skewed toward valuable letters if it is greedy.
 */
export function botAction(engine: LastGaspEngine, seat: number, level: number, rnd: () => number): Action {
  const tier = TIERS[Math.max(0, Math.min(TIERS.length - 1, level))];
  const fits = candidates(engine);
  const available = engine.available;
  const danger = engine.pieces / PIECES;

  // ── call the word ───────────────────────────────────────────────────────
  //
  // Gated on how much is actually *visible*, not just on how far the answer
  // list has narrowed — see CALL_THRESHOLD. A wrong call costs two pieces AND
  // the rest of the round, so a bot that fished for it would also spend most
  // of every match sitting out, which reads as broken rather than reckless.
  const revealed = 1 - engine.hiddenCount / Math.max(1, engine.board.length);
  if (revealed >= CALL_THRESHOLD && fits.length > 0 && fits.length <= 3 && engine.hiddenCount > 0) {
    const sure = 1 / fits.length;
    // More willing the closer the stickman is to finished: at that point a
    // letter is a real risk too, and being the one who draws the last line is
    // worse than being wrong.
    if (rnd() < tier.nerve * sure * (0.5 + danger)) {
      return { s: seat, w: fits[Math.floor(rnd() * fits.length)] };
    }
  }

  // ── take a letter ───────────────────────────────────────────────────────
  let pool = available;
  if (fits.length > 0 && rnd() < tier.deduction) {
    // Letters that appear in something still possible. Ranked by how many of
    // the remaining candidates they would split, which is the actual skill in
    // hangman and the thing the top rank should look like it is doing.
    const counts = new Map<string, number>();
    for (const w of fits) {
      for (const ch of new Set([...w])) {
        if (!available.includes(ch)) continue;
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (ranked.length > 0) {
      // Near the top of the list, not always the very top — a bot that is
      // never surprising is a bot nobody enjoys losing to.
      const width = Math.max(1, Math.ceil(ranked.length * (1 - tier.deduction * 0.7)));
      pool = ranked.slice(0, width).map(([ch]) => ch);
    }
  } else {
    pool = BY_FREQUENCY.filter((c) => available.includes(c)).slice(0, 6);
    if (pool.length === 0) pool = available;
  }

  if (pool.length === 0) {
    // Nothing left to call at all: throw the word it likes best rather than
    // stalling the table.
    return { s: seat, w: fits[0] ?? engine.word };
  }

  // Greed: bias toward the letter that pays, when the gallows can still take
  // a hit. Nobody gets greedy on the last line.
  if (rnd() < tier.greed * (1 - danger)) {
    const best = [...pool].sort(
      (a, b) => (LETTER_VALUE[b] ?? 1) - (LETTER_VALUE[a] ?? 1) || a.localeCompare(b),
    )[0];
    return { s: seat, l: ALPHABET.indexOf(best) };
  }

  return { s: seat, l: ALPHABET.indexOf(pool[Math.floor(rnd() * pool.length)] ?? pool[0]) };
}

/**
 * What a player who ran out of clock does.
 *
 * The commonest letter still available — the safe, boring guess a distracted
 * player would probably have made anyway. Deliberately not random: a timeout
 * is usually a locked phone or somebody still reading the board, and neither
 * of them consented to a gamble that could hang them.
 */
export function timeoutAction(engine: LastGaspEngine, seat: number): Action {
  const available = engine.available;
  const pick = BY_FREQUENCY.find((c) => available.includes(c)) ?? available[0];
  return { s: seat, l: ALPHABET.indexOf(pick) };
}
