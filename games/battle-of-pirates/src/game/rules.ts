/**
 * Every number the battle is made of, in one file.
 *
 * The engine reads these and nothing else, so a balance change is a one-line
 * edit here rather than a hunt through the simulation. Where REQUIREMENTS.md
 * quotes a figure, it is this figure.
 */

/** Ships a side brings. One each is the duel; two or three is a fleet action. */
export type FleetSize = 1 | 2 | 3;

/** Hulls on the water to ships per side, clamped to what an arena exists for. */
export function fleetSizeFor(totalShips: number): FleetSize {
  return clamp(Math.round(totalShips / 2), 1, 3) as FleetSize;
}

export interface Arena {
  w: number;
  h: number;
  /** Waterline. Hulls sit on it; anything below is sea. */
  seaY: number;
  /**
   * Where each ship would sit with no drift, as `anchor[team][slot]`.
   *
   * Slot 0 is the one nearest the enemy, so the fleet builds backwards from
   * the front rank and the innermost pair are always CENTRE_GAP apart however
   * many ships turn up. That is what keeps the opening exchange of a 3v3
   * feeling like the duel this was balanced as.
   */
  anchor: [number[], number[]];
  /**
   * Muzzle speed at full power, which is a property of the water rather than
   * of the cannon.
   *
   * A bigger fleet means a wider sea, and the rearmost ship still has to be
   * able to reach the enemy's rearmost ship. Range goes as the square of
   * muzzle velocity, so the speed scales with the square root of the longest
   * shot on the board — which leaves the *relative* reach of the power dial
   * exactly where it was tuned: the bottom third still falls short and the
   * top still clears a drifted target, whatever the size of the battle.
   */
  maxSpeed: number;
  /** How far a hull may wander, and how far per turn. Tighter when it has neighbours. */
  driftMax: number;
  driftStep: number;
}

/** Between the two innermost hulls. The number the whole game was balanced around. */
const CENTRE_GAP = 1850;
/**
 * Between one ship and the next on its own side.
 *
 * A hull's hitbox is HULL_W across, but the sprite carries a bowsprit and
 * rigging past that, so the gap is set against the drawing rather than the
 * box: 360 apart with 60 of drift each way leaves 40px of daylight at the
 * worst possible moment, which is enough that two hulls never read as one.
 */
const SLOT_GAP = 360;
/** Water beyond the rearmost hull, so a drifting ship never touches the frame. */
const EDGE = 300;

/**
 * The water for a battle of this size.
 *
 * A one-a-side call reproduces the hand-tuned arena this game shipped with,
 * down to the pixel — 2450 by 900, anchors at 300 and 2150, 1760 muzzle speed
 * — so growing the fleet is strictly an addition and the duel is untouched.
 */
export function arenaFor(perSide: FleetSize): Arena {
  const back = (perSide - 1) * SLOT_GAP;
  const w = EDGE * 2 + back * 2 + CENTRE_GAP;
  // The frame keeps its shape as it widens, so a lofted shot has the same
  // headroom over the water it always had rather than leaving the top of a
  // squashed letterbox.
  const h = (w * 900) / 2450;
  const front = [EDGE + back, EDGE + back + CENTRE_GAP];

  const anchor: [number[], number[]] = [
    Array.from({ length: perSide }, (_, slot) => front[0] - slot * SLOT_GAP),
    Array.from({ length: perSide }, (_, slot) => front[1] + slot * SLOT_GAP),
  ];

  // The longest shot anyone can be asked to make: rearmost hull to rearmost hull.
  const longest = CENTRE_GAP + back * 2;

  return {
    w,
    h,
    seaY: (h * 690) / 900,
    anchor,
    maxSpeed: BASE_MAX_SPEED * Math.sqrt(longest / CENTRE_GAP),
    // A lone ship has the whole side to itself and keeps the roomy original
    // drift. Give it neighbours and that same drift would sail two hulls
    // straight through each other, so it tightens to something that cannot.
    driftMax: perSide === 1 ? 135 : 60,
    driftStep: perSide === 1 ? 62 : 28,
  };
}

