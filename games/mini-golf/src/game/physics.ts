/**
 * A rolling ball, and everything that can happen to it.
 *
 * This is the only place the game decides where a ball ends up. The engine
 * steps it a frame at a time so a shot can be watched; the bot runs the very
 * same code flat out to see where a putt would finish before committing to it.
 * One implementation, so a bot can never be playing a slightly different game
 * from the person it is beating.
 *
 * Nothing here is asked to be deterministic across machines, and it is not:
 * `Math.exp` is not specified to the last bit and two browsers may disagree in
 * the twelfth decimal. That is fine, because a shot's *outcome* never travels
 * as "replay this and trust yourself" — the player who took it sends where the
 * ball actually stopped, and the far side snaps to that once its own replay has
 * finished looking pretty. See ShotPacket.
 */
import { BALL_R, HOLE_R, PHYSICS, clamp } from './rules';
import type { Course, Vec } from './course';
import { blockDistance, dist, inPatch, toBlockLocal } from './course';

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  moving: boolean;
}

export type Surface = 'green' | 'rough' | 'sand';

/** How wide the shaggy band around the outer wall is. */
const FRINGE = 7;

/** Everything a step can report, accumulated over a whole shot. */
export interface ShotEvents {
  bounces: number;
  splash: boolean;
  lipped: boolean;
  holed: boolean;
  /** Sand it was resting in when it stopped, not sand it merely rolled across. */
  endedInSand: boolean;
  endedInRough: boolean;
}

export const noEvents = (): ShotEvents => ({
  bounces: 0,
  splash: false,
  lipped: false,
  holed: false,
  endedInSand: false,
  endedInRough: false,
});

/** How far this point is from the nearest outer wall. */
function wallClearance(course: Course, x: number, y: number): number {
  const s = course.shape;
  if (s.kind === 'rect') {
    return Math.min(x, course.w - x, y, course.h - y);
  }
  const dx = x - s.cx;
  const dy = y - s.cy;
  return Math.min(s.r - Math.hypot(dx, dy), dx * s.nx + dy * s.ny);
}

export function surfaceAt(course: Course, x: number, y: number): Surface {
  for (const p of course.sand) if (inPatch(p, x, y)) return 'sand';
  return wallClearance(course, x, y) < FRINGE ? 'rough' : 'green';
}

const frictionFor = (s: Surface) =>
  s === 'sand' ? PHYSICS.K_SAND : s === 'rough' ? PHYSICS.K_ROUGH : PHYSICS.K_GREEN;

/** Bounces the velocity about a unit normal and takes the sting out of it. */
function reflect(ball: Ball, nx: number, ny: number, restitution: number) {
  const dot = ball.vx * nx + ball.vy * ny;
  ball.vx = (ball.vx - 2 * dot * nx) * restitution;
  ball.vy = (ball.vy - 2 * dot * ny) * restitution;
}

/** Puts a ball that has strayed through the outer wall back inside, bouncing. */
function resolveWalls(course: Course, ball: Ball, events: ShotEvents) {
  const s = course.shape;

  if (s.kind === 'rect') {
    if (ball.x < BALL_R) {
      ball.x = BALL_R;
      if (ball.vx < 0) reflect(ball, 1, 0, PHYSICS.BOUNCE);
      events.bounces++;
    } else if (ball.x > course.w - BALL_R) {
      ball.x = course.w - BALL_R;
      if (ball.vx > 0) reflect(ball, -1, 0, PHYSICS.BOUNCE);
      events.bounces++;
    }
    if (ball.y < BALL_R) {
      ball.y = BALL_R;
      if (ball.vy < 0) reflect(ball, 0, 1, PHYSICS.BOUNCE);
      events.bounces++;
    } else if (ball.y > course.h - BALL_R) {
      ball.y = course.h - BALL_R;
      if (ball.vy > 0) reflect(ball, 0, -1, PHYSICS.BOUNCE);
      events.bounces++;
    }
    return;
  }

  // The arc, then the flat cut. Both are one plane each, so both are the same
  // two lines of code with a different normal.
  const dx = ball.x - s.cx;
  const dy = ball.y - s.cy;
  const d = Math.hypot(dx, dy);
  if (d > s.r - BALL_R && d > 0) {
    const nx = -dx / d;
    const ny = -dy / d;
    ball.x = s.cx + (dx / d) * (s.r - BALL_R);
    ball.y = s.cy + (dy / d) * (s.r - BALL_R);
    if (ball.vx * nx + ball.vy * ny < 0) reflect(ball, nx, ny, PHYSICS.BOUNCE);
    events.bounces++;
  }

  const along = (ball.x - s.cx) * s.nx + (ball.y - s.cy) * s.ny;
  if (along < BALL_R) {
    const push = BALL_R - along;
    ball.x += s.nx * push;
    ball.y += s.ny * push;
    if (ball.vx * s.nx + ball.vy * s.ny < 0) reflect(ball, s.nx, s.ny, PHYSICS.BOUNCE);
    events.bounces++;
  }
}

