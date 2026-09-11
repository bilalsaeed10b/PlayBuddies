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
  applyMove,
  clonePosition,
  colOf,
  distanceToGoal,
  encodeStep,
  encodeWall,
  isWallMove,
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
  /** Stops a bot spending the whole opening repeating the same marginal wall idea. */
  lastAction?: 'step' | 'wall';
  wallsPlaced?: number;
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

interface SearchMove {
  move: number;
  /** Immediate score for move ordering; the tree still decides the real value. */
  order: number;
  /** Net route steps bought by a wall, or Infinity for a pawn move. */
  wallGain: number;
}

interface SearchContext {
  deadline: number;
  nodes: number;
  cache: Map<number, number>;
}

/** A compact state key for the Grandmaster's per-turn transposition table. */
function positionKey(pos: Position, turn: number, depth: number): number {
  let hash = 2166136261;
  const add = (value: number) => {
    hash ^= value + 1;
    hash = Math.imul(hash, 16777619);
  };
  add(turn);
  add(depth);
  for (const pawn of pos.pawns) add(pawn);
  for (const stock of pos.stock) add(stock);
  for (let i = 0; i < pos.h.length; i++) {
    if (pos.h[i]) {
      add(i + 173);
      add(pos.h[i]);
    }
    if (pos.v[i]) {
      add(i + 349);
      add(pos.v[i]);
    }
  }
  return hash >>> 0;
}

/**
 * Chess-engine style move generation: every pawn step plus the strongest
 * legal walls touching an enemy's route. Keeping only the best wall candidates
 * makes alpha-beta deep enough to matter without freezing a phone.
 */
function searchMoves(pos: Position, turn: number, layout: Layout, wallCap: number): SearchMove[] {
  const out: SearchMove[] = [];
  for (const target of pawnMoves(pos, turn, layout)) {
    const next = clonePosition(pos);
    next.pawns[turn] = target;
    out.push({ move: encodeStep(target), order: strategicScore(next, turn, layout), wallGain: Infinity });
  }
  if ((pos.stock[turn] ?? 0) <= 0 || wallCap <= 0) return out;

  const myDist = sideDistance(pos, turn, layout);
  const threatDist = leaderOf(pos, turn, layout).dist;
  const seen = new Set<number>();
  const walls: SearchMove[] = [];
  for (let target = 0; target < layout.players; target++) {
    if (layout.teams ? teamOf(target) === teamOf(turn) : target === turn) continue;
    const route = routeToGoal(pos, target, layout);
    for (const slot of candidateSlots(route, pos.pawns[target], route.length, layout)) {
      const code = wallCode(slot.o, slot.r, slot.c);
      if (seen.has(code)) continue;
      seen.add(code);
      if (!wallLegal(pos, turn, slot.o, slot.r, slot.c, layout)) continue;
      const next = clonePosition(pos);
      const move = encodeWall(slot.o, slot.r, slot.c);
      applyMove(next, turn, move);
      const nextMine = sideDistance(next, turn, layout);
      const nextThreat = leaderOf(next, turn, layout).dist;
      const wallGain = nextThreat - threatDist - (nextMine - myDist);
      walls.push({ move, order: strategicScore(next, turn, layout) + wallGain * 2, wallGain });
    }
  }
  walls.sort((a, b) => b.order - a.order);
  out.push(...walls.slice(0, wallCap));
  return out;
}

function treeScore(
  pos: Position,
  turn: number,
  perspective: number,
  layout: Layout,
  depth: number,
  alpha: number,
  beta: number,
  context: SearchContext,
): number | null {
  if ((context.nodes++ & 31) === 0 && Date.now() >= context.deadline) return null;
  const standing = strategicScore(pos, perspective, layout);
  if (depth <= 0 || Math.abs(standing) >= 100_000) return standing;

  const key = positionKey(pos, turn, depth);
  const cached = context.cache.get(key);
  if (cached !== undefined) return cached;

  const friendly = layout.teams ? teamOf(turn) === teamOf(perspective) : turn === perspective;
  const wallCap = depth >= 3 ? 5 : 8;
  const actions = searchMoves(pos, turn, layout, wallCap);
  if (actions.length === 0) return standing;
  actions.sort((a, b) => friendly ? b.order - a.order : a.order - b.order);

  let best = friendly ? -Infinity : Infinity;
  let cut = false;
  for (const action of actions) {
    const next = clonePosition(pos);
    applyMove(next, turn, action.move);
    const value = treeScore(
      next,
      (turn + 1) % layout.players,
      perspective,
      layout,
      depth - 1,
      alpha,
      beta,
      context,
    );
    if (value === null) return null;
    if (friendly) {
      best = Math.max(best, value);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, value);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) {
      cut = true;
      break;
    }
  }
  // A cut node is a bound rather than an exact score, so only cache complete
  // nodes. This keeps repeated positions fast without poisoning later branches.
  if (!cut) context.cache.set(key, best);
  return best;
}

