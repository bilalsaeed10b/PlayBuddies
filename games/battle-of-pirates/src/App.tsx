import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Anchor,
  ArrowLeft,
  Check,
  Coins,
  Crown,
  Loader2,
  Lock,
  Maximize2,
  Play,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react';
import { IN_IFRAME, toggleFullscreen } from './fullscreen';
import { FREE_SHIPS, SHIPS, drawShip } from './game/ships';
import { TEAM_COLORS } from './game/rules';
import { TIERS } from './engine/ai';
import { audioService } from './services/audio';
import BattleView, { MatchConfig } from './screens/BattleView';
import type { Seat } from './engine/BattleEngine';
import type { GameSettings, Team } from './types/game';

/**
 * The platform owns the lobby.
 *
 * This game never shows a login screen and never asks for a room code. It
 * reads the room it was handed in the query string, writes only its own slot
 * in it, and lets PlayBuddies decide who is in the match.
 */
interface Handoff {
  room: string;
  displayName: string;
  solo: boolean;
}

function readHandoff(): Handoff {
  const params = new URLSearchParams(window.location.search);
  const room = (params.get('room') || '').toUpperCase().trim();
  const handoff = {
    room,
    displayName: params.get('displayName') || '',
    solo: params.get('mode') === 'single',
  };
  // Clean the address bar so a copied link is not a stale room handoff.
  if (room) window.history.replaceState({}, document.title, window.location.pathname);
  return handoff;
}

const DEFAULT_SETTINGS: GameSettings = {
  bgmVolume: 0.3,
  sfxVolume: 0.75,
  aimGuide: true,
  turnTimer: true,
  obstacles: true,
  lowPower: false,
};

type View = 'menu' | 'pick' | 'room' | 'game' | 'offline_menu';

interface LobbyPerson {
  uid: string;
  displayName: string;
  /**
   * The lobby's per-player slot. Fish Eat Fish named it, Volley Clash reuses
   * it, and so does this: the security rules name the writable fields one by
   * one, so a new game inventing its own key would simply be refused.
   */
  fishIndex?: number | null;
}

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;
const coinFlip = (): Team => (Math.random() < 0.5 ? 0 : 1);

