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
/**
 * Net heights are set *relative to how high a player can get*, not picked for
 * looks.
 *
 * Lowering the jump to stop everyone floating also removed the only shot that
 * ends a rally: with the old 210-tall net a player could no longer reach above
 * the tape, so nothing was ever unreturnable and AI-vs-AI rallies ran past a
 * hundred touches. The net came down with the jump. What matters is the gap
 * between the tape and a jumping player's reach — keep that and the game plays
 * the same, whatever the absolute numbers are.
 */
export const ARENAS: Record<ArenaKind, Arena> = {
  standard: { w: 1280, h: 720, floor: 660, netX: 640, netW: 16, netTop: 485 },
  wide: { w: 1760, h: 780, floor: 715, netX: 880, netW: 18, netTop: 525 },
};

export function arenaFor(playerCount: number): Arena {
  return playerCount > 2 ? ARENAS.wide : ARENAS.standard;
}

export const BALANCE = {
  // ── ball ────────────────────────────────────────────────────────────────
  GRAVITY: 2400,
  BALL_R: 24,
  /**
   * Uncapped, a charged spike off a dashing player moves further in one step
   * than the ball is wide, and the floor test misses it entirely.
   */
  BALL_MAX_SPEED: 1750,
  WALL_BOUNCE: 0.86,
  /** Ball bounces off the floor with this much energy retained (higher = bouncier). */
  FLOOR_BOUNCE: 0.72,
  NET_BOUNCE: 0.68,
  /**
   * How sharply spin curves the ball, in radians per second per unit of spin.
   *
   * Magnus force acts perpendicular to travel, which means it does no work: it
   * bends the flight path without adding or removing speed. So it is applied as
   * a rotation of the velocity vector, and this number is a *turn rate* — not
   * the acceleration it used to be.
   *
   * That distinction was the bug. The old version added the sideways force to
   * vx and then computed the vertical term from the *already updated* vx, which
   * is not a rotation at all: it bled vertical velocity away every step. At
   * full spin it cancelled about 85% of gravity, so a hard-hit ball stopped
   * falling and hung in the air, drifting sideways in proportion to how fast
   * the player who hit it was moving — the ball appeared to follow them around.
   *
   * At MAX_SPIN this is ~0.63 rad/s, and spin decays quickly, so a whole flight
   * bends by perhaps 20°. Visible, never silly.
   */
  MAGNUS_TURN: 0.0007,
  /** How much of the hitter's horizontal speed becomes spin. */
  SPIN_FROM_HIT: 0.55,
  MAX_SPIN: 900,
  /** Multiplicative decay per second. */
  SPIN_DECAY: 0.55,

  // ── players ─────────────────────────────────────────────────────────────
  PLAYER_R: 42,
  /**
   * Heavier than it was (2600).
   *
   * "Too floaty" is almost never about speed — it is about hang time. At 2600
   * a jump kept you airborne for the better part of a second with barely any
   * air control, so half of every rally was spent drifting and waiting to land.
   * More gravity shortens the hang without taking the jump away.
   */
  PLAYER_GRAVITY: 3200,
  /**
   * Movement is effectively instant, and that is the point.
   *
   * These went 2800 → 4800 → here. Even at 4800 there was a perceptible ramp
   * on and off every step, and a positioning game where you cannot trust where
   * you will actually stop feels broken rather than weighty. At 14000 a key
   * press is a position change: full speed inside two frames, dead stop inside
   * two frames. Arcade, not simulation.
   */
  RUN_ACCEL: 14000,
  AIR_ACCEL: 5000,
  MAX_RUN: 440,
  FRICTION: 14000,
  JUMP_V: 1020,
  /**
   * Extra lift while the jump key is still down, for JUMP_HOLD seconds.
   *
   * Cut from 1200: a held jump used to sail well clear of the net from a
   * standing start, which is the "jumping too high" everyone noticed. A tap now
   * just reaches blocking height and a held jump reaches spiking height, so the
   * difference between the two is worth learning.
   */
  JUMP_HOLD_ACCEL: 700,
  JUMP_HOLD: 0.16,
  DASH_SPEED: 940,
  DASH_TIME: 0.16,
  DASH_COOLDOWN: 0.9,

  // ── contact ─────────────────────────────────────────────────────────────
  /**
   * Every hit is this hard now.
   *
   * It was 700, on the assumption that a held charge would multiply it by up to
   * 1.9. With the charge meter gone that multiplier went too, so every contact
   * became a 700 lob that anybody could run down: AI-vs-AI rallies went to 40,
   * 77, once 136 touches and a single point took over a minute. Folding the
   * average charged hit back into the base restores the pace without asking the
   * player to hold anything.
   */
  HIT_BASE: 1150,
  /**
   * Straight upward kick added to every contact, on top of the bounce.
   *
   * The ball used to leave along the contact normal and nothing else, so a
   * touch taken slightly off-centre skidded away flat and low and the rally was
   * over. A fixed pop makes every touch pick the ball *up* — which is what a
   * volleyball does off a forearm, and what makes a rally feel like a rally.
   */
  BOUNCE_LIFT: 150,
  /**
   * Hard ceiling on how fast the ball can be travelling upward after a contact.
   *
   * BOUNCE_LIFT is added on top of the hit, so without a cap it compounds: at
   * 210 with no ceiling, AI-vs-AI rallies ran to 136 touches and one lasted two
   * minutes, because every touch put in more height than gravity took out and
   * the ball simply stopped coming down. Anything that adds energy to a rally
   * needs a limit; this is that limit.
   */
  MAX_UP: 1220,
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
   * be returned. At 0.62 a ground touch always arcs, which is both what a pass
   * looks like and what gives the other side time to get under it. The rule
   * players learn from it — you can only spike in the air — is the single most
   * important thing about how the game reads.
   */
  GROUND_LIFT: 0.7,

  // ── match ───────────────────────────────────────────────────────────────
  SERVE_DELAY: 1.3,
  POINT_DELAY: 1.2,
  /** The lead needed to take the match, when the win-by-two setting is on. */
  WIN_BY: 2,
  HARD_CAP: 11,

  // ── power-ups ───────────────────────────────────────────────────────────
  POWER_EVERY_MIN: 12,
  POWER_EVERY_MAX: 20,
  POWER_R: 26,
  POWER_FALL: 95,
  POWER_FEATHER_GRAVITY: 0.5,
  /** Rocket multiplies the next hit. It replaced the charge meter's role. */
  POWER_ROCKET_HIT: 1.85,
  POWER_GIANT_SCALE: 1.4,
  POWER_FREEZE_SLOW: 0.5,
  DURATION: { rocket: Infinity, feather: 8, giant: 7, freeze: 4 } as const,

  // ── net ─────────────────────────────────────────────────────────────────
  //
  // The rule this whole section is built around: *nobody ever waits for the
  // wire to see their own character move.* Every machine simulates the entire
  // match; the network only corrects it. A packet that goes missing costs
  // accuracy, never responsiveness.
  /** Snapshots per second from the host. */
  SNAPSHOT_HZ: 30,
  /**
   * How often a guest tells the host where its own body actually is.
   *
   * Guests are authoritative over their own body — see MatchEngine.applyBody.
   * Sending the body as well as the input is what removes the last source of
   * delay: with input alone the host has to re-derive the position from a
   * bitmask that is already one trip old, and every dropped packet becomes a
   * visible stutter on everybody else's screen.
   */
  BODY_HZ: 30,
  /**
   * Floor on how often input is repeated when nothing is changing.
   *
   * Input is sent the instant a key changes state, so this is only a heartbeat
   * against packet loss on an unreliable channel — not the input rate.
   */
  INPUT_HEARTBEAT_HZ: 10,
  /** Round-trip probes per second. Feeds the extrapolation below. */
  PING_HZ: 1,
  /**
   * How far a received packet may be extrapolated forward, in seconds.
   *
   * Everything on the wire is already old by one trip when it arrives, so it is
   * run forward by that much before being used. Past this the estimate is worse
   * than the local simulation and it is dropped.
   */
  MAX_EXTRAP: 0.3,
  /** How fast remote characters and the ball are eased onto their target. */
  INTERP: 22,
  /**
   * Error, in pixels, a machine tolerates on a body it does not own before it
   * bothers correcting it at all. Below this the local simulation is right.
   */
  BODY_TOLERANCE: 3,
  /** Above this the ease is abandoned and the body is snapped. */
  BODY_SNAP: 260,
  /**
   * The same two numbers for a guest's *own* body, which it owns.
   *
   * Wildly looser on purpose. A character that is nudged under your own thumb
   * feels broken even when the nudge is technically more accurate, so the host
   * only gets to move you when the two simulations have genuinely come apart —
   * a serve reset, or a correction big enough that ignoring it would put you on
   * the wrong side of the ball.
   */
  OWN_TOLERANCE: 90,
  OWN_SNAP: 340,
  /** Ball error tolerated before correcting, and the error that forces a snap. */
  BALL_TOLERANCE: 12,
  BALL_SNAP: 320,
  /** Seconds without a snapshot before a guest says so on screen. */
  STALL_WARN: 1.5,
  /**
   * Seconds without a snapshot before a guest runs the rules itself.
   *
   * A guest cannot score, serve or spawn power-ups, so a host that vanishes
   * used to leave everyone else staring at a frozen court until they gave up
   * and quit. Taking over is not always *right* — two guests could take over at
   * once and drift apart — but a game that keeps playing beats a game that has
   * stopped, and the roster change that follows a real disconnect resolves it.
   *
   * MatchView doubles this for a guest that has *never* heard from the host —
   * see the note by DROPPED_MS in MatchView.tsx for why the first contact
   * needs a longer allowance than a drop mid-match. Kept in step with that
   * number by hand: this doubled is meant to land close to it.
   */
  STALL_PROMOTE: 10,

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
