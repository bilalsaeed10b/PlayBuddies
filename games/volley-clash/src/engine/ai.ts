/**
 * The computer opponent.
 *
 * The naive version — walk toward the ball's current x — loses every rally,
 * because by the time it arrives the ball has moved. This one **solves for
 * where the ball will be**: it integrates the ball forward until it drops to
 * hitting height and walks to that point instead.
 *
 * Two things it learned the hard way, both visible in a frame-by-frame trace:
 *
 * - It must commit to the landing spot **while the ball is still on the other
 *   side of the net**. Waiting until the ball crosses leaves under half a
 *   second to cover half a court, and it simply cannot.
 * - It must almost never jump. Air acceleration is a third of ground
 *   acceleration, so an airborne AI is a stationary AI. An earlier version
 *   rolled dice for a jump every physics step — 120 times a second — and spent
 *   entire rallies hopping on the spot while the ball landed beside it.
 *
 * Difficulty is not implemented by cheating. Every tier runs the same
 * prediction; the tiers differ in how often they re-read the world, how much
 * error they add to their aim, and how willing they are to attack. A Rookie is
 * a Legend with slower eyes.
 */
import { Arena, BALANCE, clamp } from '../game/rules';
import { Ball, Input, Player, Team } from '../types/game';

interface Tier {
  /** Seconds between re-reads of the ball. Higher = slower to react. */
  think: number;
  /** Horizontal aim error in pixels. */
  slop: number;
  /** Chance, per decision, of going up for an attacking hit instead of a safe one. */
  aggression: number;
  dashes: boolean;
  label: string;
}

export const TIERS: Tier[] = [
  { think: 0.26, slop: 105, aggression: 0.18, dashes: false, label: 'Rookie' },
  { think: 0.13, slop: 48, aggression: 0.5, dashes: true, label: 'Pro' },
  { think: 0.05, slop: 14, aggression: 0.85, dashes: true, label: 'Legend' },
];

/** Where the ball will be when it next falls to `hitY`, and how long that takes. */
function predict(ball: Ball, arena: Arena, hitY: number, gravity: number) {
  let x = ball.x;
  let y = ball.y;
  let vx = ball.vx;
  let vy = ball.vy;
  const dt = 1 / 60;

  for (let i = 0; i < 150; i++) {
    vy += gravity * dt;
    x += vx * dt;
    y += vy * dt;

    if (x < BALANCE.BALL_R) {
      x = BALANCE.BALL_R;
      vx = -vx * BALANCE.WALL_BOUNCE;
    } else if (x > arena.w - BALANCE.BALL_R) {
      x = arena.w - BALANCE.BALL_R;
      vx = -vx * BALANCE.WALL_BOUNCE;
    }

    if (vy > 0 && y >= hitY) return { x, time: i * dt };
  }
  return { x, time: 2.5 };
}

/** The x a player holds when the ball is not their problem. */
function restingX(arena: Arena, team: Team, index: number, count: number) {
  const half = arena.netX;
  // Two per side: one covers the net, one covers the back.
  const spots = count > 1 ? [0.62, 0.3] : [0.5];
  const t = spots[index % spots.length];
  return team === 0 ? half * t : arena.w - half * t;
}

/**
 * One frame of input for an AI seat.
 *
 * `mates` is every player on the same team, so a 2v2 pair agrees on who takes
 * the ball rather than both charging it. `serveTeam` is the side holding the
 * serve, or null during open play — without it both teams treat the hanging
 * serve as theirs and jump at a ball on the wrong side of the net.
 */
