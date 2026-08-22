/**
 * The battle on screen: the render loop, the controls, and the wire.
 *
 * The engine knows nothing about React, the keyboard or Firestore. This
 * component owns all three and hands the engine plain numbers, which is what
 * keeps the simulation testable and the transport swappable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Loader2, Settings as SettingsIcon, Ship as ShipIcon, Wind } from 'lucide-react';
import AimPad, { Aim } from '../components/AimPad';
import CardHand, { HAND_HEIGHT, HAND_HEIGHT_COMPACT } from '../components/CardHand';
import { BattleEngine, Seat } from '../engine/BattleEngine';
import { Brain, chooseShot, newBrain } from '../engine/ai';
import { BALANCE, CardId, TEAM_COLORS, clamp } from '../game/rules';
import { QualityGovernor } from '../game/quality';
import { SHIPS } from '../game/ships';
import { IN_IFRAME, toggleFullscreen } from '../fullscreen';
import { audioService } from '../services/audio';
import type { GameSettings, NetPacket, Phase, Team } from '../types/game';
// Type only: the runtime value arrives through the dynamic import below, which
// is what keeps the Firebase SDK out of an offline player's bundle.
import type { TurnLink } from '../net/turnLink';

export interface MatchConfig {
  /** null for offline play. */
  roomId: string | null;
  uid: string | null;
  /** The other human, online only. */
  peerUid: string | null;
  isHost: boolean;
  seats: [Seat, Seat];
  /** Teams driven from this device: one online or solo, both on a couch. */
  localTeams: Team[];
  /** Difficulty for bots, including one that takes over from a dropout. */
  aiLevel: number;
  /** Chosen by the host online, locally otherwise. */
  seed: number;
  first: Team;
}

interface Session {
  seed: number;
  first: Team;
}

/** Elevation, in radians above the horizon, from a world angle. */
function elevOf(angle: number, facing: 1 | -1): number {
  return facing > 0 ? -angle : angle + Math.PI;
}

