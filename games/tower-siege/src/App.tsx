import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { scrimProps, useEscape } from '@shared/ui/dismiss';
import {
  ArrowLeft,
  Bot,
  Castle,
  Check,
  Coins,
  Crown,
  Eye,
  Loader2,
  LogOut,
  Maximize2,
  Play,
  ShoppingBag,
  Settings as SettingsIcon,
  Shield,
  Swords,
  Users,
  User,
} from 'lucide-react';
import { askHostToEndGame, askToLeaveLobby, isNativeFullscreen, toggleFullscreen, useAutoFullscreen } from './fullscreen';
import { MainMenu } from '@shared/menu/MainMenu';
import { ActionBar, HostBadge, StageFrame } from '@shared/menu/StageFrame';
import { ModeCard, OptionGroup, RuleSection } from '@shared/menu/MatchControls';
import { MENU_STAGE_FIELD, parseStage } from '@shared/menu/stage';
import type { MenuStage } from '@shared/menu/stage';
import type { MenuTheme } from '@shared/menu/theme';
import { GameWallet, reportResult } from './platform/wallet';
import { TIERS } from './engine/ai';
import { SEATS, DEFAULT_RULES, WAVE_CHOICES, clamp, packRules, unpackRules } from './game/rules';
import type { MatchRules, Mode, PlayerCount } from './game/rules';
import { audioService } from './services/audio';
import MatchView from './screens/MatchView';
import type { MatchConfig, Seat } from './screens/MatchView';
import { DEFAULT_SETTINGS } from './types/game';
import type { GameSettings } from './types/game';
import { createLogger } from '@shared/log/logger';

const log = createLogger('tower-siege');

/**
 * The platform owns the lobby.
 *
 * This game never shows a login screen and never asks for a room code. It
 * reads the room it was handed in the query string, writes only its own slot
 * in it, and lets PlayWithBuddies decide who is in the match.
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

/** Everything before the siege is one of the shared menu stages; see `stage` in App. */
type View = 'shell' | 'game';

const THEME: MenuTheme = {
  tone: 'dark',
  primary: 'bg-amber-400 text-slate-900',
  selected: 'border-amber-300 bg-amber-400/18',
  accent: 'text-amber-300',
};

/**
 * The modes this game has, exactly as REQUIREMENTS.md lists them.
 *
 * A card is a (mode, seats) pair rather than a bare `Mode`, because that is
 * what a mode is here: `siege` seats two for a duel or four for a 2v2, and
 * `alliance` is the co-op keep. Nothing on a card is invented , every one of
 * these is a combination the old room screen already offered, and the seat
 * count is the same `players` rule it always wrote.
 */
interface SiegeMode {
  mode: Mode;
  players: PlayerCount;
  name: string;
  badge: string;
  hint: string;
  icon: ReactNode;
  /** One seat has nobody to share the keep with, so it is offered on this device only. */
  soloOnly?: boolean;
}

const MODES: SiegeMode[] = [
  {
    mode: 'alliance',
    players: 1,
    name: 'Single Player',
    badge: 'Solo · 1 seat',
    hint: 'One commander holds the keep. Every machine on the field is yours, and every kill pays your purse.',
    icon: <User />,
    soloOnly: true,
  },
  {
    mode: 'alliance',
    players: 2,
    name: 'Shared Keep',
    badge: 'Co-op · 2 seats',
    hint: 'Two commanders, one keep, one pool of lives. Each builds from their own purse, and holding through the last wave wins it for both.',
    icon: <Shield />,
  },
  {
    mode: 'siege',
    players: 2,
    name: 'Head-to-Head',
    badge: '1v1 · 2 seats',
    hint: 'The same keep and the same waves, scored as a race: more tower kills takes it, as long as the keep is still standing at the end.',
    icon: <Swords />,
  },
  {
    mode: 'siege',
    players: 4,
    name: 'Team Siege',
    badge: '2v2 · 4 seats',
    hint: 'Four commanders in alternating-seat teams, 1 and 3 against 2 and 4. Team kills decide it if the keep survives.',
    icon: <Users />,
  },
];

const WAVE_NOTE: Record<number, string> = { 10: 'Short', 20: 'Standard', 30: 'Long' };

/** A solo siege keeps its own rules, so it can never overwrite the room's. */
const SOLO_RULES: MatchRules = { ...DEFAULT_RULES, mode: 'alliance', players: 1 };

interface LobbyPerson {
  uid: string;
  displayName: string;
  /** Written by the PlayWithBuddies lobby, not by this game. */
  photoURL?: string;
  /** The platform's own ready flag: opt-out by default, and writable by its owner alone. */
  isReady?: boolean;
}

