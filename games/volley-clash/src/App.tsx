import { useCallback, useEffect, useMemo, useState } from 'react';
import { scrimProps, useEscape } from '@shared/ui/dismiss';
import useShortScreen from '@shared/ui/useShortScreen';
import {
  ArrowLeft,
  Bot,
  Check,
  Coins,
  Crown,
  Loader2,
  Lock,
  LogOut,
  Maximize2,
  Play,
  Settings as SettingsIcon,
  Users,
  Volleyball,
} from 'lucide-react';
import { askHostToEndGame, askToLeaveLobby, isNativeFullscreen, toggleFullscreen, useAutoFullscreen } from './fullscreen';
import { MainMenu } from '@shared/menu/MainMenu';
import { ActionBar, HostBadge, StageFrame } from '@shared/menu/StageFrame';
import { ModeCard, OptionGroup, RuleSection, ToggleOption } from '@shared/menu/MatchControls';
import { MENU_STAGE_FIELD, parseStage } from '@shared/menu/stage';
import type { MenuStage } from '@shared/menu/stage';
import type { MenuTheme } from '@shared/menu/theme';
import { CHARACTERS, Character, FREE_CHARACTERS, drawCharacter } from './game/characters';
import { TEAM_COLORS } from './game/rules';
import {
  DEFAULT_RULES,
  TARGET_POINTS,
  cleanRules,
  packRules,
  rulesSummary,
  unpackRules,
} from './game/matchRules';
import { TIERS } from './engine/ai';
import { audioService } from './services/audio';
import { GameWallet, reportResult } from './platform/wallet';
import MatchView, { MatchConfig, Person } from './screens/MatchView';
import { GameSettings, MatchRules, Team } from './types/game';
import { createLogger } from '@shared/log/logger';

const log = createLogger('volley-clash');

/**
 * The platform owns the lobby.
 *
 * This game never shows a login screen and never asks for a room code. It reads
 * the room it was handed in the query string, writes only its own slot in it,
 * and lets PlayWithBuddies decide who is in the match.
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
  // Clean the address bar so a copied link isn't a stale room handoff.
  if (room) window.history.replaceState({}, document.title, window.location.pathname);
  return handoff;
}

/** This device's own preferences. The match's rules live in MatchRules. */
const DEFAULT_SETTINGS: GameSettings = {
  bgmVolume: 0.35,
  sfxVolume: 0.7,
  lowPower: false,
  controlScheme: 0,
};

/** Everything before the whistle is one of the shared menu stages; see `stage` in App. */
type View = 'shell' | 'game';

/** Sunset amber over deep water , the same palette the baked court uses. */
const THEME: MenuTheme = {
  tone: 'dark',
  primary: 'bg-amber-400 text-slate-900',
  selected: 'border-amber-400 bg-amber-400/15',
  accent: 'text-amber-300',
};

interface LobbyPerson {
  uid: string;
  displayName: string;
  /** Reuses the lobby's existing per-player slot; the fish game calls it fishIndex. */
  fishIndex?: number | null;
}

