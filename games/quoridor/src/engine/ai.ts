/**
 * The bot.
 *
 * Quoridor's whole tension is one comparison: am I closer to my edge than the
 * player I am most afraid of is to theirs? Everything here falls out of that.
 * Ahead, it runs. Behind, it looks for the wall that costs the leader the most
 * steps while costing itself the fewest, and spends one if the trade is good
 * enough.
 *
 * The expensive part is scoring walls, so the search never looks at all 128
 * slots. It looks at the ones lying on or beside the leader's own shortest
 * route, because a wall anywhere else cannot lengthen it — which cuts a few
 * hundred breadth-first searches a turn down to a few dozen.
 */
import {
  HORIZONTAL,
  Position,
  VERTICAL,
  clonePosition,
  colOf,
  distanceToGoal,
  encodeStep,
  encodeWall,
  pawnMoves,
  rowOf,
  routeToGoal,
  stepTowardGoal,
  teamOf,
  wallCode,
  wallLegal,
  wallSlot,
} from '../game/rules';
import type { Layout, Orientation } from '../game/rules';

export interface Tier {
  label: string;
  /**
   * How often it simply forgets to think and takes a plain step instead. The
   * lowest rank is meant to be beatable by somebody learning the rules.
   */
  sloppiness: number;
  /** How much shorter the leader's route has to get before a wall is worth one. */
  threshold: number;
  /** Walls it refuses to spend early, so it is not empty-handed at the finish. */
  reserve: number;
  /** How much of the leader's route it bothers examining. */
  lookahead: number;
}

export const TIERS: readonly Tier[] = [
  { label: 'Rookie', sloppiness: 0.55, threshold: 3, reserve: 0, lookahead: 3 },
  { label: 'Runner', sloppiness: 0.12, threshold: 2, reserve: 1, lookahead: 5 },
  { label: 'Architect', sloppiness: 0, threshold: 1, reserve: 2, lookahead: 8 },
];

/** Per-bot memory. Only enough to stop it repeating itself in an obvious way. */
export interface Brain {
  /** Squares it has stood on lately, so a Rookie's dithering does not loop forever. */
  recent: number[];
}

export const newBrain = (): Brain => ({ recent: [] });

/**
 * Every wall slot that could possibly lengthen this route.
 *
 * A step from one square to the next is blocked only by a wall in one of the
 * four slots touching the groove between them, so walking the route and
 * collecting those is exhaustive for "walls that matter" without being
 * anywhere near exhaustive for "walls that exist".
 */
function candidateSlots(
  route: number[],
  from: number,
  depth: number,
  layout: Layout,
): { o: Orientation; r: number; c: number }[] {
  const path = [from, ...route.slice(0, depth)];
  const seen = new Set<number>();
  const out: { o: Orientation; r: number; c: number }[] = [];

  for (let i = 0; i + 1 < path.length; i++) {
    const r = rowOf(path[i]);
    const c = colOf(path[i]);
    const nr = rowOf(path[i + 1]);
    const nc = colOf(path[i + 1]);
    const vertical = nr !== r;
    // The groove crossed by this step, then both slots that can cover it.
    const line = vertical ? Math.min(r, nr) : Math.min(c, nc);
    const along = vertical ? c : r;

    for (const shift of [0, -1]) {
      const slotR = vertical ? line : along + shift;
      const slotC = vertical ? along + shift : line;
      if (slotR < 0 || slotR >= layout.lines || slotC < 0 || slotC >= layout.lines) continue;
      const o: Orientation = vertical ? HORIZONTAL : VERTICAL;
      // `wallCode` rather than a hand-rolled key: the old one packed the slot
      // as `o * 64 + r * 8 + c`, which quietly assumed an eight-groove board
      // and collided the moment one got bigger.
      const key = wallCode(o, slotR, slotC);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ o, r: slotR, c: slotC });
      // The perpendicular wall in the same slot is worth a look too: it does
      // not block this step, but it very often blocks the detour around it.
      const other: Orientation = o === HORIZONTAL ? VERTICAL : HORIZONTAL;
      const otherKey = wallCode(other, slotR, slotC);
      if (!seen.has(otherKey)) {
        seen.add(otherKey);
        out.push({ o: other, r: slotR, c: slotC });
      }
    }
  }
  return out;
}

/**
 * How far this seat's *side* is from winning.
 *
 * In a free-for-all that is just this pawn. In a 2v2 it is whichever partner
 * is closer, because either of them crossing ends the game — a bot that
 * measured only its own route would panic and start walling while its partner
 * was two steps from the line, and would happily drop a wall across that
 * partner's road to do it.
 */
function sideDistance(pos: Position, seat: number, layout: Layout): number {
  let best = -1;
  for (let p = 0; p < layout.players; p++) {
    if (layout.teams ? teamOf(p) !== teamOf(seat) : p !== seat) continue;
    const d = distanceToGoal(pos, p, layout);
    if (d >= 0 && (best < 0 || d < best)) best = d;
  }
  return best;
}

