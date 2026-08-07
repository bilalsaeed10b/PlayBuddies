import { PlayerState } from '../types';

/**
 * Smoothing for the character this browser does *not* control.
 *
 * Snapshots arrive at whatever rate the network manages — ~30/s over a healthy
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

/** Never guess further ahead than this. Past it, hold position rather than drift into a wall. */
const MAX_EXTRAPOLATION_MS = 250;

/** Above this the gap is a teleport — a respawn or a level change — so snap instead of gliding across the level. */
const SNAP_DISTANCE = 120;

/** Share of the remaining error closed per 60fps frame. Higher is tighter but jerkier. */
const CATCHUP_PER_FRAME = 0.25;

export class RemoteSmoother {
  private snap: RemoteSnapshot | null = null;
  private receivedAt = 0;

  /**
   * Records a snapshot. Older ones are dropped: the DataChannel is unordered
   * (that is what makes it fast) and Firestore can deliver a retry behind a
   * newer write, so packets genuinely do arrive out of sequence.
   */
  push(s: RemoteSnapshot) {
    if (this.snap && s.lastUpdate <= this.snap.lastUpdate) return;
    this.snap = s;
    this.receivedAt = performance.now();
  }

  /** Call when the level restarts, so a fresh player isn't dragged to a stale position. */
  reset() {
    this.snap = null;
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

    const ageFrames = Math.min(now - this.receivedAt, MAX_EXTRAPOLATION_MS) / FRAME_MS;
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
 * produces byte-identical frames; re-sending them 30 times a second burns
 * bandwidth on both peers and, on the Firestore fallback, real money.
 */
export function worthSending(a: RemoteSnapshot | null, b: RemoteSnapshot): boolean {
  if (!a) return true;
  if (a.isDead !== b.isDead || a.atDoor !== b.atDoor) return true;
  if (a.animState !== b.animState || a.facing !== b.facing || a.score !== b.score) return true;
  return Math.abs(a.x - b.x) > 0.25 || Math.abs(a.y - b.y) > 0.25;
}
