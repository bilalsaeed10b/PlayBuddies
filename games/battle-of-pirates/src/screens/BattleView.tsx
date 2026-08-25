/**
 * The battle on screen: the render loop, the controls, and the wire.
 *
 * The engine knows nothing about React, the keyboard or Firestore. This
 * component owns all three and hands the engine plain numbers, which is what
 * keeps the simulation testable and the transport swappable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Ship as ShipIcon } from 'lucide-react';
import AimPad, { Aim } from '../components/AimPad';
import CardHand, { HAND_HEIGHT, HAND_HEIGHT_COMPACT } from '../components/CardHand';
import { BattleEngine, Seat } from '../engine/BattleEngine';
import { Brain, chooseShot, newBrain } from '../engine/ai';
import { BALANCE, CardId, TEAM_COLORS, angleOf, clamp, elevOf, elevRange } from '../game/rules';
import { QualityGovernor } from '../game/quality';
import { IN_IFRAME, toggleFullscreen } from '../fullscreen';
import ControlsTray from '@shared/controls/ControlsTray';
import { audioService } from '../services/audio';
import { packRules, unpackRules } from '../types/game';
import { devLog } from '@shared/devlog/devlog';
import type { GameSettings, MatchRules, NetPacket, Phase, Team } from '../types/game';
// Type only: the runtime value arrives through the dynamic import below, which
// is what keeps the Firebase SDK out of an offline player's bundle.
import type { TurnLink } from '../net/turnLink';

export interface MatchConfig {
  /** null for offline play. */
  roomId: string | null;
  uid: string | null;
  /** Everyone else in the battle, online only. Empty offline. */
  peerUids: string[];
  isHost: boolean;
  /** Two, four or six hulls. Index into this is a ship, everywhere. */
  seats: Seat[];
  /** Hulls driven from this device: one online, one or two on a couch. */
  localShips: number[];
  /** Difficulty for bots, including one that takes over from a dropout. */
  aiLevel: number;
  /** Chosen by the host online, locally otherwise. */
  seed: number;
  first: Team;
  /** The host's rules. A guest's copy is overwritten by whatever arrives on the wire. */
  rules: MatchRules;
}

/**
 * Everything the engine needs that the host decides.
 *
 * The rules join the seed and the coin toss here rather than being read from
 * local settings, because all three have to be identical on both clients: a
 * guest that built its engine from its own idea of the rules would spawn a
 * different mountain and deal itself different cards.
 */
interface Session {
  seed: number;
  first: Team;
  rules: MatchRules;
}