export default function App() {
  const [handoff] = useState(readHandoff);
  const online = Boolean(handoff.room);

  const [view, setView] = useState<View>(online ? 'room' : 'menu');
  const [showSettings, setShowSettings] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [lobby, setLobby] = useState<{
    hostId: string;
    players: Record<string, LobbyPerson>;
    matchStarted?: boolean;
  } | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  /** Offline setup: how many people are at this device, and as what. */
  const [seatCount, setSeatCount] = useState(1);
  const [seatSkin, setSeatSkin] = useState<Record<number, number>>({});
  const [aiLevel, setAiLevel] = useState(1);

  const [coins, setCoins] = useState(() => Number(localStorage.getItem('fishy_coins') || 0));
  const [owned, setOwned] = useState<number[]>(() => {
    const saved = localStorage.getItem('pirates_owned');
    const parsed: number[] = saved ? JSON.parse(saved) : [];
    return [...new Set([...parsed, ...FREE_SHIPS])];
  });
  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('pirates_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  // The coin balance is shared with the rest of PlayBuddies on purpose. Coins
  // earned in one game are worth something in the next, which is the only
  // thing that makes a single-player shop feel like part of a platform.
  useEffect(() => localStorage.setItem('fishy_coins', String(coins)), [coins]);
  useEffect(() => localStorage.setItem('pirates_owned', JSON.stringify(owned)), [owned]);
  useEffect(() => {
    localStorage.setItem('pirates_settings', JSON.stringify(settings));
    audioService.setVolumes(settings.bgmVolume, settings.sfxVolume);
  }, [settings]);

  // -- platform session -------------------------------------------------------
  //
  // Firebase is imported dynamically, and only down the online path.
  //
  // The SDK is several times the weight of the entire rest of the game, and a
  // solo or couch battle never calls into it once. As a static import it
  // became a modulepreload in the built HTML, so every player paid for all of
  // it before the sea could draw.
  useEffect(() => {
    if (!online) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void import('./firebase').then(({ auth, onAuthStateChanged }) => {
      if (cancelled) return;
      unsubscribe = onAuthStateChanged(auth, (user) => {
        setUid(user?.uid ?? null);
        setAuthChecked(true);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [online]);

  useEffect(() => {
    if (!online || !uid) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void import('./firebase').then(({ db, doc, onSnapshot }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, 'lobbies', handoff.room),
        (snap) => {
          if (!snap.exists()) {
            setLobbyError('That lobby is gone.');
            return;
          }
          const data = snap.data() as {
            hostId: string;
            players: Record<string, LobbyPerson>;
            matchStarted?: boolean;
          };
          if (!data.players?.[uid]) {
            setLobbyError("You are not in this lobby.");
            return;
          }
          setLobbyError(null);
          setLobby(data);
        },
        () => setLobbyError('Lost contact with the lobby.'),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [online, uid, handoff.room]);

  /**
   * Sides, decided by a stable sort on uid.
   *
   * Every client computes the same answer from data it already has. Deriving
   * sides from arrival order would give two players different ideas about who
   * is on the left.
   */
  const people = useMemo(() => {
    return Object.values(lobby?.players ?? {})
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .slice(0, 2)
      .map((p, i) => ({
        uid: p.uid,
        displayName: p.displayName || 'Player',
        skin: p.fishIndex,
        team: i as Team,
      }));
  }, [lobby]);

  const mySkin = uid ? lobby?.players?.[uid]?.fishIndex : undefined;
  const isHost = Boolean(uid && lobby && lobby.hostId === uid);
  const myTeam = people.find((p) => p.uid === uid)?.team ?? 0;

  useEffect(() => {
    if (!online) return;
    if (lobby?.matchStarted && mySkin !== undefined && mySkin !== null) setView('game');
    else if (view === 'game') setView('room');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.matchStarted, mySkin, online]);

  /**
   * A fresh seed and a fresh coin toss for every match.
   *
   * Both are drawn once, when the battle screen opens, and the host is the one
   * whose draw counts online -- it sends the two numbers and the guest builds
   * the identical match from them.
   */
  const [matchKey, setMatchKey] = useState(0);
  useEffect(() => {
    if (view === 'game') setMatchKey((n) => n + 1);
  }, [view]);
  const session = useMemo(() => ({ seed: randomSeed(), first: coinFlip() }), [matchKey]);

  const buy = useCallback(
    (index: number) => {
      const price = SHIPS[index].price;
      if (owned.includes(index) || coins < price) return false;
      setCoins((c) => c - price);
      setOwned((o) => [...o, index]);
      audioService.playPop();
      return true;
    },
    [owned, coins],
  );

  const pickOnline = useCallback(
    async (index: number) => {
      if (!uid) return;
      if (!owned.includes(index) && !buy(index)) return;
      try {
        // Already loaded by the session effect on this path; the import cache
        // makes this a lookup rather than a second fetch.
        const { db, doc, updateDoc } = await import('./firebase');
        await updateDoc(doc(db, 'lobbies', handoff.room), { [`players.${uid}.fishIndex`]: index });
      } catch (e) {
        console.error('Could not save your ship', e);
      }
    },
    [uid, owned, buy, handoff.room],
  );

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      await updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: true });
    } catch (e) {
      console.error('Could not start the battle', e);
    }
  }, [isHost, handoff.room]);

  const award = useCallback((won: boolean, hpLeft: number) => {
    // Something for turning up, more for winning, and a bonus for coming
    // through it with your hull mostly intact.
    setCoins((c) => c + (won ? 95 : 30) + (won ? Math.round(hpLeft / 3) : 0));
  }, []);

  /**
   * Leaving the battle, online: back to the room, and, for the host, the
   * go-signal comes down with it.
   *
   * `matchStarted` was never reset anywhere in the two games before this one,
   * and it broke a rematch two different ways: pressing Start again did
   * nothing, because true to true is not a change the effect above reacts to,
   * while picking a *different* ship was a change, so it launched a battle
   * nobody had started. Resetting it here, on the way out, also covers the
   * host quitting mid-match, which is what the platform's own End Game does.
   */
  const leaveBattle = useCallback(() => {
    setView(online ? 'room' : 'menu');
    if (!online || !isHost) return;
    void import('./firebase')
      .then(({ db, doc, updateDoc }) => updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: false }))
      .catch((e) => console.error('Could not reset the match flag', e));
  }, [online, isHost, handoff.room]);

  // -- into the battle --------------------------------------------------------

  if (view === 'game') {
    const config = online && uid ? onlineConfig() : offlineConfig();
    return (
      <>
        <BattleView
          config={config}
          settings={settings}
          onOpenSettings={() => setShowSettings(true)}
          onExit={leaveBattle}
          onResult={award}
        />
        {showSettings && (
          <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
        )}
      </>
    );
  }

  /**
   * An empty seat gets a bot.
   *
   * A lobby with one person in it -- the platform's solo mode, or simply being
   * first into the room -- must still be a battle. The other two games shipped
   * with a version of this that only filled a *partly* full match, so a room
   * of one started with nothing on the other side at all.
   */
  function onlineConfig(): MatchConfig {
    // `mode=single` is the platform saying this player pressed its own Solo
    // button. It should mean a bot even in the moment before the roster
    // settles, rather than a battle that depends on how fast a snapshot
    // arrived.
    const opponent = handoff.solo ? undefined : people.find((p) => p.uid !== uid);
    const seats: [Seat, Seat] = [
      seatFor(0, opponent, myTeam),
      seatFor(1, opponent, myTeam),
    ];
    return {
      roomId: handoff.room,
      uid,
      peerUid: opponent?.uid ?? null,
      isHost,
      seats,
      localTeams: [myTeam],
      aiLevel,
      seed: session.seed,
      first: session.first,
    };
  }

  function seatFor(team: Team, opponent: { uid: string; displayName: string; skin?: number | null } | undefined, mine: Team): Seat {
    if (team === mine) {
      return {
        team,
        id: uid ?? 'me',
        name: handoff.displayName || 'You',
        control: 'local',
        aiLevel,
        skin: mySkin ?? FREE_SHIPS[0],
      };
    }
    if (opponent) {
      return {
        team,
        id: opponent.uid,
        name: opponent.displayName,
        control: 'remote',
        aiLevel,
        skin: opponent.skin ?? pickOtherShip(mySkin ?? FREE_SHIPS[0]),
      };
    }
    return {
      team,
      id: 'bot',
      name: `${TIERS[aiLevel].label} Bot`,
      control: 'ai',
      aiLevel,
      skin: pickOtherShip(mySkin ?? FREE_SHIPS[0]),
    };
  }

  function offlineConfig(): MatchConfig {
    const p1 = seatSkin[0] ?? FREE_SHIPS[0];
    const seats: [Seat, Seat] = [
      { team: 0, id: 'seat-0', name: seatCount > 1 ? 'Player 1' : 'You', control: 'local', aiLevel, skin: p1 },
      seatCount > 1
        ? { team: 1, id: 'seat-1', name: 'Player 2', control: 'local', aiLevel, skin: seatSkin[1] ?? pickOtherShip(p1) }
        : { team: 1, id: 'bot', name: `${TIERS[aiLevel].label} Bot`, control: 'ai', aiLevel, skin: pickOtherShip(p1) },
    ];
    return {
      roomId: null,
      uid: null,
      peerUid: null,
      isHost: true,
      seats,
      localTeams: seatCount > 1 ? [0, 1] : [0],
      aiLevel,
      seed: session.seed,
      first: session.first,
    };
  }

  // -- shells -----------------------------------------------------------------

  const openOffline = (players: number) => {
    audioService.unlock();
    setSeatCount(players);
    setSeatSkin({});
    setView('pick');
  };

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden text-white">
      {(view === 'menu' || view === 'offline_menu') && (
        <Menu
          coins={coins}
          aiLevel={aiLevel}
          onAiLevel={setAiLevel}
          onSolo={() => openOffline(1)}
          onCouch={() => openOffline(2)}
          onSettings={() => setShowSettings(true)}
          onBack={view === 'offline_menu' ? () => setView('room') : undefined}
        />
      )}

      {view === 'pick' && (
        <OfflinePick
          seatCount={seatCount}
          owned={owned}
          coins={coins}
          onBack={() => setView(online ? 'offline_menu' : 'menu')}
          onBuy={buy}
          onDone={(picks) => {
            setSeatSkin(picks);
            setView('game');
          }}
        />
      )}

      {view === 'room' && (
        <RoomScreen
          ready={authChecked}
          error={lobbyError}
          uid={uid}
          people={people}
          hostId={lobby?.hostId ?? null}
          mine={mySkin}
          owned={owned}
          coins={coins}
          isHost={isHost}
          onPick={pickOnline}
          onStart={startMatch}
          onSettings={() => setShowSettings(true)}
          onFullscreen={() => toggleFullscreen(document.documentElement, !document.fullscreenElement)}
          onPlayOffline={() => {
            audioService.unlock();
            setView('offline_menu');
          }}
        />
      )}

      {showSettings && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

/** The bot sails something other than what the player picked. */
function pickOtherShip(playerChoice: number) {
  const options = FREE_SHIPS.filter((i) => i !== playerChoice);
  return options[Math.floor(Math.random() * options.length)] ?? 0;
}

// -- pieces -------------------------------------------------------------------

function Menu({
  coins,
  aiLevel,
  onAiLevel,
  onSolo,
  onCouch,
  onSettings,
  onBack,
}: {
  coins: number;
  aiLevel: number;
  onAiLevel: (n: number) => void;
  onSolo: () => void;
  onCouch: () => void;
  onSettings: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto overscroll-contain p-6">
      {onBack && (
        <div className="absolute left-4 top-4">
          <button onClick={onBack} aria-label="Back" className="panel rounded-2xl p-3">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>
      )}

      <div className="text-center">
        <div className="mb-4 inline-block rounded-3xl bg-amber-400/20 p-4">
          <Anchor className="h-12 w-12 text-amber-300" />
        </div>
        <h1 className="text-4xl font-black leading-none tracking-tighter drop-shadow-lg sm:text-6xl">
          BATTLE OF <span className="text-amber-300">PIRATES</span>
        </h1>
        <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.3em] text-white/70">Aim, swipe, sink</p>
      </div>

      <div className="panel w-full max-w-md space-y-5 rounded-[2rem] p-6">
        <button
          onClick={onSolo}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 py-4 text-lg font-black text-slate-900 transition-transform active:scale-95"
        >
          <Play className="h-5 w-5 fill-current" /> Solo - you against the bot
        </button>

        <div className="space-y-2">
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-white/50">Bot rank</p>
          <div className="flex gap-1 rounded-xl bg-black/30 p-1">
            {TIERS.map((tier, i) => (
              <button
                key={tier.label}
                onClick={() => onAiLevel(i)}
                className={`flex-1 rounded-lg py-2 text-xs font-black uppercase tracking-wider transition-colors ${
                  aiLevel === i ? 'bg-amber-400 text-slate-900' : 'text-white/60'
                }`}
              >
                {tier.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={onCouch}
          className="w-full rounded-2xl border border-white/25 bg-white/10 py-4 font-black transition-colors hover:bg-white/20"
        >
          Two captains, one device
          <span className="mt-1 block text-[11px] font-bold normal-case tracking-normal text-white/50">
            Turns alternate. Whoever is up drags and lets go.
          </span>
        </button>

        <div className="rounded-2xl bg-black/25 p-3 text-center text-xs leading-relaxed text-white/50">
          <p className="mb-1 font-black uppercase tracking-[0.15em] text-white/40">How it works</p>
          <p>Drag back from anywhere and let go. Further back is more powder; the angle is the angle.</p>
          <p className="mt-1">Read the wind, pick a card, and put a hole in the other hull first.</p>
          <p className="mt-2 text-white/40">
            Playing online? Start a lobby on PlayBuddies and pick this game. Two ships, one stretch of water.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="panel flex items-center gap-2 rounded-2xl px-4 py-3 font-bold text-amber-300">
          <Coins className="h-5 w-5" /> {coins}
        </div>
        <button onClick={onSettings} aria-label="Settings" className="panel rounded-2xl p-3">
          <SettingsIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

/** A ship card, drawn with the same code the battle uses. */
function Portrait({ index, size = 92 }: { index: number; size?: number }) {
  const ref = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, size, size);
      drawShip(ctx, {
        skin: index,
        x: size * 0.5,
        y: size * 0.84,
        facing: 1,
        accent: 'rgba(255,255,255,0.35)',
        aim: -0.55,
        lean: -0.05,
        flash: 0,
        clock: 0,
        scale: size / 390,
      });
    },
    [index, size],
  );
  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

function ShipGrid({
  owned,
  coins,
  selected,
  takenBy,
  onPick,
}: {
  owned: number[];
  coins: number;
  selected: number | null;
  takenBy: Record<number, string>;
  onPick: (index: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {SHIPS.map((ship, index) => {
        const isOwned = owned.includes(index);
        const taken = takenBy[index];
        const isSelected = selected === index;
        const affordable = coins >= ship.price;

        return (
          <button
            key={ship.name}
            onClick={() => onPick(index)}
            disabled={Boolean(taken) || (!isOwned && !affordable)}
            className={`relative flex flex-col items-center gap-1.5 overflow-hidden rounded-2xl border p-3 text-center transition-colors ${
              taken
                ? 'cursor-not-allowed border-rose-400/40 opacity-40'
                : isSelected
                  ? 'border-amber-400 bg-amber-400/20 shadow-[0_0_0_3px_rgba(251,191,36,0.25)]'
                  : isOwned
                    ? 'border-white/15 bg-white/10 hover:bg-white/20'
                    : 'border-amber-400/40 bg-amber-400/10'
            }`}
          >
            {!isOwned && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[1px]">
                <Lock className="mb-0.5 h-4 w-4 text-amber-300" />
                <span className="text-[11px] font-black text-amber-300">{ship.price}</span>
                {!affordable && <span className="text-[9px] font-bold text-rose-300">not enough</span>}
              </div>
            )}
            <Portrait index={index} />
            <span className="text-sm font-black uppercase tracking-wide">{ship.name}</span>
            {/*
              No stat bars, because there are no stats. Three identical full
              bars on every card would imply a choice that does not exist, and
              hinting at one is worse than saying plainly that these are paint.
            */}
            <span className="rounded-lg bg-black/25 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.15em] text-white/45">
              Paint only
            </span>
            <span className="text-[10px] leading-tight text-white/50">{ship.blurb}</span>
            {taken && <span className="text-[9px] font-black uppercase text-rose-300">{taken}</span>}
            {isSelected && (
              <span className="flex items-center gap-1 text-[10px] font-black text-amber-300">
                <Check className="h-3 w-3" /> picked
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Shell({
  title,
  coins,
  onBack,
  children,
}: {
  title: string;
  coins: number;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-3 p-3 sm:gap-4 sm:p-6">
      {/* Reachable while embedded via "Play offline", so the whole row clears
          the host's floating bar rather than just the coin badge: the three
          sit on one baseline and staggering them reads as broken. */}
      <div className={`flex shrink-0 items-center justify-between gap-2 ${IN_IFRAME ? 'mt-14' : ''}`}>
        <button onClick={onBack} aria-label="Back" className="panel shrink-0 rounded-2xl p-3">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="min-w-0 truncate text-center text-base font-black tracking-tight sm:text-2xl">{title}</h2>
        <div className="panel flex shrink-0 items-center gap-2 rounded-2xl px-3 py-2 font-bold text-amber-300">
          <Coins className="h-4 w-4" /> {coins}
        </div>
      </div>
      {/* Explicit min-h-0 is what lets the child actually scroll instead of
          growing the flex column past the viewport. */}
      <div className="panel min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-[2rem] p-3 sm:p-6">
        {children}
      </div>
    </div>
  );
}

function OfflinePick({
  seatCount,
  owned,
  coins,
  onBack,
  onBuy,
  onDone,
}: {
  seatCount: number;
  owned: number[];
  coins: number;
  onBack: () => void;
  onBuy: (index: number) => boolean;
  onDone: (picks: Record<number, number>) => void;
}) {
  const [picks, setPicks] = useState<Record<number, number>>({});
  const seat = Object.keys(picks).length;

  const takenBy = useMemo(() => {
    const map: Record<number, string> = {};
    Object.entries(picks).forEach(([id, index]) => {
      map[index] = `P${Number(id) + 1}`;
    });
    return map;
  }, [picks]);

  const pick = (index: number) => {
    if (!owned.includes(index) && !onBuy(index)) return;
    const next = { ...picks, [seat]: index };
    setPicks(next);
    if (Object.keys(next).length >= seatCount) onDone(next);
  };

  const title = seatCount > 1 ? `Player ${seat + 1} - pick a ship` : 'Pick your ship';
  return (
    <Shell title={title} coins={coins} onBack={onBack}>
      <ShipGrid owned={owned} coins={coins} selected={null} takenBy={takenBy} onPick={pick} />
    </Shell>
  );
}

function RoomScreen({
  ready,
  error,
  uid,
  people,
  hostId,
  mine,
  owned,
  coins,
  isHost,
  onPick,
  onStart,
  onSettings,
  onFullscreen,
  onPlayOffline,
}: {
  ready: boolean;
  error: string | null;
  uid: string | null;
  people: { uid: string; displayName: string; skin?: number | null; team: Team }[];
  hostId: string | null;
  mine: number | null | undefined;
  owned: number[];
  coins: number;
  isHost: boolean;
  onPick: (index: number) => void;
  onStart: () => void;
  onSettings: () => void;
  onFullscreen: () => void;
  onPlayOffline: () => void;
}) {
  const takenBy = useMemo(() => {
    const map: Record<number, string> = {};
    for (const p of people) {
      if (p.uid !== uid && p.skin !== undefined && p.skin !== null) map[p.skin] = p.displayName;
    }
    return map;
  }, [people, uid]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-2xl font-black">{error}</h2>
        <p className="text-sm text-white/60">Head back to the PlayBuddies lobby and try again.</p>
      </div>
    );
  }

  if (!ready || !uid) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-amber-300" />
        <p className="font-bold text-white/80">Coming alongside...</p>
      </div>
    );
  }

  const iAmReady = mine !== undefined && mine !== null;
  const soloRoom = people.length < 2;

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-3 p-3 sm:gap-4 sm:p-6">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-black tracking-tight sm:text-2xl">Pick your ship</h2>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-300/80">
            {soloRoom ? 'A bot will take the other helm' : '1v1 across open water'}
          </p>
        </div>
        {/*
          Embedded, PlayBuddies floats its own Invite / Full screen / End Game
          bar over this same corner at a z-index we cannot reach from inside
          the frame, so this row has to start below it.
        */}
        <div className={`flex shrink-0 items-center gap-2 ${IN_IFRAME ? 'mt-14' : ''}`}>
          <div className="panel flex items-center gap-2 rounded-2xl px-3 py-2 font-bold text-amber-300">
            <Coins className="h-4 w-4" /> {coins}
          </div>
          {!IN_IFRAME && (
            <button onClick={onFullscreen} className="panel rounded-2xl p-2.5" title="Full screen">
              <Maximize2 className="h-5 w-5" />
            </button>
          )}
          <button onClick={onSettings} aria-label="Settings" className="panel rounded-2xl p-2.5">
            <SettingsIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* On a phone the start button would otherwise sit below the fold, which
          is exactly what made it unreachable in the other games. */}
      <div className="panel shrink-0 rounded-2xl p-3 lg:hidden">
        {isHost ? (
          <button
            onClick={onStart}
            disabled={!iAmReady}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 py-3 text-base font-black text-slate-900 disabled:opacity-40"
          >
            <Play className="h-5 w-5 fill-current" /> WEIGH ANCHOR
          </button>
        ) : (
          <p className="text-center text-sm font-bold text-white/60">
            {iAmReady ? 'Waiting for the host...' : 'Pick a ship to be ready.'}
          </p>
        )}
        <button
          onClick={onPlayOffline}
          className="mt-2 w-full rounded-xl border border-white/20 bg-white/5 py-2.5 text-sm font-black text-white/70 transition-colors hover:bg-white/15"
        >
          Play offline
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-3 sm:gap-4 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
        <div className="panel order-2 min-h-0 overflow-y-auto overscroll-contain rounded-[2rem] p-3 sm:p-6 lg:order-1 lg:col-span-2">
          <ShipGrid owned={owned} coins={coins} selected={mine ?? null} takenBy={takenBy} onPick={onPick} />
        </div>

        <div className="order-1 flex min-h-0 flex-col gap-3 sm:gap-4 lg:order-2">
          <div className="panel flex max-h-44 min-h-0 flex-col rounded-[2rem] p-4 sm:p-5 lg:max-h-none lg:flex-1">
            <h3 className="mb-3 flex shrink-0 items-center gap-2 text-[11px] font-black uppercase tracking-[0.2em] text-white/50">
              <Users className="h-4 w-4" /> On the water ({people.length})
            </h3>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1">
              {people.map((p) => (
                <div
                  key={p.uid}
                  className="flex items-center gap-3 rounded-2xl border p-2.5"
                  style={{
                    borderColor: `${TEAM_COLORS[p.team].main}55`,
                    background: `${TEAM_COLORS[p.team].main}18`,
                  }}
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black/25">
                    {p.skin !== undefined && p.skin !== null ? (
                      <Portrait index={p.skin} size={42} />
                    ) : (
                      <Anchor className="h-5 w-5 text-white/40" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1 truncate text-sm font-bold">
                      {p.displayName}
                      {p.uid === hostId && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
                    </p>
                    <p
                      className="text-[10px] font-black uppercase tracking-widest"
                      style={{ color: TEAM_COLORS[p.team].light }}
                    >
                      {TEAM_COLORS[p.team].name}
                      {p.uid === uid ? ' - you' : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel hidden shrink-0 rounded-[2rem] p-5 lg:block">
            {isHost ? (
              <>
                <button
                  onClick={onStart}
                  disabled={!iAmReady}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 py-4 text-lg font-black text-slate-900 disabled:opacity-40"
                >
                  <Play className="h-5 w-5 fill-current" /> WEIGH ANCHOR
                </button>
                <p className="mt-2 text-center text-[11px] text-white/50">
                  {!iAmReady
                    ? 'Pick your own ship first.'
                    : soloRoom
                      ? 'A bot will sail the other hull.'
                      : 'Who fires first is drawn at the start.'}
                </p>
              </>
            ) : (
              <p className="text-center text-sm font-bold text-white/60">
                {!iAmReady ? 'Pick a ship to be ready.' : 'Waiting for the host...'}
              </p>
            )}
            <button
              onClick={onPlayOffline}
              className="mt-3 w-full rounded-2xl border border-white/20 bg-white/5 py-3 font-black text-white/60 transition-colors hover:bg-white/15"
            >
              Play offline
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  onClose: () => void;
}) {
  const toggles: { key: keyof GameSettings; label: string; hint: string }[] = [
    { key: 'aimGuide', label: 'Aim guide', hint: 'Shows the first stretch of the arc. Off is the harder game.' },
    { key: 'turnTimer', label: 'Turn clock', hint: 'Fires on its own after 30 seconds. Takes effect next battle.' },
    { key: 'obstacles', label: 'Rocks', hint: 'Stone in the water between the ships. Takes effect next battle.' },
    {
      key: 'lowPower',
      label: 'Low power mode',
      hint: 'Forces the cheap render path. The game already drops to it on its own when frames get long.',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-6 overflow-y-auto overscroll-contain rounded-[2rem] p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-black">Settings</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-white/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        {(['bgmVolume', 'sfxVolume'] as const).map((key) => (
          <div key={key} className="space-y-1">
            <div className="flex justify-between text-sm font-bold">
              <span>{key === 'bgmVolume' ? 'Sea and surf' : 'Effects'}</span>
              <span>{Math.round(settings[key] * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={settings[key]}
              onChange={(e) => onChange({ ...settings, [key]: parseFloat(e.target.value) })}
              className="w-full accent-amber-400"
            />
          </div>
        ))}

        {toggles.map(({ key, label, hint }) => (
          <label key={key} className="flex items-center justify-between gap-3">
            <span className="text-sm font-bold">
              {label}
              <span className="block text-[11px] font-normal text-white/50">{hint}</span>
            </span>
            <input
              type="checkbox"
              checked={Boolean(settings[key])}
              onChange={(e) => onChange({ ...settings, [key]: e.target.checked })}
              className="h-6 w-6 shrink-0 accent-amber-400"
            />
          </label>
        ))}
      </div>
    </div>
  );
}
