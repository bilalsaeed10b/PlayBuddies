import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Coins,
  Crown,
  Fish as FishIcon,
  Loader2,
  Lock,
  LogOut,
  Maximize2,
  Play,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react';
import { askHostToEndGame, toggleFullscreen } from './fullscreen';
import {
  FISH_ASSETS,
  FISH_CATEGORIES,
  STARTER_FISH,
  fishSrc,
} from './game/fish';
import { GameSettings } from './types/game';
import GameView, { LobbyPerson } from './screens/GameView';
import { audioService } from './services/audio';
import { GameWallet, reportResult } from './platform/wallet';

/**
 * The platform owns the lobby.
 *
 * This game used to ship its own Firebase project, its own Google sign-in, its
 * own room codes and its own waiting room — none of which knew anything about
 * the PlayBuddies lobby that launched it. Everything here now reads the room it
 * was handed in the query string and writes only its own slot in it.
 */
interface Handoff {
  room: string;
  displayName: string;
  /** The platform sets this when the player is alone and wants couch co-op. */
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
  // Clean the address bar so a copied link isn't a stale room handoff.
  if (room) window.history.replaceState({}, document.title, window.location.pathname);
  return handoff;
}

const DEFAULT_SETTINGS: GameSettings = { bgmVolume: 0.4, sfxVolume: 0.7, controlScheme: 0, lowPower: false };

type View = 'menu' | 'select' | 'room' | 'game' | 'shop';

