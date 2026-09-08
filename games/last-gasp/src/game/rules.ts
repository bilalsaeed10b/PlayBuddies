/**
 * Every number and every rule the game runs on, in one file.
 *
 * The idea this is all built around: a plain hangman is a puzzle, and a
 * puzzle is a thing one person solves while everybody else watches. Here
 * somebody at the table sets the word — typed by hand, not drawn from a list
 * — and everybody else races to crack it. Nobody waits for a turn: any
 * guesser may call any letter at any moment, and the one who gets a letter
 * right earns a short window to keep going before the board opens back up to
 * the whole table. The gallows is still shared, and whoever draws its last
 * line forfeits everything they earned that word.
 *
 * Everything below exists to sharpen that. Anything that makes a correct
 * guess feel the same whether it opened the round or closed it makes the
 * game worse.
 */

/**
 * How many wrong guesses the stickman can absorb.
 *
 * Kept from the turn-based version's own measurement rather than re-guessed:
 * six is the number everybody already recognises, and simulating full
 * matches showed it lands a real table's hang rate around a third of
 * rounds — often enough to be feared every round, rare enough that reaching
 * it still feels like something went wrong. The mechanics generating misses
 * changed completely; the count that makes them land right did not.
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
 * because they are less likely to be there. That is the decision every open
 * guess is — take E for a pittance where five other people might beat you to
 * it, or take K for real money on the same bet.
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

/** English letter frequency, commonest first. Drives the bots. */
export const BY_FREQUENCY = 'ETAOINSRHLDCUMFPGWYBVKXJQZ'.split('');

export const BALANCE = {
  /**
   * A wrong guess draws one line on the shared stickman. Whoever draws the
   * line that finishes it loses every point they earned this word — not the
   * whole table's, just theirs. It is what keeps an open guess a real bet
   * rather than a free lottery ticket: five people racing for the same
   * letter is fine right up until missing it costs something.
   */
  HANG_PENALTY: 'round' as const,

  /**
   * How long a correct guess buys the guesser exclusive control, in
   * milliseconds.
   *
   * This is the whole shape of the game: get a letter right and the board
   * stops being a race for two seconds, which is enough time to try again
   * while you are the only one allowed to, and not enough time to think hard
   * about it. Miss inside the window, or let it run out, and it opens back up
   * to everyone.
   */
  CHAIN_WINDOW_MS: 2000,

  /**
   * How much each consecutive chained hit is worth, as a multiplier on the
   * letter's own value — 1.0 for a cold, open-table guess, rising with every
   * hit landed inside the same unbroken chain.
   *
   * Uncapped in principle but self-limiting in practice: a word only has so
   * many distinct letters, and each one still costs a genuine 2-second guess.
   * Chaining through the last three letters of a word to solo-crack it is
   * supposed to feel like it paid for itself.
   */
  CHAIN_STEP: 0.35,

  /** How many words in a match. Index into ROUND_CHOICES. */
  ROUNDS: 5,

  /** Seconds a word-setter (or a team member suggesting one) gets before a bot word fills in for them. */
  SET_SECONDS: 30,

  /** Seconds a team gets to vote once every suggestion is in. */
  VOTE_SECONDS: 15,

  /** A word must be at least this long — one letter is not a hangman word. */
  MIN_WORD_LEN: 3,
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

/** Team colours. Deliberately distinct from SEAT_COLORS so a team badge and a seat chip are never confused. */
export const TEAM_COLORS = [
  { name: 'Blaze', main: '#f97316' },
  { name: 'Tide', main: '#0ea5e9' },
  { name: 'Moss', main: '#65a30d' },
  { name: 'Plum', main: '#a855f7' },
];

export type PlayerCount = 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const PLAYER_COUNTS: PlayerCount[] = [2, 3, 4, 5, 6, 7, 8];

export type Mode = 'ffa' | 'teams';

export const MIN_TEAMS = 2;
export const MAX_TEAMS = 4;

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Deterministic PRNG.
 *
 * A bot's own word choice, and any bot guess timing, has to land the same on
 * every client, so nothing in a match is allowed to touch `Math.random()`.
 * Same generator as the rest of the platform.
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

/** What one revealed letter is worth on its own, times how many copies it has. */
export function scoreFor(letter: string, copies: number): number {
  return (LETTER_VALUE[letter] ?? 1) * copies;
}

/** The multiplier a hit at chain depth `n` (0 = cold, open-table guess) earns. */
export function chainMultiplier(depth: number): number {
  return 1 + Math.max(0, depth) * BALANCE.CHAIN_STEP;
}