export function thinkFor(
  self: Player,
  ball: Ball,
  arena: Arena,
  dt: number,
  mates: Player[],
  ballGravity: number,
  serveTeam: Team | null,
): Input {
  const tier = TIERS[clamp(self.aiLevel, 0, TIERS.length - 1)];
  const brain = self.brain;

  brain.thinkIn -= dt;
  if (brain.thinkIn <= 0) {
    brain.thinkIn = tier.think;
    decide(self, ball, arena, mates, ballGravity, serveTeam, tier);
  }

  const gap = brain.targetX - self.x;
  const deadZone = self.r * 0.3;

  // Bang-bang steering overshoots at 470 px/s and then oscillates around the
  // target — which is what a trace showed it doing while the ball landed two
  // body-widths away. Stop pushing once friction alone will carry us there.
  const brake = (self.vx * self.vx) / (2 * BALANCE.FRICTION);
  const dir = Math.abs(gap) < deadZone ? 0 : Math.sign(gap);
  const coasting = dir !== 0 && Math.sign(self.vx) === dir && Math.abs(gap) <= brake;

  const input: Input = {
    left: dir < 0 && !coasting,
    right: dir > 0 && !coasting,
    jump: false,
    dash: false,
  };

  // Jumping is a decision made at think time and executed once, not a dice roll
  // evaluated every physics step.
  const overhead = ball.y < self.y - self.r * 1.1;
  const reachable = Math.abs(ball.x - self.x) < self.r * 2.2;
  if (brain.wantJump && self.onGround && overhead && reachable) {
    input.jump = true;
    brain.wantJump = false;
  }
  // Keep holding through the boost window so the AI gets the full jump height a
  // human would; releasing on the first frame is why it used to under-jump.
  if (!self.onGround && self.jumpHeld >= 0 && self.jumpHeld < BALANCE.JUMP_HOLD) input.jump = true;

  if (brain.wantDash && self.onGround && self.dashCd <= 0 && Math.abs(gap) > self.r * 3) {
    input.dash = true;
    brain.wantDash = false;
  }

  return input;
}

function decide(
  self: Player,
  ball: Ball,
  arena: Arena,
  mates: Player[],
  ballGravity: number,
  serveTeam: Team | null,
  tier: Tier,
) {
  const brain = self.brain;
  const index = Math.max(0, mates.findIndex((p) => p.id === self.id));

  // During a serve the ball hangs on one side and only that side may play it.
  if (serveTeam !== null && serveTeam !== self.team) {
    brain.targetX = restingX(arena, self.team, index, mates.length);
    brain.claimed = false;
    brain.wantJump = false;
    brain.wantDash = false;
    return;
  }

  const hitY = arena.floor - self.r * 1.4;
  const shot = predict(ball, arena, hitY, ballGravity);

  // The whole point of predicting: commit to the landing spot while the ball is
  // still on the far side, so there is time to actually get there.
  const landsMine = self.team === 0 ? shot.x < arena.netX : shot.x > arena.netX;
  if (!landsMine) {
    brain.targetX = restingX(arena, self.team, index, mates.length);
    brain.claimed = false;
    brain.wantJump = false;
    brain.wantDash = false;
    return;
  }

  const inset = self.r + 14;
  const spot = clamp(
    shot.x,
    self.team === 0 ? inset : arena.netX + arena.netW / 2 + inset,
    self.team === 0 ? arena.netX - arena.netW / 2 - inset : arena.w - inset,
  );

  // Who takes it: whoever is closest. Ties break on id so both members of a 2v2
  // independently reach the same answer.
  const rivals = mates.filter((p) => p.id !== self.id);
  const mine = Math.abs(self.x - spot);
  brain.claimed = rivals.every((p) => {
    const theirs = Math.abs(p.x - spot);
    return mine < theirs || (mine === theirs && self.id < p.id);
  });

  if (!brain.claimed) {
    brain.targetX = restingX(arena, self.team, index, mates.length);
    brain.wantJump = false;
    brain.wantDash = false;
    return;
  }

  // Stand slightly on the far side of the ball from the net. The contact normal
  // is what decides the outgoing angle, so standing dead underneath pops the
  // ball straight back up and the AI juggles on its own side until it drops.
  const toward: number = self.team === 0 ? 1 : -1;
  // No aim wobble on the serve. It is a stationary ball dropped on your own
  // head; missing it is not a difficulty setting, it is a bug the player sees.
  const slop = serveTeam === null ? (Math.random() - 0.5) * tier.slop : 0;
  brain.targetX = spot - toward * self.r * 0.75 + slop;

  // Go up for it only when the ball will still be well above head height when
  // it arrives, we are already close, and this tier feels like attacking.
  const arrivesHigh = shot.time < 0.7 && ball.y < arena.floor - self.r * 3;
  brain.wantJump = arrivesHigh && Math.abs(self.x - brain.targetX) < self.r * 2 && Math.random() < tier.aggression;
  brain.wantDash = tier.dashes && Math.abs(self.x - brain.targetX) > self.r * 5 && shot.time < 0.9;
}

export function newBrain() {
  return { targetX: 0, thinkIn: 0, claimed: false, wantJump: false, wantDash: false };
}
