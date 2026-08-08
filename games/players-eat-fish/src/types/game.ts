export interface Vector2D {
  x: number;
  y: number;
}

export type FishKind = 'player' | 'enemy' | 'boss';

/** One fish in the simulation. Flat numbers throughout — this is the hot path. */
export interface Fish {
  id: string;
  kind: FishKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Collision radius, and the currency of the whole game. */
  size: number;
  score: number;
  asset: number;
  angle: number;
  dead: boolean;
  name?: string;
  /** performance.now() when it entered the world — drives spawn protection. */
  bornAt: number;
  /** Cruise speed multiplier, so a shoal doesn't move as one rigid block. */
  pace: number;
  /**
   * Where this fish is currently trying to go, and how long until it picks
   * somewhere new. A heading held for a few seconds is what makes a fish look
   * like it is swimming *somewhere*. Steering by a pair of sine waves — which
   * is what this used to do — traces a closed loop, and thirty fish each
   * tracing their own loop is exactly the "just circling around" that was
   * reported.
   */
  heading: number;
  turnIn: number;
  /** Members of a shoal share this. Solitary fish have none. */
  shoal?: number;
  /** Fades the boss in and out. */
  opacity?: number;
  /** Set on fish driven by the network: where they claim to be heading. */
  net?: { x: number; y: number; vx: number; vy: number; at: number };
}

export interface GameSettings {
  bgmVolume: number;
  sfxVolume: number;
  /** 0 = WASD first, 1 = arrows first, 2 = IJKL first. Only matters for local co-op. */
  controlScheme: number;
}

/** What a player broadcasts about itself, as a compact array. */
export type PlayerPacket = [
  x: number,
  y: number,
  vx: number,
  vy: number,
  size: number,
  score: number,
  asset: number,
  angle: number,
  dead: 0 | 1,
];

/** What the host broadcasts about one AI fish. */
export type EnemyPacket = [
  id: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  size: number,
  asset: number,
];

export type NetMessage =
  | { t: 'p'; d: PlayerPacket; n: number }
  | { t: 'e'; d: EnemyPacket[]; b: EnemyPacket | null; n: number }
  | { t: 'x'; id: number }
  | { t: 'k'; ids: number[] }
  | { t: 'd'; by: string; size: number };
