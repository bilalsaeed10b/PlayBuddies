/**
 * The word, the gallows, and what one guess does to both.
 *
 * This file is a pure function wearing a class. The entire state of a match
 * is derived by replaying `history` from nothing — no state is accumulated
 * incrementally, nothing is cached between rounds, and `replay()` from the
 * same history always lands on the identical result. That is what lets the
 * wire be "here is every action so far" rather than a patch stream, and it
 * is why there is no resync path anywhere in this game: a client that missed
 * six turns catches up by replaying six turns.
 *
 * It knows nothing about React, Firestore or drawing. The screen asks it what
 * happened and animates the answer.
 */
import { ALPHABET, BALANCE, PIECES, mulberry32, scoreFor } from '../game/rules';
import { answers } from '../game/words';
import type { Action, Control, MatchRules, Phase, RoundHistory } from '../types/game';
import { ROUND_CHOICES } from '../types/game';

export interface Seat {
  id: string;
  name: string;
  control: Control;
  aiLevel: number;
  /** Index into FACES. Cosmetic, always. */
  skin: number;
}

export interface PlayerState {
  /** Points safely on the board from finished rounds. Nothing takes these away. */
  total: number;
  /** Earned this round, and forfeit entirely if this player finishes the stickman. */
  round: number;
  /** Wrong solve this round: no more turns until the next word. */
  out: boolean;
  /** Match-long tallies, for the end screen. */
  correct: number;
  wrong: number;
  solves: number;
  hangs: number;
}

/**
 * What happened, newest last. The screen reads this straight out as a feed —
 * it is the round's story, and it is deliberately in resolution order rather
 * than a dramatised version of it.
 */
export type RoundEvent =
  | { kind: 'hit'; seat: number; letter: string; copies: number; points: number }
  | { kind: 'miss'; seat: number; letter: string; piece: number }
  | { kind: 'solved'; seat: number; word: string; points: number }
  | { kind: 'wrongWord'; seat: number; attempt: string; piece: number }
  | { kind: 'hanged'; seat: number; lost: number }
  | { kind: 'cleared'; word: string };

export interface EngineConfig {
  seats: Seat[];
  seed: number;
  rules: MatchRules;
}

export class LastGaspEngine {
  readonly seats: Seat[];
  readonly seed: number;
  rules: MatchRules;

  /** Every round's actions. The single source of truth; everything else is derived. */
  history: RoundHistory[] = [];

  players: PlayerState[] = [];
  /** Letters called this round, in call order. */
  called: string[] = [];
  /** How much of the stickman is drawn, 0..PIECES. */
  pieces = 0;
  /** Seat whose turn it is. Meaningless once the round is over. */
  turn = 0;
  events: RoundEvent[] = [];
  phase: Phase = 'guessing';
  winner: number | null = null;

  constructor(cfg: EngineConfig) {
    this.seats = cfg.seats;
    this.seed = cfg.seed;
    this.rules = cfg.rules;
    this.replay([[]]);
  }

  get playerCount(): number {
    return this.seats.length;
  }

  get totalRounds(): number {
    return ROUND_CHOICES[this.rules.rounds] ?? BALANCE.ROUNDS;
  }

  /** Which word the match is on, zero-based. */
  get round(): number {
    return Math.max(0, this.history.length - 1);
  }

  /** How many actions the current round has already recorded. */
  get actionCount(): number {
    return this.history[this.round]?.length ?? 0;
  }

  /**
   * The answer for a round.
   *
   * A pure function of (seed, round), so every client picks the same one
   * without anybody having to send it — which matters, because sending it
   * would put the answer in a Firestore document that every player in the
   * room is allowed to read.
   */
  answerFor(round: number): { word: string; category: string } {
    const list = answers();
    const rnd = mulberry32(this.seed + round * 40503);
    // Two draws, because a single mulberry32 output straight after seeding is
    // noticeably flat across nearby seeds — and consecutive rounds are, by
    // construction, nearby seeds.
    rnd();
    return list[Math.floor(rnd() * list.length) % list.length];
  }

