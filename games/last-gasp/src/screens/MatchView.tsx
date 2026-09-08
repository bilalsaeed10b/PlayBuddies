/**
 * The match: the gallows, the word, the open table, and the wire.
 *
 * The structural decision worth reading before the rest of this file: exactly
 * one client decides what happened, and that is the host. Guests publish the
 * action they want to take and nothing else; the host validates it, appends
 * it, and republishes the whole history. A guest never computes a
 * consequence — including the one piece of real time in this game, a chain
 * window lapsing, which only the host ever decides and always records as a
 * discrete action rather than something every client independently notices.
 *
 * The engine is pure and knows nothing about React, Firestore, the DOM or a
 * clock. This component owns all four.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Send, ThumbsUp, Trophy, Zap } from 'lucide-react';
import ControlsTray from '@shared/controls/ControlsTray';
import { isStaleChunkError, recoverFromStaleChunk } from '@shared/net/staleChunk';
import Gallows from '../components/Gallows';
import Keyboard from '../components/Keyboard';
import WordBoard from '../components/WordBoard';
import FaceToken from '../components/FaceToken';
import { LastGaspEngine } from '../engine/LastGaspEngine';
import type { RoundEvent, Seat } from '../engine/LastGaspEngine';
import { botGuess, botVote, botWord, chainDelay, reactionDelay } from '../engine/ai';
import { ALPHABET, BALANCE, PIECES, SEAT_COLORS, TEAM_COLORS } from '../game/rules';
import { audioService } from '../services/audio';
import { cleanWord, packHistory, packRules, unpackHistory } from '../types/game';
import type { Action, GameSettings, MatchRules, NetPacket } from '../types/game';
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
  const teams = config.rules.mode === 'teams';

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

  const [notice, setNotice] = useState<string | null>(null);
  const [wordInput, setWordInput] = useState('');
  /** Which of this device's own seats is "at the keyboard" for guessing, when it is driving more than one. */
  const [activeLocal, setActiveLocal] = useState(0);

  /**
   * A short, wide screen — a phone turned sideways.
   *
   * Stacked, this screen wants a gallows, a word, a status line and a 26-key
   * rack in one column. Measured at 812x375 without this, the gallows sat at
   * y=-2 (clipped by the header) and the keyboard's own bottom edge landed
   * at y=416 — 41px below a 375px-tall viewport, on the one row a landscape
   * phone actually needs to reach. Side by side, the board takes the height
   * and the rack takes the width there is plenty of. The same measured
   * approach Wanted Board and the original build of this game both needed.
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
   * The learned match seed — see the identical field in Wanted Board's
   * MatchView for why this exists at all. A guest's `config.seed` is only
   * ever this device's own locally-rolled guess; the host's `start` packet
   * (or the `seed` stamped on the first `state` packet) corrects it.
   */
  const effectiveSeedRef = useRef<number>(config.seed);

  const localSet = useMemo(() => new Set(config.localSeats), [config.localSeats]);
  const seatOfUid = useMemo(() => {
    const map = new Map<string, number>();
    config.seats.forEach((seat, i) => map.set(seat.id, i));
    return map;
  }, [config.seats]);
  const seatSeq = config.seats.map((s) => s.id).join(',');

  // ── applying an action (host only) ───────────────────────────────────────

  const publish = useCallback(() => {
    linkRef.current?.send({
      t: 'state',
      n: Date.now(),
      s: config.seed,
      ...packHistory(engine.history),
      r: rulesBits,
      seed: config.seed,
    });
  }, [config.seed, engine, rulesBits]);

  /**
   * Applies an action to this device's own board and nothing more.
   *
   * The half of `commit` that everyone is allowed to do. Guests use it to show
   * a move the instant they hear about it rather than waiting for the host's
   * authoritative echo to come back round — see `play` for why that matters so
   * much here.
   */
  const applyLocal = useCallback(
    (action: Action): boolean => {
      const before = engine.events.length;
      if (!engine.apply(action)) return false;
      for (const ev of engine.events.slice(before)) soundFor(ev);
      repaint();
      return true;
    },
    [engine, repaint],
  );

  const commit = useCallback(
    (action: Action): boolean => {
      if (!config.isHost) return false;
      if (!applyLocal(action)) return false;
      log.info('action:applied', { round: engine.round, action, phase: engine.phase, pieces: engine.pieces });
      if (online) publish();
      return true;
    },
    [config.isHost, engine, applyLocal, online, publish],
  );

  /** Whatever this device is allowed to do, routed to the host directly or over the wire. */
  const play = useCallback(
    (action: Action) => {
      audioService.unlock();
      if (config.isHost) {
        commit(action);
        return;
      }
      linkRef.current?.send({
        t: 'play',
        n: Date.now(),
        s: effectiveSeedRef.current,
        rd: engine.round,
        at: engine.actionCount,
        a: action,
      });
      // Shown here immediately, rather than waiting for the host to say it
      // happened.
      //
      // This used to wait, on the reasoning that the host might reject the
      // action and there is no "unplay". But there is: the host's `state`
      // packet carries the whole history and `replay` rebuilds the board from
      // it wholesale, so a rejected guess is corrected completely and
      // automatically on the very next one. What the caution actually bought
      // was a rare, self-healing flicker in exchange for *every* letter a
      // guest called sitting dead for two Firestore round trips -- their own
      // write out, and the host's republished history back.
      applyLocal(action);
    },
    [engine, config.isHost, applyLocal],
  );

  // ── the wire ─────────────────────────────────────────────────────────────

  const handlePacket = useCallback(
    (packet: NetPacket, from: string) => {
      if (packet.t === 'start') {
        if (config.isHost) return;
        effectiveSeedRef.current = packet.seed;
        linkRef.current?.setStamp({ seed: packet.seed, r: packet.r });
        linkRef.current?.setSeed(packet.seed);
        return;
      }

      if (packet.t === 'play') {
        if (packet.s !== effectiveSeedRef.current) return;
        if (packet.rd !== engine.round || packet.at !== engine.actionCount) return;
        const seat = seatOfUid.get(from);
        if (seat === undefined) return;
        // Only ever trust the sender's own seat number, never whatever the
        // packet claims — a guest cannot act, vote or set a word for anyone
        // but themselves.
        const claimed = packet.a;
        const action: Action =
          claimed.t === 'word'
            ? { t: 'word', s: seat, w: cleanWord(claimed.w) }
            : claimed.t === 'vote'
              ? { t: 'vote', s: seat, pick: claimed.pick }
              : claimed.t === 'guess'
                ? { t: 'guess', s: seat, l: claimed.l }
                : { t: 'expire' };
        // The host resolves it and republishes; everyone else shows it now and
        // is corrected by that republish if the host disagreed.
        //
        // Guests used to drop this packet on the floor and wait, which is why
        // a letter somebody else called took two round trips to appear rather
        // than one: theirs out to the host, then the host's history back. They
        // were already receiving the first of those and throwing it away.
        if (config.isHost) commit(action);
        else applyLocal(action);
        return;
      }

      if (packet.t === 'state') {
        if (config.isHost) return;
        if (typeof packet.seed === 'number') effectiveSeedRef.current = packet.seed;
        if (packet.s !== effectiveSeedRef.current) return;
        const incoming = unpackHistory(packet.h, packet.hc);
        const before = engine.events.length;
        engine.replay(incoming);
        for (const ev of engine.events.slice(before)) soundFor(ev);
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
    [config.isHost, engine, seatOfUid, commit, applyLocal, repaint],
  );

  useEffect(() => {
    if (!online || !config.roomId || !config.uid) return;
    let disposed = false;
    let link: TurnLink | null = null;
    let leave: ((e: PageTransitionEvent) => void) | undefined;
    let cancelLeave: (() => void) | undefined;
    let onVisible: (() => void) | undefined;

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
        // The host already knows the match; a guest overwrites this the moment
        // the start packet lands. Either way a `bye` from this link names the
        // match it belongs to, so the next one can ignore it.
        link.setSeed(config.seed);
        if (config.isHost) {
          link.send({ t: 'start', n: Date.now(), seed: config.seed, r: rulesBits });
        }
        // `pagehide` fires with `persisted: false` — indistinguishable from a
        // real close — on plenty of things that are not: a phone screen
        // locking, switching apps for a moment, an iOS Safari tab going into
        // the background. A page holding an open Firestore listener is not
        // bfcache-eligible in most browsers, so `persisted` alone cannot
        // catch this. Rather than hand the seat to a bot on the spot, wait to
        // see if the tab comes back — cancel on `pageshow` or the tab going
        // visible again — and only actually announce the bye once it hasn't.
        let leaveTimer: number | undefined;
        cancelLeave = () => {
          if (leaveTimer !== undefined) {
            window.clearTimeout(leaveTimer);
            leaveTimer = undefined;
          }
        };
        leave = (e) => {
          if (e.persisted) return;
          cancelLeave?.();
          leaveTimer = window.setTimeout(() => link?.close(), 15000);
        };
        onVisible = () => {
          if (document.visibilityState === 'visible') cancelLeave?.();
        };
        window.addEventListener('pagehide', leave);
        window.addEventListener('pageshow', cancelLeave);
        document.addEventListener('visibilitychange', onVisible);
      })
      .catch((e) => {
        // A stale build, not a dead connection: this tab has been open since
        // before the deploy that just replaced the exact file it's asking for.
        // Reloading fetches the new `index.html`, which asks for the file that
        // actually exists -- so this fixes itself rather than leaving the
        // player on a screen whose only way out is a "Back" that fails the
        // same way.
        if (isStaleChunkError(e)) {
          recoverFromStaleChunk();
          return;
        }
        log.error('wire:open-failed', { message: String(e?.message ?? e) });
        setNotice('Could not reach the other players.');
      });

    return () => {
      disposed = true;
      cancelLeave?.();
      if (leave) window.removeEventListener('pagehide', leave);
      if (cancelLeave) window.removeEventListener('pageshow', cancelLeave);
      if (onVisible) document.removeEventListener('visibilitychange', onVisible);
      link?.close();
      linkRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, config.roomId, config.uid, config.peerUids.join(','), config.isHost, config.seed, rulesBits, seatSeq]);

  // ── bots (host only) ─────────────────────────────────────────────────────
  //
  // One heartbeat rather than a pile of individually-tracked timers: every
  // time anything eligibility-relevant changes, every currently-eligible bot
  // seat gets a fresh randomised delay before it acts. The delay itself needs
  // no cross-client agreement — only the host ever runs this, and the choice
  // it produces (which letter, which word) is what actually gets replayed —
  // so it is timed with plain Math.random() rather than the seeded rng.
  const botTimers = useRef(new Map<number, number>());
  useEffect(() => {
    if (!config.isHost) return;
    for (const id of botTimers.current.values()) window.clearTimeout(id);
    botTimers.current.clear();
    if (engine.phase === 'roundOver' || engine.phase === 'over') return;

    const schedule = (seat: number, delayMs: number, act: () => void) => {
      const id = window.setTimeout(() => {
        botTimers.current.delete(seat);
        act();
      }, delayMs);
      botTimers.current.set(seat, id);
    };

    for (let seat = 0; seat < config.seats.length; seat++) {
      if (config.seats[seat].control !== 'ai') continue;
      const level = config.seats[seat].aiLevel;

      if (engine.canSetWord(seat)) {
        schedule(seat, reactionDelay(level, Math.random), () => {
          const { word } = botWord(engine.rngFor(seat));
          commit({ t: 'word', s: seat, w: word });
        });
      } else if (engine.canVote(seat)) {
        schedule(seat, 400 + Math.random() * 900, () => {
          commit({ t: 'vote', s: seat, pick: botVote(engine, seat, engine.rngFor(seat)) });
        });
      } else if (engine.canGuess(seat)) {
        const chaining = engine.chainHolder === seat;
        const delay = chaining ? chainDelay(level, Math.random) : reactionDelay(level, Math.random);
        schedule(seat, delay, () => {
          if (!engine.canGuess(seat)) return;
          commit({ t: 'guess', s: seat, l: botGuess(engine, level, engine.rngFor(seat)) });
        });
      }
    }

    return () => {
      for (const id of botTimers.current.values()) window.clearTimeout(id);
      botTimers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.isHost, version, engine.phase, engine.chainHolder]);

  // ── human timeouts: a setter, a suggester, or a chain window (host only) ──

  const [setClock, setSetClock] = useState<number>(BALANCE.SET_SECONDS);
  const [voteClock, setVoteClock] = useState<number>(BALANCE.VOTE_SECONDS);
  const [chainClock, setChainClock] = useState<number>(BALANCE.CHAIN_WINDOW_MS / 1000);

  useEffect(() => {
    if (engine.phase !== 'settingWord' && engine.phase !== 'suggesting') return;
    setSetClock(BALANCE.SET_SECONDS);
    const id = window.setInterval(() => {
      setSetClock((c) => {
        if (c <= 1) {
          if (config.isHost) {
            // Whichever human hasn't set/suggested yet gets a bot word so the
            // table never stalls on someone who stepped away.
            const stuck = config.seats
              .map((_, i) => i)
              .filter((i) => config.seats[i].control !== 'ai' && engine.canSetWord(i));
            for (const seat of stuck) {
              const { word } = botWord(engine.rngFor(seat));
              commit({ t: 'word', s: seat, w: word });
            }
          }
          return BALANCE.SET_SECONDS;
        }
        return c - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.phase, engine.round, engine.suggestions.length, config.isHost, version]);

  useEffect(() => {
    if (engine.phase !== 'voting') return;
    setVoteClock(BALANCE.VOTE_SECONDS);
    const id = window.setInterval(() => {
      setVoteClock((c) => {
        if (c <= 1) {
          if (config.isHost) {
            const stuck = config.seats
              .map((_, i) => i)
              .filter((i) => config.seats[i].control !== 'ai' && engine.canVote(i));
            for (const seat of stuck) {
              commit({ t: 'vote', s: seat, pick: botVote(engine, seat, engine.rngFor(seat)) });
            }
          }
          return BALANCE.VOTE_SECONDS;
        }
        return c - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.phase, engine.votes.size, config.isHost, version]);

  useEffect(() => {
    if (engine.phase !== 'guessing' || engine.chainHolder === null) {
      setChainClock(BALANCE.CHAIN_WINDOW_MS / 1000);
      return;
    }
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      const left = Math.max(0, BALANCE.CHAIN_WINDOW_MS - (Date.now() - startedAt));
      setChainClock(Math.ceil(left / 1000));
      if (left <= 0) {
        if (config.isHost) commit({ t: 'expire' });
      }
    }, 120);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.phase, engine.chainHolder, engine.chainDepth, config.isHost]);

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

  useEffect(() => {
    setWordInput('');
    setActiveLocal(0);
  }, [engine.round]);

  // ── render ───────────────────────────────────────────────────────────────

  const board = engine.board;
  const lastEvent = engine.events[engine.events.length - 1];
  const standings = engine.standings();
  const teamStandings = teams ? engine.teamStandings() : [];
  const roundOver = engine.phase === 'roundOver' || engine.phase === 'over';

  // Which of my own seats is the one that can act right now, for whichever
  // phase we are in. On a solo device this is trivially localSeats[0]; on a
  // shared couch device it is whichever seat the little picker below has set
  // as "you" — see activeLocal.
  const actingLocal = (predicate: (seat: number) => boolean) => config.localSeats.find(predicate);

  const mySetter = actingLocal((s) => engine.canSetWord(s));
  const myVoter = actingLocal((s) => engine.canVote(s));
  const guessCandidates = config.localSeats.filter((s) => engine.canGuess(s));
  const myGuesser = guessCandidates.includes(config.localSeats[activeLocal] ?? -1)
    ? config.localSeats[activeLocal]
    : guessCandidates[0];

  /**
   * Letters from a real keyboard.
   *
   * The on-screen keys were the only way in, which is right on a phone and
   * absurd on a laptop: the game is a race for a letter and the fastest thing
   * in the room was being asked to hunt for a button with a mouse.
   *
   * Held in a ref and read by one listener rather than re-binding a listener
   * every time the board changes -- this component re-renders on every letter
   * anybody calls, and a listener that came and went that often would drop
   * keys pressed in the gap.
   */
  const guessRef = useRef<{ seat: number | undefined; play: (l: number) => void }>({
    seat: undefined,
    play: () => {},
  });
  guessRef.current = {
    seat: myGuesser,
    play: (l: number) => play({ t: 'guess', s: myGuesser as number, l }),
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never while a word is being typed: the setter is entering letters into
      // a box, and every one of them would otherwise also be called out loud
      // to the people trying to guess it.
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return;
      const letter = e.key.toUpperCase();
      const at = ALPHABET.indexOf(letter);
      if (at < 0) return;
      const { seat, play: send } = guessRef.current;
      if (seat === undefined) return;
      e.preventDefault();
      audioService.unlock();
      send(at);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submitWord = () => {
    const cleaned = cleanWord(wordInput);
    if (cleaned.length < BALANCE.MIN_WORD_LEN) return;
    const seat = mySetter;
    if (seat === undefined) return;
    play({ t: 'word', s: seat, w: cleaned });
    setWordInput('');
  };

  const settingSeatName = () => {
    if (config.rules.mode === 'ffa') return config.seats[engine.setterSeat]?.name ?? 'Someone';
    const team = engine.seatsOnTeam(engine.settingTeam);
    return `${teamNameFor(engine.settingTeam)} (${team.map((s) => config.seats[s]?.name).join(', ')})`;
  };

  const centerBlock = (
    <>
      <Gallows pieces={engine.pieces} className="h-[22vh] max-h-52 min-h-24 w-auto shrink-0" />

      <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500">
        {engine.pieces} / {PIECES} lines · {PIECES - engine.pieces} left
      </p>

      {engine.word && <WordBoard board={board} exposed={roundOver} word={engine.word} />}

      <p className="min-h-[2.5em] max-w-md px-2 text-center text-xs font-bold leading-snug text-slate-300">
        {roundOver
          ? roundSummary(engine, config.seats, teams)
          : lastEvent
            ? describe(lastEvent, config.seats, localSet)
            : phaseHint(engine, settingSeatName(), mySetter !== undefined)}
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
      ) : engine.phase === 'settingWord' ? (
        mySetter !== undefined ? (
          <WordEntry value={wordInput} onChange={setWordInput} onSubmit={submitWord} label="Type the word everyone will guess" seconds={setClock} />
        ) : (
          <WaitingCard text={`${settingSeatName()} is choosing a word…`} seconds={setClock} />
        )
      ) : engine.phase === 'suggesting' ? (
        mySetter !== undefined ? (
          <WordEntry value={wordInput} onChange={setWordInput} onSubmit={submitWord} label="Suggest a word for your team" seconds={setClock} />
        ) : engine.teamOf(config.localSeats[0] ?? -1) === engine.settingTeam ? (
          <WaitingCard text="Waiting on your teammates' suggestions…" seconds={setClock} />
        ) : (
          <WaitingCard text={`${settingSeatName()} is picking a word…`} seconds={setClock} />
        )
      ) : engine.phase === 'voting' ? (
        myVoter !== undefined ? (
          <VotePanel suggestions={engine.suggestions} seats={config.seats} mine={myVoter} onVote={(pick) => play({ t: 'vote', s: myVoter, pick })} />
        ) : engine.teamOf(config.localSeats[0] ?? -1) === engine.settingTeam ? (
          <WaitingCard text="Waiting on your team's vote…" seconds={voteClock} />
        ) : (
          <WaitingCard text={`${settingSeatName()} is picking a word…`} seconds={voteClock} />
        )
      ) : (
        <>
          {guessCandidates.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {guessCandidates.map((s) => (
                <button
                  key={s}
                  onClick={() => setActiveLocal(config.localSeats.indexOf(s))}
                  className={`shrink-0 rounded-full border-2 px-3 py-1 text-[11px] font-black uppercase ${
                    myGuesser === s ? 'border-lime-400 bg-lime-400/15 text-lime-200' : 'border-slate-600/50 text-slate-400'
                  }`}
                >
                  {config.seats[s]?.name}
                </button>
              ))}
            </div>
          )}
          <ChainBanner engine={engine} seats={config.seats} localSet={localSet} chainClock={chainClock} />
          <Keyboard
            called={engine.called}
            hits={new Set(engine.called.filter((c) => engine.word.includes(c)))}
            disabled={myGuesser === undefined}
            markUsed={settings.markUsed}
            onPick={(letter) => {
              if (myGuesser === undefined) return;
              play({ t: 'guess', s: myGuesser, l: ALPHABET.indexOf(letter) });
            }}
          />
        </>
      )}
    </>
  );

  return (
    <div ref={shellRef} className="relative flex h-[100dvh] w-full flex-col overflow-hidden">
      {/* ── top bar ── */}
      <div className="flex shrink-0 items-start justify-between gap-2 p-2 sm:p-3">
        <div className="shrink-0 rounded-2xl border border-slate-600/50 bg-slate-900/70 px-3 py-1.5 backdrop-blur">
          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400">Word</p>
          <p className="text-sm font-black leading-tight tabular-nums text-slate-100">
            {Math.min(engine.round + 1, engine.totalRounds)} / {engine.totalRounds}
          </p>
        </div>
        <div className="shrink-0">
          <ControlsTray shellRef={shellRef} online={online} isHost={config.isHost} onSettings={onOpenSettings} onExit={onExit} theme="dark" />
        </div>
      </div>

      {/* ── roster ── */}
      <div className="shrink-0 px-2 sm:px-3">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {config.seats.map((seat, i) => {
            const colors = SEAT_COLORS[i % SEAT_COLORS.length];
            const setting = config.rules.mode === 'ffa' ? engine.setterSeat === i : engine.teamOf(i) === engine.settingTeam;
            const acting = engine.chainHolder === i;
            const mine = localSet.has(i);
            return (
              <div
                key={seat.id}
                className={`flex min-w-0 flex-1 shrink-0 items-center gap-1.5 rounded-xl border-2 px-1.5 py-1 transition-all ${
                  acting ? 'scale-[1.02]' : ''
                }`}
                style={{
                  borderColor: acting ? colors.main : setting ? 'rgba(250,204,21,0.5)' : 'rgba(148,163,184,0.22)',
                  background: acting ? `${colors.main}1f` : 'rgba(15,23,42,0.55)',
                }}
              >
                <FaceToken skin={seat.skin} size={26} ring={colors.main} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1 truncate text-[10px] font-black uppercase tracking-wide text-slate-100">
                    {mine ? 'You' : seat.name}
                    {teams && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TEAM_COLORS[engine.teamOf(i) % TEAM_COLORS.length]?.main }} />
                    )}
                    {acting && <Zap className="h-2.5 w-2.5 shrink-0 text-amber-300" />}
                  </p>
                  <p className="text-[10px] font-bold leading-tight tabular-nums text-slate-400">
                    <span className="text-slate-100">{engine.liveTotal(i)}</span>
                    {engine.players[i] && engine.players[i].round > 0 && <span className="text-lime-400"> +{engine.players[i].round}</span>}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── the body ──
          Two explicit arrangements rather than one tree bent with `order`:
          stacked, the rack belongs at the thumb end below the board, and no
          ordering trick gets that right in both orientations at once. */}
      {sideBySide ? (
        <div className="flex min-h-0 flex-1 gap-2 overflow-hidden px-2 pb-2">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-1.5">{centerBlock}</div>
          <div className="flex w-[52%] max-w-[420px] shrink-0 flex-col justify-center gap-2 overflow-y-auto">{rackBlock}</div>
        </div>
      ) : (
        <>
          <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col items-center justify-center gap-3 px-3">{centerBlock}</div>
          <div className="mx-auto w-full max-w-2xl shrink-0 space-y-2 p-2 sm:p-3">{rackBlock}</div>
        </>
      )}

      {notice && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center px-4">
          <p className="rounded-xl border border-slate-500/50 bg-slate-950/95 px-3 py-1.5 text-center text-xs font-bold text-slate-200">{notice}</p>
        </div>
      )}

      {/* ── the end ── */}
      {engine.phase === 'over' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/80 p-5 backdrop-blur-sm">
          <div className="max-h-[88dvh] w-full max-w-sm overflow-y-auto overscroll-contain space-y-4 rounded-[2rem] border-2 border-slate-600/60 bg-slate-900 p-6 text-center">
            <Trophy className="mx-auto h-11 w-11 text-amber-400" />
            <h2 className="text-3xl font-black leading-none text-slate-50">
              {engine.winner !== null && localSet.has(engine.winner) ? 'You won it' : 'They won it'}
            </h2>
            <p className="text-sm font-bold text-slate-400">
              {config.seats[engine.winner ?? 0]?.name} finished on {engine.players[engine.winner ?? 0]?.total ?? 0}.
            </p>

            {teams && (
              <div className="space-y-1 rounded-2xl bg-slate-950/60 p-3 text-left">
                {teamStandings.map((row, i) => (
                  <div key={row.team} className="flex items-center gap-2 text-xs">
                    <span className="w-3 font-black text-slate-500">{i + 1}</span>
                    <span className="h-2 w-2 rounded-full" style={{ background: TEAM_COLORS[row.team % TEAM_COLORS.length]?.main }} />
                    <span className="min-w-0 flex-1 truncate font-black uppercase tracking-wide text-slate-100">{teamNameFor(row.team)}</span>
                    <span className="w-10 text-right font-black tabular-nums text-slate-50">{row.total}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1 rounded-2xl bg-slate-950/60 p-3 text-left">
              {standings.map((row, i) => (
                <div key={config.seats[row.seat].id} className="flex items-center gap-2 text-xs">
                  <span className="w-3 font-black text-slate-500">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-black uppercase tracking-wide text-slate-100">{config.seats[row.seat].name}</span>
                  <span className="font-bold tabular-nums text-slate-500">
                    {engine.players[row.seat].hangs > 0 ? `hanged ×${engine.players[row.seat].hangs}` : `best chain ${engine.players[row.seat].bestChain}`}
                  </span>
                  <span className="w-10 text-right font-black tabular-nums text-slate-50">{row.total}</span>
                </div>
              ))}
            </div>

            <button onClick={onExit} className="w-full rounded-2xl bg-lime-500 py-3 font-black uppercase tracking-[0.18em] text-slate-950">
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function teamNameFor(team: number): string {
  return TEAM_COLORS[team % TEAM_COLORS.length]?.name ?? `Team ${team + 1}`;
}

function WordEntry({
  value,
  onChange,
  onSubmit,
  label,
  seconds,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  label: string;
  /** The clock only ever ran silently against the person actually typing — everyone else waiting on them saw it, they didn't. */
  seconds: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-center gap-2">
        <p className="text-center text-[11px] font-black uppercase tracking-wide text-lime-300">{label}</p>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-black tabular-nums ${
            seconds <= 5
              ? 'animate-pulse border-rose-400/60 bg-rose-500/15 text-rose-300'
              : 'border-lime-400/40 bg-lime-400/10 text-lime-300'
          }`}
        >
          {seconds}s
        </span>
      </div>
      <div className="flex gap-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(cleanWord(e.target.value))}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          placeholder="Type it here…"
          aria-label={label}
          className="min-w-0 flex-1 rounded-xl border-2 border-slate-500/60 bg-slate-100 px-3 py-3 text-center text-lg font-black uppercase tracking-[0.2em] text-slate-900 placeholder:text-sm placeholder:font-bold placeholder:tracking-normal placeholder:text-slate-400 focus:border-lime-400 focus:outline-none"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={value.length < BALANCE.MIN_WORD_LEN}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-lime-500 px-4 font-black uppercase tracking-wide text-slate-950 disabled:opacity-40"
        >
          <Send className="h-4 w-4" /> Set
        </button>
      </div>
      <p className="text-center text-[10px] font-bold text-slate-500">Nobody else can see this until it's guessed or the word ends.</p>
    </div>
  );
}

function VotePanel({
  suggestions,
  seats,
  mine,
  onVote,
}: {
  suggestions: { seat: number; word: string }[];
  seats: Seat[];
  mine: number;
  onVote: (pick: number) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-center text-[11px] font-black uppercase tracking-wide text-lime-300">Pick your team's word</p>
      <div className="grid grid-cols-2 gap-2">
        {suggestions.map((s, i) => (
          <button key={i} onClick={() => onVote(i)} className="rounded-xl border-2 border-slate-600/50 bg-slate-800/60 px-3 py-3 text-center active:scale-95">
            <p className="text-lg font-black tracking-[0.15em] text-slate-100">{s.word}</p>
            <p className="text-[9px] font-bold uppercase text-slate-500">{s.seat === mine ? 'yours' : `from ${seats[s.seat]?.name ?? 'a teammate'}`}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function WaitingCard({ text, seconds }: { text: string; seconds: number }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-2xl border-2 border-slate-600/50 bg-slate-900/70 py-4">
      <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
      <p className="text-sm font-black uppercase tracking-wide text-slate-300">
        {text} <span className="text-slate-500">({seconds}s)</span>
      </p>
    </div>
  );
}

function ChainBanner({
  engine,
  seats,
  localSet,
  chainClock,
}: {
  engine: LastGaspEngine;
  seats: Seat[];
  localSet: Set<number>;
  chainClock: number;
}) {
  if (engine.chainHolder === null) {
    return (
      <p className="flex items-center justify-center gap-1.5 text-[11px] font-black uppercase tracking-wide text-slate-400">
        <ThumbsUp className="h-3.5 w-3.5" /> Open table — first correct letter wins it
      </p>
    );
  }
  const name = localSet.has(engine.chainHolder) ? 'You' : (seats[engine.chainHolder]?.name ?? 'Someone');
  const mult = (1 + engine.chainDepth * BALANCE.CHAIN_STEP).toFixed(2);
  return (
    <div className="flex items-center justify-center gap-2 rounded-xl border-2 border-amber-400/60 bg-amber-400/10 px-3 py-1.5">
      <Zap className="h-4 w-4 text-amber-300" />
      <p className="text-[11px] font-black uppercase tracking-wide text-amber-200">
        {name}'s chain · ×{mult} · {chainClock}s left
      </p>
    </div>
  );
}

function phaseHint(engine: LastGaspEngine, settingSeatName: string, mine: boolean): string {
  if (engine.phase === 'settingWord') return mine ? "You're choosing a word." : `${settingSeatName} is choosing a word.`;
  if (engine.phase === 'suggesting') return `${settingSeatName} are picking a word.`;
  if (engine.phase === 'voting') return `${settingSeatName} are voting.`;
  return 'First guess of the word.';
}

function describe(event: RoundEvent, seats: Seat[], mine: Set<number>): string {
  const name = (i: number) => (mine.has(i) ? 'You' : (seats[i]?.name ?? 'Someone'));
  const was = (i: number) => (mine.has(i) ? 'were' : 'was');
  switch (event.kind) {
    case 'wordSet':
      return `${name(event.seat)} set the word.`;
    case 'suggested':
      return `${name(event.seat)} suggested a word.`;
    case 'voted':
      return `${name(event.seat)} voted.`;
    case 'wordChosen':
      return `The team picked ${name(event.author)}'s word.`;
    case 'hit':
      return event.chain > 0
        ? `${name(event.seat)} chained ${event.letter} — +${event.points}.`
        : `${name(event.seat)} called ${event.letter} — ${event.copies} of them, +${event.points}.`;
    case 'miss':
      return `No ${event.letter}. That is line ${event.piece} of ${PIECES}.`;
    case 'chainEnded':
      return event.reason === 'expired' ? `${name(event.seat)}'s window closed. Open again.` : '';
    case 'hanged':
      return event.lost > 0
        ? `${name(event.seat)} drew the last line and ${was(event.seat)} out ${event.lost} points.`
        : `${name(event.seat)} drew the last line.`;
    case 'cleared':
      return `The word was ${event.word}.`;
  }
}

/** The line under the board once a word is done with. */
function roundSummary(engine: LastGaspEngine, seats: Seat[], teams: boolean): string {
  const hanged = engine.events.find((e) => e.kind === 'hanged');
  if (hanged && hanged.kind === 'hanged') {
    return `${seats[hanged.seat]?.name ?? 'Someone'} finished the stickman. The word was ${engine.word}.`;
  }
  const cleared = engine.events.find((e) => e.kind === 'cleared');
  if (cleared && cleared.kind === 'cleared') {
    return teams ? `Cracked: ${cleared.word}.` : `Cracked it: ${cleared.word}.`;
  }
  return `The word was ${engine.word}.`;
}

function soundFor(event: RoundEvent) {
  switch (event.kind) {
    case 'hit':
      audioService.playHit(event.chain > 0 ? 1 : event.copies);
      break;
    case 'miss':
      audioService.playMiss();
      break;
    case 'cleared':
      audioService.playSolve();
      break;
    case 'hanged':
      audioService.playHang();
      break;
    default:
      break;
  }
}
