/**
 * Every number and every rule the town runs on, in one file.
 *
 * The engine reads these and nothing else, so a balance change is a one-line
 * edit here rather than a hunt through the resolver.
 *
 * The whole game is one tension, and every number below exists to sharpen it:
 * your bounty grows while you run, but it is only *yours* once it is banked,
 * and banking means standing still in the one building everybody knows you
 * have to visit. Anything that makes running safer, or banking cheaper, makes
 * the game worse.
 */

/** A location on the board. Index is identity everywhere — on the wire too. */
export interface Place {
  name: string;
  /** One-word flavour under the name on the map. */
  tag: string;
  /** Where it sits on the map, as a percentage of the board box. */
  x: number;
  y: number;
}

/**
 * Nine locations: the Bank at the centre of town, eight more around it.
 *
 * This used to be six places in a plain ring, and every ride was a choice of
 * exactly two directions. It is a wagon wheel now: the outer eight still
 * connect only to their two neighbours around the rim, but four of them —
 * Saloon, Mine, Canyon, Chapel — also sit on a spoke straight to the Bank.
 * That is the whole idea. A spoke place has a fast, exposed line to the money
 * and more directions to be read from; a rim-only place (Depot, Jail,
 * Graveyard, Livery) is quieter and harder to predict, but every trip to the
 * Bank costs it a lap around the rim or a walk through somebody else's spoke.
 * "Which kind of place am I standing in" is now a real part of the read, on
 * top of "which way did they go."
 */
export const PLACES: Place[] = [
  { name: 'Bank', tag: 'cash in here', x: 50, y: 50 },
  { name: 'Saloon', tag: 'loud', x: 50, y: 8 },
  { name: 'Depot', tag: 'rails', x: 79.7, y: 20.3 },
  { name: 'Mine', tag: 'deep', x: 92, y: 50 },
  { name: 'Jail', tag: 'iron bars', x: 79.7, y: 79.7 },
  { name: 'Canyon', tag: 'no cover', x: 50, y: 92 },
  { name: 'Graveyard', tag: 'no witnesses', x: 20.3, y: 79.7 },
  { name: 'Chapel', tag: 'quiet', x: 8, y: 50 },
  { name: 'Livery', tag: 'fast horses', x: 20.3, y: 20.3 },
];

/** The one place a bounty can be turned into a score nobody can take. */
export const BANK = 0;

export const PLACE_COUNT = PLACES.length;

/**
 * Every direct edge, each listed once. Everything else — legal moves,
 * shortest paths, the roads drawn on the map and in the guide — is derived
 * from this.
 */
export const ROADS: [number, number][] = [
  // the rim
  [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 1],
  // the spokes
  [0, 1], [0, 3], [0, 5], [0, 7],
];

const ADJACENCY: number[][] = PLACES.map(() => []);
for (const [a, b] of ROADS) {
  ADJACENCY[a].push(b);
  ADJACENCY[b].push(a);
}
for (const list of ADJACENCY) list.sort((a, b) => a - b);

/** All places directly reachable from `place` by one ride. Not sorted by distance — sorted by index, for a stable UI. */
export function neighbours(place: number): number[] {
  return ADJACENCY[place] ?? [];
}

/** Every place a player at `place` could legally ride or trap this round. */
export function reachable(place: number): number[] {
  return [place, ...neighbours(place)];
}

/**
 * All-pairs shortest hop count, and the first hop of a shortest path between
 * any two places — both computed once, from the fixed graph above, rather
 * than on every call. Nine places makes this nine tiny breadth-first
 * searches at module load; nothing here ever runs again mid-match.
 */
const DIST: number[][] = PLACES.map(() => new Array(PLACE_COUNT).fill(Infinity));
/** NEXT_STEP[from][to] = the neighbour of `from` that starts a shortest path to `to`. */
const NEXT_STEP: number[][] = PLACES.map(() => new Array(PLACE_COUNT).fill(-1));

