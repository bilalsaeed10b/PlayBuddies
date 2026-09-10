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
 * route, because a wall anywhere else cannot lengthen it , which cuts a few
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
  /** Pawn plies searched before choosing a step. Zero keeps the classic shortest-route runner. */
  planningDepth: number;
  /** How many steps ahead it may be and still invest in a useful blocking wall. */
  wallLead: number;
  /** Score range in which equally sound plans may be varied. */
  variety: number;
  /** How many route slots to inspect when anticipating the next enemy wall. */
  replyWalls: number;
}

export const TIERS: readonly Tier[] = [
  { label: 'Rookie', sloppiness: 0.55, threshold: 3, reserve: 0, lookahead: 3, planningDepth: 0, wallLead: 0, variety: 0, replyWalls: 0 },
  { label: 'Runner', sloppiness: 0.12, threshold: 2, reserve: 1, lookahead: 5, planningDepth: 0, wallLead: 0, variety: 0, replyWalls: 0 },
  { label: 'Architect', sloppiness: 0, threshold: 1, reserve: 2, lookahead: 8, planningDepth: 0, wallLead: 0, variety: 0, replyWalls: 0 },
  { label: 'Strategist', sloppiness: 0, threshold: 1, reserve: 2, lookahead: 12, planningDepth: 2, wallLead: 1, variety: 1.25, replyWalls: 0 },
  { label: 'Mastermind', sloppiness: 0, threshold: 1, reserve: 1, lookahead: 18, planningDepth: 4, wallLead: 2, variety: 0.75, replyWalls: 8 },
  { label: 'Grandmaster', sloppiness: 0, threshold: 0.5, reserve: 0, lookahead: 32, planningDepth: 6, wallLead: 4, variety: 0.3, replyWalls: 18 },
];

/** Per-bot memory. Only enough to stop it repeating itself in an obvious way. */
export interface Brain {
  /** Squares it has stood on lately, so a Rookie's dithering does not loop forever. */
  recent: number[];
  /** A lasting lane preference gives each advanced bot a recognisable style. */
  style?: number;
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
 * is closer, because either of them crossing ends the game , a bot that
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

/** A board score from one seat's point of view; larger means its side is closer to winning. */
function strategicScore(pos: Position, seat: number, layout: Layout): number {
  const mine = sideDistance(pos, seat, layout);
  const threat = leaderOf(pos, seat, layout);
  if (mine === 0) return 100_000;
  if (threat.dist === 0) return -100_000;

  let friendlyWalls = 0;
  let enemyWalls = 0;
  for (let i = 0; i < layout.players; i++) {
    const friendly = layout.teams ? teamOf(i) === teamOf(seat) : i === seat;
    if (friendly) friendlyWalls += pos.stock[i] ?? 0;
    else enemyWalls += pos.stock[i] ?? 0;
  }
  return (threat.dist - mine) * 24 + (friendlyWalls - enemyWalls) * 0.35;
}

/**
 * Small alpha-beta search over pawn moves. Walls are scored separately below;
 * this search stops the strongest bots taking an obvious shortest-path step
 * that gives the next opponent a jump or leaves a partner blocking the lane.
 */
function searchPawnMoves(
  pos: Position,
  turn: number,
  seat: number,
  layout: Layout,
  depth: number,
  alpha: number,
  beta: number,
): number {
  if (depth <= 0) return strategicScore(pos, seat, layout);
  const options = pawnMoves(pos, turn, layout);
  if (options.length === 0) return strategicScore(pos, seat, layout);
  const friendly = layout.teams ? teamOf(turn) === teamOf(seat) : turn === seat;
  let best = friendly ? -Infinity : Infinity;

  for (const target of options) {
    const next = clonePosition(pos);
    next.pawns[turn] = target;
    const terminal = strategicScore(next, seat, layout);
    const value = Math.abs(terminal) >= 100_000
      ? terminal
      : searchPawnMoves(next, (turn + 1) % layout.players, seat, layout, depth - 1, alpha, beta);
    if (friendly) {
      best = Math.max(best, value);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, value);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }
  return best;
}

function plannedStep(
  pos: Position,
  seat: number,
  layout: Layout,
  tier: Tier,
  brain: Brain,
  rng: () => number,
): number {
  const options = pawnMoves(pos, seat, layout);
  if (brain.style === undefined) brain.style = rng() * 2 - 1;
  const home = layout.sides[seat].home;
  const lateral = (square: number) => home === 'north' || home === 'south' ? colOf(square) : rowOf(square);
  const centre = (layout.size - 1) / 2;
  const scores: { target: number; score: number }[] = [];
  let bestScore = -Infinity;
  for (const target of options) {
    const next = clonePosition(pos);
    next.pawns[seat] = target;
    const terminal = strategicScore(next, seat, layout);
    let score = Math.abs(terminal) >= 100_000
      ? terminal
      : searchPawnMoves(next, (seat + 1) % layout.players, seat, layout, tier.planningDepth - 1, -Infinity, Infinity);
    if (tier.replyWalls > 0 && Math.abs(score) < 100_000) {
      score = Math.min(score, worstEnemyReply(next, (seat + 1) % layout.players, seat, layout, tier.replyWalls));
    }
    if (brain.recent.includes(target)) score -= 0.4;
    // This only separates near-ties. It is deliberately far smaller than the
    // value of gaining one route step, so personality never replaces tactics.
    score += brain.style * ((lateral(target) - centre) / layout.size) * 0.22;
    scores.push({ target, score });
    bestScore = Math.max(bestScore, score);
  }
  const sound = scores.filter((option) => option.score >= bestScore - tier.variety);
  return sound[Math.min(sound.length - 1, Math.floor(rng() * sound.length))]?.target
    ?? options[0]
    ?? pos.pawns[seat];
}

/** The strongest immediate pawn-or-wall answer available to the next enemy. */
function worstEnemyReply(
  pos: Position,
  turn: number,
  seat: number,
  layout: Layout,
  wallLimit: number,
): number {
  let worst = Infinity;
  for (const target of pawnMoves(pos, turn, layout)) {
    const reply = clonePosition(pos);
    reply.pawns[turn] = target;
    worst = Math.min(worst, strategicScore(reply, seat, layout));
  }
  if ((pos.stock[turn] ?? 0) <= 0) return worst;

  const seen = new Set<number>();
  let checked = 0;
  for (let friendly = 0; friendly < layout.players && checked < wallLimit; friendly++) {
    if (layout.teams ? teamOf(friendly) !== teamOf(seat) : friendly !== seat) continue;
    const route = routeToGoal(pos, friendly, layout);
    for (const slot of candidateSlots(route, pos.pawns[friendly], route.length, layout)) {
      const key = wallCode(slot.o, slot.r, slot.c);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!wallLegal(pos, turn, slot.o, slot.r, slot.c, layout)) continue;
      const reply = clonePosition(pos);
      const grid = slot.o === HORIZONTAL ? reply.h : reply.v;
      grid[wallSlot(slot.r, slot.c)] = turn + 1;
      reply.stock[turn]--;
      worst = Math.min(worst, strategicScore(reply, seat, layout));
      if (++checked >= wallLimit) break;
    }
  }
  return worst === Infinity ? strategicScore(pos, seat, layout) : worst;
}

