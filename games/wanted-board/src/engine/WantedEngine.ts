/**
 * The town, and what happens when everybody moves at once.
 *
 * This file is a pure function wearing a class. The entire state of a match is
 * derived by replaying `history` from an empty town — nothing is accumulated
 * incrementally, nothing is cached across rounds, and `replay()` from the same
 * history always lands on the identical state. That is what lets the wire be
 * "here is every round so far" instead of a patch stream, and it is why there
 * is no resync path anywhere in this game: a client that missed six rounds
 * catches up by replaying six rounds.
 *
 * It also knows nothing about React, Firestore or drawing. The screen asks it
 * what happened and animates the answer.
 */
import {
  BALANCE,
  BANK,
  CARDS,
  PLACE_COUNT,
  clamp,
  mulberry32,
  neighbours,
  startPlaces,
} from '../game/rules';
import type { CardId } from '../game/rules';
import { TARGET_CHOICES, decodeChoice, encodeChoice } from '../types/game';
import type { Choice, Control, EncodedRound, MatchRules, Phase } from '../types/game';

export interface Seat {
  id: string;
  name: string;
  control: Control;
  aiLevel: number;
  /** Index into OUTLAWS. Cosmetic, always. */
  skin: number;
}

export interface PlayerState {
  place: number;
  /** On your head right now. Stealable, and worth nothing until it is banked. */
  bounty: number;
  /** Banked. Nobody can ever take this, and it is the only thing that wins. */
  banked: number;
  /**
   * The biggest bounty this seat has ever carried this match.
   *
   * Purely a record, but a load-bearing one for the end screen: "lost $840 in
   * one night" is the story of a match, and current bounty cannot tell it
   * because getting robbed is exactly what sets it back to nothing.
   */
  peakBounty: number;
  /** Times robbed, and times they did the robbing. */
  caught: number;
  catches: number;
  /** Total taken off other people, for the end-of-game table. */
  stolen: number;
}

export interface TrapState {
  place: number;
  owner: number;
  /** A trap set this round only springs from the *next* one. */
  armedOn: number;
}

/**
 * What happened, in the order the reveal should play it.
 *
 * The screen animates straight down this list, so the order here is the order
 * the story is told in — and it is deliberately the same order the rules
 * resolve in, so what a player sees is never a dramatised version of what the
 * numbers did.
 */
export type RoundEvent =
  | { kind: 'move'; seat: number; from: number; to: number }
  | { kind: 'trap'; seat: number; owner: number; place: number; amount: number }
  | { kind: 'ambush'; seat: number; victims: number[]; place: number; amount: number }
  | { kind: 'standoff'; seats: number[]; place: number }
  | { kind: 'miss'; seat: number; place: number }
  | { kind: 'bank'; seat: number; amount: number }
  | { kind: 'pay'; seat: number; amount: number };

export interface EngineConfig {
  seats: Seat[];
  seed: number;
  rules: MatchRules;
}

export class WantedEngine {
  readonly seats: Seat[];
  readonly seed: number;
  rules: MatchRules;

  /** Every resolved round. The single source of truth; everything else is derived. */
  history: EncodedRound[] = [];

  players: PlayerState[] = [];
  traps: TrapState[] = [];
  /** What the last resolved round did, for the reveal. */
  lastEvents: RoundEvent[] = [];
  lastChoices: Choice[] = [];
  winner: number | null = null;
  phase: Phase = 'choosing';

  constructor(cfg: EngineConfig) {
    this.seats = cfg.seats;
    this.seed = cfg.seed;
    this.rules = cfg.rules;
    this.reset();
  }

  get playerCount(): number {
    return this.seats.length;
  }

  /** Rounds resolved so far. The round being chosen for is this number. */
  get round(): number {
    return this.history.length;
  }

  get target(): number {
    return TARGET_CHOICES[this.rules.target] ?? BALANCE.TARGET_BANKED;
  }

  private reset() {
    const places = startPlaces(this.playerCount);
    this.players = this.seats.map((_, i) => ({
      place: places[i] ?? 0,
      bounty: 0,
      banked: 0,
      peakBounty: 0,
      caught: 0,
      catches: 0,
      stolen: 0,
    }));
    this.traps = [];
    this.lastEvents = [];
    this.lastChoices = [];
    this.winner = null;
    this.phase = 'choosing';
  }

  /**
   * Rebuild the whole match from a history.
   *
   * Called whenever the host's history is longer than ours — which is every
   * round for a guest, and after any reconnection for anybody. Cheap enough to
   * do unconditionally: a full game is a dozen rounds of arithmetic.
   */
  replay(history: EncodedRound[]) {
    this.reset();
    this.history = [];
    for (const round of history) this.applyRound(round);
  }

