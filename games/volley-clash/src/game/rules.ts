/**
 * Every number that decides how the game feels, in one file.
 *
 * The numbers here are the ones REQUIREMENTS.md quotes. If you change one,
 * change it there too — a spec that disagrees with the code is worse than no
 * spec at all.
 */

export type ArenaKind = 'standard' | 'wide';

export interface Arena {
  w: number;
  h: number;
  /** y of the sand surface. Everything stands on this. */
  floor: number;
  /** Centre of the net. Also the dividing line between the two halves. */
  netX: number;
  netW: number;
  /** y of the top of the net. Lower number = higher net. */
  netTop: number;
}

/**
 * Two courts, chosen by head count.
 *
 * The wide court is not just "the same court, bigger" — the net is taller too.
 * Four players means two of them can be at the net at once, and on the standard
 * net a 2v2 rally dies on the first block every single time.
 */
export const ARENAS: Record<ArenaKind, Arena> = {
  standard: { w: 1280, h: 720, floor: 660, netX: 640, netW: 16, netTop: 450 },
  wide: { w: 1760, h: 780, floor: 715, netX: 880, netW: 18, netTop: 485 },
};

export function arenaFor(playerCount: number): Arena {
  return playerCount > 2 ? ARENAS.wide : ARENAS.standard;
}

export const BALANCE = {
  // ── ball ────────────────────────────────────────────────────────────────
  GRAVITY: 1750,
  BALL_R: 24,
  /**
   * Uncapped, a charged spike off a dashing player moves further in one step
   * than the ball is wide, and the floor test misses it entirely.
   */
  BALL_MAX_SPEED: 1750,
  WALL_BOUNCE: 0.86,
  NET_BOUNCE: 0.68,
  /** Sideways force from spin, perpendicular to travel. Small on purpose. */
  MAGNUS: 0.00026,
  /** How much of the hitter's horizontal speed becomes spin. */
  SPIN_FROM_HIT: 0.55,
  MAX_SPIN: 900,
  /** Multiplicative decay per second. */
  SPIN_DECAY: 0.55,

  // ── players ─────────────────────────────────────────────────────────────
  PLAYER_R: 42,
  PLAYER_GRAVITY: 2600,
  RUN_ACCEL: 4200,
  AIR_ACCEL: 1500,
  MAX_RUN: 470,
  FRICTION: 3400,
  JUMP_V: 1000,
  /** Extra lift while the jump key is still down, for JUMP_HOLD seconds. */
  JUMP_HOLD_ACCEL: 1500,
  JUMP_HOLD: 0.18,
  DASH_SPEED: 940,
  DASH_TIME: 0.16,
  DASH_COOLDOWN: 0.9,

  /** Seconds of holding to reach full charge. */
  CHARGE_TIME: 0.7,
  /** Movement multiplier while charging — charging in the wrong place is a real cost. */
  CHARGE_SLOW: 0.55,

  // ── contact ─────────────────────────────────────────────────────────────
  HIT_BASE: 700,
  /** Full charge adds this fraction on top of the base hit. */
  CHARGE_GAIN: 0.95,
  /**
   * How much of the incoming speed is returned.
   *
   * Kept low deliberately. At 0.25 each hit added a quarter of an already-fast
   * ball to an already-full-power swing, so a rally escalated: by the third
   * touch the ball was crossing the entire court every time and both players
   * were pinned against opposite walls. Energy has to leave the rally faster
   * than the swings put it in, or the game turns into pong.
   */
  HIT_RETURN: 0.1,
  /** How much of the hitter's own velocity is added to the outgoing ball. */
  HIT_CARRY: 0.35,
  HIT_COOLDOWN: 0.12,
  /**
   * Multiplies the first contact after a serve.
   *
   * Without it the serve is the weakest shot in the game — a dead ball, no
   * incoming speed to borrow — so the serving side starts every rally behind.
   * Combined with "the conceding side serves", that made the first point of a
   * match decide the whole thing: AI-vs-AI produced 7–0 four times out of four,
   * because the team that dropped one point then had to serve its way out of
   * every rally. A free swing at a dead ball is what a serve is anyway, and it
   * makes the format self-balancing: lose a point, get the advantage back.
   */
  SERVE_BONUS: 1.45,
  /**
   * Ground contacts are forced upward by at least this much of the normal.
   *
   * This started at 0.2 and it was the single worst number in the game: a
   * glancing contact left at 0.2 up and 0.98 across, which is a horizontal
   * missile, and AI-vs-AI rallies died after 1.4 touches because nothing could
   * be returned. At 0.55 a ground touch always arcs, which is both what a pass
   * looks like and what gives the other side time to get under it. The rule
   * players learn from it — you can only spike in the air — is the single most
   * important thing about how the game reads.
   */
  GROUND_LIFT: 0.55,

  // ── match ───────────────────────────────────────────────────────────────
  SERVE_DELAY: 1.3,
  POINT_DELAY: 1.2,
  WIN_BY: 2,
  HARD_CAP: 11,
  /** Below this many points to go, the last rally runs slightly slowed. */
  MATCH_POINT_SLOWMO: 0.72,

  // ── power-ups ───────────────────────────────────────────────────────────
  POWER_EVERY_MIN: 12,
  POWER_EVERY_MAX: 20,
  POWER_R: 26,
  POWER_FALL: 95,
  POWER_FEATHER_GRAVITY: 0.5,
  POWER_GIANT_SCALE: 1.4,
  POWER_FREEZE_SLOW: 0.5,
  DURATION: { rocket: Infinity, feather: 8, giant: 7, freeze: 4 } as const,

  // ── net ─────────────────────────────────────────────────────────────────
  /** Snapshots per second from the host. */
  SNAPSHOT_HZ: 20,
  /** Input packets per second from each client. */
  INPUT_HZ: 30,
  /** How fast a client's own character is pulled back toward the host's truth. */
  RECONCILE: 6,
  /** How fast remote characters and the ball chase the last snapshot. */
  INTERP: 18,

  // ── simulation ──────────────────────────────────────────────────────────
  FIXED_DT: 1 / 120,
  /** A tab that was backgrounded for a minute must not run a minute of physics. */
  MAX_STEPS: 8,
} as const;

export const TEAM_COLORS = [
  { main: '#f97316', dark: '#c2410c', light: '#fdba74', name: 'Blaze' },
  { main: '#0ea5e9', dark: '#0369a1', light: '#7dd3fc', name: 'Tide' },
] as const;

export const POWER_META: Record<
  string,
  { label: string; blurb: string; color: string; glyph: string }
> = {
  rocket: { label: 'Rocket', blurb: 'Next hit is a max-power spike', color: '#ef4444', glyph: '🚀' },
  feather: { label: 'Feather', blurb: 'The ball floats', color: '#a78bfa', glyph: '🪶' },
  giant: { label: 'Giant', blurb: 'Your team grows', color: '#22c55e', glyph: '💪' },
  freeze: { label: 'Freeze', blurb: 'They slow down', color: '#38bdf8', glyph: '❄️' },
};

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
