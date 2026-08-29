/**
 * The round on screen: the render loop, the controls, and the wire.
 *
 * The engine knows nothing about React, the keyboard or Firestore. This
 * component owns all three and hands the engine an angle and a power, which is
 * what keeps the physics testable and the transport swappable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Coins, Flag, Loader2, Target, Trophy } from 'lucide-react';
import ControlsTray from '@shared/controls/ControlsTray';
import AimPad from '../components/AimPad';
import type { Aim } from '../components/AimPad';
import { GolfEngine } from '../engine/GolfEngine';
import type { Seat, ShotReport } from '../engine/GolfEngine';
import { TIERS, chooseShot, newBrain } from '../engine/ai';
import type { Brain } from '../engine/ai';
import { SEATS, SHOUTS, clamp, relativeToPar, scoreName } from '../game/rules';
import type { Shout } from '../game/rules';
import { IN_IFRAME, toggleFullscreen } from '../fullscreen';
import { audioService } from '../services/audio';
import { TURN_SECONDS, packRules, unpackRules } from '../types/game';
import type { GameSettings, MatchRules, NetPacket } from '../types/game';
// Type only: the runtime value arrives through the dynamic import below, which
// is what keeps the Firebase SDK out of an offline player's bundle.
import type { TurnLink } from '../net/turnLink';

export interface MatchConfig {
  /** null for offline play. */
  roomId: string | null;
  uid: string | null;
  /** Everyone else in the round, online only. Empty offline. */
  peerUids: string[];
  isHost: boolean;
  /** One to four balls. An index into this is a ball, everywhere. */
  seats: Seat[];
  /** Balls played from this device: one online, one to four on a couch. */
  localSeats: number[];
  /** Difficulty for bots, including one that takes over from somebody who left. */
  aiLevel: number;
  /** Chosen by the host online, locally otherwise. */
  seed: number;
  first: number;
  /** The host's rules. A guest's copy is replaced by whatever arrives on the wire. */
  rules: MatchRules;
}

/**
 * Everything the green needs that the host decides.
 *
 * The rules join the seed and the toss here rather than being read from local
 * settings, because all three have to be identical everywhere: a guest that
 * built its own idea of the round would be putting at a different flag on a
 * differently shaped green.
 */
interface Session {
  seed: number;
  first: number;
  rules: MatchRules;
}

interface Banner {
  id: number;
  label: string;
  tone: 'great' | 'good' | 'even' | 'bad';
}

const THINK_MS = 520;
const BANNER_MS = 1900;

const TONE: Record<Banner['tone'], string> = {
  great: 'border-amber-300/70 bg-amber-400/95 text-amber-950',
  good: 'border-emerald-300/70 bg-emerald-400/95 text-emerald-950',
  even: 'border-white/40 bg-white/92 text-slate-800',
  bad: 'border-rose-300/60 bg-rose-400/95 text-rose-950',
};

