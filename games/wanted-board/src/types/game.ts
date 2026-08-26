import type { CardId, PlayerCount } from '../game/rules';
import { CARD_ORDER } from '../game/rules';

export type { PlayerCount };

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
 * `choosing` is the only phase a player does anything in; `reveal` is the
 * animation that pays it off, and it is deliberately a real phase rather than
 * a CSS flourish — everybody watches the same cards flip in the same order,
 * and nobody can act during it.
 */
export type Phase = 'choosing' | 'reveal' | 'over';

/** Preferences that belong to this device and nobody else. */
export interface GameSettings {
  sfxVolume: number;
  /** Spell out what each card does on the card itself, rather than only in the rules panel. */
  hints: boolean;
}

/**
 * How this game is played, set by the host and obeyed by everyone.
 *
 * These reach a guest over the wire before its town is built (see `packRules`),
 * because a guest that laid out its own idea of the game would seat people in
 * different places and reject every round that arrived.
 */
export interface MatchRules {
  players: PlayerCount;
  /** Lock a card in for anyone still deciding after ROUND_SECONDS. */
  roundTimer: boolean;
  /** How much banked money ends it. Index into TARGET_CHOICES. */
  target: number;
}

export const TARGET_CHOICES = [600, 1000, 1500];

/**
 * `target: 0` — $600 — on purpose.
 *
 * Simulated bot tables bank somewhere around $750 for a winner at the middle
 * rank, so $600 is a post most games actually reach and a few reach early,
 * which is what makes the last two rounds a race rather than an arithmetic
 * check. At $1000 the top rank essentially never got there and every game
 * ended on the round limit with a shrug.
 */
export const DEFAULT_RULES: MatchRules = {
  players: 2,
  roundTimer: true,
  target: 0,
};

const PLAYER_CODES: PlayerCount[] = [2, 3, 4];

/**
 * The rules as one integer.
 *
 * TurnLink stamps a flat `Record<string, number>` onto every packet a client
 * writes, so a guest arriving after the first round still learns the game's
 * terms from whatever packet happens to be in the document. Packing the rules
 * into a single number is what lets them ride along in that slot.
 */
export function packRules(rules: MatchRules): number {
  const players = Math.max(0, PLAYER_CODES.indexOf(rules.players));
  const target = Math.max(0, Math.min(TARGET_CHOICES.length - 1, rules.target));
  return players | (rules.roundTimer ? 4 : 0) | (target << 3);
}

export function unpackRules(bits: number | undefined): MatchRules {
  if (typeof bits !== 'number' || !Number.isFinite(bits)) return DEFAULT_RULES;
  return {
    players: PLAYER_CODES[bits & 3] ?? DEFAULT_RULES.players,
    roundTimer: (bits & 4) !== 0,
    target: (bits >> 3) & 3,
  };
}

// ── one player's decision for one round ────────────────────────────────────

export interface Choice {
  card: CardId;
  /** Where the card points. Meaningless for cards whose `needsTarget` is false. */
  target: number;
}

/**
 * A choice as one small integer, so a whole game fits in one Firestore field.
 *
 * Five cards and six places means everything below 40; packing the card into
 * the high bits and the place into the low three keeps both readable in a log.
 */
export function encodeChoice(choice: Choice): number {
  return (Math.max(0, CARD_ORDER.indexOf(choice.card)) << 3) | (choice.target & 7);
}

export function decodeChoice(code: number): Choice {
  return {
    card: CARD_ORDER[(code >> 3) % CARD_ORDER.length] ?? 'layLow',
    target: code & 7,
  };
}

/** One resolved round: every seat's choice, in seat order. */
export type EncodedRound = number[];

// ── the wire ───────────────────────────────────────────────────────────────

/**
 * The whole protocol.
 *
 * Simultaneous play turns out to be *easier* to put on a wire than alternating
 * turns, not harder — but only if exactly one client is allowed to decide when
 * a round is over. So the host does: guests publish their own choice and
 * nothing else, the host resolves, and the host's history is the game. A guest
 * never computes a resolution, so there is no arithmetic for two clients to
 * disagree about, and no reconciliation path to get wrong.
 */

export interface StartPacket {
  t: 'start';
  n: number;
  /** Seeds the opening layout and every bot decision after it. */
  seed: number;
  /** The host's rules, packed by `packRules`. */
  r: number;
}

/** A guest telling the host what it wants to do this round. */
export interface PickPacket {
  t: 'pick';
  n: number;
  /** The game this belongs to. A mismatch means a document left over from last night. */
  s: number;
  /** Which round this is a choice for — a late packet for a finished round is dropped. */
  rd: number;
  /** The choice itself, by `encodeChoice`. */
  c: number;
}

/**
 * The host publishing the game so far.
 *
 * Sending the entire history rather than just the new round is the one design
 * decision here worth defending, and it is the same one Quoridor makes: a
 * whole game is at most a dozen rounds of four small integers, so the complete
 * history is a few hundred bytes and occupies exactly one Firestore field. In
 * exchange, every problem an incremental protocol has simply does not arise. A
 * player who reloads, joins late, or sleeps their phone receives the complete
 * game on the very next round and replays it. There is no resync path because
 * there is nothing to resync.
 */
export interface RoundPacket {
  t: 'round';
  n: number;
  s: number;
  /** Every resolved round, in order. */
  h: EncodedRound[];
  /**
   * Which seats have locked a card in for the round now in progress, as a bit
   * per seat. Pure UI: it drives "waiting on two players" without anybody
   * learning *what* was chosen, which is the one thing that must stay secret
   * until the reveal.
   */
  lk: number;
  /** The host's rules, stamped onto every write so a late joiner can still build the game. */
  r?: number;
  /** The seed, stamped for the same reason. */
  seed?: number;
}

/** Sent on the way out, so a seat is taken over by a bot rather than stalling the round. */
export interface ByePacket {
  t: 'bye';
  n: number;
}

/** Written on arrival to clear whatever the last game left in the document. */
export interface IdlePacket {
  t: 'idle';
  n: number;
}

export type NetPacket = StartPacket | PickPacket | RoundPacket | ByePacket | IdlePacket;
