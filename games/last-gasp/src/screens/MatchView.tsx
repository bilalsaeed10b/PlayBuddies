/**
 * The match: the gallows, the word, the keyboard and the wire.
 *
 * The structural decision worth reading before the rest of this file: exactly
 * one client decides what happened, and that is the host. Guests publish the
 * action they want to take and nothing else; the host validates it against
 * the turn order, appends it, and republishes the whole history. A guest
 * never computes a consequence, so there is no arithmetic for two clients to
 * disagree about — the class of bug the alternating-turn games on this
 * platform have each had to be fixed for at least once.
 *
 * The engine is pure and knows nothing about React, Firestore or the DOM.
 * This component owns all three.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Send, Trophy } from 'lucide-react';
import ControlsTray from '@shared/controls/ControlsTray';
import Gallows from '../components/Gallows';
import Keyboard from '../components/Keyboard';
import WordBoard from '../components/WordBoard';
import FaceToken from '../components/FaceToken';
import { LastGaspEngine } from '../engine/LastGaspEngine';
import type { RoundEvent, Seat } from '../engine/LastGaspEngine';
import { botAction, timeoutAction } from '../engine/ai';
import { ALPHABET, BALANCE, PIECES, SEAT_COLORS } from '../game/rules';
import { audioService } from '../services/audio';
import { cleanAttempt, packRules } from '../types/game';
import type { Action, GameSettings, MatchRules, NetPacket, RoundHistory } from '../types/game';
import type { TurnLink } from '../net/turnLink';
import { createLogger } from '@shared/log/logger';

const log = createLogger('last-gasp');

export interface MatchConfig {
  roomId: string | null;
  uid: string | null;
  peerUids: string[];
  isHost: boolean;
  seats: Seat[];
  /** Seats driven from this device: one online, or several sharing a screen. */
  localSeats: number[];
  seed: number;
  rules: MatchRules;
}

/** How long the round-over card sits before the next word is dealt. */
const ROUND_CARD_MS = 3600;
/** How long a bot appears to think, so its turn is watchable. */
const BOT_THINK_MS = 1100;

