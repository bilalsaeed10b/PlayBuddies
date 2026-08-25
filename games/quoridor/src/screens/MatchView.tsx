/**
 * The game on screen: the render loop, the controls, and the wire.
 *
 * The engine knows nothing about React, the keyboard or Firestore. This
 * component owns all three and hands the engine plain integers, which is what
 * keeps the rules testable and the transport swappable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, Coins, Flag, Footprints, Loader2, RotateCw, Trophy } from 'lucide-react';
import ControlsTray from '@shared/controls/ControlsTray';
import BoardPad from '../components/BoardPad';
import { QuoridorEngine } from '../engine/QuoridorEngine';
import type { Seat } from '../engine/QuoridorEngine';
import { TIERS, chooseMove, fallbackMove, newBrain } from '../engine/ai';
import type { Brain } from '../engine/ai';
import { HORIZONTAL, SIDES, VERTICAL, wallsFor } from '../game/rules';
import type { Orientation } from '../game/rules';
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
  /** Everyone else in the game, online only. Empty offline. */
  peerUids: string[];
  isHost: boolean;
  /** Two or four seats. An index into this is a pawn, everywhere. */
  seats: Seat[];
  /** Seats played from this device: one online, one to four on a couch. */
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
 * Everything the board needs that the host decides.
 *
 * The rules join the seed and the toss here rather than being read from local
 * settings, because all three have to be identical everywhere: a guest that
 * laid out its own idea of the game would seat the pawns differently and
 * reject every move that arrived.
 */
interface Session {
  seed: number;
  first: number;
  rules: MatchRules;
}

