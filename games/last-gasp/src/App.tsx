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
  Swords,
  Users,
} from 'lucide-react';
import { askHostToEndGame, askToLeaveLobby, isNativeFullscreen, toggleFullscreen, useAutoFullscreen } from './fullscreen';
import { MainMenu } from '@shared/menu/MainMenu';
import { ActionBar, HostBadge, StageFrame } from '@shared/menu/StageFrame';
import { ModeCard, OptionGroup, RuleSection } from '@shared/menu/MatchControls';
import { MENU_STAGE_FIELD, parseStage } from '@shared/menu/stage';
import type { MenuStage } from '@shared/menu/stage';
import type { MenuTheme } from '@shared/menu/theme';
import { FACES, FREE_FACES } from './game/faces';
import FaceToken from './components/FaceToken';
import Gallows from './components/Gallows';
import {
  BALANCE,
  LETTER_VALUE,
  MAX_TEAMS,
  MIN_TEAMS,
  PIECES,
  PLAYER_COUNTS,
  SEAT_COLORS,
  TEAM_COLORS,
} from './game/rules';
import { TIERS } from './engine/ai';
import { audioService } from './services/audio';
import { GameWallet, reportResult } from './platform/wallet';
import MatchView from './screens/MatchView';
import type { MatchConfig } from './screens/MatchView';
import type { Seat } from './engine/LastGaspEngine';
import { DEFAULT_RULES, ROUND_CHOICES, defaultTeams, packRules, unpackRules } from './types/game';
import { createLogger } from '@shared/log/logger';
import type { GameSettings, MatchRules, PlayerCount } from './types/game';

const log = createLogger('last-gasp');

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
  if (room) window.history.replaceState({}, document.title, window.location.pathname);
  return handoff;
}

const DEFAULT_SETTINGS: GameSettings = { sfxVolume: 0.7, markUsed: true };

/** Everything before the match is one of the shared menu stages; see `stage` in App. */
type View = 'shell' | 'game';

const THEME: MenuTheme = {
  tone: 'dark',
  primary: 'bg-lime-500 text-slate-950',
  selected: 'border-lime-400 bg-lime-400/15',
  accent: 'text-lime-300',
};

interface LobbyPerson {
  uid: string;
  displayName: string;
  /** The lobby's per-player slot. Fish Eat Fish named it and every game since reuses it. */
  fishIndex?: number | null;
}

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;

/**
 * Below this many real people, an online race has nobody to race against.
 * There are no bots to make up the difference anymore , see `onlineConfig`.
 */
