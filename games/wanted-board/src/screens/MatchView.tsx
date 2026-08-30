/**
 * The match: the town, the rack, the wire, and the reveal.
 *
 * The one structural decision worth reading before the rest of this file: in a
 * simultaneous game exactly one client must be allowed to decide when a round
 * is over, and here that is the host. Guests publish their own card and
 * nothing else; the host collects every card, resolves, and publishes the
 * whole history. A guest never computes a resolution, so there is no
 * arithmetic for two clients to disagree about — which is the entire class of
 * bug that alternating-turn games on this platform have had to be fixed for.
 *
 * The engine is pure and knows nothing about React, Firestore or the DOM. This
 * component owns all three.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Trophy } from 'lucide-react';
import ControlsTray from '@shared/controls/ControlsTray';
import CardRack from '../components/CardRack';
import TownMap from '../components/TownMap';
import OutlawToken from '../components/OutlawToken';
import { WantedEngine } from '../engine/WantedEngine';
import type { RoundEvent, Seat } from '../engine/WantedEngine';
import { botChoice } from '../engine/ai';
import { BALANCE, CARDS, PLACES, SEAT_COLORS } from '../game/rules';
import type { CardId } from '../game/rules';
import { audioService } from '../services/audio';
import { decodeChoice, encodeChoice, packRules } from '../types/game';
import type { Choice, EncodedRound, GameSettings, MatchRules, NetPacket } from '../types/game';
import type { TurnLink } from '../net/turnLink';
import { createLogger } from '@shared/log/logger';

const log = createLogger('wanted-board');

export interface MatchConfig {
  roomId: string | null;
  uid: string | null;
  peerUids: string[];
  isHost: boolean;
  seats: Seat[];
  /** Seats driven from this device: one online, or several sharing a phone. */
  localSeats: number[];
  seed: number;
  rules: MatchRules;
}

