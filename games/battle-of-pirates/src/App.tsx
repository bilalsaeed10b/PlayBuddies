import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { scrimProps, useEscape } from '@shared/ui/dismiss';
import useShortScreen from '@shared/ui/useShortScreen';
import {
  Anchor,
  ArrowLeft,
  Bug,
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
  Target,
  Trophy,
} from 'lucide-react';
import { askHostToEndGame, askToLeaveLobby, isNativeFullscreen, toggleFullscreen, useAutoFullscreen } from './fullscreen';
import { MainMenu } from '@shared/menu/MainMenu';
import { ActionBar, HostBadge, StageFrame } from '@shared/menu/StageFrame';
import { ModeCard, OptionGroup, RuleSection, ToggleOption } from '@shared/menu/MatchControls';
import { MENU_STAGE_FIELD, parseStage } from '@shared/menu/stage';
import type { MenuStage } from '@shared/menu/stage';
import type { MenuTheme } from '@shared/menu/theme';
import { ANIMATED_ORNAMENTS, BADGE_LABEL, FREE_SHIPS, SHIPS, badgeShipsFor, drawShip } from './game/ships';
import type { ShipGrants } from './game/ships';
import { WEATHER_CHOICES, weatherFor, wetWeather } from './game/weather';
import { DEFAULT_HULL_INDEX, HULLS, getHullStatDots } from './game/hulls';
import { BALANCE, CARDS, CARD_ORDER, TEAM_COLORS } from './game/rules';
import { TIERS } from './engine/ai';
import { audioService } from './services/audio';
import { GameWallet, reportResult } from './platform/wallet';
import { accuracy, clearStats, currentWeekId, favouriteCard, readStats, recordBattle } from './platform/stats';
import type { MatchRecord, Stats } from './platform/stats';
import BattleView, { MatchConfig } from './screens/BattleView';
import type { Seat } from './engine/BattleEngine';
import { DEFAULT_RULES, PLAYER_CODES, packRules, unpackRules } from './types/game';
import { createLogger } from '@shared/log/logger';
import type { GameSettings, MatchRules, MountainRule, PlayerCount, Team } from './types/game';

const log = createLogger('battle-of-pirates');

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
  lowPower: false,
};

/** Everything before the battle is one of the shared menu stages; see `stage` in App. */
type View = 'shell' | 'game';

const THEME: MenuTheme = {
  tone: 'dark',
  primary: 'bg-amber-400 text-slate-900',
  selected: 'border-amber-400 bg-amber-400/15',
  accent: 'text-amber-300',
};

interface LobbyPerson {
  uid: string;
  displayName: string;
  /**
   * The lobby's per-player slot. Fish Eat Fish named it, Volley Clash reuses
   * it, and so does this: the security rules name the writable fields one by
   * one, so a new game inventing its own key would simply be refused.
   */
  fishIndex?: number | null;
  /**
   * This player's hull class, as an index into HULLS.
   *
   * `role` is the lobby's other per-player slot -- Neon Elements' fire/water
   * pick, from a game that no longer exists. firestore.rules still names it
   * as writable by its owner and nothing on the platform reads it, so it is
   * the one free field a game can claim. It has to travel through the lobby
   * rather than over the wire because the class is baked into every hull at
   * the moment each client builds its own engine, and all of them build it
   * from this same document before a shot is fired.
   */
  role?: number | null;
  /** Written by the PlayBuddies lobby, not this game -- see the roster chips in RoomScreen. */
  photoURL?: string;
  /** The platform's own ready toggle, opt-out by default. Same doc, same reason `photoURL` is here. */
  isReady?: boolean;
}

type BattleTeams = Record<string, Team>;

/**
 * The host freezes this exact crew into the lobby with the start signal.
 * Every device builds its engine from it, rather than from a lobby snapshot
 * that can still be catching up as the battle view opens.
 */
interface BattleCaptain {
  uid: string;
  displayName: string;
  skin: number;
  hull: number;
  team: Team;
}

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;
const coinFlip = (): Team => (Math.random() < 0.5 ? 0 : 1);