function angleOf(elev: number, facing: 1 | -1): number {
  return facing > 0 ? -elev : elev - Math.PI;
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

  const online = Boolean(config.roomId && config.uid && config.peerUid);

  /**
   * The whole negotiation.
   *
   * The host draws a seed and a first shooter and sends those two numbers. The
   * guest waits for them and builds the identical match from nothing else: the
   * wind, the drift, the rocks and every hand for the rest of the game all
   * fall out of the seed.
   */
  const [session, setSession] = useState<Session | null>(
    online && !config.isHost ? null : { seed: config.seed, first: config.first },
  );
  const [hp, setHp] = useState<[number, number]>([BALANCE.MAX_HP, BALANCE.MAX_HP]);
  const [turn, setTurn] = useState<Team>(config.first);
  const [phase, setPhase] = useState<Phase>('deal');
  const [hand, setHand] = useState<CardId[]>([]);
  const [selected, setSelected] = useState<CardId>('round');
  const [clock, setClock] = useState<number>(BALANCE.TURN_TIME);
  const [wind, setWind] = useState(0);
  const [over, setOver] = useState<{ winner: Team } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [coarse, setCoarse] = useState(false);
  const [compact, setCompact] = useState(false);
  const [portrait, setPortrait] = useState(false);
  const [rotateHint, setRotateHint] = useState(true);
  const [rematch, setRematch] = useState(0);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const held = useRef<Record<string, boolean>>({});
  const draggingRef = useRef(false);
  const brains = useRef<[Brain, Brain]>([newBrain(), newBrain()]);
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
  const localTeamsKey = config.localTeams.join(',');
  const remoteTeam = (1 - (config.localTeams[0] ?? 0)) as Team;
  const { aiLevel } = config;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const localTeams = useMemo(() => new Set(config.localTeams), [localTeamsKey]);
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
    engine.aimAngle = angleOf(clamp(elev, 0.06, 1.53), facing);

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
    (packet: NetPacket) => {
      if (packet.t === 'start') {
        setSession((current) =>
          current && current.seed === packet.seed ? current : { seed: packet.seed, first: packet.first },
        );
        return;
      }
      if (packet.t === 'bye') {
        engineRef.current?.handOverToAI(remoteTeam, aiLevel);
        setNotice('They abandoned ship. A bot has the wheel.');
        return;
      }
      if (packet.t !== 'fire' && packet.t !== 'shot') return;
      // A turn doubles as a start packet. The host's document holds exactly one
      // write at a time, so a guest that arrives after the opening shot finds a
      // turn where the negotiation was; the seed and the first shooter travel
      // on it, which is everything a match is built from. Carried on the
      // preview too, since that is now usually the first thing to arrive.
      if (packet.first !== undefined) {
        const opening = { seed: packet.s, first: packet.first };
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
    [remoteTeam, aiLevel],
  );

  useEffect(() => {
    if (!online || !config.roomId || !config.uid || !config.peerUid) return;

    let disposed = false;
    let link: TurnLink | null = null;
    let leave: (() => void) | undefined;

    void import('../net/turnLink')
      .then(({ TurnLink: Link }) => {
        // The match can be left while this import is still in flight; without
        // the guard the listener opens with nothing left to close it.
        if (disposed) return;
        link = new Link(
          config.roomId as string,
          config.uid as string,
          config.peerUid as string,
          handlePacket,
          (message) => setNotice(message),
          // The host's terms ride along on every turn it writes, not only on
          // the start packet that the next write replaces.
          config.isHost ? { first: config.first } : undefined,
        );
        linkRef.current = link;

        // Two numbers, sent once. Everything else about the match is derived.
        if (config.isHost) {
          link.send({ t: 'start', n: Date.now(), seed: config.seed, first: config.first });
        }

        leave = () => link?.close();
        window.addEventListener('pagehide', leave);
      })
      .catch((err) => {
        console.error('Could not open the wire', err);
        setNotice('Could not reach the other ship.');
      });

    return () => {
      disposed = true;
      if (leave) window.removeEventListener('pagehide', leave);
      link?.close();
      linkRef.current = null;
    };
  }, [online, config.roomId, config.uid, config.peerUid, config.isHost, config.seed, config.first, handlePacket]);

  // -- the engine and the loop -----------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const governor = new QualityGovernor(settingsRef.current.lowPower);
    brains.current = [newBrain(), newBrain()];

    const engine = new BattleEngine({
      seats: config.seats,
      seed: session.seed,
      first: session.first,
      obstacles: settingsRef.current.obstacles,
      turnTimer: settingsRef.current.turnTimer,
      onSfx: (kind, power) => {
        if (kind === 'fire') audioService.playFire(power ?? 0.6);
        else if (kind === 'hull') audioService.playHull(power ?? 0.6);
        else if (kind === 'splash') audioService.playSplash();
        else if (kind === 'rock') audioService.playRock();
        else if (kind === 'deal') audioService.playDeal();
        else if (kind === 'burn') audioService.playBurn();
        else if (kind === 'sink') audioService.playSink();
      },
      onLocalShot: online ? (packet) => linkRef.current?.send(packet) : undefined,
      onOver: (winner) => {
        setOver({ winner });
        const won = localTeams.has(winner);
        onResult(won, Math.round(engine.ships[winner].hp));
        audioService.playEnd(won);
      },
    });
    engineRef.current = engine;
    for (const packet of queued.current) {
      if (packet.t === 'fire') engine.applyFire(packet);
      else if (packet.t === 'shot') engine.applyShot(packet);
    }
    queued.current = [];

    const decide = (team: Team) =>
      chooseShot(engine, team, engine.ships[team].aiLevel, brains.current[team]);

    // Dev-only handles. "Who is on the water, whose turn does the engine think
    // it is, and what would a bot do from here" are the first three questions
    // worth asking when a turn appears stuck, and none of them can be answered
    // from the console without these.
    if (import.meta.env.DEV) {
      const dev = window as unknown as { __battle?: BattleEngine; __decide?: (team: Team) => unknown };
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
      hp0: -1,
      hp1: -1,
      turn: -1 as number,
      phase: '' as string,
      selected: '' as string,
      clock: -1,
      wind: 99,
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
      engine.aiming =
        settingsRef.current.aimGuide && engine.awaitingLocal && (draggingRef.current || !coarseRef.current);
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
      const hp0 = engine.hp[0];
      const hp1 = engine.hp[1];
      const windRounded = Math.round(engine.wind * 20) / 20;

      if (hp0 !== shown.hp0 || hp1 !== shown.hp1) {
        shown.hp0 = hp0;
        shown.hp1 = hp1;
        setHp([hp0, hp1]);
      }
      if (engine.turn !== shown.turn) {
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
      if (windRounded !== shown.wind) {
        shown.wind = windRounded;
        setWind(windRounded);
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
    setSession({ seed: (Math.random() * 0x7fffffff) | 0, first: Math.random() < 0.5 ? 0 : 1 });
    setRematch((n) => n + 1);
  }, []);

  // -- render -----------------------------------------------------------------

  const myTurn = localTeams.has(turn) && (phase === 'aim' || phase === 'deal');
  const canAim = phase === 'aim' && myTurn && !over;
  const facing: 1 | -1 = turn === 0 ? 1 : -1;
  const handHeight = compact ? HAND_HEIGHT_COMPACT : HAND_HEIGHT;
  const showHand = myTurn && !over;

  // A seat handed to a bot keeps its owner's name, so this line has to read
  // properly for "Alice (adrift)" and for the solo seat, which is called "You".
  const shooter = config.seats[turn].name;
  const turnLabel = over
    ? ''
    : myTurn || shooter.toLowerCase() === 'you'
      ? config.localTeams.length > 1
        ? `${shooter} to fire`
        : 'Your shot'
      : `${shooter} is aiming`;

  if (!session) {
    return (
      <div className="flex h-[100dvh] w-full flex-col items-center justify-center gap-3 bg-[#04121f] text-white">
        <Loader2 className="h-10 w-10 animate-spin text-amber-300" />
        <p className="font-bold text-white/80">Waiting for the host to weigh anchor.</p>
        <button onClick={onExit} className="mt-2 rounded-2xl border border-white/20 bg-white/5 px-5 py-2 text-sm font-bold">
          Back
        </button>
      </div>
    );
  }

  return (
    <div ref={shellRef} className="relative h-[100dvh] w-full overflow-hidden bg-[#04121f] text-white">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />

      {/* -- the two hulls, at a glance -- */}
      <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-2">
        <div className="flex w-full max-w-[560px] items-stretch gap-1.5 rounded-2xl border border-white/15 bg-slate-950/55 p-1.5 backdrop-blur-md">
          {([0, 1] as Team[]).map((team) => (
            <HullMeter
              key={team}
              name={config.seats[team].name}
              skin={config.seats[team].skin}
              hp={hp[team]}
              team={team}
              mine={localTeams.has(team)}
              active={turn === team && !over}
            />
          ))}
        </div>
      </div>

      {/* -- wind, turn and clock -- */}
      <div className="pointer-events-none absolute inset-x-0 top-[76px] z-20 flex flex-col items-center gap-1.5">
        <WindGauge wind={wind} />
        {turnLabel && (
          <div
            className="rounded-full border border-white/15 bg-slate-950/60 px-3 py-1 text-[11px] font-black uppercase tracking-[0.16em] backdrop-blur-md"
            style={{ color: TEAM_COLORS[turn].light }}
          >
            {turnLabel}
            {canAim && settings.turnTimer && clock <= 10 ? ` - ${clock}s` : ''}
          </div>
        )}
      </div>

      {/*
        PlayBuddies floats its own Invite / Full screen / End Game bar over this
        corner at a z-index the iframe cannot reach, so this row has to start
        below it. Full screen is not repeated here for the same reason: the
        host already provides one, and two in one corner is the overlap.
      */}
      <div className={`absolute right-2 z-30 flex gap-2 ${IN_IFRAME ? 'top-20' : 'top-2'}`}>
        <button
          onClick={onOpenSettings}
          aria-label="Settings"
          className="rounded-2xl border border-white/20 bg-slate-950/60 p-3 backdrop-blur-md"
        >
          <SettingsIcon className="h-5 w-5" />
        </button>
        <button
          onClick={onExit}
          aria-label="Leave the battle"
          className="rounded-2xl border border-white/20 bg-slate-950/60 p-3 backdrop-blur-md"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      </div>

      {portrait && rotateHint && !over && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-30 flex justify-center px-6">
          <div className="rounded-2xl border border-white/15 bg-slate-950/85 px-4 py-2 text-center text-xs font-bold text-white/75 backdrop-blur-md">
            Turn your phone sideways for a bigger sea.
          </div>
        </div>
      )}

      {notice && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[124px] z-30 flex justify-center px-4">
          <div className="rounded-xl border border-amber-300/40 bg-slate-950/85 px-4 py-2 text-center text-xs font-bold text-amber-200">
            {notice}
          </div>
        </div>
      )}

      <AimPad
        enabled={canAim}
        facing={facing}
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

      {/* -- how to play, on a device with keys -- */}
      {!coarse && canAim && !dragging && (
        <div className="pointer-events-none absolute inset-x-0 bottom-1 z-10 flex justify-center">
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
              style={{ color: localTeams.has(over.winner) ? '#fbbf24' : '#64748b' }}
            />
            {/* On a couch both seats are local, so "you win" is true of
                whoever is reading it and useless. Name the winner instead. */}
            <h2 className="text-3xl font-black">
              {config.localTeams.length > 1
                ? `${config.seats[over.winner].name} takes it!`
                : localTeams.has(over.winner)
                  ? 'Prize taken!'
                  : 'You are sunk'}
            </h2>
            <p className="text-sm text-white/60">
              {/* The solo seat is literally called "You", so the verb has to
                  agree with it or the line reads "You wins". */}
              {config.seats[over.winner].name}{' '}
              {config.seats[over.winner].name.toLowerCase() === 'you' ? 'win' : 'wins'} with{' '}
              {hp[over.winner]} hull left.
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
  skin,
  hp,
  team,
  mine,
  active,
}: {
  name: string;
  skin: number;
  hp: number;
  team: Team;
  mine: boolean;
  active: boolean;
}) {
  const frac = clamp(hp / BALANCE.MAX_HP, 0, 1);
  const colors = TEAM_COLORS[team];
  return (
    <div
      className={`min-w-0 flex-1 rounded-xl px-2.5 py-1.5 transition-colors ${active ? 'bg-white/10' : ''}`}
      style={{ boxShadow: active ? `inset 0 0 0 1.5px ${colors.main}` : undefined }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px] font-black uppercase tracking-wider" style={{ color: colors.light }}>
          {/* The marker is dropped when the seat is already called "You", which
              is what the solo seat is named. "You - you" reads as a bug. */}
          {name}
          {mine && name.toLowerCase() !== 'you' ? ' - you' : ''}
        </span>
        <span className="shrink-0 text-sm font-black tabular-nums">{hp}</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-white/15">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${frac * 100}%`,
            background: frac > 0.55 ? '#4ade80' : frac > 0.3 ? '#fbbf24' : '#f87171',
          }}
        />
      </div>
      <div className="mt-0.5 truncate text-[9px] font-bold uppercase tracking-wider text-white/35">
        {SHIPS[clamp(skin, 0, SHIPS.length - 1)].name}
      </div>
    </div>
  );
}

/**
 * The wind, as an arrow.
 *
 * It has to be readable in the half second between looking up and pulling
 * back, so it is a direction and a length rather than a number: a long arrow
 * pointing right means the ball goes right, and that is the whole of it.
 */
function WindGauge({ wind }: { wind: number }) {
  const strength = Math.min(1, Math.abs(wind));
  const dead = strength < 0.05;
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/15 bg-slate-950/60 px-3 py-1 backdrop-blur-md">
      <Wind className="h-3.5 w-3.5 text-sky-200" />
      <div className="relative h-3 w-24">
        <div className="absolute left-1/2 top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-white/25" />
        {!dead && (
          <div
            className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-sky-300"
            style={{
              width: `${strength * 46}%`,
              left: wind > 0 ? '50%' : undefined,
              right: wind < 0 ? '50%' : undefined,
            }}
          />
        )}
      </div>
      <span className="w-9 text-[10px] font-black uppercase tracking-wider text-white/55">
        {dead ? 'calm' : wind > 0 ? 'east' : 'west'}
      </span>
    </div>
  );
}
