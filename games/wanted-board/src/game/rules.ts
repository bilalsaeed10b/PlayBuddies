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

/** Locations, in ring order. Index is identity everywhere — on the wire too. */
export interface Place {
  name: string;
  /** One-word flavour under the name on the map. */
  tag: string;
  /** Where it sits on the map, as a percentage of the board box. */
  x: number;
  y: number;
}

/**
 * Six locations in a ring, and you may only ever ride to a neighbour.
 *
 * The ring is the single most important design decision here. Let a player
 * ride anywhere and an ambush becomes a one-in-six guess, which is a dice
 * roll, not a read. Restricted to neighbours, every player has exactly three
 * options each round — stay, left, right — so guessing where somebody goes is
 * a genuine three-way mind game against a person whose position you can see.
 */
export const PLACES: Place[] = [
  { name: 'Saloon', tag: 'loud', x: 50, y: 8 },
  { name: 'Bank', tag: 'cash in here', x: 87, y: 30 },
  { name: 'Mine', tag: 'deep', x: 87, y: 72 },
  { name: 'Canyon', tag: 'no cover', x: 50, y: 94 },
  { name: 'Chapel', tag: 'quiet', x: 13, y: 72 },
  { name: 'Depot', tag: 'rails', x: 13, y: 30 },
];

/** The one place a bounty can be turned into a score nobody can take. */
export const BANK = 1;

export const PLACE_COUNT = PLACES.length;

/** The two neighbours of a place, in ring order. */
export function neighbours(place: number): [number, number] {
  return [(place + PLACE_COUNT - 1) % PLACE_COUNT, (place + 1) % PLACE_COUNT];
}

/** Every place a player at `place` could legally be next round. */
export function reachable(place: number): number[] {
  const [a, b] = neighbours(place);
  return [place, a, b];
}

export type CardId = 'ride' | 'layLow' | 'ambush' | 'trap' | 'cashIn';

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
  cashIn: {
    id: 'cashIn',
    name: 'Cash In',
    blurb: 'Bank every dollar on your head. Safe forever. You are wide open while you do it.',
    needsTarget: false,
    onlyAt: BANK,
  },
};

export const CARD_ORDER: CardId[] = ['ride', 'layLow', 'ambush', 'trap', 'cashIn'];

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
];

export type PlayerCount = 2 | 3 | 4;

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
 * Where each seat starts, spread as evenly around the ring as the count allows.
 *
 * Never on the Bank: opening the game with somebody already standing on the
 * one square that matters is a free half-lap nobody else gets.
 */
export function startPlaces(players: number): number[] {
  const step = PLACE_COUNT / players;
  const out: number[] = [];
  for (let i = 0; i < players; i++) {
    let place = Math.round(i * step) % PLACE_COUNT;
    if (place === BANK) place = (place + 1) % PLACE_COUNT;
    out.push(place);
  }
  return out;
}