const MIN_ONLINE_PLAYERS = 2;

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

  const wallet = useMemo(() => new GameWallet('last-gasp', 'lastgasp_owned'), []);
  const [coins, setCoins] = useState(() => wallet.current.coins);
  const [owned, setOwned] = useState<number[]>(() => [
    ...new Set([...wallet.current.unlocks, ...FREE_FACES]),
  ]);
  const [walletReady, setWalletReady] = useState(false);

  useEffect(() => {
    wallet.open((purse) => {
      setCoins(purse.coins);
      setOwned([...new Set([...purse.unlocks, ...FREE_FACES])]);
      setWalletReady(true);
    });
    return () => wallet.close();
  }, [wallet]);

  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('lastgasp_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  const [rules, setRules] = useState<MatchRules>(() => {
    const saved = localStorage.getItem('lastgasp_rules');
    return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : DEFAULT_RULES;
  });
  useEffect(() => {
    localStorage.setItem('lastgasp_rules', JSON.stringify(rules));
  }, [rules]);

  // Keeps `teamOf` the right length whenever the player count or team count
  // changes, on a fresh even split , a host's individual taps on a roster
  // chip (see TeamBoard) override single entries after that, but a length
  // mismatch would otherwise leave stray or missing assignments the moment
  // either number moved.
  useEffect(() => {
    if (rules.mode !== 'teams') return;
    if (rules.teamOf.length === rules.players) return;
    setRules((r) => ({ ...r, teamOf: defaultTeams(r.players, r.teamCount) }));
  }, [rules.mode, rules.players, rules.teamCount, rules.teamOf.length]);

  useEffect(() => {
    if (!walletReady) return;
    wallet.save({ coins, unlocks: owned });
  }, [walletReady, coins, owned, wallet]);

  useEffect(() => {
    localStorage.setItem('lastgasp_settings', JSON.stringify(settings));
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
          // listens to. Compared against `data.hostId` rather than the `isHost`
          // variable, which still holds the *previous* snapshot inside this
          // same callback.
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
  }, [online, uid, handoff.room, handoff.displayName]);

  /**
   * Who is playing, in a fixed order every client derives the same way.
   *
   * Sorted by uid rather than by arrival, because arrival order differs
   * between clients and the seat index is what the whole wire protocol is
   * addressed by. Capped at the hard table max, never at `rules.players` , an
   * online table is exactly whoever is actually in the room, no more and no
   * fewer; there are no bots to pad it out to some earlier-chosen number, and
   * there is no reason to hide a real person who showed up late.
   */
  const people = useMemo(() => {
    return Object.values(lobby?.players ?? {})
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .slice(0, PLAYER_COUNTS[PLAYER_COUNTS.length - 1])
      .map((p) => ({ uid: p.uid, displayName: p.displayName || 'Player', skin: p.fishIndex }));
  }, [lobby]);

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

  // The host keeps `rules.players` in lockstep with who is actually in the
  // room. Nothing online reads it as a target to fill anymore, but Teams'
  // default split and the wire-packed rules still need a real number, and it
  // has to be one every client agrees on without anybody having picked it.
  useEffect(() => {
    if (!online || offlineMatch || !isHost) return;
    const n = Math.max(MIN_ONLINE_PLAYERS, Math.min(PLAYER_COUNTS[PLAYER_COUNTS.length - 1], people.length || MIN_ONLINE_PLAYERS));
    if (n !== rules.players) setRules((r) => ({ ...r, players: n as PlayerCount }));
  }, [online, offlineMatch, isHost, people.length, rules.players]);

  // A two-player "Teams" match is just a one-person team on each side and
  // adds the suggestion/vote flow without adding a teammate. Keep it FFA
  // until there is a third person at the table, including after someone leaves.
  useEffect(() => {
    if (!online || offlineMatch || !isHost || people.length > 2 || rules.mode !== 'teams') return;
    setRules((r) => (r.mode === 'teams' ? { ...r, mode: 'ffa' } : r));
  }, [online, offlineMatch, isHost, people.length, rules.mode]);

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
      const price = FACES[index].price;
      if (owned.includes(index) || coins < price) return false;
      setCoins((c) => c - price);
      setOwned((o) => [...o, index]);
      audioService.playTap();
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
        console.error('Could not save your face', e);
      }
    },
    [uid, owned, buy, handoff.room],
  );

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    const players = Math.max(
      MIN_ONLINE_PLAYERS,
      Math.min(PLAYER_COUNTS[PLAYER_COUNTS.length - 1], people.length || MIN_ONLINE_PLAYERS),
    ) as PlayerCount;
    const mode = players > 2 ? rules.mode : 'ffa';
    const teamCount = Math.min(rules.teamCount, players);
    let teamOf = Array.from({ length: players }, (_, seat) =>
      Math.min(teamCount - 1, rules.teamOf[seat] ?? seat % teamCount),
    );
    if (mode === 'teams' && !Array.from({ length: teamCount }, (_, team) => teamOf.includes(team)).every(Boolean)) {
      teamOf = defaultTeams(players, teamCount);
    }
    const startRules: MatchRules = { ...rules, mode, players, teamCount, teamOf };
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
      log.error('match:start-failed', { message: String((e as Error)?.message ?? e) });
    }
  }, [isHost, handoff.room, people.length, rules]);

  const award = useCallback((won: boolean, points: number) => {
    setCoins((c) => c + (won ? 90 : 25) + Math.round(points / 3));
    reportResult(won);
  }, []);

  /**
   * Leaving the match: back to the match page for a rematch, and, online, the
   * host's go-signal comes down with it.
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
  // Authentication usually resolves before the Firestore roster. Keep
  // replacing that empty preview while the lobby is waiting; when Start lands,
  // the shared seed and rules become the fixed identity of this match.
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

    // Exactly the real people in the room, in the same fixed order , no
    // filler. A race where everyone but you is a bot racing itself was the
    // bug, not a feature; a seat left short is just a smaller race.
    crew.forEach((person, i) => {
      if (person.uid === uid) {
        localSeats.push(i);
        seats.push({
          id: uid ?? 'me',
          name: handoff.displayName || 'You',
          control: 'local',
          aiLevel: 1,
          skin: mySkin ?? FREE_FACES[0],
        });
      } else {
        seats.push({
          id: person.uid,
          name: person.displayName,
          control: 'remote',
          aiLevel: 1,
          skin: person.skin ?? otherFace(mySkin ?? FREE_FACES[0], i),
        });
      }
    });

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
    const p1 = seatSkin[0] ?? FREE_FACES[0];
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
          skin: seatSkin[i] ?? (i === 0 ? p1 : otherFace(p1, i)),
        });
      } else {
        seats.push({
          id: `bot-${i}`,
          name: `${TIERS[aiLevel].label} ${i + 1}`,
          control: 'ai',
          aiLevel,
          skin: otherFace(p1, i),
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
      // Always Free-For-All offline: Teams needs a lobby to assign people to
      // teams in, and there is no lobby here , carrying over whatever mode
      // an earlier online match happened to be left on would seat a solo or
      // couch game into teams nobody had any way to configure.
      rules: { ...rules, mode: 'ffa' },
    };
  }

  const openOffline = (players: number) => {
    audioService.unlock();
    rollSession();
    setOfflineMatch(true);
    setSeatCount(players);
    setSeatSkin({});
    // A shared-screen game needs at least a seat each; a solo game keeps
    // whatever the match page is set to.
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
    <div className="panel flex items-center gap-1.5 rounded-2xl px-3 py-2.5 font-bold text-amber-300 short:py-2">
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
      {toolButton('How to play', <ScrollText className="h-5 w-5 text-lime-300" />, () => setShowGuide(true))}
      {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
      {toolButton('Settings', <SettingsIcon className="h-5 w-5" />, () => setShowSettings(true))}
      {!local && isHost && toolButton('End the game for everyone', <LogOut className="h-5 w-5" />, askHostToEndGame)}
    </>
  );

  let screen: React.ReactNode;
  if (!local && lobbyError) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-2xl font-black text-slate-100">{lobbyError}</h2>
        <p className="text-sm text-slate-400">Head back to the PlayBuddies lobby and try again.</p>
      </div>
    );
  } else if (!local && (!authChecked || !uid || !lobby)) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-lime-400" />
        <p className="font-bold text-slate-400">Chalking up…</p>
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
        multiHint={`Everyone in this room · ${people.length} at the board`}
        toolbar={
          <>
            {coinChip}
            {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
            {toolButton('Leave', <LogOut className="h-5 w-5" />, askToLeaveLobby)}
          </>
        }
        title={
          <div className="flex items-center justify-center gap-4 short:gap-2">
            <Gallows pieces={PIECES} className="h-24 w-auto opacity-80 short:h-10" />
            <div className="text-left">
              <p className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-500 short:hidden">One line left</p>
              <h1 className="text-3xl font-black leading-none tracking-tighter text-slate-50 sm:text-5xl short:text-2xl">
                THE LAST
                <br />
                GASP
              </h1>
              <p className="mt-1 text-xs font-black uppercase tracking-[0.24em] text-lime-400 short:hidden">
                Don't draw it
              </p>
            </div>
          </div>
        }
        secondary={
          <>
            <button
              onClick={() => openOffline(2)}
              disabled={online && !isHost}
              className="w-full rounded-2xl border border-white/15 bg-white/5 py-2.5 text-sm font-black text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40 short:py-1.5"
            >
              Two on one screen
              <span className="block text-[10px] font-bold text-white/45 short:hidden">
                Pass it over to set a word, then race for the letters together.
              </span>
            </button>
            {/* Loud on purpose , this is not the hangman anybody already knows. */}
            <button
              onClick={() => setShowGuide(true)}
              className="relative flex w-full items-center gap-3 overflow-hidden rounded-2xl border-2 border-lime-400/70 bg-lime-400/10 px-4 py-3 text-left transition-transform active:scale-[0.99] short:py-1.5"
            >
              <span className="absolute -right-6 -top-6 h-16 w-16 animate-pulse rounded-full bg-lime-400/20" aria-hidden />
              <ScrollText className="h-6 w-6 shrink-0 text-lime-300 short:h-5 short:w-5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-black uppercase tracking-wide text-lime-200">First time? Read this</p>
                <p className="text-[11px] font-bold text-lime-300/70 short:hidden">It is not the word game you know.</p>
              </div>
            </button>
          </>
        }
        footer={<p className="text-center text-[11px] font-bold text-white/45 short:hidden">{rulesSummary(rules)}</p>}
      />
    );
  } else if (stage === 'customize') {
    const slots: FaceSlot[] = local
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
    const roster: BoardMember[] = local
      ? Array.from({ length: rules.players }, (_, i) => ({
          key: `seat-${i}`,
          name: i < seatCount ? (seatCount > 1 ? `Player ${i + 1}` : 'You') : `${TIERS[aiLevel].label} ${i + 1}`,
          skin: i < seatCount ? seatSkin[i] : undefined,
          bot: i >= seatCount,
          you: i === 0,
        }))
      : people.map((p) => ({
          key: p.uid,
          name: p.displayName,
          skin: p.skin,
          you: p.uid === uid,
          host: p.uid === lobby?.hostId,
        }));
    const everyonePicked = people.every((p) => p.skin !== undefined && p.skin !== null);
    const iAmReady = mySkin !== undefined && mySkin !== null;
    const waitingFor = people.filter((p) => p.skin === undefined || p.skin === null).length;
    const enoughPlayers = people.length >= MIN_ONLINE_PLAYERS;
    const bots = local ? Math.max(0, rules.players - seatCount) : 0;
    screen = (
      <ModesScreen
        rules={rules}
        locked={!local && !isHost}
        local={local}
        hostName={hostName}
        toolbar={stageToolbar}
        roster={roster}
        seatCount={seatCount}
        teamsAvailable={!local && people.length > 2}
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
        startDisabled={!local && (!everyonePicked || !enoughPlayers)}
        startNote={
          !local && !isHost
            ? !iAmReady
              ? 'Pick a face to be ready.'
              : `${hostName || 'The host'} starts the match when the board is set.`
            : !local && !enoughPlayers
              ? 'Need at least one more player , invite a friend, or play offline against bots.'
              : !local && !everyonePicked
                ? `Waiting on ${waitingFor} more to pick a face.`
                : bots > 0
                  ? `Bots take ${bots} of the ${rules.players} seats. Anyone can call any letter, any time.`
                  : 'Anyone can call any letter, any time.'
        }
      />
    );
  }

  return (
    <div className="game-surface h-[100dvh] w-full overflow-hidden">
      {screen}

      {showSettings && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
      )}
      {showGuide && <GuidePanel onClose={() => setShowGuide(false)} />}
    </div>
  );
}

