import { useCallback, useEffect, useMemo, useState } from 'react';
import { scrimProps, useEscape } from '@shared/ui/dismiss';
import { ArrowLeft, Coins, Loader2, LogOut, Maximize2, Settings as SettingsIcon } from 'lucide-react';
import { askHostToEndGame, askToLeaveLobby, isNativeFullscreen, toggleFullscreen, useAutoFullscreen } from './fullscreen';
import { MainMenu } from '@shared/menu/MainMenu';
import { MENU_STAGE_FIELD, parseStage } from '@shared/menu/stage';
import type { MenuStage } from '@shared/menu/stage';
import { FISH_ASSETS, STARTER_FISH, fishSrc } from './game/fish';
import { GameSettings } from './types/game';
import GameView, { LobbyPerson } from './screens/GameView';
import CustomizeScreen from './screens/CustomizeScreen';
import type { FishSlot } from './screens/CustomizeScreen';
import ModesScreen from './screens/ModesScreen';
import type { ReefMember } from './screens/ModesScreen';
import FishGrid from './components/FishGrid';
import { THEME } from './screens/menuTheme';
import { audioService } from './services/audio';
import { GameWallet, reportResult, reportRun } from './platform/wallet';

/**
 * The platform owns the lobby.
 *
 * This game used to ship its own Firebase project, its own Google sign-in, its
 * own room codes and its own waiting room , none of which knew anything about
 * the PlayWithBuddies lobby that launched it. Everything here now reads the room it
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

const DEFAULT_SETTINGS: GameSettings = { bgmVolume: 0.4, sfxVolume: 0.7, controlScheme: 0, lowPower: false, mouseFollow: true };

/** Everything before the reef is one of the shared menu stages; see `stage` in App. */
type View = 'shell' | 'game';

/** GameSettings.controlScheme, by name. Seat N at one keyboard steers with the (N + scheme)th. */
const KEY_LAYOUTS = ['WASD', 'Arrows', 'IJKL'];

