/**
 * The word, the gallows, and what one guess does to both.
 *
 * This file is a pure function wearing a class. The entire state of a match
 * is derived by replaying `history` from nothing — no state is accumulated
 * incrementally, nothing is cached between rounds, and `replay()` from the
 * same history always lands on the identical result. That is what lets the
 * wire be "here is every action so far" rather than a patch stream, and it
 * is why there is no resync path anywhere in this game: a client that missed
 * six actions catches up by replaying six actions.
 *
 * The one piece of real time in the whole game — a correct guess buying a
 * short exclusive window — is handled without the engine ever touching a
 * clock. The host decides live when that window has lapsed and appends a
 * discrete `expire` action recording that it happened; every other client
 * only ever learns about it by replaying that action, the same as any other.
 * Nothing here ever asks what time it is.
 *
 * It knows nothing about React, Firestore or the DOM. The screen asks it
 * what happened and animates the answer.
 */
import { ALPHABET, BALANCE, PIECES, chainMultiplier, mulberry32, scoreFor } from '../game/rules';
import type { Action, Control, MatchRules, Phase, RoundHistory } from '../types/game';
import { MAX_WORD_LEN, ROUND_CHOICES, cleanWord } from '../types/game';

export interface Seat {
  id: string;
  name: string;
  control: Control;
  aiLevel: number;
  /** Index into FACES. Cosmetic, always. */
  skin: number;
}

export interface PlayerState {
  /** Points safely on the board from finished words. Nothing takes these away. */
  total: number;
  /** Earned this word, and forfeit entirely if this player draws the last line. */
  round: number;
  correct: number;
  wrong: number;
  hangs: number;
  /** Longest unbroken chain this player landed, match-long — the end screen's real bragging right. */
  bestChain: number;
}

/**
 * What happened, newest last. The screen reads this straight out as a feed —
 * it is the word's story, and it is deliberately in resolution order.
 */
export type RoundEvent =
  | { kind: 'wordSet'; seat: number }
  | { kind: 'suggested'; seat: number }
  | { kind: 'voted'; seat: number }
  | { kind: 'wordChosen'; team: number; author: number }
  | { kind: 'hit'; seat: number; letter: string; copies: number; points: number; chain: number }
  | { kind: 'miss'; seat: number; letter: string; piece: number }
  | { kind: 'chainEnded'; seat: number; reason: 'expired' | 'miss' }
  | { kind: 'hanged'; seat: number; lost: number }
  | { kind: 'cleared'; word: string };

export interface EngineConfig {
  seats: Seat[];
  seed: number;
  rules: MatchRules;
}

interface Suggestion {
  seat: number;
  word: string;
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
  pieces = 0;
  phase: Phase = 'settingWord';
  winner: number | null = null;

  /** The current word. Empty until it has actually been set — see the wire-protocol note on secrecy. */
  word = '';

  /** Free-For-All only: who is setting this round's word. */
  setterSeat = 0;
  /** Teams only: which team is setting this round's word. */
  settingTeam = 0;
  /** Teams only, this round: every suggestion offered so far, in submission order. */
  suggestions: Suggestion[] = [];
  /** Teams only, this round: seat -> the suggestion index they voted for. */
  votes = new Map<number, number>();

  /** Who currently holds the guessing chain, and how deep into it they are. Reopens to everyone once this is null. */
  chainHolder: number | null = null;
  chainDepth = 0;

  events: RoundEvent[] = [];

  constructor(cfg: EngineConfig) {
    this.seats = cfg.seats;
    this.seed = cfg.seed;
    this.rules = cfg.rules;
    this.replay([[]]);
  }

  get playerCount(): number {
    return this.seats.length;
  }

  get teamCount(): number {
    return Math.max(1, this.rules.teamCount);
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

  /** The word as it is currently shown: the letter, or null for a blank. */
  get board(): (string | null)[] {
    const shown = new Set(this.called);
    return [...this.word].map((ch) => (shown.has(ch) ? ch : null));
  }

  get solved(): boolean {
    return this.word.length > 0 && this.board.every((c) => c !== null);
  }

  get hiddenCount(): number {
    return this.board.filter((c) => c === null).length;
  }

  /** Letters nobody has called yet this round. */
  get available(): string[] {
    const used = new Set(this.called);
    return ALPHABET.filter((c) => !used.has(c));
  }

  teamOf(seat: number): number {
    return this.rules.mode === 'teams' ? (this.rules.teamOf[seat] ?? 0) : seat;
  }

  seatsOnTeam(team: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.playerCount; i++) if (this.teamOf(i) === team) out.push(i);
    return out;
  }

