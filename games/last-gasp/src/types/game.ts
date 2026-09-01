import type { Mode, PlayerCount } from '../game/rules';
import { MAX_TEAMS, MIN_TEAMS } from '../game/rules';

export type { PlayerCount, Mode };

/**
 * Who is driving a seat.
 *
 * `local` is played on this device, `remote` arrives over the wire, `ai` is a
 * bot. A seat flips from `remote` to `ai` when somebody leaves, and the
 * resolver never has to care which it was.
 */
export type Control = 'local' | 'remote' | 'ai';

/**
 * What the table is waiting for.
 *
 * `settingWord` only exists in Free-For-All; `suggesting`/`voting` only exist
 * in Teams. `guessing` is where both modes spend most of a round.
 */
export type Phase = 'settingWord' | 'suggesting' | 'voting' | 'guessing' | 'roundOver' | 'over';

/** Preferences that belong to this device and nobody else. */
export interface GameSettings {
  sfxVolume: number;
  /** Grey out letters already called, rather than leaving the keyboard untouched. */
  markUsed: boolean;
}

/**
 * How this game is played, set by the host and obeyed by everyone.
 *
 * Team assignment lives here rather than in an in-match settings panel —
 * "who is on which team" is a lobby decision with real consequences for who
 * you are about to play with, not a toggle to fix mid-match.
 */
export interface MatchRules {
  players: PlayerCount;
  mode: Mode;
  /** Meaningful only when `mode === 'teams'`. */
  teamCount: number;
  /** Seat index -> team index (0-based). Meaningful only when `mode === 'teams'`. */
  teamOf: number[];
  /** How many words the match runs for. Index into ROUND_CHOICES. */
  rounds: number;
}

export const ROUND_CHOICES = [3, 5, 8];

export const DEFAULT_RULES: MatchRules = {
  players: 2,
  mode: 'ffa',
  teamCount: 2,
  teamOf: [],
  rounds: 1,
};

/** An even split — team 0, team 1, team 0, team 1, ... — the default before a host drags anyone around. */
export function defaultTeams(players: number, teamCount: number): number[] {
  return Array.from({ length: players }, (_, i) => i % Math.max(MIN_TEAMS, Math.min(MAX_TEAMS, teamCount)));
}

const PLAYER_CODES: PlayerCount[] = [2, 3, 4, 5, 6, 7, 8];
const TEAM_CODES = [2, 3, 4];

/**
 * The rules as one integer, teams and all.
 *
 * TurnLink stamps a flat `Record<string, number>` onto every packet a client
 * writes, so a guest arriving after the first word still learns the match's
 * terms from whatever packet happens to be in the document. Bits 0-7 are the
 * simple choices; bits 8 upward are two bits per seat holding that seat's
 * team, which is why this is a single wide integer instead of the small one
 * the turn-based version got away with.
 */
export function packRules(rules: MatchRules): number {
  const playersIdx = Math.max(0, PLAYER_CODES.indexOf(rules.players));
  const modeBit = rules.mode === 'teams' ? 1 : 0;
  const teamCountIdx = Math.max(0, TEAM_CODES.indexOf(rules.teamCount));
  const roundsIdx = Math.max(0, Math.min(ROUND_CHOICES.length - 1, rules.rounds));
  let teamBits = 0;
  for (let i = 0; i < 8; i++) teamBits |= (rules.teamOf[i] ?? 0) << (i * 2);
  return (playersIdx & 7) | (modeBit << 3) | ((teamCountIdx & 3) << 4) | ((roundsIdx & 3) << 6) | (teamBits << 8);
}

export function unpackRules(bits: number | undefined): MatchRules {
  if (typeof bits !== 'number' || !Number.isFinite(bits)) return DEFAULT_RULES;
  const players = PLAYER_CODES[bits & 7] ?? DEFAULT_RULES.players;
  const teamBits = Math.floor(bits / 256);
  const teamOf: number[] = [];
  for (let i = 0; i < players; i++) teamOf.push((teamBits >> (i * 2)) & 3);
  return {
    players,
    mode: (bits & 8) !== 0 ? 'teams' : 'ffa',
    teamCount: TEAM_CODES[(bits >> 4) & 3] ?? DEFAULT_RULES.teamCount,
    teamOf,
    rounds: (bits >> 6) & 3,
  };
}

// ── one action, exactly as it goes on the wire and into the history ────────

/** The longest word this game accepts. Long enough for a real word, short enough to fit the board. */
export const MAX_WORD_LEN = 18;