/** The bot picks something other than what the player is wearing. */
function otherFace(playerChoice: number, seed: number): number {
  const options = FREE_FACES.filter((i) => i !== playerChoice);
  return options[seed % Math.max(1, options.length)] ?? 0;
}

function rulesSummary(rules: MatchRules): string {
  return [
    `${rules.players} players`,
    `${ROUND_CHOICES[rules.rounds] ?? BALANCE.ROUNDS} words`,
    rules.mode === 'teams' ? `Teams of ${rules.teamCount}` : 'Free-For-All',
  ].join(' · ');
}

// -- stage 2 ------------------------------------------------------------------

/** One person choosing a face: an online player, or a seat at this device. */
interface FaceSlot {
  key: string;
  label: string;
  skin: number | null | undefined;
  /** Whether this device picks for this slot. */
  editable: boolean;
  isHost?: boolean;
}

/**
 * Stage 2: who you are at the board.
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
  slots: FaceSlot[];
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

  const picked = (s: FaceSlot) => s.skin !== undefined && s.skin !== null;
  const waiting = slots.filter((s) => !picked(s)).length;
  const iAmReady = mine.every(picked);

  return (
    <StageFrame
      theme={THEME}
      step={2}
      title="Pick a face"
      subtitle={`${slots.length} ${slots.length === 1 ? 'player' : 'players'} · no bots online`}
      onBack={onBack}
      toolbar={toolbar}
      status={
        !leads ? <HostBadge theme={THEME}>{hostName || 'The host'} moves on when everyone is set</HostBadge> : undefined
      }
      footer={
        <ActionBar
          theme={THEME}
          label="Next: Match setup"
          onAction={leads ? onNext : undefined}
          disabled={waiting > 0}
          note={
            leads
              ? waiting > 0
                ? `Waiting on ${waiting} more to pick a face.`
                : 'Everyone is set. Next, how the match runs.'
              : iAmReady
                ? `Ready. Waiting for ${hostName || 'the host'} to set the match up...`
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
                className={`flex shrink-0 items-center gap-2 rounded-2xl border px-2 py-1.5 text-left disabled:cursor-default ${
                  s === active && mine.length > 1 ? THEME.selected : 'border-white/10 bg-black/20'
                }`}
              >
                <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-black/25">
                  {picked(s) ? <FaceToken skin={s.skin as number} size={34} ring={color} /> : null}
                </span>
                <span className="min-w-0">
                  <span className="flex max-w-[120px] items-center gap-1 truncate text-xs font-black">
                    {s.label}
                    {s.isHost && <Crown className="h-3 w-3 shrink-0 text-amber-300" />}
                  </span>
                  <span
                    className={`block text-[9px] font-black uppercase tracking-wider ${
                      picked(s) ? 'text-lime-300' : 'text-white/40'
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
            <FaceGrid
              owned={owned}
              coins={coins}
              selected={active.skin ?? null}
              pickedBy={pickedBy}
              onPick={(index) => onPick(active.key, index)}
            />
          </div>
        ) : (
          <p className="py-10 text-center text-sm font-bold text-white/55">
            The board is full for this match. You can watch this one out.
          </p>
        )}
      </div>
    </StageFrame>
  );
}

function FaceGrid({
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
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {FACES.map((face, index) => {
        const isOwned = owned.includes(index);
        const isSelected = selected === index;
        const affordable = coins >= face.price;
        const others = pickedBy[index] ?? [];
        return (
          <button
            key={face.name}
            onClick={() => onPick(index)}
            disabled={!isOwned && !affordable}
            className={`relative flex flex-col items-center gap-1 overflow-hidden rounded-2xl border-2 p-2.5 text-center transition-colors ${
              isSelected
                ? 'border-lime-400 bg-lime-400/10'
                : isOwned
                  ? 'border-slate-600/50 bg-slate-800/50'
                  : 'border-slate-700/50 bg-slate-900/50'
            }`}
          >
            {!isOwned && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-950/75">
                <Lock className="mb-0.5 h-4 w-4 text-slate-300" />
                <span className="text-[11px] font-black text-slate-200">{face.price}</span>
                {!affordable && <span className="text-[9px] font-bold text-rose-400">not enough</span>}
              </div>
            )}
            <FaceToken skin={index} size={58} />
            <span className="text-[11px] font-black uppercase tracking-wide text-slate-100">{face.name}</span>
            <span className="text-[9px] leading-tight text-slate-400">{face.blurb}</span>
            {others.length > 0 && (
              <span className="text-[9px] font-black uppercase text-slate-500">also {others.join(', ')}</span>
            )}
            {isSelected && (
              <span className="flex items-center gap-1 text-[10px] font-black text-lime-300">
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

interface BoardMember {
  key: string;
  name: string;
  skin?: number | null;
  bot?: boolean;
  you?: boolean;
  host?: boolean;
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
  local,
  hostName,
  toolbar,
  roster,
  seatCount,
  teamsAvailable,
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
  /** Solo or couch: no room, so no teams and a bot count to choose. */
  local: boolean;
  hostName?: string;
  toolbar: React.ReactNode;
  roster: BoardMember[];
  seatCount: number;
  teamsAvailable: boolean;
  onRules: (rules: MatchRules) => void;
  aiLevel: number;
  /** Omitted when no bot is playing, or for a guest: bots are driven by the host. */
  onAiLevel?: (level: number) => void;
  onGuide: () => void;
  onBack?: () => void;
  onStart?: () => void;
  startDisabled?: boolean;
  startNote: string;
}) {
  const set = (patch: Partial<MatchRules>) => onRules({ ...rules, ...patch });
  const teamOf = (seat: number) => rules.teamOf[seat] ?? seat % rules.teamCount;
  const cycleTeam = (seat: number) => {
    if (locked) return;
    const next = [...rules.teamOf];
    while (next.length <= seat) next.push(next.length % rules.teamCount);
    next[seat] = (teamOf(seat) + 1) % rules.teamCount;
    set({ teamOf: next });
  };

  return (
    <StageFrame
      theme={THEME}
      step={3}
      title="Match setup"
      subtitle={rulesSummary(rules)}
      onBack={onBack}
      toolbar={toolbar}
      status={locked ? <HostBadge theme={THEME}>{hostName || 'The host'} is setting the match up...</HostBadge> : undefined}
      footer={
        <ActionBar
          theme={THEME}
          label={local ? 'Start' : 'Start the match'}
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
              local
                ? 'Teams need a room , a solo or couch match is always Free-For-All.'
                : teamsAvailable
                  ? undefined
                  : 'Teams unlock when a third player joins.'
            }
            locked={locked}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <ModeCard
                theme={THEME}
                title="Free-For-All"
                badge="2+ players"
                description="One person sets a word each round. Everybody else races to crack it , anyone can call any letter, any time."
                icon={<Swords className="h-4 w-4" />}
                selected={rules.mode === 'ffa' || !teamsAvailable}
                locked={locked}
                onSelect={() => set({ mode: 'ffa' })}
              />
              <ModeCard
                theme={THEME}
                title="Teams"
                badge="3+ players"
                description="Your team suggests words and votes on one; the other teams race to crack it together."
                icon={<Users className="h-4 w-4" />}
                selected={rules.mode === 'teams' && teamsAvailable}
                locked={locked || !teamsAvailable}
                onSelect={() => set({ mode: 'teams', teamOf: defaultTeams(rules.players, rules.teamCount) })}
              />
            </div>
            <button
              onClick={onGuide}
              className="flex w-full items-center gap-2 rounded-xl border border-lime-400/30 bg-lime-400/10 px-3 py-2 text-left text-[11px] font-bold leading-relaxed text-lime-100 short:hidden"
            >
              <ScrollText className="h-4 w-4 shrink-0 text-lime-300" />
              A hit buys you a {BALANCE.CHAIN_WINDOW_MS / 1000}s window to keep going, and rare letters pay more. Read the
              full rules.
            </button>
          </RuleSection>

          <RuleSection
            theme={THEME}
            title="Words in a match"
            hint="Highest total when they run out takes it."
            locked={locked}
          >
            <OptionGroup
              theme={THEME}
              locked={locked}
              value={rules.rounds}
              onChange={(rounds) => set({ rounds })}
              options={ROUND_CHOICES.map((amount, i) => ({ value: i, label: String(amount) }))}
            />
          </RuleSection>

          {local && (
            <RuleSection
              theme={THEME}
              title="Players"
              hint="Seats past whoever is on the couch are filled with bots."
            >
              <OptionGroup
                theme={THEME}
                columns={4}
                value={rules.players}
                onChange={(n) => set({ players: Math.max(seatCount, n) as PlayerCount })}
                options={PLAYER_COUNTS.map((n) => ({ value: n, label: String(n) }))}
              />
            </RuleSection>
          )}

          {onAiLevel && (
            <RuleSection theme={THEME} title="Bot rank" hint="How fast the bots in empty seats call letters.">
              <OptionGroup
                theme={THEME}
                value={aiLevel}
                onChange={onAiLevel}
                options={TIERS.map((tier, i) => ({ value: i, label: tier.label }))}
              />
            </RuleSection>
          )}

          {rules.mode === 'teams' && teamsAvailable && (
            <RuleSection
              theme={THEME}
              title="Teams"
              hint={locked ? undefined : 'Tap a name to move them to the next team.'}
              locked={locked}
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-bold text-white/55">How many teams</p>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: MAX_TEAMS - MIN_TEAMS + 1 }, (_, i) => MIN_TEAMS + i).map((n) => (
                      <button
                        key={n}
                        disabled={locked}
                        onClick={() => set({ teamCount: n, teamOf: defaultTeams(rules.players, n) })}
                        className={`h-7 w-7 rounded-md text-[11px] font-black disabled:opacity-60 ${
                          rules.teamCount === n ? 'bg-slate-100 text-slate-900' : 'bg-slate-800/70 text-slate-400'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>

                {/* A column per team rather than one row of everybody.
                    Colour alone was carrying the whole idea of who was on whose
                    side, which meant reading the teams off four dots in a row --
                    fine once you know the trick, useless at a glance, and no help
                    at all if the two colours are close. */}
                <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(108px, 1fr))' }}>
                  {Array.from({ length: rules.teamCount }, (_, t) => {
                    const color = TEAM_COLORS[t % TEAM_COLORS.length];
                    const members = roster.map((_, seat) => seat).filter((seat) => teamOf(seat) === t);
                    return (
                      <div
                        key={t}
                        className="flex min-w-0 flex-col gap-1 rounded-xl border p-1.5"
                        style={{ borderColor: `${color.main}55`, background: `${color.main}10` }}
                      >
                        <p
                          className="px-0.5 text-[9px] font-black uppercase tracking-[0.12em]"
                          style={{ color: color.main }}
                        >
                          Team {t + 1}
                        </p>
                        {members.length === 0 ? (
                          <p className="px-0.5 py-1 text-[10px] font-bold text-white/35">Nobody yet</p>
                        ) : (
                          members.map((seat) => {
                            const person = roster[seat];
                            return (
                              <button
                                key={seat}
                                disabled={locked}
                                onClick={() => cycleTeam(seat)}
                                className="flex min-w-0 items-center gap-1 rounded-lg bg-slate-900/50 px-1.5 py-1 text-left disabled:opacity-90"
                                title={locked ? undefined : 'Tap to change team'}
                              >
                                <span className="min-w-0 flex-1 truncate text-[10px] font-black text-slate-100">
                                  {person.name}
                                </span>
                                {person.host && <Crown className="h-2.5 w-2.5 shrink-0 text-amber-300" />}
                              </button>
                            );
                          })
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </RuleSection>
          )}
        </div>

        <RuleSection theme={THEME} title={`At the board · ${roster.length}`} locked={locked}>
          <div className="space-y-1.5">
            {roster.map((m, i) => {
              const color = SEAT_COLORS[i % SEAT_COLORS.length].main;
              return (
                <div
                  key={m.key}
                  className="flex items-center gap-2 rounded-xl border p-1.5"
                  style={{ borderColor: `${color}55`, background: `${color}14` }}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/25">
                    {m.skin !== undefined && m.skin !== null ? (
                      <FaceToken skin={m.skin} size={30} ring={color} />
                    ) : null}
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-xs font-bold ${m.bot ? 'text-white/45' : ''}`}>
                    {m.name}
                    {m.you && <span className="text-white/45"> · you</span>}
                  </span>
                  {m.host && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
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
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-5 overflow-y-auto rounded-[2rem] p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-black uppercase tracking-wide text-slate-100">Settings</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-slate-700/50">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-sm font-bold text-slate-100">
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
            className="w-full accent-lime-500"
          />
        </div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold text-slate-100">
            Mark used letters
            <span className="block text-[11px] font-normal text-slate-400">
              Colour the keys that have already been called , green for a hit, red for a miss.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.markUsed}
            onChange={(e) => onChange({ ...settings, markUsed: e.target.checked })}
            className="h-6 w-6 shrink-0 accent-lime-500"
          />
        </label>
      </div>
    </div>
  );
}

/** Four pictures, no reading required, for somebody who has never opened this before. */
function HowItWorks() {
  const steps = [
    { n: 1, title: 'Someone sets a word', body: 'Free-For-All: one player types it. Teams: your team suggests, then votes.' },
    { n: 2, title: 'It is open to everyone', body: 'No turns. Anyone can call any letter, any moment , fastest right guess wins it.' },
    { n: 3, title: 'A hit buys you a window', body: `Get one right and you alone get ${BALANCE.CHAIN_WINDOW_MS / 1000}s to keep going. Chain hits pay more each time.` },
    { n: 4, title: 'A miss draws the gallows', body: `${PIECES} wrong guesses and he's finished , whoever drew the last line loses the word's points.` },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {steps.map((s) => (
        <div key={s.n} className="rounded-2xl border border-slate-600/40 bg-slate-800/40 p-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-lime-500 text-[10px] font-black text-slate-950">
            {s.n}
          </span>
          <p className="mt-1.5 text-[11px] font-black uppercase tracking-wide text-slate-100">{s.title}</p>
          <p className="text-[10px] leading-snug text-slate-400">{s.body}</p>
        </div>
      ))}
    </div>
  );
}

/** The stickman at three stages, so the escalation is a picture rather than a number. */
function StageStrip() {
  const stages = [
    { at: 1, label: 'Early', note: 'Guess freely.' },
    { at: 3, label: 'Getting on', note: 'Think about it.' },
    { at: PIECES - 1, label: 'One left', note: 'Whoever misses now pays.' },
  ];
  return (
    <div className="rounded-2xl border border-slate-600/40 bg-slate-800/40 p-3">
      <div className="grid grid-cols-3 gap-2">
        {stages.map((s) => (
          <div key={s.at} className="flex flex-col items-center gap-1">
            <Gallows pieces={s.at} className="h-24 w-auto" />
            <p className="text-[10px] font-black uppercase tracking-wide text-slate-200">{s.label}</p>
            <p className="text-center text-[9px] leading-tight text-slate-500">{s.note}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * How the game works, for anyone who has never played this one.
 *
 * Only the explanation now: how many words, how many players and who is on
 * whose team are all decisions the match page makes, where the roster they
 * apply to is already on screen. A modal was the wrong place to keep them
 * , it hid the one page that says what you are about to play.
 */
function GuidePanel({ onClose }: { onClose: () => void }) {
  const sample = ['E', 'A', 'D', 'B', 'K', 'Z'];
  // Escape closes it too. See @shared/ui/dismiss.
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-5 overflow-y-auto rounded-[2rem] p-6">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-xl font-black uppercase tracking-wide text-slate-100">How to play</h3>
            <p className="text-[11px] font-semibold text-slate-400">It is not the hangman you already know.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-slate-700/50">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <HowItWorks />
        <StageStrip />

        <div className="space-y-1.5 rounded-2xl border border-slate-600/40 bg-slate-800/40 p-3">
          <p className="text-[11px] font-black uppercase tracking-wide text-slate-200">Rare letters pay more</p>
          <div className="flex flex-wrap gap-1.5">
            {sample.map((c) => (
              <span
                key={c}
                className="flex flex-col items-center rounded-lg border border-slate-500/40 bg-slate-100 px-2 py-1"
              >
                <span className="text-sm font-black leading-none text-slate-900">{c}</span>
                <span className="text-[8px] font-bold text-slate-500">{LETTER_VALUE[c]}</span>
              </span>
            ))}
          </div>
          <p className="text-[10px] leading-snug text-slate-400">
            Per copy found, before any chain bonus. A safe E is worth one; a Z that lands is worth ten ,
            the bet you're making every time you go for a letter instead of waiting for a safer one.
          </p>
        </div>

        <p className="text-center text-[10px] font-bold text-slate-500">
          Words, players and teams are set on the match page, right before you start.
        </p>
      </div>
    </div>
  );
}
