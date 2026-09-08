/**
 * The bot.
 *
 * It has no model of the course at all — no idea what a wall is, no notion of
 * a bunker. What it has is `simulate`, the same physics the player's ball
 * obeys, and it simply tries putts and keeps the one that finishes nearest the
 * flag. Everything that looks like understanding falls out of that: it plays
 * round a pond because the shots through the pond score badly, and it banks
 * off the boards because at the higher ranks it also tries the shots that are
 * not pointed at the hole.
 *
 * The search is two passes rather than one fine grid. A coarse sweep finds the
 * neighbourhood, a tight sweep polishes it, and the two together cost about a
 * fifth of what one grid at the same final resolution would.
 */
import { BALL_R, PHYSICS, clamp } from '../game/rules';
import type { Course, RouteField, Vec } from '../game/course';
import { blockDistance, dist, inPatch, routeField } from '../game/course';
import { simulate } from '../game/physics';

export interface Tier {
  label: string;
  /** Half-width of the angle sweep around the straight line, in radians. */
  spread: number;
  angleSteps: number;
  powerSteps: number;
  /** Also try shots pointed nowhere near the hole even when the line is clear. */
  banks: boolean;
  /**
   * How finely the way-round sweep is searched.
   *
   * Every rank sweeps when the line is blocked — a bot that cannot see a gap
   * it is staring at is broken, not easy — but a lower rank sweeps coarsely
   * and so finds a worse way round, which is a fairer kind of weakness than
   * simply firing into the wall.
   */
  sweep: number;
  /**
   * Slop added to the chosen shot. This is the whole difference between the
   * ranks, and it has to do real work: the search itself is close to perfect
   * at every rank — it tries a couple of hundred putts with the exact physics
   * the ball obeys — so without a firm hand on the wobble even Rookie would
   * hole out from anywhere.
   */
  angleError: number;
  powerError: number;
}

export const TIERS: readonly Tier[] = [
  { label: 'Rookie', spread: 0.3, angleSteps: 5, powerSteps: 5, banks: false, sweep: 10, angleError: 0.34, powerError: 0.36 },
  { label: 'Club', spread: 0.55, angleSteps: 7, powerSteps: 7, banks: false, sweep: 16, angleError: 0.15, powerError: 0.18 },
  { label: 'Pro', spread: 0.9, angleSteps: 9, powerSteps: 8, banks: true, sweep: 22, angleError: 0.055, powerError: 0.07 },
];

/** Per-bot memory. Only enough to stop it playing the identical bad shot twice. */
export interface Brain {
  lastAngle: number;
  lastPower: number;
  stuck: number;
}

export const newBrain = (): Brain => ({ lastAngle: 0, lastPower: 0, stuck: 0 });

export interface Shot {
  angle: number;
  power: number;
}

/** Cheaper physics for the search. Close enough to choose by, a third of the cost. */
const SEARCH_STEP = PHYSICS.STEP * 3;

/**
 * How bad a resting place is, in "units still to travel" terms.
 *
 * Going in wins outright. Everything else is the *route* distance left, not
 * the ruler distance, plus a levy on the places that will cost a stroke or a
 * stroke's worth of trouble next turn.
 *
 * The route is what tells the search apart from a bot that just points at the
 * flag. Ruler distance rates "stopped against the near face of the barrier, a
 * few units from the cup as the crow flies" above "most of the way round it" —
 * the first spot looks closer, but the barrier is still entirely between it
 * and the flag, so the bot picked it, rammed the same wall again next turn,
 * and looked stuck because it was: nothing in the score ever told it that
 * "closer" and "further along the way in" were different things. `route` is
 * built once per shot from the cup outward and answers exactly that question.
 */
function score(course: Course, route: RouteField, rest: Vec, holed: boolean, splash: boolean, sand: boolean): number {
  if (holed) return -1000;
  const routed = route.at(rest.x, rest.y);
  // A spot the field never reached is very close to something solid — the
  // ball is resting right on a wall it just hit. Treated as roughly as bad as
  // the ruler distance plus a flat penalty rather than thrown out, since it is
  // still a real, physically-reachable resting place.
  let s = routed >= 0 ? routed : dist(rest, course.hole) + 60;
  if (splash) s += 90;
  if (sand) s += 26;
  // Tucked hard against scenery is a bad place to be even when it is close.
  for (const b of course.blocks) if (blockDistance(b, rest.x, rest.y) < 4) s += 10;
  for (const p of course.water) if (inPatch(p, rest.x, rest.y)) s += 90;
  return s;
}