interface Lobby {
  hostId: string;
  players: Record<string, LobbyPerson>;
  matchStarted?: boolean;
  matchRules?: number;
  /** The stage the whole room is on. The platform resets it when a game is launched. */
  menuStage?: string;
  /**
   * The host's bot rank. It is not part of the packed rules , those are the
   * terms the engine simulates from, and this only decides how the host's
   * bots buy , so it travels beside them, host-written like every other
   * room-wide field.
   */
  siegeBotLevel?: number;
}

/** One berth on the battlefield, for the crew page and the match page alike. */
interface CrewSeat {
  key: string;
  seat: number;
  name: string;
  colour: (typeof SEATS)[number];
  you?: boolean;
  host?: boolean;
  bot?: boolean;
  ready?: boolean;
  /** 1 or 2 in a siege; absent when everyone is on the same side. */
  team?: number;
}

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;

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
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);
  const [offlineMatch, setOfflineMatch] = useState(false);
  const [aiLevel, setAiLevel] = useState(1);

  const wallet = useMemo(() => new GameWallet('tower-siege', 'siege_owned'), []);
  const [coins, setCoins] = useState(() => wallet.current.coins);
  const [walletReady, setWalletReady] = useState(false);

  useEffect(() => {
    wallet.open((purse) => {
      setCoins(purse.coins);
      setWalletReady(true);
    });
    return () => wallet.close();
  }, [wallet]);

  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('siege_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  /** The room's rules. A solo siege keeps its own, below, so neither can overwrite the other. */
  const [rules, setRules] = useState<MatchRules>(() => {
    const saved = localStorage.getItem('siege_rules');
    return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : DEFAULT_RULES;
  });

  const [soloRules, setSoloRules] = useState<MatchRules>(() => {
    const saved = localStorage.getItem('siege_solo_rules');
    return saved ? { ...SOLO_RULES, ...JSON.parse(saved) } : SOLO_RULES;
  });

  useEffect(() => {
    localStorage.setItem('siege_rules', JSON.stringify(rules));
  }, [rules]);

  useEffect(() => {
    localStorage.setItem('siege_solo_rules', JSON.stringify(soloRules));
  }, [soloRules]);

  useEffect(() => {
    localStorage.setItem('siege_settings', JSON.stringify(settings));
    audioService.setVolume(settings.sfxVolume);
  }, [settings]);

  useEffect(() => {
    if (!walletReady) return;
    wallet.save({ coins, unlocks: [] });
  }, [walletReady, coins, wallet]);

  const [session, setSession] = useState(() => ({ seed: randomSeed() }));
  const rollSession = useCallback(() => setSession({ seed: randomSeed() }), []);

  // -- platform session -------------------------------------------------------
  //
  // Firebase is imported dynamically, and only down the online path: the SDK is
  // several times the weight of the whole game and a solo siege never calls
  // into it once.
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
            setLobbyError('That room is gone.');
            return;
          }
          const data = snap.data() as Lobby;
          setLobby(data);
          setLobbyError(null);
        },
        () => setLobbyError('Lost contact with the room.'),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [online, uid, handoff.room]);

  const isHost = Boolean(uid && lobby && lobby.hostId === uid);

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

  /**
   * Match size follows the live room so an old local setting cannot create
   * ghost seats. Tower Siege supports a duel or a four-player 2v2.
   *
   * A previous room choice must never turn two live players into four stale
   * seats. The current roster is the source of truth before the host starts.
   */
  useEffect(() => {
    if (!online || !isHost || !lobby) return;
    const roomSize = Object.keys(lobby.players ?? {}).length;
    const fits: PlayerCount = roomSize > 2 ? 4 : 2;
    if (fits !== rules.players || (fits === 4 && rules.mode === 'alliance')) {
      setRules((r) => ({ ...r, players: fits, mode: fits === 4 ? 'siege' : r.mode, sends: false }));
    }
  }, [online, isHost, lobby, rules.players, rules.mode]);

  /**
   * Everyone in the match, sorted by uid.
   *
   * Sorted rather than in arrival order so every client computes the identical
   * seating from data it already has; ownership and 2v2 teams depend on this.
   */
  const people = useMemo(() => {
    return Object.values(lobby?.players ?? {})
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .slice(0, rules.players)
      .map((p) => ({
        uid: p.uid,
        displayName: p.displayName || 'Player',
        /** Everyone joins a PlayWithBuddies room ready, so only a deliberate un-ready reads as false. */
        ready: p.isReady !== false,
      }));
  }, [lobby, rules.players]);

  /**
   * A guest obeys the host's rules; its own copy is only a placeholder.
   *
   * This is also what makes a guest's locked match page a live one rather
   * than a guess: the host writes `matchRules` on every change (below), and
   * it lands here as they click.
   */
  useEffect(() => {
    if (!online || isHost) return;
    const bits = lobby?.matchRules;
    if (typeof bits !== 'number') return;
    setRules(unpackRules(bits));
  }, [online, isHost, lobby?.matchRules]);

  /** The bot rank rides beside the packed rules rather than inside them. */
  useEffect(() => {
    if (!online || isHost) return;
    const level = lobby?.siegeBotLevel;
    if (typeof level !== 'number' || !Number.isFinite(level)) return;
    setAiLevel(clamp(Math.round(level), 0, TIERS.length - 1));
  }, [online, isHost, lobby?.siegeBotLevel]);

  // Publish the match terms while everyone is still in the room, on every
  // change and not only at the start: a guest's copy of the match page is fed
  // from this write. Guests also need the seat count before MatchView freezes
  // its roster. Written only when it would actually say something new, so a
  // snapshot of an unrelated field cannot start a write of its own.
  useEffect(() => {
    if (!online || !isHost || !lobby) return;
    const packed = packRules(rules);
    if (lobby.matchRules === packed && lobby.siegeBotLevel === aiLevel) return;
    void writeLobby({ matchRules: packed, siegeBotLevel: aiLevel });
  }, [online, isHost, lobby, rules, aiLevel, writeLobby]);

  useEffect(() => {
    if (!online || offlineMatch) return;
    if (lobby?.matchStarted && view === 'shell') {
      rollSession();
      setView('game');
    }
    if (!lobby?.matchStarted && view === 'game' && !offlineMatch) setView('shell');
  }, [lobby?.matchStarted, online, view, offlineMatch, rollSession]);

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      await updateDoc(doc(db, 'lobbies', handoff.room), {
        matchStarted: true,
        matchRules: packRules(rules),
      });
    } catch (e) {
      console.error('Could not raise the gates', e);
    }
  }, [isHost, handoff.room, rules]);

  /**
   * Out of the siege and back onto the match page, ready for a rematch.
   *
   * A solo siege is this device's own: it drops back onto its local match
   * page rather than into the room this browser happens to be signed into.
   * Online, the host's go-signal comes down with them , without that reset a
   * rematch could not start, since true to true is not a change the effect
   * above reacts to. It also covers a host quitting mid-match.
   */
  const leaveMatch = useCallback(async () => {
    setView('shell');
    if (offlineMatch) {
      setLocalStage('modes');
      return;
    }
    if (!online || !isHost) return;
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      await updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: false });
    } catch {
      /* the room may already be gone; nothing to do about it here */
    }
  }, [online, isHost, offlineMatch, handoff.room]);

  const award = useCallback((won: boolean, wave: number) => {
    // Something for turning up, more for surviving, and a slice per wave so a
    // long losing stand still pays better than a short one.
    setCoins((c) => c + (won ? 120 : 30) + wave * 6);
    reportResult(won, { wave });
  }, []);

  // -- configs ----------------------------------------------------------------

  function onlineConfig(): MatchConfig {
    const crew = handoff.solo ? people.filter((p) => p.uid === uid) : people;
    const seats: Seat[] = [];
    let mine = -1;

    // Every berth the rules call for gets filled, in the fixed sorted order
    // every client derives the same way. An empty berth gets a bot, so a
    // half-empty room is still a race rather than a walkover (R1).
    for (let i = 0; i < rules.players; i++) {
      const person = crew[i];
      if (person && person.uid === uid) {
        mine = i;
        seats.push({ id: uid, name: handoff.displayName || 'You', control: 'local' });
      } else if (person) {
        seats.push({ id: person.uid, name: person.displayName, control: 'remote' });
      } else {
        seats.push({ id: `bot-${i}`, name: `${TIERS[aiLevel].label} ${i + 1}`, control: 'bot' });
      }
    }

    const peerUids = crew.filter((p) => p.uid !== uid).map((p) => p.uid);
    log.info('seats:built', {
      players: rules.players,
      mode: rules.mode,
      seats: seats.map((s) => ({ id: s.id, control: s.control })),
      mine,
      peerUids,
      isHost,
    });

    return {
      roomId: handoff.room,
      uid,
      peerUids,
      isHost,
      seats,
      // A player who arrived after the berths filled up watches rather than
      // being wedged in: the match is already under way and the waves are set.
      mine: mine < 0 ? 0 : mine,
      aiLevel,
      seed: session.seed,
      rules,
    };
  }

  function offlineConfig(): MatchConfig {
    const seats: Seat[] = [];
    // Whatever the solo match page chose: one commander alone, or the empty
    // seats filled by bots, exactly as an under-full room fills them online.
    for (let i = 0; i < Math.max(1, soloRules.players); i++) {
      seats.push(
        i === 0
          ? { id: 'me', name: 'You', control: 'local' }
          : { id: `bot-${i}`, name: `${TIERS[aiLevel].label} ${i}`, control: 'bot' },
      );
    }
    return {
      roomId: null,
      uid: null,
      peerUids: [],
      isHost: true,
      seats,
      mine: 0,
      aiLevel,
      seed: session.seed,
      rules: soloRules,
    };
  }

  /** Single Player: the same three stages, run on this device alone. */
  const openOffline = () => {
    audioService.unlock();
    setOfflineMatch(true);
    setLocalStage('customize');
  };

  const closeOffline = () => {
    setOfflineMatch(false);
    setLocalStage('menu');
  };

  const startSolo = () => {
    audioService.unlock();
    rollSession();
    setView('game');
  };

  // Frozen to match identity, not recomputed live: MatchView reads config
  // fields like seat team every frame, and a live roster reorder mid-round
  // (reconnect, late write) would otherwise flip them under a running game.
  const pregameConfigKey = view === 'game'
    ? 'locked'
    : `${packRules(offlineMatch || !online ? soloRules : rules)}:${aiLevel}:${people.map((person) => person.uid).join(',')}`;
  const matchConfig = useMemo(
    () => (offlineMatch || !online ? offlineConfig() : onlineConfig()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.seed, offlineMatch, online, pregameConfigKey],
  );

  // -- the pre-match flow -----------------------------------------------------

  /** Solo play, or the game opened on its own: the flow lives on this device alone. */
  const local = !online || offlineMatch;
  const remoteStage = parseStage(lobby?.menuStage);
  const stage: MenuStage = local ? localStage : remoteStage;
  /** Online, the stage is a room-wide fact the host writes; offline it is this device's. */
  const goStage = (next: MenuStage) => {
    if (local) setLocalStage(next);
    else void writeLobby({ [MENU_STAGE_FIELD]: next });
  };

  /** The rules this device may edit: its own solo ones, or the room's. */
  const stageRules = local ? soloRules : rules;
  const setStageRules = (next: MatchRules) => (local ? setSoloRules(next) : setRules(next));

  /** This device moves the flow on: playing alone, or holding the room. */
  const leads = local || isHost;
  const locked = !leads;
  const hostName = lobby?.players?.[lobby.hostId]?.displayName;
  const roomSize = Object.keys(lobby?.players ?? {}).length;

  /**
   * Who holds which berth, in the order every client derives the same way.
   *
   * One list behind both stages: the crew page and the match page are two
   * views of the same seating. An empty berth is a bot rather than a gap, so
   * the room plays the mode it picked whether or not the fourth person came.
   */
  const seats = useMemo<CrewSeat[]>(() => {
    const total = Math.max(1, stageRules.players);
    const out: CrewSeat[] = [];
    for (let i = 0; i < total; i++) {
      const colour = SEATS[i % SEATS.length];
      const team = stageRules.mode === 'siege' && total > 1 ? (i % 2) + 1 : undefined;
      const person = local ? undefined : people[i];
      if (local && i === 0) {
        out.push({ key: 'me', seat: i, name: 'You', colour, you: true, team });
      } else if (person) {
        out.push({
          key: person.uid,
          seat: i,
          name: person.displayName,
          colour,
          you: person.uid === uid,
          host: person.uid === lobby?.hostId,
          ready: person.ready,
          team,
        });
      } else {
        // Named exactly as the match config names them, so the page and the
        // battlefield never disagree about who is holding a berth.
        out.push({ key: `bot-${i}`, seat: i, name: `${TIERS[aiLevel].label} ${local ? i : i + 1}`, colour, bot: true, team });
      }
    }
    return out;
  }, [local, people, stageRules.players, stageRules.mode, aiLevel, uid, lobby?.hostId]);

  /** In the room, but past the last berth: watching this one out. */
  const watchers = useMemo(() => {
    if (local) return [];
    const seated = new Set(people.map((person) => person.uid));
    return Object.values(lobby?.players ?? {})
      .filter((person) => !seated.has(person.uid))
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .map((person) => ({ uid: person.uid, name: person.displayName || 'Player' }));
  }, [local, people, lobby]);

  const bots = seats.filter((seat) => seat.bot).length;
  const iAmReady = !online || !uid ? true : lobby?.players?.[uid]?.isReady !== false;

  /**
   * The platform's own ready flag, and the one field of their own slot a guest
   * is allowed to write. Nothing blocks on it: it is how somebody says "give
   * me a second", not a lock on the room , a tab that crashed un-ready would
   * otherwise strand everybody else behind it.
   */
  const toggleReady = useCallback(async () => {
    if (!online || !uid) return;
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      await updateDoc(doc(db, 'lobbies', handoff.room), { [`players.${uid}.isReady`]: !iAmReady });
    } catch (e) {
      console.error('Could not change your ready flag', e);
    }
  }, [online, uid, handoff.room, iAmReady]);

  const fullscreen = () => toggleFullscreen(document.documentElement, !isNativeFullscreen());
  const coinChip = (
    <div className="panel flex items-center gap-1.5 rounded-2xl px-3 py-2.5 font-black text-amber-300 short:py-2">
      <Coins className="h-4 w-4" /> {coins}
    </div>
  );
  const toolButton = (label: string, icon: ReactNode, onClick: () => void) => (
    <button onClick={onClick} aria-label={label} title={label} className="panel rounded-2xl p-2.5 short:p-2">
      {icon}
    </button>
  );
  const stageToolbar = (
    <>
      <span className="hidden sm:block">{coinChip}</span>
      {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
      {toolButton('Settings', <SettingsIcon className="h-5 w-5" />, () => setShowSettings(true))}
      {!local && isHost && toolButton('End the match for everyone', <LogOut className="h-5 w-5" />, askHostToEndGame)}
    </>
  );

  // -- render -----------------------------------------------------------------

  let screen: ReactNode;
  if (view === 'game') {
    screen = (
      <MatchView
        config={matchConfig}
        settings={settings}
        coins={coins}
        onOpenSettings={() => setShowSettings(true)}
        onExit={() => {
          if (online && !offlineMatch && !isHost) askHostToEndGame();
          void leaveMatch();
        }}
        onResult={award}
      />
    );
  } else if (!local && lobbyError) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-lg font-black">{lobbyError}</p>
        <button onClick={openOffline} className="rounded-2xl bg-amber-400 px-5 py-3 font-black text-slate-900">
          Play single player
        </button>
      </div>
    );
  } else if (!local && (!authChecked || !uid || !lobby)) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-amber-300" />
        <p className="font-bold text-white/70">Finding the room…</p>
      </div>
    );
  } else if (stage === 'menu') {
    screen = (
      <MainMenu
        theme={THEME}
        online={online}
        isHost={isHost}
        hostName={hostName}
        onSingle={openOffline}
        onMulti={online && !handoff.solo ? () => goStage('customize') : undefined}
        onSettings={() => setShowSettings(true)}
        singleHint="Hold the keep on this device"
        multiHint={`Co-op, 1v1 or 2v2 · ${roomSize} in the room`}
        toolbar={
          <>
            {coinChip}
            {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
            {toolButton('Leave', <LogOut className="h-5 w-5" />, askToLeaveLobby)}
          </>
        }
        title={
          <>
            <div className="mx-auto mb-2 grid h-16 w-16 place-items-center rounded-[1.4rem] border-2 border-amber-200/60 bg-amber-400 text-slate-900 shadow-[0_10px_35px_rgba(251,191,36,.35)] short:h-11 short:w-11">
              <Castle className="h-9 w-9 short:h-6 short:w-6" />
            </div>
            <h1 className="text-4xl font-black leading-none tracking-tighter drop-shadow-lg sm:text-6xl short:text-3xl">
              TOWER <span className="text-amber-300">SIEGE</span>
            </h1>
            <p className="mt-2 text-[11px] font-black uppercase tracking-[0.28em] text-cyan-100/75">
              One battlefield · every machine matters
            </p>
          </>
        }
        secondary={
          <button
            onClick={() => setShowShop(true)}
            className="flex w-full items-center gap-3 rounded-2xl border border-white/15 bg-white/5 px-4 py-2.5 text-left transition-colors hover:bg-white/10 short:py-1.5"
          >
            <ShoppingBag className="h-5 w-5 shrink-0 text-violet-300" />
            <span className="min-w-0">
              <span className="block text-sm font-black">Shop</span>
              <span className="block text-[10px] font-bold text-white/45">Battlefield collection</span>
            </span>
          </button>
        }
        footer={
          <p className="max-w-md text-center text-[11px] leading-relaxed text-white/45 short:hidden">
            Pick a machine and tap a plot twice to build. Your machines earn your gold, and only you can upgrade or
            sell them.
          </p>
        }
      />
    );
  } else if (stage === 'customize') {
    screen = (
      <CrewScreen
        seats={seats}
        watchers={watchers}
        toolbar={stageToolbar}
        leads={leads}
        hostName={hostName}
        iAmReady={iAmReady}
        onReady={online && !isHost ? toggleReady : undefined}
        onBack={local ? closeOffline : isHost ? () => goStage('menu') : undefined}
        onNext={() => goStage('modes')}
      />
    );
  } else {
    // Online the room size decides the seat count -- the effect above keeps
    // `players` on whatever the room actually holds -- so a mode that does not
    // fit the room is shown, and says why, rather than quietly vanishing.
    const cards = MODES.filter((mode) => local || !mode.soloOnly).map((mode) => {
      const misfit = !local && (mode.players === 4 ? roomSize < 3 : roomSize > 2);
      return {
        mode,
        disabled: misfit,
        why: misfit
          ? mode.players === 4
            ? 'Needs a third player in the room.'
            : 'Too many players in the room for two berths.'
          : undefined,
      };
    });
    screen = (
      <ModesScreen
        rules={stageRules}
        onRules={setStageRules}
        cards={cards}
        locked={locked}
        hostName={hostName}
        toolbar={stageToolbar}
        seats={seats}
        watchers={watchers}
        aiLevel={aiLevel}
        onAiLevel={setAiLevel}
        onBack={leads ? () => goStage('customize') : undefined}
        onStart={local ? startSolo : isHost ? startMatch : undefined}
        startNote={
          locked
            ? `${hostName || 'The host'} raises the gates when the field is set.`
            : bots > 0
              ? `${bots === 1 ? 'A' : bots} ${TIERS[aiLevel].label} bot${bots === 1 ? '' : 's'} hold${
                  bots === 1 ? 's' : ''
                } the empty berth${bots === 1 ? '' : 's'}.`
              : watchers.length > 0
                ? `${watchers.length} more in the room will watch this one out.`
                : 'Every berth is taken.'
        }
      />
    );
  }

  return (
    <div className={`relative h-[100dvh] w-full overflow-hidden text-white ${view === 'game' ? '' : 'menu-sky'}`}>
      {screen}

      {showSettings && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
      )}

      {showShop && <ShopPanel coins={coins} onClose={() => setShowShop(false)} />}
    </div>
  );
}

