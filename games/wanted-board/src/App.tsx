import { useCallback, useEffect, useMemo, useState } from 'react';
import { scrimProps, useEscape } from '@shared/ui/dismiss';
import {
  ArrowLeft,
  Check,
  Coins,
  Crown,
  Loader2,
  Lock,
  LogOut,
  Maximize2,
  Play,
  ScrollText,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react';
import { askHostToEndGame, askToLeaveLobby, isNativeFullscreen, toggleFullscreen, useAutoFullscreen } from './fullscreen';
import { MainMenu } from '@shared/menu/MainMenu';
import { ActionBar, HostBadge, StageFrame } from '@shared/menu/StageFrame';
import { OptionGroup, RuleSection, ToggleOption } from '@shared/menu/MatchControls';
import { MENU_STAGE_FIELD, parseStage } from '@shared/menu/stage';
import type { MenuStage } from '@shared/menu/stage';
import type { MenuTheme } from '@shared/menu/theme';
import { FREE_OUTLAWS, OUTLAWS } from './game/outlaws';
import useShortScreen from '@shared/ui/useShortScreen';
import OutlawToken from './components/OutlawToken';
import { BALANCE, BANK, CARDS, CARD_GLYPH, CARD_ORDER, PLACES, ROADS, SEAT_COLORS } from './game/rules';
import { TIERS } from './engine/ai';
import { audioService } from './services/audio';
import { GameWallet, reportResult } from './platform/wallet';
import MatchView from './screens/MatchView';
import type { MatchConfig } from './screens/MatchView';
import type { Seat } from './engine/WantedEngine';
import { DEFAULT_RULES, PLAYER_CODES, TARGET_CHOICES, packRules, unpackRules } from './types/game';
import { createLogger } from '@shared/log/logger';
import type { GameSettings, MatchRules, PlayerCount } from './types/game';

const log = createLogger('wanted-board');

/**
 * The platform owns the lobby.
 *
 * This game never shows a login screen and never asks for a room code. It
 * reads the room it was handed in the query string, writes only its own slot
 * in it, and lets PlayWithBuddies decide who is in the game.
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
  if (room) window.history.replaceState({}, document.title, window.location.pathname);
  return handoff;
}

const DEFAULT_SETTINGS: GameSettings = { sfxVolume: 0.7, hints: true };

/** Everything before the game is one of the shared menu stages; see `stage` in App. */
type View = 'shell' | 'game';

const THEME: MenuTheme = {
  tone: 'light',
  primary: 'bg-rose-800 text-amber-50',
  selected: 'border-rose-700 bg-rose-100',
  accent: 'text-rose-800',
};

interface LobbyPerson {
  uid: string;
  displayName: string;
  /** The lobby's per-player slot. Fish Eat Fish named it and every game since reuses it. */
  fishIndex?: number | null;
}

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;

/**
 * The bot rank used for any seat this device fills in an online room.
 *
 * The tier picker on the match page is only ever reached offline, so it really
 * means "how hard should the practice bot be". Letting that leak into online
 * rooms is how a player who once tried Marshal ends up playing friends
 * alongside merciless fill-in bots.
 */
const ONLINE_AI_LEVEL = 1;

export default function App() {
  const [handoff] = useState(readHandoff);
  const online = Boolean(handoff.room);

  const [view, setView] = useState<View>('shell');
  /** The stage for a flow this device runs alone. Online, the lobby's `menuStage` is the one that counts. */
  const [localStage, setLocalStage] = useState<MenuStage>('menu');
  useAutoFullscreen(online || view === 'game');
  const [showSettings, setShowSettings] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [lobby, setLobby] = useState<{
    hostId: string;
    players: Record<string, LobbyPerson>;
    matchStarted?: boolean;
    matchRules?: number;
    matchSeed?: number;
    menuStage?: string;
  } | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  const [seatCount, setSeatCount] = useState(1);
  const [seatSkin, setSeatSkin] = useState<Record<number, number>>({});
  const [offlineMatch, setOfflineMatch] = useState(false);
  const [aiLevel, setAiLevel] = useState(1);

  const wallet = useMemo(() => new GameWallet('wanted-board', 'wanted_owned'), []);
  const [coins, setCoins] = useState(() => wallet.current.coins);
  const [owned, setOwned] = useState<number[]>(() => [...new Set([...wallet.current.unlocks, ...FREE_OUTLAWS])]);
  const [walletReady, setWalletReady] = useState(false);

  useEffect(() => {
    wallet.open((purse) => {
      setCoins(purse.coins);
      setOwned([...new Set([...purse.unlocks, ...FREE_OUTLAWS])]);
      setWalletReady(true);
    });
    return () => wallet.close();
  }, [wallet]);

  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('wanted_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  const [rules, setRules] = useState<MatchRules>(() => {
    const saved = localStorage.getItem('wanted_rules');
    return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : DEFAULT_RULES;
  });
  useEffect(() => {
    localStorage.setItem('wanted_rules', JSON.stringify(rules));
  }, [rules]);

  useEffect(() => {
    if (!walletReady) return;
    wallet.save({ coins, unlocks: owned });
  }, [walletReady, coins, owned, wallet]);

  useEffect(() => {
    localStorage.setItem('wanted_settings', JSON.stringify(settings));
    audioService.setVolume(settings.sfxVolume);
  }, [settings]);

  // -- platform session -------------------------------------------------------

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
            matchRules?: number;
            matchSeed?: number;
            menuStage?: string;
          };
          if (!data.players?.[uid]) {
            setLobbyError('You are not in this lobby.');
            return;
          }
          setLobbyError(null);
          log.context({ room: handoff.room, who: handoff.displayName || undefined });
          log.info('lobby:snapshot', {
            hostId: data.hostId,
            iAmHost: data.hostId === uid,
            players: Object.keys(data.players ?? {}).length,
            matchStarted: Boolean(data.matchStarted),
            matchRules: data.matchRules,
            matchSeed: data.matchSeed,
          });
          setLobby(data);
          // The host's terms, arriving on the one channel every client already
          // listens to. Without this a guest seats the table by its own idea of
          // the player count and builds a different town , compared against
          // `data.hostId` rather than the `isHost` variable, which still holds
          // the *previous* snapshot inside this same callback.
          if (typeof data.matchRules === 'number' && data.hostId !== uid) {
            setRules(unpackRules(data.matchRules));
          }
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
   * Who is playing, in a fixed order every client derives the same way.
   *
   * Sorted by uid rather than by arrival, because arrival order differs
   * between clients and the seat index is what the whole wire protocol is
   * addressed by. Keep the complete room here: slicing by a locally saved
   * player count before the host starts is how real people became bot seats.
   */
  const people = useMemo(() => {
    return Object.values(lobby?.players ?? {})
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .slice(0, PLAYER_CODES[PLAYER_CODES.length - 1])
      .map((p) => ({ uid: p.uid, displayName: p.displayName || 'Player', skin: p.fishIndex }));
  }, [lobby?.players]);

  const mySkin = uid ? lobby?.players?.[uid]?.fishIndex : undefined;
  const isHost = Boolean(uid && lobby && lobby.hostId === uid);
  const stampedRules = typeof lobby?.matchRules === 'number' ? unpackRules(lobby.matchRules) : null;
  const activeRules = lobby?.matchStarted && stampedRules ? stampedRules : rules;

  /** Host only: any room-wide change, from moving the flow on to publishing the rules. */
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

  const remoteStage = parseStage(lobby?.menuStage);

  /**
   * The rules go to the room the moment the host changes them on the match
   * page, not only with the start signal, so every guest's locked copy of that
   * page shows what the host is actually choosing while they choose it.
   */
  useEffect(() => {
    if (!online || offlineMatch || !isHost || remoteStage !== 'modes' || !lobby) return;
    const packed = packRules(rules);
    if (lobby.matchRules !== packed) void writeLobby({ matchRules: packed });
  }, [online, offlineMatch, isHost, remoteStage, lobby, rules, writeLobby]);

  /**
   * The host's chosen player count follows the room, not the other way round.
   *
   * This follows the room in both directions. A remembered four-player game
   * must become a duel after two people leave; online matches never pad the
   * connected crew with bots from an old setting.
   */
  useEffect(() => {
    if (!online || offlineMatch || !isHost || !lobby) return;
    const roomSize = Object.keys(lobby.players ?? {}).length;
    const fits = PLAYER_CODES.find((n) => n >= roomSize) ?? PLAYER_CODES[PLAYER_CODES.length - 1];
    if (fits !== rules.players) setRules((r) => ({ ...r, players: fits }));
  }, [online, offlineMatch, isHost, lobby, rules.players]);

  useEffect(() => {
    if (!online || offlineMatch) return;
    if (lobby?.matchStarted && mySkin !== undefined && mySkin !== null) setView('game');
    else if (view === 'game') setView('shell');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.matchStarted, mySkin, online, offlineMatch]);

  const [session, setSession] = useState(() => ({ seed: randomSeed() }));
  const rollSession = useCallback(() => setSession({ seed: randomSeed() }), []);

  const buy = useCallback(
    (index: number) => {
      const price = OUTLAWS[index].price;
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
        const { db, doc, updateDoc } = await import('./firebase');
        await updateDoc(doc(db, 'lobbies', handoff.room), { [`players.${uid}.fishIndex`]: index });
      } catch (e) {
        console.error('Could not save your outlaw', e);
      }
    },
    [uid, owned, buy, handoff.room],
  );

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    const players = PLAYER_CODES.find((n) => n >= people.length) ?? PLAYER_CODES[PLAYER_CODES.length - 1];
    const startRules = { ...rules, players };
    const matchSeed = randomSeed();
    setRules(startRules);
    setSession({ seed: matchSeed });
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      // The rules ride along in the same write as the go-signal, so they land
      // in every guest's snapshot at the same instant `matchStarted` does.
      await updateDoc(doc(db, 'lobbies', handoff.room), {
        matchStarted: true,
        matchRules: packRules(startRules),
        matchSeed,
      });
    } catch (e) {
      console.error('Could not start the game', e);
    }
  }, [isHost, handoff.room, people.length, rules]);

  const award = useCallback((won: boolean, banked: number) => {
    setCoins((c) => c + (won ? 95 : 30) + Math.round(banked / 25));
    reportResult(won);
  }, []);

  /**
   * Leaving the game: back to the match page for another round, and, online,
   * the host's go-signal comes down with it.
   */
  const leaveMatch = useCallback(() => {
    setView('shell');
    rollSession();
    if (offlineMatch) {
      setLocalStage('modes');
      return;
    }
    if (!online || !isHost) return;
    void writeLobby({ matchStarted: false });
  }, [online, isHost, offlineMatch, rollSession, writeLobby]);

  const rosterKey = people.map((person) => `${person.uid}:${person.skin ?? ''}`).join('|');
  // While waiting, every roster update rebuilds the preview config. Once the
  // host starts, the shared seed and packed rules become the immutable match
  // identity, so a later presence write cannot replace seats mid-game.
  const onlineMatchKey = lobby?.matchStarted
    ? `started:${lobby.matchSeed ?? session.seed}:${lobby.matchRules ?? ''}`
    : `waiting:${rosterKey}`;
  const matchConfig = useMemo(
    () =>
      online && uid && !offlineMatch
        ? onlineConfig(activeRules, lobby?.matchSeed ?? session.seed)
        : offlineConfig(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.seed, offlineMatch, uid, onlineMatchKey],
  );

  // -- into the game ----------------------------------------------------------

  if (view === 'game') {
    // Frozen to match identity, not recomputed live: MatchView reads config
    // fields like seat team every frame, and a live roster reorder mid-round
    // (reconnect, late write) would otherwise flip them under a running game.
    const config = matchConfig;
    return (
      <>
        <MatchView
          config={config}
          settings={settings}
          onOpenSettings={() => setShowSettings(true)}
          onExit={leaveMatch}
          onResult={award}
        />
        {showSettings && (
          <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
        )}
      </>
    );
  }

  function onlineConfig(matchRules: MatchRules, matchSeed: number): MatchConfig {
    const crew = handoff.solo ? people.filter((p) => p.uid === uid) : people;
    const seats: Seat[] = [];
    const localSeats: number[] = [];

    for (let i = 0; i < matchRules.players; i++) {
      const person = crew[i];
      if (person && person.uid === uid) {
        localSeats.push(i);
        seats.push({
          id: uid ?? 'me',
          name: handoff.displayName || 'You',
          control: 'local',
          aiLevel: ONLINE_AI_LEVEL,
          skin: mySkin ?? FREE_OUTLAWS[0],
        });
      } else if (person) {
        seats.push({
          id: person.uid,
          name: person.displayName,
          control: 'remote',
          aiLevel: ONLINE_AI_LEVEL,
          skin: person.skin ?? otherOutlaw(mySkin ?? FREE_OUTLAWS[0], i),
        });
      } else {
        seats.push({
          id: `bot-${i}`,
          name: `${TIERS[ONLINE_AI_LEVEL].label} ${i + 1}`,
          control: 'ai',
          aiLevel: ONLINE_AI_LEVEL,
          skin: otherOutlaw(mySkin ?? FREE_OUTLAWS[0], i),
        });
      }
    }

    return {
      roomId: handoff.room,
      uid,
      peerUids: crew.filter((p) => p.uid !== uid).map((p) => p.uid),
      isHost,
      seats,
      localSeats,
      seed: matchSeed,
      rules: matchRules,
    };
  }

  function offlineConfig(): MatchConfig {
    const p1 = seatSkin[0] ?? FREE_OUTLAWS[0];
    const seats: Seat[] = [];
    const localSeats: number[] = [];

    for (let i = 0; i < rules.players; i++) {
      if (i < seatCount) {
        localSeats.push(i);
        seats.push({
          id: `seat-${i}`,
          name: seatCount > 1 ? `Player ${i + 1}` : 'You',
          control: 'local',
          aiLevel,
          skin: seatSkin[i] ?? (i === 0 ? p1 : otherOutlaw(p1, i)),
        });
      } else {
        seats.push({
          id: `bot-${i}`,
          name: `${TIERS[aiLevel].label} ${i + 1}`,
          control: 'ai',
          aiLevel,
          skin: otherOutlaw(p1, i),
        });
      }
    }

    return {
      roomId: null,
      uid: null,
      peerUids: [],
      isHost: true,
      seats,
      localSeats,
      seed: session.seed,
      rules,
    };
  }

  const openOffline = (players: number) => {
    audioService.unlock();
    rollSession();
    setOfflineMatch(true);
    setSeatCount(players);
    setSeatSkin({});
    // A couch game needs at least a seat each; a solo game keeps whatever the
    // match page is set to.
    if (players > rules.players) setRules((r) => ({ ...r, players: players as PlayerCount }));
    setLocalStage('customize');
  };

  const closeOffline = () => {
    setOfflineMatch(false);
    setLocalStage('menu');
  };

  // -- the shell --------------------------------------------------------------

  /** Solo, couch, or a game opened on its own: the flow lives on this device alone. */
  const local = !online || offlineMatch;
  const stage: MenuStage = local ? localStage : remoteStage;
  const goStage = (next: MenuStage) => {
    if (local) setLocalStage(next);
    else void writeLobby({ [MENU_STAGE_FIELD]: next });
  };
  const hostName = lobby ? lobby.players?.[lobby.hostId]?.displayName : undefined;
  const fullscreen = () => toggleFullscreen(document.documentElement, !isNativeFullscreen());

  const coinChip = (
    <div className="panel flex items-center gap-1.5 rounded-2xl px-3 py-2.5 font-bold text-amber-800 short:py-2">
      <Coins className="h-4 w-4" /> {coins}
    </div>
  );
  const toolButton = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <button onClick={onClick} aria-label={label} title={label} className="panel rounded-2xl p-2.5 short:p-2">
      {icon}
    </button>
  );
  const stageToolbar = (
    <>
      <span className="hidden sm:block">{coinChip}</span>
      {toolButton('The rules', <ScrollText className="h-5 w-5 text-rose-800" />, () => setShowGuide(true))}
      {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
      {toolButton('Settings', <SettingsIcon className="h-5 w-5" />, () => setShowSettings(true))}
      {!local && isHost && toolButton('End the game for everyone', <LogOut className="h-5 w-5" />, askHostToEndGame)}
    </>
  );

  let screen: React.ReactNode;
  if (!local && lobbyError) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-2xl font-black text-amber-950">{lobbyError}</h2>
        <p className="text-sm text-amber-900/60">Head back to the PlayWithBuddies lobby and try again.</p>
      </div>
    );
  } else if (!local && (!authChecked || !uid || !lobby)) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-rose-800" />
        <p className="font-bold text-amber-900/70">Riding into town…</p>
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
        singleHint="You against the bots"
        multiHint={`Everyone in this room · ${people.length} in town`}
        toolbar={
          <>
            {coinChip}
            {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
            {toolButton('Leave', <LogOut className="h-5 w-5" />, askToLeaveLobby)}
          </>
        }
        title={
          <>
            <p className="text-[10px] font-black uppercase tracking-[0.4em] text-amber-900/50 short:hidden">
              Reward offered for
            </p>
            <h1 className="text-5xl font-black leading-none tracking-tighter text-amber-950 sm:text-7xl short:text-3xl">
              WANTED
            </h1>
            <p className="mt-1 text-xs font-black uppercase tracking-[0.3em] text-rose-800">Dead or in debt</p>
          </>
        }
        secondary={
          <>
            <button
              onClick={() => openOffline(2)}
              disabled={online && !isHost}
              className="w-full rounded-2xl border border-black/10 bg-white/60 py-2.5 text-sm font-black text-amber-950 transition-colors hover:bg-white disabled:opacity-40 short:py-1.5"
            >
              Two on one device
              <span className="block text-[10px] font-bold text-amber-900/50 short:hidden">
                You pass the phone. Nobody peeks.
              </span>
            </button>
            {/* Loud on purpose , cards are picked in secret and money is on the
                line, and a small "Rules" button is easy to never notice at all. */}
            <button
              onClick={() => setShowGuide(true)}
              className="relative flex w-full items-center gap-3 overflow-hidden rounded-2xl border-2 border-rose-700 bg-rose-100 px-4 py-3 text-left shadow-[0_4px_16px_rgba(190,18,60,0.18)] transition-transform active:scale-[0.99] short:py-1.5"
            >
              <span className="absolute -right-6 -top-6 h-16 w-16 animate-pulse rounded-full bg-rose-700/20" aria-hidden />
              <ScrollText className="h-6 w-6 shrink-0 text-rose-800 short:h-5 short:w-5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-black uppercase tracking-wide text-rose-900">New in town? Read the rules</p>
                <p className="text-[11px] font-bold text-rose-800/70 short:hidden">If you want to win, it's worth a minute.</p>
              </div>
            </button>
          </>
        }
        footer={
          <p className="max-w-md text-center text-[11px] leading-relaxed text-amber-900/50 short:hidden">
            Everybody picks a card in secret and they all flip at once. Your bounty climbs while you run, but it is
            only yours once you have banked it.
          </p>
        }
      />
    );
  } else if (stage === 'customize') {
    const slots: OutlawSlot[] = local
      ? Array.from({ length: seatCount }, (_, i) => ({
          key: String(i),
          label: seatCount > 1 ? `Player ${i + 1}` : 'You',
          skin: seatSkin[i],
          editable: true,
        }))
      : people.map((p) => ({
          key: p.uid,
          label: p.displayName,
          skin: p.skin,
          editable: p.uid === uid,
          isHost: p.uid === lobby?.hostId,
        }));
    screen = (
      <CustomizeScreen
        slots={slots}
        owned={owned}
        coins={coins}
        toolbar={stageToolbar}
        leads={local || isHost}
        hostName={hostName}
        onPick={(key, index) => {
          if (!local) return void pickOnline(index);
          if (!owned.includes(index) && !buy(index)) return;
          setSeatSkin((s) => ({ ...s, [Number(key)]: index }));
        }}
        onBack={local ? closeOffline : isHost ? () => goStage('menu') : undefined}
        onNext={() => goStage('modes')}
      />
    );
  } else {
    const humans = local ? seatCount : people.length;
    const bots = Math.max(0, rules.players - humans);
    const roster: TownMember[] = local
      ? Array.from({ length: rules.players }, (_, i) => ({
          key: `seat-${i}`,
          name: i < seatCount ? (seatCount > 1 ? `Player ${i + 1}` : 'You') : `${TIERS[aiLevel].label} ${i + 1}`,
          skin: i < seatCount ? seatSkin[i] : undefined,
          bot: i >= seatCount,
          you: i === 0,
        }))
      : [
          ...people.map((p) => ({
            key: p.uid,
            name: p.displayName,
            skin: p.skin,
            you: p.uid === uid,
            host: p.uid === lobby?.hostId,
          })),
          ...Array.from({ length: bots }, (_, i) => ({
            key: `bot-${i}`,
            name: `${TIERS[ONLINE_AI_LEVEL].label} ${people.length + i + 1}`,
            bot: true,
          })),
        ];
    const everyonePicked = people.every((p) => p.skin !== undefined && p.skin !== null);
    const iAmReady = mySkin !== undefined && mySkin !== null;
    const waitingFor = people.filter((p) => p.skin === undefined || p.skin === null).length;
    screen = (
      <ModesScreen
        rules={rules}
        locked={!local && !isHost}
        local={local}
        hostName={hostName}
        toolbar={stageToolbar}
        roster={roster}
        seatCount={seatCount}
        bots={bots}
        onRules={setRules}
        aiLevel={aiLevel}
        onAiLevel={local && bots > 0 ? setAiLevel : undefined}
        onGuide={() => setShowGuide(true)}
        onBack={local || isHost ? () => goStage('customize') : undefined}
        onStart={
          local
            ? () => {
                audioService.unlock();
                setView('game');
              }
            : isHost
              ? startMatch
              : undefined
        }
        startDisabled={!local && !everyonePicked}
        startNote={
          !local && !isHost
            ? !iAmReady
              ? 'Pick a face to be ready.'
              : `${hostName || 'The host'} rides out when the town is set.`
            : !local && !everyonePicked
              ? `Waiting on ${waitingFor} more to pick a face.`
              : bots > 0
                ? `Bots ride ${bots} of the ${rules.players} horses. Everyone picks a card in secret.`
                : 'Everyone picks a card in secret, and they all flip at once.'
        }
      />
    );
  }

  return (
    <div className="game-surface relative h-[100dvh] w-full overflow-hidden">
      {screen}

      {showSettings && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
      )}
      {showGuide && <GuidePanel onClose={() => setShowGuide(false)} />}
    </div>
  );
}