interface Lobby {
  hostId: string;
  players: Record<string, LobbyPerson>;
  matchStarted?: boolean;
  /** The host's rules, packed by `packRules`. Written live while the host is on the setup page. */
  matchRules?: number;
  /** Where the room is in the pre-match flow. Host-written; see @shared/menu/stage. */
  menuStage?: string;
}

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

  /** Offline setup: who is playing, as what. */
  const [seatCount, setSeatCount] = useState(1);
  const [seatChar, setSeatChar] = useState<Record<string, number>>({});
  /**
   * The player deliberately asked for an offline match.
   *
   * Being signed into a lobby is not the same as wanting to play in it, and
   * couch play is offered from *inside* the room. Without this flag the branch
   * below rebuilt the online config for it anyway: one local seat instead of
   * two, so player two's keys drove nothing, with the whole Firebase and WebRTC
   * path still running underneath a match that has no peers. That is what made
   * couch play look broken and run slowly at the same time.
   */
  const [offlineMatch, setOfflineMatch] = useState(false);

  /**
   * The purse belongs to the account, not to this browser.
   *
   * localStorage is read first so the shop is never blank while the handshake
   * with PlayWithBuddies is in flight, and written on every change so the game
   * still works opened on its own. It is a cache now rather than the record.
   */
  const wallet = useMemo(() => new GameWallet('volley-clash', 'volley_owned'), []);
  const [coins, setCoins] = useState(() => wallet.current.coins);
  const [owned, setOwned] = useState<number[]>(() => [
    ...new Set([...wallet.current.unlocks, ...FREE_CHARACTERS]),
  ]);
  /** Nothing is saved until the account has answered, or declined to. */
  const [walletReady, setWalletReady] = useState(false);

  useEffect(() => {
    wallet.open((purse) => {
      setCoins(purse.coins);
      setOwned([...new Set([...purse.unlocks, ...FREE_CHARACTERS])]);
      setWalletReady(true);
    });
    return () => wallet.close();
  }, [wallet]);

  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('volley_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  /**
   * How the next match is played. The host's copy is the one that counts.
   *
   * Remembered between matches so a host who prefers first-to-11 does not set
   * it again every time, but never merged with anything a guest has stored: a
   * guest's copy is only ever a placeholder until the host's rules arrive from
   * the lobby. `cleanRules` because this string can be an older build's.
   */
  const [rules, setRules] = useState<MatchRules>(() => {
    const saved = localStorage.getItem('volley_rules');
    return saved ? cleanRules({ ...DEFAULT_RULES, ...JSON.parse(saved) }) : DEFAULT_RULES;
  });

  // The coin balance is shared with the rest of PlayWithBuddies on purpose. Coins
  // earned in one game are worth something in the next, which is the only thing
  // that makes a single-player shop feel like part of a platform.
  //
  // Held back until the handshake settles: saving the placeholder balance the
  // moment the game booted would write a stale number straight over the real
  // one, which is how an account ends up back at zero.
  useEffect(() => {
    if (!walletReady) return;
    wallet.save({ coins, unlocks: owned });
  }, [walletReady, coins, owned, wallet]);
  useEffect(() => {
    localStorage.setItem('volley_settings', JSON.stringify(settings));
    audioService.setVolumes(settings.bgmVolume, settings.sfxVolume);
  }, [settings]);

  // ── platform session ───────────────────────────────────────────────────────
  //
  // Firebase is imported dynamically, and only down the online path.
  //
  // The SDK is 825 KB against 248 KB for the entire rest of the game, and a
  // solo or couch match never calls into it once. As a static import it became
  // a `modulepreload` in the built HTML, so every player paid for all of it
  // before the court could draw.
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
            setLobbyError("You're not in this lobby.");
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

          // The host's rules, live, on the one channel every client already has
          // open: a guest's locked setup page shows what the host is choosing
          // while they choose it, and everyone builds the same engine from it.
          //
          // Only from the setup page onward. `matchRules` is one field of a
          // lobby document that outlives a game, so the number sitting in it
          // before the host arrives there can be last night's match , or
          // another game's packing of something else entirely. Compared against
          // `data.hostId` rather than the `isHost` variable, which still
          // describes the *previous* snapshot inside this callback.
          const roomStage = parseStage(data.menuStage);
          if (
            data.hostId !== uid &&
            typeof data.matchRules === 'number' &&
            (roomStage === 'modes' || data.matchStarted)
          ) {
            setRules((current) => (packRules(current) === data.matchRules ? current : unpackRules(data.matchRules)));
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

  const people = useMemo<Person[]>(() => {
    const list = Object.values(lobby?.players ?? {});
    // Teams are assigned by a stable sort on uid, so every client independently
    // computes the same sides. Deriving them from arrival order would give two
    // players different ideas about who they are playing with.
    return [...list]
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .map((p, i) => ({
        uid: p.uid,
        displayName: p.displayName || 'Player',
        character: p.fishIndex,
        team: (i % 2) as Team,
      }));
  }, [lobby]);

  const myCharacter = uid ? lobby?.players?.[uid]?.fishIndex : undefined;
  const isHost = Boolean(uid && lobby && lobby.hostId === uid);
  const myTeam = people.find((p) => p.uid === uid)?.team ?? 0;
  /** Solo, couch, or the game opened on its own: the flow lives on this device alone. */
  const local = !online || offlineMatch;

  /**
   * The rules the match is actually played to.
   *
   * Once the go-signal is out, the copy stamped into the lobby beside it is the
   * truth for everyone, including a guest whose live copy had not landed yet.
   */
  const stampedRules = typeof lobby?.matchRules === 'number' ? unpackRules(lobby.matchRules) : null;
  const activeRules = !local && lobby?.matchStarted && stampedRules ? stampedRules : rules;

  // Saved only by the device that sets them. A guest's copy is the host's,
  // applied from the lobby; saving it would quietly replace this player's own
  // preference for the next room they host or the next match they play alone.
  useEffect(() => {
    if (online && !offlineMatch && !isHost) return;
    localStorage.setItem('volley_rules', JSON.stringify(rules));
  }, [rules, online, offlineMatch, isHost]);

  /**
   * Three in the room is always doubles.
   *
   * Singles fills each side to one, so with three humans on court it would add
   * no bot at all and lay out a 2v1. The card is locked on the setup page for
   * the same reason; this is what stops a host who chose singles in a room of
   * two from being left on it when a third walks in.
   */
  useEffect(() => {
    if (!online || offlineMatch || !isHost || !lobby) return;
    if (Object.keys(lobby.players ?? {}).length > 2 && !rules.doubles) setRules((r) => ({ ...r, doubles: true }));
  }, [online, offlineMatch, isHost, lobby, rules.doubles]);

  useEffect(() => {
    // An offline match is the player's own; the room does not get to start or
    // end it. This guard is also what stops an unrelated lobby update from
    // bouncing a couch match straight back to the room.
    if (!online || offlineMatch) return;
    if (lobby?.matchStarted && myCharacter !== undefined && myCharacter !== null) setView('game');
    else if (view === 'game') setView('shell');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.matchStarted, myCharacter, online, offlineMatch]);

  const buy = useCallback(
    (index: number) => {
      const price = CHARACTERS[index].price;
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
        console.error('Could not save your character', e);
      }
    },
    [uid, owned, buy, handoff.room],
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

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      // The rules ride with the go-signal in the same write, so the snapshot
      // that opens the court on every guest also carries the target score and
      // the court size it is built from, even if the live sync below had not
      // landed yet.
      await updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: true, matchRules: packRules(rules) });
    } catch (e) {
      log.error('match:start-failed', { message: String((e as Error)?.message ?? e) });
      console.error('Could not start the match', e);
    }
  }, [isHost, handoff.room, rules]);

  const award = useCallback((won: boolean, score: [number, number]) => {
    // Something for turning up, more for winning, and a bonus for a close one.
    const margin = Math.abs(score[0] - score[1]);
    setCoins((c) => c + (won ? 90 : 30) + (margin <= 2 ? 25 : 0));
    reportResult(won, { margin });
  }, []);

  const remoteStage = parseStage(lobby?.menuStage);

  /**
   * The rules go to the room the moment the host changes them on the setup
   * page, not only with the start signal, so every guest's locked copy of that
   * page shows what the host is choosing while they choose it.
   */
  useEffect(() => {
    if (!online || offlineMatch || !isHost || remoteStage !== 'modes' || !lobby) return;
    const packed = packRules(rules);
    if (lobby.matchRules !== packed) void writeLobby({ matchRules: packed });
  }, [online, offlineMatch, isHost, remoteStage, lobby, rules, writeLobby]);

  /**
   * Leaving the match: back to the setup page for a rematch, and , for the
   * host , the go-signal comes down with it.
   *
   * `matchStarted` was never reset anywhere after being set, so a rematch was
   * broken two different ways: pressing "Start Match" again did nothing,
   * because true -> true isn't a change the effect above reacts to, while
   * simply picking a *different* character was , `myCharacter` changing while
   * the stale flag was still `true` launched a match nobody had started.
   *
   * Resetting it here, on the way out, rather than only when a round finishes
   * normally, also covers the host quitting mid-match: with nobody left to run
   * the authoritative simulation, ending the match for everyone is correct,
   * not a bug , it is exactly what the platform's own "End Game" already does.
   */
  const leaveMatch = useCallback(() => {
    setView('shell');
    // Offline, the flow is this device's: straight back to its own setup page.
    // Online, the room's stage never left that page, so clearing the flag is
    // all it takes to bring everyone back to it.
    if (offlineMatch) {
      setLocalStage('modes');
      return;
    }
    if (!online || !isHost) return;
    void writeLobby({ matchStarted: false });
  }, [online, isHost, offlineMatch, writeLobby]);

  // ── in the match ───────────────────────────────────────────────────────────
  if (view === 'game') {
    const config = online && uid && !offlineMatch ? onlineConfig() : offlineConfig();

    return (
      <>
        <MatchView
          config={config}
          settings={settings}
          rules={activeRules}
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

  /** One a side, or two. Three humans can never be singles: see the effect above. */
  function perTeamFor(rules: MatchRules) {
    return rules.doubles || people.length > 2 ? 2 : 1;
  }

  /**
   * Every empty seat gets a bot.
   *
   * This used to fill the fourth slot of a three-person lobby and nothing else,
   * which meant a lobby with one person in it , the platform's solo mode, or
   * simply being first into the room , started a match with **no opponent on
   * the court at all**. The ball landed on an empty half over and over and the
   * score climbed on its own.
   *
   * Ids and characters are derived, never random: the host simulates the bots
   * and every client draws them, so all of them have to agree on who is there
   * and what they look like without exchanging a word about it. Their *rank*
   * now comes down from the lobby with the rest of the rules, for the same
   * reason: it used to be whatever each device happened to have picked.
   */
  function onlineConfig(): MatchConfig {
    const perTeam = perTeamFor(activeRules);
    const taken = new Set(people.map((p) => p.character).filter((c): c is number => c !== null && c !== undefined));
    const pool = FREE_CHARACTERS.filter((c) => !taken.has(c));

    const bots: MatchConfig['bots'] = [];
    for (const team of [0, 1] as Team[]) {
      const humans = people.filter((p) => p.team === team).length;
      for (let i = humans; i < perTeam; i++) {
        bots.push({
          id: `bot-${team}-${i}`,
          team,
          character: pool[bots.length % Math.max(1, pool.length)] ?? 0,
          level: activeRules.aiLevel,
          name: TIERS[activeRules.aiLevel].label,
        });
      }
    }

    return {
      roomId: handoff.room,
      uid,
      hostId: lobby?.hostId ?? null,
      people,
      localIds: uid ? [uid] : [],
      localCharacter: uid ? { [uid]: myCharacter ?? 0 } : {},
      localNames: uid ? { [uid]: handoff.displayName || 'You' } : {},
      localTeams: uid ? { [uid]: myTeam } : {},
      bots,
    };
  }

  function offlineConfig(): MatchConfig {
    const localIds = Array.from({ length: seatCount }, (_, i) => `seat-${i}`);
    const localTeams: Record<string, Team> = {};
    const localNames: Record<string, string> = {};
    localIds.forEach((id, i) => {
      // Couch play is 1v1 across the net, not two people on the same side.
      localTeams[id] = (i % 2) as Team;
      localNames[id] = seatCount > 1 ? `P${i + 1}` : 'You';
    });
    const bots: MatchConfig['bots'] =
      seatCount === 1
        ? [
            {
              id: 'bot-0',
              team: 1,
              character: pickBotCharacter(seatChar['seat-0'] ?? 0),
              level: rules.aiLevel,
              name: TIERS[rules.aiLevel].label,
            },
          ]
        : [];
    return {
      roomId: null,
      uid: null,
      hostId: null,
      people: [],
      localIds,
      localCharacter: seatChar,
      localNames,
      localTeams,
      bots,
    };
  }

  // ── the pre-match flow ─────────────────────────────────────────────────────

  const openOffline = (locals: number) => {
    audioService.unlock();
    setOfflineMatch(true);
    setSeatCount(locals);
    setSeatChar({});
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
      next === 'modes' ? { [MENU_STAGE_FIELD]: next, matchRules: packRules(rules) } : { [MENU_STAGE_FIELD]: next },
    );
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
      {!local && isHost && toolButton('End the match for everyone', <LogOut className="h-5 w-5" />, askHostToEndGame)}
    </>
  );

  let screen: React.ReactNode;
  if (!local && lobbyError) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-2xl font-black">{lobbyError}</h2>
        <p className="text-sm text-white/60">Head back to the PlayWithBuddies lobby and try again.</p>
      </div>
    );
  } else if (!local && (!authChecked || !uid || !lobby)) {
    screen = (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-amber-300" />
        <p className="font-bold text-white/80">Walking onto the court…</p>
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
        singleHint="You against the bot"
        multiHint={`Everyone in this room · ${people.length} on court`}
        toolbar={
          <>
            {coinChip}
            {toolButton('Full screen', <Maximize2 className="h-5 w-5" />, fullscreen)}
            {toolButton('Leave', <LogOut className="h-5 w-5" />, askToLeaveLobby)}
          </>
        }
        title={
          <>
            <div className="mb-3 inline-block rounded-3xl bg-amber-400/20 p-4 short:hidden">
              <Volleyball className="h-12 w-12 text-amber-300" />
            </div>
            <h1 className="text-4xl font-black leading-none tracking-tighter drop-shadow-lg sm:text-6xl short:text-3xl">
              VOLLEY<span className="text-amber-300">CLASH</span>
            </h1>
            <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.3em] text-white/70">
              Two touches, one winner
            </p>
          </>
        }
        secondary={
          <button
            onClick={() => openOffline(2)}
            disabled={online && !isHost}
            className="w-full rounded-2xl border border-white/15 bg-white/5 py-2.5 text-sm font-black text-white/80 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 short:py-1.5"
          >
            Two players, one PC
            <span className="block text-[10px] font-bold text-white/45">
              Player 1 on A / D / W · Player 2 on the arrow keys
            </span>
          </button>
        }
        footer={
          <p className="max-w-md text-center text-[11px] leading-relaxed text-white/45 short:hidden">
            Move left and right, jump. That is it. Where the ball hits you decides where it goes. On a touchscreen,
            drag the left half to move and tap the right half to jump.
            {!online && (
              <span className="mt-1 block text-white/35">
                Playing online? Start a lobby on PlayWithBuddies and pick this game.
              </span>
            )}
          </p>
        }
      />
    );
  } else if (stage === 'customize') {
    const slots: CourtSlot[] = local
      ? Array.from({ length: seatCount }, (_, i) => ({
          key: `seat-${i}`,
          label: seatCount > 1 ? `Player ${i + 1}` : 'You',
          character: seatChar[`seat-${i}`],
          team: (i % 2) as Team,
          editable: true,
        }))
      : people.map((p) => ({
          key: p.uid,
          label: p.displayName,
          character: p.character,
          team: p.team ?? 0,
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
          setSeatChar((s) => ({ ...s, [key]: index }));
        }}
        onBack={local ? closeOffline : isHost ? () => goStage('menu') : undefined}
        onNext={() => goStage('modes')}
      />
    );
  } else {
    // Built the same way onlineConfig and offlineConfig build the match, so the
    // page shows exactly who Serve is about to put on the court.
    const perTeam = perTeamFor(rules);
    const lineup: CourtSlot[] = [];
    if (local) {
      for (let i = 0; i < seatCount; i++) {
        lineup.push({
          key: `seat-${i}`,
          label: seatCount > 1 ? `Player ${i + 1}` : 'You',
          character: seatChar[`seat-${i}`],
          team: (i % 2) as Team,
          editable: true,
        });
      }
      if (seatCount === 1) {
        lineup.push({ key: 'bot-0', label: TIERS[rules.aiLevel].label, team: 1, editable: false, bot: true });
      }
    } else {
      for (const p of people) {
        lineup.push({
          key: p.uid,
          label: p.displayName,
          character: p.character,
          team: p.team ?? 0,
          editable: false,
          you: p.uid === uid,
          isHost: p.uid === lobby?.hostId,
        });
      }
      for (const team of [0, 1] as Team[]) {
        const humans = people.filter((p) => p.team === team).length;
        for (let i = humans; i < perTeam; i++) {
          lineup.push({
            key: `bot-${team}-${i}`,
            label: TIERS[rules.aiLevel].label,
            team,
            editable: false,
            bot: true,
          });
        }
      }
    }
    const waiting = lineup.filter((s) => !s.bot && !hasCharacter(s.character)).length;
    const bots = lineup.filter((s) => s.bot).length;
    const locked = !local && !isHost;
    screen = (
      <ModesScreen
        rules={rules}
        locked={locked}
        local={local}
        seatCount={seatCount}
        /** Singles lays out one a side, so three humans can never have it. */
        singlesAllowed={local || people.length <= 2}
        hostName={hostName}
        toolbar={stageToolbar}
        lineup={lineup}
        bots={bots}
        onRules={setRules}
        onSeatCount={local ? setSeatCount : undefined}
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
        startDisabled={waiting > 0}
        startNote={
          locked
            ? `${hostName || 'The host'} serves when everyone is set.`
            : waiting > 0
              ? local
                ? `${waiting === 1 ? 'A player' : `${waiting} players`} at this device still needs a character. Go back a step.`
                : `Waiting on ${waiting} more to pick a character.`
              : bots > 0
                ? `Bots play ${bots} of the ${lineup.length} on court.`
                : 'Everyone is ready.'
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
    </div>
  );
}

/** Whether a lobby slot or a seat at this device has chosen a character yet. */
function hasCharacter(index: number | null | undefined): index is number {
  return index !== undefined && index !== null;
}

/** The bot picks something other than what the player picked. */
function pickBotCharacter(playerChoice: number) {
  const options = FREE_CHARACTERS.filter((i) => i !== playerChoice);
  return options[Math.floor(Math.random() * options.length)] ?? 0;
}

/** One person on the court: a player in the room, a seat at this device, or a bot. */
interface CourtSlot {
  key: string;
  label: string;
  character?: number | null;
  team: Team;
  /** Whether this device picks for this slot. */
  editable: boolean;
  isHost?: boolean;
  you?: boolean;
  bot?: boolean;
}

// ── pieces ───────────────────────────────────────────────────────────────────

/** A character card, drawn with the same code the match uses. */
function Portrait({ index, size = 68, ring = 'rgba(255,255,255,0.28)' }: { index: number; size?: number; ring?: string }) {
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
      drawCharacter(ctx, CHARACTERS[index], size / 2, size * 0.62, size * 0.34, 1, ring);
    },
    [index, size, ring],
  );
  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

