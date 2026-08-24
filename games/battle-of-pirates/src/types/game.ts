import type { CardId } from '../game/rules';

/** 0 is the ship on the left, 1 is the ship on the right. Never anything else. */
export type Team = 0 | 1;

/**
 * Who is driving a ship.
 *
 * `local` is aimed on this device, `remote` arrives over the wire, `ai` is
 * simulated. A seat flips from `remote` to `ai` when someone drops out, and
 * nothing else in the engine has to care.
 */
export type Control = 'local' | 'remote' | 'ai';

/**
 * `aim` is the only phase that waits on a human. Everything else runs itself.
 *
 * `deal` exists so the hand can be turned face up with a beat before the
 * player is expected to act; without it the cards appeared already-dealt and
 * nobody noticed the hand had changed.
 */
export type Phase = 'deal' | 'aim' | 'flight' | 'impact' | 'over';

export interface Shot {
  /** Radians. 0 points right, negative is up. */
  angle: number;
  /** 0 to 1. Scaled to a muzzle speed by BALANCE. */
  power: number;
  card: CardId;
}

export interface Ship {
  team: Team;
  /**
   * This hull's rank in its own fleet, 0 being the one nearest the enemy.
   *
   * Together with `team` this picks the anchor out of `Arena.anchor`. A duel
   * only ever has slot 0 on each side; a 3v3 has slots 0, 1 and 2 strung back
   * from the front rank.
   */
  slot: number;
  id: string;
  name: string;
  control: Control;
  /** Only meaningful when control is 'ai'. 0 swab, 1 gunner, 2 captain. */
  aiLevel: number;
  /** Index into SHIPS. Cosmetic, always. */
  skin: number;
  hp: number;
  /** Where this hull would sit with no drift. */
  anchorX: number;
  x: number;
  /** Turns of fire left on the deck. */
  burn: number;
  /** Fixed offset so the two hulls never rock in lockstep. */
  bobPhase: number;
  /** Set on a hit, decays. Drives the white flash and the recoil lean. */
  flash: number;
  /** Recoil lean, radians. Decays back to level. */
  lean: number;
  /** Last shot this ship took, so the aim UI can open where it left off. */
  lastAim: { angle: number; power: number };
}

export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** Side that fired it, so a hull can tell friendly fire from incoming. */
  team: Team;
  /**
   * The ship that fired it.
   *
   * Distinct from `team` once a side has more than one hull: "don't detonate
   * on the deck you left" is about this ship, while "that one hurts less" is
   * about the side. In a duel the two questions had the same answer.
   */
  from: number;
  damage: number;
  blast: number;
  gravity: number;
  pierce: boolean;
  windproof: boolean;
  burn: number;
  alive: boolean;
  age: number;
  /** Ring buffer of past positions for the smoke trail. */
  trail: number[];
}

export interface Rock {
  x: number;
  y: number;
  r: number;
  /** Chipped away by hits; a rock that has taken enough shots crumbles. */
  hp: number;
  seed: number;
}

/**
 * Preferences that belong to this device and nobody else.
 *
 * Anything that changes how the battle actually plays out lives in MatchRules
 * below instead. The split matters: both clients simulate the same shot from
 * the same seed, so a rule one of them disagreed about is a desync, not a
 * preference — which is exactly what `obstacles` used to be when it lived
 * here. A host with rocks on and a guest with rocks off built two different
 * seas and every shot after the first landed somewhere else on each screen.
 */
export interface GameSettings {
  bgmVolume: number;
  sfxVolume: number;
  /** Force the cheap render path regardless of what the device claims. */
  lowPower: boolean;
}

/** Off entirely, crumbles after enough hits, or stands there all battle. */
export type MountainRule = 'off' | 'breakable' | 'solid';

/**
 * How many hulls take to the water, split evenly into two fleets.
 *
 * Always even, because the two sides have to match: 2 is the duel, 4 is two
 * a side, 6 is three. Anyone in the room beyond this count watches.
 */
export type PlayerCount = 2 | 4 | 6;

/**
 * How this battle is played, set by the host and obeyed by everyone.
 *
 * These reach the guest over the wire before its engine is built (see
 * `packRules`), so both sides deal the same hands, spawn the same mountain and
 * agree on whether a shot fires itself when the clock runs out.
 */
export interface MatchRules {
  /**
   * The dotted trajectory arc while aiming.
   *
   * Off by default now. With it on the shot solves itself — you drag until the
   * dots point at the enemy and let go — which is the whole game handed over.
   * The aim arrow on the pad is always there regardless; that shows direction
   * and power, not where the ball lands.
   */
  aimArc: boolean;
  /** Fire automatically when the turn clock runs out. */
  turnTimer: boolean;
  mountain: MountainRule;
  /** Cards. Off means every shot is a plain round shot and the hand is hidden. */
  cards: boolean;
  players: PlayerCount;
}

export const DEFAULT_RULES: MatchRules = {
  aimArc: false,
  turnTimer: true,
  mountain: 'breakable',
  cards: true,
  players: 2,
};

const MOUNTAIN_CODES: MountainRule[] = ['off', 'breakable', 'solid'];
const PLAYER_CODES: PlayerCount[] = [2, 4, 6];

/**
 * The rules as one integer.
 *
 * TurnLink stamps a flat `Record<string, number>` onto every packet the host
 * writes, so that a guest arriving after the opening shot still learns the
 * match's terms from whatever turn happens to be in the document. Packing the
 * rules into a single number is what lets them ride along in that same slot.
 */
