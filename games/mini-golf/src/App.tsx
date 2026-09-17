import { useCallback, useEffect, useMemo, useState } from 'react';
import { scrimProps, useEscape } from '@shared/ui/dismiss';
import useShortScreen from '@shared/ui/useShortScreen';
import {
  ArrowLeft,
  Bot,
  Check,
  Circle,
  Coins,
  Crown,
  Eye,
  Flag,
  Loader2,
  Lock,
  LogOut,
  Maximize2,
  Play,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react';
import { askHostToEndGame, askToLeaveLobby, isNativeFullscreen, toggleFullscreen, useAutoFullscreen } from './fullscreen';
import { MainMenu } from '@shared/menu/MainMenu';
import { ActionBar, HostBadge, StageFrame } from '@shared/menu/StageFrame';
import { ModeCard, OptionGroup, RuleSection, ToggleOption } from '@shared/menu/MatchControls';
import { MENU_STAGE_FIELD, parseStage } from '@shared/menu/stage';
import type { MenuStage } from '@shared/menu/stage';
import type { MenuTheme } from '@shared/menu/theme';
import { BALLS, FREE_BALLS, drawBall } from './game/balls';
import { SEATS } from './game/rules';
import { TIERS } from './engine/ai';
import { audioService } from './services/audio';
import { GameWallet, reportResult } from './platform/wallet';
import MatchView from './screens/MatchView';
import type { MatchConfig } from './screens/MatchView';
import type { Seat } from './engine/GolfEngine';
import { DEFAULT_RULES, PLAYER_CODES, TURN_SECONDS, packRules, unpackRules } from './types/game';
import type { GameSettings, HoleCount, MatchRules, PlayerCount } from './types/game';
import { createLogger } from '@shared/log/logger';

const log = createLogger('mini-golf');

/**
 * The platform owns the lobby.
 *
 * This game never shows a login screen and never asks for a room code. It
 * reads the room it was handed in the query string, writes only its own slot
 * in it, and lets PlayBuddies decide who is in the round.
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
  sfxVolume: 0.7,
  shouts: true,
};

/** Everything before the round is one of the shared menu stages; see `stage` in App. */
type View = 'shell' | 'game';

/** The same greens and glass the course itself is drawn in. */
const THEME: MenuTheme = {
  tone: 'dark',
  primary: 'bg-emerald-400 text-emerald-950',
  selected: 'border-emerald-300 bg-emerald-400/15',
  accent: 'text-emerald-300',
};

interface LobbyPerson {
  uid: string;
  displayName: string;
  /**
   * The lobby's per-player slot. Fish Eat Fish named it, and every game since
   * has reused it: the security rules name the writable fields one by one, so
   * a new game inventing its own key would simply be refused.
   */
  fishIndex?: number | null;
}

interface Lobby {
  hostId: string;
  players: Record<string, LobbyPerson>;
  matchStarted?: boolean;
  /** The host's rules, packed by `packRules`. Written live while the host is on the match page. */
  matchRules?: number;
  /** Where the room is in the pre-match flow. Host-written; see @shared/menu/stage. */
  menuStage?: string;
}

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;

/**
 * The bot rank for any ball this device fills in automatically online.
 *
 * The tier picker on the match page is only offered offline, so `aiLevel` there
 * is really "how hard should the *practice* bot be" , a preference for solo
 * and couch play. Online it must not leak: picking Pro once to test a round
 * alone and then playing a real one with friends should not quietly make every
 * empty seat merciless. Online bots are always Club.
 */
const ONLINE_AI_LEVEL = 1;

export default function App() {
  const [handoff] = useState(readHandoff);
  const online = Boolean(handoff.room);

  const [view, setView] = useState<View>('shell');
  useAutoFullscreen(online || view === 'game');
  /** The stage for a flow this device runs alone. Online, the lobby's `menuStage` is the one that counts. */
  const [localStage, setLocalStage] = useState<MenuStage>('menu');
  const [showSettings, setShowSettings] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  /** Offline setup: how many people are at this device, and with what ball. */
  const [seatCount, setSeatCount] = useState(1);
  const [seatSkin, setSeatSkin] = useState<Record<number, number>>({});
  /**
   * The player deliberately asked for an offline round.
   *
   * Being signed into a lobby is not the same as wanting to play in it, and the
   * offline menu is reachable from *inside* the room. Without this flag the
   * branch below would rebuild the online config for it anyway , one local
   * ball rather than two, so the second player at the keyboard putted nothing,
   * with the whole Firebase path still running underneath a round that has no
   * peers to talk to.
   */
  const [offlineMatch, setOfflineMatch] = useState(false);
  const [aiLevel, setAiLevel] = useState(1);

  /**
   * The purse belongs to the account, not to this browser.
   *
   * localStorage is still read first so the shop is never blank while the
   * handshake with PlayBuddies is in flight, and it is still written on every
   * change so the game works opened on its own. It is a cache now rather than
   * the record.
   */
  const wallet = useMemo(() => new GameWallet('mini-golf', 'golf_owned'), []);
  const [coins, setCoins] = useState(() => wallet.current.coins);
  const [owned, setOwned] = useState<number[]>(() => [
    ...new Set([...wallet.current.unlocks, ...FREE_BALLS]),
  ]);
  /** Nothing is saved until the account has answered, or declined to. */
  const [walletReady, setWalletReady] = useState(false);

  useEffect(() => {
    wallet.open((purse) => {
      setCoins(purse.coins);
      setOwned([...new Set([...purse.unlocks, ...FREE_BALLS])]);
      setWalletReady(true);
    });
    return () => wallet.close();
  }, [wallet]);

  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('golf_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  /**
   * How the next round is played. The host's copy is the one that counts.
   *
   * Remembered between rounds so a host who prefers six holes does not re-set
   * it every time, but never merged with anything a guest has stored: a
   * guest's copy is only ever a placeholder until the host's rules arrive from
   * the lobby. Saved further down, once this device knows whether it is the
   * one setting them.
   */
  const [rules, setRules] = useState<MatchRules>(() => {
    const saved = localStorage.getItem('golf_rules');
    return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : DEFAULT_RULES;
  });

  // The coin balance is shared with the rest of PlayBuddies on purpose. Coins
  // earned in one game are worth something in the next, which is the only
  // thing that makes a single-player shop feel like part of a platform.
  //
  // Held back until the handshake settles: saving the placeholder balance the
  // moment the game booted would write a stale number straight over the real
  // one, which is how an account ends up back at zero.
  useEffect(() => {
    if (!walletReady) return;
    wallet.save({ coins, unlocks: owned });
  }, [walletReady, coins, owned, wallet]);

  useEffect(() => {
    localStorage.setItem('golf_settings', JSON.stringify(settings));
    audioService.setVolume(settings.sfxVolume);
  }, [settings]);

  // -- platform session -------------------------------------------------------
  //
  // Firebase is imported dynamically, and only down the online path.
  //
  // The SDK is several times the weight of the entire rest of the game, and a
  // solo or couch round never calls into it once. As a static import it became
  // a modulepreload in the built HTML, so every player paid for all of it
  // before the green could draw.
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
          const data = snap.data() as Lobby;
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
            menuStage: data.menuStage,
            matchRules: data.matchRules,
          });
          setLobby(data);
          // The host's rules, applied the moment they land rather than only when
          // the round's start packet arrives. A guest's locked match page shows
          // what the host is choosing as they choose it, and `people` below is
          // sliced by the same player count on every client, so nobody builds a
          // different number of balls from a stale local copy. Compared against
          // `data.hostId` directly: `isHost` still reflects the previous snapshot
          // inside this callback.
          const hostRules = data.matchRules;
          if (typeof hostRules === 'number' && data.hostId !== uid) {
            setRules((current) => (packRules(current) === hostRules ? current : unpackRules(hostRules)));
          }
        },
        () => {
          log.error('lobby:lost');
          setLobbyError('Lost contact with the lobby.');
        },
      );
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [online, uid, handoff.room]);

  /**
   * Everyone in the room, in seat order: the host first, then by uid.
   *
   * Every client has to compute the identical order from data it already has,
   * because a seat index *is* a ball on the wire , a putt names its seat by
   * number, and so does the toss. Arrival order would give two players
   * different ideas about who is the red ball, and so did the "this device
   * first" order this replaces: it made sure the person who pressed Start got
   * a ball, but it also put every client in seat one on its own screen, so a
   * putt from the host landed on a guest's own ball. The host first keeps the
   * guarantee and agrees everywhere.
   */
  const roomPeople = useMemo(() => {
    const hostId = lobby?.hostId;
    return Object.values(lobby?.players ?? {})
      .sort((a, b) => Number(b.uid === hostId) - Number(a.uid === hostId) || a.uid.localeCompare(b.uid))
      .map((p) => ({
        uid: p.uid,
        displayName: p.displayName || 'Player',
        skin: p.fishIndex,
      }));
  }, [lobby]);

  /**
   * Who is playing. Anyone past the host's chosen count is in the room but not
   * in the round: four balls is as many as a small green stays readable with.
   */
  const people = useMemo(() => roomPeople.slice(0, rules.players), [roomPeople, rules.players]);

  const mySkin = uid ? lobby?.players?.[uid]?.fishIndex : undefined;
  const isHost = Boolean(uid && lobby && lobby.hostId === uid);

  // Saved only by the device that sets them. A guest's copy is the host's,
  // applied from the lobby; saving it would quietly replace this player's own
  // preference for the next room they host or the next round they play alone.
  useEffect(() => {
    if (online && !offlineMatch && !isHost) return;
    localStorage.setItem('golf_rules', JSON.stringify(rules));
  }, [rules, online, offlineMatch, isHost]);

  /**
   * The host's chosen player count follows the room, not the other way round.
   *
   * `rules.players` used to be whatever this device remembered from its last
   * round -- often two -- so a host who opened a fresh room with three
   * friends found the seats already decided one of them would be watching,
   * with nothing on screen to say so before Start. This raises it to the
   * smallest count the room actually fits the moment somebody new joins, and
   * never lowers one. It is also why the match page offers no count below the
   * room's size: those cards are locked there rather than left to snap back a
   * moment after the host presses them.
   */
  useEffect(() => {
    // Not for a round this device is playing on its own: the room's size says
    // nothing about how many balls a solo or couch round wants.
    if (!online || offlineMatch || !isHost || !lobby) return;
    const roomSize = Object.keys(lobby.players ?? {}).length;
    const fits = PLAYER_CODES.find((n) => n >= roomSize) ?? PLAYER_CODES[PLAYER_CODES.length - 1];
    if (fits > rules.players) setRules((r) => ({ ...r, players: fits }));
  }, [online, offlineMatch, isHost, lobby, rules.players]);

  useEffect(() => {
    // An offline round is the player's own; the room does not get to start or
    // end it. This guard is also what stops an unrelated lobby update from
    // bouncing a couch round straight back to the room.
    if (!online || offlineMatch) return;
    if (lobby?.matchStarted && mySkin !== undefined && mySkin !== null) setView('game');
    else if (view === 'game') setView('shell');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.matchStarted, mySkin, online, offlineMatch]);

  /**
   * A fresh seed and a fresh toss for every round.
   *
   * The seed builds every green in the round, so it is the entire layout
   * negotiation; the toss is only who tees off on hole one, since after that
   * honours decides it.
   *
   * They are rolled at the door, on the way *out* of a round, and never while
   * one is running: rolling them from an effect keyed on the view fires one
   * render after the green has already mounted, so the engine keeps the course
   * it was built with while the start packet goes out carrying a different
   * seed , and the guest then plays a hole nobody else can see.
   *
   * The toss is kept as a fraction and only becomes a seat when the round is
   * built (see `tossSeat`), because it is drawn before the match page, where
   * the ball count can still change: a seat drawn against the old count would
   * never hand the honour to a ball added since, and clamping one that is now
   * out of range would land on the last ball every time.
   */
  const [session, setSession] = useState(() => ({ seed: randomSeed(), toss: Math.random() }));
  const rollSession = useCallback(() => setSession({ seed: randomSeed(), toss: Math.random() }), []);
  const tossSeat = (players: number) => Math.min(players - 1, Math.floor(session.toss * players));

  const buy = useCallback(
    (index: number) => {
      const price = BALLS[index].price;
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
        console.error('Could not save your ball', e);
      }
    },
    [uid, owned, buy, handoff.room],
  );

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      // The rules ride with the go-signal in the same write, so every guest's
      // snapshot that opens the green also carries the ball count it is built
      // from, even if the live sync below had not landed yet.
      await updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: true, matchRules: packRules(rules) });
    } catch (e) {
      log.error('match:start-failed', { message: String((e as Error)?.message ?? e) });
      console.error('Could not start the round', e);
    }
  }, [isHost, handoff.room, rules]);

  const award = useCallback(
    (won: boolean, strokes: number) => {
      // Something for turning up, more for winning, and a real bonus for a
      // tidy card , a round in level fours pays about double a scrappy one.
      const budget = rules.holes * 4;
      setCoins((c) => c + (won ? 95 : 30) + Math.max(0, budget - strokes) * 7);
      reportResult(won);
    },
    [rules.holes],
  );

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
   * page shows what the host is choosing while they choose it.
   */
  useEffect(() => {
    if (!online || offlineMatch || !isHost || remoteStage !== 'modes' || !lobby) return;
    const packed = packRules(rules);
    if (lobby.matchRules !== packed) void writeLobby({ matchRules: packed });
  }, [online, offlineMatch, isHost, remoteStage, lobby, rules, writeLobby]);

  /**
   * Leaving the round: back to the match page for a rematch, and, online, the
   * host's go-signal comes down with it.
   *
   * `matchStarted` left set breaks a rematch two ways: pressing Start again
   * does nothing, because true to true is not a change the effect above reacts
   * to, while picking a *different* ball is a change, so it launches a round
   * nobody started. Resetting it here, on the way out, also covers the host
   * quitting mid-round, which is what the platform's own End Game does.
   */
  const leaveMatch = useCallback(() => {
    setView('shell');
    rollSession();
    // Offline, the flow is this device's: straight back to its own match page.
    // Online, the room's stage never left the match page, so clearing the flag
    // is all it takes to bring everyone back there.
    if (offlineMatch) {
      setLocalStage('modes');
      return;
    }
    if (!online || !isHost) return;
    void writeLobby({ matchStarted: false });
  }, [online, isHost, offlineMatch, rollSession, writeLobby]);

  const matchConfig = useMemo(
    () => (online && uid && !offlineMatch ? onlineConfig() : offlineConfig()),
    // Rebuild once when the room becomes a match. The previous memo was made
    // while authentication was ready but the roster was still empty, then
    // kept that all-bot lineup when Start was pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.seed, offlineMatch, uid, view],
  );

  // -- onto the first tee -----------------------------------------------------

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
          coins={coins}
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

  /**
   * An empty ball gets a bot.
   *
   * A lobby with one person in it , the platform's solo mode, or simply being
   * first into the room , must still be a round. Two of the earlier games
   * shipped with a version of this that only filled a *partly* full match, so
   * a room of one started with nobody to play against at all.
   */
  function onlineConfig(): MatchConfig {
    // `mode=single` is the platform saying this player pressed its own Solo
    // button. It should mean bots even in the moment before the roster settles,
    // rather than a round that depends on how fast a snapshot arrived.
    const crew = handoff.solo ? people.filter((p) => p.uid === uid) : people;
    const seats: Seat[] = [];
    const localSeats: number[] = [];

    for (let i = 0; i < rules.players; i++) {
      const person = crew[i];
      if (person && person.uid === uid) {
        localSeats.push(i);
        seats.push({
          id: uid ?? 'me',
          name: handoff.displayName || 'You',
          control: 'local',
          aiLevel: ONLINE_AI_LEVEL,
          skin: mySkin ?? FREE_BALLS[0],
        });
      } else if (person) {
        seats.push({
          id: person.uid,
          name: person.displayName,
          control: 'remote',
          aiLevel: ONLINE_AI_LEVEL,
          skin: person.skin ?? otherBall(mySkin ?? FREE_BALLS[0]),
        });
      } else {
        seats.push({
          id: `bot-${i}`,
          name: `${TIERS[ONLINE_AI_LEVEL].label} Bot`,
          control: 'ai',
          aiLevel: ONLINE_AI_LEVEL,
          skin: otherBall(mySkin ?? FREE_BALLS[0]),
        });
      }
    }

    return {
      roomId: handoff.room,
      uid,
      peerUids: crew.filter((p) => p.uid !== uid).map((p) => p.uid),
      isHost,
      seats,
      // Somebody who arrived after the balls were handed out has none; the
      // green still draws, they simply have nothing to putt.
      localSeats,
      aiLevel: ONLINE_AI_LEVEL,
      seed: session.seed,
      first: tossSeat(rules.players),
      rules,
    };
  }

  function offlineConfig(): MatchConfig {
    const first = seatSkin[0] ?? FREE_BALLS[0];
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
          skin: seatSkin[i] ?? (i === 0 ? first : otherBall(first)),
        });
      } else {
        seats.push({
          id: `bot-${i}`,
          // Numbered only when there is more than one, so a one-on-one still
          // reads "Club Bot" rather than "Club Bot 2".
          name: rules.players > 2 ? `${TIERS[aiLevel].label} ${i}` : `${TIERS[aiLevel].label} Bot`,
          control: 'ai',
          aiLevel,
          skin: otherBall(first),
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
      aiLevel,
      seed: session.seed,
      first: tossSeat(rules.players),
      rules,
    };
  }

  // -- the pre-match flow -----------------------------------------------------

  const openOffline = (locals: number) => {
    audioService.unlock();
    rollSession();
    setOfflineMatch(true);
    setSeatCount(locals);
    setSeatSkin({});
    // Everybody at this device needs a ball of their own; the match page will
    // not offer fewer, so start from a count that already fits.
    if (rules.players < locals) setRules((r) => ({ ...r, players: locals as PlayerCount }));
    setLocalStage('customize');
  };

  const closeOffline = () => {
    setOfflineMatch(false);
    setLocalStage('menu');
  };

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
    <div className="panel flex items-center gap-1.5 rounded-2xl px-3 py-2.5 font-bold text-amber-300 short:py-2">
      <Coins className="h-4 w-4" /> {coins}
    </div>
  );
  const toolButton = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <button onClick={onClick} aria-label={label} title={label} className="panel rounded-2xl p-2.5 short:p-2">
      {icon}
    </button>
  );
  /** The same tray on both setup pages: purse, fullscreen, settings, and the host's switch that ends it for everyone. */
  const stageToolbar = (
    <>
      <span className="hidden sm:block">{coinChip}</span>
      {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
      {toolButton('Settings', <SettingsIcon className="h-5 w-5" />, () => setShowSettings(true))}
      {!local && isHost && toolButton('End the round for everyone', <LogOut className="h-5 w-5" />, askHostToEndGame)}
    </>
  );

  let screen: React.ReactNode;
  if (!local && lobbyError) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-2xl font-black">{lobbyError}</h2>
        <p className="text-sm text-white/60">Head back to the PlayBuddies lobby and try again.</p>
      </div>
    );
  } else if (!local && (!authChecked || !uid || !lobby)) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-emerald-300" />
        <p className="font-bold text-white/80">Checking in at the pro shop…</p>
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
        onMulti={
          online && !handoff.solo
            ? () => {
                audioService.unlock();
                goStage('customize');
              }
            : undefined
        }
        onSettings={() => setShowSettings(true)}
        multiHint={`Everyone in this room · ${roomPeople.length} on the tee`}
        toolbar={
          <>
            {coinChip}
            {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
            {toolButton('Leave', <LogOut className="h-5 w-5" />, askToLeaveLobby)}
          </>
        }
        title={
          <>
            <div className="mb-3 inline-block rounded-3xl bg-emerald-400/20 p-4 short:hidden">
              <Flag className="h-12 w-12 text-emerald-200" />
            </div>
            <h1 className="text-4xl font-black leading-none tracking-tighter drop-shadow-lg sm:text-6xl short:text-3xl">
              MINI <span className="text-emerald-300">GOLF</span>
            </h1>
            <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.3em] text-white/70">
              Top-down, one putt at a time
            </p>
          </>
        }
        secondary={
          <button
            onClick={() => openOffline(2)}
            disabled={online && !isHost}
            className="w-full rounded-2xl border border-white/15 bg-white/5 py-2.5 text-sm font-black text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40 short:py-1.5"
          >
            Two players, one device
            <span className="block text-[10px] font-bold text-white/45">
              Turns alternate. Whoever is up drags back and lets go.
            </span>
          </button>
        }
        footer={
          <p className="max-w-md text-center text-[11px] leading-relaxed text-white/45 short:hidden">
            Drag back from anywhere and release. Further back is harder; the line is the line. Bank off the blocks,
            stay out of the ponds, and get down in fewer than everybody else.
            {!online && (
              <span className="mt-1 block text-white/35">
                Playing online? Start a lobby on PlayBuddies and pick this game.
              </span>
            )}
          </p>
        }
      />
    );
  } else if (stage === 'customize') {
    const slots: BallSlot[] = local
      ? Array.from({ length: seatCount }, (_, i) => ({
          key: String(i),
          label: seatCount > 1 ? `Player ${i + 1}` : 'You',
          skin: seatSkin[i],
          editable: true,
        }))
      : roomPeople.map((p) => ({
          key: p.uid,
          label: p.displayName,
          skin: p.skin,
          editable: p.uid === uid,
          isHost: p.uid === lobby?.hostId,
        }));
    // Only balls actually in the round hold the room up. Anyone past the count
    // can still pick one, but nobody waits on them to.
    const waiting = local
      ? slots.filter((s) => !hasBall(s.skin)).length
      : people.filter((p) => !hasBall(p.skin)).length;
    screen = (
      <CustomizeScreen
        slots={slots}
        owned={owned}
        coins={coins}
        toolbar={stageToolbar}
        leads={local || isHost}
        hostName={hostName}
        waiting={waiting}
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
    // Built the same way onlineConfig and offlineConfig build the round, so the
    // page shows exactly who Tee off is about to put on the green.
    const crew = handoff.solo ? people.filter((p) => p.uid === uid) : people;
    const lineup: TeeSlot[] = [];
    for (let i = 0; i < rules.players; i++) {
      const person = local ? undefined : crew[i];
      if (local && i < seatCount) {
        lineup.push({ key: `seat-${i}`, name: seatCount > 1 ? `Player ${i + 1}` : 'You', skin: seatSkin[i] });
      } else if (person) {
        lineup.push({
          key: person.uid,
          name: person.displayName,
          skin: person.skin,
          you: person.uid === uid,
          host: person.uid === lobby?.hostId,
        });
      } else {
        const tier = TIERS[local ? aiLevel : ONLINE_AI_LEVEL].label;
        lineup.push({ key: `bot-${i}`, name: local && rules.players > 2 ? `${tier} ${i}` : `${tier} Bot`, bot: true });
      }
    }
    const watching = local ? [] : roomPeople.slice(rules.players).map((p) => p.displayName);
    const bots = lineup.filter((s) => s.bot).length;
    const waitingFor = local ? 0 : crew.filter((p) => !hasBall(p.skin)).length;
    // The auto-fit effect above never lets an online round seat fewer balls
    // than the room fills, so the page does not offer those counts either.
    const roomFits = PLAYER_CODES.find((n) => n >= roomPeople.length) ?? PLAYER_CODES[PLAYER_CODES.length - 1];
    screen = (
      <ModesScreen
        rules={rules}
        locked={!local && !isHost}
        local={local}
        minPlayers={local ? seatCount : roomFits}
        hostName={hostName}
        toolbar={stageToolbar}
        lineup={lineup}
        watching={watching}
        onRules={setRules}
        aiLevel={aiLevel}
        onAiLevel={local && bots > 0 ? setAiLevel : undefined}
        onBack={local || isHost ? () => goStage('customize') : undefined}
        onStart={
          local || isHost
            ? () => {
                audioService.unlock();
                if (local) setView('game');
                else void startMatch();
              }
            : undefined
        }
        startDisabled={waitingFor > 0}
        startNote={
          !local && !isHost
            ? `${hostName || 'The host'} tees off when everyone is set.`
            : waitingFor > 0
              ? `Waiting on ${waitingFor} more to pick a ball. Go back a step so they can.`
              : bots > 0
                ? `Bots play ${bots} of the ${rules.players} balls. Who tees off first is drawn at the start.`
                : 'Who tees off first is drawn at the start.'
        }
      />
    );
  }

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden">
      {screen}

      {showSettings && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

/** The round in one line, for anyone who wants to know what they are walking onto. */
function rulesSummary(rules: MatchRules): string {
  return [
    `${rules.holes} ${rules.holes === 1 ? 'hole' : 'holes'}`,
    `${rules.players} ${rules.players === 1 ? 'ball' : 'balls'}`,
    rules.hazards ? 'water and sand' : 'clean greens',
    rules.turnTimer ? `${TURN_SECONDS}s turns` : 'no clock',
  ].join(' · ');
}

/** Whether a lobby slot or a seat at this device has chosen a ball yet. */
function hasBall(skin: number | null | undefined): skin is number {
  return skin !== undefined && skin !== null;
}

/** A bot plays something other than the ball the player picked. */
function otherBall(playerChoice: number) {
  const options = FREE_BALLS.filter((i) => i !== playerChoice);
  return options[Math.floor(Math.random() * options.length)] ?? 0;
}

// -- pieces -------------------------------------------------------------------

/** A ball card, drawn with the same code the green uses. */
function Portrait({ index, seat = 0, size = 72 }: { index: number; seat?: number; size?: number }) {
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
      drawBall(ctx, {
        skin: index,
        x: size * 0.5,
        y: size * 0.5,
        r: size * 0.3,
        ring: SEATS[seat % SEATS.length].main,
      });
    },
    [index, seat, size],
  );
  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

function BallGrid({
  owned,
  coins,
  seat = 0,
  selected,
  pickedBy,
  onPick,
}: {
  owned: number[];
  coins: number;
  /** Which ball in the round this player is putting: the card rings match the green. */
  seat?: number;
  selected: number | null;
  /**
   * Everyone else who has also picked this ball. Purely informational , the
   * pattern is cosmetic and the coloured ring is what tells balls apart, so
   * nothing stops two players choosing the same one.
   */
  pickedBy: Record<number, string[]>;
  onPick: (index: number) => void;
}) {
  // 165px a card is nearly half a landscape phone. Sideways, keep the ball and
  // its name and drop the rest.
  const short = useShortScreen();
  return (
    <div className={`grid ${short ? 'grid-cols-5 gap-2' : 'grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'}`}>
      {BALLS.map((ball, index) => {
        const isOwned = owned.includes(index);
        const others = pickedBy[index] ?? [];
        const isSelected = selected === index;
        const affordable = coins >= ball.price;

        return (
          <button
            key={ball.name}
            onClick={() => onPick(index)}
            disabled={!isOwned && !affordable}
            className={`relative flex flex-col items-center overflow-hidden rounded-2xl border text-center transition-colors ${
              short ? 'gap-0.5 p-1.5' : 'gap-1.5 p-3'
            } ${
              isSelected
                ? 'border-emerald-300 bg-emerald-400/20 shadow-[0_0_0_3px_rgba(52,211,153,0.25)]'
                : isOwned
                  ? 'border-white/15 bg-white/10 hover:bg-white/20'
                  : 'border-emerald-300/40 bg-emerald-400/10'
            }`}
          >
            {!isOwned && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[1px]">
                <Lock className="mb-0.5 h-4 w-4 text-emerald-200" />
                <span className="text-[11px] font-black text-emerald-200">{ball.price}</span>
                {!affordable && <span className="text-[9px] font-bold text-rose-300">not enough</span>}
              </div>
            )}
            <Portrait index={index} seat={seat} size={short ? 42 : 72} />
            <span
              className={`font-black uppercase tracking-wide ${short ? 'text-[10px] leading-tight' : 'text-sm'}`}
            >
              {ball.name}
            </span>
            {/*
              No stat bars, because there are no stats. Three identical full
              bars on every card would imply a choice that does not exist, and
              hinting at one is worse than saying plainly that these are paint.
            */}
            <span className="rounded-lg bg-black/25 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.15em] text-white/45 short:hidden">
              Paint only
            </span>
            <span className="text-[10px] leading-tight text-white/50 short:hidden">{ball.blurb}</span>
            {others.length > 0 && (
              <span className="text-[9px] font-black uppercase text-white/40">Also played by {others.join(', ')}</span>
            )}
            {isSelected && (
              <span className="flex items-center gap-1 text-[10px] font-black text-emerald-300">
                <Check className="h-3 w-3" /> picked
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** One person choosing a ball: a player in the room, or a seat at this device. */
interface BallSlot {
  key: string;
  label: string;
  skin: number | null | undefined;
  /** Whether this device picks for this slot. */
  editable: boolean;
  isHost?: boolean;
}

/**
 * Stage 2: the ball.
 *
 * The same screen online and offline. Online each player fills only their own
 * slot and watches everyone else's appear in the strip along the top; on a
 * couch every seat belongs to this device, and the turn to choose passes along
 * on its own as each one is filled.
 */
function CustomizeScreen({
  slots,
  owned,
  coins,
  toolbar,
  leads,
  hostName,
  waiting,
  onPick,
  onBack,
  onNext,
}: {
  slots: BallSlot[];
  owned: number[];
  coins: number;
  toolbar: React.ReactNode;
  /** This device moves the flow on: offline, or the host. */
  leads: boolean;
  hostName?: string;
  /** Balls in the round still to be chosen, by anybody. */
  waiting: number;
  onPick: (key: string, index: number) => void;
  onBack?: () => void;
  onNext: () => void;
}) {
  const mine = slots.filter((s) => s.editable);
  const [activeKey, setActiveKey] = useState(() => mine[0]?.key ?? '');
  const active = mine.find((s) => s.key === activeKey) ?? mine[0];
  const activeSeat = active ? slots.indexOf(active) : 0;

  // On a couch, the next player's turn to choose comes round on its own , the
  // old flow's one real convenience, kept.
  useEffect(() => {
    if (mine.length < 2) return;
    const current = mine.find((s) => s.key === activeKey);
    if (current && !hasBall(current.skin)) return;
    const next = mine.find((s) => !hasBall(s.skin));
    if (next && next.key !== activeKey) setActiveKey(next.key);
  }, [mine, activeKey]);

  const pickedBy = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const s of slots) if (s !== active && hasBall(s.skin)) (map[s.skin] ??= []).push(s.label);
    return map;
  }, [slots, active]);

  const mineWaiting = mine.filter((s) => !hasBall(s.skin)).length;
  const iAmReady = mineWaiting === 0;
  /** Nobody is waiting on anybody else while the only empty balls are this device's. */
  const leadNote =
    waiting === 0
      ? 'Everyone has a ball. Next, the course.'
      : mineWaiting >= waiting
        ? mineWaiting > 1
          ? `Pick a ball for each of the ${mineWaiting} players at this device.`
          : 'Pick a ball to carry on.'
        : `Waiting on ${waiting} more to pick a ball.`;

  return (
    <StageFrame
      theme={THEME}
      step={2}
      title={active && mine.length > 1 ? `${active.label}, pick a ball` : 'Pick your ball'}
      subtitle={`${slots.length} ${slots.length === 1 ? 'golfer' : 'golfers'} · paint only, every ball putts the same`}
      onBack={onBack}
      toolbar={toolbar}
      status={
        !leads ? (
          <HostBadge theme={THEME}>{hostName || 'The host'} sets the course once everyone has a ball</HostBadge>
        ) : undefined
      }
      footer={
        <ActionBar
          theme={THEME}
          label="Next: the course"
          onAction={leads ? onNext : undefined}
          disabled={waiting > 0}
          note={
            leads
              ? leadNote
              : iAmReady
                ? `Ready. Waiting for ${hostName || 'the host'} to set the course up...`
                : 'Pick a ball to be ready.'
          }
        />
      }
    >
      <div className="flex h-full flex-col gap-3 short:gap-2">
        <div className="flex shrink-0 gap-2 overflow-x-auto overscroll-contain pb-1">
          {slots.map((s, i) => (
            <button
              key={s.key}
              type="button"
              disabled={!s.editable || mine.length < 2}
              onClick={() => setActiveKey(s.key)}
              className={`flex shrink-0 items-center gap-2 rounded-2xl border px-2 py-1.5 text-left disabled:cursor-default ${
                s === active && mine.length > 1 ? THEME.selected : 'border-white/10 bg-black/20'
              }`}
            >
              <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-black/25">
                {hasBall(s.skin) ? (
                  <Portrait index={s.skin} seat={i} size={36} />
                ) : (
                  <Circle className="h-4 w-4 text-white/35" />
                )}
              </span>
              <span className="min-w-0">
                <span className="flex max-w-[120px] items-center gap-1 truncate text-xs font-black">
                  {s.label}
                  {s.isHost && <Crown className="h-3 w-3 shrink-0 text-amber-300" />}
                </span>
                <span
                  className={`block text-[9px] font-black uppercase tracking-wider ${
                    hasBall(s.skin) ? 'text-emerald-300' : 'text-white/40'
                  }`}
                >
                  {hasBall(s.skin) ? `Ready · ${BALLS[s.skin]?.name ?? 'Ball'}` : 'Choosing...'}
                </span>
              </span>
            </button>
          ))}
        </div>

        {/* The purse rides in the toolbar from `sm:` up, where there is room for it. */}
        <p className="flex shrink-0 items-center justify-center gap-1.5 text-[11px] font-black text-amber-300 sm:hidden">
          <Coins className="h-3.5 w-3.5" /> {coins}
        </p>

        <div className="min-h-0 flex-1">
          {active ? (
            <BallGrid
              owned={owned}
              coins={coins}
              seat={activeSeat}
              selected={active.skin ?? null}
              pickedBy={pickedBy}
              onPick={(index) => onPick(active.key, index)}
            />
          ) : (
            <p className="py-10 text-center text-sm font-bold text-white/55">
              Every ball in this round is spoken for. You can watch it from the clubhouse.
            </p>
          )}
        </div>
      </div>
    </StageFrame>
  );
}

/** One ball in the round, in seat order: a player, or the bot that fills it. */
interface TeeSlot {
  key: string;
  name: string;
  skin?: number | null;
  bot?: boolean;
  you?: boolean;
  host?: boolean;
}

/**
 * How many balls the round is played with , the only thing here that changes
 * the shape of a match rather than a detail of it, so it gets the cards.
 *
 * There is no stroke play versus skins versus speed golf, because there is one
 * way to win a round: the lowest card after the last hole. Inventing the other
 * two here would be inventing them in the menu only.
 */
const BALL_MODES: { players: PlayerCount; title: string; description: string }[] = [
  { players: 1, title: 'Solo card', description: 'Just you and the card. Beat par and take the coins.' },
  { players: 2, title: 'Head to head', description: 'One other ball. The lower card takes the round.' },
  { players: 3, title: 'Group of three', description: 'The green widens a little so nobody tees off inside anybody else.' },
  { players: 4, title: 'Group of four', description: 'As many balls as a small green stays readable with.' },
];

const HOLE_OPTIONS: { value: HoleCount; label: string; sub: string }[] = [
  { value: 1, label: '1 hole', sub: 'one and done' },
  { value: 3, label: '3 holes', sub: 'a quick round' },
  { value: 6, label: '6 holes', sub: 'the full round' },
];

/**
 * Stage 3: the whole round on one page, never a popup.
 *
 * The host's copy is the controls; a guest's copy is the same page with every
 * control locked, kept current from the lobby as the host clicks. See
 * MatchControls for the pieces, and the `matchRules` effect in App for the
 * wire that keeps the two in step.
 */
function ModesScreen({
  rules,
  locked,
  local,
  minPlayers,
  hostName,
  toolbar,
  lineup,
  watching,
  onRules,
  aiLevel,
  onAiLevel,
  onBack,
  onStart,
  startDisabled,
  startNote,
}: {
  rules: MatchRules;
  locked: boolean;
  /** This device's own round: solo, couch, or the game opened on its own. */
  local: boolean;
  /** The fewest balls this round can be played with: everyone here, or everyone in the room. */
  minPlayers: number;
  hostName?: string;
  toolbar: React.ReactNode;
  lineup: TeeSlot[];
  /** Anyone in the room past the last ball. */
  watching: string[];
  onRules: (rules: MatchRules) => void;
  aiLevel: number;
  /** Omitted online, where bots always putt at Club, and when no bot is playing. */
  onAiLevel?: (level: number) => void;
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
      title="Course setup"
      subtitle={rulesSummary(rules)}
      onBack={onBack}
      toolbar={toolbar}
      status={
        locked ? <HostBadge theme={THEME}>{hostName || 'The host'} is setting the course up...</HostBadge> : undefined
      }
      footer={
        <ActionBar
          theme={THEME}
          label="Tee off"
          icon={<Play className="h-4 w-4 fill-current" />}
          onAction={onStart}
          disabled={startDisabled}
          note={startNote}
        />
      }
    >
      <div className="grid gap-5 lg:grid-cols-3 short:gap-3">
        <div className="space-y-5 lg:col-span-2 short:space-y-3">
          <RuleSection
            theme={THEME}
            title="Balls on the green"
            hint={
              local
                ? minPlayers > 1
                  ? 'Everybody at this device needs one. Any left over are played by bots.'
                  : 'Any ball nobody takes is played by a bot.'
                : 'Everyone in the room gets one, up to four. Any left over are played by bots.'
            }
            locked={locked}
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {BALL_MODES.map((mode) => (
                <ModeCard
                  key={mode.players}
                  theme={THEME}
                  title={mode.title}
                  badge={`${mode.players} ${mode.players === 1 ? 'ball' : 'balls'}`}
                  description={mode.description}
                  icon={mode.players === 1 ? <Flag className="h-4 w-4" /> : <Users className="h-4 w-4" />}
                  selected={rules.players === mode.players}
                  locked={locked || mode.players < minPlayers}
                  onSelect={() => set({ players: mode.players })}
                />
              ))}
            </div>
          </RuleSection>

          <RuleSection
            theme={THEME}
            title="Holes"
            hint="Every one is built fresh from the round's seed. Cards run cumulatively; the lowest total takes it."
            locked={locked}
          >
            <OptionGroup
              theme={THEME}
              locked={locked}
              value={rules.holes}
              onChange={(holes) => set({ holes })}
              options={HOLE_OPTIONS}
            />
          </RuleSection>

          <RuleSection theme={THEME} title="The course" locked={locked}>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleOption
                theme={THEME}
                label="Water and sand"
                hint="Ponds cost a stroke and a drop on the bank; bunkers just kill the roll. Off leaves the blocks, which are the ones worth banking off."
                value={rules.hazards}
                locked={locked}
                onChange={(hazards) => set({ hazards })}
              />
              <ToggleOption
                theme={THEME}
                label={`Turn clock · ${TURN_SECONDS}s`}
                hint="A putt goes off on its own after twenty seconds, straight at the flag at a sane weight. Off lets a turn take as long as it takes."
                value={rules.turnTimer}
                locked={locked}
                onChange={(turnTimer) => set({ turnTimer })}
              />
            </div>
          </RuleSection>

          {onAiLevel && (
            <RuleSection theme={THEME} title="Bot rank" hint="How well the bots on the empty balls putt.">
              <OptionGroup
                theme={THEME}
                value={aiLevel}
                onChange={onAiLevel}
                options={TIERS.map((tier, i) => ({ value: i, label: tier.label }))}
              />
            </RuleSection>
          )}
        </div>

        <div className="space-y-4 short:space-y-2">
          <RuleSection
            theme={THEME}
            title={`On the tee · ${lineup.length}`}
            hint="Who plays which ball. Who tees off on hole one is drawn at the start; after that, honours."
            locked={locked}
          >
            <div className="space-y-1.5">
              {lineup.map((s, i) => (
                <div
                  key={s.key}
                  className="flex items-center gap-2 rounded-xl border p-1.5"
                  style={{
                    borderColor: `${SEATS[i % SEATS.length].main}55`,
                    background: `${SEATS[i % SEATS.length].main}18`,
                  }}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/25">
                    {hasBall(s.skin) ? (
                      <Portrait index={s.skin} seat={i} size={36} />
                    ) : s.bot ? (
                      <Bot className="h-4 w-4 text-white/45" />
                    ) : (
                      <Circle className="h-4 w-4 text-white/35" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`flex items-center gap-1 truncate text-xs font-bold ${s.bot ? 'text-white/55' : ''}`}>
                      {s.name}
                      {s.you && <span className="shrink-0 text-white/45"> · you</span>}
                      {s.host && <Crown className="h-3 w-3 shrink-0 text-amber-300" />}
                    </span>
                    <span
                      className="block text-[9px] font-black uppercase tracking-widest"
                      style={{ color: SEATS[i % SEATS.length].light }}
                    >
                      {SEATS[i % SEATS.length].name}
                      {!s.bot && !hasBall(s.skin) && ' · choosing'}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            {watching.length > 0 && (
              <p className="flex items-start gap-1.5 rounded-xl bg-black/25 px-2 py-1.5 text-[10px] font-bold leading-snug text-white/45">
                <Eye className="mt-0.5 h-3 w-3 shrink-0" /> Watching this one: {watching.join(', ')}
              </p>
            )}
          </RuleSection>

          <div className="rounded-2xl bg-black/25 p-3 text-[11px] leading-relaxed text-white/50 short:hidden">
            <p className="mb-1 font-black uppercase tracking-[0.15em] text-white/40">Always true</p>
            <p>Every green is a rectangle or a half-round, and every one of them can be finished.</p>
            <p className="mt-1">A ball rolling too fast rides straight over the cup. Weight matters as much as line.</p>
            <p className="mt-1">Five over par and the ball is picked up, scored, and the round moves on.</p>
          </div>
        </div>
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
  /**
   * This device only.
   *
   * The hole count, the ball count and the hazards used to live here and no
   * longer do: they change what the round *is*, so everybody has to agree on
   * them. They are Round Rules now, set by the host. What is left is genuinely
   * local , how loud it is, and whether this player wants to be shouted at.
   */
  // Escape closes it too. See @shared/ui/dismiss.
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-6 overflow-y-auto overscroll-contain rounded-[2rem] bg-slate-900/90 p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-black">Settings</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-white/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-sm font-bold">
            <span>Club and cup</span>
            <span>{Math.round(settings.sfxVolume * 100)}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={settings.sfxVolume}
            onChange={(e) => onChange({ ...settings, sfxVolume: parseFloat(e.target.value) })}
            className="w-full accent-emerald-400"
          />
        </div>

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold">
            Call the shots
            <span className="block text-[11px] font-normal text-white/50">
              HOLE IN ONE!, IN THE DRINK!, BUNKERED and the rest, over the green. Off keeps the scorecard and
              drops the commentary.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.shouts}
            onChange={(e) => onChange({ ...settings, shouts: e.target.checked })}
            className="h-6 w-6 shrink-0 accent-emerald-400"
          />
        </label>
      </div>
    </div>
  );
}