export default function App() {
  const [handoff] = useState(readHandoff);
  const online = Boolean(handoff.room);

  const [view, setView] = useState<View>('shell');
  useAutoFullscreen(online || view === 'game');
  /** The stage for a flow this device runs alone. Online, the lobby's `menuStage` is the one that counts. */
  const [localStage, setLocalStage] = useState<MenuStage>('menu');
  const [showSettings, setShowSettings] = useState(false);
  const [showShop, setShowShop] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [lobby, setLobby] = useState<{ hostId: string; players: Record<string, LobbyPerson & { isReady?: boolean }>; friendlyFish?: boolean; matchStarted?: boolean; menuStage?: string } | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  const [seatCount, setSeatCount] = useState(1);
  const [seatFish, setSeatFish] = useState<Record<string, number>>({});
  /**
   * The player deliberately asked for an offline run.
   *
   * Launched from a lobby this screen used to be unreachable altogether , the
   * view opened straight on the room and the only way to the shared-keyboard
   * menu was to not be in a lobby at all. The room now offers it, and this flag
   * is what keeps the choice: without it the branch below still handed the
   * engine a single online seat, so players two and three drove nothing.
   */
  const [offlineMatch, setOfflineMatch] = useState(false);
  /** Friendly Fish for a run at one keyboard. Online, the lobby's `friendlyFish` is the one that counts. */
  const [localFriendly, setLocalFriendly] = useState(false);

  /**
   * The purse belongs to the account, not to this browser.
   *
   * localStorage is read first so the shop is never blank while the handshake
   * with PlayWithBuddies is in flight, and written on every change so the game
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
  // The SDK is 826 KB , more than three times the rest of this game put
  // together , and a solo run never makes a single call into it. Statically
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
          const data = snap.data() as { hostId: string; players: Record<string, LobbyPerson>; friendlyFish?: boolean; matchStarted?: boolean; menuStage?: string };
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
    else if (view === 'game') setView('shell');
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
        const { db, doc, updateDoc } = await import('./firebase');
        await updateDoc(doc(db, 'lobbies', handoff.room), { [`players.${uid}.fishIndex`]: index });
      } catch (e) {
        console.error('Could not save fish choice', e);
      }
    },
    [uid, unlocked, coins, handoff.room],
  );

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    // Already flying: a host who inherited the room mid-match (the old host
    // left) just swims back in. true -> true would not reach the effect above.
    if (lobby?.matchStarted) {
      setView('game');
      return;
    }
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      await updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: true });
    } catch (e) {
      console.error('Could not start the match', e);
    }
  }, [isHost, lobby?.matchStarted, handoff.room]);

  const buy =(index: number) => {
    const price = FISH_ASSETS[index].price;
    if (unlocked.includes(index) || coins < price) return;
    setCoins((c) => c - price);
    setUnlocked((u) => [...u, index]);
  };

  const awardCoins = useCallback((score: number) => {
    setCoins((c) => c + Math.floor(score / 8));
    // A life ending is a run for the daily challenge, not a match on the record.
    reportRun({ score });
  }, []);

  /**
   * Leaving the water: back to the match page (Stage 3), and online , for the
   * host , the go-signal comes down with it.
   *
   * `matchStarted` was never reset anywhere after being set, so a "Back to
   * lobby" round-trip was broken: the room screen's transition to 'game' is
   * driven by `matchStarted && myFish`, and re-pressing "start" is a true ->
   * true no-op, while picking a *different* fish is a real change to
   * `myFish` , so it fired off a match nobody had started, with the stale
   * flag still set from the last one.
   *
   * Resetting it here rather than only on some notion of "the round ended"
   * also covers the host leaving mid-match: fish has no discrete win/lose
   * moment (death is per-player, not global), so this is the one place every
   * exit path , the defeat screen's "Back to lobby" and a premature host
   * quit alike , actually passes through.
   */
  const leaveWater = useCallback(() => {
    // Back to the match page either way, ready for another go. Offline that
    // is this device's own stage; online the room is still on it.
    setView('shell');
    if (offlineMatch) {
      setLocalStage('modes');
      return;
    }
    if (!online || !isHost) return;
    void import('./firebase')
      .then(({ db, doc, updateDoc }) => updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: false }))
      .catch((e) => console.error('Could not reset the match flag', e));
  }, [online, isHost, offlineMatch, handoff.room]);

  /** Host only: a room-wide change, from moving everyone to the next stage to the Friendly Fish rule. */
  const writeLobby = useCallback(
    async (fields: Record<string, string | number | boolean>) => {
      if (!online || !isHost) return;
      try {
        const { db, doc, updateDoc } = await import('./firebase');
        await updateDoc(doc(db, 'lobbies', handoff.room), fields);
      } catch (e) {
        console.error('Could not update the room', e);
      }
    },
    [online, isHost, handoff.room],
  );

  // ── the pre-match flow ───────────────────────────────────────────────────
  //
  // Title screen, fish, match rules. Online the host writes the stage into the
  // lobby (`menuStage`) and every client renders whatever it says; solo, at one
  // keyboard, or opened on its own, the stage lives on this device alone.
  const local = !online || offlineMatch;
  const remoteStage = parseStage(lobby?.menuStage);
  const iAmReady = myFish !== undefined && myFish !== null;
  /**
   * Nobody sits on the match page without a fish. A guest who has none , they
   * arrived late, or were still choosing when the host moved on , keeps the
   * picker until they do, and if a match is already running, picking one is
   * what takes them into it (the `matchStarted` effect above).
   */
  const lateJoin = !local && remoteStage === 'modes' && !isHost && !iAmReady;
  const stage: MenuStage = local ? localStage : lateJoin ? 'customize' : remoteStage;
  const goStage = (next: MenuStage) => {
    if (local) setLocalStage(next);
    else void writeLobby({ [MENU_STAGE_FIELD]: next });
  };

  // The shop is a detour off the title screen. When the room moves on, a
  // guest still browsing it moves on with everyone else.
  useEffect(() => setShowShop(false), [stage]);

  const openOffline = (players: number) => {
    setOfflineMatch(true);
    setSeatCount(players);
    setSeatFish({});
    setLocalStage('customize');
  };

  const closeOffline = () => {
    setOfflineMatch(false);
    setLocalStage('menu');
  };

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
          friendlyFish={netPlay ? lobby?.friendlyFish === true : seatCount > 1 && localFriendly}
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

  // ── the menu stages ──────────────────────────────────────────────────────
  //
  // A fixed height with the scrolling done *inside* each screen. The root used
  // to be `min-h-[100dvh] overflow-y-auto`, which grows with its content rather
  // than scrolling it , and since index.css sets `body { overflow: hidden }`,
  // anything past the fold was simply unreachable. That is why the start button
  // could not be tapped on a phone.
  const hostName = lobby ? lobby.players?.[lobby.hostId]?.displayName : undefined;
  const fullscreen = () => toggleFullscreen(document.documentElement, !isNativeFullscreen());
  const coinChip = (
    <div className="glass-dark flex items-center gap-1.5 rounded-2xl px-3 py-2.5 font-bold text-amber-600 short:py-2">
      <Coins className="h-4 w-4" /> {coins}
    </div>
  );
  const toolButton = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <button onClick={onClick} aria-label={label} title={label} className="glass-dark rounded-2xl p-2.5 short:p-2">
      {icon}
    </button>
  );
  /** Stages 2 and 3. The balance matters while picking (a locked fish is bought on tap), less once picked. */
  const stageToolbar = (coinsOnPhone: boolean) => (
    <>
      <div className={coinsOnPhone ? '' : 'hidden sm:block'}>{coinChip}</div>
      {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
      {toolButton('Settings', <SettingsIcon className="h-5 w-5" />, () => setShowSettings(true))}
      {!local && isHost && toolButton('End the match for everyone', <LogOut className="h-5 w-5" />, askHostToEndGame)}
    </>
  );

  let screen: React.ReactNode;
  if (showShop) {
    screen = (
      <Shell title="Fish Shop" coins={coins} onBack={() => setShowShop(false)}>
        <FishGrid unlocked={unlocked} coins={coins} onPick={buy} selected={null} pickedBy={{}} mode="shop" />
      </Shell>
    );
  } else if (!local && lobbyError) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-6 text-center">
        <h2 className="text-2xl font-black">{lobbyError}</h2>
        <p className="text-sm text-slate-600">Head back to the PlayWithBuddies lobby and try again.</p>
      </div>
    );
  } else if (!local && (!authChecked || !uid || !lobby)) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-emerald-600" />
        <p className="font-bold text-slate-700">Joining the reef…</p>
      </div>
    );
  } else if (stage === 'menu') {
    screen = (
      <MainMenu
        theme={THEME}
        online={online}
        isHost={isHost}
        hostName={hostName}
        onSingle={() => openOffline(1)}
        onMulti={online && !handoff.solo ? () => goStage('customize') : undefined}
        onSettings={() => setShowSettings(true)}
        singleHint="Just you and the reef"
        multiHint={`Everyone in this room · ${people.length} ${people.length === 1 ? 'player' : 'players'}`}
        toolbar={
          <>
            {coinChip}
            <button onClick={() => setShowShop(true)} className="glass-dark rounded-2xl px-3 py-2.5 font-bold short:py-2">
              Shop
            </button>
            {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
            {toolButton('Leave', <LogOut className="h-5 w-5" />, askToLeaveLobby)}
          </>
        }
        title={
          <>
            <div className="mb-3 flex items-end justify-center gap-4 short:hidden" aria-hidden>
              {[10, 21, 29].map((index, i) => (
                <img
                  key={index}
                  src={fishSrc(index)}
                  alt=""
                  className="animate-float h-12 w-auto drop-shadow-lg sm:h-16"
                  style={{ animationDelay: `${i * -2}s` }}
                />
              ))}
            </div>
            <h1 className="text-4xl font-black leading-none tracking-tighter sm:text-6xl short:text-3xl">
              GO EAT <span className="text-emerald-500">FISH</span>
            </h1>
            <p className="mt-2 text-xs font-bold uppercase tracking-[0.3em] text-slate-600">Grow or get eaten</p>
          </>
        }
        secondary={
          <div className="rounded-2xl border border-black/10 bg-white/40 p-2.5 short:p-1.5">
            <p className="text-center text-[11px] font-black text-slate-600">Share one keyboard</p>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {[2, 3].map((n) => (
                <button
                  key={n}
                  onClick={() => openOffline(n)}
                  disabled={online && !isHost}
                  className="rounded-xl border border-emerald-500/30 bg-emerald-600/15 py-2 text-sm font-black text-emerald-700 transition-colors enabled:hover:bg-emerald-500 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-40 short:py-1.5"
                >
                  {n} players
                </button>
              ))}
            </div>
          </div>
        }
        footer={
          <p className="max-w-md text-center text-[11px] leading-relaxed text-slate-600 short:hidden">
            Steer with WASD or the arrow keys, point with the mouse, or drag anywhere on a touchscreen. Sharing one
            keyboard? Game Settings picks who gets which keys.
            {!online && ' Playing online? Start a lobby on PlayWithBuddies and pick this game.'}
          </p>
        }
      />
    );
  } else if (stage === 'customize') {
    const slots: FishSlot[] = local
      ? Array.from({ length: seatCount }, (_, i) => ({
          key: `seat-${i}`,
          label: seatCount > 1 ? `Player ${i + 1}` : 'You',
          fish: seatFish[`seat-${i}`],
          editable: true,
        }))
      : people.map((p) => ({
          key: p.uid,
          label: p.displayName,
          fish: p.fishIndex,
          editable: p.uid === uid,
          isHost: p.uid === lobby?.hostId,
        }));
    screen = (
      <CustomizeScreen
        key={local ? `seats-${seatCount}` : 'room'}
        slots={slots}
        role={local ? 'local' : isHost ? 'host' : 'guest'}
        unlocked={unlocked}
        coins={coins}
        toolbar={stageToolbar(true)}
        hostName={hostName}
        lateJoin={lateJoin ? (lobby?.matchStarted ? 'underway' : 'setup') : undefined}
        onPick={(key, index) => {
          if (!local) return void pickFishOnline(index);
          if (!unlocked.includes(index)) {
            if (coins < FISH_ASSETS[index].price) return;
            buy(index);
          }
          setSeatFish((s) => ({ ...s, [key]: index }));
        }}
        onBack={local ? closeOffline : isHost ? () => goStage('menu') : undefined}
        onNext={() => goStage('modes')}
      />
    );
  } else {
    const kind: 'room' | 'solo' | 'couch' = !local ? 'room' : seatCount > 1 ? 'couch' : 'solo';
    const members: ReefMember[] = local
      ? Array.from({ length: seatCount }, (_, i) => ({
          key: `seat-${i}`,
          name: seatCount > 1 ? `Player ${i + 1}` : 'You',
          fish: seatFish[`seat-${i}`],
          keys: seatCount > 1 ? KEY_LAYOUTS[(i + settings.controlScheme) % KEY_LAYOUTS.length] : undefined,
        }))
      : people.map((p) => ({
          key: p.uid,
          name: p.displayName,
          fish: p.fishIndex,
          you: p.uid === uid,
          host: p.uid === lobby?.hostId,
        }));
    const waiting = members.filter((m) => m.fish === undefined || m.fish === null).length;
    const underway = !local && lobby?.matchStarted === true;
    let action: { label: string; onClick: () => void; disabled?: boolean } | undefined;
    let note: string;
    if (local) {
      action = { label: 'Dive in', onClick: () => setView('game') };
      note =
        kind === 'couch'
          ? 'Everyone steers with the keys by their name. Dragging on a touchscreen steers Player 1.'
          : 'Every fish starts the same size. Grow by eating.';
    } else if (isHost) {
      action = { label: underway ? 'Dive back in' : 'Dive in', onClick: () => void startMatch(), disabled: !iAmReady };
      note = !iAmReady
        ? 'Pick your fish first: go back a step.'
        : waiting > 0
          ? `${waiting} still choosing. They can dive in once they pick.`
          : 'Everyone is ready!';
    } else if (underway && iAmReady) {
      // A guest who left a match still running: the reef has no finish line, so they can go straight back.
      action = { label: 'Dive back in', onClick: () => setView('game') };
      note = 'A match is underway in this room.';
    } else {
      note = `${hostName || 'The host'} starts the match when everyone is ready.`;
    }
    screen = (
      <ModesScreen
        kind={kind}
        locked={!local && !isHost}
        hostName={hostName}
        underway={underway}
        toolbar={stageToolbar(false)}
        members={members}
        friendlyFish={local ? localFriendly : lobby?.friendlyFish === true}
        onFriendlyFish={(value) => {
          if (local) return setLocalFriendly(value);
          // The lobby field is the rule itself: every guest's locked copy of this page reads it back live.
          if (!isHost || lobby?.matchStarted) return;
          void writeLobby({ friendlyFish: value });
        }}
        onBack={local || isHost ? () => goStage('customize') : undefined}
        action={action}
        note={note}
      />
    );
  }

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden text-slate-900">
      {screen}

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
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-y-auto overscroll-contain gap-3 p-3 sm:gap-4 sm:p-6">
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

function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  onClose: () => void;
}) {
  // Escape closes it too. See @shared/ui/dismiss.
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-sky-950/60 p-4 backdrop-blur-sm">
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

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold">
            Follow the mouse
            <span className="block text-[11px] font-normal text-slate-500">
              Your fish swims toward the pointer. Any movement key takes over until the mouse moves again.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.mouseFollow}
            onChange={(e) => onChange({ ...settings, mouseFollow: e.target.checked })}
            className="h-6 w-6 shrink-0 accent-emerald-500"
          />
        </label>

        <div className="space-y-2">
          <span className="text-sm font-bold">Keyboard layout</span>
          <div className="flex gap-1 rounded-xl bg-black/5 p-1">
            {KEY_LAYOUTS.map((label, i) => (
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
            For sharing one keyboard: player one uses this set, extra players take the next ones. Playing
            alone or online, WASD and the arrows both work. On a touchscreen, drag anywhere to steer.
          </p>
        </div>
      </div>
    </div>
  );
}
