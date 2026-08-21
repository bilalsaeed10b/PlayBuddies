import { PlayerState } from '../types';

/**
 * Smoothing for the character this browser does *not* control.
 *
 * Snapshots arrive at whatever rate the network manages — ~60/s over a healthy
 * DataChannel, ~5/s when it falls back to Firestore — while the game draws at
 * 60Hz or more. The old code did two things that fought each other:
 *
 *   1. wrote every snapshot straight onto the player with Object.assign, so the
 *      partner teleported backwards the instant a packet landed, and
 *   2. filled the gaps between packets by re-applying gravity locally, with no
 *      collision — so between packets the partner sank through whatever floor
 *      they were actually standing on, then got yanked back up.
 *
 * Together that is exactly the "other player lags on my screen" rubber-banding.
 *
 * Instead: carry the last snapshot forward along its own reported velocity, and
 * *ease* the drawn position toward that estimate rather than assigning it. The
 * partner then moves continuously at the local frame rate, and a late packet
 * costs a few pixels of correction instead of a visible jump.
 */

export interface RemoteSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  animState: PlayerState['animState'];
  animFrame: number;
  facing: PlayerState['facing'];
  isDead: boolean;
  atDoor: boolean;
  score: number;
  /** Sender's clock. Only used to order snapshots against each other. */
  lastUpdate: number;
}

/** The engine measures dt in 60fps frames, so extrapolation must too. */
const FRAME_MS = 1000 / 60;

/**
 * Never guess further ahead than this. Past it, hold position rather than drift
 * into a wall.
 *
 * Two hundred and fifty milliseconds of guessing is nearly a whole tile of
 * overshoot at running speed, and every pixel of it has to be taken back when
 * the real position lands. That budget was sized for a channel that could
 * stall on a retransmit. It no longer can, so the cap can be tight enough to
 * cover ordinary jitter and nothing more.
 */
const MAX_EXTRAPOLATION_MS = 140;

/** Above this the gap is a teleport — a respawn or a level change — so snap instead of gliding across the level. */
const SNAP_DISTANCE = 120;

/**
 * Share of the remaining error closed per 60fps frame. Higher is tighter but
 * jerkier.
 *
 * An easing filter always sits a little behind what it is chasing, by
 * (1 - k) / k frames. At 0.25 that is three frames, so the partner was drawn
 * a steady 50ms in the past on a perfect connection, before the network had
 * added anything. At 0.42 it is under a frame and a half, which is the
 * difference between a partner who feels present and one who feels remote.
 *
 * There is a floor under how high this can go: at 1 the easing is gone and
 * every packet is a hard assignment, which is the teleporting this class was
 * written to stop.
 */
const CATCHUP_PER_FRAME = 0.42;

export class RemoteSmoother {
  private snap: RemoteSnapshot | null = null;
  /** When the current snapshot was *sent*, expressed on this machine's clock. */
  private sentAtLocal = 0;
  /**
   * Lowest (local arrival - sender's stamp) seen so far.
   *
   * The two machines' clocks have no relationship to each other, so a sender's
   * timestamp means nothing on its own. What is knowable is that the fastest
   * packet ever seen took the least time, so the smallest difference observed
   * is a decent stand-in for "clock offset plus the best case trip". Every
   * other packet can then be dated against it.
   */
  private baseOffset: number | null = null;

  /**
   * Records a snapshot. Older ones are dropped: the DataChannel is unordered
   * (that is what makes it fast) and Firestore can deliver a retry behind a
   * newer write, so packets genuinely do arrive out of sequence.
   */
  push(s: RemoteSnapshot) {
    if (this.snap && s.lastUpdate <= this.snap.lastUpdate) return;

    const now = performance.now();
    const observed = now - s.lastUpdate;
    if (this.baseOffset === null || observed < this.baseOffset) {
      this.baseOffset = observed;
    } else {
      // Let the estimate drift back up very slowly. Without this, one freakishly
      // fast packet, or a sender whose clock is quietly running ahead, would
      // pin the baseline too low for the rest of the session and every packet
      // after it would be treated as older than it is.
      this.baseOffset += (observed - this.baseOffset) * 0.0005;
    }

    this.snap = s;
    this.sentAtLocal = s.lastUpdate + this.baseOffset;
  }

  /** Call when the level restarts, so a fresh player isn't dragged to a stale position. */
  reset() {
    this.snap = null;
    this.baseOffset = null;
  }

  /** Advances the remote player one frame. `dt` is in 60fps frames, as everywhere else. */
  apply(p: PlayerState, dt: number, now = performance.now()) {
    const s = this.snap;
    if (!s) return;

    // Discrete state is copied outright — a half-dead player is nonsense.
    p.animState = s.animState;
    p.animFrame = s.animFrame;
    p.facing = s.facing;
    p.isDead = s.isDead;
    p.atDoor = s.atDoor;
    p.score = s.score;
    p.vx = s.vx;
    p.vy = s.vy;

    // Dated from when it was *sent*, not from when it turned up.
    //
    // Measuring from arrival treats every packet as brand new, so a packet held
    // up an extra eighty milliseconds put the partner eighty milliseconds into
    // the past the instant it landed: they visibly stepped backwards, then
    // hurried to catch up, on every hiccup in the connection. Dating from the
    // send time means a late packet is simply extrapolated further, and jitter
    // stops being something the player can see.
    const ageMs = Math.max(0, Math.min(now - this.sentAtLocal, MAX_EXTRAPOLATION_MS));
    const ageFrames = ageMs / FRAME_MS;
    const targetX = s.x + s.vx * ageFrames;
    const targetY = s.y + s.vy * ageFrames;

    const dx = targetX - p.x;
    const dy = targetY - p.y;

    if (dx * dx + dy * dy > SNAP_DISTANCE * SNAP_DISTANCE) {
      p.x = targetX;
      p.y = targetY;
      return;
    }

    // Frame-rate independent easing: the same fraction of the error is closed
    // per unit of *time*, so 144Hz doesn't catch up nearly three times faster
    // than 60Hz and overshoot into a wall.
    const k = 1 - Math.pow(1 - CATCHUP_PER_FRAME, Math.max(dt, 0));
    p.x += dx * k;
    p.y += dy * k;
  }
}

/** Fields worth putting on the wire — everything else is derivable or local. */
export function snapshotOf(p: PlayerState, lastUpdate: number): RemoteSnapshot {
  return {
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    animState: p.animState,
    animFrame: p.animFrame,
    facing: p.facing,
    isDead: p.isDead,
    atDoor: p.atDoor,
    score: p.score,
    lastUpdate,
  };
}

/**
 * True when a snapshot is worth sending. An idle player standing on a platform
 * produces byte-identical frames; re-sending them 60 times a second burns
 * bandwidth on both peers and, on the Firestore fallback, real money.
 */
export function worthSending(a: RemoteSnapshot | null, b: RemoteSnapshot): boolean {
  if (!a) return true;
  if (a.isDead !== b.isDead || a.atDoor !== b.atDoor) return true;
  if (a.animState !== b.animState || a.facing !== b.facing || a.score !== b.score) return true;
  return Math.abs(a.x - b.x) > 0.25 || Math.abs(a.y - b.y) > 0.25;
}