/**
 * Stat bars used to live here, one row each for speed, jump and power. They are
 * gone with the stats: showing three identical full bars on every card would
 * imply a choice that no longer exists, and hinting at one is worse than
 * saying plainly that these are skins.
 */
function SkinNote() {
  return (
    <div className="rounded-lg bg-black/25 px-2 py-1 text-center text-[9px] font-black uppercase tracking-[0.15em] text-white/45">
      Skin only · same stats
    </div>
  );
}

function CharacterGrid({
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
   * Everyone else who has also picked this character. Purely informational ,
   * these are skins and nothing else, so nothing stops two players choosing
   * the same one.
   */
  pickedBy: Record<number, string[]>;
  onPick: (index: number) => void;
}) {
  // 184px a card, on a 360px screen held sideways. Keep the face and the name.
  const short = useShortScreen();
  return (
    <div className={`grid ${short ? 'grid-cols-5 gap-2' : 'grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'}`}>
      {CHARACTERS.map((ch: Character, index) => {
        const isOwned = owned.includes(index);
        const others = pickedBy[index] ?? [];
        const isSelected = selected === index;
        const affordable = coins >= ch.price;

        return (
          <button
            key={ch.name}
            onClick={() => onPick(index)}
            disabled={!isOwned && !affordable}
            className={`relative flex flex-col items-center overflow-hidden rounded-2xl border text-left transition-colors ${
              short ? 'gap-0.5 p-1.5' : 'gap-2 p-3'
            } ${
              isSelected
                ? 'border-amber-400 bg-amber-400/20 shadow-[0_0_0_3px_rgba(251,191,36,0.25)]'
                : isOwned
                  ? 'border-white/15 bg-white/10 hover:bg-white/20'
                  : 'border-amber-400/40 bg-amber-400/10'
            }`}
          >
            {!isOwned && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[1px]">
                <Lock className="mb-0.5 h-4 w-4 text-amber-300" />
                <span className="text-[11px] font-black text-amber-300">{ch.price}</span>
                {!affordable && <span className="text-[9px] font-bold text-rose-300">not enough</span>}
              </div>
            )}
            <Portrait index={index} size={short ? 42 : 68} />
            <span
              className={`font-black uppercase tracking-wide ${short ? 'text-[10px] leading-tight' : 'text-sm'}`}
            >
              {ch.name}
            </span>
            <div className="w-full short:hidden">
              <SkinNote />
            </div>
            <span className="text-[10px] leading-tight text-white/50 short:hidden">{ch.blurb}</span>
            {others.length > 0 && (
              <span className="text-[9px] font-black uppercase text-white/40">Also played by {others.join(', ')}</span>
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
 * Stage 2: the character.
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
  onPick,
  onBack,
  onNext,
}: {
  slots: CourtSlot[];
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

  // On a couch, the next player's turn to choose comes round on its own , the
  // old flow's one real convenience, kept.
  useEffect(() => {
    if (mine.length < 2) return;
    const current = mine.find((s) => s.key === activeKey);
    if (current && !hasCharacter(current.character)) return;
    const next = mine.find((s) => !hasCharacter(s.character));
    if (next && next.key !== activeKey) setActiveKey(next.key);
  }, [mine, activeKey]);

  const pickedBy = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const s of slots) if (s !== active && hasCharacter(s.character)) (map[s.character] ??= []).push(s.label);
    return map;
  }, [slots, active]);

  const waiting = slots.filter((s) => !hasCharacter(s.character)).length;
  const mineWaiting = mine.filter((s) => !hasCharacter(s.character)).length;

  return (
    <StageFrame
      theme={THEME}
      step={2}
      title={active && mine.length > 1 ? `${active.label}, pick a character` : 'Pick your character'}
      subtitle={`${slots.length} on court · skins only, every one plays the same`}
      onBack={onBack}
      toolbar={toolbar}
      status={
        !leads ? (
          <HostBadge theme={THEME}>{hostName || 'The host'} sets the match up once everyone has picked</HostBadge>
        ) : undefined
      }
      footer={
        <ActionBar
          theme={THEME}
          label="Next: match setup"
          onAction={leads ? onNext : undefined}
          disabled={waiting > 0}
          note={
            leads
              ? waiting === 0
                ? 'Everyone has a character. Next, the match.'
                : mineWaiting >= waiting
                  ? mineWaiting > 1
                    ? `Pick one for each of the ${mineWaiting} players at this device.`
                    : 'Pick a character to carry on.'
                  : `Waiting on ${waiting} more to pick.`
              : mineWaiting === 0
                ? `Ready. Waiting for ${hostName || 'the host'} to set the match up...`
                : 'Pick a character to be ready.'
          }
        />
      }
    >
      <div className="flex h-full flex-col gap-3 short:gap-2">
        <div className="flex shrink-0 gap-2 overflow-x-auto overscroll-contain pb-1">
          {slots.map((s) => (
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
                {hasCharacter(s.character) ? (
                  <Portrait index={s.character} size={36} ring={`${TEAM_COLORS[s.team].main}88`} />
                ) : (
                  <Volleyball className="h-4 w-4 text-white/35" />
                )}
              </span>
              <span className="min-w-0">
                <span className="flex max-w-[120px] items-center gap-1 truncate text-xs font-black">
                  {s.label}
                  {s.isHost && <Crown className="h-3 w-3 shrink-0 text-amber-300" />}
                </span>
                <span
                  className={`block text-[9px] font-black uppercase tracking-wider ${
                    hasCharacter(s.character) ? 'text-amber-300' : 'text-white/40'
                  }`}
                >
                  {hasCharacter(s.character) ? `Ready · ${CHARACTERS[s.character]?.name ?? ''}` : 'Choosing...'}
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
            <CharacterGrid
              owned={owned}
              coins={coins}
              selected={active.character ?? null}
              pickedBy={pickedBy}
              onPick={(index) => onPick(active.key, index)}
            />
          ) : (
            <p className="py-10 text-center text-sm font-bold text-white/55">
              Everyone on this court has already picked. Sit tight.
            </p>
          )}
        </div>
      </div>
    </StageFrame>
  );
}

/**
 * How the court is laid out , the only thing here that changes the shape of a
 * match rather than a detail of it, so it gets the cards.
 *
 * Offline the two cards are the two flows this game has always had: one seat
 * against a bot, or two seats across the net. Online they are the two court
 * sizes the engine lays out (`arenaFor`), with bots filling whatever the room
 * does not.
 */
const LOCAL_MODES = [
  { seats: 1, title: 'Solo', badge: '1v1', description: 'You on one side, a bot on the other.' },
  { seats: 2, title: 'Couch', badge: '2 players, 1 PC', description: 'P1 on A / D / W, P2 on the arrow keys.' },
];

const COURT_MODES = [
  { doubles: false, title: 'Singles', badge: '1v1', description: 'One a side on the standard court.' },
  { doubles: true, title: 'Doubles', badge: '2v2', description: 'Two a side on the wide court. Bots fill the gaps.' },
];

/**
 * Stage 3: the whole match on one page, never a popup.
 *
 * The host's copy is the controls; a guest's copy is the same page with every
 * control locked, kept current from the lobby as the host clicks. See
 * MatchControls for the pieces, and the `matchRules` effect in App for the wire
 * that keeps the two in step.
 */
function ModesScreen({
  rules,
  locked,
  local,
  seatCount,
  singlesAllowed,
  hostName,
  toolbar,
  lineup,
  bots,
  onRules,
  onSeatCount,
  onBack,
  onStart,
  startDisabled,
  startNote,
}: {
  rules: MatchRules;
  locked: boolean;
  /** This device's own match: solo, couch, or the game opened on its own. */
  local: boolean;
  seatCount: number;
  singlesAllowed: boolean;
  hostName?: string;
  toolbar: React.ReactNode;
  lineup: CourtSlot[];
  /** How many of the lineup are bots. */
  bots: number;
  onRules: (rules: MatchRules) => void;
  /** Offline only: the mode cards are seats at this device rather than a court size. */
  onSeatCount?: (seats: number) => void;
  onBack?: () => void;
  onStart?: () => void;
  startDisabled?: boolean;
  startNote: string;
}) {
  const set = (patch: Partial<MatchRules>) => onRules({ ...rules, ...patch });
  const format = local ? (seatCount > 1 ? 'Couch 1v1' : 'Solo') : rules.doubles ? '2v2' : '1v1';

  return (
    <StageFrame
      theme={THEME}
      step={3}
      title="Match setup"
      subtitle={`${format} · ${rulesSummary(rules)}`}
      onBack={onBack}
      toolbar={toolbar}
      status={
        locked ? <HostBadge theme={THEME}>{hostName || 'The host'} is setting the match up...</HostBadge> : undefined
      }
      footer={
        <ActionBar
          theme={THEME}
          label="Serve"
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
            title="The court"
            hint={
              local
                ? 'Two at one keyboard share the court; on your own, a bot takes the other side.'
                : 'Everyone in the room plays. Doubles widens the court and fills any empty spot with a bot.'
            }
            locked={locked}
          >
            <div className="grid grid-cols-2 gap-2">
              {local
                ? LOCAL_MODES.map((mode) => (
                    <ModeCard
                      key={mode.seats}
                      theme={THEME}
                      title={mode.title}
                      badge={mode.badge}
                      description={mode.description}
                      icon={mode.seats === 1 ? <Volleyball className="h-4 w-4" /> : <Users className="h-4 w-4" />}
                      selected={seatCount === mode.seats}
                      locked={locked || !onSeatCount}
                      onSelect={() => onSeatCount?.(mode.seats)}
                    />
                  ))
                : COURT_MODES.map((mode) => (
                    <ModeCard
                      key={mode.title}
                      theme={THEME}
                      title={mode.title}
                      badge={mode.badge}
                      description={mode.description}
                      icon={mode.doubles ? <Users className="h-4 w-4" /> : <Volleyball className="h-4 w-4" />}
                      selected={rules.doubles === mode.doubles}
                      locked={locked || (!mode.doubles && !singlesAllowed)}
                      onSelect={() => set({ doubles: mode.doubles })}
                    />
                  ))}
            </div>
            {!local && !singlesAllowed && (
              <p className="text-[11px] font-bold text-white/45">
                Three or more on court is always doubles , singles has nowhere to put them.
              </p>
            )}
          </RuleSection>

          <RuleSection
            theme={THEME}
            title="Points to win"
            hint="Every rally scores, whoever served it."
            locked={locked}
          >
            <OptionGroup
              theme={THEME}
              locked={locked}
              value={rules.targetPoints}
              onChange={(targetPoints) => set({ targetPoints })}
              options={TARGET_POINTS.map((n) => ({
                value: n,
                label: `First to ${n}`,
                sub: n === 5 ? 'quick' : n === 7 ? 'standard' : 'long',
              }))}
            />
            <ToggleOption
              theme={THEME}
              label="Win by two"
              hint={`${rules.targetPoints}-${rules.targetPoints - 1} keeps playing until someone is two clear. Off means first to ${rules.targetPoints} takes it.`}
              value={rules.winByTwo}
              locked={locked}
              onChange={(winByTwo) => set({ winByTwo })}
            />
          </RuleSection>

          {bots > 0 && (
            <RuleSection
              theme={THEME}
              title="Bot rank"
              hint="How well the bots on the empty spots read the ball."
              locked={locked}
            >
              <OptionGroup
                theme={THEME}
                locked={locked}
                value={rules.aiLevel}
                onChange={(aiLevel) => set({ aiLevel })}
                options={TIERS.map((tier, i) => ({ value: i, label: tier.label }))}
              />
            </RuleSection>
          )}
        </div>

        <div className="space-y-4 short:space-y-2">
          <RuleSection
            theme={THEME}
            title={`On court · ${lineup.length}`}
            hint="Sides are set by the room, not by choice, so nobody waits on a team pick. Bots fill anything left."
            locked={locked}
          >
            <div className="space-y-1.5">
              {lineup.map((s) => (
                <div
                  key={s.key}
                  className="flex items-center gap-2 rounded-xl border p-1.5"
                  style={{
                    borderColor: `${TEAM_COLORS[s.team].main}55`,
                    background: `${TEAM_COLORS[s.team].main}18`,
                  }}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/25">
                    {hasCharacter(s.character) ? (
                      <Portrait index={s.character} size={36} ring={`${TEAM_COLORS[s.team].main}88`} />
                    ) : s.bot ? (
                      <Bot className="h-4 w-4 text-white/45" />
                    ) : (
                      <Volleyball className="h-4 w-4 text-white/35" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`flex items-center gap-1 truncate text-xs font-bold ${s.bot ? 'text-white/55' : ''}`}>
                      {s.label}
                      {s.you && <span className="shrink-0 text-white/45"> · you</span>}
                      {s.isHost && <Crown className="h-3 w-3 shrink-0 text-amber-300" />}
                    </span>
                    <span
                      className="block text-[9px] font-black uppercase tracking-widest"
                      style={{ color: TEAM_COLORS[s.team].light }}
                    >
                      {TEAM_COLORS[s.team].name}
                      {s.bot ? ' · bot' : !hasCharacter(s.character) ? ' · choosing' : ''}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </RuleSection>

          <div className="rounded-2xl bg-black/25 p-3 text-[11px] leading-relaxed text-white/50 short:hidden">
            <p className="mb-1 font-black uppercase tracking-[0.15em] text-white/40">Always true</p>
            <p>Where the ball hits you decides where it goes. There is no aim button.</p>
            <p className="mt-1">Two touches a side, then it has to cross. A third is a point against you.</p>
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
   * The target score and win-by-two used to live here and no
   * longer do. They decide what the match *is*, so everybody in it has to agree
   * on them , and while they sat beside the volume sliders every machine kept
   * its own copy, which online was quietly wrong in both directions. They are
   * match rules now, set by the host on the setup page. What is left is
   * genuinely local: how loud it is, how hard it draws, and which end of the
   * keyboard player one sits at.
   */
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
              className="w-full accent-amber-400"
            />
          </div>
        ))}

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold">
            Low power mode
            <span className="block text-[11px] font-normal text-white/50">
              Smaller canvas, no ball trail. Turn this on if the court stutters.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.lowPower}
            onChange={(e) => onChange({ ...settings, lowPower: e.target.checked })}
            className="h-6 w-6 shrink-0 accent-amber-400"
          />
        </label>

        <div className="space-y-2">
          <span className="text-sm font-bold">Keyboard</span>
          <div className="flex gap-1 rounded-xl bg-black/30 p-1">
            {['P1 on WASD', 'P1 on arrows'].map((label, i) => (
              <button
                key={label}
                onClick={() => onChange({ ...settings, controlScheme: i })}
                className={`flex-1 rounded-lg py-2 text-xs font-black transition-colors ${
                  settings.controlScheme === i ? 'bg-amber-400 text-slate-900' : 'text-white/60'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-white/50">
            Two players at one keyboard always get one layout each; this says which one goes first.
          </p>
        </div>
      </div>
    </div>
  );
}
