/**
 * Four hulls, all free, and the one axis of this game that is not cosmetic.
 *
 * ships.ts is emphatic that a skin never changes the fight, and that stands:
 * a shop that sells an advantage in a head-to-head game is worse than no shop
 * at all. This is the other half of that rule. Every class here costs nothing
 * and is available to everybody from the first battle, so the choice is a
 * choice about how you want to fight rather than about what you have paid
 * for. Skin and class are picked separately and neither constrains the other.
 *
 * None of them is better. Each buys one thing with another, and the thing it
 * spends is the thing its opponent most wants it to have spent:
 *
 *  - a Sloop is hard to hit and cannot take a hit
 *  - a Man-o'-War can take anything and is impossible to miss
 *  - a Bomb Ketch punishes a near miss and is soft when it takes one
 *  - a Frigate has no opinions at all, which against the other three is
 *    itself a position
 *
 * Every multiplier is applied against the numbers in BALANCE, which stay the
 * duel's hand-tuned figures -- a Frigate is exactly the ship this game was
 * balanced as, down to the pixel.
 *
 * The numbers below are measured, not chosen. Each stat was varied on its own
 * against a plain Frigate over 360 Captain-rank duels, which is what makes
 * them tradeable at all:
 *
 *   hull      0.85 -> 30% win     1.10 -> 63%    1.30 -> 80%
 *   damage    0.80 -> 22%         1.10 -> 61%    1.20 -> 70%
 *   width     0.75 -> 56%         1.15 -> 47%    1.30 -> 44%
 *   roam      any value           ~50%  (see below)
 *   blast     0.70 -> 43%         1.70 -> 60%    2.30 -> 69%
 *
 * As set, all four land inside a six-point spread at every bot rank and no
 * single pairing falls outside 44-59%. Before this pass the Man-o'-War took
 * 89% of everything it met.
 *
 * So hull and damage are near enough interchangeable and are what actually
 * balances a class; a narrower target is worth about six points across its
 * whole range, and every class is then set to land within a couple of points
 * of even.
 *
 * Roam measuring flat is a property of the test rather than of the game, and
 * it is kept anyway: a bot re-solves the range from wherever you actually
 * are every single turn, so wandering costs it nothing, while against a human
 * reusing last turn's elevation it is the whole difference between a hit and
 * a splash.
 */

export interface HullClass {
  id: string;
  name: string;
  blurb: string;
  /** What it trades away, said plainly. Shown under the name in the picker. */
  cost: string;
  /** Multiplier on BALANCE.MAX_HP. */
  hp: number;
  /**
   * Multiplier on the hull and rigging hitbox width.
   *
   * The one stat that cuts both ways at once and the reason the classes are
   * a triangle rather than a ladder: a narrower silhouette is harder for the
   * enemy to land on, and it is exactly as hard for a crewmate's blast to
   * reach, which matters not at all in a duel and a great deal in a 3v3.
   */
  width: number;
  /** Multiplier on how far the sea shoves it between turns. */
  drift: number;
  /**
   * Multiplier on both the radius *and* the damage of every blast it fires.
   *
   * Both, because the radius on its own is worth nothing: splash falls off
   * with the square of the distance from a base of 15 against a 24-point
   * direct hit, so a wider ring reaches further and then does under four
   * damage when it gets there. Given a 2.3x radius and nothing else, the
   * Bomb Ketch measured 47% in a 3v3 -- inside a point of the Frigate it was
   * supposed to be a different ship from. Scaling the damage with it is what
   * makes the ring worth having at all.
   *
   * Kept modest for a reason the other stats do not have: blast is a
   * forgiveness stat, so what it is worth depends on how often its owner
   * misses. At 1.7x the Ketch measured 54% against a Captain and 64% against
   * a Swab -- even against good gunnery and lopsided against poor. 1.25x is
   * the largest ring that still lands within a few points of even at every
   * rank, which matters because a bot sails one of these too.
   */
  blast: number;
  /**
   * Multiplier on the damage every ball it fires does.
   *
   * The axis that actually balances the other three, and it is here because
   * it was measured rather than guessed. The first pass at these classes
   * traded hull for a smaller silhouette, and bot-against-bot over 200 seeds
   * a pairing the Man-o'-War won 89% of: how long a ship survives tracks its
   * hull almost exactly (0.80 hull bought 0.85x survival, 1.32 bought 1.27x)
   * while the narrower target was worth ±5% and the wider roam nothing at
   * all. In an artillery duel the aim converges on wherever you actually are
   * -- being a slightly smaller thing to converge on is close to free, and
   * being a tougher one is close to everything. So a hull that soaks now
   * pays for it in what its own guns do, which is a trade the fight can
   * actually feel.
   */
  damage: number;
}

export const HULLS: HullClass[] = [
  {
    id: 'frigate',
    name: 'Frigate',
    blurb: 'The ship this game was balanced as. Nothing given up, nothing gained.',
    cost: 'No trade',
    hp: 1,
    width: 1,
    drift: 1,
    blast: 1,
    damage: 1,
  },
  {
    id: 'sloop',
    name: 'Sloop',
    blurb: 'Small, quick, and carrying more powder than she has any business carrying. Hits like a bigger ship and cannot take being hit like one.',
    cost: 'Made of matchwood',
    hp: 0.85,
    width: 0.84,
    drift: 1.65,
    blast: 1,
    damage: 1.12,
  },
  {
    id: 'manowar',
    name: "Man-o'-War",
    blurb: 'A castle that floats. Soaks a battle nobody else survives, and takes her time about answering.',
    cost: 'Her guns bite softest',
    hp: 1.25,
    width: 1.16,
    drift: 0.55,
    blast: 1,
    damage: 0.84,
  },
  {
    id: 'ketch',
    name: 'Bomb Ketch',
    blurb: 'Built round the powder. Her near misses still bite, which is worth most where there is more than one hull to reach.',
    cost: 'A little thin in the planking',
    hp: 0.95,
    width: 1,
    drift: 0.9,
    blast: 1.25,
    damage: 1,
  },
];

/** Never out of range, whatever a stale save or a peer claims. */
export function hullAt(index: number | null | undefined): HullClass {
  if (typeof index !== 'number' || !Number.isInteger(index)) return HULLS[0];
  return HULLS[index] ?? HULLS[0];
}
