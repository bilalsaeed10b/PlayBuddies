import { useCallback, useEffect, useMemo, useState } from 'react';
import { scrimProps, useEscape } from '@shared/ui/dismiss';
import {
  ArrowLeft,
  Blocks,
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
  Users,
} from 'lucide-react';
import { askHostToEndGame, toggleFullscreen } from './fullscreen';
import { FREE_PAWNS, PAWNS, drawPawn } from './game/pawns';
import { SIDES, wallsFor } from './game/rules';
import { TIERS } from './engine/ai';
import { audioService } from './services/audio';
import { GameWallet, reportResult } from './platform/wallet';
import MatchView from './screens/MatchView';
import type { MatchConfig } from './screens/MatchView';
import type { Seat } from './engine/QuoridorEngine';
import { DEFAULT_RULES } from './types/game';
import { createLogger } from '@shared/log/logger';
import type { GameSettings, MatchRules, PlayerCount } from './types/game';

const log = createLogger('quoridor');

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

type View = 'menu' | 'pick' | 'room' | 'game' | 'offline_menu';

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

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;

/**
 * The bot rank for any seat this device fills automatically in an online game.
 *
 * The tier picker in the Menu is only ever reached offline, so `aiLevel`
 * there is really "how hard should the *practice* bot be" — a preference for
 * solo and couch play. Online, the same state used to leak into every bot
 * PlayBuddies seats for a room: pick Architect once to test the offline game,
 * then go play a real match with friends, and the empty seats were suddenly
 * merciless too. Online bots are always Runner instead, independent of
 * whatever the offline picker is currently set to.
 */
const ONLINE_AI_LEVEL = 1;