// -- pieces -------------------------------------------------------------------

/**
 * Stage 2: who is holding which berth.
 *
 * Tower Siege has nothing for a player to pick here , no skins, no classes,
 * no loadout of any kind. The berth *is* the identity: it fixes the colour
 * every machine you build wears, whose purse a kill pays, and which side you
 * are on in a siege. So this stage shows the seating rather than inventing a
 * picker for it, and the one thing a guest says here is whether they are set.
 */
function CrewScreen({
  seats,
  watchers,
  toolbar,
  leads,
  hostName,
  iAmReady,
  onReady,
  onBack,
  onNext,
}: {
  seats: CrewSeat[];
  watchers: { uid: string; name: string }[];
  toolbar: ReactNode;
  /** This device moves the room on: playing alone, or holding it. */
  leads: boolean;
  hostName?: string;
  iAmReady: boolean;
  /** Guests only: the platform's ready flag on their own slot. */
  onReady?: () => void;
  onBack?: () => void;
  onNext: () => void;
}) {
  const humans = seats.filter((seat) => !seat.bot).length;
  return (
    <StageFrame
      theme={THEME}
      step={2}
      title="The crew"
      subtitle={`${seats.length} ${seats.length === 1 ? 'berth' : 'berths'} · colours are fixed by seat`}
      onBack={onBack}
      toolbar={toolbar}
      status={
        !leads ? (
          <HostBadge theme={THEME}>{hostName || 'The host'} moves the room on when everyone is set</HostBadge>
        ) : undefined
      }
      footer={
        <ActionBar
          theme={THEME}
          label="Next: Match setup"
          onAction={leads ? onNext : undefined}
          note={
            leads
              ? 'Berths are handed out in a fixed order. Next, the mode and the waves.'
              : iAmReady
                ? `Ready. Waiting for ${hostName || 'the host'} to set the match up...`
                : 'Say when you are ready and the host will see it.'
          }
          side={
            onReady ? (
              <button
                type="button"
                onClick={onReady}
                className={`mb-1 flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-black uppercase tracking-wide transition-colors ${
                  iAmReady
                    ? 'border-emerald-300/50 bg-emerald-400/15 text-emerald-200'
                    : 'border-white/15 bg-white/5 text-white/70'
                }`}
              >
                <Check className="h-3.5 w-3.5" />
                {iAmReady ? 'Ready' : 'Not ready'}
              </button>
            ) : undefined
          }
        />
      }
    >
      <div className="space-y-3 short:space-y-2">
        <p className="text-[11px] leading-relaxed text-white/50 short:hidden">
          One battlefield, one keep, one pool of lives , and every machine on it belongs to the commander who paid for
          it. Your colour is how the field says which are yours: only you can upgrade or sell them, and only their
          kills pay your purse.
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          {seats.map((seat) => (
            <div
              key={seat.key}
              className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/35 p-3 short:p-2"
            >
              <span
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-black text-slate-950 short:h-8 short:w-8"
                style={{ background: seat.colour.main }}
              >
                {seat.bot ? <Bot className="h-5 w-5" /> : seat.seat + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate text-sm font-black">
                  {seat.name}
                  {seat.you && <span className="shrink-0 text-white/45">· you</span>}
                  {seat.host && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
                </span>
                <span className="block text-[10px] font-black uppercase tracking-wider text-white/40">
                  Seat {seat.seat + 1} · {seat.colour.name}
                  {seat.bot ? ' · bot' : ''}
                </span>
              </span>
              {seat.team !== undefined && (
                <span
                  className="shrink-0 rounded-lg bg-white/8 px-2 py-1 text-[9px] font-black"
                  style={{ color: SEATS[seat.seat % 2].light }}
                >
                  TEAM {seat.team}
                </span>
              )}
              {seat.ready !== undefined && (
                <span
                  className={`shrink-0 rounded-lg px-2 py-1 text-[9px] font-black uppercase ${
                    seat.ready ? 'bg-emerald-400/15 text-emerald-200' : 'bg-white/8 text-white/45'
                  }`}
                >
                  {seat.ready ? 'Ready' : 'Hold on'}
                </span>
              )}
            </div>
          ))}
        </div>

        {watchers.length > 0 && (
          <div className="rounded-2xl border border-dashed border-white/15 p-3 short:p-2">
            <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-white/45">
              <Eye className="h-3.5 w-3.5" /> Watching · {watchers.length}
            </p>
            <p className="mt-1 text-[11px] font-bold text-white/55">
              {watchers.map((person) => person.name).join(', ')}
            </p>
            <p className="mt-1 text-[10px] text-white/35">
              The field seats {seats.length}. They can watch this one out from the room.
            </p>
          </div>
        )}

        {humans === 1 && seats.length > 1 && (
          <p className="text-[11px] font-bold text-white/40">
            Empty berths are held by bots. Their rank is set on the next page.
          </p>
        )}
      </div>
    </StageFrame>
  );
}

/**
 * Stage 3: the whole match on one page.
 *
 * The host's copy is the controls; a guest's copy is the same page locked,
 * kept current from the lobby as the host clicks it. See MatchControls.
 */
function ModesScreen({
  rules,
  onRules,
  cards,
  locked,
  hostName,
  toolbar,
  seats,
  watchers,
  aiLevel,
  onAiLevel,
  onBack,
  onStart,
  startNote,
}: {
  rules: MatchRules;
  onRules: (rules: MatchRules) => void;
  /** Every mode this game has; `disabled` is one the live room cannot seat. */
  cards: { mode: SiegeMode; disabled: boolean; why?: string }[];
  locked: boolean;
  hostName?: string;
  toolbar: ReactNode;
  seats: CrewSeat[];
  watchers: { uid: string; name: string }[];
  aiLevel: number;
  onAiLevel: (level: number) => void;
  onBack?: () => void;
  /** Omitted for a guest: the host is the one who raises the gates. */
  onStart?: () => void;
  startNote: string;
}) {
  const bots = seats.filter((seat) => seat.bot).length;
  const chosen = cards.find((card) => card.mode.mode === rules.mode && card.mode.players === rules.players)?.mode;
  const startLabel =
    rules.players === 1
      ? 'Start solo siege'
      : rules.mode === 'alliance'
        ? 'Start co-op'
        : rules.players === 4
          ? 'Start 2v2'
          : 'Start duel';

  return (
    <StageFrame
      theme={THEME}
      step={3}
      title="Match setup"
      subtitle={`${chosen?.name ?? 'Siege'} · ${rules.waves} waves · ${seats.length} ${
        seats.length === 1 ? 'berth' : 'berths'
      }`}
      onBack={onBack}
      toolbar={toolbar}
      status={locked ? <HostBadge theme={THEME}>{hostName || 'The host'} is setting the match up...</HostBadge> : undefined}
      footer={
        <ActionBar
          theme={THEME}
          label={startLabel}
          icon={<Play className="h-4 w-4 fill-current" />}
          onAction={onStart}
          note={startNote}
        />
      }
    >
      <div className="grid gap-5 lg:grid-cols-3 short:gap-3">
        <div className="space-y-5 lg:col-span-2 short:space-y-3">
          <RuleSection theme={THEME} title="Game mode" locked={locked}>
            <div className="grid gap-2 sm:grid-cols-2">
              {cards.map(({ mode, disabled, why }) => (
                <ModeCard
                  key={`${mode.mode}-${mode.players}`}
                  theme={THEME}
                  title={mode.name}
                  badge={mode.badge}
                  description={why ? `${mode.hint} ${why}` : mode.hint}
                  icon={mode.icon}
                  selected={rules.mode === mode.mode && rules.players === mode.players}
                  locked={locked || disabled}
                  onSelect={() => onRules({ ...rules, mode: mode.mode, players: mode.players, sends: false })}
                />
              ))}
            </div>
          </RuleSection>

          <RuleSection
            theme={THEME}
            title="Length"
            hint="Every fifth wave brings a Siege Beast. Hold through the last one and the keep has won."
            locked={locked}
          >
            <OptionGroup
              theme={THEME}
              locked={locked}
              columns={3}
              value={rules.waves}
              onChange={(waves) => onRules({ ...rules, waves })}
              options={WAVE_CHOICES.map((count) => ({
                value: count as number,
                label: `${count} waves`,
                sub: WAVE_NOTE[count],
              }))}
            />
          </RuleSection>

          {bots > 0 && (
            <RuleSection
              theme={THEME}
              title="Commander AI"
              hint="How well the bots holding empty berths build."
              locked={locked}
            >
              <OptionGroup
                theme={THEME}
                locked={locked}
                value={aiLevel}
                onChange={onAiLevel}
                options={TIERS.map((tier, i) => ({ value: i, label: tier.label }))}
              />
            </RuleSection>
          )}
        </div>

        <RuleSection
          theme={THEME}
          title={`Berths · ${seats.length}`}
          hint={rules.mode === 'siege' && seats.length > 1 ? 'Teams alternate down the seating.' : undefined}
          locked={locked}
        >
          <div className="space-y-1.5">
            {seats.map((seat) => (
              <div key={seat.key} className="flex items-center gap-2 rounded-xl bg-black/20 p-2">
                <span
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-xs font-black text-slate-950"
                  style={{ background: seat.colour.main }}
                >
                  {seat.bot ? <Bot className="h-3.5 w-3.5" /> : seat.seat + 1}
                </span>
                <span className={`min-w-0 flex-1 truncate text-xs font-bold ${seat.bot ? 'text-white/45' : ''}`}>
                  {seat.name}
                  {seat.you && <span className="text-white/45"> · you</span>}
                </span>
                {seat.host && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
                {seat.team !== undefined && (
                  <span className="shrink-0 text-[9px] font-black" style={{ color: SEATS[seat.seat % 2].light }}>
                    T{seat.team}
                  </span>
                )}
              </div>
            ))}
            {watchers.length > 0 && (
              <p className="flex items-center gap-1.5 px-1 pt-1 text-[10px] font-bold text-white/40">
                <Eye className="h-3 w-3 shrink-0" />
                {watchers.map((person) => person.name).join(', ')} watching
              </p>
            )}
          </div>
        </RuleSection>
      </div>
    </StageFrame>
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
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="panel w-full max-w-sm space-y-5 rounded-[2rem] p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-black">Settings</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-white/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <SettingsHeading>Audio</SettingsHeading>
        <label className="block space-y-2">
          <span className="text-sm font-bold">Sound</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.sfxVolume}
            onChange={(e) => onChange({ ...settings, sfxVolume: Number(e.target.value) })}
            className="w-full accent-amber-400"
          />
        </label>

        <SettingsHeading>Display</SettingsHeading>
        {(
          [
            { key: 'showRanges', label: 'Show every range', hint: 'Rings under all your towers, not only the one you tapped. Busy, and honest about what covers what.' },
            { key: 'shouts', label: 'Banners', hint: 'The big WAVE CLEARED text over the board.' },
          ] as const
        ).map(({ key, label, hint }) => (
          <label key={key} className="flex items-center justify-between gap-3">
            <span className="text-sm font-bold">
              {label}
              <span className="block text-[11px] font-normal text-white/50">{hint}</span>
            </span>
            <input
              type="checkbox"
              checked={settings[key]}
              onChange={(e) => onChange({ ...settings, [key]: e.target.checked })}
              className="h-6 w-6 shrink-0 accent-amber-400"
            />
          </label>
        ))}

        <SettingsHeading>Controls</SettingsHeading>
        <p className="text-[11px] leading-relaxed text-white/50">
          Pick a machine from the bar, then tap a plot twice to build there. Tap one of your own machines to upgrade
          or sell it. There is nothing to rebind: the whole game is one finger.
        </p>
      </div>
    </div>
  );
}

/**
 * Only device preferences live in this panel , audio and what is drawn.
 *
 * Anything that changes how the siege actually plays is a match rule and
 * belongs on stage 3, where the host sets it for the whole room. The two are
 * not interchangeable: every client simulates every keep from one seed, so a
 * rule one of them disagreed about is a divergence rather than a taste.
 */
function SettingsHeading({ children }: { children: ReactNode }) {
  return <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/40">{children}</p>;
}

function ShopPanel({ coins, onClose }: { coins: number; onClose: () => void }) {
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm">
      <div className="panel w-full max-w-lg rounded-[2rem] p-6">
        <div className="flex items-center justify-between"><div><h3 className="text-2xl font-black">Siege Shop</h3><p className="text-xs text-white/45">Cosmetic banners and field styles are arriving next.</p></div><button onClick={onClose} className="rounded-xl p-2 hover:bg-white/10"><ArrowLeft /></button></div>
        <div className="mt-5 grid grid-cols-3 gap-3">{['Royal Gold', 'Ocean Blue', 'Dragon Red'].map((name, i) => <div key={name} className="rounded-2xl border border-white/12 bg-white/5 p-3 text-center"><div className="mx-auto h-16 rounded-xl" style={{background: ['#fbbf24','#22d3ee','#fb7185'][i]}} /><p className="mt-2 text-xs font-black">{name}</p><p className="text-[10px] text-white/40">Coming soon</p></div>)}</div>
        <p className="mt-5 text-center text-sm font-black text-amber-300"><Coins className="mr-1 inline h-4 w-4" />{coins} available</p>
      </div>
    </div>
  );
}