/**
 * Every arena is fully visible, whatever its size.
 *
 * There is no camera. Every ship and the whole arc between them are on screen
 * at all times, because an artillery game where you cannot see the target is
 * a guessing game, and a scrolling view on a phone is unreadable anyway.
 * The generous headroom is deliberate: a lofted mortar leaves the top of the
 * frame, and an off-screen ball needs somewhere to be.
 *
 * CENTRE_GAP above is wide on purpose, and wider than the first two passes at
 * it. A thousand pixels between anchors let two thirds of the power dial
 * reach the enemy outright; 1260 fixed that but a good aim from the deck
 * could still all but guarantee a hit once elevation was solved once; 1600
 * made range a real problem to solve on every shot, not just once a match.
 * At 1850 that problem stays live even after the mountain in the middle
 * forces the elevation choice too -- flat is no longer an option at all, so
 * the water has to carry the whole burden of range on its own, and it needs
 * the extra room to do it in. The anchors stay clear of the frame's edge at
 * full drift either way.
 */

/**
 * Muzzle speed at full power for the one-a-side arena, in world px/s.
 *
 * Not read directly by anything that fires: `arenaFor` scales it to the water
 * it is building and hands the result out as `arena.maxSpeed`. This is the
 * number that scaling is anchored on.
 */
const BASE_MAX_SPEED = 1760;