export default function App() {
  const [handoff] = useState(readHandoff);
  const online = Boolean(handoff.room);

  const [view, setView] = useState<View>('shell');
  useAutoFullscreen(online || view === 'game');
  /** The stage for a flow this device runs alone. Online, the lobby's `menuStage` is the one that counts. */
  const [localStage, setLocalStage] = useState<MenuStage>('menu');
  const [showSettings, setShowSettings] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [lobby, setLobby] = useState<{
    hostId: string;
    players: Record<string, LobbyPerson>;
    battleTeams?: BattleTeams;
    battleRoster?: BattleCaptain[];
    battleSeed?: number;
    battleFirst?: Team;
    matchStarted?: boolean;
    matchRules?: number;
    menuStage?: string;
  } | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  /** Offline setup: how many people are at this device, and as what. */
  const [seatCount, setSeatCount] = useState(1);
  const [seatSkin, setSeatSkin] = useState<Record<number, number>>({});
  /** Offline: which hull class each person at this device is sailing. */
  const [seatHull, setSeatHull] = useState<Record<number, number>>({});
  /**
   * The player deliberately asked for an offline battle.
   *
   * Being signed into a lobby is not the same as wanting to play in it, and
   * the offline menu is reachable from *inside* the room. Without this flag the
   * branch below rebuilt the online config for it anyway: one local seat rather
   * than two, so the second player at the keyboard drove nothing, with the
   * whole Firebase and WebRTC path still running underneath a battle that has
   * no peers to talk to.
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
  const wallet = useMemo(() => new GameWallet('battle-of-pirates', 'pirates_owned'), []);
  const [coins, setCoins] = useState(() => wallet.current.coins);
  const [owned, setOwned] = useState<number[]>(() => [
    ...new Set([...boughtOnly(wallet.current.unlocks), ...FREE_SHIPS]),
  ]);
  /** Tester badges on the account, which unlock the two badge hulls. */
  const [grants, setGrants] = useState<ShipGrants>({});
  /**
   * Everything this captain may fly: what they bought or started with, plus
   * whatever their badges unlock. Kept apart from `owned` because `owned` is
   * what gets saved, and a badge hull saved as a purchase would outlive the
   * badge if an admin ever took it back.
   */
  const flyable = useMemo(() => [...new Set([...owned, ...badgeShipsFor(grants)])], [owned, grants]);
  /** Nothing is saved until the account has answered, or declined to. */
  const [walletReady, setWalletReady] = useState(false);

  useEffect(() => {
    wallet.open((purse) => {
      setCoins(purse.coins);
      setOwned([...new Set([...boughtOnly(purse.unlocks), ...FREE_SHIPS])]);
      setGrants(purse.grants ?? {});
      setWalletReady(true);
    });
    return () => wallet.close();
  }, [wallet]);
  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('pirates_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  /**
   * How the next battle is played. The host's copy is the one that counts.
   *
   * Remembered between battles so a host who prefers a solid mountain does not
   * re-set it every round, but never merged with anything a guest has stored:
   * a guest's copy of this is only ever a placeholder until the host's rules
   * arrive on the wire.
   */
  const [rules, setRules] = useState<MatchRules>(() => {
    // Key bumped once, deliberately. Aim arc is meant to be on for a fresh
    // player and only off if someone actually chose that -- but a device that
    // had ever toggled it off under the old key kept getting that `false`
    // forever, merged straight over the true default on every load, with
    // nothing on screen suggesting a stale preference was the reason a
    // beginner-friendly game suddenly stopped being one. A new key means
    // every device starts clean on the documented default again; the very
    // next toggle here writes to `_v2` and persists exactly as before.
    const saved = localStorage.getItem('pirates_rules_v2');
    return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : DEFAULT_RULES;
  });
  /** The captain's log. Read once on boot, replaced after every battle. */
  const [stats, setStats] = useState<Stats>(readStats);
  const [showStats, setShowStats] = useState(false);
  useEffect(() => {
    localStorage.setItem('pirates_rules_v2', JSON.stringify(rules));
  }, [rules]);

  // The picker reads only these aggregate aim totals for the captains beside
  // you. Match history, cards and anything account-related remain local.
  useEffect(() => {
    if (!uid) return;
    void import('./firebase')
      .then(({ db, doc, setDoc, serverTimestamp }) => setDoc(doc(db, 'pirateStats', uid), {
        allTime: { shots: stats.shots, hits: stats.hits },
        week: stats.week,
        updatedAt: serverTimestamp(),
      }))
      .catch((error) => console.warn('Could not publish aim totals', error));
  }, [uid, stats.shots, stats.hits, stats.week]);

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
            battleTeams?: BattleTeams;
            battleRoster?: BattleCaptain[];
            battleSeed?: number;
            battleFirst?: Team;
            matchStarted?: boolean;
            matchRules?: number;
            menuStage?: string;
          };
          if (!data.players?.[uid]) {
            setLobbyError("You are not in this lobby.");
            return;
          }
          setLobbyError(null);
          log.info('lobby:snapshot', {
            hostId: data.hostId,
            iAmHost: data.hostId === uid,
            playerCount: Object.keys(data.players ?? {}).length,
            matchStarted: Boolean(data.matchStarted),
            matchRules: data.matchRules,
          });
          setLobby(data);
          // The host's rules, arriving on the one channel every client is
          // already subscribed to. Without this a guest's `rules.players` is
          // whatever it last was on THIS device -- often the default of 2 --
          // and `people`/`onlineConfig` below slice the roster by it, so a
          // 3v3 with four humans rendered as a duel on every guest: two ships
          // instead of six, and the two who got left out of the seats array
          // could never be given a turn because their identity was never
          // subscribed to on the wire. Compared directly against `data.hostId`
          // rather than the `isHost` variable, which still reflects the
          // *previous* lobby snapshot inside this same callback.
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
   * Sides, decided by a stable sort on uid.
   *
   * Every client computes the same answer from data it already has. Deriving
   * sides from arrival order would give two players different ideas about who
   * is on the left.
   */
  /**
   * Who is sailing, which side they are on, and in what order.
   *
   * Sorted by uid so every client computes the identical answer from data it
   * already has -- arrival order would give two players different ideas about
   * who is on the left. Sides alternate down that sorted list, which splits
   * any even count evenly and puts the same captain on the same anchor
   * everywhere.
   *
   * Anyone past the host's chosen player count is in the room but not in the
   * battle. That is deliberate: the two fleets have to match, so a fifth
   * person in a four-player battle watches rather than making it 3v2.
   */
  const people = useMemo(() => {
    return Object.values(lobby?.players ?? {})
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .slice(0, rules.players)
      .map((p, i) => ({
        uid: p.uid,
        displayName: p.displayName || 'Player',
        skin: p.fishIndex,
        // A player who has not touched the picker sails a Balanced hull, which is
        // the class every number in BALANCE was tuned against.
        hull: typeof p.role === 'number' ? p.role : DEFAULT_HULL_INDEX,
        // A host's explicit placement wins. Alternating remains a stable,
        // balanced default until someone opens team management.
        team: lobby?.battleTeams?.[p.uid] === 1 ? 1 : lobby?.battleTeams?.[p.uid] === 0 ? 0 : (i % 2) as Team,
        photoURL: p.photoURL,
        isReady: Boolean(p.isReady),
      }));
  }, [lobby, rules.players]);

  const isHost = Boolean(uid && lobby && lobby.hostId === uid);

  /**
   * The host's chosen player count follows the room, not the other way round.
   *
   * `rules.players` used to be whatever this device remembered from its last
   * battle -- often two -- so a host who opened a fresh room with three
   * friends found the seats already decided one of them would be watching,
   * with nothing on screen to say so before Start. This raises it to the
   * smallest count the room actually fits the moment somebody new joins, and
   * never on its own lowers a count the host (or an earlier run of this same
   * effect) already set -- so choosing fewer seats than the room on purpose,
   * bots filling the rest, still works exactly as before for whoever wants it.
   */
  useEffect(() => {
    if (!online || !isHost || !lobby) return;
    const roomSize = Object.keys(lobby.players ?? {}).length;
    const fits = PLAYER_CODES.find((n) => n >= roomSize) ?? PLAYER_CODES[PLAYER_CODES.length - 1];
    if (fits > rules.players) setRules((r) => ({ ...r, players: fits }));
  }, [online, isHost, lobby, rules.players]);

  useEffect(() => {
    // An offline battle is the player's own; the room does not get to start or
    // end it. This guard is also what stops an unrelated lobby update from
    // bouncing a couch battle straight back to the room.
    if (!online || offlineMatch) return;
    // `battleRoster` is written with `matchStarted` in the host's one atomic
    // write. Waiting for it prevents four devices from opening a 4-player
    // battle with four different, half-arrived lobby rosters.
    if (
      lobby?.matchStarted &&
      Array.isArray(lobby.battleRoster) &&
      lobby.battleRoster.some((captain) => captain.uid === uid) &&
      typeof lobby.battleSeed === 'number' &&
      (lobby.battleFirst === 0 || lobby.battleFirst === 1)
    ) {
      setSession({ seed: lobby.battleSeed, first: lobby.battleFirst });
      setView('game');
    }
    else if (view === 'game') setView('shell');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.matchStarted, lobby?.battleRoster, lobby?.battleSeed, lobby?.battleFirst, uid, online, offlineMatch]);

  /**
   * A fresh seed and a fresh coin toss for every match.
   *
   * Both are drawn once, and the host is the one whose draw counts online --
   * it sends the two numbers and the guest builds the identical match from
   * them.
   *
   * They are rolled at the door, on the way *out* of a battle, and never while
   * one is running. The obvious version bumped a key from an effect keyed on
   * the view, which fires one render after the battle has already mounted: the
   * engine kept the seed it was built with while the start packet went out
   * carrying the new one. The guest then built a different match, and every
   * shot that arrived was thrown away by the seed check in applyShot -- a
   * duel where neither side ever saw the other fire, which is exactly what a
   * broken turn order looks like from the inside.
   */
  const [session, setSession] = useState(() => ({ seed: randomSeed(), first: coinFlip() }));
  const rollSession = useCallback(() => setSession({ seed: randomSeed(), first: coinFlip() }), []);

  const buy = useCallback(
    (index: number) => {
      // A badge hull is never for sale, whatever its price field says.
      if (SHIPS[index]?.badge) return false;
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
      if (!flyable.includes(index) && !buy(index)) return;
      try {
        // Already loaded by the session effect on this path; the import cache
        // makes this a lookup rather than a second fetch.
        const { db, doc, updateDoc } = await import('./firebase');
        await updateDoc(doc(db, 'lobbies', handoff.room), { [`players.${uid}.fishIndex`]: index });
      } catch (e) {
        console.error('Could not save your ship', e);
      }
    },
    [uid, flyable, buy, handoff.room],
  );

  /**
   * The hull class, into the lobby so every client reads the same one.
   *
   * Free, so unlike `pickOnline` above there is nothing to buy and nothing to
   * check -- every class is available from the first battle by design.
   */
  const pickHullOnline = useCallback(
    async (index: number) => {
      if (!uid) return;
      try {
        const { db, doc, updateDoc } = await import('./firebase');
        await updateDoc(doc(db, 'lobbies', handoff.room), { [`players.${uid}.role`]: index });
      } catch (e) {
        console.error('Could not save your hull', e);
      }
    },
    [uid, handoff.room],
  );

  /** Host-only team assignment, persisted before the match is started. */
  const assignTeam = useCallback(async (targetUid: string, team: Team) => {
    if (!isHost || !lobby?.players[targetUid]) return;
    const ordered = Object.values(lobby.players)
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .slice(0, rules.players)
      .map((p, i) => ({
        uid: p.uid,
        team: lobby.battleTeams?.[p.uid] === 1 ? 1 : lobby.battleTeams?.[p.uid] === 0 ? 0 : (i % 2) as Team,
      }));
    const target = ordered.find((p) => p.uid === targetUid);
    if (!target || target.team === team) return;

    const next: Record<string, Team> = { [`battleTeams.${targetUid}`]: team };
    const capacity = rules.players / 2;
    const destination = ordered.filter((p) => p.team === team && p.uid !== targetUid);
    if (destination.length >= capacity) {
      const swap = destination[destination.length - 1];
      next[`battleTeams.${swap.uid}`] = target.team;
    }

    try {
      const { db, doc, updateDoc } = await import('./firebase');
      await updateDoc(doc(db, 'lobbies', handoff.room), next);
    } catch (e) {
      console.error('Could not assign that team', e);
    }
  }, [isHost, lobby?.players, lobby?.battleTeams, rules.players, handoff.room]);

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      const opening = { seed: randomSeed(), first: coinFlip() };
      const roster: BattleCaptain[] = people.map((person) => ({
        uid: person.uid,
        displayName: person.displayName,
        skin: person.skin ?? FREE_SHIPS[0],
        hull: person.hull,
        team: person.team,
      }));
      // The host changes session before the lobby write resolves, so its own
      // engine and the roster document share the same opening terms too.
      setSession(opening);
      // `matchRules` rides along with the go-signal in the same write, so it
      // lands in every guest's next snapshot at the same instant `matchStarted`
      // does -- there is no room for a guest to flip to the game view on a
      // `rules.players` that hasn't been corrected yet (see the lobby
      // snapshot handler above).
      log.info('host:start-match', { players: rules.players, packed: packRules(rules), roster: roster.map((p) => p.uid) });
      await updateDoc(doc(db, 'lobbies', handoff.room), {
        matchStarted: true,
        matchRules: packRules(rules),
        battleRoster: roster,
        battleSeed: opening.seed,
        battleFirst: opening.first,
      });
    } catch (e) {
      console.error('Could not start the battle', e);
    }
  }, [isHost, handoff.room, people, rules]);

  const award = useCallback((won: boolean, hpLeft: number, record: MatchRecord) => {
    // Something for turning up, more for winning, and a bonus for coming
    // through it with your hull mostly intact.
    setCoins((c) => c + (won ? 95 : 30) + (won ? Math.round(hpLeft / 3) : 0));
    reportResult(won, { sunk: record.sunk });
    setStats(recordBattle(won, record));
  }, []);

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
   * Leaving the battle: back to the match page for a rematch, and, online, the
   * host's go-signal comes down with it.
   *
   * `matchStarted` was never reset anywhere in the two games before this one,
   * and it broke a rematch two different ways: pressing Start again did
   * nothing, because true to true is not a change the effect above reacts to,
   * while picking a *different* ship was a change, so it launched a battle
   * nobody had started. Resetting it here, on the way out, also covers the
   * host quitting mid-match, which is what the platform's own End Game does.
   */
  const leaveBattle = useCallback(() => {
    setView('shell');
    rollSession();
    if (offlineMatch) {
      setLocalStage('modes');
      return;
    }
    if (!online || !isHost) return;
    void writeLobby({ matchStarted: false });
  }, [online, isHost, offlineMatch, rollSession, writeLobby]);

  // -- into the battle --------------------------------------------------------

  /**
   * Frozen for the whole battle, not recomputed on every render.
   *
   * `onlineConfig()` reads the live lobby roster and assigns `team: i % 2`
   * from its current sorted position -- which is fine the moment a match
   * starts, and wrong to keep doing afterward. `config` used to be a plain
   * `const` built fresh on every render, and BattleView's own `myTeam` /
   * `turnTeam` read `config.seats[i].team` directly every frame, not the
   * frozen ships the battle engine actually simulates with. A reconnect, a
   * late spectator, even an unrelated field changing on the lobby doc, was
   * enough to re-sort that roster and flip a captain's array index -- the
   * engine kept fighting the identical battle it started, but the HUD would
   * occasionally announce a different captain as your teammate mid-fight.
   * Capture again when entering the game, after the lobby and picks have
   * settled. Freezing only by seed could otherwise retain an empty menu roster.
   */
  const battleConfig = useMemo(
    () => (online && uid && !offlineMatch ? onlineConfig() : offlineConfig()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.seed, session.first, offlineMatch, uid, view],
  );

  if (view === 'game') {
    return (
      <>
        <BattleView
          config={battleConfig}
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
    // button. It should mean bots even in the moment before the roster
    // settles, rather than a battle that depends on how fast a snapshot
    // arrived.
    // The room continues receiving presence, skin and ready writes while a
    // battle runs. None of those may change the match's identity. In
    // particular, four clients must never turn a slightly different live
    // Firestore snapshot into four different seat indexes. The host's launch
    // packet above is the single, immutable source of truth for this match.
    const frozenCrew: BattleCaptain[] = lobby?.matchStarted && Array.isArray(lobby.battleRoster)
      ? lobby.battleRoster
      : people.map((person) => ({
        uid: person.uid,
        displayName: person.displayName,
        skin: person.skin ?? FREE_SHIPS[0],
        hull: person.hull,
        team: person.team,
      }));
    const matchRules = lobby?.matchStarted && typeof lobby.matchRules === 'number'
      ? unpackRules(lobby.matchRules)
      : rules;
    const crew = handoff.solo ? frozenCrew.filter((p) => p.uid === uid) : frozenCrew;
    const seats: Seat[] = [];
    const localShips: number[] = [];

    // Build each fleet separately. That keeps the anchors correct even when
    // the host groups friends on one team rather than alternating the roster.
    const perTeam = matchRules.players / 2;
    for (const team of [0, 1] as const) {
      const fleet = crew
        .filter((person) => person.team === team)
        .map((person) => {
          let h = session.seed;
          const str = person.uid || 'bot';
          for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
          return { person, hash: h };
        })
        .sort((a, b) => (a.hash !== b.hash ? a.hash - b.hash : (a.person.uid || '').localeCompare(b.person.uid || '')))
        .map((item) => item.person);
      for (let slot = 0; slot < perTeam; slot++) {
        const person = fleet[slot];
        const seatIndex = seats.length;
        if (person && person.uid === uid) {
          localShips.push(seatIndex);
          seats.push({
            team,
            id: person.uid,
            name: person.displayName,
            control: 'local',
            aiLevel,
            skin: person.skin,
            hull: person.hull,
          });
        } else if (person) {
          seats.push({
            team,
            id: person.uid,
            name: person.displayName,
            control: 'remote',
            aiLevel,
            skin: person.skin,
            hull: person.hull,
          });
        } else {
          // Bots also need deterministic cosmetics. A random roll here does
          // not alter combat, but it makes a mismatched roster much harder to
          // diagnose and gives different clients different visual fleets.
          const botSkin = FREE_SHIPS[Math.abs(session.seed + team * 19 + slot * 37) % FREE_SHIPS.length] ?? FREE_SHIPS[0];
          seats.push({
            team,
            id: `bot-${team}-${slot}`,
            name: `${TIERS[aiLevel].label} Bot`,
            control: 'ai',
            aiLevel,
            skin: botSkin,
            hull: seatIndex % HULLS.length,
          });
        }
      }
    }

    const peerUids = crew.filter((p) => p.uid !== uid).map((p) => p.uid);
    // The exact thing that was silently wrong before: a guest whose local
    // `rules.players` hadn't caught up to the host's built a shorter seats
    // array than the host did. Logged every time this runs so that mismatch
    // is visible across two tabs' logs without having to reproduce it live.
    log.info('seats:built', {
      rulesPlayers: matchRules.players,
      peopleCount: people.length,
      crewCount: crew.length,
      frozen: frozenCrew === lobby?.battleRoster,
      peerUids,
      seatCount: seats.length,
      seats: seats.map((s) => ({ team: s.team, id: s.id, control: s.control })),
      localShips,
      isHost,
    });

    return {
      roomId: handoff.room,
      hostUid: lobby?.hostId,
      uid,
      peerUids,
      isHost,
      seats,
      // A player who arrived after the berths filled up has no hull; the
      // battle still renders, they just have nothing to fire.
      localShips,
      aiLevel,
      seed: session.seed,
      first: session.first,
      rules: matchRules,
    };
  }

  function offlineConfig(): MatchConfig {
    const p1 = seatSkin[0] ?? FREE_SHIPS[0];
    const seats: Seat[] = [];
    const localShips: number[] = [];

    // The fleet-size rule applies offline too, so a solo player can take a
    // wing of bots against a fleet of them. Sides alternate down the list, so
    // the first two berths are opposite each other , which is what makes a
    // couch battle two people facing off rather than sharing a side.
    for (let i = 0; i < rules.players; i++) {
      const team = (i % 2) as Team;
      if (i < seatCount) {
        localShips.push(i);
        seats.push({
          team,
          id: `seat-${i}`,
          name: seatCount > 1 ? `Player ${i + 1}` : 'You',
          control: 'local',
          aiLevel,
          skin: seatSkin[i] ?? (i === 0 ? p1 : pickOtherShip(p1)),
          hull: seatHull[i] ?? 0,
        });
      } else {
        seats.push({
          team,
          id: `bot-${i}`,
          // Numbered only when there is more than one, so a duel still reads
          // "Gunner Bot" rather than "Gunner Bot 2".
          name: rules.players > 2 ? `${TIERS[aiLevel].label} ${i}` : `${TIERS[aiLevel].label} Bot`,
          control: 'ai',
          aiLevel,
          skin: pickOtherShip(p1),
          hull: i % HULLS.length,
        });
      }
    }

    return {
      roomId: null,
      uid: null,
      peerUids: [],
      isHost: true,
      seats,
      localShips,
      aiLevel,
      seed: session.seed,
      first: session.first,
      rules,
    };
  }

  // -- the pre-match flow -----------------------------------------------------

  const openOffline = (players: number) => {
    audioService.unlock();
    rollSession();
    setOfflineMatch(true);
    setSeatCount(players);
    setSeatSkin({});
    setSeatHull({});
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
  const toolButton = (label: string, icon: React.ReactNode, onClick: () => void, extra = '') => (
    <button onClick={onClick} aria-label={label} title={label} className={`panel rounded-2xl p-2.5 short:p-2 ${extra}`}>
      {icon}
    </button>
  );
  const stageToolbar = (
    <>
      <span className="hidden sm:block">{coinChip}</span>
      {!local &&
        toolButton('Friends leaderboard', <Trophy className="h-5 w-5 text-amber-300" />, () => setShowLeaderboard(true), 'hidden sm:block')}
      {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
      {toolButton('Settings', <SettingsIcon className="h-5 w-5" />, () => setShowSettings(true))}
      {!local && isHost && toolButton('End the match for everyone', <LogOut className="h-5 w-5" />, askHostToEndGame)}
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
        <Loader2 className="h-10 w-10 animate-spin text-amber-300" />
        <p className="font-bold text-white/80">Coming alongside...</p>
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
        multiHint={`Everyone in this room · ${people.length} aboard`}
        toolbar={
          <>
            {coinChip}
            {toolButton("Captain's log", <Target className="h-5 w-5 text-sky-300" />, () => setShowStats(true))}
            {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
            {toolButton('Leave', <LogOut className="h-5 w-5" />, askToLeaveLobby)}
          </>
        }
        title={
          <>
            <div className="mb-3 inline-block rounded-3xl bg-amber-400/20 p-4 short:hidden">
              <Anchor className="h-12 w-12 text-amber-300" />
            </div>
            <h1 className="text-4xl font-black leading-none tracking-tighter drop-shadow-lg sm:text-6xl short:text-3xl">
              BATTLE OF <span className="text-amber-300">PIRATES</span>
            </h1>
            <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.3em] text-white/70">Aim, swipe, sink</p>
          </>
        }
        secondary={
          <button
            onClick={() => openOffline(2)}
            disabled={online && !isHost}
            className="w-full rounded-2xl border border-white/15 bg-white/5 py-2.5 text-sm font-black text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40 short:py-1.5"
          >
            Two captains, one device
            <span className="block text-[10px] font-bold text-white/45">Turns alternate on this screen</span>
          </button>
        }
        footer={
          <p className="max-w-md text-center text-[11px] leading-relaxed text-white/45 short:hidden">
            Drag back from anywhere and let go. Further back is more powder; the angle is the angle.
          </p>
        }
      />
    );
  } else if (stage === 'customize') {
    const slots: LoadoutSlot[] = local
      ? Array.from({ length: seatCount }, (_, i) => ({
          key: String(i),
          label: seatCount > 1 ? `Player ${i + 1}` : 'You',
          skin: seatSkin[i],
          hull: seatHull[i] ?? DEFAULT_HULL_INDEX,
          editable: true,
        }))
      : people.map((p) => ({
          key: p.uid,
          label: p.displayName,
          skin: p.skin,
          hull: p.hull,
          photoURL: p.photoURL,
          editable: p.uid === uid,
          isHost: p.uid === lobby?.hostId,
        }));
    screen = (
      <CustomizeScreen
        slots={slots}
        owned={flyable}
        coins={coins}
        toolbar={stageToolbar}
        leads={local || isHost}
        hostName={hostName}
        onPickSkin={(key, index) => {
          if (!local) return void pickOnline(index);
          if (!flyable.includes(index) && !buy(index)) return;
          setSeatSkin((s) => ({ ...s, [Number(key)]: index }));
        }}
        onPickHull={(key, index) => {
          if (!local) return void pickHullOnline(index);
          setSeatHull((h) => ({ ...h, [Number(key)]: index }));
        }}
        onBack={local ? closeOffline : isHost ? () => goStage('menu') : undefined}
        onNext={() => goStage('modes')}
      />
    );
  } else {
    const capacity = rules.players / 2;
    const roster: FleetMember[] = [];
    if (local) {
      for (let i = 0; i < rules.players; i++) {
        roster.push({
          key: `seat-${i}`,
          name: i < seatCount ? (seatCount > 1 ? `Player ${i + 1}` : 'You') : `${TIERS[aiLevel].label} Bot`,
          team: (i % 2) as Team,
          skin: i < seatCount ? seatSkin[i] : undefined,
          bot: i >= seatCount,
        });
      }
    } else {
      for (const p of people) {
        roster.push({ key: p.uid, name: p.displayName, team: p.team, skin: p.skin, you: p.uid === uid, host: p.uid === lobby?.hostId });
      }
      for (const team of [0, 1] as const) {
        const empty = capacity - people.filter((p) => p.team === team).length;
        for (let i = 0; i < empty; i++) {
          roster.push({ key: `bot-${team}-${i}`, name: `${TIERS[aiLevel].label} Bot`, team, bot: true });
        }
      }
    }
    const everyonePicked = people.every((p) => p.skin !== undefined && p.skin !== null);
    const teamsOverfull = ([0, 1] as const).some((team) => people.filter((p) => p.team === team).length > capacity);
    const waitingFor = people.filter((p) => p.skin === undefined || p.skin === null).length;
    const bots = roster.filter((m) => m.bot).length;
    screen = (
      <ModesScreen
        rules={rules}
        locked={!local && !isHost}
        hostName={hostName}
        toolbar={stageToolbar}
        roster={roster}
        onRules={setRules}
        onAssignTeam={!local && isHost && rules.players > 2 ? assignTeam : undefined}
        aiLevel={aiLevel}
        onAiLevel={(local || isHost) && bots > 0 ? setAiLevel : undefined}
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
        startDisabled={!local && (!everyonePicked || teamsOverfull)}
        startNote={
          !local && !isHost
            ? `${hostName || 'The host'} weighs anchor when the fleet is set.`
            : !local && !everyonePicked
              ? `Waiting on ${waitingFor} more to pick a ship.`
              : teamsOverfull
                ? `Move a captain: each fleet holds ${capacity}.`
                : bots > 0
                  ? `Bots sail ${bots} of the ${rules.players} hulls. Who fires first is drawn at the start.`
                  : 'Who fires first is drawn at the start.'
        }
      />
    );
  }

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden text-white">
      {screen}

      {showSettings && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
      )}

      {showLeaderboard && (
        <LeaderboardModal people={people} uid={uid} stats={stats} onClose={() => setShowLeaderboard(false)} />
      )}

      {showStats && (
        <StatsPanel
          stats={stats}
          onClose={() => setShowStats(false)}
          onClear={() => {
            clearStats();
            setStats(readStats());
          }}
        />
      )}
    </div>
  );
}