const THINK_MS = 420;

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
  onResult: (won: boolean, movesTaken: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<QuoridorEngine | null>(null);
  const linkRef = useRef<TurnLink | null>(null);

  const online = Boolean(config.roomId && config.uid && config.peerUids.length > 0);
  /**
   * Bots are driven by exactly one device.
   *
   * Offline that is obviously this one. Online it is the host and nobody else:
   * two clients each deciding a bot's move would write two different games
   * into two documents, and whichever landed second would rebuild the other's
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
  const [stock, setStock] = useState<number[]>(() =>
    config.seats.map(() => wallsFor(config.rules.players)),
  );
  const [dists, setDists] = useState<number[]>(() => config.seats.map(() => -1));
  const [moves, setMoves] = useState(0);
  const [over, setOver] = useState<{ winner: number } | null>(null);
  const [clock, setClock] = useState(TURN_SECONDS);
  const [mode, setMode] = useState<'move' | 'wall'>('move');
  const [forced, setForced] = useState<Orientation | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [rematch, setRematch] = useState(0);

  /**
   * True while the wire itself is the problem — it never opened, or it dropped
   * mid-game — as opposed to an ordinary notice like somebody going idle.
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
  /** Move lists that arrived before the engine existed. */
  const queued = useRef<number[][]>([]);
  const clockRef = useRef(TURN_SECONDS);

  /**
   * Everything below keys on strings and numbers, never on the config object.
   *
   * App rebuilds `config` on every render and re-renders on every lobby
   * snapshot, so its arrays are a different array each time even when nothing
   * about the game has changed. That is fine for the HUD and fatal for the
   * wire: an effect that lists an array identity in its dependencies tears the
   * link down and opens a new one, and closing a link writes a `bye` — which
   * tells everyone else this player abandoned their pawn, over and over.
   */
  const peerKey = config.peerUids.join(',');
  const seatIdKey = config.seats.map((s) => s.id).join(',');
  const localKey = config.localSeats.join(',');
  const { aiLevel } = config;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const localSeats = useMemo(() => new Set(config.localSeats), [localKey]);
  /** Which seat each remote player holds, so a `bye` lands on the right pawn. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seatOfUid = useMemo(() => {
    const map = new Map<string, number>();
    config.seats.forEach((seat, i) => map.set(seat.id, i));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatIdKey]);

  /**
   * Whether this device drives the bots, read from a ref inside the loop.
   *
   * As a dependency it would rebuild the board — resetting a live game — the
   * moment the lobby handed the host badge to somebody else.
   */
  const aiDriverRef = useRef(aiDriver);
  aiDriverRef.current = aiDriver;

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
        setNotice(`${engineRef.current?.seats[seat]?.name ?? 'A player'} left. A bot has their pawn.`);
        return;
      }
      if (packet.t !== 'move') return;

      // A move doubles as a start packet. Each document holds exactly one write
      // at a time, so a guest that arrives after the opening move finds a move
      // list where the negotiation was; the first player and the rules travel
      // on it, which is everything the board is built from.
      if (packet.first !== undefined) {
        const opening = { seed: packet.s, first: packet.first, rules: unpackRules(packet.r) };
        setSession((current) => current ?? opening);
      }

      const engine = engineRef.current;
      if (!engine) {
        queued.current.push(packet.h);
        return;
      }
      // A document survives the game that wrote it, so the first snapshot after
      // subscribing can be last night's final move. Stamping the seed makes a
      // stale game obvious instead of replayable.
      if (packet.s !== engine.seedTag) return;
      engine.syncHistory(packet.h);
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
        // The game can be left while this import is still in flight; without
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

        // The whole negotiation, sent once: which seat starts, and the rules.
        // Nothing else about a Quoridor board needs agreeing on.
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
   * move before the host's has a move list and no way to interpret it.
   */
  useEffect(() => {
    if (!session) return;
    linkRef.current?.setStamp({ first: session.first, r: packRules(session.rules) });
  }, [session]);

  // -- the engine and the loop ------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return;

    const engine = new QuoridorEngine({
      // The engine flips a seat's control to 'ai' when its player leaves, so it
      // gets its own copy rather than mutating the object App rebuilds.
      seats: config.seats.map((s) => ({ ...s })),
      players: session.rules.players,
      first: session.first,
      seedTag: session.seed,
      onSfx: (kind) => {
        if (kind === 'step') audioService.playStep();
        else if (kind === 'wall') audioService.playWall();
        else if (kind === 'deny') audioService.playDeny();
        else if (kind === 'turn') audioService.playTurn();
      },
      onLocalMove: online
        ? (history) => linkRef.current?.send({ t: 'move', n: Date.now(), s: session.seed, h: history })
        : undefined,
      onOver: (winner) => {
        setOver({ winner });
        const won = config.localSeats.includes(winner);
        onResult(won, engine.history.length);
        audioService.playEnd(won);
      },
    });
    engineRef.current = engine;
    brains.current = engine.seats.map(() => newBrain());
    for (const history of queued.current) engine.syncHistory(history);
    queued.current = [];

    // Dev-only handle. "Where is everybody, whose turn does the board think it
    // is, and what would a bot do from here" are the first three questions
    // worth asking when a turn looks stuck, and none of them can be answered
    // from the console without this.
    if (import.meta.env.DEV) {
      (window as unknown as { __board?: QuoridorEngine }).__board = engine;
    }

    /**
     * The canvas is sized from its container, not from the window.
     *
     * `resize` writes an explicit pixel width and height onto the element,
     * which is what keeps a CSS pixel and a board coordinate the same thing —
     * and also what overrides the `w-full h-full` classes, so nothing else
     * will correct it. A window listener alone was not enough: the board's box
     * changes without the window doing anything at all when the player chips
     * wrap to a second line, when the tray grows, or when the CSS fallback
     * fullscreen path fires. A ResizeObserver catches every one of those, and
     * the window resize with them.
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
    let lastMoves = -1;
    let lastStock = '';
    let lastClock = -1;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(64, now - last);
      last = now;

      engine.showHints = settingsRef.current.hints;
      engine.draw(dt);

      // The bot thinks for a beat before moving. Instant moves read as a bug.
      if (engine.awaitingAI(aiDriverRef.current) && aiTimer.current === null) {
        const seat = engine.turn;
        aiTimer.current = window.setTimeout(
          () => {
            aiTimer.current = null;
            const live = engineRef.current;
            if (!live || live.turn !== seat || live.winner >= 0) return;
            live.play(
              chooseMove(live.pos, seat, live.players, live.seats[seat]?.aiLevel ?? 1, brains.current[seat] ?? newBrain()),
            );
          },
          THINK_MS + Math.random() * 420,
        );
      }

      // The clock only ever runs against somebody sitting at this device — a
      // remote player's clock is their own device's business, and running a
      // second copy of it here would move their pawn for them.
      if (session.rules.turnTimer && engine.awaitingLocal) {
        clockRef.current = Math.max(0, clockRef.current - dt / 1000);
        if (clockRef.current === 0) {
          // A step along their own shortest route, never a wall: a clock
          // should not spend somebody's walls for them.
          engine.play(fallbackMove(engine.pos, engine.turn, engine.players));
        }
      }

      if (engine.turn !== lastTurn) {
        lastTurn = engine.turn;
        clockRef.current = TURN_SECONDS;
        setTurn(engine.turn);
      }
      if (engine.history.length !== lastMoves) {
        lastMoves = engine.history.length;
        setMoves(lastMoves);
        setDists(engine.distances());
      }
      const stockKey = engine.pos.stock.join(',');
      if (stockKey !== lastStock) {
        lastStock = stockKey;
        setStock(engine.pos.stock.slice());
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // The board is rebuilt only when the *game* changes — a new seed, a new
    // toss, a rematch. Listing anything the lobby can touch here would reset a
    // game in progress the moment somebody's name or badge changed.
  }, [session?.seed, session?.first, session?.rules.players, rematch]);

  useEffect(() => {
    const engine = engineRef.current;
    if (engine) engine.mode = mode;
  }, [mode]);

  /**
   * A new seed is a new game, however it arrived.
   *
   * The host clears the result panel in `playAgain`; a guest only learns of the
   * rematch when the host's start packet lands, and without this it would sit
   * behind "somebody crossed" watching a fresh board it could not touch.
   */
  useEffect(() => {
    setOver(null);
    setNotice(null);
    setMode('move');
    setForced(undefined);
    clockRef.current = TURN_SECONDS;
  }, [session?.seed]);

  // -- actions ----------------------------------------------------------------

  /**
   * A move landed. Declared above the keyboard listener on purpose — that
   * effect lists it as a dependency, and a dependency array is read during
   * render, so a `const` declared further down is still in its dead zone.
   */
  const settled = useCallback(() => {
    clockRef.current = TURN_SECONDS;
    // Wall mode is a deliberate choice, not a state to be stuck in: after one
    // lands, the board goes back to the thing you do nine turns out of ten.
    setMode('move');
    setForced(undefined);
  }, []);

  // -- keyboard ---------------------------------------------------------------

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine) return;
      const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (arrows.includes(e.code) || e.code === 'Space') e.preventDefault();
      if (e.repeat) return;

      if (e.code === 'KeyW') {
        setMode((m) => (m === 'move' ? 'wall' : 'move'));
        audioService.playPop();
        return;
      }
      if (e.code === 'KeyR') {
        setForced((o) => (o === HORIZONTAL ? VERTICAL : HORIZONTAL));
        audioService.playPop();
        return;
      }
      if (!engine.awaitingLocal) return;

      if (engine.mode === 'wall') {
        if ((e.code === 'Enter' || e.code === 'Space') && engine.hover?.ok) {
          // Same tidy-up the pointer path gets: a wall that lands puts the
          // board back into stepping, rather than leaving it armed.
          if (engine.playWall(engine.hover.o, engine.hover.r, engine.hover.c)) settled();
        }
        return;
      }

      const step = arrows.indexOf(e.code);
      if (step < 0) return;
      // Up, down, left, right — the same four the rules allow and no more.
      const delta = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ][step];
      const from = engine.pos.pawns[engine.turn];
      const r = Math.floor(from / 9) + delta[0];
      const c = (from % 9) + delta[1];
      // A blocked step in that direction may still be a legal jump two squares
      // along, which is what the second candidate covers.
      const near = r * 9 + c;
      const far = (r + delta[0]) * 9 + (c + delta[1]);
      const legal = engine.targets();
      if (legal.includes(near)) engine.playStep(near);
      else if (legal.includes(far)) engine.playStep(far);
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [settled]);

  const playAgain = useCallback(() => {
    setOver(null);
    setNotice(null);
    setMode('move');
    const next = { seed: (Math.random() * 0x7fffffff) | 0, first: Math.floor(Math.random() * config.rules.players) };
    setSession((current) => ({ ...next, rules: current?.rules ?? config.rules }));
    setRematch((n) => n + 1);
    // Online, the others are waiting on exactly this: a fresh seed makes every
    // document from the last game stale, and the new toss reaches them here.
    if (online && config.isHost) {
      linkRef.current?.setStamp({ first: next.first, r: rulesBits });
      linkRef.current?.send({ t: 'start', n: Date.now(), seed: next.seed, first: next.first, r: rulesBits });
    }
  }, [online, config.isHost, config.rules, rulesBits]);

  // -- render -----------------------------------------------------------------

  const engine = engineRef.current;
  const players = session?.rules.players ?? config.rules.players;
  const myTurn = localSeats.has(turn) && !over;
  const wallsLeft = stock[turn] ?? 0;
  const mover = config.seats[turn]?.name ?? 'Someone';
  const mySeat = config.localSeats[0] ?? 0;
  const iWon = over ? config.localSeats.includes(over.winner) : false;

  const turnLabel = over
    ? ''
    : myTurn
      ? config.localSeats.length > 1
        ? `${mover} to move`
        : 'Your move'
      : `${mover} is thinking`;

  if (!session) {
    return (
      <div className="flex h-[100dvh] w-full flex-col items-center justify-center gap-3 bg-[#eef2f7] text-slate-800">
        <Loader2 className="h-10 w-10 animate-spin text-amber-500" />
        <p className="font-bold">
          {connectionLost ? 'Lost contact before the game could start.' : 'Waiting for the host to set the board.'}
        </p>
        {notice && connectionLost && <p className="text-xs text-amber-700">{notice}</p>}
        <div className="mt-2 flex gap-2">
          {connectionLost && (
            <button onClick={retryConnection} className="rounded-2xl bg-amber-400 px-5 py-2 text-sm font-bold text-slate-900">
              Try again
            </button>
          )}
          <button onClick={onExit} className="rounded-2xl border border-black/10 bg-white px-5 py-2 text-sm font-bold">
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-[linear-gradient(160deg,#f7f3ea_0%,#e8eef4_55%,#dfe7ef_100%)] text-slate-800"
    >
      {/* ── who is who, and how far they have to go ── */}
      <div className="pointer-events-none z-30 flex items-start justify-between gap-2 p-2 sm:p-3">
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {config.seats.slice(0, players).map((seat, i) => (
            <PlayerChip
              key={seat.id}
              seat={seat}
              index={i}
              walls={stock[i] ?? 0}
              steps={dists[i] ?? -1}
              active={turn === i && !over}
              mine={localSeats.has(i)}
            />
          ))}
        </div>

        {/* The row is pointer-events-none so taps fall through to the board;
            the tray has to opt back in or none of its buttons are reachable. */}
        <div className="pointer-events-auto shrink-0">
          <ControlsTray
            shellRef={shellRef}
            online={online}
            isHost={config.isHost}
            onSettings={onOpenSettings}
            onExit={onExit}
            theme="light"
            before={
              <div className="flex items-center gap-1.5 rounded-xl border border-black/10 bg-white/80 px-3 py-2 text-sm font-bold text-amber-600">
                <Coins className="h-4 w-4" /> {coins}
              </div>
            }
          />
        </div>
      </div>

      {/* ── the board ── */}
      <div ref={boardRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />
        <BoardPad
          engineRef={engineRef}
          enabled={myTurn}
          forced={mode === 'wall' ? forced : undefined}
          onSettled={settled}
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
              className="rounded-full border border-black/10 bg-white/85 px-3 py-1 text-[11px] font-black uppercase tracking-[0.16em] shadow-sm backdrop-blur"
              style={{ color: SIDES[turn]?.dark }}
            >
              {turnLabel}
            </div>
            {session.rules.turnTimer && myTurn && (
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-black/10">
                <div
                  className="h-full rounded-full transition-[width] duration-200"
                  style={{
                    width: `${Math.max(0, Math.min(100, (clock / TURN_SECONDS) * 100))}%`,
                    background: clock <= 5 ? '#e11d48' : SIDES[turn]?.main,
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── step, or build ── */}
      <div className="z-30 flex shrink-0 items-center justify-center gap-2 p-2 sm:p-3">
        <div className="flex items-center gap-1 rounded-2xl border border-black/10 bg-white/85 p-1 shadow-sm backdrop-blur">
          <ModeButton
            active={mode === 'move'}
            onClick={() => {
              setMode('move');
              audioService.playPop();
            }}
            icon={<Footprints className="h-4 w-4" />}
            label="Step"
          />
          <ModeButton
            active={mode === 'wall'}
            disabled={wallsLeft <= 0 && myTurn}
            onClick={() => {
              setMode('wall');
              audioService.playPop();
            }}
            icon={<Blocks className="h-4 w-4" />}
            label={`Wall · ${myTurn ? wallsLeft : stock[mySeat] ?? 0}`}
          />
        </div>
        {mode === 'wall' && (
          <button
            onClick={() => {
              setForced((o) => (o === HORIZONTAL ? VERTICAL : HORIZONTAL));
              audioService.playPop();
            }}
            className="flex items-center gap-1.5 rounded-2xl border border-black/10 bg-white/85 px-3 py-2.5 text-xs font-bold shadow-sm backdrop-blur"
            title="Pin the wall's direction (R)"
          >
            <RotateCw className="h-4 w-4" />
            {forced === undefined ? 'Auto' : forced === HORIZONTAL ? 'Across' : 'Down'}
          </button>
        )}
      </div>

      {notice && (
        <div className={`absolute inset-x-0 bottom-20 z-30 flex justify-center px-4 ${connectionLost ? '' : 'pointer-events-none'}`}>
          <div className="flex items-center gap-3 rounded-xl border border-amber-400/50 bg-white/95 px-4 py-2 text-center text-xs font-bold text-amber-700 shadow-sm">
            {notice}
            {connectionLost && (
              <button onClick={retryConnection} className="rounded-lg bg-amber-400 px-2.5 py-1 text-[11px] font-black text-slate-900">
                Retry
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── result ── */}
      {over && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/45 p-6 backdrop-blur-sm">
          <div className="w-full max-w-sm space-y-5 rounded-[2rem] border border-black/10 bg-white/95 p-7 text-center shadow-2xl">
            <Trophy className="mx-auto h-14 w-14" style={{ color: SIDES[over.winner]?.main ?? '#f59e0b' }} />
            <div>
              <h2 className="text-3xl font-black tracking-tight">
                {/* On a couch every seat is local, so "you win" is true of
                    whoever is reading it and useless. Name the pawn instead. */}
                {iWon && config.localSeats.length === 1
                  ? 'You crossed'
                  : `${engine?.seats[over.winner]?.name ?? SIDES[over.winner].name} crosses`}
              </h2>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                {moves} moves · {SIDES[over.winner]?.name} reached the far side
              </p>
            </div>
            <div className="flex gap-2">
              {(!online || config.isHost) && (
                <button
                  onClick={playAgain}
                  className="flex-1 rounded-2xl bg-amber-400 py-3 font-black text-slate-900 transition-transform active:scale-95"
                >
                  Play again
                </button>
              )}
              <button onClick={onExit} className="flex-1 rounded-2xl border border-black/10 bg-white py-3 font-black text-slate-600">
                {online ? 'Back to the room' : 'Back'}
              </button>
            </div>
            {online && !config.isHost && (
              <p className="text-[11px] font-semibold text-slate-400">The host can deal another game.</p>
            )}
          </div>
        </div>
      )}

      {/* ── how to play, on a device with keys ── */}
      <div className="pointer-events-none absolute inset-x-0 bottom-14 z-10 hidden justify-center sm:flex">
        <div className="rounded-xl border border-black/10 bg-white/70 px-3 py-1 text-[10px] font-semibold text-slate-500 backdrop-blur">
          arrows step · W switches to walls · R pins a direction · Enter drops it
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-black uppercase tracking-wider transition-colors disabled:opacity-35 ${
        active ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-black/5'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * One player, in a strip: their colour, their name, walls in hand and how many
 * squares they still have to cross.
 *
 * The step count is the whole game stated as one number. It is also what makes
 * a wall's worth obvious the moment it lands — somebody's number jumps.
 */
function PlayerChip({
  seat,
  index,
  walls,
  steps,
  active,
  mine,
}: {
  seat: Seat;
  index: number;
  walls: number;
  steps: number;
  active: boolean;
  mine: boolean;
}) {
  const side = SIDES[index];
  return (
    <div
      className={`pointer-events-none flex items-center gap-2 rounded-xl border bg-white/85 px-2.5 py-1.5 shadow-sm backdrop-blur transition-transform ${
        active ? 'scale-[1.03]' : ''
      }`}
      style={{ borderColor: active ? side.main : 'rgba(0,0,0,0.08)' }}
    >
      <span
        className="h-4 w-4 shrink-0 rounded-full ring-2"
        style={{ background: side.main, boxShadow: active ? `0 0 0 3px ${side.light}` : undefined }}
      />
      <div className="min-w-0 leading-tight">
        <p className="max-w-[7rem] truncate text-xs font-black">
          {seat.name}
          {mine ? ' · you' : ''}
        </p>
        <p className="flex items-center gap-2 text-[10px] font-bold text-slate-500">
          <span className="flex items-center gap-0.5">
            <Blocks className="h-3 w-3" />
            {walls}
          </span>
          <span className="flex items-center gap-0.5">
            <Flag className="h-3 w-3" />
            {steps < 0 ? '—' : steps}
          </span>
          {seat.control === 'ai' && (
            <span className="rounded bg-slate-200 px-1 text-[9px] uppercase tracking-wide text-slate-500">
              {TIERS[seat.aiLevel]?.label ?? 'Bot'}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
