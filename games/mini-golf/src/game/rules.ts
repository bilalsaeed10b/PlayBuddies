/**
 * Every number the game turns on, and the words it uses for a finished hole.
 *
 * Nothing here touches React, a canvas or the network. The engine, the bot and
 * the course generator all read the same constants, which is what stops a
 * "that felt different" bug from ever being a real one.
 */

/** World units. A course is laid out in these and fitted to the canvas at draw time. */
export const BALL_R = 1.6;
export const HOLE_R = 3.3;

export const PHYSICS = {
  /** Muzzle speed at full pull, in units per second. */
  MAX_SPEED: 190,
  /** Below a tenth of full pull the gesture was almost certainly a look, not a shot. */
  MIN_POWER: 0.08,
  /**
   * Friction as an exponential decay constant per surface: v *= e^(-k·dt).
   *
   * Chosen so the carry from a full swing (MAX_SPEED / k) is about 140 units
   * on the green — a shade less than the widest course, so crossing one in a
   * single putt is possible but never automatic.
   */
  K_GREEN: 1.35,
  K_ROUGH: 2.7,
  K_SAND: 5.6,
  /** Under this it has stopped, and holding on to the last hundredth of a unit per second just delays the turn. */
  STOP: 3,
  /** How much speed survives a wall. */
  BOUNCE: 0.72,
  /** A block is a touch deader than the outer wall, so banking off scenery costs something. */
  BOUNCE_BLOCK: 0.62,
  /**
   * Fast enough and the ball rides straight over the cup.
   *
   * Without this a hole is a magnet: any line through it drops, and power
   * stops mattering at all. With it, a screamer lips out — which is the shot
   * everyone remembers.
   *
   * Tuned down hard from where it started. At a third of full speed a ball
   * still dropped, which meant getting the line right was the whole game and a
   * perfect player aced better than half the holes it saw. At a fifth, the
   * ball has to be dying as it arrives — so line and weight are two separate
   * skills, which is what putting actually is.
   */
  CAPTURE_SPEED: 42,
  /** The rim robs a lipped-out ball of this much speed on the way past. */
  LIP_DAMP: 0.55,
  /** Physics runs on this fixed step regardless of frame rate. */
  STEP: 1 / 240,
  /** A shot that has not settled by now is stopped where it stands. Guards against a stuck ball. */
  MAX_FLIGHT: 12,
} as const;

/** One seat's colour, for its ball, its ring and its row on the card. */
export interface Palette {
  name: string;
  main: string;
  light: string;
  dark: string;
}

export const SEATS: readonly Palette[] = [
  { name: 'Red', main: '#ef4444', light: '#fca5a5', dark: '#b91c1c' },
  { name: 'Blue', main: '#3b82f6', light: '#93c5fd', dark: '#1d4ed8' },
  { name: 'Amber', main: '#f59e0b', light: '#fcd34d', dark: '#b45309' },
  { name: 'Violet', main: '#a855f7', light: '#d8b4fe', dark: '#7e22ce' },
];

export const TURF = {
  green: '#3f9c4f',
  greenAlt: '#37904a',
  fringe: '#2f7a3d',
  rough: '#276334',
  edge: '#1b4526',
  sand: '#e6cf9c',
  sandDark: '#cbb079',
  water: '#2f7fb5',
  waterLight: '#57a6d8',
  block: '#5b4636',
  blockTop: '#7a6049',
  cup: '#10261a',
} as const;

/** How many players a round seats. Four is the most a small green stays readable with. */
export type PlayerCount = 1 | 2 | 3 | 4;
/** How long a round runs. */
export type HoleCount = 1 | 3 | 6;

/**
 * Strokes at which a hole is written off.
 *
 * Somebody who has ricocheted around a pond nine times is not enjoying
 * themselves, and everybody else is watching them do it. The ball is picked up
 * at par + this, scored, and the round moves on.
 */
export const PICKUP_OVER_PAR = 6;

export const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

/**
 * The name of a score, which is most of the reason to play a hole out.
 *
 * Golf has had a word for every result for two hundred years and they are all
 * better than a number. `null` for the ones with no name — nobody has ever
 * been pleased enough about a quintuple bogey to have coined one.
 */
export function scoreName(strokes: number, par: number): { label: string; tone: 'great' | 'good' | 'even' | 'bad' } {
  if (strokes === 1) return { label: 'HOLE IN ONE!', tone: 'great' };
  const rel = strokes - par;
  if (rel <= -3) return { label: 'ALBATROSS!', tone: 'great' };
  if (rel === -2) return { label: 'EAGLE!', tone: 'great' };
  if (rel === -1) return { label: 'BIRDIE', tone: 'good' };
  if (rel === 0) return { label: 'PAR', tone: 'even' };
  if (rel === 1) return { label: 'BOGEY', tone: 'bad' };
  if (rel === 2) return { label: 'DOUBLE BOGEY', tone: 'bad' };
  if (rel === 3) return { label: 'TRIPLE BOGEY', tone: 'bad' };
  return { label: `+${rel}`, tone: 'bad' };
}

/** How a total reads against the round's par: "-2", "E", "+5". */
export function relativeToPar(strokes: number, par: number): string {
  const rel = strokes - par;
  if (rel === 0) return 'E';
  return rel > 0 ? `+${rel}` : String(rel);
}

/**
 * The things the course shouts at you between shots.
 *
 * Deliberately separate from `scoreName`: those are the record, these are
 * commentary, and they fire on what the ball just did rather than on what the
 * card says.
 */
export type Shout =
  | 'splash'
  | 'bunker'
  | 'rough'
  | 'wall'
  | 'close'
  | 'lip'
  | 'gimme'
  | 'strong'
  | 'tap';

export const SHOUTS: Record<Shout, { label: string; tone: 'great' | 'good' | 'even' | 'bad' }> = {
  splash: { label: 'IN THE DRINK!', tone: 'bad' },
  bunker: { label: 'BUNKERED', tone: 'bad' },
  rough: { label: 'IN THE ROUGH', tone: 'even' },
  wall: { label: 'OFF THE BOARDS', tone: 'even' },
  close: { label: 'SO CLOSE', tone: 'good' },
  lip: { label: 'LIPPED OUT!', tone: 'bad' },
  gimme: { label: 'THAT IS A GIMME', tone: 'good' },
  strong: { label: 'TOO MUCH CLUB', tone: 'even' },
  tap: { label: 'LEFT IT SHORT', tone: 'even' },
};
