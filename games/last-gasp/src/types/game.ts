import type { PlayerCount } from '../game/rules';

export type { PlayerCount };

/**
 * Who is driving a seat.
 *
 * `local` is played on this device, `remote` arrives over the wire, `ai` is a
 * bot. A seat flips from `remote` to `ai` when somebody leaves, and the
 * resolver never has to care which it was.
 */
export type Control = 'local' | 'remote' | 'ai';

/** What the table is waiting for. */
export type Phase = 'guessing' | 'roundOver' | 'over';

/** Preferences that belong to this device and nobody else. */
export interface GameSettings {
  sfxVolume: number;
  /** Grey out letters already called, rather than leaving the keyboard untouched. */
  markUsed: boolean;
}

/**
 * How this game is played, set by the host and obeyed by everyone.
 *
 * These reach a guest over the wire before its first word is drawn (see
 * `packRules`), because a guest playing a different number of rounds, or
 * seating a different number of players, builds a different match and
 * rejects everything the host sends.
 */
export interface MatchRules {
  players: PlayerCount;
  /** Lock a guess in for anyone still deciding after TURN_SECONDS. */
  turnTimer: boolean;
  /** How many words the match runs for. Index into ROUND_CHOICES. */
  rounds: number;
}

export const ROUND_CHOICES = [3, 5, 8];

export const DEFAULT_RULES: MatchRules = {
  players: 2,
  turnTimer: true,
  rounds: 1,
};

const PLAYER_CODES: PlayerCount[] = [2, 3, 4, 5, 6, 7, 8];

/**
 * The rules as one integer.
 *
 * TurnLink stamps a flat `Record<string, number>` onto every packet a client
 * writes, so a guest arriving after the first word still learns the match's
 * terms from whatever packet happens to be in the document. Packing them into
 * a single number is what lets them ride along in that slot.
 */
export function packRules(rules: MatchRules): number {
  const players = Math.max(0, PLAYER_CODES.indexOf(rules.players));
  const rounds = Math.max(0, Math.min(ROUND_CHOICES.length - 1, rules.rounds));
  return (players & 7) | (rules.turnTimer ? 8 : 0) | (rounds << 4);
}

export function unpackRules(bits: number | undefined): MatchRules {
  if (typeof bits !== 'number' || !Number.isFinite(bits)) return DEFAULT_RULES;
  return {
    players: PLAYER_CODES[bits & 7] ?? DEFAULT_RULES.players,
    turnTimer: (bits & 8) !== 0,
    rounds: (bits >> 4) & 3,
  };
}

// ── one player's turn ──────────────────────────────────────────────────────

/**
 * One action, exactly as it goes on the wire and into the history.
 *
 * Deliberately records what was *attempted*, never what it was worth. The
 * engine re-derives every consequence — points, pieces, whose turn is next,
 * whether the round ended — by replaying the list against the word it
 * computed for itself. Recording an outcome instead would mean two clients
 * could disagree about a round and both believe their own copy.
 *
 * `w` carries the actual attempted string rather than a right/wrong flag,
 * because "he guessed PORRIDGE?" is half the fun of watching somebody lose.
 * Capped and sanitised on the way in — see `cleanAttempt`.
 */
export type Action =
  /** A letter, as an index into ALPHABET. */
  | { s: number; l: number }
  /** A go at the whole word. */
  | { s: number; w: string };

/** The longest answer is 12 letters; anything longer is not a guess at this word. */
export const MAX_ATTEMPT = 16;

/**
 * A word attempt, reduced to something safe to store, replay and draw.
 *
 * This string is the one piece of free text in the whole protocol — every
 * other field is a number — so it is stripped to A-Z here, on the way in,
 * rather than trusted anywhere downstream.
 */
export function cleanAttempt(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, MAX_ATTEMPT);
}

/** One round's actions, in the order they were played. */
export type RoundHistory = Action[];

// ── the wire ───────────────────────────────────────────────────────────────

/**
 * The whole protocol.
 *
 * Same shape as Wanted Board's, and for the same reason: exactly one client
 * decides what happened. Guests publish the action they want to take and
 * nothing else; the host validates it against the turn order, appends it, and
 * republishes the entire history. A guest never computes a consequence, so
 * there is no arithmetic for two clients to disagree about and no
 * reconciliation path to get wrong.
 */

export interface StartPacket {
  t: 'start';
  n: number;
  /** Picks every word in the match, and seeds every bot. */
  seed: number;
  /** The host's rules, packed by `packRules`. */
  r: number;
}

/** A guest telling the host what it wants to do. */
export interface PlayPacket {
  t: 'play';
  n: number;
  /** The match this belongs to. A mismatch means a document left over from last night. */
  s: number;
  /** Which round this is an action for — a late packet for a finished round is dropped. */
  rd: number;
  /** How many actions this round had already seen. The host's guard against a double-send. */
  at: number;
  /** A letter index, or -1 when `w` carries a word attempt instead. */
  l: number;
  w?: string;
}

/**
 * The host publishing the match so far.
 *
 * Every round's actions, every time. A whole match is five rounds of at most
 * a couple of dozen tiny objects, so the complete history is well under a
 * Firestore document and a player who reloads, joins late or sleeps their
 * phone receives the entire game on the very next turn and replays it. There
 * is no resync path because there is nothing to resync.
 */
export interface StatePacket {
  t: 'state';
  n: number;
  s: number;
  /** Every round's actions, oldest round first. */
  h: RoundHistory[];
  /** The host's rules, stamped on every write so a late joiner can still build the match. */
  r?: number;
  /** The seed, stamped for the same reason. */
  seed?: number;
}

/** Sent on the way out, so a seat is taken over by a bot rather than stalling the turn. */
export interface ByePacket {
  t: 'bye';
  n: number;
}

/** Written on arrival to clear whatever the last match left in the document. */
export interface IdlePacket {
  t: 'idle';
  n: number;
}

export type NetPacket = StartPacket | PlayPacket | StatePacket | ByePacket | IdlePacket;