  // ── legality ─────────────────────────────────────────────────────────────

  /** Whether this seat may set/suggest a word right now. */
  canSetWord(seat: number): boolean {
    if (this.phase === 'settingWord') return this.rules.mode === 'ffa' && seat === this.setterSeat;
    if (this.phase === 'suggesting') {
      return (
        this.rules.mode === 'teams' &&
        this.teamOf(seat) === this.settingTeam &&
        !this.suggestions.some((s) => s.seat === seat)
      );
    }
    return false;
  }

  /** Whether this seat may vote right now, and on what. */
  canVote(seat: number): boolean {
    return (
      this.phase === 'voting' &&
      this.rules.mode === 'teams' &&
      this.teamOf(seat) === this.settingTeam &&
      !this.votes.has(seat)
    );
  }

  /** Whether this seat may call a letter right now — the open table, or the current chain holder alone. */
  canGuess(seat: number): boolean {
    if (this.phase !== 'guessing') return false;
    const settingSide = this.rules.mode === 'teams' ? this.settingTeam : this.setterSeat;
    if (this.teamOf(seat) === settingSide) return false;
    if (this.chainHolder !== null) return this.chainHolder === seat;
    return true;
  }

  /** Only the host ever calls this — it is not something a player "does". */
  canExpire(): boolean {
    return this.phase === 'guessing' && this.chainHolder !== null;
  }

  // ── resolution ───────────────────────────────────────────────────────────

  replay(history: RoundHistory[]) {
    this.players = this.seats.map(() => ({
      total: 0, round: 0, correct: 0, wrong: 0, hangs: 0, bestChain: 0,
    }));
    this.history = [];
    this.phase = this.rules.mode === 'teams' ? 'suggesting' : 'settingWord';
    this.winner = null;
    this.setterSeat = 0;
    this.settingTeam = 0;
    this.resetRound();

    for (let r = 0; r < history.length; r++) {
      if (r > 0) this.beginRound();
      this.history[r] = [];
      for (const action of history[r]) this.apply(action);
    }
    if (this.history.length === 0) this.history = [[]];
  }

  private resetRound() {
    this.word = '';
    this.called = [];
    this.pieces = 0;
    this.events = [];
    this.suggestions = [];
    this.votes = new Map();
    this.chainHolder = null;
    this.chainDepth = 0;
  }

  private beginRound() {
    for (const p of this.players) p.total += p.round;
    this.resetRound();
    this.setterSeat = this.history.length % this.playerCount;
    this.settingTeam = this.history.length % this.teamCount;
    this.phase = this.rules.mode === 'teams' ? 'suggesting' : 'settingWord';
    this.history.push([]);
  }

  /**
   * One action, start to finish.
   *
   * Rejects rather than corrects. A rejected action simply never happened —
   * the caller tries again or a timeout picks something for it — which is
   * only safe because this game has no fixed turn order to stall: rejecting
   * one player's stale packet blocks nobody else.
   */
  apply(action: Action): boolean {
    if (action.t === 'word') return this.applyWord(action.s, action.w);
    if (action.t === 'vote') return this.applyVote(action.s, action.pick);
    if (action.t === 'guess') return this.applyGuess(action.s, action.l);
    if (action.t === 'expire') return this.applyExpire();
    return false;
  }

  private applyWord(seat: number, raw: string): boolean {
    if (!this.canSetWord(seat)) return false;
    const word = cleanWord(raw);
    if (word.length < BALANCE.MIN_WORD_LEN || word.length > MAX_WORD_LEN) return false;

    if (this.phase === 'settingWord') {
      this.word = word;
      this.phase = 'guessing';
      this.events.push({ kind: 'wordSet', seat });
      this.history[this.round].push({ t: 'word', s: seat, w: word });
      return true;
    }

    // Teams: a suggestion. Recorded now; scored once every teammate is in.
    this.suggestions.push({ seat, word });
    this.events.push({ kind: 'suggested', seat });
    this.history[this.round].push({ t: 'word', s: seat, w: word });

    const team = this.seatsOnTeam(this.settingTeam);
    if (this.suggestions.length < team.length) return true;

    if (team.length === 1) {
      // Nobody to vote against. Their one suggestion is the word.
      this.chooseWord(0);
    } else {
      this.phase = 'voting';
    }
    return true;
  }

