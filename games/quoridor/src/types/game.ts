import type { PlayerCount } from '../game/rules';

export type { PlayerCount };

/**
 * Who is driving a seat.
 *
 * `local` is played on this device, `remote` arrives over the wire, `ai` is a
 * bot. A seat flips from `remote` to `ai` when somebody leaves, and nothing
 * else in the engine has to care.
 */
export type Control = 'local' | 'remote' | 'ai';

/** What the board is waiting for. `over` is the only one that never leaves. */
export type Phase = 'play' | 'moving' | 'over';

/**
 * Preferences that belong to this device and nobody else.
 *
 * Anything that changes how the game actually plays lives in MatchRules
 * instead. The split matters online: both clients replay the same move list,
 * so a rule one of them disagreed about is two different boards — while the
 * volume, or whether this player wants the legal squares lit up, is nobody
 * else's business.
 */
export interface GameSettings {
  sfxVolume: number;
  /** Light up the squares the current pawn may step to. */
  hints: boolean;
}

/**
 * How this game is played, set by the host and obeyed by everyone.
 *
 * These reach a guest over the wire before its board is built (see
 * `packRules`), because a guest that laid out its own idea of the game would
 * seat the pawns differently and reject every move that arrived.
 */
export interface MatchRules {
  players: PlayerCount;
  /**
   * Fire a move off on its own after thirty seconds.
   *
   * The auto-move is a step along the pawn's own shortest route, never a wall:
   * a clock should not spend somebody's walls for them.
   */
  turnTimer: boolean;
  /**
   * Four players as two pairs rather than a free-for-all.
   *
   * Only meaningful at four. The pairs are the seats that share a turn parity
   * -- south with west, north with east -- which is what makes the turn order
   * alternate between the two sides rather than giving one pair two moves in a
   * row. It also means partners are never racing at each other's goal line, so
   * a wall that helps one of them rarely hurts the other.
   *
   * Either partner reaching their own far side takes it for both.
   */
  teams: boolean;
}

export const DEFAULT_RULES: MatchRules = {
  players: 2,
  turnTimer: false,
  teams: false,
};

export const TURN_SECONDS = 30;

const PLAYER_CODES: PlayerCount[] = [2, 4];

/**
 * The rules as one integer.
 *
 * TurnLink stamps a flat `Record<string, number>` onto every packet a client
 * writes, so a guest arriving after the first move still learns the game's
 * terms from whatever move happens to be in the document. Packing the rules
 * into a single number is what lets them ride along in that slot.
 */
export function packRules(rules: MatchRules): number {
  return (
    Math.max(0, PLAYER_CODES.indexOf(rules.players)) |
    (rules.turnTimer ? 2 : 0) |
    (rules.teams ? 4 : 0)
  );
}

export function unpackRules(bits: number | undefined): MatchRules {
  if (typeof bits !== 'number' || !Number.isFinite(bits)) return DEFAULT_RULES;
  return {
    players: PLAYER_CODES[bits & 1] ?? DEFAULT_RULES.players,
    turnTimer: (bits & 2) !== 0,
    teams: (bits & 4) !== 0,
  };
}

/**
 * The whole wire protocol.
 *
 * A board game does not need a 20Hz mesh. One move is one document write, so
 * this game exchanges turns through the lobby's `updates/{uid}` collection and
 * never opens a peer connection at all: no STUN, no NAT traversal, no
 * "connecting…" that never resolves on a restrictive network.
 */
export interface StartPacket {
  t: 'start';
  n: number;
  /**
   * Identifies the game, not the layout.
   *
   * Quoridor sets up the same way every time — there is nothing to randomise
   * but who goes first. The number is here so a document left behind by last
   * night's game is obviously stale rather than replayable, and so a rematch
   * is a different game rather than a longer one.
   */
  seed: number;
  /** Which seat moves first, drawn by the host. */
  first: number;
  /** The host's rules, packed by `packRules`. */
  r: number;
}

/**
 * The game so far, as the sender knows it.
 *
 * Sending the whole move list rather than just the new move is the one design
 * decision in this file worth defending. A Quoridor game is at most a couple
 * of hundred moves and each one is a number under 209, so the entire history
 * is well under a kilobyte and occupies exactly one Firestore field. In
 * exchange, every problem an incremental protocol has simply does not arise:
 * a player who reloads, joins late, sleeps their phone, or misses a snapshot
 * receives the complete game on the very next move and replays it. There is no
 * resync path because there is nothing to resync.
 */
export interface MovePacket {
  t: 'move';
  n: number;
  /** The game this history belongs to. A mismatch means a stale document. */
  s: number;
  /** Every move played, in order, encoded by `encodeStep` / `encodeWall`. */
  h: number[];
  /**
   * Who moved first, stamped onto every write once this client knows it.
   *
   * A player's update document is *replaced* by each write, so the moment
   * anybody moves, the start packet is gone. A guest that subscribed a second
   * later would find a move list where the negotiation should have been and
   * sit on "waiting for the host" for the rest of the game.
   */
  first?: number;
  /** The host's rules, packed by `packRules`. Travels with `first`, for the same reason. */
  r?: number;
}

/**
 * Sent on the way out, so a seat is taken over rather than abandoned.
 *
 * Carries the match seed for the same reason a turn does, and for a bug that
 * was much harder to see: a player's update document survives the match that
 * wrote it, and the last thing a departing player writes is this. On the next
 * match each client clears its *own* document before subscribing, but it
 * cannot clear anyone else's -- so whichever client opened its listener first
 * read the other's leftover farewell as a live one and handed a perfectly
 * present player's seat to a bot before the first move. Stamping the seed
 * makes a dead `bye` obvious instead of obeyable.
 */
export interface ByePacket {
  t: 'bye';
  n: number;
  /** The match this farewell belongs to. Absent on a packet from an older build. */
  s?: number;
}

/** Written on arrival to clear whatever the last game left in the document. */
export interface IdlePacket {
  t: 'idle';
  n: number;
}

/**
 * Sent once, right after a guest's link opens, so a pawn handed to a bot by a
 * `bye` is handed back the moment its player actually returns.
 *
 * `bye` was one-way: nothing ever told the board its owner was back, so a
 * player who reloaded, or who stepped out to the lobby and came back, spent
 * the rest of the game watching a bot move their pawn with no way to take it.
 */
export interface HelloPacket {
  t: 'hello';
  n: number;
}

export type NetPacket = StartPacket | MovePacket | ByePacket | HelloPacket | IdlePacket;