export default function MatchView({
  config,
  settings,
  onOpenSettings,
  onExit,
  onResult,
}: {
  config: MatchConfig;
  settings: GameSettings;
  onOpenSettings: () => void;
  onExit: () => void;
  onResult: (won: boolean, points: number) => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const linkRef = useRef<TurnLink | null>(null);

  const online = Boolean(config.roomId && config.uid && config.peerUids.length > 0);
  const rulesBits = packRules(config.rules);

  const engine = useMemo(
    () => new LastGaspEngine({ seats: config.seats, seed: config.seed, rules: config.rules }),
    // Rebuilt only when the match itself changes — a settings tweak must not
    // reset the board mid-word.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.seed, config.seats.length],
  );

  /** Bumped whenever the engine's derived state changes, to force a repaint. */
  const [version, setVersion] = useState(0);
  const repaint = useCallback(() => setVersion((v) => v + 1), []);

  const [clock, setClock] = useState<number>(BALANCE.TURN_SECONDS);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState('');
  const [solving, setSolving] = useState(false);

  /**
   * A short, wide screen — a phone turned sideways.
   *
   * Stacked, this screen wants a header, a roster, a gallows, a word, a feed
   * line and a 26-key rack in one column. At 375px tall that does not fit:
   * measured at 812x375 the gallows was pushed to y=-20 and the "call the
   * whole word" button sat at y=384, entirely below the viewport, so the
   * single highest-stakes action in the game was unreachable. Side by side,
   * the board takes the height and the rack takes the width there is plenty
   * of. Measured rather than guessed from a width breakpoint, because a
   * landscape phone is wide enough to clear `sm:` while being exactly the
   * case that needs the other layout.
   */
  const [sideBySide, setSideBySide] = useState(
    () => typeof window !== 'undefined' && window.innerHeight < 520 && window.innerWidth > window.innerHeight,
  );
  useEffect(() => {
    const probe = () => setSideBySide(window.innerHeight < 520 && window.innerWidth > window.innerHeight);
    probe();
    window.addEventListener('resize', probe);
    window.addEventListener('orientationchange', probe);
    return () => {
      window.removeEventListener('resize', probe);
      window.removeEventListener('orientationchange', probe);
    };
  }, []);

  /**
   * The learned match seed.
   *
   * The host's `config.seed` is authoritative. A guest's is only ever this
   * device's own locally-rolled guess — App.tsx never learns the host's real
   * one — so filtering wire packets on it directly would mean a guest
   * rejected every state packet the host ever sent, and the host rejected
   * every play the guest sent back. Corrected the moment the real value
   * arrives, from the `start` packet or the `seed` stamped on the first
   * `state` packet, whichever lands first. (Wanted Board shipped without this
   * and its online play was completely dead until it was found.)
   */
  const effectiveSeedRef = useRef<number>(config.seed);

  const localSet = useMemo(() => new Set(config.localSeats), [config.localSeats]);
  const seatOfUid = useMemo(() => {
    const map = new Map<string, number>();
    config.seats.forEach((seat, i) => map.set(seat.id, i));
    return map;
  }, [config.seats]);
  const seatSeq = config.seats.map((s) => s.id).join(',');

  const myTurn = localSet.has(engine.turn) && engine.phase === 'guessing';
  const turnSeat = config.seats[engine.turn];

  // ── applying an action (host only) ───────────────────────────────────────

  const publish = useCallback(() => {
    linkRef.current?.send({
      t: 'state',
      n: Date.now(),
      s: config.seed,
      h: engine.history,
      r: rulesBits,
      seed: config.seed,
    });
  }, [config.seed, engine, rulesBits]);

  /**
   * Host-side: run an action through the engine and tell everyone.
   *
   * Returns whether it was accepted, so a caller driving a bot or a timeout
   * can tell the difference between "played" and "that seat was not up".
   */
  const commit = useCallback(
    (action: Action): boolean => {
      if (!config.isHost) return false;
      if (!engine.apply(action)) return false;
      const last = engine.events[engine.events.length - 1];
      if (last) soundFor(last);
      log.info('turn:applied', {
        round: engine.round,
        seat: action.s,
        kind: 'l' in action ? ALPHABET[action.l] : 'word',
        pieces: engine.pieces,
        phase: engine.phase,
      });
      repaint();
      if (online) publish();
      return true;
    },
    [config.isHost, engine, repaint, online, publish],
  );

  /** Whatever this device is allowed to do with the current turn. */
  const play = useCallback(
    (action: Action) => {
      if (!engine.canAct(action.s)) return;
      audioService.unlock();
      if (config.isHost) {
        commit(action);
        return;
      }
      linkRef.current?.send({
        t: 'play',
        n: Date.now(),
        // The learned seed, not config.seed — see effectiveSeedRef.
        s: effectiveSeedRef.current,
        rd: engine.round,
        at: engine.actionCount,
        l: 'l' in action ? action.l : -1,
        ...('w' in action ? { w: action.w } : {}),
      });
      // Optimism would be wrong here: the host may reject this (a turn that
      // already moved on, a letter somebody else just took) and there is no
      // "unplay". The board updates when the host says it did, which on a
      // turn-based game nobody is watching frame-by-frame is imperceptible.
    },
    [engine, config.isHost],
  );

  // ── the wire ─────────────────────────────────────────────────────────────

  const handlePacket = useCallback(
    (packet: NetPacket, from: string) => {
      if (packet.t === 'start') {
        if (config.isHost) return;
        effectiveSeedRef.current = packet.seed;
        linkRef.current?.setStamp({ seed: packet.seed, r: packet.r });
        return;
      }

      if (packet.t === 'play') {
        if (!config.isHost || packet.s !== effectiveSeedRef.current) return;
        // A packet for a round that has already ended, or for a turn that has
        // already been taken, is a straggler rather than a move.
        if (packet.rd !== engine.round || packet.at !== engine.actionCount) return;
        const seat = seatOfUid.get(from);
        if (seat === undefined) return;
        const action: Action =
          packet.l >= 0 ? { s: seat, l: packet.l } : { s: seat, w: cleanAttempt(packet.w ?? '') };
        commit(action);
        return;
      }

      if (packet.t === 'state') {
        if (config.isHost) return;
        if (typeof packet.seed === 'number') effectiveSeedRef.current = packet.seed;
        if (packet.s !== effectiveSeedRef.current) return;
        const incoming = packet.h as RoundHistory[];
        const before = engine.events.length;
        // Replay rather than patch: a guest that missed three turns catches up
        // by replaying three turns, and there is no other path to get right.
        engine.replay(incoming);
        const fresh = engine.events[engine.events.length - 1];
        if (fresh && engine.events.length !== before) soundFor(fresh);
        log.info('wire:state', { from, rounds: incoming.length, pieces: engine.pieces });
        repaint();
        return;
      }

      if (packet.t === 'bye') {
        const seat = seatOfUid.get(from);
        if (seat === undefined) return;
        config.seats[seat].control = 'ai';
        config.seats[seat].aiLevel = 1;
        setNotice(`${config.seats[seat].name} walked out. A bot has their chalk.`);
        repaint();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.isHost, engine, seatOfUid, commit, repaint],
  );

  useEffect(() => {
    if (!online || !config.roomId || !config.uid) return;
    let disposed = false;
    let link: TurnLink | null = null;
    let leave: ((e: PageTransitionEvent) => void) | undefined;

    void import('../net/turnLink')
      .then(({ TurnLink: Link }) => {
        if (disposed) return;
        link = new Link(
          config.roomId as string,
          config.uid as string,
          config.peerUids,
          handlePacket,
          (message) => setNotice(message),
          config.isHost ? { seed: config.seed, r: rulesBits } : undefined,
        );
        linkRef.current = link;
        if (config.isHost) {
          link.send({ t: 'start', n: Date.now(), seed: config.seed, r: rulesBits });
        }
        // `persisted` separates a real unload from the browser freezing a
        // backgrounded tab into its bfcache — a phone screen locking must not
        // announce a bye and hand a present player's seat to a bot.
        leave = (e) => {
          if (e.persisted) return;
          link?.close();
        };
        window.addEventListener('pagehide', leave);
      })
      .catch((e) => {
        log.error('wire:open-failed', { message: String(e?.message ?? e) });
        setNotice('Could not reach the other players.');
      });

    return () => {
      disposed = true;
      if (leave) window.removeEventListener('pagehide', leave);
      link?.close();
      linkRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, config.roomId, config.uid, config.peerUids.join(','), config.isHost, config.seed, rulesBits, seatSeq]);

  // ── bots ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!config.isHost || engine.phase !== 'guessing') return;
    const seat = config.seats[engine.turn];
    if (!seat || seat.control !== 'ai') return;
    const id = window.setTimeout(() => {
      commit(botAction(engine, engine.turn, seat.aiLevel, engine.rngFor(engine.turn)));
    }, BOT_THINK_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.isHost, version, engine.phase, engine.turn]);

  // ── the round card, then the next word ───────────────────────────────────

  useEffect(() => {
    if (engine.phase !== 'roundOver') return;
    if (!config.isHost) return;
    const id = window.setTimeout(() => {
      engine.nextRound();
      repaint();
      if (online) publish();
    }, ROUND_CARD_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.phase, config.isHost, version]);

  useEffect(() => {
    if (engine.phase !== 'over') return;
    const mine = config.localSeats[0] ?? 0;
    const won = engine.winner !== null && localSet.has(engine.winner);
    audioService.playEnd(won);
    onResult(won, engine.players[mine]?.total ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.phase]);

  // ── the turn clock ───────────────────────────────────────────────────────

  useEffect(() => {
    if (engine.phase !== 'guessing' || !config.rules.turnTimer) return;
    if (turnSeat?.control === 'ai') return;
    setClock(BALANCE.TURN_SECONDS);
    const id = window.setInterval(() => {
      setClock((c) => {
        if (c <= 1) {
          // Only the host may end a turn. A guest's clock hitting zero just
          // stops counting; the host decides when a turn is spent.
          if (config.isHost) commit(timeoutAction(engine, engine.turn));
          return 0;
        }
        if (c <= 6) audioService.playTick();
        return c - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.phase, engine.turn, engine.round, config.rules.turnTimer, config.isHost, version]);

  // Clear the solve box whenever the turn or the word changes under it.
  useEffect(() => {
    setAttempt('');
    setSolving(false);
  }, [engine.turn, engine.round]);

  // ── render ───────────────────────────────────────────────────────────────

  const board = engine.board;
  const hits = useMemo(
    () => new Set(engine.called.filter((c) => engine.word.includes(c))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, engine.called.length, engine.round],
  );
  const lastEvent = engine.events[engine.events.length - 1];
  const latestPiece =
    lastEvent && (lastEvent.kind === 'miss' || lastEvent.kind === 'wrongWord')
      ? lastEvent.piece - 1
      : undefined;
  const standings = engine.standings();
  const roundOver = engine.phase === 'roundOver' || engine.phase === 'over';

  const submitSolve = () => {
    const cleaned = cleanAttempt(attempt);
    if (cleaned.length === 0) return;
    play({ s: engine.turn, w: cleaned });
    setAttempt('');
    setSolving(false);
  };

  const boardBlock = (
    <>
        <Gallows pieces={engine.pieces} latest={latestPiece} className="h-[22vh] max-h-52 min-h-24 w-auto shrink-0" />

        {/* The two numbers that matter most, on one row and next to the
            drawing they are about. The clock started out up in the header
            and had to move: the shared controls tray wants 250px of a 375px
            phone row on its own, so a third chip up there left nothing
            legible. */}
        <div className="flex items-center gap-3">
          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500">
            {engine.pieces} / {PIECES} lines · {PIECES - engine.pieces} left
          </p>
          {engine.phase === 'guessing' && config.rules.turnTimer && turnSeat?.control !== 'ai' && (
            <span
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-black tabular-nums transition-colors ${
                clock <= 5
                  ? 'border-rose-500 bg-rose-950/70 text-rose-300'
                  : 'border-slate-600/60 bg-slate-900/70 text-slate-300'
              }`}
            >
              {clock}s
            </span>
          )}
        </div>

        {/* The category, sitting directly above the blanks it is a hint for. */}
        <p className="text-center text-[11px] font-black uppercase tracking-[0.22em] text-lime-400/90">
          {engine.category}
        </p>

        <WordBoard board={board} exposed={roundOver} word={engine.word} />

        {/* The one line that always says what just happened, because in a game
            where a turn can cost you the whole round, "what did that do" is
            never a question anyone should have to work out. */}
        <p className="min-h-[2.5em] max-w-md px-2 text-center text-xs font-bold leading-snug text-slate-300">
          {roundOver ? roundSummary(engine, config.seats) : lastEvent ? describe(lastEvent, config.seats, localSet) : 'First guess of the word.'}
        </p>
    </>
  );

  const rackBlock = (
    <>
        {roundOver ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border-2 border-slate-600/50 bg-slate-900/70 py-4">
            {engine.phase === 'over' ? (
              <p className="text-sm font-black uppercase tracking-wide text-slate-300">Counting up…</p>
            ) : (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                <p className="text-sm font-black uppercase tracking-wide text-slate-300">Next word…</p>
              </>
            )}
          </div>
        ) : !myTurn ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border-2 border-slate-600/50 bg-slate-900/70 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
            <p className="text-sm font-black uppercase tracking-wide text-slate-300">
              {turnSeat ? `${turnSeat.name} is thinking` : 'Waiting…'}
            </p>
          </div>
        ) : solving ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                autoFocus
                value={attempt}
                onChange={(e) => setAttempt(cleanAttempt(e.target.value))}
                onKeyDown={(e) => e.key === 'Enter' && submitSolve()}
                placeholder="The whole word…"
                aria-label="Your guess at the whole word"
                className="min-w-0 flex-1 rounded-xl border-2 border-slate-500/60 bg-slate-100 px-3 py-3 text-center text-lg font-black uppercase tracking-[0.2em] text-slate-900 placeholder:text-sm placeholder:font-bold placeholder:tracking-normal placeholder:text-slate-400 focus:border-lime-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={submitSolve}
                disabled={attempt.length === 0}
                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-lime-500 px-4 font-black uppercase tracking-wide text-slate-950 disabled:opacity-40"
              >
                <Send className="h-4 w-4" /> Call
              </button>
            </div>
            <button
              type="button"
              onClick={() => setSolving(false)}
              className="w-full rounded-xl border border-slate-600/60 py-2 text-xs font-bold uppercase tracking-wide text-slate-400"
            >
              Back to letters
            </button>
            <p className="text-center text-[10px] font-bold text-rose-400/80">
              Wrong costs {BALANCE.WRONG_SOLVE_PIECES} lines and the rest of the word.
            </p>
          </div>
        ) : (
          <>
            <Keyboard
              called={engine.called}
              hits={hits}
              disabled={false}
              markUsed={settings.markUsed}
              onPick={(letter) => {
                audioService.playTap();
                play({ s: engine.turn, l: ALPHABET.indexOf(letter) });
              }}
            />
            <button
              type="button"
              onClick={() => setSolving(true)}
              className="w-full rounded-2xl border-2 border-lime-400/60 bg-lime-400/10 py-2.5 text-sm font-black uppercase tracking-[0.18em] text-lime-300 active:scale-[0.99]"
            >
              Call the whole word
              <span className="ml-2 text-[10px] font-bold tracking-normal text-lime-400/60">
                +{engine.hiddenCount * BALANCE.SOLVE_BONUS_PER_LETTER} bonus
              </span>
            </button>
          </>
        )}
    </>
  );

  return (
    <div ref={shellRef} className="relative flex h-[100dvh] w-full flex-col overflow-hidden">
      {/* ── top bar ── */}
      <div className="flex shrink-0 items-start justify-between gap-2 p-2 sm:p-3">
        {/* Just the count. The category used to live here too and wrapped to
            three lines on a 375px phone, squeezing this chip to 27px and
            pushing the controls tray off the edge — the tray alone wants
            250 of a 375px row, so there was never space for both. It reads
            better down beside the word anyway, which is where you are
            actually looking when you use it. */}
        <div className="shrink-0 rounded-2xl border border-slate-600/50 bg-slate-900/70 px-3 py-1.5 backdrop-blur">
          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400">Word</p>
          <p className="text-sm font-black leading-tight tabular-nums text-slate-100">
            {Math.min(engine.round + 1, engine.totalRounds)} / {engine.totalRounds}
          </p>
        </div>

        <div className="shrink-0">
        <ControlsTray
          shellRef={shellRef}
          online={online}
          isHost={config.isHost}
          onSettings={onOpenSettings}
          onExit={onExit}
          theme="dark"
        />
        </div>
      </div>

      {/* ── roster ── */}
      <div className="shrink-0 px-2 sm:px-3">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {config.seats.map((seat, i) => {
            const state = engine.players[i];
            const colors = SEAT_COLORS[i % SEAT_COLORS.length];
            const isTurn = engine.turn === i && engine.phase === 'guessing';
            const mine = localSet.has(i);
            return (
              <div
                key={seat.id}
                className={`flex min-w-0 flex-1 shrink-0 items-center gap-1.5 rounded-xl border-2 px-1.5 py-1 transition-all ${
                  isTurn ? 'scale-[1.02]' : ''
                } ${state?.out ? 'opacity-45' : ''}`}
                style={{
                  borderColor: isTurn ? colors.main : 'rgba(148,163,184,0.22)',
                  background: isTurn ? `${colors.main}1f` : 'rgba(15,23,42,0.55)',
                }}
              >
                <FaceToken skin={seat.skin} size={26} ring={colors.main} out={state?.out} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1 truncate text-[10px] font-black uppercase tracking-wide text-slate-100">
                    {mine ? 'You' : seat.name}
                    {isTurn && <span style={{ color: colors.main }}>●</span>}
                  </p>
                  <p className="text-[10px] font-bold leading-tight tabular-nums text-slate-400">
                    <span className="text-slate-100">{engine.liveTotal(i)}</span>
                    {state && state.round > 0 && (
                      <span className="text-lime-400"> +{state.round}</span>
                    )}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Two explicit arrangements rather than one tree bent with `order`:
          stacked, the rack belongs at the thumb end with the board above it,
          and no ordering trick gets that right in both orientations. */}
      {sideBySide ? (
        <div className="flex min-h-0 flex-1 gap-2 overflow-hidden px-2 pb-2">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-1.5">
            {boardBlock}
          </div>
          <div className="flex w-[52%] max-w-[420px] shrink-0 flex-col justify-center gap-2 overflow-y-auto">
            {rackBlock}
          </div>
        </div>
      ) : (
        <>
          <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col items-center justify-center gap-3 px-3">
            {boardBlock}
          </div>
          <div className="mx-auto w-full max-w-2xl shrink-0 space-y-2 p-2 sm:p-3">{rackBlock}</div>
        </>
      )}

      {notice && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center px-4">
          <p className="rounded-xl border border-slate-500/50 bg-slate-950/95 px-3 py-1.5 text-center text-xs font-bold text-slate-200">
            {notice}
          </p>
        </div>
      )}

      {/* ── the end ── */}
      {engine.phase === 'over' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/80 p-5 backdrop-blur-sm">
          <div className="w-full max-w-sm space-y-4 rounded-[2rem] border-2 border-slate-600/60 bg-slate-900 p-6 text-center">
            <Trophy className="mx-auto h-11 w-11 text-amber-400" />
            <h2 className="text-3xl font-black leading-none text-slate-50">
              {engine.winner !== null && localSet.has(engine.winner) ? 'You won it' : 'They won it'}
            </h2>
            <p className="text-sm font-bold text-slate-400">
              {config.seats[engine.winner ?? 0]?.name} finished on{' '}
              {engine.players[engine.winner ?? 0]?.total ?? 0}.
            </p>

            <div className="space-y-1 rounded-2xl bg-slate-950/60 p-3 text-left">
              {standings.map((row, i) => (
                <div key={config.seats[row.seat].id} className="flex items-center gap-2 text-xs">
                  <span className="w-3 font-black text-slate-500">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-black uppercase tracking-wide text-slate-100">
                    {config.seats[row.seat].name}
                  </span>
                  <span className="font-bold tabular-nums text-slate-500">
                    {engine.players[row.seat].hangs > 0
                      ? `hanged ×${engine.players[row.seat].hangs}`
                      : `${engine.players[row.seat].solves} solved`}
                  </span>
                  <span className="w-10 text-right font-black tabular-nums text-slate-50">
                    {row.total}
                  </span>
                </div>
              ))}
            </div>

            <button
              onClick={onExit}
              className="w-full rounded-2xl bg-lime-500 py-3 font-black uppercase tracking-[0.18em] text-slate-950"
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function describe(event: RoundEvent, seats: Seat[], mine: Set<number>): string {
  const name = (i: number) => (mine.has(i) ? 'You' : (seats[i]?.name ?? 'Someone'));
  const was = (i: number) => (mine.has(i) ? 'were' : 'was');
  switch (event.kind) {
    case 'hit':
      return `${name(event.seat)} called ${event.letter} — ${event.copies} of them, +${event.points}.`;
    case 'miss':
      return `No ${event.letter}. That is line ${event.piece} of ${PIECES}.`;
    case 'solved':
      return `${name(event.seat)} called it: ${event.word}. +${event.points}.`;
    case 'wrongWord':
      return `${name(event.seat)} said ${event.attempt}. Not even close — out for this word.`;
    case 'hanged':
      return event.lost > 0
        ? `${name(event.seat)} drew the last line and ${was(event.seat)} out ${event.lost} points.`
        : `${name(event.seat)} drew the last line.`;
    case 'cleared':
      return `The word was ${event.word}.`;
  }
}

/** The line under the board once a word is done with. */
function roundSummary(engine: LastGaspEngine, seats: Seat[]): string {
  const hanged = engine.events.find((e) => e.kind === 'hanged');
  if (hanged && hanged.kind === 'hanged') {
    return `${seats[hanged.seat]?.name ?? 'Someone'} finished the stickman. The word was ${engine.word}.`;
  }
  const solved = engine.events.find((e) => e.kind === 'solved');
  if (solved && solved.kind === 'solved') {
    return `${seats[solved.seat]?.name ?? 'Someone'} called ${solved.word} and kept everybody alive.`;
  }
  return `The word was ${engine.word}. Nobody hanged.`;
}

function soundFor(event: RoundEvent) {
  switch (event.kind) {
    case 'hit':
      audioService.playHit(event.copies);
      break;
    case 'miss':
      audioService.playMiss();
      break;
    case 'solved':
      audioService.playSolve();
      break;
    case 'wrongWord':
      audioService.playWrong();
      break;
    case 'hanged':
      audioService.playHang();
      break;
    default:
      break;
  }
}