const MOUNTAIN_LABEL: Record<MountainRule, string> = {
  off: 'No mountain',
  breakable: 'Breakable mountain',
  solid: 'Solid mountain',
};

const MOUNTAIN_HINT: Record<MountainRule, string> = {
  off: 'Open water. Every shot is a flat duel.',
  breakable: 'Stone amidships that crumbles after ten hits, so the lane opens up late in a long battle.',
  solid: 'Never crumbles. The lane over the top is the only lane there is, or a bore shot through it.',
};

/** How a player count reads as a fight. */
function formatSides(players: PlayerCount): string {
  return `${players / 2}v${players / 2}`;
}

/** The rules in one line, for anyone who wants to know what they are sailing into. */
function rulesSummary(rules: MatchRules): string {
  return [
    `${formatSides(rules.players)} · ${rules.players} ships`,
    MOUNTAIN_LABEL[rules.mountain],
    rules.weather === 'random' ? 'random weather' : WEATHER_CHOICES.find(w => w.id === weatherFor(rules))?.name,
    rules.cards ? 'cards on' : 'round shot only',
    rules.turnTimer ? `${BALANCE.TURN_TIME}s turns` : 'no clock',
    rules.aimArc ? 'aim arc on' : 'no aim arc',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * A saved purse with any badge hull taken out.
 *
 * Nothing this build writes puts one there, but a purse is whatever the
 * account says it is, and a badge hull arriving as a "purchase" would stay
 * unlocked after the badge was taken back.
 */
function boughtOnly(unlocks: number[]): number[] {
  return unlocks.filter((i) => !SHIPS[i]?.badge);
}

/** The bot sails something other than what the player picked. */
function pickOtherShip(playerChoice: number) {
  const options = FREE_SHIPS.filter((i) => i !== playerChoice);
  return options[Math.floor(Math.random() * options.length)] ?? 0;
}


/** One person choosing a loadout: an online player, or a seat at this device. */
interface LoadoutSlot {
  key: string;
  label: string;
  skin: number | null | undefined;
  hull: number;
  photoURL?: string;
  /** Whether this device picks for this slot. */
  editable: boolean;
  isHost?: boolean;
}

/**
 * Stage 2: paint and hull.
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
  onPickSkin,
  onPickHull,
  onBack,
  onNext,
}: {
  slots: LoadoutSlot[];
  owned: number[];
  coins: number;
  toolbar: React.ReactNode;
  /** This device moves the flow on: offline, or the host. */
  leads: boolean;
  hostName?: string;
  onPickSkin: (key: string, index: number) => void;
  onPickHull: (key: string, index: number) => void;
  onBack?: () => void;
  onNext: () => void;
}) {
  const mine = slots.filter((s) => s.editable);
  const [activeKey, setActiveKey] = useState(() => mine[0]?.key ?? '');
  const active = mine.find((s) => s.key === activeKey) ?? mine[0];
  /** Paint first, because it is the one with a price on it. */
  const [tab, setTab] = useState<'ship' | 'hull'>('ship');

  const others = slots.filter((s) => s !== active);
  const pickedBy = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const s of others) if (s.skin !== undefined && s.skin !== null) (map[s.skin] ??= []).push(s.label);
    return map;
  }, [others]);
  const hullPickedBy = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const s of others) (map[s.hull] ??= []).push(s.label);
    return map;
  }, [others]);

  const picked = (s: LoadoutSlot) => s.skin !== undefined && s.skin !== null;
  const waiting = slots.filter((s) => !picked(s)).length;
  const iAmReady = mine.every(picked);

  return (
    <StageFrame
      theme={THEME}
      step={2}
      title="Pick your ship"
      subtitle={`${slots.length} ${slots.length === 1 ? 'captain' : 'captains'} · paint and hull`}
      onBack={onBack}
      toolbar={toolbar}
      status={!leads ? <HostBadge theme={THEME}>{hostName || 'The host'} moves the fleet on when everyone is set</HostBadge> : undefined}
      footer={
        <ActionBar
          theme={THEME}
          label="Next: Match rules"
          onAction={leads ? onNext : undefined}
          disabled={waiting > 0}
          note={
            leads
              ? waiting > 0
                ? `Waiting on ${waiting} more to pick a ship.`
                : 'Everyone is set. Next, the rules of the battle.'
              : iAmReady
                ? `Ready. Waiting for ${hostName || 'the host'} to set up the match...`
                : 'Pick a ship to be ready.'
          }
        />
      }
    >
      <div className="flex h-full flex-col gap-3 short:gap-2">
        <div className="flex shrink-0 gap-2 overflow-x-auto overscroll-contain pb-1">
          {slots.map((s) => {
            const selectable = s.editable && mine.length > 1;
            return (
              <button
                key={s.key}
                type="button"
                disabled={!selectable}
                onClick={() => setActiveKey(s.key)}
                className={`flex shrink-0 items-center gap-2 rounded-2xl border px-2 py-1.5 text-left disabled:cursor-default ${
                  s === active && mine.length > 1 ? THEME.selected : 'border-white/10 bg-black/20'
                }`}
              >
                <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-black/25">
                  {picked(s) ? <Portrait index={s.skin as number} size={36} /> : <Anchor className="h-4 w-4 text-white/35" />}
                </span>
                <span className="min-w-0">
                  <span className="flex max-w-[120px] items-center gap-1 truncate text-xs font-black">
                    {s.label}
                    {s.isHost && <Crown className="h-3 w-3 shrink-0 text-amber-300" />}
                  </span>
                  <span className={`block text-[9px] font-black uppercase tracking-wider ${picked(s) ? 'text-emerald-300' : 'text-white/40'}`}>
                    {picked(s) ? `Ready · ${HULLS[s.hull]?.name ?? 'Balanced'}` : 'Choosing...'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {active ? (
          <>
            <div className="flex shrink-0 gap-1 rounded-xl bg-black/30 p-1">
              {(['ship', 'hull'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 rounded-lg py-1.5 text-[11px] font-black uppercase tracking-wider transition-colors ${
                    tab === t ? 'bg-amber-400 text-slate-900' : 'text-white/55'
                  }`}
                >
                  {t === 'ship' ? 'Ship paint' : `Hull class · ${HULLS[active.hull]?.name ?? 'Balanced'}`}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {tab === 'ship' ? (
                <ShipGrid
                  owned={owned}
                  coins={coins}
                  selected={active.skin ?? null}
                  pickedBy={pickedBy}
                  onPick={(index) => onPickSkin(active.key, index)}
                />
              ) : (
                <div className="space-y-3 pb-1">
                  <p className="text-center text-[11px] font-semibold text-white/45">
                    All {HULLS.length} are free. The paint is what you bought; this is how you fight.
                  </p>
                  <HullGrid selected={active.hull} onPick={(index) => onPickHull(active.key, index)} pickedBy={hullPickedBy} />
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="py-10 text-center text-sm font-bold text-white/55">
            The berths are full for this battle. You can watch from the shore.
          </p>
        )}
      </div>
    </StageFrame>
  );
}

interface FleetMember {
  key: string;
  name: string;
  team: Team;
  skin?: number | null;
  bot?: boolean;
  you?: boolean;
  host?: boolean;
}

const FLEET_MODES: { players: PlayerCount; title: string; description: string }[] = [
  { players: 2, title: 'Duel', description: 'One hull each, the whole sea between you.' },
  { players: 4, title: 'Fleet Skirmish', description: 'Two to a side. The water widens and the helm alternates sides.' },
  { players: 6, title: 'Armada', description: 'Full fleets of three. Every living captain takes a turn in order.' },
];

/**
 * Stage 3: the whole match on one page.
 *
 * The host's copy is the controls; a guest's copy is the same page locked,
 * kept current from the lobby as the host clicks. See MatchControls.
 */
function ModesScreen({
  rules,
  locked,
  hostName,
  toolbar,
  roster,
  onRules,
  onAssignTeam,
  aiLevel,
  onAiLevel,
  onBack,
  onStart,
  startDisabled,
  startNote,
}: {
  rules: MatchRules;
  locked: boolean;
  hostName?: string;
  toolbar: React.ReactNode;
  roster: FleetMember[];
  onRules: (rules: MatchRules) => void;
  /** Host only, and only when there is more than one ship to a side. */
  onAssignTeam?: (uid: string, team: Team) => void;
  aiLevel: number;
  /** Omitted when no bot is sailing, or for a guest: bots are driven by the host. */
  onAiLevel?: (level: number) => void;
  onBack?: () => void;
  onStart?: () => void;
  startDisabled?: boolean;
  startNote: string;
}) {
  const set = (patch: Partial<MatchRules>) => onRules({ ...rules, ...patch });
  const weather = rules.weather ?? weatherFor(rules);

  return (
    <StageFrame
      theme={THEME}
      step={3}
      title="Match rules"
      subtitle={rulesSummary(rules)}
      onBack={onBack}
      toolbar={toolbar}
      status={locked ? <HostBadge theme={THEME}>{hostName || 'The host'} is configuring the match...</HostBadge> : undefined}
      footer={
        <ActionBar
          theme={THEME}
          label="Weigh anchor"
          icon={<Play className="h-4 w-4 fill-current" />}
          onAction={onStart}
          disabled={startDisabled}
          note={startNote}
        />
      }
    >
      <div className="grid gap-5 lg:grid-cols-3 short:gap-3">
        <div className="space-y-5 lg:col-span-2 short:space-y-3">
          <RuleSection theme={THEME} title="Game mode" locked={locked}>
            <div className="grid gap-2 sm:grid-cols-3">
              {FLEET_MODES.map((mode) => (
                <ModeCard
                  key={mode.players}
                  theme={THEME}
                  title={mode.title}
                  badge={`${formatSides(mode.players)} · ${mode.players} ships`}
                  description={mode.description}
                  icon={<Anchor className="h-4 w-4" />}
                  selected={rules.players === mode.players}
                  locked={locked}
                  onSelect={() => set({ players: mode.players })}
                />
              ))}
            </div>
            <p className="rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100 short:hidden">
              Land 3 damaging cannon attacks to charge a special: Torpedo deals 25 to one enemy, Acid Rain deals 10 to
              every enemy, Heal restores up to 25 HP. Each special uses your turn.
            </p>
          </RuleSection>

          <RuleSection
            theme={THEME}
            title="Weather"
            hint="Random picks one sky at the start and keeps it. Weather never changes your aim."
            locked={locked}
          >
            <OptionGroup
              theme={THEME}
              columns={3}
              locked={locked}
              value={weather}
              onChange={(id) => set({ weather: id, storm: id === 'random' ? false : wetWeather(id) })}
              options={WEATHER_CHOICES.map((w) => ({ value: w.id, label: w.name }))}
            />
          </RuleSection>

          <RuleSection theme={THEME} title="The mountain" hint={MOUNTAIN_HINT[rules.mountain]} locked={locked}>
            <OptionGroup
              theme={THEME}
              locked={locked}
              value={rules.mountain}
              onChange={(mountain) => set({ mountain })}
              options={(['off', 'breakable', 'solid'] as MountainRule[]).map((m) => ({ value: m, label: MOUNTAIN_LABEL[m] }))}
            />
          </RuleSection>

          <RuleSection theme={THEME} title="Modifiers" locked={locked}>
            <div className="grid gap-2 sm:grid-cols-3">
              <ToggleOption
                theme={THEME}
                label="Cards"
                hint="Three special shots dealt each turn. Off is round shot every time."
                value={rules.cards}
                locked={locked}
                onChange={(cards) => set({ cards })}
              />
              <ToggleOption
                theme={THEME}
                label={`Turn clock · ${BALANCE.TURN_TIME}s`}
                hint="Aim in time or the turn passes. Off lets a turn take as long as it takes."
                value={rules.turnTimer}
                locked={locked}
                onChange={(turnTimer) => set({ turnTimer })}
              />
              <ToggleOption
                theme={THEME}
                label="Aim arc"
                hint="Draws the start of the shot while aiming. Much easier."
                value={rules.aimArc}
                locked={locked}
                onChange={(aimArc) => set({ aimArc })}
              />
            </div>
          </RuleSection>

          {onAiLevel && (
            <RuleSection theme={THEME} title="Bot rank" hint="How well the bots in empty berths shoot.">
              <OptionGroup
                theme={THEME}
                value={aiLevel}
                onChange={onAiLevel}
                options={TIERS.map((tier, i) => ({ value: i, label: tier.label }))}
              />
            </RuleSection>
          )}
        </div>

        <RuleSection
          theme={THEME}
          title={`Fleets · ${formatSides(rules.players)}`}
          hint={onAssignTeam ? 'Tap a side to move a captain.' : undefined}
          locked={locked}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {([0, 1] as const).map((team) => (
              <div
                key={team}
                className="space-y-1.5 rounded-2xl border p-2"
                style={{ borderColor: `${TEAM_COLORS[team].main}55`, background: `${TEAM_COLORS[team].main}14` }}
              >
                <p className="px-1 text-[10px] font-black uppercase tracking-widest" style={{ color: TEAM_COLORS[team].light }}>
                  {TEAM_COLORS[team].name}
                </p>
                {roster
                  .filter((m) => m.team === team)
                  .map((m) => (
                    <div key={m.key} className="flex items-center gap-2 rounded-xl bg-black/20 p-1.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/25">
                        {m.skin !== undefined && m.skin !== null ? (
                          <Portrait index={m.skin} size={32} />
                        ) : (
                          <Anchor className="h-4 w-4 text-white/35" />
                        )}
                      </span>
                      <span className={`min-w-0 flex-1 truncate text-xs font-bold ${m.bot ? 'text-white/45' : ''}`}>
                        {m.name}
                        {m.you && <span className="text-white/45"> · you</span>}
                      </span>
                      {m.host && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
                      {onAssignTeam && !m.bot && (
                        <button
                          type="button"
                          onClick={() => onAssignTeam(m.key, team === 0 ? 1 : 0)}
                          className="shrink-0 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-white/65 hover:bg-white/10"
                          title={`Move to ${TEAM_COLORS[team === 0 ? 1 : 0].name}`}
                        >
                          Swap
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </RuleSection>
      </div>
    </StageFrame>
  );
}

// -- pieces -------------------------------------------------------------------

/** Card colours for the two badge hulls, matching the badges they come from. */
const BADGE_TONE = {
  tester: {
    card: 'border-lime-400/50 bg-lime-400/10 hover:bg-lime-400/15',
    chip: 'bg-lime-400/20 text-lime-300',
    text: 'text-lime-300',
  },
  testerPlus: {
    card: 'border-cyan-300/60 bg-cyan-400/10 hover:bg-cyan-400/15 shadow-[0_0_18px_rgba(34,211,238,0.18)]',
    chip: 'bg-cyan-400/20 text-cyan-200',
    text: 'text-cyan-200',
  },
} as const;

/** A ship card, drawn with the same code the battle uses. */
function Portrait({ index, size = 92 }: { index: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
      const canvas = ref.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      const animated = ANIMATED_ORNAMENTS.includes(SHIPS[index]?.ornament ?? '');
      let frame = 0;
      let visible = false;
      let previous = -Infinity;
      const paint = (now: number) => {
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
        clock: now / 1000,
        scale: size / 390,
      });
      };
      paint(0);
      if (!animated || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const tick = (now: number) => {
        if (now - previous >= 50) { paint(now); previous = now; }
        frame = requestAnimationFrame(tick);
      };
      const sync = () => {
        cancelAnimationFrame(frame);
        if (visible && !document.hidden) frame = requestAnimationFrame(tick);
      };
      const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
      observer.observe(canvas);
      document.addEventListener('visibilitychange', sync);
      return () => { observer.disconnect(); cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', sync); };
  }, [index, size]);
  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

function ShipGrid({
  owned,
  coins,
  selected,
  pickedBy,
  onPick,
}: {
  owned: number[];
  coins: number;
  selected: number | null;
  /**
   * Everyone else who has also picked this ship. Purely informational , the
   * paint is cosmetic, so nothing stops two captains flying the same colours.
   */
  pickedBy: Record<number, string[]>;
  onPick: (index: number) => void;
}) {
  // A paint card is 198px tall -- more than half a landscape phone. Sideways it
  // keeps the picture and the name and drops everything else.
  const short = useShortScreen();
  return (
    <div className={`grid ${short ? 'grid-cols-5 gap-2' : 'grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'}`}>
      {SHIPS.map((ship, index) => {
        const isOwned = owned.includes(index);
        const others = pickedBy[index] ?? [];
        const isSelected = selected === index;
        // A badge hull is never bought: without the badge it is simply shut.
        const affordable = !ship.badge && coins >= ship.price;
        const badgeTone = ship.badge === 'testerPlus' ? BADGE_TONE.testerPlus : ship.badge ? BADGE_TONE.tester : null;

        return (
          <button
            key={ship.name}
            onClick={() => onPick(index)}
            disabled={!isOwned && !affordable}
            className={`relative flex flex-col items-center overflow-hidden rounded-2xl border text-center transition-colors ${
              short ? 'gap-0.5 p-1.5' : 'gap-1.5 p-3'
            } ${
              isSelected
                ? 'border-amber-400 bg-amber-400/20 shadow-[0_0_0_3px_rgba(251,191,36,0.25)]'
                : badgeTone
                  ? badgeTone.card
                  : isOwned
                    ? 'border-white/15 bg-white/10 hover:bg-white/20'
                    : 'border-amber-400/40 bg-amber-400/10'
            }`}
          >
            {!isOwned && ship.badge && badgeTone && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-0.5 bg-black/65 px-2 backdrop-blur-[1px]">
                <Bug className={`h-4 w-4 ${badgeTone.text}`} />
                <span className={`text-[11px] font-black ${badgeTone.text}`}>{BADGE_LABEL[ship.badge]} only</span>
                <span className="text-[9px] font-bold text-white/55 short:hidden">Earned by approved bug reports</span>
              </div>
            )}
            {!isOwned && !ship.badge && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[1px]">
                <Lock className="mb-0.5 h-4 w-4 text-amber-300" />
                <span className="text-[11px] font-black text-amber-300">{ship.price}</span>
                {!affordable && <span className="text-[9px] font-bold text-rose-300">not enough</span>}
              </div>
            )}
            <Portrait index={index} size={short ? 46 : 92} />
            <span
              className={`font-black uppercase tracking-wide ${short ? 'text-[10px] leading-tight' : 'text-sm'}`}
            >
              {ship.name}
            </span>
            {/*
              No stat bars, because there are no stats. Three identical full
              bars on every card would imply a choice that does not exist, and
              hinting at one is worse than saying plainly that these are paint.
            */}
            {badgeTone && ship.badge ? (
              <span className={`rounded-lg px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.15em] short:hidden ${badgeTone.chip}`}>
                {BADGE_LABEL[ship.badge]} exclusive
              </span>
            ) : (
              <span className="rounded-lg bg-black/25 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.15em] text-white/45 short:hidden">
                Paint only
              </span>
            )}
            <span className="text-[10px] leading-tight text-white/50 short:hidden">{ship.blurb}</span>
            {others.length > 0 && (
              <span className="text-[9px] font-black uppercase text-white/40">Also flown by {others.join(', ')}</span>
            )}
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

/**
 * The battle roles, as cards. The bars make their strengths readable at
 * a glance while the short description explains the unusual mechanic.
 */
function HullGrid({
  selected,
  onPick,
  pickedBy,
}: {
  selected: number;
  onPick: (index: number) => void;
  /** Who else has taken this class. Empty offline until a second seat picks. */
  pickedBy?: Record<number, string[]>;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5 sm:gap-3 short:grid-cols-4 short:gap-1.5">
      {HULLS.map((hull, i) => {
        const isSelected = selected === i;
        const others = pickedBy?.[i] ?? [];
        return (
          <button
            key={hull.id}
            onClick={() => onPick(i)}
            className={`flex flex-col gap-2 rounded-2xl border p-3 sm:p-3.5 text-left transition-colors short:gap-1 short:p-2 ${
              isSelected
                ? 'border-amber-400 bg-amber-400/15'
                : 'border-white/15 bg-white/5 hover:bg-white/10'
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-black">{hull.name}</span>
              {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
            </div>
            <p className="text-[10.5px] leading-snug text-white/60 short:hidden">{hull.blurb}</p>
            <HullMeters hull={hull} />
            <p className="text-[9px] font-black uppercase tracking-wider text-rose-300/80">
              {hull.cost}
            </p>
            {others.length > 0 && (
              <span className="text-[9px] font-black uppercase text-white/40">
                Also sailed by {others.join(', ')}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

type PublicAimTotals = {
  allTime: { shots: number; hits: number };
  week: { id: string; shots: number; hits: number };
};
/**
 * A modal dialog for the friends leaderboard. Accessible via the header button.
 */
function LeaderboardModal({
  people,
  uid,
  stats,
  onClose,
}: {
  people: { uid: string; displayName: string; photoURL?: string }[];
  uid: string | null;
  stats: Stats;
  onClose: () => void;
}) {
  useEscape(true, onClose);
  const [tab, setTab] = useState<'weekly' | 'all-time'>('weekly');
  const [remote, setRemote] = useState<Record<string, PublicAimTotals>>({});
  const rosterKey = people.map((person) => person.uid).sort().join(',');

  useEffect(() => {
    let cancelled = false;
    const crew = people.filter((person) => person.uid !== uid);
    void import('./firebase')
      .then(async ({ db, doc, getDoc }) => {
        const reads = await Promise.all(crew.map(async (person) => {
          try {
            const snapshot = await getDoc(doc(db, 'pirateStats', person.uid));
            const data = snapshot.data() as Partial<PublicAimTotals> | undefined;
            const allTime = data?.allTime;
            const week = data?.week;
            if (
              typeof allTime?.shots !== 'number' || typeof allTime.hits !== 'number' ||
              typeof week?.id !== 'string' || typeof week.shots !== 'number' || typeof week.hits !== 'number'
            ) return null;
            return [person.uid, { allTime, week }] as const;
          } catch {
            return null;
          }
        }));
        if (!cancelled) setRemote(Object.fromEntries(reads.filter((entry): entry is readonly [string, PublicAimTotals] => entry !== null)));
      })
      .catch(() => { if (!cancelled) setRemote({}); });
    return () => { cancelled = true; };
  }, [rosterKey, uid]);

  const weekId = currentWeekId();
  const self: PublicAimTotals = { allTime: { shots: stats.shots, hits: stats.hits }, week: stats.week };
  const rows = people
    .map((person) => {
      const totals = person.uid === uid ? self : remote[person.uid];
      const scoped = tab === 'weekly'
        ? totals?.week.id === weekId ? totals.week : { shots: 0, hits: 0 }
        : totals?.allTime ?? { shots: 0, hits: 0 };
      return { ...person, ...scoped, percent: accuracy(scoped) };
    })
    .sort((a, b) => b.percent - a.percent || b.shots - a.shots || a.displayName.localeCompare(b.displayName));

  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md overflow-hidden rounded-[2rem] p-5 sm:p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3.5 flex items-start justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-black tracking-tight text-amber-200">
              <Trophy className="h-5 w-5 text-amber-300" /> Friends leaderboard
            </h3>
            <p className="mt-0.5 text-xs font-semibold text-white/50">Ranked by aim accuracy across open water</p>
          </div>
          <button onClick={onClose} aria-label="Close leaderboard" className="rounded-xl p-2 text-white/65 hover:bg-white/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-3 flex justify-end">
          <div className="flex rounded-lg bg-black/30 p-0.5 text-[10px] font-black uppercase tracking-wide">
            <button onClick={() => setTab('weekly')} className={`rounded-md px-2.5 py-1 ${tab === 'weekly' ? 'bg-amber-400 text-slate-950' : 'text-white/50'}`}>Weekly</button>
            <button onClick={() => setTab('all-time')} className={`rounded-md px-2.5 py-1 ${tab === 'all-time' ? 'bg-amber-400 text-slate-950' : 'text-white/50'}`}>All time</button>
          </div>
        </div>

        <div className="max-h-[50dvh] space-y-2 overflow-y-auto overscroll-contain pr-1">
          {rows.map((row, index) => (
            <div key={row.uid} className={`rounded-2xl px-3 py-2 ${row.uid === uid ? 'bg-amber-400/15 ring-1 ring-amber-400/35' : 'bg-black/20'}`}>
              <div className="flex items-center gap-2 text-xs">
                <span className="w-5 text-center font-black tabular-nums text-amber-300">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate font-bold">{row.displayName}{row.uid === uid ? ' · you' : ''}</span>
                <span className="font-black tabular-nums text-amber-200">{row.shots > 0 ? `${row.percent}%` : '—'}</span>
              </div>
              <div className="ml-7 mt-1.5 flex items-center gap-2">
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
                  <span className="block h-full rounded-full bg-amber-400" style={{ width: `${row.shots > 0 ? Math.max(4, row.percent) : 0}%` }} />
                </span>
                <span className="w-16 text-right text-[10px] font-semibold tabular-nums text-white/50">{row.hits}/{row.shots} hits</span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[10px] font-semibold leading-relaxed text-white/40">
          {tab === 'weekly' ? 'This week only. A better week puts you straight up the board.' : 'Every recorded cannon turn.'}
        </p>
      </div>
    </div>
  );
}

/** Visual role profile. Values are relative to the strongest available role. */
function HullMeters({ hull }: { hull: typeof HULLS[number] }) {
  const statDots = getHullStatDots(hull);
  const meters = [
    { label: 'Hull', dots: statDots.hpDots, color: 'bg-emerald-400' },
    { label: 'Guns', dots: statDots.damageDots, color: 'bg-amber-400' },
    { label: 'Critical', dots: statDots.critDots, color: 'bg-rose-400' },
    { label: 'Aim', dots: statDots.aimGuideDots, color: 'bg-cyan-300' },
  ];
  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 short:hidden">
      {meters.map((meter) => {
        const filled = Math.max(1, Math.min(5, meter.dots));
        const empty = 5 - filled;
        const percent = (filled / 5) * 100;
        return (
          <div key={meter.label} title={`${meter.label}: ${filled} of 5`}>
            <div className="mb-0.5 flex justify-between text-[8px] font-black uppercase tracking-wider text-white/45">
              <span>{meter.label}</span>
              <span className="tracking-[1px]">
                <span className="text-white/90">{'●'.repeat(filled)}</span>
                {empty > 0 && <span className="text-white/25">{'●'.repeat(empty)}</span>}
              </span>
            </div>
            <span className="block h-1.5 overflow-hidden rounded-full bg-white/10">
              <span className={`block h-full rounded-full ${meter.color}`} style={{ width: `${percent}%` }} />
            </span>
          </div>
        );
      })}
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
  /**
   * This device only.
   *
   * The aim guide, the turn clock and the mountain used to live here and no
   * longer do: they change how the battle plays, so both sides have to agree
   * on them. They are Battle Rules now, set by the host in the room. What is
   * left is genuinely local , how loud it is, and how hard this particular
   * machine is willing to work.
   */
  const toggles: { key: keyof GameSettings; label: string; hint: string }[] = [
    {
      key: 'lowPower',
      label: 'Low power mode',
      hint: 'Reduces scenery and particle density. Cannon flashes and essential weapon effects stay visible.',
    },
  ];

  // Escape closes it too. See @shared/ui/dismiss.
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
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

/**
 * The captain's log.
 *
 * Four numbers up top and the detail below them, in that order on purpose:
 * accuracy is the one figure a player actually wants and it should not have
 * to be hunted for. Everything here is this browser's own record -- see
 * stats.ts on why it does not go to the account.
 */
function StatsPanel({
  stats,
  onClose,
  onClear,
}: {
  stats: Stats;
  onClose: () => void;
  onClear: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const fav = favouriteCard(stats);
  const acc = accuracy(stats);
  const winRate = stats.battles === 0 ? 0 : Math.round((stats.wins / stats.battles) * 100);
  // Grapeshot puts five balls in the air for one trigger pull, so this and
  // `acc` are genuinely different questions: how often a turn achieved
  // something, against how much of the iron actually arrived.
  const ballAcc = stats.balls === 0 ? 0 : Math.round((stats.ballsLanded / stats.balls) * 100);

  const rows: { label: string; value: string }[] = [
    { label: 'Battles fought', value: String(stats.battles) },
    { label: 'Won', value: `${stats.wins} · ${winRate}%` },
    { label: 'Shots fired', value: String(stats.shots) },
    { label: 'Shots that landed', value: String(stats.hits) },
    { label: 'Iron on target', value: `${stats.ballsLanded} of ${stats.balls} balls · ${ballAcc}%` },
    { label: 'Damage dealt', value: String(Math.round(stats.damage)) },
    { label: 'Best run', value: stats.bestStreak > 0 ? `${stats.bestStreak} in a row` : ',' },
  ];
  const profile = [
    { label: 'Win rate', value: winRate, tone: 'bg-emerald-400', detail: `${stats.wins} victories` },
    { label: 'Shot accuracy', value: acc, tone: 'bg-amber-400', detail: `${stats.hits} turns landed` },
    { label: 'Iron on target', value: ballAcc, tone: 'bg-sky-400', detail: `${stats.ballsLanded} cannonballs hit` },
  ];

  // Escape closes it too. See @shared/ui/dismiss.
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-5 overflow-y-auto overscroll-contain rounded-[2rem] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xl font-black">Captain&apos;s log</h3>
            <p className="text-[11px] font-semibold text-white/45">
              Your own gunnery, counted from every hull you have sailed.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-white/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        {stats.battles === 0 ? (
          <div className="rounded-2xl bg-black/25 p-6 text-center">
            <Anchor className="mx-auto mb-3 h-10 w-10 text-white/25" />
            <p className="text-sm font-bold text-white/60">Nothing logged yet.</p>
            <p className="mt-1 text-[11px] text-white/40">
              Fight a battle and this fills itself in , every shot you take, and what it did.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Figure icon={<Target className="h-4 w-4" />} label="Accuracy" value={`${acc}%`} tone="amber" />
              <Figure icon={<Trophy className="h-4 w-4" />} label="Win rate" value={`${winRate}%`} tone="emerald" />
              <Figure icon={<Anchor className="h-4 w-4" />} label="Ships sunk" value={String(stats.sunk)} tone="rose" />
              <Figure
                icon={<ScrollText className="h-4 w-4" />}
                label="Favourite card"
                value={fav ? CARDS[fav.id].name : ','}
                sub={fav ? `${fav.n} fired` : undefined}
                tone="sky"
              />
            </div>

            <div className="rounded-2xl bg-black/25 p-4">
              <p className="mb-3 text-[11px] font-black uppercase tracking-[0.2em] text-white/45">Captain profile</p>
              <div className="space-y-3">
                {profile.map((metric) => (
                  <div key={metric.label}>
                    <div className="mb-1 flex items-baseline justify-between gap-3 text-[11px] font-bold">
                      <span className="text-white/70">{metric.label}</span>
                      <span className="tabular-nums text-white">{metric.value}% <span className="font-medium text-white/40">· {metric.detail}</span></span>
                    </div>
                    <span className="block h-2 overflow-hidden rounded-full bg-white/10">
                      <span className={`block h-full rounded-full ${metric.tone}`} style={{ width: `${Math.max(metric.value > 0 ? 4 : 0, metric.value)}%` }} />
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1 rounded-2xl bg-black/25 p-4">
              {rows.map((r) => (
                <div key={r.label} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-semibold text-white/55">{r.label}</span>
                  <span className="font-black tabular-nums">{r.value}</span>
                </div>
              ))}
            </div>

            <div className="space-y-2">
              <p className="text-[11px] font-black uppercase tracking-[0.2em] text-white/45">The deck</p>
              <div className="space-y-1.5">
                {CARD_ORDER.map((id) => {
                  const n = stats.cards[id] ?? 0;
                  const share = stats.shots === 0 ? 0 : (n / stats.shots) * 100;
                  return (
                    <div key={id} className="flex items-center gap-2.5">
                      <span className="w-24 shrink-0 truncate text-[11px] font-bold text-white/60">
                        {CARDS[id].name}
                      </span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                        <span
                          className="block h-full rounded-full bg-amber-400/80"
                          style={{ width: `${Math.max(n > 0 ? 4 : 0, share)}%` }}
                        />
                      </span>
                      <span className="w-8 shrink-0 text-right text-[11px] font-black tabular-nums text-white/50">
                        {n}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {confirming ? (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    onClear();
                    setConfirming(false);
                  }}
                  className="flex-1 rounded-xl border border-rose-400/50 bg-rose-500/20 py-2.5 text-xs font-black text-rose-200"
                >
                  Yes, wipe the log
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="flex-1 rounded-xl border border-white/15 bg-white/5 py-2.5 text-xs font-black text-white/60"
                >
                  Keep it
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="w-full rounded-xl border border-white/10 py-2.5 text-[11px] font-bold text-white/35 hover:bg-white/5"
              >
                Start a fresh log
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const FIGURE_TONE = {
  amber: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  emerald: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  rose: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  sky: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
};

/** One headline number. Big enough to read at a glance and nothing else on it. */
function Figure({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone: keyof typeof FIGURE_TONE;
}) {
  return (
    <div className={`rounded-2xl border p-3 ${FIGURE_TONE[tone]}`}>
      <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider opacity-80">
        {icon} {label}
      </p>
      <p className="mt-1 truncate text-xl font-black text-white">{value}</p>
      {sub && <p className="text-[10px] font-bold opacity-70">{sub}</p>}
    </div>
  );
}