export default function App() {
  const [handoff] = useState(readHandoff);
  const online = Boolean(handoff.room);

  const [view, setView] = useState<View>(online ? 'room' : 'menu');
  const [showSettings, setShowSettings] = useState(false);
  const [showRules, setShowRules] = useState(false);
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
  /**
   * The player deliberately asked for an offline game.
   *
   * Being signed into a lobby is not the same as wanting to play in it, and
   * the offline menu is reachable from *inside* the room. Without this flag the
   * branch below would rebuild the online config for it anyway — one local
   * seat rather than two, so the second player at the keyboard drove nothing,
   * with the whole Firebase path still running underneath a game that has no
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
   * re-set it every round, but never merged with anything a guest has stored:
   * a guest's copy is only ever a placeholder until the host's rules arrive on
   * the wire.
   */
  const [rules, setRules] = useState<MatchRules>(() => {
    const saved = localStorage.getItem('quoridor_rules');
    return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : DEFAULT_RULES;
  });
  useEffect(() => {
    localStorage.setItem('quoridor_rules', JSON.stringify(rules));
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
          const data = snap.data() as {
            hostId: string;
            players: Record<string, LobbyPerson>;
            matchStarted?: boolean;
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
          });
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
   * Who is playing, and in what order.
   *
   * Sorted by uid so every client computes the identical answer from data it
   * already has — arrival order would give two players different ideas about
   * who sits at the bottom of the board. Anyone past the host's chosen player
   * count is in the room but not in the game: Quoridor seats face each other
   * across fixed edges, so a fifth person watches rather than making it a
   * five-sided board.
   */
  const people = useMemo(() => {
    return Object.values(lobby?.players ?? {})
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .slice(0, rules.players)
      .map((p) => ({
        uid: p.uid,
        displayName: p.displayName || 'Player',
        skin: p.fishIndex,
      }));
  }, [lobby, rules.players]);

  const mySkin = uid ? lobby?.players?.[uid]?.fishIndex : undefined;
  const isHost = Boolean(uid && lobby && lobby.hostId === uid);

  useEffect(() => {
    // An offline game is the player's own; the room does not get to start or
    // end it. This guard is also what stops an unrelated lobby update from
    // bouncing a couch game straight back to the room.
    if (!online || offlineMatch) return;
    if (lobby?.matchStarted && mySkin !== undefined && mySkin !== null) setView('game');
    else if (view === 'game') setView('room');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.matchStarted, mySkin, online, offlineMatch]);

  /**
   * A fresh seed and a fresh toss for every game.
   *
   * Quoridor's board is the same every time — the only thing to draw for is
   * who moves first, and the seed exists so a document left over from the last
   * game is obviously stale rather than replayable.
   *
   * They are rolled at the door, on the way *out* of a game, and never while
   * one is running: rolling them from an effect keyed on the view fires one
   * render after the board has already mounted, so the engine keeps the toss
   * it was built with while the start packet goes out carrying a different
   * one — and the guest then builds a game whose turn order disagrees with
   * every move that arrives.
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
        console.error('Could not save your pawn', e);
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
      console.error('Could not start the game', e);
    }
  }, [isHost, handoff.room]);

  const award = useCallback((won: boolean, movesTaken: number) => {
    // Something for turning up, more for crossing first, and a bonus for doing
    // it briskly — a ninety-move win is a grind, a thirty-move win is a plan.
    setCoins((c) => c + (won ? 95 : 30) + (won ? Math.max(0, 60 - movesTaken) : 0));
    reportResult(won);
  }, []);

  /**
   * Leaving the game, online: back to the room, and, for the host, the
   * go-signal comes down with it.
   *
   * `matchStarted` left set breaks a rematch two ways: pressing Start again
   * does nothing, because true to true is not a change the effect above reacts
   * to, while picking a *different* pawn is a change, so it launches a game
   * nobody started. Resetting it here, on the way out, also covers the host
   * quitting mid-game, which is what the platform's own End Game does.
   */
  const leaveMatch = useCallback(() => {
    setOfflineMatch(false);
    setView(online ? 'room' : 'menu');
    rollSession();
    if (!online || !isHost) return;
    void import('./firebase')
      .then(({ db, doc, updateDoc }) => updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: false }))
      .catch((e) => console.error('Could not reset the match flag', e));
  }, [online, isHost, handoff.room, rollSession]);

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
   * A lobby with one person in it — the platform's solo mode, or simply being
   * first into the room — must still be a game. Two of the earlier games
   * shipped with a version of this that only filled a *partly* full match, so
   * a room of one started with nothing on the other side of the board at all.
   */
  function onlineConfig(): MatchConfig {
    // `mode=single` is the platform saying this player pressed its own Solo
    // button. It should mean bots even in the moment before the roster
    // settles, rather than a game that depends on how fast a snapshot arrived.
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
          skin: mySkin ?? FREE_PAWNS[0],
        });
      } else if (person) {
        seats.push({
          id: person.uid,
          name: person.displayName,
          control: 'remote',
          aiLevel: ONLINE_AI_LEVEL,
          skin: person.skin ?? otherPawn(mySkin ?? FREE_PAWNS[0]),
        });
      } else {
        seats.push({
          id: `bot-${i}`,
          name: `${TIERS[ONLINE_AI_LEVEL].label} Bot`,
          control: 'ai',
          aiLevel: ONLINE_AI_LEVEL,
          skin: otherPawn(mySkin ?? FREE_PAWNS[0]),
        });
      }
    }

    return {
      roomId: handoff.room,
      uid,
      peerUids: crew.filter((p) => p.uid !== uid).map((p) => p.uid),
      isHost,
      seats,
      // Somebody who arrived after the seats filled up has no pawn; the board
      // still draws, they simply have nothing to move.
      localSeats,
      aiLevel: ONLINE_AI_LEVEL,
      seed: session.seed,
      first: session.first,
      rules,
    };
  }

  function offlineConfig(): MatchConfig {
    const first = seatSkin[0] ?? FREE_PAWNS[0];
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
          skin: seatSkin[i] ?? (i === 0 ? first : otherPawn(first)),
        });
      } else {
        seats.push({
          id: `bot-${i}`,
          // Numbered only when there is more than one, so a duel still reads
          // "Runner Bot" rather than "Runner Bot 2".
          name: rules.players > 2 ? `${TIERS[aiLevel].label} ${i}` : `${TIERS[aiLevel].label} Bot`,
          control: 'ai',
          aiLevel,
          skin: otherPawn(first),
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
      first: session.first,
      rules,
    };
  }

  // -- shells -----------------------------------------------------------------

  const openOffline = (locals: number) => {
    audioService.unlock();
    rollSession();
    setOfflineMatch(true);
    setSeatCount(Math.min(locals, rules.players));
    setSeatSkin({});
    setView('pick');
  };

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden">
      {(view === 'menu' || view === 'offline_menu') && (
        <Menu
          coins={coins}
          aiLevel={aiLevel}
          onAiLevel={setAiLevel}
          rules={rules}
          onSolo={() => openOffline(1)}
          onCouch={() => openOffline(2)}
          onSettings={() => setShowSettings(true)}
          onRules={() => setShowRules(true)}
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
          rules={rules}
          onPick={pickOnline}
          onStart={startMatch}
          onSettings={() => setShowSettings(true)}
          onRules={() => setShowRules(true)}
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

      {showRules && (
        <RulesPanel
          rules={rules}
          editable={!online || isHost}
          onChange={setRules}
          onClose={() => setShowRules(false)}
        />
      )}
    </div>
  );
}

/** The rules in one line, for anyone who wants to know what they are walking into. */
function rulesSummary(rules: MatchRules): string {
  return [
    rules.players === 2 ? 'Two players' : 'Four players',
    `${wallsFor(rules.players)} walls each`,
    '9×9 board',
    rules.turnTimer ? '30s turns' : 'no clock',
  ].join(' · ');
}

/** A bot takes a pawn other than the one the player picked. */
function otherPawn(playerChoice: number) {
  const options = FREE_PAWNS.filter((i) => i !== playerChoice);
  return options[Math.floor(Math.random() * options.length)] ?? 0;
}

// -- pieces -------------------------------------------------------------------

function Menu({
  coins,
  aiLevel,
  onAiLevel,
  rules,
  onSolo,
  onCouch,
  onSettings,
  onRules,
  onBack,
}: {
  coins: number;
  aiLevel: number;
  onAiLevel: (n: number) => void;
  rules: MatchRules;
  onSolo: () => void;
  onCouch: () => void;
  onSettings: () => void;
  onRules: () => void;
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
        <div className="mb-4 inline-block rounded-3xl bg-amber-400/25 p-4">
          <Grid3x3 className="h-12 w-12 text-amber-600" />
        </div>
        <h1 className="text-4xl font-black leading-none tracking-tighter sm:text-6xl">
          QUORI<span className="text-amber-500">DOR</span>
        </h1>
        <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.3em] text-slate-500">
          Run the gauntlet, build the maze
        </p>
      </div>

      <div className="panel w-full max-w-md space-y-5 rounded-[2rem] p-6">
        <button
          onClick={onSolo}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 py-4 text-lg font-black text-slate-900 transition-transform active:scale-95"
        >
          <Play className="h-5 w-5 fill-current" /> Solo — you against the bot
        </button>

        <div className="space-y-2">
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Bot rank</p>
          <div className="flex gap-1 rounded-xl bg-slate-900/5 p-1">
            {TIERS.map((tier, i) => (
              <button
                key={tier.label}
                onClick={() => onAiLevel(i)}
                className={`flex-1 rounded-lg py-2 text-xs font-black uppercase tracking-wider transition-colors ${
                  aiLevel === i ? 'bg-slate-900 text-white' : 'text-slate-500'
                }`}
              >
                {tier.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={onCouch}
          className="w-full rounded-2xl border border-black/10 bg-white/70 py-4 font-black transition-colors hover:bg-white"
        >
          Two players, one device
          <span className="mt-1 block text-[11px] font-bold normal-case tracking-normal text-slate-500">
            Turns alternate. Whoever is up taps a square, or drops a wall.
          </span>
        </button>

        <div className="rounded-2xl bg-slate-900/5 p-3 text-center text-xs leading-relaxed text-slate-500">
          <p className="mb-1 font-black uppercase tracking-[0.15em] text-slate-400">How it works</p>
          <p>One step a turn — up, down, left or right, never diagonally — or spend a wall instead.</p>
          <p className="mt-1">
            Face another pawn with nothing between you and you may jump straight over it; if a wall or the
            board's edge is right behind them, the jump bends to either side.
          </p>
          <p className="mt-2 text-slate-400">
            Playing online? Start a lobby on PlayBuddies and pick this game.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="panel flex items-center gap-2 rounded-2xl px-4 py-3 font-bold text-amber-600">
          <Coins className="h-5 w-5" /> {coins}
        </div>
        <button onClick={onRules} className="panel flex items-center gap-2 rounded-2xl px-4 py-3 font-bold text-slate-600">
          <ScrollText className="h-5 w-5" /> Rules
        </button>
        <button onClick={onSettings} aria-label="Settings" className="panel rounded-2xl p-3">
          <SettingsIcon className="h-5 w-5" />
        </button>
      </div>
      <p className="-mt-3 text-center text-[11px] font-semibold text-slate-400">{rulesSummary(rules)}</p>
    </div>
  );
}

/** A pawn card, drawn with the same code the board uses. */
function Portrait({ index, seat = 0, size = 84 }: { index: number; seat?: number; size?: number }) {
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
      const side = SIDES[seat % SIDES.length];
      drawPawn(ctx, {
        skin: index,
        x: size * 0.5,
        y: size * 0.56,
        r: size * 0.3,
        main: side.main,
        light: side.light,
        dark: side.dark,
      });
    },
    [index, seat, size],
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
   * Everyone else who has also picked this pawn. Purely informational — the
   * shape is cosmetic and the seat colour is what tells pawns apart, so
   * nothing stops two players choosing the same one.
   */
  pickedBy: Record<number, string[]>;
  onPick: (index: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
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
            className={`relative flex flex-col items-center gap-1.5 overflow-hidden rounded-2xl border p-3 text-center transition-colors ${
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
            <Portrait index={index} />
            <span className="text-sm font-black uppercase tracking-wide">{pawn.name}</span>
            {/*
              No stat bars, because there are no stats. Three identical full
              bars on every card would imply a choice that does not exist, and
              hinting at one is worse than saying plainly that these are shape.
            */}
            <span className="rounded-lg bg-slate-900/8 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.15em] text-slate-400">
              Shape only
            </span>
            <span className="text-[10px] leading-tight text-slate-500">{pawn.blurb}</span>
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
        <button onClick={onBack} aria-label="Back" className="panel shrink-0 rounded-2xl p-3">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="min-w-0 truncate text-center text-base font-black tracking-tight sm:text-2xl">{title}</h2>
        <div className="panel flex shrink-0 items-center gap-2 rounded-2xl px-3 py-2 font-bold text-amber-600">
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

  const pickedBy = useMemo(() => {
    const map: Record<number, string[]> = {};
    Object.entries(picks).forEach(([id, index]) => {
      (map[index] ??= []).push(`P${Number(id) + 1}`);
    });
    return map;
  }, [picks]);

  const pick = (index: number) => {
    if (!owned.includes(index) && !onBuy(index)) return;
    const next = { ...picks, [seat]: index };
    setPicks(next);
    if (Object.keys(next).length >= seatCount) onDone(next);
  };

  const title = seatCount > 1 ? `Player ${seat + 1} — pick a pawn` : 'Pick your pawn';
  return (
    <Shell title={title} coins={coins} onBack={onBack}>
      <PawnGrid owned={owned} coins={coins} selected={null} pickedBy={pickedBy} onPick={pick} />
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
  rules,
  onPick,
  onStart,
  onSettings,
  onRules,
  onFullscreen,
  onPlayOffline,
}: {
  ready: boolean;
  error: string | null;
  uid: string | null;
  people: { uid: string; displayName: string; skin?: number | null }[];
  hostId: string | null;
  mine: number | null | undefined;
  owned: number[];
  coins: number;
  isHost: boolean;
  rules: MatchRules;
  onPick: (index: number) => void;
  onStart: () => void;
  onSettings: () => void;
  onRules: () => void;
  onFullscreen: () => void;
  onPlayOffline: () => void;
}) {
  const pickedBy = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const p of people) {
      if (p.uid !== uid && p.skin !== undefined && p.skin !== null) (map[p.skin] ??= []).push(p.displayName);
    }
    return map;
  }, [people, uid]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-2xl font-black">{error}</h2>
        <p className="text-sm text-slate-500">Head back to the PlayBuddies lobby and try again.</p>
      </div>
    );
  }

  if (!ready || !uid) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-amber-500" />
        <p className="font-bold text-slate-600">Pulling up a chair…</p>
      </div>
    );
  }

  const iAmReady = mine !== undefined && mine !== null;
  /** Seats the rules call for that nobody has taken; bots play these. */
  const emptySeats = Math.max(0, rules.players - people.length);
  /**
   * Nobody starts until everybody has chosen.
   *
   * The host used to be able to start the moment its *own* pawn was picked,
   * which dropped anyone still choosing onto a board playing a pawn the lobby
   * had never recorded — their opponent saw a piece they had not chosen, and
   * the shop was still open over the top of it.
   */
  const everyonePicked = people.every((p) => p.skin !== undefined && p.skin !== null);
  const canStart = iAmReady && everyonePicked;
  const waitingFor = people.filter((p) => p.skin === undefined || p.skin === null).length;

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-3 p-3 sm:gap-4 sm:p-6">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-black tracking-tight sm:text-2xl">Pick your pawn</h2>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-600/90">
            {rules.players} across a 9×9 board · {wallsFor(rules.players)} walls each
            {emptySeats > 0 && ` · ${emptySeats} ${emptySeats === 1 ? 'seat' : 'seats'} to bots`}
          </p>
        </div>
        {/* The same tray the board itself carries: purse, fullscreen, settings,
            and — for the host only — the switch that ends it for everyone. */}
        <div className="flex shrink-0 items-center gap-2">
          <div className="panel flex items-center gap-2 rounded-xl px-3 py-2 font-bold text-amber-600">
            <Coins className="h-4 w-4" /> {coins}
          </div>
          <button onClick={onFullscreen} className="panel rounded-xl p-2" title="Full screen">
            <Maximize2 className="h-5 w-5" />
          </button>
          <button onClick={onSettings} aria-label="Settings" className="panel rounded-xl p-2">
            <SettingsIcon className="h-5 w-5" />
          </button>
          {isHost && (
            <button
              onClick={askHostToEndGame}
              aria-label="End game"
              className="panel rounded-xl p-2"
              title="End the game for everyone"
            >
              <LogOut className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      {/* On a phone the start button would otherwise sit below the fold, which
          is exactly what made it unreachable in the earlier games. */}
      <div className="panel shrink-0 rounded-2xl p-3 lg:hidden">
        {isHost ? (
          <button
            onClick={onStart}
            disabled={!canStart}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 py-3 text-base font-black text-slate-900 disabled:opacity-40"
          >
            <Play className="h-5 w-5 fill-current" /> START
          </button>
        ) : (
          <p className="text-center text-sm font-bold text-slate-500">
            {!iAmReady
              ? 'Pick a pawn to be ready.'
              : !everyonePicked
                ? 'Waiting for everyone to pick…'
                : 'Waiting for the host…'}
          </p>
        )}
        <button
          onClick={onRules}
          className="mt-2 flex w-full flex-col items-center gap-0.5 rounded-xl border border-black/10 bg-white/60 py-2 text-sm font-black text-slate-600 transition-colors hover:bg-white"
        >
          <span className="flex items-center gap-2">
            <ScrollText className="h-4 w-4" /> {isHost ? 'Game rules' : 'Game rules (host sets these)'}
          </span>
          <span className="px-2 text-[10px] font-semibold leading-tight text-slate-400">{rulesSummary(rules)}</span>
        </button>
        <button
          onClick={onPlayOffline}
          className="mt-2 w-full rounded-xl border border-black/10 bg-white/60 py-2.5 text-sm font-black text-slate-600 transition-colors hover:bg-white"
        >
          Play offline
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-3 sm:gap-4 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
        <div className="panel order-2 min-h-0 overflow-y-auto overscroll-contain rounded-[2rem] p-3 sm:p-6 lg:order-1 lg:col-span-2">
          <PawnGrid owned={owned} coins={coins} selected={mine ?? null} pickedBy={pickedBy} onPick={onPick} />
        </div>

        <div className="order-1 flex min-h-0 flex-col gap-3 sm:gap-4 lg:order-2">
          <div className="panel flex max-h-44 min-h-0 flex-col rounded-[2rem] p-4 sm:p-5 lg:max-h-none lg:flex-1">
            <h3 className="mb-3 flex shrink-0 items-center gap-2 text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">
              <Users className="h-4 w-4" /> At the board ({people.length})
            </h3>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1">
              {people.map((p, i) => (
                <div
                  key={p.uid}
                  className="flex items-center gap-3 rounded-2xl border p-2.5"
                  style={{
                    borderColor: `${SIDES[i].main}55`,
                    background: `${SIDES[i].main}14`,
                  }}
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white/70">
                    {p.skin !== undefined && p.skin !== null ? (
                      <Portrait index={p.skin} seat={i} size={42} />
                    ) : (
                      <Blocks className="h-5 w-5 text-slate-300" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1 truncate text-sm font-bold">
                      {p.displayName}
                      {p.uid === hostId && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
                    </p>
                    <p className="text-[10px] font-black uppercase tracking-widest" style={{ color: SIDES[i].dark }}>
                      {SIDES[i].name}
                      {p.uid === uid ? ' — you' : ''}
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
                  disabled={!canStart}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 py-4 text-lg font-black text-slate-900 disabled:opacity-40"
                >
                  <Play className="h-5 w-5 fill-current" /> START
                </button>
                <p className="mt-2 text-center text-[11px] text-slate-500">
                  {!iAmReady
                    ? 'Pick your own pawn first.'
                    : !everyonePicked
                      ? `Waiting on ${waitingFor} more to pick.`
                      : emptySeats > 0
                        ? `Bots will play ${emptySeats} of the ${rules.players} pawns.`
                        : 'Who moves first is drawn at the start.'}
                </p>
              </>
            ) : (
              <p className="text-center text-sm font-bold text-slate-500">
                {!iAmReady
                  ? 'Pick a pawn to be ready.'
                  : !everyonePicked
                    ? 'Waiting for everyone to pick…'
                    : 'Waiting for the host…'}
              </p>
            )}
            <button
              onClick={onRules}
              className="mt-3 flex w-full flex-col items-center gap-1 rounded-2xl border border-black/10 bg-white/60 py-3 font-black text-slate-600 transition-colors hover:bg-white"
            >
              <span className="flex items-center gap-2">
                <ScrollText className="h-4 w-4" /> {isHost ? 'Game rules' : 'Game rules (host sets these)'}
              </span>
              <span className="px-3 text-[10px] font-semibold leading-tight text-slate-400">{rulesSummary(rules)}</span>
            </button>
            <button
              onClick={onPlayOffline}
              className="mt-3 w-full rounded-2xl border border-black/10 bg-white/60 py-3 font-black text-slate-600 transition-colors hover:bg-white"
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
  /**
   * This device only.
   *
   * The player count and the turn clock used to live here and no longer do:
   * they change what the game *is*, so everybody has to agree on them. They
   * are Game Rules now, set by the host. What is left is genuinely local — how
   * loud it is, and how much the board is willing to tell you.
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
          <h3 className="text-xl font-black">Settings</h3>
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
 * The rules of the game, set once by the host and obeyed by everyone.
 *
 * Separate from Settings on purpose. Settings are this device's business —
 * volume, how much help the board offers — and nobody else is affected. These
 * change what the game *is*, so everyone has to be playing the same one: they
 * travel to a guest over the wire (see `packRules`) and its board is built
 * from whatever arrives, not from anything stored locally.
 *
 * A guest can open this panel and read it, but every control is dead. Letting
 * them change a copy that gets overwritten the moment the host presses start
 * would be a lie about who is in charge.
 */
function RulesPanel({
  rules,
  editable,
  onChange,
  onClose,
}: {
  rules: MatchRules;
  editable: boolean;
  onChange: (r: MatchRules) => void;
  onClose: () => void;
}) {
  // Escape closes it too. See @shared/ui/dismiss.
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-6 overflow-y-auto overscroll-contain rounded-[2rem] bg-white/95 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xl font-black">Game rules</h3>
            <p className="text-[11px] font-semibold text-slate-400">
              {editable ? 'Applies to everyone. Takes effect next game.' : 'Set by the host.'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-black/5">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-bold">
            Players
            <span className="block text-[11px] font-normal text-slate-500">
              Two sit opposite each other; four take all sides of the board. Anyone in the room beyond this
              watches — the seats are fixed edges, not a queue. Empty seats are played by bots.
            </span>
          </p>
          <div className="grid grid-cols-2 gap-2">
            {([2, 4] as PlayerCount[]).map((option) => (
              <button
                key={option}
                disabled={!editable}
                onClick={() => onChange({ ...rules, players: option })}
                className={`rounded-xl border px-2 py-2.5 text-xs font-black transition-colors disabled:opacity-50 ${
                  rules.players === option
                    ? 'border-amber-400 bg-amber-400/20 text-amber-700'
                    : 'border-black/10 bg-white/60 text-slate-500 hover:bg-white'
                }`}
              >
                {option} players
                <span className="block text-[10px] font-bold text-slate-400">{wallsFor(option)} walls each</span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-400">
            {rules.players === 2
              ? 'The duel. Ten walls apiece — enough to build a real maze between you.'
              : 'Four corners of the same board. Five walls each, so every one of them has to matter.'}
          </p>
        </div>

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold">
            Turn clock
            <span className="block text-[11px] font-normal text-slate-500">
              A move goes in on its own after thirty seconds — a step along that pawn's own shortest route,
              never a wall. Off lets a turn take as long as it takes.
            </span>
          </span>
          <input
            type="checkbox"
            disabled={!editable}
            checked={rules.turnTimer}
            onChange={(e) => onChange({ ...rules, turnTimer: e.target.checked })}
            className="h-6 w-6 shrink-0 accent-amber-500 disabled:opacity-50"
          />
        </label>

        <div className="rounded-2xl bg-slate-900/5 p-3 text-xs leading-relaxed text-slate-500">
          <p className="mb-1 font-black uppercase tracking-[0.15em] text-slate-400">Always true</p>
          <p>A pawn moves one square up, down, left or right. Never diagonally, except out of a jump.</p>
          <p className="mt-1">A wall covers two squares of groove and may not cross or overlap another.</p>
          <p className="mt-1">
            No wall may leave any pawn with no route at all to its goal, so the board can never be sealed —
            only made longer.
          </p>
        </div>
      </div>
    </div>
  );
}
