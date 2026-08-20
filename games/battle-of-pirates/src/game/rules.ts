/**
 * Every number the battle is made of, in one file.
 *
 * The engine reads these and nothing else, so a balance change is a one-line
 * edit here rather than a hunt through the simulation. Where REQUIREMENTS.md
 * quotes a figure, it is this figure.
 */

export interface Arena {
  w: number;
  h: number;
  /** Waterline. Hulls sit on it; anything below is sea. */
  seaY: number;
  /** Where each ship would sit with no drift. */
  anchor: [number, number];
}

/**
 * One arena, always fully visible.
 *
 * There is no camera. Both ships and the whole arc between them are on screen
 * at all times, because an artillery game where you cannot see the target is
 * a guessing game, and a scrolling view on a phone is unreadable anyway.
 * The generous headroom is deliberate: a lofted mortar leaves the top of the
 * frame, and an off-screen ball needs somewhere to be.
 */
export const ARENA: Arena = {
  w: 1600,
  h: 900,
  seaY: 690,
  anchor: [300, 1300],
};

export const BALANCE = {
  GRAVITY: 1400,
  /** Speed at full power, in world px/s. */
  MAX_SPEED: 1760,
  /** Minimum, so a fumbled tap still leaves the barrel. */
  MIN_SPEED: 300,
  /** Sideways acceleration per unit of wind (wind runs -1 to 1). */
  WIND_ACCEL: 160,
  BALL_R: 15,
  /** Nothing may fly forever. A shot that has not landed by now is a miss. */
  MAX_FLIGHT: 14,

  MAX_HP: 100,
  /** A clean hull strike with a plain round. Roughly five to sink a ship. */
  DIRECT: 22,
  /** Splash reach. A near miss in the water still rattles the hull. */
  BLAST_R: 140,
  /** Splash damage at zero distance, falling linearly to nothing at BLAST_R. */
  BLAST: 15,
  /** Your own hull counts. It hurts half as much, which is mercy enough. */
  SELF_MULT: 0.5,
  /** Ceiling on any single resolution, used to clamp what a peer claims. */
  MAX_TURN_DAMAGE: 62,
  BURN_PER_TURN: 7,

  HULL_W: 224,
  HULL_H: 78,
  /** Muzzle offset from the hull centre, toward the enemy. */
  MUZZLE_X: 74,
  MUZZLE_Y: -46,
  /** How far a ship may wander from its anchor, and how far per turn. */
  DRIFT_MAX: 135,
  DRIFT_STEP: 62,
  /** Real on the hitbox, not just paint. See REQUIREMENTS section 4. */
  BOB_AMP: 10,
  BOB_SPEED: 1.35,

  ROCK_MIN: 1,
  ROCK_MAX: 3,

  /** Seconds a player gets to aim before the shot goes off on its own. */
  TURN_TIME: 30,
  /** Beat between the explosion settling and the next player getting the helm. */
  IMPACT_HOLD: 1.35,
  /** How long the bot pretends to think, so a shot never appears from nowhere. */
  BOT_THINK: 1.1,
  /** Wind can change by at most this much between turns. */
  WIND_STEP: 0.55,
  WIND_MAX: 1,
} as const;

export const TEAM_COLORS: Record<0 | 1, { name: string; main: string; light: string; dark: string }> = {
  0: { name: 'Crimson', main: '#e0453c', light: '#ff8a7d', dark: '#7f1d1d' },
  1: { name: 'Cobalt', main: '#3b82f6', light: '#93c5fd', dark: '#1e3a8a' },
};

// ── cards ──────────────────────────────────────────────────────────────────

export type CardId = 'round' | 'chain' | 'grape' | 'mortar' | 'firebomb' | 'patch' | 'bore';