/** Same idea for the scenery: find the nearest surface point, push out, bounce. */
function resolveBlocks(course: Course, ball: Ball, events: ShotEvents) {
  for (const b of course.blocks) {
    const d = blockDistance(b, ball.x, ball.y);
    if (d >= BALL_R) continue;

    let nx: number;
    let ny: number;
    if (b.kind === 'circle') {
      const ox = ball.x - b.x;
      const oy = ball.y - b.y;
      const len = Math.hypot(ox, oy) || 1;
      nx = ox / len;
      ny = oy / len;
    } else {
      // Work out the way out in the block's own frame, where it is an ordinary
      // axis-aligned box, then rotate that answer back into the world.
      const { lx, ly } = toBlockLocal(b, ball.x, ball.y);
      const qx = Math.abs(lx) - b.w / 2;
      const qy = Math.abs(ly) - b.h / 2;
      let ux: number;
      let uy: number;
      if (qx > 0 || qy > 0) {
        ux = Math.max(qx, 0) * Math.sign(lx || 1);
        uy = Math.max(qy, 0) * Math.sign(ly || 1);
      } else {
        // Inside it: leave by the nearest face rather than the nearest corner.
        if (qx > qy) {
          ux = Math.sign(lx || 1);
          uy = 0;
        } else {
          ux = 0;
          uy = Math.sign(ly || 1);
        }
      }
      const len = Math.hypot(ux, uy) || 1;
      ux /= len;
      uy /= len;
      const c = Math.cos(b.a);
      const sn = Math.sin(b.a);
      nx = ux * c - uy * sn;
      ny = ux * sn + uy * c;
    }

    ball.x += nx * (BALL_R - d);
    ball.y += ny * (BALL_R - d);
    if (ball.vx * nx + ball.vy * ny < 0) reflect(ball, nx, ny, PHYSICS.BOUNCE_BLOCK);
    events.bounces++;
  }
}

/**
 * One fixed physics step. Mutates the ball, appends to `events`.
 *
 * Split out of the loop below so the engine can call it a frame's worth at a
 * time and the bot can call it a thousand times without stopping to draw.
 */
export function advance(course: Course, ball: Ball, dt: number, events: ShotEvents) {
  if (!ball.moving) return;

  const k = frictionFor(surfaceAt(course, ball.x, ball.y));
  const decay = Math.exp(-k * dt);
  ball.vx *= decay;
  ball.vy *= decay;

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  // The cup, before the walls: a ball dropping in is done, wherever it is.
  const toHole = dist(ball, course.hole);
  if (toHole < HOLE_R - BALL_R * 0.3) {
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed < PHYSICS.CAPTURE_SPEED) {
      ball.x = course.hole.x;
      ball.y = course.hole.y;
      ball.vx = 0;
      ball.vy = 0;
      ball.moving = false;
      events.holed = true;
      return;
    }
    // Too quick. It rides the rim and carries on, a good deal slower and
    // pushed off line — which is what a lip-out looks like.
    ball.vx *= PHYSICS.LIP_DAMP;
    ball.vy *= PHYSICS.LIP_DAMP;
    events.lipped = true;
  }

  for (const p of course.water) {
    if (!inPatch(p, ball.x, ball.y)) continue;
    // It stops right where it went in, and it is left there. Deciding *where a
    // drowned ball reappears* is not physics — it is a rule — so this only
    // reports the splash and the caller plays the ball again from wherever it
    // was struck. `simulate` does the same, which is how the bot knows a pond
    // costs it the whole shot rather than a few units of position.
    ball.vx = 0;
    ball.vy = 0;
    ball.moving = false;
    events.splash = true;
    return;
  }

  resolveWalls(course, ball, events);
  resolveBlocks(course, ball, events);

  if (Math.hypot(ball.vx, ball.vy) < PHYSICS.STOP) {
    ball.vx = 0;
    ball.vy = 0;
    ball.moving = false;
    const s = surfaceAt(course, ball.x, ball.y);
    events.endedInSand = s === 'sand';
    events.endedInRough = s === 'rough';
  }
}

/** A struck ball, ready to be stepped. */
export function launch(from: Vec, angle: number, power: number): Ball {
  const speed = PHYSICS.MAX_SPEED * clamp(power, PHYSICS.MIN_POWER, 1);
  return {
    x: from.x,
    y: from.y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    moving: true,
  };
}

export interface ShotResult {
  rest: Vec;
  events: ShotEvents;
  /** Seconds of simulated time the shot took. Only the bot cares. */
  duration: number;
}

/**
 * Play a whole shot out immediately.
 *
 * The bot's entire understanding of the course is this function: it tries a
 * putt, sees where the ball would stop, and keeps the best one. That is why it
 * can bank off a wall it was never taught about.
 */
export function simulate(course: Course, from: Vec, angle: number, power: number, step = PHYSICS.STEP): ShotResult {
  const ball = launch(from, angle, power);
  const events = noEvents();
  let t = 0;
  while (ball.moving && t < PHYSICS.MAX_FLIGHT) {
    advance(course, ball, step, events);
    t += step;
  }
  if (ball.moving) {
    // Ran out of patience. Somewhere in a corner at walking pace; call it done.
    ball.moving = false;
    const s = surfaceAt(course, ball.x, ball.y);
    events.endedInSand = s === 'sand';
    events.endedInRough = s === 'rough';
  }
  // A drowned ball is played again from where it was struck, so that — not the
  // bottom of the pond — is where this shot actually leaves it.
  const rest = events.splash ? { x: from.x, y: from.y } : { x: ball.x, y: ball.y };
  return { rest, events, duration: t };
}
