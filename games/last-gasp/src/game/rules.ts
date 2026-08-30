/**
 * Every number and every rule the game runs on, in one file.
 *
 * The idea this is all built around: a plain hangman is a puzzle, and a
 * puzzle is a thing one person solves while everybody else watches. So the
 * gallows here is *shared*, and the player who draws the line that finishes
 * it is the one who pays for it. That single change turns a spelling test
 * into a party game — the same letter guess is free on the first turn and
 * terrifying on the seventh, and the pressure is on whoever's turn it
 * happens to be rather than on whoever happens to be good at anagrams.
 *
 * Everything below exists to sharpen that. Anything that makes a late guess
 * feel the same as an early one makes the game worse.
 */

/**
 * How many wrong guesses the stickman can absorb.
 *
 * Six, picked by measurement rather than by feel. This was originally eight,
 * on the reasoning that six misses shared between six players is barely one
 * mistake each — and that reasoning turned out to be simply wrong. The thing
 * that ends a round is not the table running out of misses, it is somebody
 * working the word out, and simulating full matches showed the gallows almost
 * never filled at all: across 2100 rounds it finished 2.8% of the time at
 * eight, which made the mechanic the whole game is built on a non-event.
 *
 * Measured probability that the stickman is finished, by table skill:
 *
 *            naive    mid    near-optimal
 *   four      82%     38%      12%
 *   five      70%     23%       5%
 *   six       56%     13%       2%
 *   seven     44%      7%       0%
 *   eight     34%      3%       0%
 *
 * Real players sit between the first two columns — they guess by letter
 * frequency and read the revealed pattern, but unlike a bot they cannot
 * consult the answer list. Six puts a real table somewhere around a third of
 * rounds, which is often enough to be feared every round and rare enough
 * that reaching it still feels like something went wrong.
 *
 * It is also the number everybody already knows, so the finished drawing is
 * the one they are expecting.
 */
export const PIECES = 6;

/** Drawn in this order, one per wrong guess. Index is the piece number. */
export const PIECE_NAMES = [
  'head',
  'body',
  'left arm',
  'right arm',
  'left leg',
  'right leg',
] as const;

/**
 * What each letter is worth per copy revealed.
 *
 * Scrabble's values, and for Scrabble's reason: rare letters are worth more
 * because they are less likely to be there. That is the whole decision this
 * game hands you on a safe turn — take E for a pittance, or take K for real
 * money and maybe a limb. Without it the correct play is always "guess the
 * commonest unused letter", every turn, forever, which is not a decision.
 */
export const LETTER_VALUE: Record<string, number> = {
  A: 1, E: 1, I: 1, O: 1, U: 1, L: 1, N: 1, S: 1, T: 1, R: 1,
  D: 2, G: 2,
  B: 3, C: 3, M: 3, P: 3,
  F: 4, H: 4, V: 4, W: 4, Y: 4,
  K: 5,
  J: 8, X: 8,
  Q: 10, Z: 10,
};

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** English letter frequency, commonest first. Drives bots and the timeout guess. */
export const BY_FREQUENCY = 'ETAOINSRHLDCUMFPGWYBVKXJQZ'.split('');

export const BALANCE = {
  /**
   * A correct solve pays this per still-hidden letter, on top of the letters
   * it reveals.
   *
   * Scaled by what is *left*, so solving is worth most when the board is
   * nearly blank and worth almost nothing once somebody else has done the
   * work of opening it up. That is what stops the right play being "wait for
   * the board to fill in, then steal it on the last turn".
   */
  SOLVE_BONUS_PER_LETTER: 3,

  /**
   * A wrong solve costs this many pieces, and locks the guesser out of the
   * rest of the round.
   *
   * Two, not one: a solve attempt has to be a real bet or the correct play is
   * to fish for it every single turn. The lockout matters more than the
   * pieces — it means an early wild guess costs you the whole round's
   * earnings, not just a limb.
   */
  WRONG_SOLVE_PIECES: 2,

  /**
   * What the player who completes the stickman loses.
   *
   * Their entire bank *for that round* — not their match total. Losing a
   * whole match to one bad turn would be miserable; losing the forty points
   * you spent this round carefully accumulating, in front of everyone, is
   * exactly the right amount of miserable.
   */
  HANG_PENALTY: 'round' as const,

  /** Rounds in a match. Each one is a fresh word and a fresh gallows. */
  ROUNDS: 5,

  /** Seconds on the clock for one player's turn. */
  TURN_SECONDS: 20,

  /**
   * How many letters of a word may already be showing before the game stops
   * treating "reveal the last letters" as worth a solve bonus.
   *
   * Nothing reads this — it is here as the note that the bonus formula above
   * already handles it, because the bonus is per *hidden* letter and there
   * are none left to pay for.
   */
} as const;

/** Seat colours. Index is the seat, not the player. */
export const SEAT_COLORS = [
  { name: 'Chalk', main: '#f8fafc', ink: '#0f172a' },
  { name: 'Coral', main: '#fb7185', ink: '#4c0519' },
  { name: 'Sky', main: '#38bdf8', ink: '#082f49' },
  { name: 'Lime', main: '#a3e635', ink: '#1a2e05' },
  { name: 'Amber', main: '#fbbf24', ink: '#451a03' },
  { name: 'Violet', main: '#c084fc', ink: '#3b0764' },
  { name: 'Teal', main: '#2dd4bf', ink: '#042f2e' },
  { name: 'Rose', main: '#f472b6', ink: '#500724' },
];

export type PlayerCount = 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const PLAYER_COUNTS: PlayerCount[] = [2, 3, 4, 5, 6, 7, 8];

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Deterministic PRNG.
 *
 * Every client has to pick the same word for the same round and compute the
 * same bot decisions, so nothing in a match is allowed to touch
 * `Math.random()`. Same generator as the rest of the platform.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What one revealed letter is worth, times how many copies it has. */
export function scoreFor(letter: string, copies: number): number {
  return (LETTER_VALUE[letter] ?? 1) * copies;
}
