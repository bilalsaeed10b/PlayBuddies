import type { HoleCount, PlayerCount } from '../game/rules';

export type { HoleCount, PlayerCount };

/**
 * Who is playing a ball.
 *
 * `local` is putted on this device, `remote` arrives over the wire, `ai` is a
 * bot. A seat flips from `remote` to `ai` when somebody leaves, and nothing
 * else in the engine has to care.
 */
export type Control = 'local' | 'remote' | 'ai';

/** What the green is waiting for. */
export type Phase = 'aim' | 'rolling' | 'holeOver' | 'over';

/**
 * Preferences that belong to this device and nobody else.
 *
 * Anything that changes how the round actually plays lives in MatchRules
 * instead. The split matters online: everybody has to be on the same course
 * with the same par, while how loud it is here is nobody else's business.
 */
export interface GameSettings {
  sfxVolume: number;
  /** The big HOLE IN ONE! / BUNKERED text over the green. */
  shouts: boolean;
}

/**
 * How this round is played, set by the host and obeyed by everyone.
 *
 * These reach a guest over the wire before its first course is built (see
 * `packRules`), because a guest that generated its own idea of the round would
 * be putting at a different flag on a differently shaped green.
 */
export interface MatchRules {
  /** Balls on the green. Anyone in the room past this watches. */
  players: PlayerCount;
  holes: HoleCount;
  /** Ponds and bunkers. Off leaves the blocks, which are what make banking work. */
  hazards: boolean;
  /** Putt automatically after twenty seconds, straight at the flag at a sane weight. */
  turnTimer: boolean;
}

export const DEFAULT_RULES: MatchRules = {
  players: 2,
  holes: 3,
  hazards: true,
  turnTimer: false,
};

export const TURN_SECONDS = 20;

const PLAYER_CODES: PlayerCount[] = [1, 2, 3, 4];
const HOLE_CODES: HoleCount[] = [1, 3, 6];

/**
 * The rules as one integer.
 *
 * TurnLink stamps a flat `Record<string, number>` onto every packet a client
 * writes, so a guest arriving after the first putt still learns the round's
 * terms from whatever shot happens to be sitting in the document. Packing the
 * rules into a single number is what lets them ride along in that slot.
 */
export function packRules(rules: MatchRules): number {
  return (
    Math.max(0, PLAYER_CODES.indexOf(rules.players)) |
    (Math.max(0, HOLE_CODES.indexOf(rules.holes)) << 2) |
    (rules.hazards ? 16 : 0) |
    (rules.turnTimer ? 32 : 0)
  );
}

export function unpackRules(bits: number | undefined): MatchRules {
  if (typeof bits !== 'number' || !Number.isFinite(bits)) return DEFAULT_RULES;
  return {
    players: PLAYER_CODES[bits & 3] ?? DEFAULT_RULES.players,
    holes: HOLE_CODES[(bits >> 2) & 3] ?? DEFAULT_RULES.holes,
    hazards: (bits & 16) !== 0,
    turnTimer: (bits & 32) !== 0,
  };
}

/**
 * The whole wire protocol.
 *
 * Golf is turn-based, so there is no mesh: one putt is one document write and
 * a whole round is a few dozen of them. Turns travel through the lobby's
 * `updates/{uid}` collection and no peer connection is opened at all — no
 * STUN, no NAT traversal, no "connecting…" that never resolves behind a
 * corporate proxy.
 */
export interface StartPacket {
  t: 'start';
  n: number;
  /** Builds every course in the round. The entire layout negotiation, in one integer. */
  seed: number;
  /** Which seat tees off on hole one. Drawn by the host. */
  first: number;
  /** The host's rules, packed by `packRules`. */
  r: number;
}

/**
 * Sent the instant the club meets the ball — before it has stopped, before
 * anybody knows where it finishes.
 *
 * The ShotPacket below is only written once a putt has fully settled, and on a
 * long green that is three or four seconds. Without this, the far side saw
 * nothing at all until the ball had already stopped *and* that had crossed the
 * network, and only then began its own replay — so a three-second putt took
 * six seconds to appear. This carries the input alone, so every screen starts
 * rolling together, off by latency and nothing else.
 */
export interface FirePacket {
  t: 'fire';
  n: number;
  s: number;
  /** Hole index, so a preview for a hole this client has left is ignored rather than replayed. */
  hl: number;
  /** Which seat swung. */
  b: number;
  a: number;
  p: number;
  first?: number;
  r?: number;
}

/**
 * A settled putt: what was struck, and the green it left behind.
 *
 * The player who took the shot is authoritative for it. Rather than have every
 * client re-run the physics and pray that `Math.exp` agrees to the last bit,
 * the shooter states where every ball ended up and the receivers snap to it
 * once their own replay has finished playing out. The two sides only ever have
 * to agree on the picture, never on a float.
 */
export interface ShotPacket {
  t: 'shot';
  n: number;
  /**
   * The round this putt belongs to.
   *
   * A player's update document survives the round that wrote it, so the first
   * snapshot after subscribing can be last night's last putt. Stamping the
   * seed makes a stale turn obvious instead of replayable.
   */
  s: number;
  /** Which hole of the round. A client still on the previous one jumps forward. */
  hl: number;
  b: number;
  a: number;
  p: number;
  /** Resting position of every ball, in engine order. */
  x: number[];
  y: number[];
  /** Strokes taken on this hole, per ball. */
  k: number[];
  /** 1 for a ball that is holed or picked up, 0 for one still in play. */
  f: number[];
  /**
   * Strokes on every *completed* hole, per ball.
   *
   * Carried so the running total is right for somebody who joined at hole
   * three and never saw holes one and two. Their card has gaps; their score
   * does not, and the score is the part that decides who won.
   */
  tot: number[];
  /** Which seat plays next. -1 when the hole is finished. */
  o: number;
  /**
   * Who teed off first, stamped by the host onto every turn it sends.
   *
   * A player's update document is *replaced* by each write, so the moment the
   * host putts, the start packet it wrote is gone. A guest that subscribed a
   * second later — a slow phone, a reconnect, a reload — would find a turn
   * where the negotiation should have been and sit on "waiting for the host"
   * for the rest of the round.
   */
  first?: number;
  /** The host's rules, packed by `packRules`. Travels with `first`, for the same reason. */
  r?: number;
}

/** Sent on the way out, so a ball is taken over by a bot rather than abandoned. */
export interface ByePacket {
  t: 'bye';
  n: number;
}

/**
 * Sent once, right after a guest's link opens, so a ball handed to a bot by a
 * `bye` gets handed back the moment its player actually returns — reload,
 * reopened tab, whatever the drop was. `bye` used to be one-way: nothing ever
 * told the round the seat's owner was back, so a reconnected player stayed a
 * spectator on a bot for the rest of it.
 */
export interface HelloPacket {
  t: 'hello';
  n: number;
}

/** Written on arrival to clear whatever the last round left in the document. */
export interface IdlePacket {
  t: 'idle';
  n: number;
}

export type NetPacket = StartPacket | FirePacket | ShotPacket | ByePacket | HelloPacket | IdlePacket;
