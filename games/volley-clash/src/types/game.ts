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
  /**
   * Pin the renderer to its cheapest tier instead of letting it measure.
   *
   * The governor finds this on its own within a second of play; this is for
   * the player who would rather not watch it happen every time.
   */
  lowPower: boolean;
  /** 0 = player one on WASD, 1 = player one on the arrows. */
  controlScheme: number;
  /** Points needed to win: 5, 7 or 11. */
  targetPoints: number;
  /**
   * Require a two-point lead to take the match.
   *
   * Off by default: "First to 7" should mean first to 7. With this on, 7-6 is
   * not a win and play continues until someone is two clear — the volleyball
   * rule, kept as an option for anyone who wants it.
   */
  winByTwo: boolean;
  powerUps: boolean;
  /**
   * How often power-ups drop, as a multiplier on the base interval. 1 is the
   * stock pace; 2 is twice as often; 0.5 is half.
   */
  powerRate: number;
}

/** One character's state on the wire. Order matters — see MatchEngine.snapshot. */
export type PlayerPacket = [
  x: number,
  y: number,
  vx: number,
  vy: number,
  r: number,
  flags: number,
  /**
   * What that character is pressing, as packInput.
   *
   * Four bytes that buy more than any amount of smoothing: with them a guest
   * runs everyone else through the real movement code instead of coasting them
   * along their last known velocity, so a player who stops, turns or jumps is
   * seen doing it rather than seen sliding until the next packet says otherwise.
   */
  input: number,
];

export type BallPacket = [x: number, y: number, vx: number, vy: number, spin: number];

/**
 * One body, as its *owner* sees it.
 *
 * Same six numbers as a PlayerPacket, and deliberately so: a guest describes
 * itself to the host in exactly the language the host describes everyone in.
 */
export type BodyPacket = PlayerPacket;

/** Bit positions inside the flags byte of a PlayerPacket / BodyPacket. */
export const F_GROUND = 1;
export const F_FACING = 2;
export const F_DASH = 4;

export type PowerPacket = [kind: PowerKind, team: Team, left: number];

export type FloatPacket = [kind: PowerKind, x: number, y: number];

/** Host → everyone, SNAPSHOT_HZ times a second. */
export interface Snapshot {
  t: 's';
  n: number;
  /**
   * The host's clock when this was built, in ms.
   *
   * Not used as a clock — the two machines never agree on one. It is used as a
   * *stopwatch*: the receiver measures how long the packet spent in flight from
   * its own round-trip estimate and runs the contents forward by that much, so
   * what it draws is where the ball is now rather than where it was.
   */
  ts: number;
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

/**
 * Guest → host: where I am, what I am pressing, and when I said so.
 *
 * The body and the input travel together in one packet because the host needs
 * both: the body to place the character exactly, the input to keep simulating
 * it between packets instead of freezing it until the next one lands.
 */
export interface BodyMessage {
  t: 'b';
  /** The sender's own body. */
  d: BodyPacket;
  /** Input bitmask, as packInput. */
  i: number;
  /** Sender's clock in ms, for the same stopwatch trick as Snapshot.ts. */
  ts: number;
  /** Monotonic sequence. The channel is unordered, so stale packets are dropped. */
  n: number;
  /**
   * The last snapshot tick this sender had applied.
   *
   * How the host dates a claim without the two machines sharing a clock: a
   * body described before the court was reset is describing the last rally.
   */
  k: number;
}

export type NetMessage =
  | Snapshot
  | BodyMessage
  /** Client → host: input bitmask plus a sequence number. */
  | { t: 'i'; d: number; n: number }
  /**
   * Round-trip probe, and its echo. `n` is the prober's clock in ms, and `to`
   * is who the echo belongs to — the relay carries it to the whole room, and
   * only the machine that sent the probe can read that number as a time.
   */
  | { t: 'q'; n: number }
  | { t: 'a'; n: number; to: string }
  /** Host → everyone: a point was scored, with the shout to display. */
  | { t: 'pt'; team: Team; sc: [number, number]; call: string }
  /** Anyone → everyone: I am leaving, hand my seat to the AI. */
  | { t: 'bye'; id: string };