export interface CardMeta {
  id: CardId;
  name: string;
  glyph: string;
  blurb: string;
  /** Relative chance of being dealt. Round shot is the floor you fall back to. */
  weight: number;
  /** Projectiles fired, and how wide they fan out, in radians. */
  shots: number;
  spread: number;
  /** Multipliers on the plain round. */
  damage: number;
  blast: number;
  gravity: number;
  speed: number;
  /** Flies straight through rocks. */
  pierce?: boolean;
  /** Wind does not touch it. */
  windproof?: boolean;
  /** Sets the target alight for this many of their turns. */
  burn?: number;
  /** Repairs your own hull the moment it is played. */
  heal?: number;
}

/**
 * Seven cards, three dealt, one played, every turn.
 *
 * A hand of three is the smallest number that is still a decision, and it fits
 * across the bottom of a phone at a size a thumb can hit. Weighting the plain
 * round highest keeps the baseline shot common: the interesting cards are
 * interesting because they are not the default.
 */
export const CARDS: Record<CardId, CardMeta> = {
  round: {
    id: 'round', name: 'Round Shot', glyph: 'O', weight: 30,
    blurb: 'The honest one. Slightly heavier powder.',
    shots: 1, spread: 0, damage: 1.1, blast: 1, gravity: 1, speed: 1,
  },
  chain: {
    id: 'chain', name: 'Chain Shot', glyph: 'oo', weight: 16,
    blurb: 'Two balls on a chain. Both can bite.',
    shots: 2, spread: 0.05, damage: 0.62, blast: 0.85, gravity: 1, speed: 1,
  },
  grape: {
    id: 'grape', name: 'Grapeshot', glyph: '::', weight: 15,
    blurb: 'Five pellets, wide fan. Forgiving aim, small teeth.',
    shots: 5, spread: 0.15, damage: 0.3, blast: 0.55, gravity: 1, speed: 0.97,
  },
  mortar: {
    id: 'mortar', name: 'Mortar', glyph: 'V', weight: 13,
    blurb: 'Drops like a stone. Huge blast, lobs over rocks.',
    shots: 1, spread: 0, damage: 1.4, blast: 1.65, gravity: 1.75, speed: 1.12,
  },
  firebomb: {
    id: 'firebomb', name: 'Firebomb', glyph: '*', weight: 11,
    blurb: 'Lights the deck. Burns for two of their turns.',
    shots: 1, spread: 0, damage: 0.8, blast: 1.15, gravity: 1, speed: 1, burn: 2,
  },
  bore: {
    id: 'bore', name: 'Bore Shot', glyph: '>', weight: 9,
    blurb: 'Punches straight through rock. Ignores the wind.',
    shots: 1, spread: 0, damage: 1.2, blast: 0.9, gravity: 0.9, speed: 1.15,
    pierce: true, windproof: true,
  },
  patch: {
    id: 'patch', name: 'Patch Kit', glyph: '+', weight: 10,
    blurb: 'Plug the holes, then fire anyway. Heals 14.',
    shots: 1, spread: 0, damage: 0.85, blast: 0.9, gravity: 1, speed: 1, heal: 14,
  },
};

export const CARD_ORDER: CardId[] = ['round', 'chain', 'grape', 'mortar', 'firebomb', 'bore', 'patch'];

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Deterministic PRNG.
 *
 * Both players must deal the same hand and blow the same wind without a round
 * trip to agree on it, so every random thing in a match is a pure function of
 * the match seed and the turn number. Math.random would desynchronise the two
 * clients within one turn.
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

/** A hand of three, dealt from the weighted deck without repeats. */
export function dealHand(rnd: () => number): CardId[] {
  const pool = [...CARD_ORDER];
  const hand: CardId[] = [];
  for (let i = 0; i < 3 && pool.length > 0; i++) {
    const total = pool.reduce((sum, id) => sum + CARDS[id].weight, 0);
    let roll = rnd() * total;
    let pick = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      roll -= CARDS[pool[j]].weight;
      if (roll <= 0) {
        pick = j;
        break;
      }
    }
    hand.push(pool[pick]);
    pool.splice(pick, 1);
  }
  return hand;
}
