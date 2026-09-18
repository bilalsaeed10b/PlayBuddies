import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { scrimProps, useEscape } from '@shared/ui/dismiss';
import {
  ArrowLeft,
  Blocks,
  Bot,
  Check,
  Coins,
  Crown,
  Grid3x3,
  Loader2,
  Lock,
  LogOut,
  Maximize2,
  Play,
  ScrollText,
  Settings as SettingsIcon,
  Swords,
  Users,
} from 'lucide-react';
import { askHostToEndGame, askToLeaveLobby, isNativeFullscreen, toggleFullscreen, useAutoFullscreen } from './fullscreen';
import { MainMenu } from '@shared/menu/MainMenu';
import { ActionBar, HostBadge, StageFrame } from '@shared/menu/StageFrame';
import { ModeCard, OptionGroup, RuleSection, ToggleOption } from '@shared/menu/MatchControls';
import { MENU_STAGE_FIELD, parseStage } from '@shared/menu/stage';
import type { MenuStage } from '@shared/menu/stage';
import type { MenuTheme } from '@shared/menu/theme';
import { FREE_PAWNS, PAWNS, drawPawn } from './game/pawns';
import useShortScreen from '@shared/ui/useShortScreen';
import { DEFAULT_SIDES, TEAMS, colOf, layoutFor, rowOf, teamOf } from './game/rules';
import type { Layout, SideMeta } from './game/rules';
import { balancedTeams, orderedRoomPlayers, teamSeatOrder } from './game/roomRoster';
import type { RoomPlayer as LobbyPerson, Team } from './game/roomRoster';
import { TIERS } from './engine/ai';
import { audioService } from './services/audio';
import { GameWallet, reportResult } from './platform/wallet';
import MatchView from './screens/MatchView';
import type { MatchConfig } from './screens/MatchView';
import type { Seat } from './engine/QuoridorEngine';
import { DEFAULT_RULES, PLAYER_CODES, TURN_SECONDS, packRules, unpackRules } from './types/game';
import { createLogger } from '@shared/log/logger';
import type { GameSettings, MatchRules, PlayerCount } from './types/game';

const log = createLogger('quoridor');

/**
 * Where this device keeps the rules it last played with.
 *
 * Versioned because the turn clock became on by default: under the old key
 * nearly everyone had `turnTimer: false` saved, not because they chose it but
 * because it was the default when they first opened the game, and the new
 * default would never have reached them.
 */
const RULES_KEY = 'quoridor_rules_v2';

/**
 * The platform owns the lobby.
 *
 * This game never shows a login screen and never asks for a room code. It
 * reads the room it was handed in the query string, writes only its own slot
 * in it, and lets PlayBuddies decide who is in the game.
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
  hints: true,
};

/** Everything before the match is one of the shared menu stages; see `stage` in App. */
type View = 'shell' | 'game';

/**
 * Quoridor is daylight on a table: pale paper, warm wood, amber ink. `light`
 * is what tells the shared screens to put dark text on this game's own pale
 * `.panel`, and amber-700 rather than the brighter 500 is what keeps their
 * small uppercase labels legible on it.
 */
const THEME: MenuTheme = {
  tone: 'light',
  primary: 'bg-amber-400 text-slate-900',
  selected: 'border-amber-400 bg-amber-400/20',
  accent: 'text-amber-700',
};

/**
 * The three boards this engine actually has.
 *
 * Each one is a `players` + `teams` pair and nothing more, because that pair
 * is all a Quoridor match is made of , `layoutFor` turns it into a board size,
 * a set of starting edges and a wall allowance, and every number shown on a
 * mode card below is read back out of that rather than typed in again.
 */
type ModeId = 'duel' | 'ffa' | 'teams';

const MODES: {
  id: ModeId;
  players: PlayerCount;
  teams: boolean;
  title: string;
  description: string;
}[] = [
  {
    id: 'duel',
    players: 2,
    teams: false,
    title: 'Classic Duel',
    description: 'Two pawns, opposite edges, ten walls apiece. Enough to build a real maze between you.',
  },
  {
    id: 'ffa',
    players: 4,
    teams: false,
    title: 'Four-Way Free-for-All',
    description: 'A pawn on every edge and nobody on your side. Five walls each, so every one has to matter.',
  },
  {
    id: 'teams',
    players: 4,
    teams: true,
    title: '2v2 Teams',
    description: 'Two pairs on a wider board, each pair running the same way. Either partner crossing takes it for both.',
  },
];

const modeOf = (rules: MatchRules): ModeId => (rules.players === 2 ? 'duel' : rules.teams ? 'teams' : 'ffa');

/** Which edge a seat is running at, for a roster line that says where it is going. */
const OPPOSITE = { south: 'north', north: 'south', west: 'east', east: 'west' } as const;

/** The lobby document, as this game reads it. Only the host writes anything but its own slot. */
interface LobbyDoc {
  hostId: string;
  players: Record<string, LobbyPerson>;
  matchStarted?: boolean;
  matchRules?: number;
  quoridorTeams?: Record<string, number>;
  menuStage?: string;
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
  const [showGuide, setShowGuide] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [lobby, setLobby] = useState<LobbyDoc | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  /** Offline setup: how many people are at this device, and as what. */
  const [seatCount, setSeatCount] = useState(1);
  const [seatSkin, setSeatSkin] = useState<Record<number, number>>({});
  /**
   * The player deliberately asked for an offline game.
   *
   * Being signed into a lobby is not the same as wanting to play in it, and
   * the offline flow is reachable from *inside* the room. Without this flag the
   * branch below would rebuild the online config for it anyway , one local
   * seat rather than two, so the second player at the keyboard drove nothing,
   * with the whole Firebase path still running underneath a game that has no
   * peers to talk to.
   */
  const [offlineMatch, setOfflineMatch] = useState(false);
  /** Solo, couch, or a game opened on its own: the flow lives on this device alone. */
  const local = !online || offlineMatch;
  const [aiLevel, setAiLevel] = useState(1);

  /**
   * The purse belongs to the account, not to this browser.
   *
   * localStorage is still read first so the shop is never blank while the
   * handshake with PlayBuddies is in flight, and it is still written on every
   * change so the game works opened on its own. It is a cache now rather than
   * the record.
   */
  const wallet = useMemo(() => new GameWallet('quoridor', 'quoridor_owned'), []);
  const [coins, setCoins] = useState(() => wallet.current.coins);
  const [owned, setOwned] = useState<number[]>(() => [
    ...new Set([...wallet.current.unlocks, ...FREE_PAWNS]),
  ]);
  /** Nothing is saved until the account has answered, or declined to. */
  const [walletReady, setWalletReady] = useState(false);