export default function App() {
  const [handoff] = useState(readHandoff);
  const online = Boolean(handoff.room);

  const [view, setView] = useState<View>(online ? 'room' : 'menu');
  const [showSettings, setShowSettings] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [lobby, setLobby] = useState<{ hostId: string; players: Record<string, LobbyPerson & { isReady?: boolean }>; matchStarted?: boolean } | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);
  const [pickNotice, setPickNotice] = useState<string | null>(null);

  const [seatCount, setSeatCount] = useState(1);
  const [seatFish, setSeatFish] = useState<Record<string, number>>({});
  /**
   * The player deliberately asked for an offline run.
   *
   * Launched from a lobby this screen used to be unreachable altogether — the
   * view opened straight on the room and the only way to the shared-keyboard
   * menu was to not be in a lobby at all. The room now offers it, and this flag
   * is what keeps the choice: without it the branch below still handed the
   * engine a single online seat, so players two and three drove nothing.
   */
  const [offlineMatch, setOfflineMatch] = useState(false);

  /**
   * The purse belongs to the account, not to this browser.
   *
   * localStorage is read first so the shop is never blank while the handshake
   * with PlayBuddies is in flight, and written on every change so the game
   * still works opened on its own. It is a cache now rather than the record.
   */
  const wallet = useMemo(() => new GameWallet('players-eat-fish', 'fishy_unlocked'), []);
  const [coins, setCoins] = useState(() => wallet.current.coins);
  const [unlocked, setUnlocked] = useState<number[]>(() => [
    ...new Set([...wallet.current.unlocks, ...STARTER_FISH]),
  ]);
  /** Nothing is saved until the account has answered, or declined to. */
  const [walletReady, setWalletReady] = useState(false);

  useEffect(() => {
    wallet.open((purse) => {
      setCoins(purse.coins);
      setUnlocked([...new Set([...purse.unlocks, ...STARTER_FISH])]);
      setWalletReady(true);
    });
    return () => wallet.close();
  }, [wallet]);
  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('fishy_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  // Held back until the handshake settles: saving the placeholder balance the
  // moment the game booted would write a stale number straight over the real
  // one, which is how an account ends up back at zero.
  useEffect(() => {
    if (!walletReady) return;
    wallet.save({ coins, unlocks: unlocked });
  }, [walletReady, coins, unlocked, wallet]);
  useEffect(() => {
    localStorage.setItem('fishy_settings', JSON.stringify(settings));
    audioService.setVolumes(settings.bgmVolume, settings.sfxVolume);
  }, [settings]);

  // ── platform session ─────────────────────────────────────────────────────
  //
  // Firebase is imported dynamically, and only down the online path.
  //
  // The SDK is 826 KB — more than three times the rest of this game put
  // together — and a solo run never makes a single call into it. Statically
  // imported it was a `modulepreload` in the built HTML, so every player
  // downloaded all of it before the reef could appear. Now the chunk is only
  // fetched when there is actually a lobby to talk to.
  useEffect(() => {
    if (!online) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    // Same origin as the platform, so the player is already signed in; this
    // just picks the session up rather than asking them to log in twice.
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
          const data = snap.data() as { hostId: string; players: Record<string, LobbyPerson>; matchStarted?: boolean };
          if (!data.players?.[uid]) {
            setLobbyError("You're not in this lobby.");
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

  const people = useMemo<LobbyPerson[]>(
    () => Object.values(lobby?.players ?? {}).map((p) => ({
      uid: p.uid,
      displayName: p.displayName || 'Player',
      fishIndex: p.fishIndex,
    })),
    [lobby],
  );

  const myFish = uid ? lobby?.players?.[uid]?.fishIndex : undefined;
  const isHost = Boolean(uid && lobby && lobby.hostId === uid);

  // The host flips matchStarted; everyone drops into the water together.
  useEffect(() => {
    // An offline run is the player's own; the room does not get to start or end
    // it. This guard is also what stops an unrelated lobby update from bouncing
    // a shared-keyboard run straight back to the room.
    if (!online || offlineMatch) return;
    if (lobby?.matchStarted && myFish !== undefined && myFish !== null) setView('game');
    else if (view === 'game') setView('room');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.matchStarted, myFish, online, offlineMatch]);

  const pickFishOnline = useCallback(
    async (index: number) => {
      if (!uid) return;
      if (!unlocked.includes(index)) {
        if (coins < FISH_ASSETS[index].price) return;
        setCoins((c) => c - FISH_ASSETS[index].price);
        setUnlocked((u) => [...u, index]);
      }
      try {
        // Already loaded by the session effect on this path; the import cache
        // makes this a no-op lookup rather than a second fetch.
        const { db, doc, runTransaction } = await import('./firebase');
        const ref = doc(db, 'lobbies', handoff.room);
        // A plain `updateDoc` here raced: two players landing on the picker
        // at once could both write the same still-shown-as-open fish before
        // either's snapshot listener caught the other's pick. The transaction
        // re-reads the room at write time, so whichever write actually lands
        // second sees the seat is taken and backs off instead of silently
        // overlapping it.
        const taken = await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          const players = (snap.data()?.players ?? {}) as Record<string, LobbyPerson>;
          const holder = Object.entries(players).find(
            ([otherUid, p]) => otherUid !== uid && p.fishIndex === index,
          );
          if (holder) return holder[1].displayName || 'Someone';
          tx.update(ref, { [`players.${uid}.fishIndex`]: index });
          return null;
        });
        if (taken) setPickNotice(`${taken} just took that one — pick another.`);
      } catch (e) {
        console.error('Could not save fish choice', e);
      }
    },
    [uid, unlocked, coins, handoff.room],
  );

  useEffect(() => {
    if (!pickNotice) return;
    const id = window.setTimeout(() => setPickNotice(null), 2500);
    return () => window.clearTimeout(id);
  }, [pickNotice]);

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      await updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: true });
    } catch (e) {
      console.error('Could not start the match', e);
    }
  }, [isHost, handoff.room]);

  const buy = (index: number) => {
    const price = FISH_ASSETS[index].price;
    if (unlocked.includes(index) || coins < price) return;
    setCoins((c) => c - price);
    setUnlocked((u) => [...u, index]);
  };

  const awardCoins = useCallback((score: number) => {
    setCoins((c) => c + Math.floor(score / 8));
  }, []);

  /**
   * Leaving the water, online: back to the room, and — for the host — the
   * go-signal comes down with it.
   *
   * `matchStarted` was never reset anywhere after being set, so a "Back to
   * lobby" round-trip was broken: the room screen's transition to 'game' is
   * driven by `matchStarted && myFish`, and re-pressing "start" is a true ->
   * true no-op, while picking a *different* fish is a real change to
   * `myFish` — so it fired off a match nobody had started, with the stale
   * flag still set from the last one.
   *
   * Resetting it here rather than only on some notion of "the round ended"
   * also covers the host leaving mid-match: fish has no discrete win/lose
   * moment (death is per-player, not global), so this is the one place every
   * exit path — the defeat screen's "Back to lobby" and a premature host
   * quit alike — actually passes through.
   */
  const leaveWater = useCallback(() => {
    setOfflineMatch(false);
    setView(online ? 'room' : 'menu');
    if (!online || !isHost) return;
    void import('./firebase')
      .then(({ db, doc, updateDoc }) => updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: false }))
      .catch((e) => console.error('Could not reset the match flag', e));
  }, [online, isHost, handoff.room]);

  // ── in the water ─────────────────────────────────────────────────────────
  if (view === 'game') {
    const netPlay = online && uid && !offlineMatch;
    const localIds = netPlay ? [uid] : Array.from({ length: seatCount }, (_, i) => `seat-${i}`);
    const localFish = netPlay ? { [uid]: myFish ?? 0 } : seatFish;
    const localNames = netPlay
      ? { [uid]: handoff.displayName || 'You' }
      : Object.fromEntries(localIds.map((id, i) => [id, seatCount > 1 ? `Player ${i + 1}` : 'You']));

    return (
      <>
        <GameView
          roomId={netPlay ? handoff.room : null}
          uid={uid}
          hostId={lobby?.hostId ?? null}
          people={people}
          localIds={localIds}
          localFish={localFish}
          localNames={localNames}
          settings={settings}
          onOpenSettings={() => setShowSettings(true)}
          onExit={leaveWater}
          onRunEnded={awardCoins}
          onMatchOver={reportResult}
        />
        {showSettings && (
          <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
        )}
      </>
    );
  }

  // ── shells ───────────────────────────────────────────────────────────────
  //
  // A fixed height with the scrolling done *inside* each screen. The root used
  // to be `min-h-[100dvh] overflow-y-auto`, which grows with its content rather
  // than scrolling it — and since index.css sets `body { overflow: hidden }`,
  // anything past the fold was simply unreachable. That is why the start button
  // could not be tapped on a phone.
  return (
    <div className="relative h-[100dvh] w-full overflow-hidden text-slate-900">
      {view === 'shop' && (
        <Shell title="Fish Shop" coins={coins} onBack={() => setView(online ? 'room' : 'menu')}>
          <FishGrid
            unlocked={unlocked}
            coins={coins}
            onPick={buy}
            selected={null}
            takenBy={{}}
            mode="shop"
          />
        </Shell>
      )}

      {view === 'menu' && (
        <div className="flex h-full flex-col items-center justify-center gap-8 overflow-y-auto p-6">
          <div className="text-center">
            <div className="mb-4 inline-block rounded-3xl bg-emerald-500/15 p-4">
              <FishIcon className="h-14 w-14 text-emerald-600" />
            </div>
            <h1 className="text-6xl font-black tracking-tighter sm:text-7xl">
              FISH<span className="text-emerald-500">.EAT</span>
            </h1>
            <p className="mt-2 text-xs font-bold uppercase tracking-[0.3em] text-slate-600">
              Grow or get eaten
            </p>
          </div>

          <div className="glass-dark w-full max-w-md space-y-5 rounded-[2rem] p-8 text-center">
            <h2 className="text-2xl font-bold">Solo Hunt</h2>
            <p className="text-sm text-slate-600">
              Play alone, or share one keyboard with up to two friends.
            </p>
            <div className="flex justify-center gap-3">
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    setOfflineMatch(true);
                    setSeatCount(n);
                    setSeatFish({});
                    setView('select');
                  }}
                  className="rounded-xl border border-emerald-500/30 bg-emerald-600/15 px-6 py-3 font-bold text-emerald-700 transition-colors hover:bg-emerald-500 hover:text-white"
                >
                  {n}P
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              Playing online? Start a lobby on PlayBuddies and pick this game.
            </p>
            {online && (
              <button
                onClick={() => setView('room')}
                className="w-full rounded-xl border border-black/10 bg-white/50 py-2.5 text-sm font-bold text-slate-600 transition-colors hover:bg-white"
              >
                Back to the lobby
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="glass-dark flex items-center gap-2 rounded-2xl px-4 py-3 font-bold text-amber-600">
              <Coins className="h-5 w-5" /> {coins}
            </div>
            <button onClick={() => setView('shop')} className="glass-dark rounded-2xl px-4 py-3 font-bold">
              Shop
            </button>
            <button onClick={() => setShowSettings(true)} className="glass-dark rounded-2xl p-3">
              <SettingsIcon className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {view === 'select' && (
        <SoloSelect
          seatCount={seatCount}
          unlocked={unlocked}
          coins={coins}
          onBack={() => setView('menu')}
          onDone={(picks) => {
            setSeatFish(picks);
            setView('game');
          }}
          onBuy={buy}
        />
      )}

      {view === 'room' && (
        <RoomScreen
          ready={authChecked}
          error={lobbyError}
          uid={uid}
          people={people}
          hostId={lobby?.hostId ?? null}
          myFish={myFish}
          unlocked={unlocked}
          coins={coins}
          isHost={isHost}
          pickNotice={pickNotice}
          onPick={pickFishOnline}
          onStart={startMatch}
          onShop={() => setView('shop')}
          onSettings={() => setShowSettings(true)}
          onFullscreen={() => toggleFullscreen(document.documentElement, !document.fullscreenElement)}
          onPlayOffline={() => setView('menu')}
        />
      )}

      {showSettings && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

// ── shared pieces ──────────────────────────────────────────────────────────

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
      <div className="flex shrink-0 items-center justify-between gap-2">
        <button onClick={onBack} className="glass-dark shrink-0 rounded-2xl p-3">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="min-w-0 truncate text-center text-base font-black tracking-tight sm:text-2xl">{title}</h2>
        <div className="flex shrink-0 items-center gap-2 rounded-xl bg-amber-500/20 px-3 py-2 font-bold text-amber-600">
          <Coins className="h-4 w-4" /> {coins}
        </div>
      </div>
      <div className="glass-dark min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-[2rem] p-3 sm:p-6">
        {children}
      </div>
    </div>
  );
}

function FishGrid({
  unlocked,
  coins,
  onPick,
  selected,
  takenBy,
  mode,
}: {
  unlocked: number[];
  coins: number;
  onPick: (index: number) => void;
  selected: number | null;
  /** index → who already has it, so two players can't be the same fish. */
  takenBy: Record<number, string>;
  mode: 'shop' | 'pick';
}) {
  return (
    <div className="space-y-5">
      {FISH_CATEGORIES.map((category) => {
        const entries = FISH_ASSETS.map((fish, index) => ({ fish, index })).filter(
          (e) => e.fish.category === category,
        );
        if (!entries.length) return null;

        return (
          <section key={category} className="space-y-2">
            <h3 className="border-b border-black/10 pb-1.5 text-[10px] sm:text-[11px] font-black uppercase tracking-[0.2em] text-emerald-700/80">
              {category} class
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-3">
              {entries.map(({ fish, index }) => {
                const isUnlocked = unlocked.includes(index);
                const taken = takenBy[index];
                const isSelected = selected === index;
                const affordable = coins >= fish.price;

                return (
                  <button
                    key={index}
                    onClick={() => onPick(index)}
                    disabled={Boolean(taken) || (mode === 'shop' && (isUnlocked || !affordable))}
                    className={`relative flex flex-col items-center gap-1 overflow-hidden rounded-xl sm:rounded-2xl border p-1.5 sm:p-2 transition-all ${
                      taken
                        ? 'cursor-not-allowed border-rose-400/40 opacity-40'
                        : isSelected
                          ? 'border-emerald-500 bg-emerald-500/20 shadow-[0_0_0_3px_rgba(16,185,129,0.2)] scale-[1.02]'
                          : isUnlocked
                            ? 'border-black/10 bg-white/40 hover:bg-white/70 active:scale-95'
                            : 'border-amber-400/40 bg-amber-400/10'
                    }`}
                  >
                    {!isUnlocked && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/55 backdrop-blur-[1px]">
                        <Lock className="mb-0.5 h-3.5 w-3.5 text-amber-300" />
                        <span className="text-[9px] font-black text-amber-300">{fish.price}</span>
                      </div>
                    )}
                    <div className="flex h-11 sm:h-14 items-center justify-center">
                      <img
                        src={fishSrc(index)}
                        alt={fish.name}
                        loading="lazy"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <span className="w-full truncate text-center text-[9px] sm:text-[10px] font-bold uppercase tracking-wide">
                      {fish.name}
                    </span>
                    <span className="text-[9px] sm:text-[10px] font-bold text-slate-500">size {fish.size}</span>
                    {taken && (
                      <span className="w-full truncate text-[8px] sm:text-[9px] font-bold uppercase text-rose-500">{taken}</span>
                    )}
                    {mode === 'shop' && isUnlocked && (
                      <span className="flex items-center gap-1 text-[9px] sm:text-[10px] font-bold text-emerald-600">
                        <Check className="h-3 w-3" /> owned
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SoloSelect({
  seatCount,
  unlocked,
  coins,
  onBack,
  onDone,
  onBuy,
}: {
  seatCount: number;
  unlocked: number[];
  coins: number;
  onBack: () => void;
  onDone: (picks: Record<string, number>) => void;
  onBuy: (index: number) => void;
}) {
  const [picks, setPicks] = useState<Record<string, number>>({});
  const seat = Object.keys(picks).length;

  const takenBy = useMemo(() => {
    const map: Record<number, string> = {};
    Object.entries(picks).forEach(([id, index], i) => {
      map[index] = `Player ${Number(id.split('-')[1]) + 1 || i + 1}`;
    });
    return map;
  }, [picks]);

  const pick = (index: number) => {
    if (!unlocked.includes(index)) {
      onBuy(index);
      return;
    }
    const next = { ...picks, [`seat-${seat}`]: index };
    setPicks(next);
    if (Object.keys(next).length >= seatCount) onDone(next);
  };

  return (
    <Shell title={`Player ${seat + 1}: pick a fish`} coins={coins} onBack={onBack}>
      <FishGrid unlocked={unlocked} coins={coins} onPick={pick} selected={null} takenBy={takenBy} mode="pick" />
    </Shell>
  );
}

function RoomScreen({
  ready,
  error,
  uid,
  people,
  hostId,
  myFish,
  unlocked,
  coins,
  isHost,
  pickNotice,
  onPick,
  onStart,
  onShop,
  onSettings,
  onFullscreen,
  onPlayOffline,
}: {
  ready: boolean;
  error: string | null;
  uid: string | null;
  people: LobbyPerson[];
  hostId: string | null;
  myFish: number | undefined;
  unlocked: number[];
  coins: number;
  isHost: boolean;
  pickNotice: string | null;
  onPick: (index: number) => void;
  onStart: () => void;
  onShop: () => void;
  onSettings: () => void;
  onFullscreen: () => void;
  onPlayOffline: () => void;
}) {
  const takenBy = useMemo(() => {
    const map: Record<number, string> = {};
    for (const p of people) {
      if (p.uid !== uid && p.fishIndex !== undefined && p.fishIndex !== null) {
        map[p.fishIndex] = p.displayName;
      }
    }
    return map;
  }, [people, uid]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-6 text-center">
        <h2 className="text-2xl font-black">{error}</h2>
        <p className="text-sm text-slate-600">Head back to the PlayBuddies lobby and try again.</p>
      </div>
    );
  }

  if (!ready || !uid) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-emerald-600" />
        <p className="font-bold text-slate-700">Joining the reef…</p>
      </div>
    );
  }

  const everyonePicked = people.every((p) => p.fishIndex !== undefined && p.fishIndex !== null);
  const iAmReady = myFish !== undefined && myFish !== null;

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-2 p-2 sm:gap-4 sm:p-5">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="min-w-0 truncate text-base font-black tracking-tight sm:text-2xl">Pick your fish</h2>
          {myFish !== undefined && myFish !== null && (
            <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
              <Check className="h-3 w-3" /> Ready
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <button onClick={onShop} className="glass-dark flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs sm:text-sm font-bold text-amber-600">
            <Coins className="h-4 w-4" /> {coins}
          </button>
          <button onClick={onFullscreen} className="glass-dark rounded-xl p-2" title="Full screen">
            <Maximize2 className="h-4 w-4 sm:h-5 sm:w-5" />
          </button>
          <button onClick={onSettings} className="glass-dark rounded-xl p-2">
            <SettingsIcon className="h-4 w-4 sm:h-5 sm:w-5" />
          </button>
          {isHost && (
            <button onClick={askHostToEndGame} className="glass-dark rounded-xl p-2" title="End the match for everyone">
              <LogOut className="h-4 w-4 sm:h-5 sm:w-5" />
            </button>
          )}
        </div>
      </div>

      {pickNotice && (
        <p className="shrink-0 rounded-xl border border-rose-400/40 bg-rose-400/10 px-3 py-1.5 text-center text-xs font-bold text-rose-600">
          {pickNotice}
        </p>
      )}

      {/* Main Grid: Responsive for Portrait and Landscape */}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-3 landscape:grid-cols-3 gap-2 sm:gap-4">
        {/* Fish Picker */}
        <div className="glass-dark min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl md:rounded-[2rem] landscape:rounded-[2rem] p-2.5 sm:p-5 md:col-span-2 landscape:col-span-2">
          <FishGrid
            unlocked={unlocked}
            coins={coins}
            onPick={onPick}
            selected={myFish ?? null}
            takenBy={takenBy}
            mode="pick"
          />
        </div>

        {/* Players & Action Column */}
        <div className="flex min-h-0 flex-col gap-2 sm:gap-3 md:col-span-1 landscape:col-span-1">
          {/* Players List */}
          <div className="glass-dark flex min-h-0 flex-1 flex-col rounded-2xl md:rounded-[2rem] landscape:rounded-[2rem] p-3 sm:p-4">
            <h3 className="mb-2 flex shrink-0 items-center gap-1.5 text-[10px] sm:text-[11px] font-black uppercase tracking-[0.2em] text-slate-500">
              <Users className="h-3.5 w-3.5" /> In the water ({people.length})
            </h3>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain pr-0.5">
              {people.map((p) => (
                <div key={p.uid} className="flex items-center gap-2.5 rounded-xl border border-black/5 bg-white/40 p-2 sm:p-2.5">
                  <div className="flex h-8 w-8 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-lg border border-black/10 bg-white/60 p-1">
                    {p.fishIndex !== undefined && p.fishIndex !== null ? (
                      <img src={fishSrc(p.fishIndex)} alt="" className="max-h-full max-w-full object-contain" />
                    ) : (
                      <FishIcon className="h-4 w-4 text-slate-400" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1 truncate text-xs sm:text-sm font-bold">
                      {p.displayName}
                      {p.uid === hostId && <Crown className="h-3 w-3 shrink-0 text-amber-500" />}
                    </p>
                    <p className="text-[9px] sm:text-[10px] font-bold uppercase tracking-widest text-slate-500">
                      {p.uid === uid ? 'You' : p.fishIndex !== undefined && p.fishIndex !== null ? 'Ready' : 'Choosing…'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Action Button */}
          <div className="glass-dark shrink-0 rounded-2xl md:rounded-[2rem] landscape:rounded-[2rem] p-2.5 sm:p-4">
            {isHost ? (
              <>
                <button
                  onClick={onStart}
                  disabled={!iAmReady}
                  className="flex w-full items-center justify-center gap-2 rounded-xl sm:rounded-2xl bg-emerald-600 py-2.5 sm:py-3.5 text-sm sm:text-base font-black text-white shadow-lg transition-transform active:scale-95 disabled:opacity-40"
                >
                  <Play className="h-4 w-4 sm:h-5 sm:w-5 fill-current" /> DIVE IN
                </button>
                <p className="mt-1.5 text-center text-[10px] text-slate-500">
                  {!iAmReady
                    ? 'Pick your fish first.'
                    : everyonePicked
                      ? 'Everyone is ready!'
                      : 'You can dive in now or wait for others.'}
                </p>
              </>
            ) : (
              <div className="text-center py-1">
                <p className="text-xs sm:text-sm font-bold text-slate-600">
                  {!iAmReady ? '👉 Pick a fish above' : '⏳ Waiting for host to start…'}
                </p>
              </div>
            )}
            {/* Sharing one keyboard is a legitimate way to play this while
                sitting in a lobby, and until now the lobby was a dead end. */}
            <button
              onClick={onPlayOffline}
              className="mt-2 w-full rounded-xl border border-black/10 bg-white/40 py-2 text-[11px] sm:text-xs font-bold text-slate-600 transition-colors hover:bg-white"
            >
              Play offline / one keyboard
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-sky-950/60 p-4 backdrop-blur-sm">
      <div className="max-h-[88dvh] w-full max-w-md space-y-6 overflow-y-auto overscroll-contain rounded-[2rem] border border-white/30 bg-white/95 p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-black">Settings</h3>
          <button onClick={onClose} className="rounded-xl p-2 hover:bg-black/5">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        {(['bgmVolume', 'sfxVolume'] as const).map((key) => (
          <div key={key} className="space-y-1">
            <div className="flex justify-between text-sm font-bold">
              <span>{key === 'bgmVolume' ? 'Music' : 'Effects'}</span>
              <span>{Math.round(settings[key] * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={settings[key]}
              onChange={(e) => onChange({ ...settings, [key]: parseFloat(e.target.value) })}
              className="w-full accent-emerald-500"
            />
          </div>
        ))}

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold">
            Low power mode
            <span className="block text-[11px] font-normal text-slate-500">
              Smaller canvas, fewer bubbles. Turn this on if the reef stutters.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.lowPower}
            onChange={(e) => onChange({ ...settings, lowPower: e.target.checked })}
            className="h-6 w-6 shrink-0 accent-emerald-500"
          />
        </label>

        <div className="space-y-2">
          <span className="text-sm font-bold">Keyboard layout</span>
          <div className="flex gap-1 rounded-xl bg-black/5 p-1">
            {['WASD', 'Arrows', 'IJKL'].map((label, i) => (
              <button
                key={label}
                onClick={() => onChange({ ...settings, controlScheme: i })}
                className={`flex-1 rounded-lg py-2 text-xs font-black uppercase tracking-wider transition-colors ${
                  settings.controlScheme === i ? 'bg-emerald-500 text-white' : 'text-slate-500'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">
            Player one uses this set; extra players on the same keyboard take the next ones. On a
            touchscreen, drag anywhere to steer.
          </p>
        </div>
      </div>
    </div>
  );
}