/** Is there anything solid or wet between this ball and the flag? */
function blockedLine(course: Course, from: Vec): boolean {
  const steps = 26;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (course.hole.x - from.x) * t;
    const y = from.y + (course.hole.y - from.y) * t;
    for (const b of course.blocks) if (blockDistance(b, x, y) < BALL_R) return true;
    for (const p of course.water) if (inPatch(p, x, y)) return true;
  }
  return false;
}

function evaluate(course: Course, route: RouteField, from: Vec, angle: number, power: number): number {
  const r = simulate(course, from, angle, power, SEARCH_STEP);
  return score(course, route, r.rest, r.events.holed, r.events.splash, r.events.endedInSand);
}

/**
 * One putt for one bot.
 *
 * Always returns something playable — the straight-at-the-flag shot underneath
 * every branch — so a bot can never stall a round.
 */
export function chooseShot(
  course: Course,
  from: Vec,
  level: number,
  brain: Brain,
  rand: () => number = Math.random,
): Shot {
  const tier = TIERS[clamp(Math.trunc(level), 0, TIERS.length - 1)];
  // Built once per putt, from the cup outward, and read by every candidate the
  // search tries. One flood-fill is a lot cheaper than asking "how far round"
  // a couple of hundred times.
  const route = routeField(course, course.hole);
  const straight = Math.atan2(course.hole.y - from.y, course.hole.x - from.x);
  const gap = dist(from, course.hole);

  // A sensible opening guess: enough weight to reach, and a little over.
  const wanted = clamp(gap / 128 + 0.12, 0.12, 1);

  let bestAngle = straight;
  let bestPower = wanted;
  let best = Infinity;

  const consider = (angle: number, power: number) => {
    const s = evaluate(course, route, from, angle, clamp(power, PHYSICS.MIN_POWER, 1));
    if (s < best) {
      best = s;
      bestAngle = angle;
      bestPower = clamp(power, PHYSICS.MIN_POWER, 1);
    }
  };

  // Pass one: coarse, around the straight line.
  for (let i = 0; i < tier.angleSteps; i++) {
    const a = straight + (tier.angleSteps === 1 ? 0 : (i / (tier.angleSteps - 1) - 0.5) * 2 * tier.spread);
    for (let j = 0; j < tier.powerSteps; j++) {
      consider(a, 0.14 + (j / (tier.powerSteps - 1)) * 0.86);
    }
  }

  // Pass two: the way round.
  //
  // Every rank gets this whenever the line to the flag is actually blocked,
  // not just the top one. Sweeping a narrow arc either side of "straight at
  // the cup" is fine on an open green and useless on a hole with a barrier
  // laid across it — every candidate points into the same wall, the bot picks
  // whichever bounces least badly, and it does that again next turn. Rookie
  // finished one hole in six that way. What separates the ranks is the wobble
  // at the end, not whether the bot can see a gap that is plainly there.
  if (tier.banks || blockedLine(course, from) || best > 18) {
    const steps = tier.sweep;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      for (let j = 0; j < 5; j++) consider(a, 0.28 + j * 0.17);
    }
  }

  // Pass three: polish the winner.
  const fine = tier.spread / (tier.angleSteps * 1.6);
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      consider(bestAngle + i * fine, bestPower + j * 0.045);
    }
  }

  // A bot that hit the same shot last turn and is still here is stuck behind
  // something its search cannot see past. Shove it sideways and let the next
  // turn re-plan from somewhere new.
  if (Math.abs(bestAngle - brain.lastAngle) < 0.01 && Math.abs(bestPower - brain.lastPower) < 0.01) {
    brain.stuck += 1;
  } else {
    brain.stuck = 0;
  }
  if (brain.stuck >= 2) {
    bestAngle += (rand() - 0.5) * 1.4;
    brain.stuck = 0;
  }

  brain.lastAngle = bestAngle;
  brain.lastPower = bestPower;

  // And then miss it, on purpose and by rank. A bot that plays its own best
  // line perfectly every time is not a difficulty setting, it is a wall.
  const jitter = (n: number) => (rand() + rand() - 1) * n;
  return {
    angle: bestAngle + jitter(tier.angleError),
    power: clamp(bestPower + jitter(tier.powerError), PHYSICS.MIN_POWER, 1),
  };
}