/**
 * The nearest pawn on the other side, and how far its side has to go.
 *
 * `seat` is the pawn worth aiming a wall at; `dist` is the whole opposing
 * side's best route, which is the number that actually decides whether we are
 * losing the race.
 */
function leaderOf(pos: Position, seat: number, layout: Layout): { seat: number; dist: number } {
  let best = -1;
  let bestDist = Infinity;
  for (let p = 0; p < layout.players; p++) {
    // Never treat a partner as the threat, and never wall one.
    if (layout.teams ? teamOf(p) === teamOf(seat) : p === seat) continue;
    const d = distanceToGoal(pos, p, layout);
    if (d >= 0 && d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (best < 0) return { seat: -1, dist: Infinity };
  return { seat: best, dist: layout.teams ? sideDistance(pos, best, layout) : bestDist };
}

/**
 * One move for one bot.
 *
 * Returns an encoded move, always a legal one — there is a plain step
 * underneath every branch, so a bot can never stall the game.
 */
export function chooseMove(
  pos: Position,
  seat: number,
  layout: Layout,
  level: number,
  brain: Brain,
  rng: () => number = Math.random,
): number {
  const tier = TIERS[Math.max(0, Math.min(TIERS.length - 1, level))];
  const options = pawnMoves(pos, seat, layout);
  if (options.length === 0) return encodeStep(pos.pawns[seat]);

  const run = () => {
    const step = stepTowardGoal(pos, seat, layout);
    return encodeStep(step >= 0 ? step : options[0]);
  };

  // A Rookie wanders. It still mostly heads the right way, but it will take a
  // sideways square often enough that a new player can get past it.
  if (rng() < tier.sloppiness) {
    const wander = options.filter((o) => !brain.recent.includes(o));
    const pick = (wander.length > 0 ? wander : options)[Math.floor(rng() * (wander.length || options.length))];
    remember(brain, pick);
    return encodeStep(pick ?? options[0]);
  }

  // My side's route, not merely my own — see `sideDistance`.
  const myDist = sideDistance(pos, seat, layout);
  const leader = leaderOf(pos, seat, layout);

  // Winning the race, or nobody left to race: just run.
  if (leader.seat < 0 || myDist <= 1) return run();

  const spendable = pos.stock[seat] - tier.reserve;
  const behind = myDist - leader.dist;
  // Walls are for when somebody else is going to get there first. A bot that
  // walls while ahead is spending its own tempo to slow a race it is winning.
  if (spendable <= 0 || behind < 0) return run();

  const wall = bestWall(pos, seat, leader.seat, layout, tier, myDist, leader.dist);
  if (wall && wall.gain >= tier.threshold - Math.min(behind, 2)) {
    return encodeWall(wall.o, wall.r, wall.c);
  }
  return run();
}

function bestWall(
  pos: Position,
  seat: number,
  target: number,
  layout: Layout,
  tier: Tier,
  myDist: number,
  targetDist: number,
): { o: Orientation; r: number; c: number; gain: number } | null {
  const route = routeToGoal(pos, target, layout);
  if (route.length === 0) return null;

  const probe = clonePosition(pos);
  let best: { o: Orientation; r: number; c: number; gain: number } | null = null;

  for (const slot of candidateSlots(route, pos.pawns[target], tier.lookahead, layout)) {
    if (!wallLegal(pos, seat, slot.o, slot.r, slot.c, layout)) continue;

    const grid = slot.o === HORIZONTAL ? probe.h : probe.v;
    const i = wallSlot(slot.r, slot.c);
    grid[i] = seat + 1;
    // Both measured per side, so a wall that lengthens the pawn we aimed at
    // but leaves its partner a clear run scores as the near-waste it is.
    const theirs = sideDistance(probe, target, layout);
    const mine = sideDistance(probe, seat, layout);
    grid[i] = 0;

    if (theirs < 0 || mine < 0) continue;
    // What it costs them, less what it costs me. A wall that lengthens my own
    // route as much as theirs has bought nothing but a spent wall.
    const gain = theirs - targetDist - (mine - myDist);
    if (!best || gain > best.gain) best = { ...slot, gain };
  }

  return best;
}

function remember(brain: Brain, square: number) {
  brain.recent.push(square);
  if (brain.recent.length > 4) brain.recent.shift();
}

/** Handy for the turn clock: the move a player would make if they did nothing. */
export function fallbackMove(pos: Position, seat: number, layout: Layout): number {
  const step = stepTowardGoal(pos, seat, layout);
  if (step >= 0) return encodeStep(step);
  const options = pawnMoves(pos, seat, layout);
  return encodeStep(options[0] ?? pos.pawns[seat]);
}