function chooseGrandmasterMove(
  pos: Position,
  seat: number,
  layout: Layout,
  brain: Brain,
  rng: () => number,
): number {
  const threat = leaderOf(pos, seat, layout);
  const urgent = threat.dist <= 2;
  const context: SearchContext = {
    deadline: Date.now() + (layout.players === 2 ? 180 : 140),
    nodes: 0,
    cache: new Map(),
  };
  let actions = searchMoves(pos, seat, layout, 16);
  // Once the opening setup is built, a wall must buy at least two route steps.
  // Emergency blocks remain available regardless of their immediate gain.
  if (!urgent && (brain.wallsPlaced ?? 0) > 0) {
    const disciplined = actions.filter((action) => !isWallMove(action.move) || action.wallGain >= 2);
    if (disciplined.length > 0) actions = disciplined;
  }
  if (actions.length === 0) return encodeStep(pos.pawns[seat]);

  actions.sort((a, b) => b.order - a.order);
  // Like a chess opening book: choose one of several sound setup walls before
  // calculation takes over. Only the first bot move can use the book, and the
  // root filter above prevents it turning that opening into a repeated lock.
  const untouchedWalls = pos.stock.every((stock) => stock === layout.walls);
  const pawnsNearHome = pos.pawns.every((pawn, player) => {
    const start = layout.sides[player].start;
    return Math.abs(rowOf(pawn) - rowOf(start)) + Math.abs(colOf(pawn) - colOf(start)) <= 1;
  });
  const freshOpening = brain.recent.length === 0
    && (brain.wallsPlaced ?? 0) === 0
    && untouchedWalls
    && pawnsNearHome;
  const bookWalls = freshOpening
    ? actions.filter((action) => isWallMove(action.move) && action.wallGain >= 0).slice(0, 6)
    : [];
  if (bookWalls.length > 0 && rng() < 0.32) {
    const chosen = bookWalls[Math.min(bookWalls.length - 1, Math.floor(rng() * bookWalls.length))];
    brain.lastAction = 'wall';
    brain.wallsPlaced = 1;
    return chosen.move;
  }
  let completed: { move: number; score: number }[] = actions.map((action) => ({
    move: action.move,
    score: action.order,
  }));

  // Iterative deepening always leaves a complete answer available. On a fast
  // machine it reaches four plies; on a phone it returns the last finished
  // depth rather than stalling the match halfway through a calculation.
  for (let depth = 2; depth <= 4; depth++) {
    const round: { move: number; score: number }[] = [];
    let finished = true;
    for (const action of actions) {
      const next = clonePosition(pos);
      applyMove(next, seat, action.move);
      const score = treeScore(
        next,
        (seat + 1) % layout.players,
        seat,
        layout,
        depth - 1,
        -Infinity,
        Infinity,
        context,
      );
      if (score === null) {
        finished = false;
        break;
      }
      round.push({ move: action.move, score });
    }
    if (!finished) break;
    completed = round;
    completed.sort((a, b) => b.score - a.score);
    const order = new Map(completed.map((choice, i) => [choice.move, i]));
    actions.sort((a, b) => (order.get(a.move) ?? 999) - (order.get(b.move) ?? 999));
  }

  const best = Math.max(...completed.map((choice) => choice.score));
  const sound = completed.filter((choice) => choice.score >= best - 0.2);
  const chosen = sound[Math.min(sound.length - 1, Math.floor(rng() * sound.length))] ?? completed[0];
  if (isWallMove(chosen.move)) {
    brain.lastAction = 'wall';
    brain.wallsPlaced = (brain.wallsPlaced ?? 0) + 1;
  } else {
    brain.lastAction = 'step';
    remember(brain, chosen.move);
  }
  return chosen.move;
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
    brain.lastAction = 'step';
    return encodeStep(winning);
  }
  if (level >= TIERS.length - 1) return chooseGrandmasterMove(pos, seat, layout, brain, rng);

  const run = () => {
    const direct = stepTowardGoal(pos, seat, layout);
    const step = tier.planningDepth > 0
      ? plannedStep(pos, seat, layout, tier, brain, rng)
      : direct >= 0 ? direct : options[0];
    remember(brain, step);
    brain.lastAction = 'step';
    return encodeStep(step);
  };

  // A Rookie wanders. It still mostly heads the right way, but it will take a
  // sideways square often enough that a new player can get past it.
  if (rng() < tier.sloppiness) {
    const wander = options.filter((o) => !brain.recent.includes(o));
    const pick = (wander.length > 0 ? wander : options)[Math.floor(rng() * (wander.length || options.length))];
    remember(brain, pick);
    brain.lastAction = 'step';
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
  const urgent = leader.dist <= 2;
  const advanced = tier.planningDepth > 0;
  // Moving normally gains one race step. A wall that adds only one step to an
  // opponent is therefore a tempo trade, not an advantage. Advanced bots may
  // mix in one such setup wall for opening variety, but never build the same
  // slow lock turn after turn unless the opponent is about to cross the line.
  const requiredGain = urgent ? 1 : behind > 0 ? 1 : advanced ? 2 : tier.threshold;
  const setupWall = advanced
    && behind === 0
    && (brain.wallsPlaced ?? 0) === 0
    && wall?.gain === 1
    && rng() < 0.35;
  const repeatedMarginalWall = !urgent && brain.lastAction === 'wall' && wall?.gain === 1;
  if (wall && !repeatedMarginalWall && (wall.gain >= requiredGain || setupWall)) {
    brain.lastAction = 'wall';
    brain.wallsPlaced = (brain.wallsPlaced ?? 0) + 1;
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