export function packRules(rules: MatchRules): number {
  return (
    (rules.aimArc ? 1 : 0) |
    (rules.turnTimer ? 2 : 0) |
    (Math.max(0, MOUNTAIN_CODES.indexOf(rules.mountain)) << 2) |
    (rules.cards ? 16 : 0) |
    (Math.max(0, PLAYER_CODES.indexOf(rules.players)) << 5)
  );
}

export function unpackRules(bits: number | undefined): MatchRules {
  if (typeof bits !== 'number' || !Number.isFinite(bits)) return DEFAULT_RULES;
  return {
    aimArc: (bits & 1) !== 0,
    turnTimer: (bits & 2) !== 0,
    mountain: MOUNTAIN_CODES[(bits >> 2) & 3] ?? DEFAULT_RULES.mountain,
    cards: (bits & 16) !== 0,
    players: PLAYER_CODES[(bits >> 5) & 3] ?? DEFAULT_RULES.players,
  };
}

/**
 * The whole wire protocol.
 *
 * Turn-based play does not need a 20 Hz mesh. One shot is one document write,
 * so this game exchanges turns through the lobby's `updates/{uid}` collection
 * and never opens a peer connection at all: no STUN, no NAT traversal, no
 * "connecting..." that never resolves on a restrictive network. A whole match
 * costs about a dozen writes.
 */
export interface StartPacket {
  t: 'start';
  n: number;
  /**
   * Seeds every deal, every wind shift and every drift for the whole match.
   *
   * Nothing else about the opening needs sending: given the same seed, both
   * clients compute the same wind and the same starting positions in the
   * engine's constructor. This is the entire negotiation.
   */
  seed: number;
  /** Who fires first. Drawn at random by the host. */
  first: Team;
  /** The host's rules, packed by `packRules`. See ShotPacket.first for why it rides on every packet. */
  r?: number;
}

/**
 * Sent the instant a shot leaves the barrel -- before its outcome is known,
 * before the ball has even reached the top of its arc.
 *
 * A ShotPacket, below, used to be the only thing that ever went out, and it
 * is only written once a turn is fully resolved: the flight has landed, the
 * impact has settled, wind and drift have rolled for next turn. On a
 * screen-filling arena that whole sequence is two to four seconds, and the
 * far side never saw a single frame of it until all of that had already
 * happened *and* crossed the network -- their own replay of the shot then
 * started from scratch on top of that. A shot that took three seconds to
 * land took six to be seen fire at all, which is the "delay" in multiplayer.
 *
 * This carries only the input -- what was aimed, not what it did -- so the
 * far side can start animating in step with the shooter, off by network
 * latency alone. The ShotPacket still follows once the outcome is known and
 * is still what the receiver trusts for HP, wind and drift; this only lets
 * the picture start moving before that arrives.
 */
export interface FirePacket {
  t: 'fire';
  n: number;
  s: number;
  a: number;
  p: number;
  c: CardId;
  /** See ShotPacket.first -- carried here too so the earliest possible message can seed a late guest's session. */
  first?: Team;
  /** The host's rules, packed by `packRules`. Travels with `first`, for the same reason. */
  r?: number;
}

/**
 * A resolved turn: what was fired, and the state it left behind.
 *
 * The shooter is authoritative for its own shot. It carries the outcome rather
 * than leaving the receiver to re-derive it, because the two clients only have
 * to agree on the *picture* then, not on the last bit of a float. The receiver
 * replays the identical shot for the animation and takes these numbers as the
 * truth when the dust settles.
 */
export interface ShotPacket {
  t: 'shot';
  n: number;
  /**
   * The match seed this turn belongs to.
   *
   * A player's update document survives the match that wrote it, so the first
   * snapshot after subscribing can be last night's final shot. Stamping the
   * seed makes a stale turn obvious instead of replayable.
   */
  s: number;
  a: number;
  p: number;
  c: CardId;
  /**
   * The fleet as the shot left it, one entry per ship in engine order: hull,
   * burning turns left, and where it drifted to.
   *
   * These were `hp0`/`hp1`, `f0`/`f1`, `d0`/`d1` back when a battle was always
   * two ships. Arrays now, because it can be six.
   */
  hp: number[];
  f: number[];
  d: number[];
  /** Wind for the next turn. */
  w: number;
  /** Which ship fires next, by index. Stated, never inferred. */
  o: number;
  /**
   * Who fired first in this match, stamped by the host onto every turn it
   * sends.
   *
   * A player's update document is *replaced* by each write, so the moment the
   * host takes its opening shot, the start packet it wrote is gone. A guest
   * that subscribed a second later -- a slow phone, a reconnect, a reload --
   * found a turn where the negotiation should have been and sat on "waiting
   * for the host" for the rest of the match. With this, and the seed already
   * in `s`, a turn is a start packet too.
   *
   * Absent on the guest's own turns, which nobody needs it from.
   */
  first?: Team;
  /** The host's rules, packed by `packRules`. Travels with `first`, for the same reason. */
  r?: number;
}

/** Sent on the way out so the opponent's ship is taken over rather than abandoned. */
export interface ByePacket {
  t: 'bye';
  n: number;
}

/** Written on arrival to clear whatever the last match left in the document. */
export interface IdlePacket {
  t: 'idle';
  n: number;
}

export type NetPacket = StartPacket | FirePacket | ShotPacket | ByePacket | IdlePacket;
