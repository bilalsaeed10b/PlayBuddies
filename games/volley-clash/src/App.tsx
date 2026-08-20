import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Coins,
  Crown,
  Loader2,
  Lock,
  Maximize2,
  Play,
  Settings as SettingsIcon,
  Users,
  Volleyball,
} from 'lucide-react';
import { IN_IFRAME, toggleFullscreen } from './fullscreen';
import { CHARACTERS, Character, FREE_CHARACTERS, drawCharacter } from './game/characters';
import { BALANCE, TEAM_COLORS } from './game/rules';
import { TIERS } from './engine/ai';
import { audioService } from './services/audio';
import MatchView, { MatchConfig, Person } from './screens/MatchView';
import { GameSettings, Team } from './types/game';

/**
 * The platform owns the lobby.
 *
 * This game never shows a login screen and never asks for a room code. It reads
 * the room it was handed in the query string, writes only its own slot in it,
 * and lets PlayBuddies decide who is in the match.
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

const DEFAULT_SETTINGS: GameSettings = {
  bgmVolume: 0.35,
  sfxVolume: 0.7,
  lowPower: false,
  controlScheme: 0,
  targetPoints: 7,
  winByTwo: false,
  powerUps: true,
  powerRate: 1,
};

type View = 'menu' | 'solo' | 'couch' | 'room' | 'game' | 'offline_menu';

interface LobbyPerson {
  uid: string;
  displayName: string;
  /** Reuses the lobby's existing per-player slot; the fish game calls it fishIndex. */
  fishIndex?: number | null;
}