  private applyVote(seat: number, pick: number): boolean {
    if (!this.canVote(seat)) return false;
    if (pick < 0 || pick >= this.suggestions.length) return false;
    this.votes.set(seat, pick);
    this.events.push({ kind: 'voted', seat });
    this.history[this.round].push({ t: 'vote', s: seat, pick });

    const team = this.seatsOnTeam(this.settingTeam);
    if (this.votes.size < team.length) return true;

    const tally = new Array(this.suggestions.length).fill(0);
    for (const pickIdx of this.votes.values()) tally[pickIdx]++;
    let winner = 0;
    for (let i = 1; i < tally.length; i++) if (tally[i] > tally[winner]) winner = i;
    this.chooseWord(winner);
    return true;
  }

  private chooseWord(index: number) {
    const pick = this.suggestions[index];
    this.word = pick.word;
    this.phase = 'guessing';
    this.events.push({ kind: 'wordChosen', team: this.settingTeam, author: pick.seat });
  }

  private applyGuess(seat: number, letterIndex: number): boolean {
    const letter = ALPHABET[letterIndex];
    if (!letter || this.called.includes(letter)) return false;
    if (!this.canGuess(seat)) return false;

    this.called.push(letter);
    const copies = [...this.word].filter((c) => c === letter).length;
    const me = this.players[seat];

    if (copies > 0) {
      const depth = this.chainHolder === seat ? this.chainDepth + 1 : 0;
      const points = Math.round(scoreFor(letter, copies) * chainMultiplier(depth));
      me.round += points;
      me.correct++;
      this.chainHolder = seat;
      this.chainDepth = depth;
      if (depth > me.bestChain) me.bestChain = depth;
      this.events.push({ kind: 'hit', seat, letter, copies, points, chain: depth });
      this.history[this.round].push({ t: 'guess', s: seat, l: letterIndex });

      if (this.solved) {
        this.events.push({ kind: 'cleared', word: this.word });
        this.endRound();
      }
      return true;
    }

    // A miss always ends whatever chain was live, whether it belonged to the
    // seat that just missed (they had the window and blew it) or nobody
    // (the table was open and this was just a bad open guess).
    const hadChain = this.chainHolder !== null;
    const chainOwner = this.chainHolder;
    this.chainHolder = null;
    this.chainDepth = 0;

    me.wrong++;
    this.pieces++;
    this.events.push({ kind: 'miss', seat, letter, piece: this.pieces });
    if (hadChain && chainOwner !== null) {
      this.events.push({ kind: 'chainEnded', seat: chainOwner, reason: 'miss' });
    }
    this.history[this.round].push({ t: 'guess', s: seat, l: letterIndex });

    if (this.pieces >= PIECES) {
      this.hang(seat);
    }
    return true;
  }

  private applyExpire(): boolean {
    if (!this.canExpire()) return false;
    const seat = this.chainHolder as number;
    this.chainHolder = null;
    this.chainDepth = 0;
    this.events.push({ kind: 'chainEnded', seat, reason: 'expired' });
    this.history[this.round].push({ t: 'expire' });
    return true;
  }

  /** The player who drew the last line forfeits everything they earned this word. */
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
      for (const p of this.players) {
        p.total += p.round;
        p.round = 0;
      }
      this.winner = this.standings()[0]?.seat ?? null;
    }
  }

  /** Move the match on to the next word. Only meaningful while `roundOver`. */
  nextRound() {
    if (this.phase !== 'roundOver') return;
    this.beginRound();
  }

  // ── reading ──────────────────────────────────────────────────────────────

  standings(): { seat: number; total: number; round: number }[] {
    return this.players
      .map((p, seat) => ({ seat, total: p.total, round: p.round }))
      .sort((a, b) => b.total - a.total || b.round - a.round || a.seat - b.seat);
  }

  /** Per-team totals, best first — only meaningful in Teams. */
  teamStandings(): { team: number; total: number }[] {
    const totals = new Array(this.teamCount).fill(0);
    for (let i = 0; i < this.playerCount; i++) totals[this.teamOf(i)] += this.liveTotal(i);
    return totals.map((total, team) => ({ team, total })).sort((a, b) => b.total - a.total || a.team - b.team);
  }

  /** Total including the word in progress — what the roster shows mid-round. */
  liveTotal(seat: number): number {
    const p = this.players[seat];
    return p ? p.total + p.round : 0;
  }

  /** Deterministic per (seed, round, actions-so-far, seat), so every client computes the same bot. */
  rngFor(seat: number): () => number {
    return mulberry32(this.seed + this.round * 7919 + this.actionCount * 131 + seat * 104729);
  }
}
