/**
 * The bots.
 *
 * Every decision here is a pure function of (engine state, seeded rng), and
 * the rng is keyed on (match seed, round, seat) — so the host and every guest
 * would compute the identical bot even though only the host actually does.
 * `Math.random()` in this file would be a desync waiting for the first time a
 * second client ever recomputes a round, which is exactly the bug Battle of
 * Pirates shipped with once.
 *
 * A bot that played optimally would be no fun and, worse, unreadable: the
 * whole game is guessing what a person will do, and a perfect opponent has no
 * habits to guess. So these have *tendencies* — a nerve threshold for banking,
 * a taste for ambushing — and the ranks differ mostly in how well they read
 * the table rather than in how much they cheat.
 */
import { BALANCE, BANK, CARDS } from '../game/rules';
import type { CardId } from '../game/rules';
import type { Choice } from '../types/game';
import type { WantedEngine } from './WantedEngine';

export interface Tier {
  label: string;
  /** Bounty at which it starts wanting to bank, as a fraction of the target. */
  nerve: number;
  /** Base chance of lying in wait rather than moving. */
  ambushTaste: number;
  /** Chance it notices somebody rich standing next to it and reacts. */
  awareness: number;
}

export const TIERS: Tier[] = [
  { label: 'Greenhorn', nerve: 0.55, ambushTaste: 0.1, awareness: 0.25 },
  { label: 'Drifter', nerve: 0.32, ambushTaste: 0.2, awareness: 0.6 },
  { label: 'Marshal', nerve: 0.22, ambushTaste: 0.28, awareness: 0.95 },
];

/**
 * One bot's move for one round.
 *
 * Reads in priority order: rob somebody standing next to me, get my own money
 * to safety, then wander with intent. Falling through to "ride toward the
 * Bank" rather than to a random card matters — a bot that drifts aimlessly
 * never threatens anybody and the table stops watching it.
 */
export function botChoice(engine: WantedEngine, seat: number, level: number, rnd: () => number): Choice {
  const tier = TIERS[Math.max(0, Math.min(TIERS.length - 1, level))];
  const me = engine.players[seat];
  const legal = engine.legalCards(seat);
  const pick = (card: CardId, target: number): Choice => engine.sanitise(seat, { card, target });

  const here = engine.seatsAt(me.place).filter((s) => s !== seat);
  const richestHere = here.sort((a, b) => engine.players[b].bounty - engine.players[a].bounty)[0];

  // ── my own money is getting heavy ────────────────────────────────────────
  //
  // Checked *before* looking for somebody to rob, and that order is the whole
  // difference between a table that plays the game and one that seizes up. The
  // other way round, a bot carrying $500 that happened to share a place with
  // anybody would stand there robbing instead of banking — and since four
  // players on six places share a place constantly, whole tables settled into
  // mutual muggings where nobody ever banked a dollar. Somebody already
  // holding a fortune has far more to lose by showing themselves than there is
  // in anyone else's pocket.
  const heavy = me.bounty >= engine.target * tier.nerve;
  if (heavy) {
    if (me.place === BANK && legal.includes('cashIn')) {
      // Standing on the Bank with a full pocket. The only reason not to take
      // it is a bad feeling about the company — which, for a bot, is somebody
      // else standing here too.
      const spooked = here.length > 0 && rnd() < tier.awareness * 0.7;
      if (!spooked) return pick('cashIn', BANK);
      return pick('layLow', me.place);
    }
    // Head for the Bank. A nervous bot that is carrying a lot will sometimes
    // duck instead, which is what makes it hard to meet it at the door.
    if (here.length > 0 && rnd() < tier.awareness * 0.35) return pick('layLow', me.place);
    return pick('ride', engine.stepToward(me.place, BANK));
  }

  // ── travelling light, and somebody here is not ───────────────────────────
  // Now it is worth showing yourself: there is a real prize in front of you
  // and very little in your own pocket for it to cost.
  if (richestHere !== undefined && rnd() < tier.awareness && legal.includes('ambush')) {
    const prize = engine.players[richestHere].bounty;
    // The pot has to clear a miss with enough margin to be a decision rather
    // than a coin flip — and they might well be laying low, in which case the
    // whole thing costs and returns nothing.
    if (prize > -BALANCE.AMBUSH_MISS * 1.8) return pick('ambush', me.place);
  }

  // ── nothing pressing: build a bounty, and occasionally lie in wait ───────
  if (rnd() < tier.ambushTaste && legal.includes('ambush')) {
    return pick('ambush', me.place);
  }

  if (rnd() < 0.18 && legal.includes('trap')) {
    const targets = engine.legalTargets(seat, 'trap');
    // Prefer rigging the approach to the Bank — it is where the money walks.
    const towardBank = engine.stepToward(me.place, BANK);
    const target = targets.includes(towardBank) && rnd() < 0.7
      ? towardBank
      : targets[Math.floor(rnd() * targets.length)] ?? targets[0];
    return pick('trap', target);
  }

  const targets = engine.legalTargets(seat, 'ride');
  if (targets.length === 0 || !CARDS.ride) return pick('layLow', me.place);
  // Drift toward the Bank more often than not, so a bot is always slowly
  // becoming a threat rather than orbiting one spot forever.
  const towardBank = engine.stepToward(me.place, BANK);
  const target = targets.includes(towardBank) && rnd() < 0.6
    ? towardBank
    : targets[Math.floor(rnd() * targets.length)] ?? targets[0];
  return pick('ride', target);
}