for (let source = 0; source < PLACE_COUNT; source++) {
  const dist = DIST[source];
  dist[source] = 0;
  const queue = [source];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    for (const next of ADJACENCY[at]) {
      if (dist[next] !== Infinity) continue;
      dist[next] = dist[at] + 1;
      queue.push(next);
    }
  }
}
// Second pass, from the *destination* this time: the first hop of a shortest
// from->to path is whichever neighbour of `from` is one step closer to `to`
// than `from` itself is — ties broken by lowest index, so every client that
// runs this arrives at the identical answer.
for (let to = 0; to < PLACE_COUNT; to++) {
  for (let from = 0; from < PLACE_COUNT; from++) {
    if (from === to) continue;
    let best = -1;
    for (const next of ADJACENCY[from]) {
      if (DIST[next][to] !== DIST[from][to] - 1) continue;
      if (best === -1 || next < best) best = next;
    }
    NEXT_STEP[from][to] = best;
  }
}

/** Hops from `place` to the Bank. Drives both the HUD and the bots. */
export function distanceToBank(place: number): number {
  return DIST[place]?.[BANK] ?? 0;
}

/** The neighbour to head to from `from` that starts the shortest ride to `to`. */
export function stepToward(from: number, to: number): number {
  if (from === to) return from;
  return NEXT_STEP[from]?.[to] ?? from;
}