/**
 * One move for one bot.
 *
 * Returns an encoded move, always a legal one , there is a plain step
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
  const winning = options.find((target) => layout.sides[seat].goal(rowOf(target), colOf(target)));
  if (winning !== undefined) {
    remember(brain, winning);
    return encodeStep(winning);
  }

  const run = () => {
    const direct = stepTowardGoal(pos, seat, layout);
    const step = tier.planningDepth > 0
      ? plannedStep(pos, seat, layout, tier, brain, rng)
      : direct >= 0 ? direct : options[0];
    remember(brain, step);
    return encodeStep(step);
  };

  // A Rookie wanders. It still mostly heads the right way, but it will take a
  // sideways square often enough that a new player can get past it.
  if (rng() < tier.sloppiness) {
    const wander = options.filter((o) => !brain.recent.includes(o));
    const pick = (wander.length > 0 ? wander : options)[Math.floor(rng() * (wander.length || options.length))];
    remember(brain, pick);
    return encodeStep(pick ?? options[0]);
  }

  // My side's route, not merely my own , see `sideDistance`.
  const myDist = sideDistance(pos, seat, layout);
  const leader = leaderOf(pos, seat, layout);

  // Winning the race, or nobody left to race: just run.
  if (leader.seat < 0 || myDist <= 1) return run();

  const spendable = pos.stock[seat] - tier.reserve;
  const behind = myDist - leader.dist;
  // Walls are for when somebody else is going to get there first. A bot that
  // walls while ahead is spending its own tempo to slow a race it is winning.
  if (spendable <= 0 || behind < -tier.wallLead) return run();

  const wall = bestWall(pos, seat, layout, tier, myDist, leader.dist, rng);
  if (wall && wall.gain > 0 && wall.gain >= tier.threshold - Math.min(Math.max(behind, 0), 2)) {
    return encodeWall(wall.o, wall.r, wall.c);
  }
  return run();
}

function bestWall(
  pos: Position,
  seat: number,
  layout: Layout,
  tier: Tier,
  myDist: number,
  targetDist: number,
  rng: () => number,
): { o: Orientation; r: number; c: number; gain: number } | null {
  const probe = clonePosition(pos);
  const before = strategicScore(pos, seat, layout);
  const candidates: { o: Orientation; r: number; c: number; gain: number; score: number }[] = [];
  const seen = new Set<number>();

  // In team games the farther enemy can become the leader after one wall, so
  // advanced bots inspect every enemy route instead of tunnelling on one pawn.
  const slots: { o: Orientation; r: number; c: number }[] = [];
  for (let target = 0; target < layout.players; target++) {
    if (layout.teams ? teamOf(target) === teamOf(seat) : target === seat) continue;
    const route = routeToGoal(pos, target, layout);
    for (const slot of candidateSlots(route, pos.pawns[target], tier.lookahead, layout)) {
      const key = wallCode(slot.o, slot.r, slot.c);
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push(slot);
    }
  }

  for (const slot of slots) {
    if (!wallLegal(pos, seat, slot.o, slot.r, slot.c, layout)) continue;

    const grid = slot.o === HORIZONTAL ? probe.h : probe.v;
    const i = wallSlot(slot.r, slot.c);
    grid[i] = seat + 1;
    // Both measured per side, so a wall that lengthens the pawn we aimed at
    // but leaves its partner a clear run scores as the near-waste it is.
    const theirs = leaderOf(probe, seat, layout).dist;
    const mine = sideDistance(probe, seat, layout);

    if (theirs < 0 || mine < 0) {
      grid[i] = 0;
      continue;
    }
    // What it costs them, less what it costs me. A wall that lengthens my own
    // route as much as theirs has bought nothing but a spent wall.
    const gain = theirs - targetDist - (mine - myDist);
    const score = gain + (strategicScore(probe, seat, layout) - before) / 24;
    grid[i] = 0;
    if (gain > 0) candidates.push({ ...slot, gain, score });
  }
  if (candidates.length === 0) return null;
  const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
  const sound = candidates.filter((candidate) => candidate.score >= bestScore - tier.variety);
  return sound[Math.min(sound.length - 1, Math.floor(rng() * sound.length))] ?? null;
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