  /** Deterministic per (seed, round, seat), so every client computes the same bot. */
  rngFor(round: number, seat: number): () => number {
    return mulberry32(this.seed + round * 7919 + seat * 104729);
  }

  // ── legality ─────────────────────────────────────────────────────────────

  /** Cards this seat may actually play from where it is standing. */
  legalCards(seat: number): CardId[] {
    const place = this.players[seat]?.place ?? 0;
    return (Object.keys(CARDS) as CardId[]).filter((id) => {
      const meta = CARDS[id];
      return meta.onlyAt === null || meta.onlyAt === place;
    });
  }

  /** Where a card may point, given where this seat is standing. */
  legalTargets(seat: number, card: CardId): number[] {
    if (!CARDS[card].needsTarget) return [];
    const place = this.players[seat]?.place ?? 0;
    // Both targeting cards reach exactly one step around the ring. Ride takes
    // you there; a trap is left there for somebody else.
    return neighbours(place);
  }

  /** Corrects an illegal or stale choice rather than rejecting it — see `applyRound`. */
  sanitise(seat: number, choice: Choice): Choice {
    const legal = this.legalCards(seat);
    const card = legal.includes(choice.card) ? choice.card : BALANCE.TIMEOUT_CARD;
    if (!CARDS[card].needsTarget) return { card, target: this.players[seat]?.place ?? 0 };
    const targets = this.legalTargets(seat, card);
    const target = targets.includes(choice.target) ? choice.target : targets[0] ?? 0;
    return { card, target };
  }

  // ── resolution ───────────────────────────────────────────────────────────

  /**
   * One round, start to finish.
   *
   * Every choice is run through `sanitise` first rather than trusted. A packet
   * can legitimately be stale — somebody picked "Cash In" at the Bank, then a
   * round they had not seen yet moved them out of it — and the alternative to
   * correcting it is a round that resolves differently depending on which
   * client is doing the arithmetic.
   */
  applyRound(encoded: EncodedRound) {
    if (this.phase === 'over') return;

    const choices: Choice[] = this.seats.map((_, i) =>
      this.sanitise(i, decodeChoice(encoded[i] ?? encodeChoice({ card: BALANCE.TIMEOUT_CARD, target: 0 }))),
    );
    const events: RoundEvent[] = [];
    const roundNo = this.history.length;

    const hidden = (seat: number) => choices[seat].card === 'layLow';

    // ── 1. movement ────────────────────────────────────────────────────────
    for (let i = 0; i < this.playerCount; i++) {
      if (choices[i].card !== 'ride') continue;
      const from = this.players[i].place;
      const to = choices[i].target;
      if (from === to) continue;
      this.players[i].place = to;
      events.push({ kind: 'move', seat: i, from, to });
    }

    // ── 2. traps armed on a previous round spring ──────────────────────────
    // Before ambushes on purpose: a trap is a thing already lying in the road,
    // and somebody waiting with a gun gets whatever the road left them.
    for (const trap of [...this.traps]) {
      if (trap.armedOn > roundNo) continue;
      const victims = this.seatsAt(trap.place).filter((s) => s !== trap.owner && !hidden(s));
      if (victims.length === 0) continue;
      // Springs once, on whoever is there — a trap is not a minefield.
      const victim = victims[0];
      const amount = Math.round(this.players[victim].bounty * BALANCE.TRAP_TAKE);
      this.players[victim].bounty -= amount;
      this.players[trap.owner].bounty += amount;
      this.players[trap.owner].stolen += amount;
      if (amount > 0) {
        this.players[victim].caught++;
        this.players[trap.owner].catches++;
      }
      events.push({ kind: 'trap', seat: victim, owner: trap.owner, place: trap.place, amount });
      this.traps = this.traps.filter((t) => t !== trap);
    }

    // ── 3. ambushes ────────────────────────────────────────────────────────
    for (let place = 0; place < PLACE_COUNT; place++) {
      const here = this.seatsAt(place);
      const ambushers = here.filter((s) => choices[s].card === 'ambush');
      if (ambushers.length === 0) continue;

      // Anyone here who is neither hidden nor themselves holding a gun.
      const victims = here.filter((s) => !ambushers.includes(s) && !hidden(s));

      if (victims.length === 0) {
        if (ambushers.length > 1) {
          // Two people with the same idea. Nobody gets robbed, everybody gets
          // seen — which costs the same as any other wasted ambush.
          events.push({ kind: 'standoff', seats: ambushers, place });
        }
        for (const a of ambushers) {
          this.players[a].bounty = Math.max(0, this.players[a].bounty + BALANCE.AMBUSH_MISS);
          if (ambushers.length === 1) events.push({ kind: 'miss', seat: a, place });
        }
        continue;
      }

      const pot = victims.reduce((sum, v) => sum + this.players[v].bounty, 0);
      for (const v of victims) {
        this.players[v].bounty = 0;
        this.players[v].caught++;
      }
      // Split evenly when two of them jumped the same person: the alternative
      // is a coin flip deciding who gets a whole bounty, and a coin flip is
      // exactly the thing this game replaces with a read.
      const share = Math.floor(pot / ambushers.length);
      for (const a of ambushers) {
        this.players[a].bounty += share;
        this.players[a].stolen += share;
        this.players[a].catches++;
      }
      events.push({ kind: 'ambush', seat: ambushers[0], victims, place, amount: pot });
    }

    // ── 4. banking ─────────────────────────────────────────────────────────
    // After the robbery, never before. Being caught mid-transaction is the
    // whole reason the Bank is a dangerous place to stand.
    for (let i = 0; i < this.playerCount; i++) {
      if (choices[i].card !== 'cashIn') continue;
      const amount = this.players[i].bounty;
      this.players[i].banked += amount;
      this.players[i].bounty = 0;
      events.push({ kind: 'bank', seat: i, amount });
    }

    // ── 5. the round pays out ──────────────────────────────────────────────
    for (let i = 0; i < this.playerCount; i++) {
      const pay =
        choices[i].card === 'ride'
          ? BALANCE.PAY_RIDE
          : choices[i].card === 'layLow'
            ? BALANCE.PAY_LAY_LOW
            : choices[i].card === 'trap'
              ? BALANCE.PAY_TRAP
              : 0;
      if (pay === 0) continue;
      this.players[i].bounty += pay;
      events.push({ kind: 'pay', seat: i, amount: pay });
    }

    // ── 6. new traps go live for next round ────────────────────────────────
    for (let i = 0; i < this.playerCount; i++) {
      if (choices[i].card !== 'trap') continue;
      // One live trap each. Setting a second moves the first rather than
      // letting one player quietly carpet the whole ring.
      this.traps = this.traps.filter((t) => t.owner !== i);
      this.traps.push({ place: choices[i].target, owner: i, armedOn: roundNo + 1 });
    }

    for (const p of this.players) {
      p.bounty = Math.max(0, Math.round(p.bounty));
      if (p.bounty > p.peakBounty) p.peakBounty = p.bounty;
    }

    this.history.push([...encoded]);
    this.lastChoices = choices;
    this.lastEvents = events;
    this.checkOver();
  }