/** Every place reachable from `place` in exactly two hops — not one, not `place` itself. */
export function twoHopTargets(place: number): number[] {
  const one = new Set(ADJACENCY[place] ?? []);
  const out = new Set<number>();
  for (const mid of ADJACENCY[place] ?? []) {
    for (const far of ADJACENCY[mid]) {
      if (far !== place && !one.has(far)) out.add(far);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export type CardId = 'ride' | 'gallop' | 'layLow' | 'ambush' | 'trap' | 'scout' | 'cashIn';

export interface CardMeta {
  id: CardId;
  name: string;
  /** One line on the card face. Has to say what it does, not what it feels like. */
  blurb: string;
  /** Does this card need the player to pick a destination? */
  needsTarget: boolean;
  /** Only legal standing in one specific place. `null` when it is legal anywhere. */
  onlyAt: number | null;
}

export const CARDS: Record<CardId, CardMeta> = {
  ride: {
    id: 'ride',
    name: 'Ride',
    blurb: 'Move to a neighbouring place. Pays the most — and walks you into whatever is waiting there.',
    needsTarget: true,
    onlyAt: null,
  },
  gallop: {
    id: 'gallop',
    name: 'Full Gallop',
    blurb: 'Ride two places down the road in one go, straight past whatever is in between. Pays less than a plain Ride.',
    needsTarget: true,
    onlyAt: null,
  },
  layLow: {
    id: 'layLow',
    name: 'Lay Low',
    blurb: 'Stay put and out of sight. Nothing can touch you. Pays almost nothing.',
    needsTarget: false,
    onlyAt: null,
  },
  ambush: {
    id: 'ambush',
    name: 'Ambush',
    blurb: 'Wait here with a gun. Take the whole bounty off anyone who is here and not hidden. Costs you if nobody shows.',
    needsTarget: false,
    onlyAt: null,
  },
  trap: {
    id: 'trap',
    name: 'Set Trap',
    blurb: 'Rig a neighbouring place. Springs NEXT round on the first soul through, for half their bounty. Nobody can see it.',
    needsTarget: true,
    onlyAt: null,
  },
  scout: {
    id: 'scout',
    name: 'Scout',
    blurb: 'Send word ahead. Pays little, but you learn exactly where the biggest bounty in town is standing right now.',
    needsTarget: false,
    onlyAt: null,
  },
  cashIn: {
    id: 'cashIn',
    name: 'Cash In',
    blurb: 'Bank every dollar on your head. Safe forever. You are wide open while you do it.',
    needsTarget: false,
    onlyAt: BANK,
  },
};

export const CARD_ORDER: CardId[] = ['ride', 'gallop', 'layLow', 'ambush', 'trap', 'scout', 'cashIn'];

/** One glyph per card. Shared by the rack, the reveal and the guide, so all three draw the same symbol. */
export const CARD_GLYPH: Record<CardId, string> = {
  ride: '→',
  gallop: '⇒',
  layLow: '▽',
  ambush: '✷',
  trap: '⊘',
  scout: '◎',
  cashIn: '$',
};

export const BALANCE = {
  /**
   * What each card pays into your bounty, before anything is stolen.
   *
   * Riding pays by far the most because riding is the only card that puts you
   * somewhere you can be ambushed *and* whose destination the table can read
   * off the map. Laying low is the safe card, so it pays a pittance: a player
   * who could hide every round and still climb would never have to gamble,
   * and the gamble is the game.
   */
  PAY_RIDE: 130,
  /**
   * A Gallop covers two hops and, by riding straight through whatever is on
   * the place in between, sidesteps any trap or ambush waiting there — which
   * is exactly the situation it exists for. Priced below a plain Ride so that
   * edge never becomes strictly better money on top of being strictly safer.
   */
  PAY_GALLOP: 80,
  /**
   * Hiding pays badly, but not so badly that it is never worth it.
   *
   * Lay Low is the only hard counter to an ambush, so it has to stay a live
   * option or ambushing becomes free money — which is exactly what happened
   * at 40: bot tables settled into everyone standing still robbing each other,
   * 60% of all cards played were Ambush, and a whole game's winner banked $161
   * because nobody ever accumulated anything to bank.
   */
  PAY_LAY_LOW: 55,
  PAY_TRAP: 20,
  /**
   * Scouting pays less than hiding — its value is the information, not the
   * money — and it does not hide you: you are exactly as exposed as anyone
   * standing still without a gun drawn.
   */
  PAY_SCOUT: 25,
  /**
   * Ambushing and catching nobody.
   *
   * Deliberately more than a ride pays. An ambush has to be a bet you can
   * lose, not a free look: at -60 the arithmetic said "wait for somebody"
   * almost every round, and a game where one card is nearly always correct
   * has no decisions left in it.
   */
  AMBUSH_MISS: -150,

  /** An ambush takes everything. A trap takes half — it is cheap and delayed. */
  TRAP_TAKE: 0.5,

  /**
   * Bank this much and the game ends the moment the round does.
   *
   * Tuned so a clean run is about four bankings: ride a lap building a bounty,
   * cash it, repeat. Enough rounds for the table to learn your habits and
   * start meeting you at the Bank.
   */
  TARGET_BANKED: 1000,

  /** If nobody hits the target, the richest banked player takes it after this many rounds. */
  ROUNDS: 12,

  /** Seconds to lock a card in before one is chosen for you. */
  ROUND_SECONDS: 20,

  /**
   * What a player who ran out of clock does.
   *
   * Deliberately the safe, boring card rather than a random one: a timeout is
   * usually a phone that locked or a player still reading, and neither of them
   * consented to a gamble. Laying low costs them tempo and nothing else.
   */
  TIMEOUT_CARD: 'layLow' as CardId,
} as const;

/** Seat colours. Index is the seat, not the skin. */
export const SEAT_COLORS = [
  { name: 'Rust', main: '#e0453c', light: '#ff9d94', dark: '#7f1d1d' },
  { name: 'Cobalt', main: '#3b82f6', light: '#93c5fd', dark: '#1e3a8a' },
  { name: 'Sage', main: '#22c55e', light: '#86efac', dark: '#14532d' },
  { name: 'Amber', main: '#f59e0b', light: '#fcd34d', dark: '#78350f' },
  { name: 'Violet', main: '#8b5cf6', light: '#c4b5fd', dark: '#4c1d95' },
  { name: 'Teal', main: '#14b8a6', light: '#5eead4', dark: '#134e4a' },
];

export type PlayerCount = 2 | 3 | 4 | 5 | 6;

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Deterministic PRNG.
 *
 * Bots must decide the same thing on every client that computes them, and the
 * opening layout has to match everywhere, so every random thing in a match is
 * a pure function of the match seed and the round number. Math.random would
 * put two clients in different towns within one round.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where each seat starts, spread as evenly around the rim as the count allows.
 *
 * Always a rim place, never the Bank and never a spoke place — starting
 * anyone already on a fast lane to the money, or on the one square that
 * matters, is a free head start nobody else gets. The rim alone has eight
 * places, plenty of room to spread six players out.
 */
const START_RING = [1, 2, 3, 4, 5, 6, 7, 8];

export function startPlaces(players: number): number[] {
  const ringLen = START_RING.length;
  const step = ringLen / players;
  const out: number[] = [];
  for (let i = 0; i < players; i++) {
    out.push(START_RING[Math.round(i * step) % ringLen]);
  }
  return out;
}
