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
  /** Team that fired it, so a hull can tell friendly fire from incoming. */
  team: Team;
  damage: number;
  blast: number;
  gravity: number;
  pierce: boolean;
  windproof: boolean;
  burn: number;
  alive: boolean;
  age: number;
  /**
   * False until the ball has cleared its own ship.
   *
   * The muzzle sits inside the hull's own hitbox, so without this every shot
   * detonated on the deck it was fired from. It flips the moment the ball is
   * outside both of its owner's boxes, which is also exactly when hitting
   * your own rigging on the way up should start counting.
   */
  armed: boolean;
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

export interface GameSettings {
  bgmVolume: number;
  sfxVolume: number;
  /** Draw the first stretch of the arc while aiming. Off is the harder game. */
  aimGuide: boolean;
  /** Fire automatically when the turn clock runs out. */
  turnTimer: boolean;
  /** Rocks in the water between the ships. */
  obstacles: boolean;
  /** Force the cheap render path regardless of what the device claims. */
  lowPower: boolean;
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
  /** HP of each ship once the shot resolved. */
  hp0: number;
  hp1: number;
  /** Burning turns left on each ship. */
  f0: number;
  f1: number;
  /** Wind for the next turn, and where the hulls drift to. */
  w: number;
  d0: number;
  d1: number;
  /** Whose turn it is next. Stated, never inferred. */
  o: Team;
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

export type NetPacket = StartPacket | ShotPacket | ByePacket | IdlePacket;