  private checkOver() {
    const target = this.target;
    const reached = this.players.some((p) => p.banked >= target);
    const outOfRounds = this.history.length >= BALANCE.ROUNDS;
    if (!reached && !outOfRounds) return;
    this.phase = 'over';
    this.winner = this.standings()[0]?.seat ?? null;
  }

  /** Everyone, best first. Banked decides it; an unbanked bounty is the tie-break. */
  standings(): { seat: number; banked: number; bounty: number; peakBounty: number }[] {
    return this.players
      .map((p, seat) => ({ seat, banked: p.banked, bounty: p.bounty, peakBounty: p.peakBounty }))
      .sort((a, b) => b.banked - a.banked || b.bounty - a.bounty || a.seat - b.seat);
  }

  seatsAt(place: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.playerCount; i++) if (this.players[i].place === place) out.push(i);
    return out;
  }

  /** A seat's own live trap, if it has one. Nobody else's is ever visible. */
  trapOf(seat: number): TrapState | undefined {
    return this.traps.find((t) => t.owner === seat);
  }

  /** How close this seat is to the Bank, in rides. Drives both the HUD and the bots. */
  ridesToBank(seat: number): number {
    const place = this.players[seat]?.place ?? 0;
    const forward = (BANK - place + PLACE_COUNT) % PLACE_COUNT;
    return Math.min(forward, PLACE_COUNT - forward);
  }

  /** One step around the ring toward the Bank. */
  stepToward(from: number, to: number): number {
    if (from === to) return from;
    const forward = (to - from + PLACE_COUNT) % PLACE_COUNT;
    return forward <= PLACE_COUNT - forward
      ? (from + 1) % PLACE_COUNT
      : (from + PLACE_COUNT - 1) % PLACE_COUNT;
  }

  /** Clamped for the HUD's progress bars. */
  bankedFraction(seat: number): number {
    return clamp((this.players[seat]?.banked ?? 0) / this.target, 0, 1);
  }
}