  get word(): string {
    return this.answerFor(this.round).word;
  }

  get category(): string {
    return this.answerFor(this.round).category;
  }

  /** The word as it is currently shown: the letter, or null for a blank. */
  get board(): (string | null)[] {
    const shown = new Set(this.called);
    return [...this.word].map((ch) => (shown.has(ch) ? ch : null));
  }

  get solved(): boolean {
    return this.board.every((c) => c !== null);
  }

  /** Letters still hidden. Drives the solve bonus. */
  get hiddenCount(): number {
    return this.board.filter((c) => c === null).length;
  }

  // ── legality ─────────────────────────────────────────────────────────────

  /** Whether this seat may act right now. */
  canAct(seat: number): boolean {
    return this.phase === 'guessing' && this.turn === seat && !this.players[seat]?.out;
  }

  /** Letters nobody has called yet this round. */
  get available(): string[] {
    const used = new Set(this.called);
    return ALPHABET.filter((c) => !used.has(c));
  }

  /**
   * Whether an action would be accepted, without applying it.
   *
   * The host checks this before appending anything, so a stale packet from a
   * guest whose screen was a turn behind is dropped rather than replayed into
   * everybody's history.
   */
  accepts(action: Action): boolean {
    if (!this.canAct(action.s)) return false;
    if ('l' in action) {
      const letter = ALPHABET[action.l];
      return Boolean(letter) && !this.called.includes(letter);
    }
    return action.w.length > 0;
  }

  // ── resolution ───────────────────────────────────────────────────────────

  /** Rebuild the whole match from a history. */
  replay(history: RoundHistory[]) {
    this.players = this.seats.map(() => ({
      total: 0,
      round: 0,
      out: false,
      correct: 0,
      wrong: 0,
      solves: 0,
      hangs: 0,
    }));
    this.history = [];
    this.phase = 'guessing';
    this.winner = null;
    this.resetRound();

    for (let r = 0; r < history.length; r++) {
      if (r > 0) this.beginRound();
      this.history[r] = [];
      for (const action of history[r]) this.apply(action);
    }
    if (this.history.length === 0) this.history = [[]];
  }

  private resetRound() {
    this.called = [];
    this.pieces = 0;
    this.events = [];
    this.turn = 0;
    for (const p of this.players) {
      p.round = 0;
      p.out = false;
    }
  }

  /** Bank the round, deal the next word, and hand the first turn on. */
  private beginRound() {
    for (const p of this.players) p.total += p.round;
    this.resetRound();
    this.phase = 'guessing';
    // The opening turn walks round the table between words, so the same
    // person is not always first at the blank board — which on a fresh word
    // is the single most valuable turn there is.
    this.turn = this.history.length % this.playerCount;
    this.history.push([]);
  }