/** How long each beat of the reveal holds, in ms. */
const REVEAL_FLIP = 1150;
const REVEAL_EVENT = 620;
const REVEAL_TAIL = 700;

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
  onResult: (won: boolean, banked: number) => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const linkRef = useRef<TurnLink | null>(null);

  const online = Boolean(config.roomId && config.uid && config.peerUids.length > 0);
  const rulesBits = packRules(config.rules);

  /**
   * The seed every wire packet is actually checked against.
   *
   * The host's `config.seed` is authoritative from the start. A guest's
   * `config.seed` is only ever this device's own locally-rolled guess — App.tsx
   * never learns the host's real one — so filtering wire packets on it
   * directly meant a guest rejected every `round` packet the host ever sent,
   * and the host rejected every `pick` the guest sent back, because the two
   * numbers were independently random and essentially never matched. This ref
   * starts at the local guess and is corrected the moment a guest hears the
   * real value from the host, via the `start` packet or the `seed` stamped on
   * the first `round` packet, whichever lands first.
   */
  const effectiveSeedRef = useRef<number>(config.seed);

  const engine = useMemo(
    () => new WantedEngine({ seats: config.seats, seed: config.seed, rules: config.rules }),
    // Rebuilt only when the match itself changes — a settings tweak must not
    // reset the town mid-game.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.seed, config.seats.length],
  );

  /** Bumped whenever the engine's derived state changes, to force a repaint. */
  const [version, setVersion] = useState(0);
  const repaint = useCallback(() => setVersion((v) => v + 1), []);

  const [phase, setPhase] = useState<'choosing' | 'reveal' | 'over'>('choosing');
  const [revealStep, setRevealStep] = useState(0);
  const [clock, setClock] = useState<number>(BALANCE.ROUND_SECONDS);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * A short, wide screen — a phone turned sideways.
   *
   * The stacked layout wants a header, a roster, a square board and a card
   * rack in one column, and on a 375px-tall landscape phone that leaves the
   * board about 100px. Side by side, the board gets the full height
   * and the rack takes the width there is plenty of. Measured rather than
   * guessed from a width breakpoint, because a landscape phone is wide enough
   * to clear `sm:` while being exactly the case that needs the other layout.
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

  /** Which local seat is currently at the rack. Couch play walks down the list. */
  const [activeLocal, setActiveLocal] = useState(0);
  const [handoff, setHandoff] = useState(false);
  const [selected, setSelected] = useState<CardId | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  /** Cards this device has already committed for the round in progress. */
  const [myPicks, setMyPicks] = useState<Record<number, Choice>>({});
  /** Bit per seat, from the host, purely so the waiting line can name a number. */
  const [lockedMask, setLockedMask] = useState(0);

  /**
   * Everybody's card for the round the host is still collecting.
   *
   * Host-only. A guest never sees another player's card until the round is
   * resolved and published, which is the one secret this game actually keeps.
   */
  const collected = useRef(new Map<number, Choice>());
  const seatOfUid = useMemo(() => {
    const map = new Map<string, number>();
    config.seats.forEach((seat, i) => map.set(seat.id, i));
    return map;
  }, [config.seats]);

  const seatSeq = config.seats.map((s) => s.id).join(',');
  const localSet = useMemo(() => new Set(config.localSeats), [config.localSeats]);

  // ── the reveal ───────────────────────────────────────────────────────────

  const playReveal = useCallback(() => {
    setPhase('reveal');
    setRevealStep(0);
    audioService.playFlip();
  }, []);

  useEffect(() => {
    if (phase !== 'reveal') return;
    const events = engine.lastEvents;
    if (revealStep > events.length) {
      // Every beat has landed. Either the night is over or somebody has to
      // pick a card again.
      const done = engine.phase === 'over';
      const id = window.setTimeout(() => {
        if (done) {
          setPhase('over');
          const mine = config.localSeats[0] ?? 0;
          const won = engine.winner !== null && localSet.has(engine.winner);
          audioService.playEnd(won);
          onResult(won, engine.players[mine]?.banked ?? 0);
        } else {
          setPhase('choosing');
          setMyPicks({});
          setSelected(null);
          setTarget(null);
          setActiveLocal(0);
          setLockedMask(0);
          setClock(BALANCE.ROUND_SECONDS);
        }
      }, REVEAL_TAIL);
      return () => window.clearTimeout(id);
    }

    const delay = revealStep === 0 ? REVEAL_FLIP : REVEAL_EVENT;
    const id = window.setTimeout(() => {
      const event = events[revealStep];
      if (event) soundFor(event);
      setRevealStep((s) => s + 1);
    }, delay);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, revealStep, version]);

  // ── resolving a round (host only) ────────────────────────────────────────

  const resolveRound = useCallback(() => {
    if (!config.isHost || engine.phase === 'over') return;
    const round = engine.round;
    const encoded: EncodedRound = config.seats.map((seat, i) => {
      const picked = collected.current.get(i);
      if (picked) return encodeChoice(engine.sanitise(i, picked));
      if (seat.control === 'ai' || seat.control === 'remote') {
        // A bot, or a human whose card never arrived. Both get the same
        // treatment: a bot plays its seeded decision, and anyone who ran out
        // of clock lays low (see BALANCE.TIMEOUT_CARD — a timeout is a locked
        // phone, not a decision to gamble).
        if (seat.control === 'ai') {
          return encodeChoice(botChoice(engine, i, seat.aiLevel, engine.rngFor(round, i)));
        }
      }
      return encodeChoice(engine.sanitise(i, { card: BALANCE.TIMEOUT_CARD, target: 0 }));
    });

    collected.current.clear();
    log.info('round:resolve', {
      round,
      cards: encoded,
      banked: engine.players.map((p) => p.banked),
      bounty: engine.players.map((p) => p.bounty),
    });
    engine.applyRound(encoded);
    repaint();
    playReveal();

    linkRef.current?.send({
      t: 'round',
      n: Date.now(),
      s: config.seed,
      h: engine.history,
      lk: 0,
      r: rulesBits,
      seed: config.seed,
    });
  }, [config.isHost, config.seats, config.seed, engine, repaint, playReveal, rulesBits]);

  /** Host: fill in every seat this device answers for, then go if that is everybody. */
  const tryResolve = useCallback(() => {
    if (!config.isHost || phase !== 'choosing') return;
    const round = engine.round;
    for (let i = 0; i < config.seats.length; i++) {
      if (collected.current.has(i)) continue;
      if (config.seats[i].control === 'ai') {
        collected.current.set(i, botChoice(engine, i, config.seats[i].aiLevel, engine.rngFor(round, i)));
      }
    }
    if (collected.current.size < config.seats.length) {
      // Publish who is still deciding, so a guest's screen can say so.
      let mask = 0;
      for (const seat of collected.current.keys()) mask |= 1 << seat;
      setLockedMask(mask);
      if (online) {
        linkRef.current?.send({
          t: 'round',
          n: Date.now(),
          s: config.seed,
          h: engine.history,
          lk: mask,
          r: rulesBits,
          seed: config.seed,
        });
      }
      return;
    }
    resolveRound();
  }, [config.isHost, config.seats, config.seed, engine, phase, online, resolveRound, rulesBits]);

  // ── the wire ─────────────────────────────────────────────────────────────

  const handlePacket = useCallback(
    (packet: NetPacket, from: string) => {
      if (packet.t === 'start') {
        // The host's word on what this match's seed actually is. A guest that
        // never hears this (or the same value stamped on the first `round`
        // packet, below) has no way to pass the staleness check on anything
        // it sends or receives for the rest of the match.
        if (config.isHost) return;
        effectiveSeedRef.current = packet.seed;
        linkRef.current?.setStamp({ seed: packet.seed, r: packet.r });
        return;
      }

      if (packet.t === 'pick') {
        if (!config.isHost || packet.s !== effectiveSeedRef.current) return;
        // A card for a round that has already resolved is a straggler, not a move.
        if (packet.rd !== engine.round) return;
        const seat = seatOfUid.get(from);
        if (seat === undefined) return;
        collected.current.set(seat, decodeChoice(packet.c));
        tryResolve();
        return;
      }

      if (packet.t === 'round') {
        log.info('wire:recv-round', { from, rounds: packet.h?.length, locked: packet.lk });
        if (config.isHost) return;
        // The host stamps its real seed on every round packet too, so a guest
        // that missed (or raced) the `start` packet still catches up here.
        if (typeof packet.seed === 'number') effectiveSeedRef.current = packet.seed;
        if (packet.s !== effectiveSeedRef.current) return;
        setLockedMask(packet.lk ?? 0);
        if (packet.h.length <= engine.history.length) return;
        // Replay rather than patch: a guest that missed three packets catches
        // up by replaying three rounds, and there is no other path to get right.
        engine.replay(packet.h);
        repaint();
        playReveal();
        return;
      }

      if (packet.t === 'bye') {
        const seat = seatOfUid.get(from);
        if (seat === undefined) return;
        config.seats[seat].control = 'ai';
        config.seats[seat].aiLevel = 1;
        config.seats[seat].name = `${config.seats[seat].name} (fled)`;
        setNotice(`${config.seats[seat].name} rode out. A bot has the reins.`);
        repaint();
        tryResolve();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.isHost, config.seed, engine, seatOfUid, tryResolve, repaint, playReveal],
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

  // ── the round clock ──────────────────────────────────────────────────────

  useEffect(() => {
    if (phase !== 'choosing' || !config.rules.roundTimer || engine.phase === 'over') return;
    const id = window.setInterval(() => {
      setClock((c) => {
        if (c <= 1) {
          // Only the host may end a round. A guest's clock hitting zero just
          // locks whatever it had; the host decides when that becomes a round.
          if (config.isHost) resolveRound();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, config.rules.roundTimer, config.isHost, engine.phase, resolveRound, version]);

  // ── committing a card ────────────────────────────────────────────────────

  const seatAtRack = config.localSeats[activeLocal] ?? config.localSeats[0] ?? 0;
  const legal = engine.legalCards(seatAtRack);
  const highlight =
    phase === 'choosing' && selected && CARDS[selected].needsTarget && !myPicks[seatAtRack]
      ? engine.legalTargets(seatAtRack, selected)
      : [];

  const lockIn = useCallback(() => {
    if (!selected) return;
    const meta = CARDS[selected];
    if (meta.needsTarget && target === null) return;
    const choice = engine.sanitise(seatAtRack, {
      card: selected,
      target: target ?? engine.players[seatAtRack].place,
    });
    audioService.unlock();
    audioService.playLock();
    setMyPicks((p) => ({ ...p, [seatAtRack]: choice }));
    setSelected(null);
    setTarget(null);

    if (config.isHost) {
      collected.current.set(seatAtRack, choice);
    } else {
      linkRef.current?.send({
        t: 'pick',
        n: Date.now(),
        // The learned seed, not config.seed — see effectiveSeedRef above. Using
        // this device's own local guess here is what made the host discard
        // every guest's card: the two seeds are independently random and
        // essentially never match.
        s: effectiveSeedRef.current,
        rd: engine.round,
        c: encodeChoice(choice),
      });
    }

    const next = activeLocal + 1;
    if (next < config.localSeats.length) {
      // Couch play: the device changes hands, and the next player must not see
      // what the last one just chose.
      setActiveLocal(next);
      setHandoff(true);
    } else if (config.isHost) {
      tryResolve();
    }
  }, [selected, target, seatAtRack, engine, config, activeLocal, tryResolve]);

  // A bot-only table still has to advance, and so does a host whose guests
  // have all already locked in before this device mounted.
  useEffect(() => {
    if (phase === 'choosing' && config.isHost) tryResolve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, version]);

  // ── render ───────────────────────────────────────────────────────────────

  const myTrap = engine.trapOf(seatAtRack)?.place;
  const revealedChoices = phase === 'reveal' ? engine.lastChoices : [];
  const hiddenSeats =
    phase === 'reveal' ? revealedChoices.flatMap((c, i) => (c.card === 'layLow' ? [i] : [])) : [];
  const waiting = config.seats.filter((_, i) => !(lockedMask & (1 << i)) && !myPicks[i]).length;
  const allMineIn = config.localSeats.every((s) => myPicks[s]);
  const standings = engine.standings();
  // The event that most recently landed — same one `soundFor` just played a
  // beat ago — is what the pawns are reacting to right now.
  const activeEvent = phase === 'reveal' ? engine.lastEvents[revealStep - 1] : undefined;
  const bubbles = bubbleFor(activeEvent);

  const townBlock = (
    <TownMap
      engine={engine}
      seats={config.seats}
      localSeats={config.localSeats}
      highlight={highlight}
      onPick={phase === 'choosing' && !handoff ? (place) => setTarget(place) : undefined}
      myTrap={myTrap}
      hiddenSeats={hiddenSeats}
      bubbles={bubbles}
    />
  );

  /** One card per player: who they are, what they have banked, and whether they have decided. */
  const rosterBlock = config.seats.map((seat, i) => {
    const state = engine.players[i];
    const colors = SEAT_COLORS[i % SEAT_COLORS.length];
    const mine = localSet.has(i);
    const isIn = Boolean(lockedMask & (1 << i)) || Boolean(myPicks[i]);
    return (
      <div
        key={seat.id}
        className="flex min-w-0 flex-1 shrink-0 items-center gap-1.5 rounded-xl border-2 px-1.5 py-1"
        style={{
          borderColor: mine ? colors.main : 'rgba(120,53,15,0.18)',
          background: mine ? `${colors.main}14` : 'rgba(247,236,214,0.7)',
        }}
      >
        <OutlawToken skin={seat.skin} size={26} ring={colors.main} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 truncate text-[10px] font-black uppercase tracking-wide text-amber-950">
            {seat.name}
            {phase === 'choosing' && isIn && <span className="text-rose-700">•</span>}
          </p>
          <p className="text-[10px] font-bold leading-tight text-amber-900/70 tabular-nums">
            <span className="text-amber-950">${state?.banked ?? 0}</span>
            <span className="text-amber-900/40"> banked</span>
          </p>
          <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-amber-900/15">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${engine.bankedFraction(i) * 100}%`, background: colors.main }}
            />
          </div>
        </div>
      </div>
    );
  });

  const rackBlock =
    phase === 'reveal' ? (
      <RevealPanel engine={engine} seats={config.seats} step={revealStep} />
    ) : phase === 'over' ? null : handoff ? (
      <button
        type="button"
        onClick={() => setHandoff(false)}
        className="w-full rounded-2xl border-2 border-amber-900/25 bg-[#f7ecd6] py-5 text-center active:scale-95"
      >
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-900/50">Pass the device</p>
        <p className="text-xl font-black text-amber-950">{config.seats[seatAtRack]?.name}</p>
        <p className="text-[11px] font-bold text-amber-900/60">Tap when you have it, and nobody else is looking.</p>
      </button>
    ) : allMineIn ? (
      <div className="flex items-center justify-center gap-2 rounded-2xl border-2 border-amber-900/20 bg-[#f7ecd6] py-5">
        <Loader2 className="h-4 w-4 animate-spin text-amber-900/50" />
        <p className="text-sm font-black uppercase tracking-wide text-amber-900/70">
          {waiting > 0 ? `Waiting on ${waiting}` : 'Dealing…'}
        </p>
      </div>
    ) : (
      <CardRack
        legal={legal}
        selected={selected}
        target={target}
        locked={Boolean(myPicks[seatAtRack])}
        hints={settings.hints}
        onSelect={(card) => {
          audioService.unlock();
          audioService.playPop();
          setSelected(card);
          // A card that points at nothing gets its target now; one that points
          // somewhere waits for a tap on the map.
          setTarget(CARDS[card].needsTarget ? null : engine.players[seatAtRack].place);
        }}
        onLock={lockIn}
      />
    );

  return (
    <div ref={shellRef} className="relative flex h-[100dvh] w-full flex-col overflow-hidden">
      {/* ── top bar: the round, the clock, the tray ── */}
      <div className="flex shrink-0 items-start justify-between gap-2 p-2 sm:p-3">
        <div className="rounded-2xl border border-amber-900/20 bg-[#f7ecd6]/90 px-3 py-1.5">
          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-amber-900/50">
            Round {Math.min(engine.round + 1, BALANCE.ROUNDS)} / {BALANCE.ROUNDS}
          </p>
          <p className="text-sm font-black leading-tight text-amber-950">
            {phase === 'reveal' ? 'Cards on the table' : phase === 'over' ? 'The night is over' : 'Everybody choose'}
          </p>
        </div>

        {phase === 'choosing' && config.rules.roundTimer && (
          <div
            className={`rounded-2xl border px-3 py-1.5 text-center ${
              clock <= 5 ? 'border-rose-700 bg-rose-100' : 'border-amber-900/20 bg-[#f7ecd6]/90'
            }`}
          >
            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-amber-900/50">Clock</p>
            <p className={`text-lg font-black leading-none tabular-nums ${clock <= 5 ? 'text-rose-800' : 'text-amber-950'}`}>
              {clock}
            </p>
          </div>
        )}

        <ControlsTray
          shellRef={shellRef}
          online={online}
          isHost={config.isHost}
          onSettings={onOpenSettings}
          onExit={onExit}
          theme="light"
        />
      </div>

      {/* ── the body ──
          Two explicit arrangements rather than one tree bent with `order`:
          stacked, the roster belongs at the top and the rack at the thumb end
          with the board between them, and no ordering trick gets all three of
          those right at once. */}
      {sideBySide ? (
        <div className="flex min-h-0 flex-1 gap-2 overflow-hidden px-2 pb-2">
          <div className="flex min-h-0 min-w-0 flex-1">{townBlock}</div>
          <div className="flex w-[46%] max-w-[330px] shrink-0 flex-col justify-center gap-1.5 overflow-y-auto">
            <div className="flex flex-col gap-1.5">{rosterBlock}</div>
            {rackBlock}
          </div>
        </div>
      ) : (
        <>
          <div className="shrink-0 px-2 sm:px-3">
            <div className="flex gap-1.5 overflow-x-auto pb-1">{rosterBlock}</div>
          </div>
          <div className="flex min-h-0 flex-1 px-2">{townBlock}</div>
          <div className="shrink-0 p-2 sm:p-3">{rackBlock}</div>
        </>
      )}

      {notice && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex justify-center px-4">
          <p className="rounded-xl border border-amber-800/40 bg-amber-950/90 px-3 py-1.5 text-center text-xs font-bold text-amber-100">
            {notice}
          </p>
        </div>
      )}

      {/* ── the end ── */}
      {phase === 'over' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-amber-950/70 p-5 backdrop-blur-sm">
          <div className="w-full max-w-sm space-y-4 rounded-[2rem] border-2 border-amber-900/30 bg-[#f7ecd6] p-6 text-center">
            <Trophy className="mx-auto h-11 w-11 text-amber-600" />
            <h2 className="text-3xl font-black leading-none text-amber-950">
              {engine.winner !== null && localSet.has(engine.winner) ? 'You walked away with it' : 'They walked away with it'}
            </h2>
            <p className="text-sm font-bold text-amber-900/60">
              {config.seats[engine.winner ?? 0]?.name} banked ${engine.players[engine.winner ?? 0]?.banked ?? 0}.
            </p>

            <div className="space-y-1 rounded-2xl bg-amber-900/5 p-3 text-left">
              {standings.map((row, i) => (
                <div key={config.seats[row.seat].id} className="flex items-center gap-2 text-xs">
                  <span className="w-3 font-black text-amber-900/40">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-black uppercase tracking-wide text-amber-950">
                    {config.seats[row.seat].name}
                  </span>
                  <span className="font-bold tabular-nums text-amber-900/50">
                    peak ${engine.players[row.seat].peakBounty}
                  </span>
                  <span className="w-14 text-right font-black tabular-nums text-amber-950">${row.banked}</span>
                </div>
              ))}
            </div>

            <button
              onClick={onExit}
              className="w-full rounded-2xl bg-rose-800 py-3 font-black uppercase tracking-[0.18em] text-amber-50"
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What everybody played, and what it cost them.
 *
 * The cards land first and all at once — that is the moment the whole game is
 * built around — and the consequences then arrive one line at a time, in the
 * order the rules actually resolved them. Nothing here re-derives anything;
 * it is a read-only view of `engine.lastEvents`.
 */
function RevealPanel({ engine, seats, step }: { engine: WantedEngine; seats: Seat[]; step: number }) {
  const events = engine.lastEvents;
  const shown = events.slice(0, Math.max(0, step));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {seats.map((seat, i) => {
          const choice = engine.lastChoices[i];
          const colors = SEAT_COLORS[i % SEAT_COLORS.length];
          if (!choice) return null;
          return (
            <div
              key={seat.id}
              className="animate-[flip_320ms_ease-out] rounded-xl border-2 px-2 py-1.5 text-center"
              style={{ borderColor: colors.main, background: `${colors.main}12` }}
            >
              <p className="truncate text-[9px] font-black uppercase tracking-wide text-amber-900/50">{seat.name}</p>
              <p className="text-xs font-black uppercase leading-tight text-amber-950">{CARDS[choice.card].name}</p>
              {CARDS[choice.card].needsTarget && (
                <p className="text-[9px] font-bold text-amber-900/50">{PLACES[choice.target]?.name}</p>
              )}
            </div>
          );
        })}
      </div>

      <div className="min-h-[56px] space-y-0.5 rounded-xl border border-amber-900/15 bg-amber-900/5 px-3 py-1.5">
        {shown.length === 0 ? (
          <p className="py-2 text-center text-[11px] font-bold text-amber-900/40">…</p>
        ) : (
          shown.map((event, i) => (
            <p key={i} className="text-[11px] font-bold leading-snug text-amber-950">
              {describe(event, seats)}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function describe(event: RoundEvent, seats: Seat[]): string {
  const name = (i: number) => seats[i]?.name ?? 'Someone';
  switch (event.kind) {
    case 'move':
      return `${name(event.seat)} rode to ${PLACES[event.to]?.name}.`;
    case 'trap':
      return event.amount > 0
        ? `${name(event.seat)} hit ${name(event.owner)}'s trap at ${PLACES[event.place]?.name} — $${event.amount} gone.`
        : `${name(event.seat)} tripped a trap at ${PLACES[event.place]?.name}, carrying nothing.`;
    case 'ambush':
      return `${name(event.seat)} was waiting at ${PLACES[event.place]?.name}. Took $${event.amount} off ${event.victims
        .map(name)
        .join(' and ')}.`;
    case 'standoff':
      return `${event.seats.map(name).join(' and ')} both drew at ${PLACES[event.place]?.name}. Nobody blinked.`;
    case 'miss':
      return `${name(event.seat)} waited at ${PLACES[event.place]?.name}. Nobody came.`;
    case 'bank':
      return event.amount > 0
        ? `${name(event.seat)} banked $${event.amount}. That one is safe.`
        : `${name(event.seat)} reached the counter with empty pockets.`;
    case 'pay':
      return `${name(event.seat)} +$${event.amount} on their head.`;
    case 'scout':
      return event.target === null
        ? `${name(event.seat)} sent word ahead. Nobody worth chasing.`
        : `${name(event.seat)} sent word ahead — ${name(event.target)} is at ${PLACES[event.place as number]?.name} carrying $${event.amount}.`;
  }
}

/**
 * What a pawn says during the beat its own event is landing.
 *
 * Purely cosmetic and purely local: every client computes the identical
 * `RoundEvent` from the same public history, but which of several lines gets
 * picked for it does not have to match from one screen to the next — nobody
 * is comparing bubbles, so this is the one piece of the reveal that is
 * allowed to use `Math.random()` instead of the seeded rng everything else
 * in this game is built on.
 */
function bubbleFor(event: RoundEvent | undefined): { seat: number; text: string }[] {
  if (!event) return [];
  const pick = (lines: string[]) => lines[Math.floor(Math.random() * lines.length)];
  switch (event.kind) {
    case 'move':
      return [{ seat: event.seat, text: pick(["Yeehaw!", "Ridin' on.", 'See ya.', 'Dust and gone.']) }];
    case 'trap':
      return event.amount > 0
        ? [
            { seat: event.owner, text: pick(['Gotcha.', 'Works every time.', 'Ha!']) },
            { seat: event.seat, text: pick(['Blast it!', 'Dagnabbit.', "Should'a watched my step."]) },
          ]
        : [{ seat: event.seat, text: pick(['Huh. Empty.', 'Lucky me.']) }];
    case 'ambush':
      return [
        { seat: event.seat, text: pick(["Stick 'em up!", "That's mine now.", 'Easy money.']) },
        ...event.victims.map((v) => ({ seat: v, text: pick(['Hands up...', 'You got me.', 'No fair!']) })),
      ];
    case 'standoff':
      return event.seats.map((s) => ({ seat: s, text: pick(['Well, howdy.', '...awkward.', 'Same idea, huh?']) }));
    case 'miss':
      return [{ seat: event.seat, text: pick(['...Anybody?', "Waited for nothin'.", 'This is embarrassing.']) }];
    case 'bank':
      return event.amount > 0
        ? [{ seat: event.seat, text: pick(['Cha-ching!', 'Safe and sound.', 'Mine for good now.']) }]
        : [{ seat: event.seat, text: pick(['...nothing to bank.']) }];
    case 'scout':
      return [{ seat: event.seat, text: pick(["Found 'em.", 'Now I know.', 'Got eyes on ya.']) }];
    default:
      return [];
  }
}

function soundFor(event: RoundEvent) {
  switch (event.kind) {
    case 'move':
      audioService.playRide();
      break;
    case 'ambush':
      audioService.playShot();
      break;
    case 'trap':
      audioService.playSnap();
      break;
    case 'miss':
    case 'standoff':
      audioService.playMiss();
      break;
    case 'bank':
      audioService.playBank();
      break;
    case 'scout':
      audioService.playPop();
      break;
    default:
      break;
  }
}