/**
 * A word attempt, reduced to something safe to store, replay and draw.
 *
 * This string is the one piece of free text in the whole protocol — every
 * other field is a number — so it is stripped to A-Z here, on the way in,
 * rather than trusted anywhere downstream.
 */
export function cleanWord(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, MAX_WORD_LEN);
}

/**
 * One action.
 *
 * Deliberately records what was *attempted*, never what it was worth — the
 * engine re-derives every consequence (points, pieces, whose chain it is,
 * whether the round ended) by replaying the list, so two clients can never
 * disagree about a round. A guess carries only the letter, not the chain
 * depth it lands at: that depth is fully determined by the sequence of
 * guesses before it, so baking it into the wire would just be a second copy
 * of information already implied by the order the actions arrive in.
 */
export type Action =
  /** The word-setter (FFA) or a team member (Teams, suggesting) proposing a word. */
  | { t: 'word'; s: number; w: string }
  /** A team member voting for one of their team's suggestions, by its index this round. */
  | { t: 'vote'; s: number; pick: number }
  /** A letter, as an index into ALPHABET. */
  | { t: 'guess'; s: number; l: number }
  /** The chain window lapsed with nobody acting. Recorded once, by the host, so every client agrees exactly when the table reopened. */
  | { t: 'expire' };

/** One round's actions, in the order they were played. */
export type RoundHistory = Action[];

/**
 * The history, flattened for Firestore.
 *
 * Firestore refuses any document containing an array directly inside another
 * array, and a list of rounds where each round is itself a list of actions is
 * exactly that. `setDoc` rejected the entire write with "Nested arrays are
 * not supported" — so the host's state packet never landed, no guess ever
 * reached anybody, and the retry path surfaced it as "that move did not reach
 * the other players": true, but blaming the network for what was really the
 * shape of the data.
 *
 * On the wire it is one flat run of actions plus each round's length. An
 * array of plain objects is fine; it is only array-inside-array that is not.
 */
export function packHistory(rounds: RoundHistory[]): { h: Action[]; hc: number[] } {
  const h: Action[] = [];
  const hc: number[] = [];
  for (const round of rounds) {
    hc.push(round.length);
    for (const action of round) h.push(action);
  }
  return { h, hc };
}

export function unpackHistory(h: Action[] | undefined, hc: number[] | undefined): RoundHistory[] {
  if (!Array.isArray(h) || !Array.isArray(hc)) return [];
  const rounds: RoundHistory[] = [];
  let at = 0;
  for (const length of hc) {
    rounds.push(h.slice(at, at + length));
    at += length;
  }
  return rounds;
}

// ── the wire ───────────────────────────────────────────────────────────────

/**
 * The whole protocol.
 *
 * Same shape as Wanted Board's and the turn-based version of this game: one
 * client — the host — decides what happened. Guests publish the action they
 * want to take and nothing else; the host validates it, appends it, and
 * republishes the entire history. A guest never computes a consequence.
 *
 * One honesty note, shared with Wanted Board's card secrecy: the word a
 * setter types has to end up in `history` for a late guest to be able to
 * replay the round at all, and every player's own `updates` document in this
 * room is readable by everyone else in it (`allow read: if signedIn()` in
 * the security rules is room-wide, not per-recipient). So the word is not
 * cryptographically hidden from a player willing to open devtools and read
 * the raw document — only from the interface, which never renders it before
 * the round reveals it. The same trade-off this platform already makes for a
 * hangman word list, just with a human typing the secret instead of a seed
 * picking it.
 */

export interface StartPacket {
  t: 'start';
  n: number;
  /** Seeds bot word choices and bot timing. */
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
  /** Which round this is for — a late packet for a finished round is dropped. */
  rd: number;
  /** How many actions this round had already seen. The host's guard against a double-send. */
  at: number;
  a: Action;
}

/**
 * The host publishing the match so far.
 *
 * Every round's actions, every time. A whole match is a handful of words'
 * worth of small objects, so the complete history is well under a Firestore
 * document and a player who reloads, joins late or sleeps their phone
 * receives the entire game on the very next write and replays it.
 */
export interface StatePacket {
  t: 'state';
  n: number;
  s: number;
  /** Every round's actions, oldest round first, flattened by `packHistory` — see there for why. */
  h: Action[];
  /** How many actions each round in `h` occupies. */
  hc: number[];
  /** The host's rules, stamped on every write so a late joiner can still build the match. */
  r?: number;
  /** The seed, stamped for the same reason. */
  seed?: number;
}

/** Sent on the way out, so a seat is taken over by a bot rather than stalling the round. */
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
