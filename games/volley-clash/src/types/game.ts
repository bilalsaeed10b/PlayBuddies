export interface Vector2D {
  x: number;
  y: number;
}

/** 0 is the left side of the court, 1 is the right. Never anything else. */
export type Team = 0 | 1;

export type Phase = 'serve' | 'rally' | 'point' | 'over';

export type PowerKind = 'rocket' | 'feather' | 'giant' | 'freeze';

/**
 * Who is driving a character.
 *
 * `local` seats read the keyboard or the touch controls on this device;
 * `remote` seats are fed by input packets; `ai` seats are simulated. A seat can
 * change from `remote` to `ai` mid-match when someone drops out, and nothing
 * else in the engine has to care.
 */
export type Control = 'local' | 'remote' | 'ai';

/**
 * Move, jump, dash. That is the whole game.
 *
 * There used to be a fourth: hold to charge a power shot, on the space bar. It
 * is gone. A charge meter turns every contact into "did I hold it long enough"
 * rather than "did I get under the ball", and on a touchscreen it had no honest
 * mapping at all. Contact and position decide the shot now, which is what the
 * game was always actually about.
 */
export interface Input {
  left: boolean;
  right: boolean;
  jump: boolean;
  dash: boolean;
}

export const NO_INPUT: Input = { left: false, right: false, jump: false, dash: false };

/** Inputs go over the wire as one byte. Four booleans do not deserve JSON. */
export function packInput(i: Input): number {
  return (i.left ? 1 : 0) | (i.right ? 2 : 0) | (i.jump ? 4 : 0) | (i.dash ? 8 : 0);
}

export function unpackInput(b: number): Input {
  return {
    left: (b & 1) !== 0,
    right: (b & 2) !== 0,
    jump: (b & 4) !== 0,
    dash: (b & 8) !== 0,
  };
}

/** One character on the court. Flat numbers — this is stepped 120 times a second. */
export interface Player {
  id: string;
  team: Team;
  name: string;
  /** Index into CHARACTERS. Fixed for the whole match. */
  character: number;
  control: Control;
  /** Only meaningful when control is 'ai'. 0 rookie, 1 pro, 2 legend. */
  aiLevel: number;

  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Body radius. Grows while the Giant power-up is up, so it is not a constant. */
  r: number;
  facing: 1 | -1;

  onGround: boolean;
  /** Seconds the jump has been held, or -1 once the boost window is spent. */
  jumpHeld: number;
  /** Remaining dash time; > 0 means the dash is driving the velocity. */
  dashLeft: number;
  dashCd: number;
  airDashUsed: boolean;
  /** Blocks a second contact for a moment, so the ball can't stick to a body. */
  hitCd: number;

  /** Scratch space for the AI. Untouched for human seats. */
  brain: Brain;
}

export interface Brain {
  /** Where the AI currently believes the ball will come down. */
  targetX: number;
  /** Counts down; the AI only re-reads the world when it hits zero. */
  thinkIn: number;
  /** True when this AI has been assigned the ball in a 2v2. */
  claimed: boolean;
  wantJump: boolean;
  wantDash: boolean;
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Positive spins the flight one way, negative the other. Decays over time. */
  spin: number;
  /** Team of whoever touched it last, or null off a serve. Decides power-up ownership. */
  lastTeam: Team | null;
  /** Player id of the last toucher, for the "ACE" call. */
  lastHitter: string | null;
}

export interface ActivePower {
  kind: PowerKind;
  /** Whose ball it was when it was collected. */
  team: Team;
  /** Seconds left. Rocket sits at Infinity until it is spent. */
  left: number;
}

export interface FloatingPower {
  kind: PowerKind;
  x: number;
  y: number;
  vy: number;
  spin: number;
}

export interface GameSettings {
  bgmVolume: number;
  sfxVolume: number;
  /** 0 = player one on WASD, 1 = player one on the arrows. */
  controlScheme: number;
  /** Points needed to win: 5, 7 or 11. */
  targetPoints: number;
  powerUps: boolean;
}

/** One character's state on the wire. Order matters — see MatchEngine.snapshot. */
export type PlayerPacket = [
  x: number,
  y: number,
  vx: number,
  vy: number,
  r: number,
  flags: number,
];

export type BallPacket = [x: number, y: number, vx: number, vy: number, spin: number];

export type PowerPacket = [kind: PowerKind, team: Team, left: number];

export type FloatPacket = [kind: PowerKind, x: number, y: number];

/** Host → everyone, 20 times a second. */
export interface Snapshot {
  t: 's';
  n: number;
  b: BallPacket;
  /** Keyed by player id so a seat re-order can never scramble the court. */
  p: Record<string, PlayerPacket>;
  sc: [number, number];
  ph: Phase;
  /** Seconds left on the current phase, for the serve countdown. */
  tm: number;
  pw: PowerPacket[];
  fl: FloatPacket[];
  /** Serving team, so a late joiner draws the ball on the right side. */
  sv: Team;
}

export type NetMessage =
  | Snapshot
  /** Client → host: input bitmask plus a sequence number. */
  | { t: 'i'; d: number; n: number }
  /** Host → everyone: a point was scored, with the shout to display. */
  | { t: 'pt'; team: Team; sc: [number, number]; call: string }
  /** Anyone → everyone: I am leaving, hand my seat to the AI. */
  | { t: 'bye'; id: string };