export const BALANCE = {
  /**
   * Gravity, eased again to match the wider water.
   *
   * The power dial is only a decision while both ends of it mean something.
   * Retuned so the bottom third of the dial still falls short of a
   * stationary enemy and the top comfortably clears one who has drifted
   * away. It also buys the thing a wide sea wants: a longer, higher arc,
   * more time to read the wind before it lands, and more room for a mortar's
   * much steeper drop to actually mean something.
   */
  GRAVITY: 1050,
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

  /** Trimmed down from the first pass at this: a smaller silhouette is a harder one to land on. */
  HULL_W: 200,
  HULL_H: 78,
  /** Muzzle offset from the hull centre, toward the enemy. Scaled with HULL_W. */
  MUZZLE_X: 66,
  MUZZLE_Y: -46,
  /** Real on the hitbox, not just paint. See REQUIREMENTS section 4. */
  BOB_AMP: 10,
  BOB_SPEED: 1.35,

  /**
   * Hits the mountain takes before it crumbles. It visibly wears down with each.
   *
   * Three was far too few. The mountain is the one thing making elevation a
   * real decision, and it was gone inside the opening exchange — two stray
   * shots and a bore, and the rest of the battle was the flat duel this arena
   * was widened specifically to prevent. Ten means it erodes across a battle
   * rather than in the first minute of one, and the host can put it beyond
   * breaking entirely with the 'solid' rule.
   */
  ROCK_HP: 10,
  /**
   * The mountain's size, in world pixels of radius -- the hitbox is a true
   * circle, so this is both how wide it reads on screen and, what actually
   * matters, how high its crest stands over the water.
   *
   * Two rocks with a crest 145 to 195px up were still a reef: tall enough to
   * stop a flat shot, short enough that a middling elevation cleared them
   * with room to spare. This is one mountain instead, crest 360 to 420px up
   * -- close to what it takes to clear at the top of the power dial, the way
   * the arc in a photo of a near-miss actually reads. Nothing at a working
   * elevation skims this one; going over it is a real commitment of power and
   * angle both, and the only way through instead of over is still a bore shot.
   */
  ROCK_R_MIN: 380,
  ROCK_R_MAX: 440,
  /**
   * How far the mountain keeps clear of an anchor.
   *
   * Measured against a hull at its furthest drift plus its own half-width,
   * with the mountain at full radius on top and room to spare, so it can
   * never spawn inside the reach of the ship that has to shoot past it.
   */
  ROCK_MARGIN: 780,

  /** Seconds a player gets to aim before the shot goes off on its own. */
  TURN_TIME: 30,
  /** Beat between the explosion settling and the next player getting the helm. */
  IMPACT_HOLD: 1.35,
  /**
   * How long to hold the picture after a remote shot's local flight has
   * settled, waiting for its authoritative outcome to cross the wire, before
   * giving up on it arriving and computing the turn's end locally instead.
   * Generous next to the round trip it is actually covering -- this is the
   * fallback for a partner who has gone quiet mid-turn, not the common case.
   */
  OUTCOME_TIMEOUT: 6,
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
 *
 * `speed` is also, in effect, a range dial: at a fixed gravity and a fixed
 * launch angle, how far a ball goes scales with the square of its muzzle
 * velocity, so a card at 0.8x speed does not fly "a bit less far", it lands
 * at roughly two thirds the distance. That is what separates grapeshot from
 * mortar below from round shot -- three different fights at three different
 * ranges, not one card with a bigger number on it.
 */
export const CARDS: Record<CardId, CardMeta> = {
  round: {
    id: 'round', name: 'Round Shot', glyph: 'O', weight: 30,
    blurb: 'The honest one. Full powder, full range.',
    shots: 1, spread: 0, damage: 1.1, blast: 1, gravity: 1, speed: 1,
  },
  chain: {
    id: 'chain', name: 'Chain Shot', glyph: 'oo', weight: 16,
    blurb: 'Two balls on a chain, same range as round shot. Both can bite.',
    shots: 2, spread: 0.05, damage: 0.62, blast: 0.85, gravity: 1, speed: 1,
  },
  /**
   * A close-range shotgun, not a weaker round shot. At 0.78x speed -- nudged
   * up when the water itself widened to 1850, so a full-power shot can still
   * physically reach the far rail when the turn's drift has actually brought
   * the two hulls close, rather than falling short even then -- it is still
   * comfortably shorter than the wind-eaten, half-power shots round shot
   * manages. The five-pellet forgiveness only pays off once the range is
   * genuinely closed.
   */
  grape: {
    id: 'grape', name: 'Grapeshot', glyph: '::', weight: 15,
    blurb: 'A close-range fan of five. Needs the enemy properly near.',
    shots: 5, spread: 0.15, damage: 0.32, blast: 0.55, gravity: 1, speed: 0.78,
  },
  /**
   * The finisher, and the only card the mountain cannot make flinch. `elevRange`
   * below locks it to a 45-to-90-degree barrel, below -- it cannot fire the flat
   * shot at all, only a lob or a near-vertical drop -- so it never competes with
   * round shot on the same trajectory. What used to pay for that restriction was
   * range: the old mortar, unrestricted, still only just reached a stationary
   * enemy at full power. Locked to the one angle band, it can afford to actually
   * carry: at 1.1x speed its 45-degree ceiling clears the water with room to
   * spare, and it still has real reach most of the way to 90, where it becomes a
   * near-vertical drop for whatever has drifted in close. `gravity` stays high,
   * so the drop itself is still the steepest in the deck, and the payoff for
   * threading it is unchanged: hardest hitting card here by a wide margin.
   */
  mortar: {
    id: 'mortar', name: 'Mortar', glyph: 'V', weight: 13,
    blurb: 'Steep shots only, forty-five degrees or more. Hits hardest, carries far for it.',
    shots: 1, spread: 0, damage: 1.75, blast: 1.5, gravity: 1.4, speed: 1.1,
  },
  firebomb: {
    id: 'firebomb', name: 'Firebomb', glyph: '*', weight: 11,
    blurb: 'Lights the deck at full range. Burns for three of their turns.',
    shots: 1, spread: 0, damage: 0.8, blast: 1.15, gravity: 1, speed: 1, burn: 3,
  },
  /**
   * The reef's answer. Every other card either goes over a rock or stops at
   * it; this is the one that does not care it is there. The faster, flatter
   * flight is deliberate too -- windproof already means the gauge stops
   * mattering, and a shot that visibly refuses to bend for either the rock
   * or the wind reads as a punch, not a lob.
   */
  bore: {
    id: 'bore', name: 'Bore Shot', glyph: '>', weight: 9,
    blurb: 'Fast, flat, and straight through rock. Ignores the wind.',
    shots: 1, spread: 0, damage: 1.2, blast: 0.9, gravity: 0.85, speed: 1.3,
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

/** Elevation, in radians above the horizon, from a world angle. */
export function elevOf(angle: number, facing: 1 | -1): number {
  return facing > 0 ? -angle : angle + Math.PI;
}

/** The inverse of elevOf, for handing an elevation back to the engine. */
export function angleOf(elev: number, facing: 1 | -1): number {
  return facing > 0 ? -elev : elev - Math.PI;
}

/** Every card but one can fire almost flat through nearly straight up. */
const ELEV_MIN = 0.06;
const ELEV_MAX = 1.53;
/** Mortar's whole redesign: a lob or a near-vertical drop, never flatter than that. */
const MORTAR_ELEV_MIN = Math.PI / 4;
const MORTAR_ELEV_MAX = Math.PI / 2;

/**
 * The elevation band a card may leave the barrel within, in radians above the
 * horizon.
 *
 * The single source of truth for the mortar's angle lock: the aim pad, the
 * keyboard, the engine's own fire() and the bot's solver all read this rather
 * than each hard-coding the pair of numbers, so a shot fired from any of them
 * lands inside the same band every other one would have allowed.
 */
export function elevRange(card: CardId): [number, number] {
  return card === 'mortar' ? [MORTAR_ELEV_MIN, MORTAR_ELEV_MAX] : [ELEV_MIN, ELEV_MAX];
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