export default function BattleView({
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
  onResult: (won: boolean, hpLeft: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<BattleEngine | null>(null);
  const linkRef = useRef<TurnLink | null>(null);

  const online = Boolean(config.roomId && config.uid && config.peerUids.length > 0);
  /**
   * The rules as one number, so the wire effect below can depend on them.
   *
   * `config.rules` is a fresh object on every render — App rebuilds the whole
   * config from scratch each lobby snapshot — and listing it in a dependency
   * array would tear the link down and reopen it several times a second,
   * writing a `bye` each time. See the note on `localTeamsKey`: this is the
   * same hazard, and the same fix.
   */
  const rulesBits = packRules(config.rules);

  /**
   * The whole negotiation.
   *
   * The host draws a seed and a first shooter and sends those two numbers. The
   * guest waits for them and builds the identical match from nothing else:
   * the drift, the rocks and every hand for the rest of the game all fall
   * out of the seed.
   */
  const [session, setSession] = useState<Session | null>(
    online && !config.isHost ? null : { seed: config.seed, first: config.first, rules: config.rules },
  );
  const [hp, setHp] = useState<number[]>(() => config.seats.map(() => BALANCE.MAX_HP));
  /** Index into  of whoever has the helm, not a side. */
  const [turn, setTurn] = useState<number>(0);
  const [phase, setPhase] = useState<Phase>('deal');
  const [hand, setHand] = useState<CardId[]>([]);
  const [selected, setSelected] = useState<CardId>('round');
  const [clock, setClock] = useState<number>(BALANCE.TURN_TIME);
  const [over, setOver] = useState<{ winner: Team } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * True while the wire itself is the problem -- it never opened, or it dropped
   * mid-match -- as opposed to an ordinary notice like a partner going idle.
   *
   * Without this, the only way out of "Could not reach the other ship." was
   * leaving the whole match: a page that fails to open a link once (a chunk
   * that didn't finish loading, a deploy landing mid-request, one dropped
   * packet) never got a second attempt. Bumping `wireGeneration` below tears
   * the link down and opens a fresh one without touching the battle itself,
   * which is still running fine locally on both sides the whole time.
   */
  const [connectionLost, setConnectionLost] = useState(false);
  const [wireGeneration, setWireGeneration] = useState(0);
  /** Set right before a retry tears the old link down, so its cleanup knows not to announce a bye for a partner who is still here. */
  const retryingRef = useRef(false);
  const retryConnection = useCallback(() => {
    retryingRef.current = true;
    setConnectionLost(false);
    setNotice(null);
    setWireGeneration((n) => n + 1);
  }, []);
  const [dragging, setDragging] = useState(false);
  /**
   * Whether the two rosters are showing names or just bars.
   *
   * Folded by default on anything being aimed with a thumb. A phone in
   * landscape is the tightest screen this game runs on and the one where the
   * roster covered actual water, and the information it holds -- who is on
   * which side, and roughly how hurt -- is already on the water: every hull
   * carries its own bar above it. Read once at mount rather than off the
   * `coarse` state below, which only lands after the first paint.
   */
  const [hudOpen, setHudOpen] = useState(
    () => typeof matchMedia !== 'function' || !matchMedia('(pointer: coarse)').matches,
  );
  const [coarse, setCoarse] = useState(false);
  const [compact, setCompact] = useState(false);
  const [portrait, setPortrait] = useState(false);
  const [rotateHint, setRotateHint] = useState(true);
  const [rematch, setRematch] = useState(0);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const held = useRef<Record<string, boolean>>({});
  const draggingRef = useRef(false);
  /** One per hull, since every seat can end up driven by a bot. */
  const brains = useRef<Brain[]>([]);
  /** Shots that arrived before the engine existed. */
  const queued = useRef<NetPacket[]>([]);

  /**
   * Everything below keys on numbers, never on the config object.
   *
   * App rebuilds `config` from scratch on every render, and it re-renders on
   * every lobby snapshot, so its arrays are a different array each time even
   * when the match has not changed by a single field. That is fine for the
   * HUD and fatal for the wire: an effect that lists an array identity in its
   * dependencies tears the link down and opens a new one, and closing a link
   * writes a `bye`. Mid-match, the other player was told their opponent had
   * abandoned ship and handed the wheel to a bot -- over and over, for as long
   * as the lobby kept ticking.
   */
  const localShipsKey = config.localShips.join(',');
  const peerKey = config.peerUids.join(',');
  const { aiLevel } = config;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const localShips = useMemo(() => new Set(config.localShips), [localShipsKey]);
  /**
   * Which hull each remote player is sailing, so a `bye` can be pinned on the
   * ship its sender was actually driving rather than on "the other one".
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shipOfUid = useMemo(() => {
    const map = new Map<string, number>();
    config.seats.forEach((seat, i) => map.set(seat.id, i));
    return map;
  }, [config.seats.map((s) => s.id).join(',')]);
  /** Read once a frame from a ref, so a media-query change cannot rebuild the loop. */
  const coarseRef = useRef(false);
  coarseRef.current = coarse;

  /**
   * Keyboard aiming, applied per frame rather than per keypress.
   *
   * Elevation is worked out in the ship's own frame and converted back, so up
   * is up whichever way the hull is pointing. Holding shift is the fine
   * adjustment, which is the difference between landing a shot and walking
   * past it in one press.
   */
  const readKeyboard = useCallback((engine: BattleEngine, dt: number) => {
    if (!engine.awaitingLocal) return;
    const facing = engine.facing(engine.turn);
    const keys = held.current;

    let elev = elevOf(engine.aimAngle, facing);
    const rate = (keys.ShiftLeft || keys.ShiftRight ? 0.16 : 0.6) * dt;
    if (keys.ArrowUp) elev += rate;
    if (keys.ArrowDown) elev -= rate;
    const [loElev, hiElev] = elevRange(engine.selected);
    engine.aimAngle = angleOf(clamp(elev, loElev, hiElev), facing);

    const powerRate = (keys.ShiftLeft || keys.ShiftRight ? 0.12 : 0.45) * dt;
    if (keys.ArrowRight) engine.aimPower = clamp(engine.aimPower + powerRate, 0.06, 1);
    if (keys.ArrowLeft) engine.aimPower = clamp(engine.aimPower - powerRate, 0.06, 1);
  }, []);

  useEffect(() => {
    const probe = () => {
      setCoarse(window.matchMedia('(pointer: coarse)').matches);
      // Short viewports lose the card blurbs before they lose the cards.
      setCompact(window.innerHeight < 560);
      // The arena is 16:9 and always fully visible, so an upright phone
      // letterboxes it into a strip. It stays playable, but it is worth one
      // sentence saying the game is nicer turned sideways.
      setPortrait(window.innerHeight > window.innerWidth * 1.15);
    };
    probe();
    window.addEventListener('resize', probe);
    window.addEventListener('orientationchange', probe);
    return () => {
      window.removeEventListener('resize', probe);
      window.removeEventListener('orientationchange', probe);
    };
  }, []);

  // One sentence, once, and then it gets out of the way for good.
  useEffect(() => {
    if (!portrait || !rotateHint) return;
    const id = window.setTimeout(() => setRotateHint(false), 5000);
    return () => window.clearTimeout(id);
  }, [portrait, rotateHint]);

  // -- the wire ---------------------------------------------------------------

  const handlePacket = useCallback(
    (packet: NetPacket, from: string) => {
      devLog('battle-of-pirates', 'wire:recv', { from, type: packet.t, n: 'n' in packet ? packet.n : undefined });
      if (packet.t === 'start') {
        setSession((current) =>
          current && current.seed === packet.seed
            ? current
            : { seed: packet.seed, first: packet.first, rules: unpackRules(packet.r) },
        );
        return;
      }
      if (packet.t === 'bye') {
        const ship = shipOfUid.get(from);
        if (ship === undefined) return;
        engineRef.current?.handOverToAI(ship, aiLevel);
        setNotice(`${config.seats[ship]?.name ?? 'A captain'} abandoned ship. A bot has the wheel.`);
        return;
      }
      if (packet.t !== 'fire' && packet.t !== 'shot') return;
      // A turn doubles as a start packet. The host's document holds exactly one
      // write at a time, so a guest that arrives after the opening shot finds a
      // turn where the negotiation was; the seed and the first shooter travel
      // on it, which is everything a match is built from. Carried on the
      // preview too, since that is now usually the first thing to arrive.
      if (packet.first !== undefined) {
        const opening = { seed: packet.s, first: packet.first, rules: unpackRules(packet.r) };
        setSession((current) => current ?? opening);
      }
      const engine = engineRef.current;
      // The engine drops a packet stamped with a different seed, so a leftover
      // document from an earlier match cannot replay itself here.
      if (!engine) {
        queued.current.push(packet);
        return;
      }
      if (packet.t === 'fire') engine.applyFire(packet);
      else engine.applyShot(packet);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shipOfUid, aiLevel],
  );

  useEffect(() => {
    if (!online || !config.roomId || !config.uid || config.peerUids.length === 0) return;

    let disposed = false;
    let link: TurnLink | null = null;
    let leave: ((e: PageTransitionEvent) => void) | undefined;

    void import('../net/turnLink')
      .then(({ TurnLink: Link }) => {
        // The match can be left while this import is still in flight; without
        // the guard the listener opens with nothing left to close it.
        if (disposed) return;
        devLog('battle-of-pirates', 'wire:open', { roomId: config.roomId, isHost: config.isHost, peerUids: config.peerUids });
        link = new Link(
          config.roomId as string,
          config.uid as string,
          config.peerUids,
          handlePacket,
          (message) => {
            devLog('battle-of-pirates', 'wire:error', { message });
            setNotice(message);
            // Every message TurnLink reports on its own -- the open failing,
            // the listener dropping, a send bouncing -- means the link itself
            // needs a fresh attempt, not just an acknowledgement.
            setConnectionLost(true);
          },
          // The host's terms ride along on every turn it writes, not only on
          // the start packet that the next write replaces.
          config.isHost ? { first: config.first, r: rulesBits } : undefined,
        );
        linkRef.current = link;

        // The whole negotiation, sent once: a seed, a coin toss and the rules.
        // Everything else about the match is derived from those.
        if (config.isHost) {
          devLog('battle-of-pirates', 'wire:send', { type: 'start', seed: config.seed, first: config.first });
          link.send({
            t: 'start',
            n: Date.now(),
            seed: config.seed,
            first: config.first,
            r: rulesBits,
          });
        }

        // A tab going into the browser's back/forward cache -- the screen
        // locking, switching apps, backgrounding the browser -- fires this
        // exactly like a real close, but the page is still alive and typically
        // comes right back. `persisted` is what tells the two apart: true
        // means bfcache, false means an actual unload. Without this check
        // every player whose phone dimmed mid-match announced a real bye and
        // handed their still-very-present seat to a bot -- worse the longer a
        // match runs, which is exactly what a 4-player game does, since each
        // player waits through three other turns before their own comes up.
        leave = (e) => {
          if (e.persisted) return;
          link?.close();
        };
        window.addEventListener('pagehide', leave);
      })
      .catch((err) => {
        console.error('Could not open the wire', err);
        setNotice('Could not reach the other ship.');
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

  // -- the engine and the loop -----------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const governor = new QualityGovernor(settingsRef.current.lowPower);

    devLog('battle-of-pirates', 'engine:build', {
      seed: session.seed,
      first: session.first,
      players: session.rules.players,
      seats: config.seats.map((s) => ({ team: s.team, id: s.id, control: s.control })),
      localShips: config.localShips,
    });

    const engine = new BattleEngine({
      seats: config.seats,
      seed: session.seed,
      first: session.first,
      rules: session.rules,
      onSfx: (kind, power) => {
        if (kind === 'fire') audioService.playFire(power ?? 0.6);
        else if (kind === 'hull') audioService.playHull(power ?? 0.6);
        else if (kind === 'splash') audioService.playSplash();
        else if (kind === 'rock') audioService.playRock();
        else if (kind === 'deal') audioService.playDeal();
        else if (kind === 'burn') audioService.playBurn();
        else if (kind === 'sink') audioService.playSink();
      },
      onLocalShot: online
        ? (packet) => {
            devLog('battle-of-pirates', 'wire:send', { type: packet.t, n: packet.n });
            linkRef.current?.send(packet);
          }
        : undefined,
      onOver: (winner) => {
        setOver({ winner });
        // With a fleet, "did I win" is about the side I am sailing on, and the
        // hull the prize is counted from is my own — not some crewmate's.
        const won = config.localShips.some((i) => engine.ships[i].team === winner);
        const mine = config.localShips[0] ?? 0;
        onResult(won, Math.round(Math.max(0, engine.ships[mine].hp)));
        audioService.playEnd(won);
      },
    });
    engineRef.current = engine;
    for (const packet of queued.current) {
      if (packet.t === 'fire') engine.applyFire(packet);
      else if (packet.t === 'shot') engine.applyShot(packet);
    }
    queued.current = [];

    brains.current = engine.ships.map(() => newBrain());
    // Seeded per shot rather than Math.random(): every connected client runs
    // this same decide() for the same bot on the same turn, and an unseeded
    // roll meant each one picked a different aim, card or target for the
    // identical shot -- see aiRng's own comment for what that looked like
    // online.
    const decide = (ship: number) =>
      chooseShot(engine, ship, engine.ships[ship].aiLevel, brains.current[ship], engine.aiRng(ship));

    // Dev-only handles. "Who is on the water, whose turn does the engine think
    // it is, and what would a bot do from here" are the first three questions
    // worth asking when a turn appears stuck, and none of them can be answered
    // from the console without these.
    if (import.meta.env.DEV) {
      const dev = window as unknown as { __battle?: BattleEngine; __decide?: (ship: number) => unknown };
      dev.__battle = engine;
      dev.__decide = decide;
    }

    let tier = governor.quality.tier;
    const fit = () => {
      const box = shellRef.current?.getBoundingClientRect();
      engine.resize(canvas, box?.width ?? window.innerWidth, box?.height ?? window.innerHeight, governor.quality);
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);

    // Mirrors of what the HUD is already showing, so a frame that changed
    // nothing costs no React work at all.
    const shown = {
      hp: '' as string,
      turn: -1 as number,
      phase: '' as string,
      selected: '' as string,
      clock: -1,
      hand: '',
    };

    let raf = 0;
    let last = performance.now();
    let skip = false;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;

      governor.sample(dt);
      const q = governor.quality;
      if (q.tier !== tier) {
        // A downgrade changes the backing-store size, so the canvas has to be
        // resized for it to mean anything.
        tier = q.tier;
        fit();
      }

      readKeyboard(engine, dt);
      // Only "is a drag live"; whether that shows the trajectory arc at all is
      // the host's rule, checked inside the engine's own render.
      engine.aiming = engine.awaitingLocal && (draggingRef.current || !coarseRef.current);
      engine.setBudget(q.particles);
      engine.update(dt, decide);

      // Nothing on the water is moving during a quiet aim phase except the
      // swell, so the cheap tiers draw it at half rate. The simulation above
      // still runs every frame; only the paint is skipped.
      const idle = q.idleHalfRate && engine.phase === 'aim' && !engine.aiming;
      skip = idle ? !skip : false;
      if (!skip) engine.render(ctx, q);

      // -- HUD, only when something a human can read has changed --
      const nextClock = Math.max(0, Math.ceil(engine.turnClock));
      const handKey = engine.hand.join(',');
      // One hp per hull now rather than a fixed pair, so this has to be a
      // string join like the others rather than two named locals -- there is
      // no hp0/hp1 to compare once a side can have three ships on it.
      const hpKey = engine.hp.join(',');

      if (hpKey !== shown.hp) {
        shown.hp = hpKey;
        setHp(engine.hp);
      }
      if (engine.turn !== shown.turn) {
        devLog('battle-of-pirates', 'turn:change', {
          from: shown.turn,
          to: engine.turn,
          control: engine.ships[engine.turn]?.control,
          seatId: config.seats[engine.turn]?.id,
        });
        shown.turn = engine.turn;
        setTurn(engine.turn);
      }
      if (engine.phase !== shown.phase) {
        shown.phase = engine.phase;
        setPhase(engine.phase);
      }
      if (handKey !== shown.hand) {
        shown.hand = handKey;
        setHand([...engine.hand]);
      }
      if (engine.selected !== shown.selected) {
        shown.selected = engine.selected;
        setSelected(engine.selected);
      }
      if (nextClock !== shown.clock) {
        shown.clock = nextClock;
        setClock(nextClock);
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
      window.removeEventListener('orientationchange', fit);
      engineRef.current = null;
    };
    // The engine is deliberately rebuilt only when the match itself changes.
    // Re-deriving it on a settings tweak would reset the hulls mid-battle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.seed, session?.first, rematch]);

  // -- keyboard ---------------------------------------------------------------

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      held.current[e.code] = true;
      if (e.repeat || !engine) return;

      if (e.code === 'Space' && engine.awaitingLocal) {
        audioService.unlock();
        engine.fire({ angle: engine.aimAngle, power: engine.aimPower, card: engine.selected });
        return;
      }
      const digit = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
      if (digit >= 0 && engine.hand[digit]) engine.select(engine.hand[digit]);
    };
    const up = (e: KeyboardEvent) => {
      held.current[e.code] = false;
    };
    const blur = () => {
      held.current = {};
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // -- pointer ----------------------------------------------------------------

  const onAim = useCallback((aim: Aim) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.aimAngle = aim.angle;
    engine.aimPower = aim.power;
  }, []);

  const onDragChange = useCallback((value: boolean) => {
    draggingRef.current = value;
    setDragging(value);
  }, []);

  const onFire = useCallback((aim: Aim) => {
    const engine = engineRef.current;
    if (!engine || !engine.awaitingLocal) return;
    engine.fire({ angle: aim.angle, power: aim.power, card: engine.selected });
  }, []);

  const pickCard = useCallback((card: CardId) => {
    engineRef.current?.select(card);
    audioService.playPop();
    setSelected(card);
  }, []);

  const playAgain = useCallback(() => {
    setOver(null);
    setNotice(null);
    // A rematch is a fresh seed and a fresh toss, played under the rules the
    // battle that just finished was played under.
    setSession((current) => ({
      seed: (Math.random() * 0x7fffffff) | 0,
      first: Math.random() < 0.5 ? 0 : 1,
      rules: current?.rules ?? config.rules,
    }));
    setRematch((n) => n + 1);
  }, []);

  // -- render -----------------------------------------------------------------

  const myTurn = localShips.has(turn) && (phase === 'aim' || phase === 'deal');
  const canAim = phase === 'aim' && myTurn && !over;
  /** My side, for colouring the HUD — the first hull this device sails. */
  const myTeam: Team = config.seats[config.localShips[0] ?? 0]?.team ?? 0;
  const turnTeam: Team = config.seats[turn]?.team ?? 0;
  const facing: 1 | -1 = turnTeam === 0 ? 1 : -1;
  const handHeight = compact ? HAND_HEIGHT_COMPACT : HAND_HEIGHT;
  // With cards off there is only ever the plain round shot, so a one-card hand
  // is a strip of screen showing the player a choice they do not have. The pad
  // takes the space back instead.
  const showHand = myTurn && !over && (session?.rules.cards ?? true);

  // A seat handed to a bot keeps its owner's name, so this line has to read
  // properly for "Alice (adrift)" and for the solo seat, which is called "You".
  const shooter = config.seats[turn]?.name ?? 'Someone';
  const turnLabel = over
    ? ''
    : myTurn || shooter.toLowerCase() === 'you'
      ? config.localShips.length > 1
        ? `${shooter} to fire`
        : 'Your shot'
      : `${shooter} is aiming`;

  // How the winning side finished: total timber left, and how many hulls are
  // still carrying it.
  const iWon = over ? myTeam === over.winner : false;
  const winnerTimber = over
    ? config.seats.reduce((sum, seat, i) => (seat.team === over.winner ? sum + (hp[i] ?? 0) : sum), 0)
    : 0;
  const winnerAfloat = over
    ? config.seats.filter((seat, i) => seat.team === over.winner && (hp[i] ?? 0) > 0).length
    : 0;

  if (!session) {
    return (
      <div className="flex h-[100dvh] w-full flex-col items-center justify-center gap-3 bg-[#04121f] text-white">
        <Loader2 className="h-10 w-10 animate-spin text-amber-300" />
        <p className="font-bold text-white/80">
          {connectionLost ? 'Lost contact before the match could start.' : 'Waiting for the host to weigh anchor.'}
        </p>
        {notice && connectionLost && <p className="text-xs text-amber-200/80">{notice}</p>}
        <div className="mt-2 flex gap-2">
          {connectionLost && (
            <button
              onClick={retryConnection}
              className="rounded-2xl bg-amber-400 px-5 py-2 text-sm font-bold text-slate-900"
            >
              Try again
            </button>
          )}
          <button onClick={onExit} className="rounded-2xl border border-white/20 bg-white/5 px-5 py-2 text-sm font-bold">
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={shellRef} className="relative h-[100dvh] w-full overflow-hidden bg-[#04121f] text-white">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />

      {/* -- every hull, at a glance, pinned to the edge its own side sails on --
          left is always team 0, right is always team 1, the same split the
          arena itself draws them in, so a glance at either edge tells you
          who's where without reading a name.

          Kept deliberately thin. On a phone in landscape there are barely 400
          points of height to work with, and two stacks of full-width cards ate
          a third of the water each -- so this is a name, a number and a hairline
          bar, and the ship's class name is gone entirely: it is the one line
          here that never changes and never affects a shot. The chevron folds
          even that away to a column of bare bars for anyone who wants the sea
          back, and folded is the default wherever a thumb is doing the aiming. */}
      {([0, 1] as Team[]).map((team) => (
        <div
          key={team}
          className={`pointer-events-none absolute top-14 z-20 flex flex-col ${team === 0 ? 'left-1.5 items-start' : 'right-1.5 items-end'}`}
        >
          <div
            className={`pointer-events-none space-y-0.5 rounded-lg border border-white/10 bg-slate-950/50 p-1 backdrop-blur-md ${
              hudOpen ? 'w-[92px] sm:w-[116px]' : 'w-8'
            }`}
          >
            {config.seats.map((seat, i) =>
              seat.team !== team ? null : (
                <HullMeter
                  key={i}
                  name={seat.name}
                  hp={hp[i] ?? 0}
                  team={team}
                  mine={localShips.has(i)}
                  active={turn === i && !over}
                  open={hudOpen}
                />
              ),
            )}
          </div>
          <button
            onClick={() => setHudOpen((open) => !open)}
            aria-label={hudOpen ? 'Fold the roster away' : 'Show the roster'}
            className="pointer-events-auto mt-1 flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-slate-950/50 text-white/40 backdrop-blur-md active:bg-white/10"
          >
            {/* Points the way the panel is about to move: outward to fold, back
                inward to open. */}
            {(team === 0) === hudOpen ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      ))}

      {/* -- turn and clock -- */}
      <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex flex-col items-center gap-1.5">
        {turnLabel && (
          <div
            className="rounded-full border border-white/15 bg-slate-950/60 px-3 py-1 text-[11px] font-black uppercase tracking-[0.16em] backdrop-blur-md"
            style={{ color: TEAM_COLORS[turnTeam].light }}
          >
            {turnLabel}
          </div>
        )}
        {canAim && session?.rules.turnTimer && <TurnTimerBar clock={clock} />}
      </div>

      <div className="absolute right-2 top-2 z-30 flex gap-2">
        <ControlsTray
          shellRef={shellRef}
          online={online}
          isHost={config.isHost}
          onSettings={onOpenSettings}
          onExit={onExit}
          theme="dark"
        />
      </div>

      {portrait && rotateHint && !over && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-30 flex justify-center px-6">
          <div className="rounded-2xl border border-white/15 bg-slate-950/85 px-4 py-2 text-center text-xs font-bold text-white/75 backdrop-blur-md">
            Turn your phone sideways for a bigger sea.
          </div>
        </div>
      )}

      {notice && (
        <div
          className={`absolute inset-x-0 bottom-[124px] z-30 flex justify-center px-4 ${connectionLost ? '' : 'pointer-events-none'}`}
        >
          <div className="flex items-center gap-3 rounded-xl border border-amber-300/40 bg-slate-950/85 px-4 py-2 text-center text-xs font-bold text-amber-200">
            {notice}
            {connectionLost && (
              <button
                onClick={retryConnection}
                className="rounded-lg bg-amber-400 px-2.5 py-1 text-[11px] font-black text-slate-900"
              >
                Retry
              </button>
            )}
          </div>
        </div>
      )}

      <AimPad
        enabled={canAim}
        facing={facing}
        selectedCard={selected}
        bottomInset={showHand ? handHeight : 8}
        onAim={onAim}
        onDragChange={onDragChange}
        onFire={onFire}
        onFirstTouch={() => {
          audioService.unlock();
          // The Fullscreen API only grants a request that is handling a real
          // user gesture, and the first touch of a match is one. Skipped while
          // embedded: PlayBuddies drives fullscreen for the whole frame, and a
          // game that grabs it from underneath leaves the two disagreeing.
          if (IN_IFRAME || document.fullscreenElement) return;
          toggleFullscreen(shellRef.current ?? document.documentElement, true);
        }}
      />

      {showHand && (
        <CardHand
          hand={hand}
          selected={selected}
          disabled={phase !== 'aim'}
          compact={compact}
          onSelect={pickCard}
        />
      )}

      {/* -- how to play, on a device with keys --
          Pinned above the card hand rather than at a fixed bottom-1, which used
          to sit directly behind it: the hand is z-20 and this was z-10 at the
          very same edge, so the hint was never actually visible whenever a hand
          was showing. */}
      {!coarse && canAim && !dragging && (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 flex justify-center"
          style={{ bottom: showHand ? handHeight + 8 : 4 }}
        >
          <div className="rounded-xl border border-white/10 bg-slate-950/50 px-3 py-1 text-[10px] font-semibold text-white/55 backdrop-blur-md">
            drag back and release to fire &middot; arrows adjust &middot; space fires &middot; 1-3 pick a card
          </div>
        </div>
      )}

      {/* -- result -- */}
      {over && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
          <div className="w-full max-w-sm space-y-5 rounded-[2rem] border border-white/20 bg-slate-900/90 p-7 text-center">
            <ShipIcon
              className="mx-auto h-14 w-14"
              style={{ color: iWon ? '#fbbf24' : '#64748b' }}
            />
            {/* On a couch both seats are local, so "you win" is true of
                whoever is reading it and useless. Name the side instead. */}
            <h2 className="text-3xl font-black">
              {config.localShips.length > 1
                ? `${TEAM_COLORS[over.winner].name} takes it!`
                : iWon
                  ? 'Prize taken!'
                  : 'You are sunk'}
            </h2>
            <p className="text-sm text-white/60">
              {/* Named by side rather than by captain: with three hulls a side
                  there is no single winner to point at, and with one the side
                  and the captain are the same thing anyway. */}
              {TEAM_COLORS[over.winner].name} wins with {winnerTimber} hull left across{' '}
              {winnerAfloat === 1 ? 'her last ship' : `${winnerAfloat} ships`}.
            </p>
            {!online && (
              <button
                onClick={playAgain}
                className="w-full rounded-2xl bg-amber-400 py-4 text-lg font-black text-slate-900 transition-transform active:scale-95"
              >
                Again
              </button>
            )}
            <button
              onClick={onExit}
              className="w-full rounded-2xl border border-white/20 bg-white/5 py-3 font-black text-white/80"
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HullMeter({
  name,
  hp,
  team,
  mine,
  active,
  open,
}: {
  name: string;
  hp: number;
  team: Team;
  mine: boolean;
  active: boolean;
  /** Folded, this is a bare bar and nothing else. */
  open: boolean;
}) {
  const frac = clamp(hp / BALANCE.MAX_HP, 0, 1);
  const colors = TEAM_COLORS[team];
  const fill = frac > 0.55 ? '#4ade80' : frac > 0.3 ? '#fbbf24' : '#f87171';

  if (!open) {
    return (
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-white/20"
        style={{ boxShadow: active ? `0 0 0 1.5px ${colors.main}` : undefined }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${frac * 100}%`, background: fill }}
        />
      </div>
    );
  }

  return (
    <div
      className={`min-w-0 rounded-md px-1 py-0.5 transition-colors ${active ? 'bg-white/10' : ''}`}
      style={{ boxShadow: active ? `inset 0 0 0 1px ${colors.main}` : undefined }}
    >
      <div className="flex items-center gap-1">
        {/* A dot rather than the " - you" that used to be spelled out: at this
            width the suffix was eating the name it was attached to. */}
        {mine && <span className="h-1 w-1 shrink-0 rounded-full bg-amber-300" />}
        <span className="truncate text-[9px] font-black uppercase tracking-wide" style={{ color: colors.light }}>
          {name}
        </span>
        <span className="ml-auto shrink-0 text-[10px] font-black tabular-nums text-white/85">{hp}</span>
      </div>
      <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white/20">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${frac * 100}%`, background: fill }}
        />
      </div>
    </div>
  );
}

/** How much of the turn clock is left, as a shrinking bar rather than a number to read. */
function TurnTimerBar({ clock }: { clock: number }) {
  const frac = clamp(clock / BALANCE.TURN_TIME, 0, 1);
  return (
    <div className="h-1.5 w-40 overflow-hidden rounded-full border border-white/10 bg-slate-950/60">
      <div
        className="h-full rounded-full transition-[width] duration-200 ease-linear"
        style={{
          width: `${frac * 100}%`,
          background: clock <= 5 ? '#f87171' : clock <= 10 ? '#fbbf24' : '#4ade80',
        }}
      />
    </div>
  );
}