  useEffect(() => {
    wallet.open((purse) => {
      setCoins(purse.coins);
      setOwned([...new Set([...purse.unlocks, ...FREE_PAWNS])]);
      setWalletReady(true);
    });
    return () => wallet.close();
  }, [wallet]);

  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('quoridor_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  /**
   * How the next game is played. The host's copy is the one that counts.
   *
   * Remembered between games so a host who prefers a four-hander does not
   * re-set it every round. A guest's copy is a placeholder until the host
   * reaches the match setup page, at which point the snapshot handler below
   * replaces it with the host's , which is what lets a guest watch the board
   * being set rather than find out what they are playing at the first move.
   */
  const [rules, setRules] = useState<MatchRules>(() => {
    const saved = localStorage.getItem(RULES_KEY);
    return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : DEFAULT_RULES;
  });
  useEffect(() => {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  }, [rules]);

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
    localStorage.setItem('quoridor_settings', JSON.stringify(settings));
    audioService.setVolume(settings.sfxVolume);
  }, [settings]);

  // -- platform session -------------------------------------------------------
  //
  // Firebase is imported dynamically, and only down the online path.
  //
  // The SDK is several times the weight of the entire rest of the game, and a
  // solo or couch game never calls into it once. As a static import it became
  // a modulepreload in the built HTML, so every player paid for all of it
  // before the board could draw.
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
          const data = snap.data() as LobbyDoc;
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
            menuStage: data.menuStage,
            quoridorTeams: data.quoridorTeams,
          });
          setLobby(data);

          // The host's rules, live, on the one channel every client already
          // has open. Only from the match setup page onward: `matchRules` is
          // one field of a lobby document that outlives a game, so the number
          // sitting in it before the host gets there can be last night's
          // Quoridor match , or another game's packing of something else
          // entirely. Compared against `data.hostId` rather than the `isHost`
          // variable, which still describes the *previous* snapshot inside
          // this callback.
          const roomStage = parseStage(data.menuStage);
          if (
            data.hostId !== uid &&
            typeof data.matchRules === 'number' &&
            (roomStage === 'modes' || data.matchStarted)
          ) {
            const theirs = unpackRules(data.matchRules);
            setRules((current) => (packRules(current) === data.matchRules ? current : theirs));
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
   * Who is playing, and in what order.
   *
   * Keep all four possible players here. A guest does not know the host's
   * player count until the host publishes it, so slicing by the guest's saved
   * local rules would turn real players into bots before that.
   * `seatsFor(hostCount)` below is the only place that chooses active seats.
   */
  const people = useMemo(() => {
    return orderedRoomPlayers(lobby?.players ?? {});
  }, [lobby?.players]);

  const mySkin = uid ? lobby?.players?.[uid]?.fishIndex : undefined;
  const isHost = Boolean(uid && lobby && lobby.hostId === uid);
  const stampedRules = typeof lobby?.matchRules === 'number' ? unpackRules(lobby.matchRules) : null;
  const activeRules = lobby?.matchStarted && stampedRules ? stampedRules : rules;
  const teamAssignments = useMemo(
    () => balancedTeams(people, lobby?.quoridorTeams),
    [people, lobby?.quoridorTeams],
  );

  /**
   * The host's chosen player count follows the room, not the other way round.
   *
   * `rules.players` used to be whatever this device remembered from its last
   * match -- often two players, from a duel -- so a host who opened a fresh
   * room with three friends found the seats already decided one of them
   * would be watching, with nothing on screen to say so before Start. This
   * sets it to the smallest count the room actually fits whenever the room
   * changes. That goes both ways: if four people picked Quoridor and two leave
   * before launch, the next match has to be a duel, not a four-seat board
   * waiting on ghosts from the old roster.
   *
   * Skipped while the host is playing an offline game inside the room: that
   * board is this device's alone, and the room's size has no say in it.
   */
  useEffect(() => {
    if (!online || offlineMatch || !isHost || !lobby) return;
    const roomSize = Object.keys(lobby.players ?? {}).length;
    const fits = PLAYER_CODES.find((n) => n >= roomSize) ?? PLAYER_CODES[PLAYER_CODES.length - 1];
    if (fits !== rules.players) setRules((r) => ({ ...r, players: fits }));
  }, [online, offlineMatch, isHost, lobby, rules.players]);

  useEffect(() => {
    // An offline game is the player's own; the room does not get to start or
    // end it. This guard is also what stops an unrelated lobby update from
    // bouncing a couch game straight back to the room.
    if (!online || offlineMatch) return;
    if (lobby?.matchStarted && mySkin !== undefined && mySkin !== null) setView('game');
    else if (view === 'game') setView('shell');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.matchStarted, mySkin, online, offlineMatch]);

  /**
   * A fresh seed and a fresh toss for every game.
   *
   * Quoridor's board is the same every time , the only thing to draw for is
   * who moves first, and the seed exists so a document left over from the last
   * game is obviously stale rather than replayable.
   *
   * They are rolled at the door: on the way *out* of a game, and once more as
   * a local game is started, never while one is running. Rolling them from an
   * effect keyed on the view fires one render after the board has already
   * mounted, so the engine keeps the toss it was built with while the start
   * packet goes out carrying a different one , and the guest then builds a
   * game whose turn order disagrees with every move that arrives.
   */
  const [session, setSession] = useState(() => ({
    seed: randomSeed(),
    first: Math.floor(Math.random() * rules.players),
  }));
  const rollSession = useCallback(
    () => setSession({ seed: randomSeed(), first: Math.floor(Math.random() * rules.players) }),
    [rules.players],
  );

  const buy = useCallback(
    (index: number) => {
      const price = PAWNS[index].price;
      if (owned.includes(index) || coins < price) return false;
      setCoins((c) => c - price);
      setOwned((o) => [...o, index]);
      audioService.playPop();
      return true;
    },
    [owned, coins],
  );

  const savePawn = useCallback(
    async (index: number) => {
      if (!uid) return;
      try {
        // Already loaded by the session effect on this path; the import cache
        // makes this a lookup rather than a second fetch.
        const { db, doc, updateDoc } = await import('./firebase');
        await updateDoc(doc(db, 'lobbies', handoff.room), { [`players.${uid}.fishIndex`]: index });
      } catch (e) {
        console.error('Could not save your pawn', e);
      }
    },
    [uid, handoff.room],
  );

  /**
   * One person's own pawn, bought first if it has to be.
   *
   * Online that is this player's own lobby slot , the only field a guest is
   * allowed to write , and offline it is whichever seat at this device is
   * choosing. Returns whether the pick actually landed, so the couch flow
   * knows whether to pass the device to the next player.
   */
  const choosePawn = useCallback(
    (key: string, index: number) => {
      if (!owned.includes(index) && !buy(index)) return false;
      if (local) setSeatSkin((s) => ({ ...s, [Number(key)]: index }));
      else void savePawn(index);
      return true;
    },
    [owned, buy, local, savePawn],
  );

  const assignTeam = useCallback(
    async (targetUid: string, team: Team) => {
      if (!isHost || !lobby) return;
      const current = balancedTeams(people, lobby.quoridorTeams);
      const previous = current[targetUid];
      if (previous === undefined || previous === team) return;

      const updates: Record<string, Team> = { [`quoridorTeams.${targetUid}`]: team };
      const destination = people.filter((person) => person.uid !== targetUid && current[person.uid] === team);
      if (destination.length >= 2) {
        const swap = destination[destination.length - 1];
        updates[`quoridorTeams.${swap.uid}`] = previous;
      }

      try {
        const { db, doc, updateDoc } = await import('./firebase');
        await updateDoc(doc(db, 'lobbies', handoff.room), updates);
      } catch (e) {
        console.error('Could not assign that team', e);
      }
    },
    [isHost, lobby, people, handoff.room],
  );

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    const players = PLAYER_CODES.find((n) => n >= people.length) ?? PLAYER_CODES[PLAYER_CODES.length - 1];
    const startRules = { ...rules, players, teams: players === 4 && rules.teams };
    const nextSession = { seed: randomSeed(), first: Math.floor(Math.random() * startRules.players) };
    setRules(startRules);
    setSession(nextSession);
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      await updateDoc(doc(db, 'lobbies', handoff.room), {
        matchStarted: true,
        matchRules: packRules(startRules),
        quoridorTeams: teamAssignments,
      });
    } catch (e) {
      console.error('Could not start the game', e);
    }
  }, [isHost, people.length, rules, teamAssignments, handoff.room]);

  const award = useCallback((won: boolean, movesTaken: number) => {
    // Something for turning up, more for crossing first, and a bonus for doing
    // it briskly , a ninety-move win is a grind, a thirty-move win is a plan.
    setCoins((c) => c + (won ? 95 : 30) + (won ? Math.max(0, 60 - movesTaken) : 0));
    reportResult(won, { moves: movesTaken });
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
   * The rules go to the room the moment the host changes them on the setup
   * page, not only with the start signal, so every guest's locked copy of that
   * page shows what the host is choosing while they choose it.
   */
  useEffect(() => {
    if (local || !isHost || remoteStage !== 'modes' || !lobby) return;
    const packed = packRules(rules);
    if (lobby.matchRules !== packed) void writeLobby({ matchRules: packed });
  }, [local, isHost, remoteStage, lobby, rules, writeLobby]);

  /**
   * Leaving the game: back to the setup page for a rematch, and, for the host
   * online, the go-signal comes down with it.
   *
   * `matchStarted` left set breaks a rematch two ways: pressing Start again
   * does nothing, because true to true is not a change the effect above reacts
   * to, while picking a *different* pawn is a change, so it launches a game
   * nobody started. Resetting it here, on the way out, also covers the host
   * quitting mid-game, which is what the platform's own End Game does.
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

  // -- into the game ----------------------------------------------------------

  if (view === 'game') {
    const config = online && uid && !offlineMatch ? onlineConfig() : offlineConfig();
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
   * An empty seat gets a bot.
   *
   * A lobby with one person in it , the platform's solo mode, or simply being
   * first into the room , must still be a game. Two of the earlier games
   * shipped with a version of this that only filled a *partly* full match, so
   * a room of one started with nothing on the other side of the board at all.
   */
  function onlineConfig(): MatchConfig {
    // `mode=single` is the platform saying this player pressed its own Solo
    // button. It should mean bots even in the moment before the roster
    // settles, rather than a game that depends on how fast a snapshot arrived.
    const roomCrew = handoff.solo ? people.filter((p) => p.uid === uid) : people;
    const crew = activeRules.players === 4 && activeRules.teams
      ? teamSeatOrder(roomCrew, teamAssignments)
      : roomCrew;

    // Taken as a function of the player count rather than read off `rules`,
    // because a guest's `rules` is its own saved copy until the host's reach
    // it -- and the seat list has to be the length the *host* decided or the
    // board has seats nobody is sitting in.
    const seatsFor = (count: PlayerCount) => {
      const seats: Seat[] = [];
      const localSeats: number[] = [];
      for (let i = 0; i < count; i++) {
        const person = crew[i];
        if (person && person.uid === uid) {
          localSeats.push(i);
          seats.push({
            id: uid ?? 'me',
            name: handoff.displayName || 'You',
            control: 'local',
            aiLevel: activeRules.aiLevel ?? 3,
            skin: mySkin ?? FREE_PAWNS[0],
          });
        } else if (person) {
          seats.push({
            id: person.uid,
            name: person.displayName,
            control: 'remote',
            aiLevel: activeRules.aiLevel ?? 3,
            skin: person.skin ?? otherPawn(mySkin ?? FREE_PAWNS[0]),
          });
        } else {
          seats.push({
            id: `bot-${i}`,
            name: `${TIERS[activeRules.aiLevel ?? 3].label} Bot`,
            control: 'ai',
            aiLevel: activeRules.aiLevel ?? 3,
            skin: otherPawn(mySkin ?? FREE_PAWNS[0]),
          });
        }
      }
      return { seats, localSeats };
    };

    const { seats, localSeats } = seatsFor(activeRules.players);

    return {
      seatsFor,
      roomId: handoff.room,
      uid,
      peerUids: roomCrew.filter((p) => p.uid !== uid).map((p) => p.uid),
      isHost,
      seats,
      // Somebody who arrived after the seats filled up has no pawn; the board
      // still draws, they simply have nothing to move.
      localSeats,
      aiLevel: activeRules.aiLevel ?? 3,
      seed: session.seed,
      first: Math.min(session.first, activeRules.players - 1),
      rules: activeRules,
    };
  }

  function offlineConfig(): MatchConfig {
    const first = seatSkin[0] ?? FREE_PAWNS[0];

    const seatsFor = (count: PlayerCount) => {
      const seats: Seat[] = [];
      const localSeats: number[] = [];
      for (let i = 0; i < count; i++) {
        if (i < seatCount) {
          localSeats.push(i);
          seats.push({
            id: `seat-${i}`,
            name: seatCount > 1 ? `Player ${i + 1}` : 'You',
            control: 'local',
            aiLevel,
            skin: seatSkin[i] ?? (i === 0 ? first : otherPawn(first)),
          });
        } else {
          seats.push({
            id: `bot-${i}`,
            // Numbered only when there is more than one, so a duel still reads
            // "Runner Bot" rather than "Runner Bot 2".
            name: count > 2 ? `${TIERS[aiLevel].label} ${i}` : `${TIERS[aiLevel].label} Bot`,
            control: 'ai',
            aiLevel,
            skin: otherPawn(first),
          });
        }
      }
      return { seats, localSeats };
    };

    const { seats, localSeats } = seatsFor(rules.players);

    return {
      seatsFor,
      roomId: null,
      uid: null,
      peerUids: [],
      isHost: true,
      seats,
      localSeats,
      aiLevel,
      seed: session.seed,
      // A mode chosen after the toss was drawn can be smaller than the toss:
      // four seats down to two leaves `first` pointing at a seat that no
      // longer exists, and a board waiting on a pawn nobody can move.
      first: Math.min(session.first, rules.players - 1),
      rules,
    };
  }

  // -- the pre-match flow -----------------------------------------------------

  const openOffline = (locals: number) => {
    audioService.unlock();
    setOfflineMatch(true);
    setSeatCount(locals);
    setSeatSkin({});
    setLocalStage('customize');
  };

  const closeOffline = () => {
    setOfflineMatch(false);
    setLocalStage('menu');
  };

  const stage: MenuStage = local ? localStage : remoteStage;
  const goStage = (next: MenuStage) => {
    if (local) {
      setLocalStage(next);
      return;
    }
    // The rules travel with the move onto the setup page. Published a moment
    // later instead, every guest would spend that moment reading whatever
    // number the last game in this room left behind.
    void writeLobby(
      next === 'modes'
        ? { [MENU_STAGE_FIELD]: next, matchRules: packRules(rules) }
        : { [MENU_STAGE_FIELD]: next },
    );
  };

  const hostName = lobby ? lobby.players?.[lobby.hostId]?.displayName : undefined;
  const fullscreen = () => toggleFullscreen(document.documentElement, !isNativeFullscreen());

  const coinChip = (
    <div className="panel flex items-center gap-1.5 rounded-2xl px-3 py-2.5 font-bold text-amber-600 short:py-2">
      <Coins className="h-4 w-4" /> {coins}
    </div>
  );
  const toolButton = (label: string, icon: ReactNode, onClick: () => void, extra = '') => (
    <button onClick={onClick} aria-label={label} title={label} className={`panel rounded-2xl p-2.5 short:p-2 ${extra}`}>
      {icon}
    </button>
  );
  const guideButton = (extra = '') =>
    toolButton('How to play', <ScrollText className="h-5 w-5 text-amber-600" />, () => setShowGuide(true), extra);
  const stageToolbar = (
    <>
      <span className="hidden sm:block">{coinChip}</span>
      {guideButton('hidden sm:block')}
      {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
      {toolButton('Settings', <SettingsIcon className="h-5 w-5" />, () => setShowSettings(true))}
      {!local &&
        (isHost
          ? toolButton('End the game for everyone', <LogOut className="h-5 w-5" />, askHostToEndGame)
          : toolButton('Leave lobby', <LogOut className="h-5 w-5" />, askToLeaveLobby))}
    </>
  );

  let screen: ReactNode;
  if (!local && lobbyError) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-2xl font-black">{lobbyError}</h2>
        <p className="text-sm text-slate-500">Head back to the PlayBuddies lobby and try again.</p>
      </div>
    );
  } else if (!local && (!authChecked || !uid || !lobby)) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-amber-500" />
        <p className="font-bold text-slate-600">Pulling up a chair…</p>
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
        multiHint={`Everyone in this room · ${people.length} at the board`}
        toolbar={
          <>
            {coinChip}
            {guideButton()}
            {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
            {toolButton('Leave', <LogOut className="h-5 w-5" />, askToLeaveLobby)}
          </>
        }
        title={
          <>
            <div className="mb-4 inline-block rounded-3xl bg-amber-400/25 p-4 short:hidden">
              <Grid3x3 className="h-12 w-12 text-amber-600" />
            </div>
            <h1 className="text-4xl font-black leading-none tracking-tighter sm:text-6xl short:text-3xl">
              QUORI<span className="text-amber-500">DOR</span>
            </h1>
            <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.3em] text-slate-500">
              Run the gauntlet, build the maze
            </p>
          </>
        }
        secondary={
          <button
            onClick={() => openOffline(2)}
            disabled={online && !isHost}
            className="w-full rounded-2xl border border-black/10 bg-white/60 py-2.5 text-sm font-black text-slate-600 transition-colors hover:bg-white disabled:opacity-40 short:py-1.5"
          >
            Two players, one device
            <span className="block text-[10px] font-bold text-slate-400">
              Turns alternate. Whoever is up taps a square, or drops a wall.
            </span>
          </button>
        }
        footer={
          <p className="max-w-md text-center text-[11px] leading-relaxed text-slate-500 short:hidden">
            One step a turn, up, down, left or right, or spend a wall instead.
            {!online && ' Playing with friends? Start a lobby on PlayBuddies and pick this game.'}
          </p>
        }
      />
    );
  } else if (stage === 'customize') {
    const slots: PawnSlot[] = local
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
    // Anyone past the four seats still gets to choose one. The board only
    // opens for a player the lobby holds a pawn for, and a watcher has to be
    // able to watch.
    if (!local && uid && !people.some((p) => p.uid === uid)) {
      slots.push({
        key: uid,
        label: handoff.displayName || 'You',
        skin: mySkin,
        editable: true,
        watching: true,
      });
    }
    screen = (
      <CustomizeScreen
        slots={slots}
        owned={owned}
        coins={coins}
        toolbar={stageToolbar}
        local={local}
        leads={local || isHost}
        hostName={hostName}
        onPick={choosePawn}
        onBack={local ? closeOffline : isHost ? () => goStage('menu') : undefined}
        onNext={() => goStage('modes')}
      />
    );
  } else {
    const layout = layoutFor(rules);
    const botLabel = TIERS[(local ? aiLevel : rules.aiLevel ?? 3)].label;
    const seats: SeatRow[] = [];
    const watchers: SeatRow[] = [];

    if (local) {
      for (let i = 0; i < rules.players; i++) {
        seats.push(
          i < seatCount
            ? {
                key: `seat-${i}`,
                seat: i,
                name: seatCount > 1 ? `Player ${i + 1}` : 'You',
                skin: seatSkin[i],
                you: true,
              }
            : {
                key: `bot-${i}`,
                seat: i,
                name: rules.players > 2 ? `${botLabel} ${i}` : `${botLabel} Bot`,
                bot: true,
              },
        );
      }
    } else {
      // The same seating the board will build: in a pairs game the roster is
      // the team order, so what is on screen here is what sits where.
      const crew = layout.teams ? teamSeatOrder(people, teamAssignments) : people;
      for (let i = 0; i < rules.players; i++) {
        const person = crew[i];
        seats.push(
          person
            ? {
                key: person.uid,
                uid: person.uid,
                seat: i,
                name: person.displayName,
                skin: person.skin,
                you: person.uid === uid,
                host: person.uid === lobby?.hostId,
              }
            : { key: `bot-${i}`, seat: i, name: `${botLabel} Bot`, bot: true },
        );
      }
      const seated = new Set(seats.map((s) => s.uid).filter(Boolean));
      for (const p of people) {
        if (!seated.has(p.uid)) {
          watchers.push({ key: p.uid, uid: p.uid, seat: -1, name: p.displayName, skin: p.skin, you: p.uid === uid });
        }
      }
    }

    const roomSize = lobby ? Object.keys(lobby.players ?? {}).length : 0;
    const iAmReady = mySkin !== undefined && mySkin !== null;
    const everyonePicked = people.every((p) => p.skin !== undefined && p.skin !== null);
    // Let the host's room-size effect finish raising a stale two-player
    // setting before Start can publish the match flag.
    const hasSeatForEveryone = people.length <= rules.players;
    const waitingFor = people.filter((p) => p.skin === undefined || p.skin === null).length;
    const bots = seats.filter((s) => s.bot).length;
    /** Somebody stepped out of a match the rest of the room is still playing. */
    const running = Boolean(!local && lobby?.matchStarted);

    screen = (
      <ModesScreen
        rules={rules}
        locked={!local && !isHost}
        hostName={hostName}
        toolbar={stageToolbar}
        seats={seats}
        watchers={watchers}
        // Online the mode follows the room, so a card the room cannot seat is
        // shown with the reason rather than quietly snapped back after a tap.
        fits={local ? undefined : PLAYER_CODES.find((n) => n >= roomSize) ?? PLAYER_CODES[PLAYER_CODES.length - 1]}
        roomSize={roomSize}
        onRules={setRules}
        onAssignTeam={!local && isHost && layout.teams && people.length > 2 ? assignTeam : undefined}
        botLevel={local ? aiLevel : rules.aiLevel ?? 3}
        onBotLevel={
          local
            ? setAiLevel
            : isHost
              ? (level: number) => setRules((r) => ({ ...r, aiLevel: level }))
              : undefined
        }
        showBots={!local || bots > 0}
        onBack={local || isHost ? () => goStage('customize') : undefined}
        startLabel={running ? 'Rejoin match' : 'Place pawns'}
        onStart={
          running
            ? iAmReady
              ? () => {
                  audioService.unlock();
                  setView('game');
                }
              : undefined
            : local
              ? () => {
                  audioService.unlock();
                  rollSession();
                  setView('game');
                }
              : isHost
                ? () => {
                    audioService.unlock();
                    void startMatch();
                  }
                : undefined
        }
        startDisabled={!running && !local && !(iAmReady && everyonePicked && hasSeatForEveryone)}
        startNote={
          running
            ? 'The match is already running. A bot is playing your pawn until you are back.'
            : local
              ? bots > 0
                ? `Bots play ${bots} of the ${rules.players} pawns. Who moves first is drawn at the start.`
                : 'Who moves first is drawn at the start.'
              : !isHost
                ? iAmReady
                  ? `${hostName || 'The host'} starts the game when everyone is set.`
                  : 'You have no pawn yet. The host can step back to the loadout.'
                : !iAmReady
                  ? 'Pick your own pawn first, back on the loadout page.'
                  : !hasSeatForEveryone
                    ? 'Preparing four player seats…'
                    : !everyonePicked
                      ? `Waiting on ${waitingFor} more to pick a pawn.`
                      : bots > 0
                        ? `Bots play ${bots} of the ${rules.players} pawns. Who moves first is drawn at the start.`
                        : 'Who moves first is drawn at the start.'
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

      {showGuide && <GuidePanel onClose={() => setShowGuide(false)} />}
    </div>
  );
}

/** The rules in one line, for anyone who wants to know what they are walking into. */
function rulesSummary(rules: MatchRules): string {
  const layout = layoutFor(rules);
  return [
    rules.players === 2 ? 'Two players' : layout.teams ? 'Two against two' : 'Four-way free-for-all',
    `${layout.walls} walls each`,
    `${layout.size}×${layout.size} board`,
    rules.turnTimer ? `${TURN_SECONDS}s turns` : 'no clock',
  ].join(' · ');
}

/** A bot takes a pawn other than the one the player picked. */
function otherPawn(playerChoice: number) {
  const options = FREE_PAWNS.filter((i) => i !== playerChoice);
  return options[Math.floor(Math.random() * options.length)] ?? 0;
}

// -- stage 2 ------------------------------------------------------------------

/** One person choosing a pawn: an online player, or a seat at this device. */
interface PawnSlot {
  key: string;
  label: string;
  skin: number | null | undefined;
  /** Whether this device picks for this slot. */
  editable: boolean;
  isHost?: boolean;
  /** Past the four seats: still picks a pawn, but is not holding anyone up. */
  watching?: boolean;
}

/**
 * Stage 2: everybody's pawn.
 *
 * The same screen online and offline. Online, each player writes only their
 * own lobby slot and watches everyone else's appear in the roster strip; on a
 * couch, every seat is this device's to pick for, one at a time.
 */
function CustomizeScreen({
  slots,
  owned,
  coins,
  toolbar,
  local,
  leads,
  hostName,
  onPick,
  onBack,
  onNext,
}: {
  slots: PawnSlot[];
  owned: number[];
  coins: number;
  toolbar: ReactNode;
  local: boolean;
  /** This device moves the flow on: offline, or the host. */
  leads: boolean;
  hostName?: string;
  onPick: (key: string, index: number) => boolean;
  onBack?: () => void;
  onNext: () => void;
}) {
  const mine = slots.filter((s) => s.editable);
  const [activeKey, setActiveKey] = useState(() => mine[0]?.key ?? '');
  const active = mine.find((s) => s.key === activeKey) ?? mine[0];

  const picked = (s: PawnSlot) => s.skin !== undefined && s.skin !== null;
  const others = slots.filter((s) => s !== active);
  const pickedBy = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const s of others) if (picked(s)) (map[s.skin as number] ??= []).push(s.label);
    return map;
  }, [others]);

  const waiting = slots.filter((s) => !picked(s) && !s.watching).length;
  const iAmReady = mine.every(picked);

  const pick = (index: number) => {
    if (!active || !onPick(active.key, index)) return;
    // A couch pair passes the device along: the next seat still without a pawn
    // becomes the one being chosen for.
    const next = mine.find((s) => s.key !== active.key && !picked(s));
    if (next) setActiveKey(next.key);
  };

  return (
    <StageFrame
      theme={THEME}
      step={2}
      title={active?.watching ? 'Pick a pawn to watch with' : 'Pick your pawn'}
      subtitle={`${slots.length} at the board · shape only, the seat is the colour`}
      onBack={onBack}
      toolbar={toolbar}
      status={
        !leads ? (
          <HostBadge theme={THEME}>{hostName || 'The host'} sets the board up when everyone is ready</HostBadge>
        ) : undefined
      }
      footer={
        <ActionBar
          theme={THEME}
          label="Next: Board setup"
          onAction={leads ? onNext : undefined}
          disabled={waiting > 0}
          note={
            leads
              ? waiting > 0
                ? local
                  ? 'Every player at this device needs a pawn.'
                  : `Waiting on ${waiting} more to pick a pawn.`
                : 'Everyone is set. Next, the board and the rules.'
              : iAmReady
                ? `Ready. Waiting for ${hostName || 'the host'} to set the board...`
                : 'Pick a pawn to be ready.'
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
                  s === active && mine.length > 1 ? THEME.selected : 'border-black/10 bg-white/60'
                }`}
              >
                <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-white/70">
                  {picked(s) ? (
                    <Portrait index={s.skin as number} size={34} />
                  ) : (
                    <Blocks className="h-4 w-4 text-slate-300" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="flex max-w-[120px] items-center gap-1 truncate text-xs font-black">
                    {s.label}
                    {s.isHost && <Crown className="h-3 w-3 shrink-0 text-amber-500" />}
                  </span>
                  <span
                    className={`block text-[9px] font-black uppercase tracking-wider ${
                      picked(s) ? 'text-emerald-600' : 'text-slate-400'
                    }`}
                  >
                    {s.watching ? 'Watching' : picked(s) ? 'Ready' : 'Choosing...'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <p className="flex shrink-0 items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-amber-700 sm:hidden">
          <Coins className="h-3.5 w-3.5" /> {coins}
        </p>

        {active ? (
          <div className="min-h-0 flex-1">
            <PawnGrid
              owned={owned}
              coins={coins}
              selected={active.skin ?? null}
              pickedBy={pickedBy}
              onPick={pick}
            />
          </div>
        ) : (
          <p className="py-10 text-center text-sm font-bold text-slate-500">
            The seats are full for this game. You can watch from beside the board.
          </p>
        )}
      </div>
    </StageFrame>
  );
}

// -- stage 3 ------------------------------------------------------------------

/** One seat on the board about to be played, or somebody waiting beside it. */
interface SeatRow {
  key: string;
  name: string;
  /** Index into the layout's sides, so a row is the edge it starts on. -1 for a watcher. */
  seat: number;
  skin?: number | null;
  bot?: boolean;
  you?: boolean;
  host?: boolean;
  /** Online humans only, so the host can move them between the two pairs. */
  uid?: string;
}

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
  seats,
  watchers,
  fits,
  roomSize,
  onRules,
  onAssignTeam,
  botLevel,
  onBotLevel,
  showBots,
  onBack,
  onStart,
  startLabel,
  startDisabled,
  startNote,
}: {
  rules: MatchRules;
  locked: boolean;
  hostName?: string;
  toolbar: ReactNode;
  seats: SeatRow[];
  watchers: SeatRow[];
  /** Online: the seat count the room fits. Offline every mode is open. */
  fits?: PlayerCount;
  roomSize: number;
  onRules: (update: (rules: MatchRules) => MatchRules) => void;
  /** Host only, and only in a pairs game with more than two humans in it. */
  onAssignTeam?: (uid: string, team: Team) => void;
  botLevel: number;
  /** Omitted for a guest: the host's bots, set by the host. */
  onBotLevel?: (level: number) => void;
  showBots: boolean;
  onBack?: () => void;
  onStart?: () => void;
  startLabel: string;
  startDisabled?: boolean;
  startNote: ReactNode;
}) {
  const layout = layoutFor(rules);
  const chosen = modeOf(rules);
  /**
   * Through an updater rather than a spread of the props copy: two controls
   * touched in the same tick would otherwise both build on the render they
   * were drawn from, and the second would quietly undo the first.
   */
  const set = (patch: Partial<MatchRules>) => onRules((current) => ({ ...current, ...patch }));

  return (
    <StageFrame
      theme={THEME}
      step={3}
      title="Board setup"
      subtitle={rulesSummary(rules)}
      onBack={onBack}
      toolbar={toolbar}
      status={
        locked ? <HostBadge theme={THEME}>{hostName || 'The host'} is setting the board...</HostBadge> : undefined
      }
      footer={
        <ActionBar
          theme={THEME}
          label={startLabel}
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
            title="Game mode"
            hint={
              fits === undefined
                ? 'Seats nobody is sitting in are played by bots.'
                : `The seats follow the room: ${roomSize} here, so ${fits} of them. Any that are spare go to bots.`
            }
            locked={locked}
          >
            <div className="grid gap-2 sm:grid-cols-3">
              {MODES.map((mode) => {
                const board = layoutFor(mode);
                const unfit = fits !== undefined && mode.players !== fits;
                return (
                  <ModeCard
                    key={mode.id}
                    theme={THEME}
                    title={mode.title}
                    badge={`${mode.players}P · ${board.size}×${board.size} · ${board.walls} walls`}
                    description={
                      unfit
                        ? mode.players === 2
                          ? `Needs a room of one or two. ${roomSize} are here.`
                          : `Needs three or four in the room. ${roomSize} ${roomSize === 1 ? 'is' : 'are'} here.`
                        : mode.description
                    }
                    icon={
                      mode.id === 'duel' ? (
                        <Swords className="h-4 w-4" />
                      ) : mode.id === 'ffa' ? (
                        <Grid3x3 className="h-4 w-4" />
                      ) : (
                        <Users className="h-4 w-4" />
                      )
                    }
                    selected={chosen === mode.id}
                    locked={locked || unfit}
                    onSelect={() => set({ players: mode.players, teams: mode.teams })}
                  />
                );
              })}
            </div>
          </RuleSection>

          <RuleSection theme={THEME} title="Match rules" locked={locked}>
            <ToggleOption
              theme={THEME}
              label={`Turn clock · ${TURN_SECONDS}s`}
              hint="Run the clock out and the turn is skipped: no step, no wall, the next player is up. Off lets a turn take as long as it takes."
              value={rules.turnTimer}
              locked={locked}
              onChange={(turnTimer) => set({ turnTimer })}
            />
          </RuleSection>

          {showBots && (
            <RuleSection
              theme={THEME}
              title="Bot rank"
              hint="How well the bots play the seats nobody is in, and any seat whose player steps out."
              locked={locked || !onBotLevel}
            >
              <OptionGroup
                theme={THEME}
                columns={3}
                locked={locked || !onBotLevel}
                value={botLevel}
                onChange={(level) => onBotLevel?.(level)}
                options={TIERS.map((tier, i) => ({ value: i, label: tier.label }))}
              />
            </RuleSection>
          )}
        </div>

        <RuleSection
          theme={THEME}
          title={`At the board · ${layout.size}×${layout.size}`}
          hint={onAssignTeam ? 'Move anyone to the other pair; the board reseats itself.' : undefined}
          locked={locked}
        >
          <BoardPreview layout={layout} />

          {layout.teams ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
              {([0, 1] as const).map((team) => (
                <div
                  key={team}
                  className="space-y-1.5 rounded-2xl border p-2"
                  style={{ borderColor: `${TEAMS[team].main}55`, background: `${TEAMS[team].main}14` }}
                >
                  <p
                    className="px-1 text-[10px] font-black uppercase tracking-widest"
                    style={{ color: TEAMS[team].dark }}
                  >
                    {TEAMS[team].name}
                  </p>
                  {seats
                    .filter((row) => teamOf(row.seat) === team)
                    .map((row) => (
                      <SeatChip
                        key={row.key}
                        row={row}
                        side={layout.sides[row.seat]}
                        onSwap={
                          onAssignTeam && row.uid
                            ? () => onAssignTeam(row.uid as string, team === 0 ? 1 : 0)
                            : undefined
                        }
                        swapTo={TEAMS[team === 0 ? 1 : 0].name}
                      />
                    ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-1.5">
              {seats.map((row) => (
                <SeatChip key={row.key} row={row} side={layout.sides[row.seat]} />
              ))}
            </div>
          )}

          {watchers.length > 0 && (
            <div className="mt-2 space-y-1.5">
              <p className="px-1 text-[10px] font-black uppercase tracking-widest text-slate-400">
                Watching ({watchers.length})
              </p>
              {watchers.map((row) => (
                <SeatChip key={row.key} row={row} />
              ))}
            </div>
          )}
        </RuleSection>
      </div>
    </StageFrame>
  );
}

/** One line of the roster: who it is, which edge they start on, and their pawn. */
function SeatChip({
  row,
  side,
  onSwap,
  swapTo,
}: {
  row: SeatRow;
  /** Absent for a watcher, who has no edge of their own. */
  side?: SideMeta;
  onSwap?: () => void;
  swapTo?: string;
}) {
  const ink = side ?? DEFAULT_SIDES[0];
  const known = row.skin !== undefined && row.skin !== null;
  return (
    <div
      className="flex items-center gap-2 rounded-xl border p-1.5"
      style={
        side
          ? { borderColor: `${ink.main}55`, background: `${ink.main}12` }
          : { borderColor: 'rgba(0,0,0,0.08)', background: 'rgba(0,0,0,0.03)' }
      }
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/70">
        {known ? (
          <Portrait index={row.skin as number} size={34} ink={ink} />
        ) : row.bot ? (
          <Bot className="h-4 w-4 text-slate-400" />
        ) : (
          <Blocks className="h-4 w-4 text-slate-300" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 truncate text-xs font-bold">
          <span className={`truncate ${row.bot ? 'text-slate-500' : ''}`}>{row.name}</span>
          {row.you && <span className="shrink-0 text-slate-400">· you</span>}
          {row.host && <Crown className="h-3 w-3 shrink-0 text-amber-500" />}
        </span>
        <span
          className="block text-[9px] font-black uppercase tracking-widest"
          style={{ color: side ? ink.dark : '#94a3b8' }}
        >
          {side ? `${ink.name} · ${ink.home} to ${OPPOSITE[ink.home]}` : 'Beside the board'}
        </span>
      </span>
      {onSwap && (
        <button
          type="button"
          onClick={onSwap}
          title={`Move to ${swapTo}`}
          className="shrink-0 rounded-lg border border-black/10 bg-white/70 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-slate-500 transition-colors hover:bg-white"
        >
          Swap
        </button>
      )}
    </div>
  );
}

/**
 * The board these rules make, at a glance: how big it is, and who starts
 * where. Drawn from `layoutFor` rather than from a picture, so it cannot
 * disagree with the board that opens.
 */
function BoardPreview({ layout }: { layout: Layout }) {
  const step = 100 / layout.size;
  return (
    <svg
      viewBox="0 0 100 100"
      className="mb-2 w-full rounded-xl border border-black/10 bg-[#fdf6e9] short:hidden"
      role="img"
      aria-label={`${layout.size} by ${layout.size} board, ${layout.players} pawns`}
    >
      {Array.from({ length: layout.size + 1 }, (_, i) => (
        <g key={i} stroke="#dbc7a6" strokeWidth={0.4}>
          <line x1={i * step} y1={0} x2={i * step} y2={100} />
          <line x1={0} y1={i * step} x2={100} y2={i * step} />
        </g>
      ))}
      {layout.sides.map((side, i) => (
        <circle
          key={i}
          cx={(colOf(side.start) + 0.5) * step}
          cy={(rowOf(side.start) + 0.5) * step}
          r={step * 0.36}
          fill={side.main}
          stroke={side.dark}
          strokeWidth={0.7}
        />
      ))}
    </svg>
  );
}

// -- pieces -------------------------------------------------------------------

/** A pawn card, drawn with the same code the board uses. */
function Portrait({
  index,
  size = 84,
  /** The seat colour this pawn is wearing. A skin is shape; the seat is colour. */
  ink = DEFAULT_SIDES[0],
}: {
  index: number;
  size?: number;
  ink?: { main: string; light: string; dark: string };
}) {
  const { main, light, dark } = ink;
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
      drawPawn(ctx, {
        skin: index,
        x: size * 0.5,
        y: size * 0.56,
        r: size * 0.3,
        main,
        light,
        dark,
      });
    },
    [index, size, main, light, dark],
  );
  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

function PawnGrid({
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
   * Everyone else who has also picked this pawn. Purely informational , the
   * shape is cosmetic and the seat colour is what tells pawns apart, so
   * nothing stops two players choosing the same one.
   */
  pickedBy: Record<number, string[]>;
  onPick: (index: number) => void;
}) {
  // A pawn card is 190px tall, which is half a landscape phone. Sideways it
  // drops the blurb and the badge, shrinks the portrait and packs five to a
  // row, so the choice is something you scan rather than something you scroll.
  const short = useShortScreen();
  return (
    <div className={`grid gap-3 ${short ? 'grid-cols-5 gap-2' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'}`}>
      {PAWNS.map((pawn, index) => {
        const isOwned = owned.includes(index);
        const others = pickedBy[index] ?? [];
        const isSelected = selected === index;
        const affordable = coins >= pawn.price;

        return (
          <button
            key={pawn.name}
            onClick={() => onPick(index)}
            disabled={!isOwned && !affordable}
            className={`relative flex flex-col items-center overflow-hidden rounded-2xl border text-center transition-colors ${
              short ? 'gap-0.5 p-1.5' : 'gap-1.5 p-3'
            } ${
              isSelected
                ? 'border-amber-400 bg-amber-400/20 shadow-[0_0_0_3px_rgba(251,191,36,0.25)]'
                : isOwned
                  ? 'border-black/10 bg-white/70 hover:bg-white'
                  : 'border-amber-400/50 bg-amber-400/10'
            }`}
          >
            {!isOwned && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-900/45 backdrop-blur-[1px]">
                <Lock className="mb-0.5 h-4 w-4 text-amber-200" />
                <span className="text-[11px] font-black text-amber-200">{pawn.price}</span>
                {!affordable && <span className="text-[9px] font-bold text-rose-200">not enough</span>}
              </div>
            )}
            <Portrait index={index} size={short ? 44 : 84} />
            <span
              className={`font-black uppercase tracking-wide ${short ? 'text-[10px] leading-tight' : 'text-sm'}`}
            >
              {pawn.name}
            </span>
            {/*
              No stat bars, because there are no stats. Three identical full
              bars on every card would imply a choice that does not exist, and
              hinting at one is worse than saying plainly that these are shape.
            */}
            <span className="rounded-lg bg-slate-900/8 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.15em] text-slate-400 short:hidden">
              Shape only
            </span>
            <span className="text-[10px] leading-tight text-slate-500 short:hidden">{pawn.blurb}</span>
            {others.length > 0 && (
              <span className="text-[9px] font-black uppercase text-slate-400">Also played by {others.join(', ')}</span>
            )}
            {isSelected && (
              <span className="flex items-center gap-1 text-[10px] font-black text-amber-600">
                <Check className="h-3 w-3" /> picked
              </span>
            )}
          </button>
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
   * The player count, the turn clock and the bots used to live here and no
   * longer do: they change what the game *is*, so everybody has to agree on
   * them. They are the board setup now, set by the host on stage three. What
   * is left is genuinely local , how loud it is, and how much the board is
   * willing to tell you.
   */
  const toggles: { key: 'hints'; label: string; hint: string }[] = [
    {
      key: 'hints',
      label: 'Show legal squares',
      hint: 'Lights up every square the pawn whose turn it is may step to, jumps included. Off is the plain wooden board.',
    },
  ];

  // Escape closes it too. See @shared/ui/dismiss.
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-6 overflow-y-auto overscroll-contain rounded-[2rem] bg-white/95 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xl font-black">Settings</h3>
            <p className="text-[11px] font-semibold text-slate-400">This device only. Nobody else is affected.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-black/5">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-sm font-bold">
            <span>Pieces and walls</span>
            <span>{Math.round(settings.sfxVolume * 100)}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={settings.sfxVolume}
            onChange={(e) => onChange({ ...settings, sfxVolume: parseFloat(e.target.value) })}
            className="w-full accent-amber-500"
          />
        </div>

        {toggles.map(({ key, label, hint }) => (
          <label key={key} className="flex items-center justify-between gap-3">
            <span className="text-sm font-bold">
              {label}
              <span className="block text-[11px] font-normal text-slate-500">{hint}</span>
            </span>
            <input
              type="checkbox"
              checked={Boolean(settings[key])}
              onChange={(e) => onChange({ ...settings, [key]: e.target.checked })}
              className="h-6 w-6 shrink-0 accent-amber-500"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * How Quoridor is played. Nothing here is a setting.
 *
 * What the match is , how many pawns, how many walls, whether there is a
 * clock , is the host's, and lives on the board setup page where everyone can
 * watch it being decided. This is the part that is true in every game, and it
 * is worth thirty seconds before the walls start going down.
 */
function GuidePanel({ onClose }: { onClose: () => void }) {
  // Escape closes it too. See @shared/ui/dismiss.
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-5 overflow-y-auto overscroll-contain rounded-[2rem] bg-white/95 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-xl font-black">
              <ScrollText className="h-5 w-5 text-amber-600" /> How to play
            </h3>
            <p className="text-[11px] font-semibold text-slate-400">True in every mode.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-black/5">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <section className="space-y-1">
          <h4 className="text-sm font-black">A turn</h4>
          <p className="text-[13px] leading-relaxed text-slate-600">
            One step , up, down, left or right, never diagonally , or spend a wall instead. Never both.
          </p>
        </section>

        <section className="space-y-1">
          <h4 className="text-sm font-black">Jumps</h4>
          <p className="text-[13px] leading-relaxed text-slate-600">
            Face another pawn with nothing between you and you may jump straight over it. If a wall or the
            board's edge is right behind them, the jump bends to either side.
          </p>
        </section>

        <section className="space-y-1">
          <h4 className="text-sm font-black">Walls</h4>
          <p className="text-[13px] leading-relaxed text-slate-600">
            A wall covers two squares of groove and may not cross or overlap another. No wall may leave any pawn
            with no route at all to its goal, so the board can never be sealed , only made longer.
          </p>
        </section>

        <section className="space-y-1">
          <h4 className="text-sm font-black">Winning</h4>
          <p className="text-[13px] leading-relaxed text-slate-600">
            Reach the far edge from the one you started on. In a pairs game either partner getting there takes it
            for both.
          </p>
        </section>

        <div className="rounded-2xl bg-slate-900/5 p-3 text-xs leading-relaxed text-slate-500">
          <p className="mb-1 font-black uppercase tracking-[0.15em] text-slate-400">Controls</p>
          <p>Tap a glowing square to step. Switch to walls and drag to a groove to drop one.</p>
          <p className="mt-1">Arrow keys move, W toggles walls, R rotates, Enter confirms.</p>
        </div>
      </div>
    </div>
  );
}