  /**
   * One action, start to finish.
   *
   * Rejects rather than corrects. Wanted Board sanitises a stale choice into
   * a legal one because every seat there must produce exactly one card per
   * round and a dropped packet would stall the table; here a rejected action
   * simply never happened, the turn stays where it was, and the player tries
   * again. That is only safe because this game is sequential — nobody else is
   * blocked while one player's packet is in flight.
   */
  apply(action: Action): boolean {
    if (this.phase !== 'guessing') return false;
    if (!this.accepts(action)) return false;

    const seat = action.s;
    const me = this.players[seat];

    if ('l' in action) {
      const letter = ALPHABET[action.l];
      this.called.push(letter);
      const copies = [...this.word].filter((c) => c === letter).length;

      if (copies > 0) {
        const points = scoreFor(letter, copies);
        me.round += points;
        me.correct++;
        this.events.push({ kind: 'hit', seat, letter, copies, points });
        this.history[this.round].push(action);
        if (this.solved) {
          this.events.push({ kind: 'cleared', word: this.word });
          this.endRound();
          return true;
        }
      } else {
        me.wrong++;
        this.pieces++;
        this.events.push({ kind: 'miss', seat, letter, piece: this.pieces });
        this.history[this.round].push(action);
        if (this.pieces >= PIECES) {
          this.hang(seat);
          return true;
        }
      }
      this.passTurn();
      return true;
    }

    // A go at the whole word.
    const attempt = action.w;
    if (attempt === this.word) {
      // Paid for what was still hidden, so the reward is largest on a blank
      // board and near-nothing once everyone else has opened it up.
      const points = this.hiddenCount * BALANCE.SOLVE_BONUS_PER_LETTER + scoreForRemaining(this.word, this.called);
      me.round += points;
      me.solves++;
      // Fill the board in so the round-over screen shows the whole word.
      for (const ch of new Set(this.word)) if (!this.called.includes(ch)) this.called.push(ch);
      this.events.push({ kind: 'solved', seat, word: this.word, points });
      this.history[this.round].push(action);
      this.endRound();
      return true;
    }

    me.wrong++;
    me.out = true;
    this.pieces = Math.min(PIECES, this.pieces + BALANCE.WRONG_SOLVE_PIECES);
    this.events.push({ kind: 'wrongWord', seat, attempt, piece: this.pieces });
    this.history[this.round].push(action);
    if (this.pieces >= PIECES) {
      this.hang(seat);
      return true;
    }
    // Everyone locked out and the stickman still standing: the word beat the
    // table. Nobody is punished, the round simply ends.
    if (this.players.every((p) => p.out)) {
      this.events.push({ kind: 'cleared', word: this.word });
      this.endRound();
      return true;
    }
    this.passTurn();
    return true;
  }

  /** The player who drew the last line forfeits everything they earned this round. */
  private hang(seat: number) {
    const lost = this.players[seat].round;
    this.players[seat].round = 0;
    this.players[seat].hangs++;
    this.events.push({ kind: 'hanged', seat, lost });
    this.endRound();
  }

  private endRound() {
    this.phase = this.history.length >= this.totalRounds ? 'over' : 'roundOver';
    if (this.phase === 'over') {
      // The last round's earnings have to land before anybody is declared the
      // winner — `beginRound` is what normally banks them and it never runs
      // after the final word.
      for (const p of this.players) {
        p.total += p.round;
        p.round = 0;
      }
      this.winner = this.standings()[0]?.seat ?? null;
    }
  }

  /** Advance to the next seat still in the round. */
  private passTurn() {
    for (let step = 1; step <= this.playerCount; step++) {
      const next = (this.turn + step) % this.playerCount;
      if (!this.players[next].out) {
        this.turn = next;
        return;
      }
    }
  }

  /** Move the match on to the next word. Only meaningful while `roundOver`. */
  nextRound() {
    if (this.phase !== 'roundOver') return;
    this.beginRound();
  }

  // ── reading ──────────────────────────────────────────────────────────────

  /** Everyone, best first. Banked total decides it; this round's earnings break a tie. */
  standings(): { seat: number; total: number; round: number }[] {
    return this.players
      .map((p, seat) => ({ seat, total: p.total, round: p.round }))
      .sort((a, b) => b.total - a.total || b.round - a.round || a.seat - b.seat);
  }

  /** Total including the round in progress — what the roster shows mid-round. */
  liveTotal(seat: number): number {
    const p = this.players[seat];
    return p ? p.total + p.round : 0;
  }

  /** Deterministic per (seed, round, action, seat), so every client computes the same bot. */
  rngFor(seat: number): () => number {
    return mulberry32(this.seed + this.round * 7919 + this.actionCount * 131 + seat * 104729);
  }
}

/** What the letters still hidden in `word` are worth, for a correct solve. */
function scoreForRemaining(word: string, called: string[]): number {
  const shown = new Set(called);
  let sum = 0;
  for (const ch of new Set([...word])) {
    if (shown.has(ch)) continue;
    sum += scoreFor(ch, [...word].filter((c) => c === ch).length);
  }
  return sum;
}