export default function App() {
  const [handoff] = useState(readHandoff);
  const online = Boolean(handoff.room);

  const [view, setView] = useState<View>(online ? 'room' : 'menu');
  const [showSettings, setShowSettings] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [lobby, setLobby] = useState<{
    hostId: string;
    players: Record<string, LobbyPerson>;
    matchStarted?: boolean;
  } | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  /** Offline setup: who is playing, as what, against what. */
  const [seatCount, setSeatCount] = useState(1);
  const [seatChar, setSeatChar] = useState<Record<string, number>>({});
  /**
   * The player deliberately asked for an offline match.
   *
   * Being signed into a lobby is not the same as wanting to play in it, and
   * 'Play Offline / Couch' is offered from *inside* the room. Without this flag
   * the branch below rebuilt the online config for it anyway: one local seat
   * instead of two, so player two's keys drove nothing, with the whole Firebase
   * and WebRTC path still running underneath a match that has no peers. That is
   * what made couch play look broken and run slowly at the same time.
   */
  const [offlineMatch, setOfflineMatch] = useState(false);
  const [aiLevel, setAiLevel] = useState(1);

  const [coins, setCoins] = useState(() => Number(localStorage.getItem('fishy_coins') || 0));
  const [owned, setOwned] = useState<number[]>(() => {
    const saved = localStorage.getItem('volley_owned');
    const parsed: number[] = saved ? JSON.parse(saved) : [];
    return [...new Set([...parsed, ...FREE_CHARACTERS])];
  });
  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('volley_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  // The coin balance is shared with the rest of PlayBuddies on purpose — coins
  // earned in one game are worth something in the next, which is the only thing
  // that makes a single-player shop feel like part of a platform.
  useEffect(() => localStorage.setItem('fishy_coins', String(coins)), [coins]);
  useEffect(() => localStorage.setItem('volley_owned', JSON.stringify(owned)), [owned]);
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
          const data = snap.data() as {
            hostId: string;
            players: Record<string, LobbyPerson>;
            matchStarted?: boolean;
          };
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

  useEffect(() => {
    // An offline match is the player's own; the room does not get to start or
    // end it. This guard is also what stops an unrelated lobby update from
    // bouncing a couch match straight back to the room.
    if (!online || offlineMatch) return;
    if (lobby?.matchStarted && myCharacter !== undefined && myCharacter !== null) setView('game');
    else if (view === 'game') setView('room');
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

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      await updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: true });
    } catch (e) {
      console.error('Could not start the match', e);
    }
  }, [isHost, handoff.room]);

  const award = useCallback((won: boolean, score: [number, number]) => {
    // Something for turning up, more for winning, and a bonus for a close one.
    const margin = Math.abs(score[0] - score[1]);
    setCoins((c) => c + (won ? 90 : 30) + (margin <= 2 ? 25 : 0));
  }, []);

  /**
   * Leaving the match, online: back to the room, and — for the host — the
   * go-signal comes down with it.
   *
   * `matchStarted` was never reset anywhere after being set, so a rematch was
   * broken two different ways: pressing "Start Match" again did nothing,
   * because true -> true isn't a change the effect above reacts to, while
   * simply picking a *different* character was — `myCharacter` changing while
   * the stale flag was still `true` launched a match nobody had started.
   *
   * Resetting it here, on the way out, rather than only when a round finishes
   * normally, also covers the host quitting mid-match: with nobody left to run
   * the authoritative simulation, ending the match for everyone is correct,
   * not a bug — it is exactly what the platform's own "End Game" already does.
   */
  const leaveMatch = useCallback(() => {
    setOfflineMatch(false);
    setView(online ? 'room' : 'menu');
    if (!online || !isHost) return;
    void import('./firebase')
      .then(({ db, doc, updateDoc }) => updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: false }))
      .catch((e) => console.error('Could not reset the match flag', e));
  }, [online, isHost, handoff.room]);

  // ── in the match ───────────────────────────────────────────────────────────
  if (view === 'game') {
    const config = online && uid && !offlineMatch ? onlineConfig() : offlineConfig();

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

  /**
   * Every empty seat gets a bot.
   *
   * This used to fill the fourth slot of a three-person lobby and nothing else,
   * which meant a lobby with one person in it — the platform's solo mode, or
   * simply being first into the room — started a match with **no opponent on
   * the court at all**. The ball landed on an empty half over and over and the
   * score climbed on its own.
   *
   * Ids and characters are derived, never random: the host simulates the bots
   * and every client draws them, so all of them have to agree on who is there
   * and what they look like without exchanging a word about it.
   */
  function onlineConfig(): MatchConfig {
    const perTeam = people.length > 2 ? 2 : 1;
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
          level: aiLevel,
          name: TIERS[aiLevel].label,
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
        ? [{ id: 'bot-0', team: 1, character: pickBotCharacter(seatChar['seat-0'] ?? 0), level: aiLevel, name: TIERS[aiLevel].label }]
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

  // ── shells ─────────────────────────────────────────────────────────────────
  return (
    <div className="relative h-[100dvh] w-full overflow-hidden text-white">
      {view === 'menu' && (
        <Menu
          coins={coins}
          onSolo={() => {
            audioService.unlock();
            setOfflineMatch(true);
            setSeatCount(1);
            setSeatChar({});
            setView('solo');
          }}
          onCouch={() => {
            audioService.unlock();
            setOfflineMatch(true);
            setSeatCount(2);
            setSeatChar({});
            setView('couch');
          }}
          onSettings={() => setShowSettings(true)}
          aiLevel={aiLevel}
          onAiLevel={setAiLevel}
        />
      )}

      {view === 'offline_menu' && (
        <Menu
          coins={coins}
          onSolo={() => {
            audioService.unlock();
            setOfflineMatch(true);
            setSeatCount(1);
            setSeatChar({});
            setView('solo');
          }}
          onCouch={() => {
            audioService.unlock();
            setOfflineMatch(true);
            setSeatCount(2);
            setSeatChar({});
            setView('couch');
          }}
          onSettings={() => setShowSettings(true)}
          aiLevel={aiLevel}
          onAiLevel={setAiLevel}
          onBack={online ? () => setView('room') : undefined}
        />
      )}

      {(view === 'solo' || view === 'couch') && (
        <OfflinePick
          seatCount={seatCount}
          owned={owned}
          coins={coins}
          onBack={() => setView(online ? 'offline_menu' : 'menu')}
          onBuy={buy}
          onDone={(picks) => {
            setSeatChar(picks);
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
          mine={myCharacter}
          owned={owned}
          coins={coins}
          isHost={isHost}
          onPick={pickOnline}
          onStart={startMatch}
          onSettings={() => setShowSettings(true)}
          onFullscreen={() => toggleFullscreen(document.documentElement, !document.fullscreenElement)}
          onPlayOffline={() => { audioService.unlock(); setView('offline_menu'); }}
        />
      )}

      {showSettings && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

/** The bot picks something other than what the player picked. */
function pickBotCharacter(playerChoice: number) {
  const options = FREE_CHARACTERS.filter((i) => i !== playerChoice);
  return options[Math.floor(Math.random() * options.length)] ?? 0;
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Menu({
  coins,
  onSolo,
  onCouch,
  onSettings,
  aiLevel,
  onAiLevel,
  onBack,
}: {
  coins: number;
  onSolo: () => void;
  onCouch: () => void;
  onSettings: () => void;
  aiLevel: number;
  onAiLevel: (n: number) => void;
  onBack?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-7 overflow-y-auto p-6">
      {onBack && (
        <div className="absolute left-4 top-4">
          <button onClick={onBack} className="panel rounded-2xl p-3">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>
      )}
      <div className="text-center">
        <div className="mb-4 inline-block rounded-3xl bg-amber-400/20 p-4">
          <Volleyball className="h-14 w-14 text-amber-300" />
        </div>
        <h1 className="text-6xl font-black tracking-tighter drop-shadow-lg sm:text-7xl">
          VOLLEY<span className="text-amber-300">CLASH</span>
        </h1>
        <p className="mt-2 text-xs font-bold uppercase tracking-[0.3em] text-white/70">Two touches, one winner</p>
      </div>

      <div className="panel w-full max-w-md space-y-5 rounded-[2rem] p-7">
        <button
          onClick={onSolo}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 py-4 text-lg font-black text-slate-900 transition-transform active:scale-95"
        >
          <Play className="h-5 w-5 fill-current" /> Solo — you vs the bot
        </button>

        <div className="space-y-2">
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-white/50">Bot difficulty</p>
          <div className="flex gap-1 rounded-xl bg-black/30 p-1">
            {TIERS.map((tier, i) => (
              <button
                key={tier.label}
                onClick={() => onAiLevel(i)}
                className={`flex-1 rounded-lg py-2 text-xs font-black uppercase tracking-wider transition-colors ${
                  aiLevel === i ? 'bg-amber-400 text-slate-900' : 'text-white/60'
                }`}
              >
                {tier.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={onCouch}
          className="w-full rounded-2xl border border-white/25 bg-white/10 py-4 font-black transition-colors hover:bg-white/20"
        >
          Offline 1v1 — two players, one PC
          <span className="mt-1 block text-[11px] font-bold normal-case tracking-normal text-white/50">
            Player 1 on A / D / W · Player 2 on the arrow keys
          </span>
        </button>

        <div className="rounded-2xl bg-black/25 p-3 text-center text-xs leading-relaxed text-white/50">
          <p className="mb-1 font-black uppercase tracking-[0.15em] text-white/40">Controls</p>
          <p>Move left and right, jump. That is it — where the ball hits you decides where it goes.</p>
          <p className="mt-1">Touchscreen: drag the left half to move, tap the right half to jump.</p>
          <p className="mt-2 text-white/40">
            Playing online? Start a lobby on PlayBuddies and pick this game. Two players face off; three or four
            play 2v2 on a wider court.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="panel flex items-center gap-2 rounded-2xl px-4 py-3 font-bold text-amber-300">
          <Coins className="h-5 w-5" /> {coins}
        </div>
        <button onClick={onSettings} className="panel rounded-2xl p-3">
          <SettingsIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

/** A character card, drawn with the same code the match uses. */
function Portrait({ index, size = 68 }: { index: number; size?: number }) {
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
      drawCharacter(ctx, CHARACTERS[index], size / 2, size * 0.62, size * 0.34, 1, 'rgba(255,255,255,0.28)');
    },
    [index, size],
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
  takenBy,
  onPick,
}: {
  owned: number[];
  coins: number;
  selected: number | null;
  takenBy: Record<number, string>;
  onPick: (index: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {CHARACTERS.map((ch: Character, index) => {
        const isOwned = owned.includes(index);
        const taken = takenBy[index];
        const isSelected = selected === index;
        const affordable = coins >= ch.price;

        return (
          <button
            key={ch.name}
            onClick={() => onPick(index)}
            disabled={Boolean(taken) || (!isOwned && !affordable)}
            className={`relative flex flex-col items-center gap-2 overflow-hidden rounded-2xl border p-3 text-left transition-colors ${
              taken
                ? 'cursor-not-allowed border-rose-400/40 opacity-40'
                : isSelected
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
            <Portrait index={index} />
            <span className="text-sm font-black uppercase tracking-wide">{ch.name}</span>
            <div className="w-full">
              <SkinNote />
            </div>
            <span className="text-[10px] leading-tight text-white/50">{ch.blurb}</span>
            {taken && <span className="text-[9px] font-black uppercase text-rose-300">{taken}</span>}
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
      {/* Reachable while embedded via "Play Offline / Couch", so the whole row
          clears the host's floating bar rather than just the coin badge — the
          three sit on one baseline and staggering them reads as broken. */}
      <div className={`flex shrink-0 items-center justify-between gap-2 ${IN_IFRAME ? 'mt-14' : ''}`}>
        <button onClick={onBack} className="panel shrink-0 rounded-2xl p-3">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="min-w-0 truncate text-center text-base font-black tracking-tight sm:text-2xl">{title}</h2>
        <div className="panel flex shrink-0 items-center gap-2 rounded-2xl px-3 py-2 font-bold text-amber-300">
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
  onDone: (picks: Record<string, number>) => void;
}) {
  const [picks, setPicks] = useState<Record<string, number>>({});
  const seat = Object.keys(picks).length;

  const takenBy = useMemo(() => {
    const map: Record<number, string> = {};
    Object.entries(picks).forEach(([id, index]) => {
      map[index] = `P${Number(id.split('-')[1]) + 1}`;
    });
    return map;
  }, [picks]);

  const pick = (index: number) => {
    if (!owned.includes(index) && !onBuy(index)) return;
    const next = { ...picks, [`seat-${seat}`]: index };
    setPicks(next);
    if (Object.keys(next).length >= seatCount) onDone(next);
  };

  const title = seatCount > 1 ? `Player ${seat + 1} — pick a character` : 'Pick your character';
  return (
    <Shell title={title} coins={coins} onBack={onBack}>
      <CharacterGrid owned={owned} coins={coins} selected={null} takenBy={takenBy} onPick={pick} />
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
  onPick,
  onStart,
  onSettings,
  onFullscreen,
  onPlayOffline,
}: {
  ready: boolean;
  error: string | null;
  uid: string | null;
  people: Person[];
  hostId: string | null;
  mine: number | null | undefined;
  owned: number[];
  coins: number;
  isHost: boolean;
  onPick: (index: number) => void;
  onStart: () => void;
  onSettings: () => void;
  onFullscreen: () => void;
  onPlayOffline: () => void;
}) {
  const takenBy = useMemo(() => {
    const map: Record<number, string> = {};
    for (const p of people) {
      if (p.uid !== uid && p.character !== undefined && p.character !== null) map[p.character] = p.displayName;
    }
    return map;
  }, [people, uid]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-2xl font-black">{error}</h2>
        <p className="text-sm text-white/60">Head back to the PlayBuddies lobby and try again.</p>
      </div>
    );
  }

  if (!ready || !uid) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-amber-300" />
        <p className="font-bold text-white/80">Walking onto the court…</p>
      </div>
    );
  }

  const iAmReady = mine !== undefined && mine !== null;
  const everyone = people.every((p) => p.character !== undefined && p.character !== null);
  const format = people.length > 2 ? '2v2 on the wide court' : '1v1';

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-3 p-3 sm:gap-4 sm:p-6">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-black tracking-tight sm:text-2xl">Pick your character</h2>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-300/80">{format}</p>
        </div>
        {/*
          Embedded, PlayBuddies floats its own Invite / Full screen / End Game
          bar over this same corner at a z-index we cannot reach from inside the
          frame, so this row has to start below it. Full screen is not repeated
          here for the same reason it was dropped from the match HUD: the host
          already provides one, and two in one corner is the overlap.
        */}
        <div className={`flex shrink-0 items-center gap-2 ${IN_IFRAME ? 'mt-14' : ''}`}>
          <div className="panel flex items-center gap-2 rounded-2xl px-3 py-2 font-bold text-amber-300">
            <Coins className="h-4 w-4" /> {coins}
          </div>
          {!IN_IFRAME && (
            <button onClick={onFullscreen} className="panel rounded-2xl p-2.5" title="Full screen">
              <Maximize2 className="h-5 w-5" />
            </button>
          )}
          <button onClick={onSettings} className="panel rounded-2xl p-2.5">
            <SettingsIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* On a phone the start button would otherwise sit below the fold, which
          is exactly what made it unreachable in the other game. */}
      <div className="panel shrink-0 rounded-2xl p-3 lg:hidden">
        {isHost ? (
          <button
            onClick={onStart}
            disabled={!iAmReady}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 py-3 text-base font-black text-slate-900 disabled:opacity-40"
          >
            <Play className="h-5 w-5 fill-current" /> START MATCH
          </button>
        ) : (
          <p className="text-center text-sm font-bold text-white/60">
            {iAmReady ? 'Waiting for the host…' : 'Pick a character to be ready.'}
          </p>
        )}
        <button
          onClick={onPlayOffline}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 py-2.5 text-sm font-black text-white/70 transition-colors hover:bg-white/15"
        >
          Play Offline / Couch
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-3 sm:gap-4 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
        <div className="panel order-2 min-h-0 overflow-y-auto overscroll-contain rounded-[2rem] p-3 sm:p-6 lg:order-1 lg:col-span-2">
          <CharacterGrid owned={owned} coins={coins} selected={mine ?? null} takenBy={takenBy} onPick={onPick} />
        </div>

        <div className="order-1 flex min-h-0 flex-col gap-3 sm:gap-4 lg:order-2">
          <div className="panel flex max-h-48 min-h-0 flex-col rounded-[2rem] p-4 sm:p-5 lg:max-h-none lg:flex-1">
            <h3 className="mb-3 flex shrink-0 items-center gap-2 text-[11px] font-black uppercase tracking-[0.2em] text-white/50">
              <Users className="h-4 w-4" /> On court ({people.length})
            </h3>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1">
              {people.map((p) => (
                <div
                  key={p.uid}
                  className="flex items-center gap-3 rounded-2xl border p-2.5"
                  style={{
                    borderColor: `${TEAM_COLORS[p.team ?? 0].main}55`,
                    background: `${TEAM_COLORS[p.team ?? 0].main}18`,
                  }}
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black/25">
                    {p.character !== undefined && p.character !== null ? (
                      <Portrait index={p.character} size={40} />
                    ) : (
                      <Volleyball className="h-5 w-5 text-white/40" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1 truncate text-sm font-bold">
                      {p.displayName}
                      {p.uid === hostId && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
                    </p>
                    <p
                      className="text-[10px] font-black uppercase tracking-widest"
                      style={{ color: TEAM_COLORS[p.team ?? 0].light }}
                    >
                      {TEAM_COLORS[p.team ?? 0].name}
                      {p.uid === uid ? ' · you' : ''}
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
                  disabled={!iAmReady}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 py-4 text-lg font-black text-slate-900 disabled:opacity-40"
                >
                  <Play className="h-5 w-5 fill-current" /> START MATCH
                </button>
                <p className="mt-2 text-center text-[11px] text-white/50">
                  {!iAmReady
                    ? 'Pick your own character first.'
                    : everyone
                      ? 'Everyone is ready.'
                      : 'Some players are still choosing.'}
                </p>
              </>
            ) : (
              <p className="text-center text-sm font-bold text-white/60">
                {!iAmReady ? 'Pick a character to be ready.' : 'Waiting for the host…'}
              </p>
            )}
            <button
              onClick={onPlayOffline}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-white/20 bg-white/5 py-3 font-black text-white/60 transition-colors hover:bg-white/15"
            >
              Play Offline / Couch
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-6 overflow-y-auto overscroll-contain rounded-[2rem] p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-black">Settings</h3>
          <button onClick={onClose} className="rounded-xl p-2 hover:bg-white/10">
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

        <div className="space-y-2">
          <span className="text-sm font-bold">First to</span>
          <div className="flex gap-1 rounded-xl bg-black/30 p-1">
            {[5, 7, 11].map((n) => (
              <button
                key={n}
                onClick={() => onChange({ ...settings, targetPoints: n })}
                className={`flex-1 rounded-lg py-2 text-xs font-black transition-colors ${
                  settings.targetPoints === n ? 'bg-amber-400 text-slate-900' : 'text-white/60'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-white/50">
            {settings.winByTwo
              ? `Reach ${settings.targetPoints} with a two-point lead. Online, the host's choice is the one that counts.`
              : `First to ${settings.targetPoints} takes it. Online, the host's choice is the one that counts.`}
          </p>
        </div>

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

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold">
            Win by two
            <span className="block text-[11px] font-normal text-white/50">
              {settings.targetPoints}-{settings.targetPoints - 1} keeps playing until someone is two clear
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.winByTwo}
            onChange={(e) => onChange({ ...settings, winByTwo: e.target.checked })}
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
        </div>

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold">
            Power-ups
            <span className="block text-[11px] font-normal text-white/50">
              Rocket, Feather, Giant and Freeze drop into rallies
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.powerUps}
            onChange={(e) => onChange({ ...settings, powerUps: e.target.checked })}
            className="h-6 w-6 shrink-0 accent-amber-400"
          />
        </label>

        {/* Only meaningful while power-ups are on, so it hides with them. */}
        {settings.powerUps && (
          <div className="space-y-1">
            <div className="flex justify-between text-sm font-bold">
              <span>How often</span>
              <span>{powerRateLabel(settings.powerRate)}</span>
            </div>
            <input
              type="range"
              min="0.25"
              max="3"
              step="0.25"
              value={settings.powerRate}
              onChange={(e) => onChange({ ...settings, powerRate: parseFloat(e.target.value) })}
              className="w-full accent-amber-400"
            />
            <p className="text-[11px] text-white/50">
              About one drop every {powerGapLabel(settings.powerRate)}. Takes effect straight away, even
              mid-match.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Plain words for the slider, so it doesn't read as a bare multiplier. */
function powerRateLabel(rate: number): string {
  if (rate <= 0.4) return 'Rare';
  if (rate <= 0.8) return 'Occasional';
  if (rate <= 1.3) return 'Normal';
  if (rate <= 2.2) return 'Frequent';
  return 'Chaos';
}

/** The interval the engine will actually use, in whole seconds. */
function powerGapLabel(rate: number): string {
  const mid = (BALANCE.POWER_EVERY_MIN + BALANCE.POWER_EVERY_MAX) / 2 / Math.max(0.05, rate);
  return `${Math.round(mid)}s`;
}