/** The bot picks something other than what the player is wearing. */
function otherOutlaw(playerChoice: number, seed: number): number {
  const options = FREE_OUTLAWS.filter((i) => i !== playerChoice);
  return options[seed % Math.max(1, options.length)] ?? 0;
}

function rulesSummary(rules: MatchRules): string {
  return [
    `${rules.players} outlaws`,
    `$${TARGET_CHOICES[rules.target] ?? BALANCE.TARGET_BANKED} to win`,
    rules.roundTimer ? `${BALANCE.ROUND_SECONDS}s rounds` : 'no clock',
  ].join(' · ');
}

// -- stage 2 ------------------------------------------------------------------

/** One person choosing a face: an online player, or a seat at this device. */
interface OutlawSlot {
  key: string;
  label: string;
  skin: number | null | undefined;
  /** Whether this device picks for this slot. */
  editable: boolean;
  isHost?: boolean;
}

/**
 * Stage 2: who you are in town.
 *
 * The same screen online and offline. Online, each player edits only their own
 * slot and watches everyone else's appear in the roster strip; on a couch,
 * every seat is this device's to edit, one at a time.
 */
function CustomizeScreen({
  slots,
  owned,
  coins,
  toolbar,
  leads,
  hostName,
  onPick,
  onBack,
  onNext,
}: {
  slots: OutlawSlot[];
  owned: number[];
  coins: number;
  toolbar: React.ReactNode;
  /** This device moves the flow on: offline, or the host. */
  leads: boolean;
  hostName?: string;
  onPick: (key: string, index: number) => void;
  onBack?: () => void;
  onNext: () => void;
}) {
  const mine = slots.filter((s) => s.editable);
  const [activeKey, setActiveKey] = useState(() => mine[0]?.key ?? '');
  const active = mine.find((s) => s.key === activeKey) ?? mine[0];

  const others = slots.filter((s) => s !== active);
  const pickedBy = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const s of others) if (s.skin !== undefined && s.skin !== null) (map[s.skin] ??= []).push(s.label);
    return map;
  }, [others]);

  const picked = (s: OutlawSlot) => s.skin !== undefined && s.skin !== null;
  const waiting = slots.filter((s) => !picked(s)).length;
  const iAmReady = mine.every(picked);

  return (
    <StageFrame
      theme={THEME}
      step={2}
      title="Pick your face"
      subtitle={`${slots.length} ${slots.length === 1 ? 'outlaw' : 'outlaws'} on the board`}
      onBack={onBack}
      toolbar={toolbar}
      status={
        !leads ? <HostBadge theme={THEME}>{hostName || 'The host'} moves on when everyone is set</HostBadge> : undefined
      }
      footer={
        <ActionBar
          theme={THEME}
          label="Next: The game"
          onAction={leads ? onNext : undefined}
          disabled={waiting > 0}
          note={
            leads
              ? waiting > 0
                ? `Waiting on ${waiting} more to pick a face.`
                : 'Everyone is set. Next, how the game runs.'
              : iAmReady
                ? `Ready. Waiting for ${hostName || 'the host'} to set the game up...`
                : 'Pick a face to be ready.'
          }
        />
      }
    >
      <div className="flex h-full flex-col gap-3 short:gap-2">
        <div className="flex shrink-0 gap-2 overflow-x-auto overscroll-contain pb-1">
          {slots.map((s, i) => {
            const selectable = s.editable && mine.length > 1;
            const color = SEAT_COLORS[i % SEAT_COLORS.length].main;
            return (
              <button
                key={s.key}
                type="button"
                disabled={!selectable}
                onClick={() => setActiveKey(s.key)}
                className={`flex shrink-0 items-center gap-2 rounded-2xl border-2 px-2 py-1.5 text-left disabled:cursor-default ${
                  s === active && mine.length > 1 ? THEME.selected : 'border-amber-900/15 bg-[#f7ecd6]'
                }`}
              >
                <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-amber-900/10">
                  {picked(s) ? <OutlawToken skin={s.skin as number} size={34} ring={color} /> : null}
                </span>
                <span className="min-w-0">
                  <span className="flex max-w-[120px] items-center gap-1 truncate text-xs font-black text-amber-950">
                    {s.label}
                    {s.isHost && <Crown className="h-3 w-3 shrink-0 text-amber-600" />}
                  </span>
                  <span
                    className={`block text-[9px] font-black uppercase tracking-wider ${
                      picked(s) ? 'text-rose-800' : 'text-amber-900/40'
                    }`}
                  >
                    {picked(s) ? 'Ready' : 'Choosing...'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {active ? (
          <div className="min-h-0 flex-1">
            <OutlawGrid
              owned={owned}
              coins={coins}
              selected={active.skin ?? null}
              pickedBy={pickedBy}
              onPick={(index) => onPick(active.key, index)}
            />
          </div>
        ) : (
          <p className="py-10 text-center text-sm font-bold text-amber-900/60">
            The board is full for this one. You can watch it play out.
          </p>
        )}
      </div>
    </StageFrame>
  );
}

function OutlawGrid({
  owned,
  coins,
  selected,
  pickedBy,
  onPick,
}: {
  owned: number[];
  coins: number;
  selected: number | null;
  pickedBy: Record<number, string[]>;
  onPick: (index: number) => void;
}) {
  // Sideways there is 360px of screen; a 133px card spends a third of it.
  const short = useShortScreen();
  return (
    <div className={`grid ${short ? 'grid-cols-6 gap-1.5' : 'grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4'}`}>
      {OUTLAWS.map((outlaw, index) => {
        const isOwned = owned.includes(index);
        const isSelected = selected === index;
        const affordable = coins >= outlaw.price;
        const others = pickedBy[index] ?? [];
        return (
          <button
            key={outlaw.name}
            onClick={() => onPick(index)}
            disabled={!isOwned && !affordable}
            className={`relative flex flex-col items-center overflow-hidden rounded-2xl border-2 text-center transition-colors ${
              short ? 'gap-0.5 p-1.5' : 'gap-1 p-2.5'
            } ${
              isSelected
                ? 'border-rose-700 bg-rose-100'
                : isOwned
                  ? 'border-amber-900/20 bg-[#f7ecd6]'
                  : 'border-amber-700/30 bg-amber-100/60'
            }`}
          >
            {!isOwned && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-amber-950/60">
                <Lock className="mb-0.5 h-4 w-4 text-amber-200" />
                <span className="text-[11px] font-black text-amber-200">{outlaw.price}</span>
                {!affordable && <span className="text-[9px] font-bold text-rose-300">not enough</span>}
              </div>
            )}
            <OutlawToken skin={index} size={short ? 38 : 62} />
            <span className="text-[11px] font-black uppercase tracking-wide text-amber-950 short:text-[9px] short:leading-tight">
              {outlaw.name}
            </span>
            <span className="text-[9px] leading-tight text-amber-900/50 short:hidden">{outlaw.blurb}</span>
            {others.length > 0 && (
              <span className="text-[9px] font-black uppercase text-amber-900/40">also {others.join(', ')}</span>
            )}
            {isSelected && (
              <span className="flex items-center gap-1 text-[10px] font-black text-rose-800">
                <Check className="h-3 w-3" /> picked
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// -- stage 3 ------------------------------------------------------------------

interface TownMember {
  key: string;
  name: string;
  skin?: number | null;
  bot?: boolean;
  you?: boolean;
  host?: boolean;
}

/**
 * Stage 3: the whole game on one page.
 *
 * The host's copy is the controls; a guest's copy is the same page locked,
 * kept current from the lobby as the host clicks. See MatchControls.
 */
function ModesScreen({
  rules,
  locked,
  local,
  hostName,
  toolbar,
  roster,
  seatCount,
  bots,
  onRules,
  aiLevel,
  onAiLevel,
  onGuide,
  onBack,
  onStart,
  startDisabled,
  startNote,
}: {
  rules: MatchRules;
  locked: boolean;
  /** Solo or couch: no room, so the table size is this device's to choose. */
  local: boolean;
  hostName?: string;
  toolbar: React.ReactNode;
  roster: TownMember[];
  seatCount: number;
  bots: number;
  onRules: (rules: MatchRules) => void;
  aiLevel: number;
  /** Omitted when no bot is riding, or for a guest: online bots always ride at one fixed rank. */
  onAiLevel?: (level: number) => void;
  onGuide: () => void;
  onBack?: () => void;
  onStart?: () => void;
  startDisabled?: boolean;
  startNote: string;
}) {
  const set = (patch: Partial<MatchRules>) => onRules({ ...rules, ...patch });

  return (
    <StageFrame
      theme={THEME}
      step={3}
      title="The game"
      subtitle={rulesSummary(rules)}
      onBack={onBack}
      toolbar={toolbar}
      status={locked ? <HostBadge theme={THEME}>{hostName || 'The host'} is setting the game up...</HostBadge> : undefined}
      footer={
        <ActionBar
          theme={THEME}
          label="Ride out"
          icon={<Play className="h-4 w-4 fill-current" />}
          onAction={onStart}
          disabled={startDisabled}
          note={startNote}
        />
      }
    >
      <div className="grid gap-5 lg:grid-cols-3 short:gap-3">
        <div className="space-y-5 lg:col-span-2 short:space-y-3">
          {local ? (
            <RuleSection
              theme={THEME}
              title="Outlaws at the table"
              hint="Seats past whoever is on the couch are filled with bots."
            >
              <OptionGroup
                theme={THEME}
                columns={5}
                value={rules.players}
                onChange={(n) => set({ players: Math.max(seatCount, n) as PlayerCount })}
                options={PLAYER_CODES.map((n) => ({ value: n, label: String(n) }))}
              />
            </RuleSection>
          ) : (
            <RuleSection theme={THEME} title="Outlaws at the table" locked={locked}>
              <p className="rounded-xl bg-black/5 px-3 py-2 text-[11px] font-bold leading-relaxed text-slate-600">
                Whoever is in the room rides , {rules.players} at this table
                {bots > 0 && `, ${bots} of them bots`}. Invite one more and the table grows with you.
              </p>
            </RuleSection>
          )}

          <RuleSection
            theme={THEME}
            title="Banked to win"
            hint={`Only money in the Bank is safe. Or the richest after ${BALANCE.ROUNDS} rounds takes it.`}
            locked={locked}
          >
            <OptionGroup
              theme={THEME}
              locked={locked}
              value={rules.target}
              onChange={(target) => set({ target })}
              options={TARGET_CHOICES.map((amount, i) => ({ value: i, label: `$${amount}` }))}
            />
          </RuleSection>

          <RuleSection theme={THEME} title="Modifiers" locked={locked}>
            <ToggleOption
              theme={THEME}
              label={`Round clock · ${BALANCE.ROUND_SECONDS}s`}
              hint="After the clock runs out, anyone still deciding lays low. Off lets a round take as long as it takes."
              value={rules.roundTimer}
              locked={locked}
              onChange={(roundTimer) => set({ roundTimer })}
            />
          </RuleSection>

          {onAiLevel && (
            <RuleSection theme={THEME} title="Bot rank" hint="How well the bots in empty saddles read the table.">
              <OptionGroup
                theme={THEME}
                value={aiLevel}
                onChange={onAiLevel}
                options={TIERS.map((tier, i) => ({ value: i, label: tier.label }))}
              />
            </RuleSection>
          )}

          <button
            onClick={onGuide}
            className="flex w-full items-center gap-2 rounded-xl border-2 border-rose-700/40 bg-rose-100/70 px-3 py-2 text-left text-[11px] font-bold leading-relaxed text-rose-900 short:hidden"
          >
            <ScrollText className="h-4 w-4 shrink-0 text-rose-800" />
            Four spokes run straight to the Bank , fast, and everyone can see you take one. Read what every card does.
          </button>
        </div>

        <RuleSection theme={THEME} title={`In town · ${roster.length}`} locked={locked}>
          <div className="space-y-1.5">
            {roster.map((m, i) => {
              const color = SEAT_COLORS[i % SEAT_COLORS.length].main;
              return (
                <div
                  key={m.key}
                  className="flex items-center gap-2 rounded-xl border-2 p-1.5"
                  style={{ borderColor: `${color}55`, background: `${color}14` }}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-amber-900/10">
                    {m.skin !== undefined && m.skin !== null ? (
                      <OutlawToken skin={m.skin} size={30} ring={color} />
                    ) : (
                      <Users className="h-4 w-4 text-amber-900/30" />
                    )}
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-xs font-bold ${m.bot ? 'text-amber-900/50' : 'text-amber-950'}`}>
                    {m.name}
                    {m.you && <span className="text-amber-900/50"> · you</span>}
                  </span>
                  {m.host && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-600" />}
                </div>
              );
            })}
          </div>
        </RuleSection>
      </div>
    </StageFrame>
  );
}

// -- modals -------------------------------------------------------------------

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
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-amber-950/60 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-5 overflow-y-auto rounded-[2rem] p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-black uppercase tracking-wide text-amber-950">Settings</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-amber-900/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-sm font-bold text-amber-950">
            <span>Effects</span>
            <span>{Math.round(settings.sfxVolume * 100)}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={settings.sfxVolume}
            onChange={(e) => onChange({ ...settings, sfxVolume: parseFloat(e.target.value) })}
            className="w-full accent-rose-800"
          />
        </div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold text-amber-950">
            Card hints
            <span className="block text-[11px] font-normal text-amber-900/50">
              Spell out what the selected card does, under the rack.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.hints}
            onChange={(e) => onChange({ ...settings, hints: e.target.checked })}
            className="h-6 w-6 shrink-0 accent-rose-800"
          />
        </label>
      </div>
    </div>
  );
}

/** Four pictures, no reading required, for someone who has never opened this game before. */
function HowItWorks() {
  const steps: { icon: React.ReactNode; title: string; body: string }[] = [
    { icon: <Lock className="h-4 w-4" />, title: 'Pick in secret', body: 'Everyone chooses a card. Nobody sees anyone else’s.' },
    { icon: <Users className="h-4 w-4" />, title: 'Reveal together', body: 'All the cards flip at once. No turns, no waiting.' },
    { icon: <Coins className="h-4 w-4" />, title: 'Bounty grows', body: 'Every card but Cash In adds to what’s on your head.' },
    { icon: <Crown className="h-4 w-4" />, title: 'Bank it to win', body: 'Only money in the Bank is safe. Get there first, most, or often.' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {steps.map((s, i) => (
        <div key={s.title} className="rounded-2xl border border-amber-900/15 bg-amber-900/5 p-2.5">
          <div className="flex items-center gap-1.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-900 text-[10px] font-black text-amber-50">
              {i + 1}
            </span>
            <span className="text-amber-800">{s.icon}</span>
          </div>
          <p className="mt-1.5 text-[11px] font-black uppercase tracking-wide text-amber-950">{s.title}</p>
          <p className="text-[10px] leading-snug text-amber-900/60">{s.body}</p>
        </div>
      ))}
    </div>
  );
}

/** The board, drawn small and static , the same wheel TownMap draws, just for reading rather than playing. */
function MapDiagram() {
  return (
    <div className="rounded-2xl border border-amber-900/15 bg-amber-900/5 p-3">
      <svg viewBox="0 0 100 100" className="mx-auto block h-36 w-36 sm:h-44 sm:w-44" aria-hidden>
        {ROADS.map(([a, b]) => (
          <line
            key={`${a}-${b}`}
            x1={PLACES[a].x}
            y1={PLACES[a].y}
            x2={PLACES[b].x}
            y2={PLACES[b].y}
            stroke="#8b6f47"
            strokeWidth={a === BANK || b === BANK ? 1.6 : 1.1}
            strokeDasharray="2.8 2.4"
            opacity={a === BANK || b === BANK ? 0.75 : 0.5}
          />
        ))}
        {PLACES.map((place, i) => (
          <g key={place.name}>
            <circle
              cx={place.x}
              cy={place.y}
              r={i === BANK ? 7.5 : 5}
              fill={i === BANK ? '#b45309' : '#f7ecd6'}
              stroke="#78350f"
              strokeWidth="1.1"
            />
          </g>
        ))}
      </svg>
      <div className="mt-1.5 flex items-center justify-center gap-4 text-[9px] font-bold text-amber-900/60">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#b45309]" /> Bank
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full border border-amber-900/50 bg-[#f7ecd6]" /> everywhere else
        </span>
      </div>
      <p className="mt-1.5 text-center text-[10px] leading-snug text-amber-900/50">
        Four spokes run straight to the Bank , fast, and everyone can see you take one. The rest of town is the
        rim: slower, and easier to disappear into.
      </p>
    </div>
  );
}

/**
 * How the game works, for anyone who has never played this one.
 *
 * Only the explanation now: the table size, what it takes to win and the
 * round clock are all decisions the match page makes, where the town they
 * apply to is already on screen. A modal was the wrong place to keep them
 * , it hid the one page that says what you are about to play.
 */
function GuidePanel({ onClose }: { onClose: () => void }) {
  // Escape closes it too. See @shared/ui/dismiss.
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-amber-950/60 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-5 overflow-y-auto rounded-[2rem] p-6">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-xl font-black uppercase tracking-wide text-amber-950">The rules</h3>
            <p className="text-[11px] font-semibold text-amber-900/50">Everything but the numbers, which the host sets.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-amber-900/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <HowItWorks />
        <MapDiagram />

        <div className="space-y-2.5 border-t border-amber-900/15 pt-4">
          <p className="text-sm font-black uppercase tracking-wide text-amber-950">The cards</p>
          {CARD_ORDER.map((id) => (
            <div key={id} className="flex items-start gap-2 text-[11px] leading-snug">
              <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-amber-900/20 bg-amber-900/5 text-sm text-amber-900">
                {CARD_GLYPH[id]}
              </span>
              <div>
                <span className="font-black uppercase tracking-wide text-amber-950">{CARDS[id].name}</span>
                {CARDS[id].onlyAt !== null && (
                  <span className="ml-1 rounded bg-amber-900/10 px-1 text-[9px] font-black uppercase text-amber-900/60">
                    {PLACES[CARDS[id].onlyAt as number]?.name} only
                  </span>
                )}
                <span className="block text-amber-900/60">{CARDS[id].blurb}</span>
              </div>
            </div>
          ))}
        </div>

        <p className="text-center text-[10px] font-bold text-amber-900/40">
          Table size, the target and the round clock are set on the game page, right before you ride out.
        </p>
      </div>
    </div>
  );
}