export default function MatchView({
  config,
  settings,
  coins,
  onOpenSettings,
  onExit,
  onResult,
}: {
  config: MatchConfig;
  settings: GameSettings;
  coins: number;
  onOpenSettings: () => void;
  onExit: () => void;
  onResult: (won: boolean, strokes: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GolfEngine | null>(null);
  const linkRef = useRef<TurnLink | null>(null);

  const online = Boolean(config.roomId && config.uid && config.peerUids.length > 0);
  /**
   * Bots are driven by exactly one device.
   *
   * Offline that is obviously this one. Online it is the host and nobody else:
   * two clients each deciding a bot's putt would write two different greens
   * into two documents, and whichever landed second would snap the other's
   * board out from under it.
   */
  const aiDriver = !online || config.isHost;

  /**
   * The rules as one number, so the wire effect below can depend on them.
   *
   * `config.rules` is a fresh object on every render — App rebuilds the whole
   * config from each lobby snapshot — and listing it in a dependency array
   * would tear the link down and reopen it several times a second, writing a
   * `bye` each time.
   */
  const rulesBits = packRules(config.rules);

  const [session, setSession] = useState<Session | null>(
    online && !config.isHost ? null : { seed: config.seed, first: config.first, rules: config.rules },
  );

  const [turn, setTurn] = useState(config.first);
  const [holeIndex, setHoleIndex] = useState(0);
  const [par, setPar] = useState(3);
  const [strokes, setStrokes] = useState<number[]>(() => config.seats.map(() => 0));
  const [totals, setTotals] = useState<number[]>(() => config.seats.map(() => 0));
  const [done, setDone] = useState<boolean[]>(() => config.seats.map(() => false));
  const [phase, setPhase] = useState<'aim' | 'rolling' | 'holeOver' | 'over'>('aim');
  const [card, setCard] = useState<(number | null)[][]>([]);
  const [clock, setClock] = useState(TURN_SECONDS);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [over, setOver] = useState<{ winners: number[]; totals: number[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rematch, setRematch] = useState(0);

  /**
   * True while the wire itself is the problem — it never opened, or it dropped
   * mid-round — as opposed to an ordinary notice like somebody going idle.
   * Without it the only way out of "could not reach the other players" was
   * leaving, so a page that failed to open a link once never got a second try.
   */
  const [connectionLost, setConnectionLost] = useState(false);
  const [wireGeneration, setWireGeneration] = useState(0);
  /** Set right before a retry tears the old link down, so its cleanup knows not to announce a bye. */
  const retryingRef = useRef(false);
  const retryConnection = useCallback(() => {
    retryingRef.current = true;
    setConnectionLost(false);
    setNotice(null);
    setWireGeneration((n) => n + 1);
  }, []);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const brains = useRef<Brain[]>([]);
  const aiTimer = useRef<number | null>(null);
  const bannerTimer = useRef<number | null>(null);
  const bannerId = useRef(0);
  /** Packets that arrived before the engine existed. */
  const queued = useRef<NetPacket[]>([]);
  const clockRef = useRef(TURN_SECONDS);

  /**
   * Everything below keys on strings and numbers, never on the config object.
   *
   * App rebuilds `config` on every render and re-renders on every lobby
   * snapshot, so its arrays are a different array each time even when nothing
   * about the round has changed. That is fine for the HUD and fatal for the
   * wire: an effect that lists an array identity in its dependencies tears the
   * link down and opens a new one, and closing a link writes a `bye` — which
   * tells everyone else this player has walked off, over and over.
   */
  const peerKey = config.peerUids.join(',');
  const seatIdKey = config.seats.map((s) => s.id).join(',');
  const localKey = config.localSeats.join(',');
  const { aiLevel } = config;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const localSeats = useMemo(() => new Set(config.localSeats), [localKey]);
  /** Which ball each remote player has, so a `bye` lands on the right one. */
  const seatOfUid = useMemo(() => {
    const map = new Map<string, number>();
    config.seats.forEach((seat, i) => map.set(seat.id, i));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatIdKey]);

  /**
   * Whether this device drives the bots, read from a ref inside the loop.
   *
   * As a dependency it would rebuild the green — resetting a live round — the
   * moment the lobby handed the host badge to somebody else.
   */
  const aiDriverRef = useRef(aiDriver);
  aiDriverRef.current = aiDriver;

  const shout = useCallback((label: string, tone: Banner['tone']) => {
    if (!settingsRef.current.shouts) return;
    bannerId.current += 1;
    setBanner({ id: bannerId.current, label, tone });
    if (bannerTimer.current !== null) window.clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => setBanner(null), BANNER_MS);
  }, []);

  // -- the wire ---------------------------------------------------------------

  const handlePacket = useCallback(
    (packet: NetPacket, from: string) => {
      if (packet.t === 'start') {
        setSession((current) =>
          current && current.seed === packet.seed
            ? current
            : { seed: packet.seed, first: packet.first, rules: unpackRules(packet.r) },
        );
        return;
      }
      if (packet.t === 'bye') {
        const seat = seatOfUid.get(from);
        if (seat === undefined) return;
        engineRef.current?.handOverToAI(seat, aiLevel);
        setNotice(`${engineRef.current?.seats[seat]?.name ?? 'A player'} left. A bot is playing their ball.`);
        return;
      }
      if (packet.t !== 'fire' && packet.t !== 'shot') return;

      // A turn doubles as a start packet. Each document holds exactly one write
      // at a time, so a guest that arrives after the opening putt finds a shot
      // where the negotiation was; the first player and the rules travel on it,
      // which is everything the round is built from.
      if (packet.first !== undefined) {
        const opening = { seed: packet.s, first: packet.first, rules: unpackRules(packet.r) };
        setSession((current) => current ?? opening);
      }

      const engine = engineRef.current;
      if (!engine) {
        queued.current.push(packet);
        return;
      }
      if (packet.t === 'fire') engine.applyFire(packet);
      else engine.applyShot(packet);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seatOfUid, aiLevel],
  );

  useEffect(() => {
    if (!online || !config.roomId || !config.uid || config.peerUids.length === 0) return;

    let disposed = false;
    let link: TurnLink | null = null;
    let leave: (() => void) | undefined;

    void import('../net/turnLink')
      .then(({ TurnLink: Link }) => {
        // The round can be left while this import is still in flight; without
        // the guard the listener opens with nothing left to close it.
        if (disposed) return;
        link = new Link(
          config.roomId as string,
          config.uid as string,
          config.peerUids,
          handlePacket,
          (message) => {
            setNotice(message);
            // Everything TurnLink reports on its own — the open failing, a
            // listener dropping, a send bouncing — means the link itself needs
            // a fresh attempt, not just an acknowledgement.
            setConnectionLost(true);
          },
          config.isHost ? { first: config.first, r: rulesBits } : undefined,
        );
        linkRef.current = link;

        // The whole negotiation, sent once: a seed, who tees off, and the
        // rules. Every green in the round is built from those three.
        if (config.isHost) {
          link.send({ t: 'start', n: Date.now(), seed: config.seed, first: config.first, r: rulesBits });
        }

        leave = () => link?.close();
        window.addEventListener('pagehide', leave);
      })
      .catch((err) => {
        console.error('Could not open the wire', err);
        setNotice('Could not reach the other players.');
        setConnectionLost(true);
      });

    return () => {
      disposed = true;
      if (leave) window.removeEventListener('pagehide', leave);
      link?.close(!retryingRef.current);
      retryingRef.current = false;
      linkRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, config.roomId, config.uid, peerKey, config.isHost, config.seed, config.first, rulesBits, handlePacket, wireGeneration]);

  /**
   * Once a guest knows the terms, it stamps them onto its own writes too.
   *
   * Without this, a third player joining late who happens to hear a guest's
   * putt before the host's has a shot packet and no way to interpret it.
   */
  useEffect(() => {
    if (!session) return;
    linkRef.current?.setStamp({ first: session.first, r: packRules(session.rules) });
  }, [session]);

  // -- actions ----------------------------------------------------------------

  const settled = useCallback(() => {
    clockRef.current = TURN_SECONDS;
  }, []);

  const playAgain = useCallback(() => {
    setOver(null);
    setNotice(null);
    setBanner(null);
    const next = { seed: (Math.random() * 0x7fffffff) | 0, first: Math.floor(Math.random() * config.rules.players) };
    setSession((current) => ({ ...next, rules: current?.rules ?? config.rules }));
    setRematch((n) => n + 1);
    // Online, the others are waiting on exactly this: a fresh seed makes every
    // document from the last round stale, and the new toss reaches them here.
    if (online && config.isHost) {
      linkRef.current?.setStamp({ first: next.first, r: rulesBits });
      linkRef.current?.send({ t: 'start', n: Date.now(), seed: next.seed, first: next.first, r: rulesBits });
    }
  }, [online, config.isHost, config.rules, rulesBits]);

  // -- the engine and the loop ------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return;

    const engine = new GolfEngine({
      // The engine flips a seat's control to 'ai' when its player leaves, so it
      // gets its own copy rather than mutating the object App rebuilds.
      seats: config.seats.map((s) => ({ ...s })),
      players: session.rules.players,
      holes: session.rules.holes,
      hazards: session.rules.hazards,
      seed: session.seed,
      first: session.first,
      onSfx: (kind) => {
        if (kind === 'putt') audioService.playPutt(0.6);
        else if (kind === 'wall') audioService.playWall();
        else if (kind === 'splash') audioService.playSplash();
        else if (kind === 'drop') audioService.playDrop();
        else if (kind === 'sand') audioService.playSand();
      },
      onShout: (kind: Shout) => {
        const s = SHOUTS[kind];
        shout(s.label, s.tone);
      },
      onHoled: (_seat, took, holePar) => {
        const s = scoreName(took, holePar);
        shout(s.label, s.tone);
      },
      onLocalFire: online
        ? (seat, angle, power, hole) =>
            linkRef.current?.send({
              t: 'fire',
              n: Date.now(),
              s: session.seed,
              hl: hole,
              b: seat,
              a: angle,
              p: power,
            })
        : undefined,
      onLocalShot: online
        ? (report: ShotReport) =>
            linkRef.current?.send({
              t: 'shot',
              n: Date.now(),
              s: session.seed,
              hl: report.hole,
              b: report.seat,
              a: report.angle,
              p: report.power,
              x: report.x.map((v) => Math.round(v * 100) / 100),
              y: report.y.map((v) => Math.round(v * 100) / 100),
              k: report.k,
              f: report.f,
              tot: report.tot,
              o: report.next,
            })
        : undefined,
      onOver: (winners, finalTotals) => {
        setOver({ winners, totals: finalTotals });
        // A tie is not a win for either side of it — only sole possession of
        // the low score is.
        const won = winners.length === 1 && config.localSeats.includes(winners[0]);
        const mine = config.localSeats[0] ?? 0;
        onResult(won, finalTotals[mine] ?? 0);
        audioService.playEnd(won);
      },
    });
    engineRef.current = engine;
    brains.current = engine.seats.map(() => newBrain());
    for (const packet of queued.current) {
      if (packet.t === 'fire') engine.applyFire(packet);
      else if (packet.t === 'shot') engine.applyShot(packet);
    }
    queued.current = [];

    // Dev-only handle. "Where is every ball, whose turn does the green think it
    // is, and what would a bot do from here" are the first three questions
    // worth asking when a turn looks stuck, and none of them can be answered
    // from the console without this.
    if (import.meta.env.DEV) {
      (window as unknown as { __golf?: GolfEngine }).__golf = engine;
    }

    /**
     * The canvas is sized from its container, not from the window.
     *
     * `resize` writes an explicit pixel width and height onto the element,
     * which is what keeps a CSS pixel and a green coordinate the same thing —
     * and also what overrides the `w-full h-full` classes, so nothing else
     * will correct it. A ResizeObserver rather than a window listener because
     * the board's box changes without the window doing anything when the
     * scoreboard wraps to a second line on a phone.
     */
    const fit = () => {
      const box = boardRef.current?.getBoundingClientRect();
      engine.resize(canvas, box?.width ?? window.innerWidth, box?.height ?? window.innerHeight);
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (boardRef.current) observer.observe(boardRef.current);

    // Mirrors of what the HUD already shows, so a frame that changed nothing
    // does not push a render.
    let lastTurn = -1;
    let lastHole = -1;
    let lastPhase = '';
    let lastStrokes = '';
    let lastTotals = '';
    let lastDone = '';
    let lastClock = -1;
    let lastCard = -1;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(64, now - last);
      last = now;

      engine.draw(dt);

      // The bot thinks for a beat before putting. Instant shots read as a bug.
      if (engine.awaitingAI(aiDriverRef.current) && aiTimer.current === null) {
        const seat = engine.turn;
        aiTimer.current = window.setTimeout(
          () => {
            aiTimer.current = null;
            const live = engineRef.current;
            if (!live || live.turn !== seat || live.phase !== 'aim') return;
            const shot = chooseShot(
              live.course,
              live.balls[seat],
              live.seats[seat]?.aiLevel ?? 1,
              brains.current[seat] ?? newBrain(),
            );
            live.putt(shot.angle, shot.power);
          },
          THINK_MS + Math.random() * 500,
        );
      }

      // The clock only ever runs against somebody sitting at this device — a
      // remote player's clock is their own device's business, and running a
      // second copy of it here would putt for them.
      if (session.rules.turnTimer && engine.awaitingLocal) {
        clockRef.current = Math.max(0, clockRef.current - dt / 1000);
        if (clockRef.current === 0) {
          const shot = engine.timeoutShot();
          engine.putt(shot.angle, shot.power);
        }
      }

      if (engine.turn !== lastTurn) {
        lastTurn = engine.turn;
        clockRef.current = TURN_SECONDS;
        setTurn(engine.turn);
      }
      if (engine.holeIndex !== lastHole) {
        lastHole = engine.holeIndex;
        setHoleIndex(lastHole);
        setPar(engine.par);
      }
      if (engine.phase !== lastPhase) {
        lastPhase = engine.phase;
        setPhase(engine.phase);
      }
      const strokeKey = engine.strokes.join(',');
      if (strokeKey !== lastStrokes) {
        lastStrokes = strokeKey;
        setStrokes(engine.strokes.slice());
      }
      const totalKey = engine.totals.join(',');
      if (totalKey !== lastTotals) {
        lastTotals = totalKey;
        setTotals(engine.totals.slice());
      }
      const doneKey = engine.done.join(',');
      if (doneKey !== lastDone) {
        lastDone = doneKey;
        setDone(engine.done.slice());
      }
      if (engine.card.length !== lastCard) {
        lastCard = engine.card.length;
        setCard(engine.card.map((row) => row.slice()));
      }
      const shown = Math.ceil(clockRef.current);
      if (shown !== lastClock) {
        lastClock = shown;
        setClock(shown);
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      if (aiTimer.current !== null) window.clearTimeout(aiTimer.current);
      aiTimer.current = null;
      engineRef.current = null;
    };
    // The green is rebuilt only when the *round* changes — a new seed, a new
    // toss, a rematch. Listing anything the lobby can touch here would reset a
    // round in progress the moment somebody's name or badge changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.seed, session?.first, session?.rules.players, session?.rules.holes, session?.rules.hazards, rematch]);

  /**
   * A new seed is a new round, however it arrived.
   *
   * The host clears the result panel in `playAgain`; a guest only learns of the
   * rematch when the host's start packet lands, and without this it would sit
   * behind the final card watching a fresh green it could not touch.
   */
  useEffect(() => {
    setOver(null);
    setNotice(null);
    setBanner(null);
    clockRef.current = TURN_SECONDS;
  }, [session?.seed]);

  useEffect(
    () => () => {
      if (bannerTimer.current !== null) window.clearTimeout(bannerTimer.current);
    },
    [],
  );

  // -- keyboard ---------------------------------------------------------------

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine) return;
      const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (arrows.includes(e.code) || e.code === 'Space') e.preventDefault();
      if (e.repeat && e.code === 'Space') return;
      if (!engine.awaitingLocal) return;

      const fine = e.shiftKey ? 0.25 : 1;
      if (e.code === 'ArrowLeft') engine.aimAngle -= 0.045 * fine;
      else if (e.code === 'ArrowRight') engine.aimAngle += 0.045 * fine;
      else if (e.code === 'ArrowUp') engine.aimPower = clamp(engine.aimPower + 0.05 * fine, 0.06, 1);
      else if (e.code === 'ArrowDown') engine.aimPower = clamp(engine.aimPower - 0.05 * fine, 0.06, 1);
      else if (e.code === 'Space') {
        audioService.unlock();
        if (engine.putt(engine.aimAngle, engine.aimPower)) settled();
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [settled]);

  // -- pointer ----------------------------------------------------------------

  const onAim = useCallback((aim: Aim) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.aimAngle = aim.angle;
    engine.aimPower = aim.power;
  }, []);

  const onFire = useCallback(
    (aim: Aim) => {
      const engine = engineRef.current;
      if (!engine) return;
      if (engine.putt(aim.angle, aim.power)) settled();
    },
    [settled],
  );

  // -- render -----------------------------------------------------------------

  const players = session?.rules.players ?? config.rules.players;
  const holes = session?.rules.holes ?? config.rules.holes;
  const myTurn = localSeats.has(turn) && phase === 'aim';
  const mover = config.seats[turn]?.name ?? 'Someone';
  const tied = (over?.winners.length ?? 0) > 1;
  const soleWinner = over && !tied ? over.winners[0] : null;
  const iWon = over ? !tied && config.localSeats.includes(over.winners[0]) : false;

  const turnLabel =
    phase === 'over'
      ? ''
      : phase === 'holeOver'
        ? 'Hole finished'
        : phase === 'rolling'
          ? 'Rolling…'
          : myTurn
            ? config.localSeats.length > 1
              ? `${mover} to putt`
              : 'Your putt'
            : `${mover} is lining it up`;

  if (!session) {
    return (
      <div className="flex h-[100dvh] w-full flex-col items-center justify-center gap-3 bg-[#276334] text-white">
        <Loader2 className="h-10 w-10 animate-spin text-emerald-200" />
        <p className="font-bold">
          {connectionLost ? 'Lost contact before the round could start.' : 'Waiting for the host to tee it up.'}
        </p>
        {notice && connectionLost && <p className="text-xs text-amber-200">{notice}</p>}
        <div className="mt-2 flex gap-2">
          {connectionLost && (
            <button onClick={retryConnection} className="rounded-2xl bg-emerald-400 px-5 py-2 text-sm font-bold text-emerald-950">
              Try again
            </button>
          )}
          <button onClick={onExit} className="rounded-2xl border border-white/25 bg-white/10 px-5 py-2 text-sm font-bold">
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={shellRef} className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-[#276334] text-white">
      {/* ── the card, at a glance ── */}
      <div className="pointer-events-none z-30 flex items-start justify-between gap-2 p-2 sm:p-3">
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <div className="flex items-center gap-1.5 rounded-xl border border-white/20 bg-black/35 px-2.5 py-1.5 backdrop-blur-md">
            <Flag className="h-3.5 w-3.5 text-emerald-200" />
            <span className="text-xs font-black">
              {holeIndex + 1}
              <span className="opacity-60">/{holes}</span>
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-white/60">par {par}</span>
          </div>
          {config.seats.slice(0, players).map((seat, i) => (
            <PlayerChip
              key={seat.id}
              seat={seat}
              index={i}
              strokes={strokes[i] ?? 0}
              total={(totals[i] ?? 0) + (strokes[i] ?? 0)}
              out={done[i] ?? false}
              active={turn === i && phase !== 'over'}
              mine={localSeats.has(i)}
            />
          ))}
        </div>

        {/* The row is pointer-events-none so drags fall through to the pad;
            the tray has to opt back in or none of its buttons are reachable. */}
        <div className="pointer-events-auto shrink-0">
          <ControlsTray
            shellRef={shellRef}
            online={online}
            isHost={config.isHost}
            onSettings={onOpenSettings}
            onExit={onExit}
            theme="dark"
            before={
              <div className="flex items-center gap-1.5 rounded-2xl border border-white/20 bg-slate-950/60 px-3 py-2.5 text-xs font-bold text-amber-300 backdrop-blur-md">
                <Coins className="h-4 w-4" /> {coins}
              </div>
            }
          />
        </div>
      </div>

      {/* ── the green ── */}
      <div ref={boardRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />

        <AimPad
          enabled={myTurn && !over}
          onAim={onAim}
          onFire={onFire}
          onFirstTouch={() => {
            audioService.unlock();
            // The Fullscreen API only grants a request handling a real user
            // gesture, and the first touch is one. Skipped while embedded:
            // PlayBuddies drives fullscreen for the whole frame, and a game
            // that grabs it from underneath leaves the two disagreeing.
            if (IN_IFRAME || document.fullscreenElement) return;
            toggleFullscreen(shellRef.current ?? document.documentElement, true);
          }}
        />

        {turnLabel && (
          <div className="pointer-events-none absolute inset-x-0 top-1 z-20 flex flex-col items-center gap-1">
            <div
              className="rounded-full border border-white/20 bg-black/45 px-3 py-1 text-[11px] font-black uppercase tracking-[0.16em] backdrop-blur-md"
              style={{ color: SEATS[turn % SEATS.length]?.light }}
            >
              {turnLabel}
            </div>
            {session.rules.turnTimer && myTurn && (
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-black/35">
                <div
                  className="h-full rounded-full transition-[width] duration-200"
                  style={{
                    width: `${Math.max(0, Math.min(100, (clock / TURN_SECONDS) * 100))}%`,
                    background: clock <= 5 ? '#f43f5e' : SEATS[turn % SEATS.length]?.main,
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* ── HOLE IN ONE!, IN THE DRINK!, and the rest ── */}
        {banner && phase !== 'over' && (
          <div className="pointer-events-none absolute inset-x-0 top-1/3 z-30 flex justify-center px-4">
            <div
              key={banner.id}
              className={`shout rounded-2xl border px-5 py-2.5 text-center text-xl font-black uppercase tracking-tight shadow-2xl sm:text-3xl ${TONE[banner.tone]}`}
            >
              {banner.label}
            </div>
          </div>
        )}

        {/* ── between holes ── */}
        {phase === 'holeOver' && !over && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]">
            <div className="w-full max-w-xs rounded-[1.75rem] border border-white/20 bg-slate-950/85 p-5 text-center">
              <p className="text-[11px] font-black uppercase tracking-[0.25em] text-white/50">
                Hole {holeIndex + 1} · par {par}
              </p>
              <div className="mt-3 space-y-1.5">
                {config.seats.slice(0, players).map((seat, i) => {
                  const took = card[holeIndex]?.[i];
                  return (
                    <div key={seat.id} className="flex items-center gap-2 text-sm">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SEATS[i].main }} />
                      <span className="min-w-0 flex-1 truncate text-left font-bold">{seat.name}</span>
                      <span className="font-black tabular-nums">{took ?? '—'}</span>
                      <span className="w-10 text-right text-xs font-bold text-white/50">
                        {took !== null && took !== undefined ? relativeToPar(took, par) : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-[11px] font-semibold text-white/40">
                {holeIndex + 1 >= holes ? 'Adding it up…' : 'Next hole coming up…'}
              </p>
            </div>
          </div>
        )}
      </div>

      {notice && (
        <div className={`absolute inset-x-0 bottom-4 z-30 flex justify-center px-4 ${connectionLost ? '' : 'pointer-events-none'}`}>
          <div className="flex items-center gap-3 rounded-xl border border-amber-300/40 bg-slate-950/85 px-4 py-2 text-center text-xs font-bold text-amber-200">
            {notice}
            {connectionLost && (
              <button onClick={retryConnection} className="rounded-lg bg-amber-400 px-2.5 py-1 text-[11px] font-black text-slate-900">
                Retry
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── how it works, pinned for the whole round rather than just this turn ── */}
      {!over && (
        <div className="pointer-events-none absolute left-2 top-20 z-10 max-w-[10.5rem] rounded-2xl border border-white/15 bg-black/40 p-3 text-[10px] leading-relaxed text-white/70 backdrop-blur-md">
          <p className="mb-1 font-black uppercase tracking-[0.15em] text-white/45">How it works</p>
          <p>Drag back from anywhere and release. Further back is harder; the line is the line.</p>
          <p className="mt-1.5">Bank off the blocks, stay out of the ponds, and get down in fewer than everybody else.</p>
          <p className="mt-1.5 hidden text-white/45 sm:block">Arrows aim · space putts.</p>
        </div>
      )}

      {/* ── the clubhouse ── */}
      {over && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/65 p-6 backdrop-blur-sm">
          <div className="w-full max-w-sm space-y-5 rounded-[2rem] border border-white/20 bg-slate-900/92 p-7 text-center">
            <Trophy
              className="mx-auto h-14 w-14"
              style={{ color: soleWinner !== null ? SEATS[soleWinner % SEATS.length]?.main : '#cbd5e1' }}
            />
            <div>
              <h2 className="text-3xl font-black tracking-tight">
                {/* On a couch every ball is local, so "you win" is true of
                    whoever is reading it and useless. Name the player instead. */}
                {tied
                  ? config.localSeats.length === 1 && over.winners.includes(config.localSeats[0])
                    ? 'You tied'
                    : "It's a tie"
                  : iWon && config.localSeats.length === 1
                    ? 'You win'
                    : `${engineRef.current?.seats[soleWinner as number]?.name ?? SEATS[(soleWinner as number) % SEATS.length].name} wins`}
              </h2>
              <p className="mt-1 text-sm font-semibold text-white/50">
                {holes} {holes === 1 ? 'hole' : 'holes'} · lowest card takes it
              </p>
            </div>

            <div className="space-y-1.5 rounded-2xl bg-black/30 p-3">
              {config.seats
                .slice(0, players)
                .map((seat, i) => ({ seat, i, total: over.totals[i] ?? 0 }))
                .sort((a, b) => a.total - b.total)
                .map(({ seat, i, total }) => (
                  <div key={seat.id} className="flex items-center gap-2 text-sm">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SEATS[i].main }} />
                    <span className="min-w-0 flex-1 truncate text-left font-bold">{seat.name}</span>
                    <span className="font-black tabular-nums">{total}</span>
                  </div>
                ))}
            </div>

            <div className="flex gap-2">
              {(!online || config.isHost) && (
                <button
                  onClick={playAgain}
                  className="flex-1 rounded-2xl bg-emerald-400 py-3 font-black text-emerald-950 transition-transform active:scale-95"
                >
                  Play again
                </button>
              )}
              <button onClick={onExit} className="flex-1 rounded-2xl border border-white/20 bg-white/10 py-3 font-black text-white/80">
                {online ? 'Back to the room' : 'Back'}
              </button>
            </div>
            {online && !config.isHost && (
              <p className="text-[11px] font-semibold text-white/40">The host can start another round.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One player, in a strip: their colour, their name, this hole and the round.
 *
 * The two numbers are deliberately different weights. The one that matters
 * shot to shot is this hole; the one that decides the round is the total, and
 * it sits quieter until the last green.
 */
function PlayerChip({
  seat,
  index,
  strokes,
  total,
  out,
  active,
  mine,
}: {
  seat: Seat;
  index: number;
  strokes: number;
  total: number;
  out: boolean;
  active: boolean;
  mine: boolean;
}) {
  const side = SEATS[index % SEATS.length];
  return (
    <div
      className={`pointer-events-none flex items-center gap-2 rounded-xl border bg-black/35 px-2.5 py-1.5 backdrop-blur-md transition-transform ${
        active ? 'scale-[1.03]' : ''
      } ${out ? 'opacity-60' : ''}`}
      style={{ borderColor: active ? side.main : 'rgba(255,255,255,0.14)' }}
    >
      <span
        className="h-3.5 w-3.5 shrink-0 rounded-full"
        style={{ background: side.main, boxShadow: active ? `0 0 0 3px ${side.dark}` : undefined }}
      />
      <div className="min-w-0 leading-tight">
        <p className="max-w-[7rem] truncate text-xs font-black">
          {seat.name}
          {mine ? ' · you' : ''}
        </p>
        <p className="flex items-center gap-2 text-[10px] font-bold text-white/55">
          <span className="flex items-center gap-0.5">
            <Target className="h-3 w-3" />
            {strokes}
          </span>
          <span className="tabular-nums">tot {total}</span>
          {seat.control === 'ai' && (
            <span className="rounded bg-white/15 px-1 text-[9px] uppercase tracking-wide">
              {TIERS[seat.aiLevel]?.label ?? 'Bot'}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
