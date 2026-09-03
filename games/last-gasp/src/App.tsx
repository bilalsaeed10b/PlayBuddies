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
import { askHostToEndGame, toggleFullscreen } from './fullscreen';
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
import type { GameSettings, MatchRules, Mode, PlayerCount } from './types/game';

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

type View = 'menu' | 'pick' | 'room' | 'game' | 'offline_menu';

interface LobbyPerson {
  uid: string;
  displayName: string;
  /** The lobby's per-player slot. Fish Eat Fish named it and every game since reuses it. */
  fishIndex?: number | null;
}

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;

/**
 * Below this many real people, an online race has nobody to race against.
 * There are no bots to make up the difference anymore — see `onlineConfig`.
 */
const MIN_ONLINE_PLAYERS = 2;

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
    matchRules?: number;
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
  // changes, on a fresh even split — a host's individual taps on a roster
  // chip (see RoomScreen) override single entries after that, but a length
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
   * addressed by. Capped at the hard table max, never at `rules.players` — an
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

  // The host keeps `rules.players` in lockstep with who is actually in the
  // room. Nothing online reads it as a target to fill anymore, but Teams'
  // default split and the wire-packed rules still need a real number, and it
  // has to be one every client agrees on without anybody having picked it.
  useEffect(() => {
    if (!online || !isHost) return;
    const n = Math.max(MIN_ONLINE_PLAYERS, Math.min(PLAYER_COUNTS[PLAYER_COUNTS.length - 1], people.length || MIN_ONLINE_PLAYERS));
    if (n !== rules.players) setRules((r) => ({ ...r, players: n as PlayerCount }));
  }, [online, isHost, people.length, rules.players]);

  useEffect(() => {
    if (!online || offlineMatch) return;
    if (lobby?.matchStarted && mySkin !== undefined && mySkin !== null) setView('game');
    else if (view === 'game') setView('room');
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
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      // The rules ride along in the same write as the go-signal, so they land
      // in every guest's snapshot at the same instant `matchStarted` does.
      await updateDoc(doc(db, 'lobbies', handoff.room), {
        matchStarted: true,
        matchRules: packRules(rules),
      });
    } catch (e) {
      log.error('match:start-failed', { message: String((e as Error)?.message ?? e) });
    }
  }, [isHost, handoff.room, rules]);

  const award = useCallback((won: boolean, points: number) => {
    setCoins((c) => c + (won ? 90 : 25) + Math.round(points / 3));
    reportResult(won);
  }, []);

  const leaveMatch = useCallback(() => {
    setOfflineMatch(false);
    setView(online ? 'room' : 'menu');
    rollSession();
    if (!online || !isHost) return;
    void import('./firebase')
      .then(({ db, doc, updateDoc }) =>
        updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: false }),
      )
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

  function onlineConfig(): MatchConfig {
    const crew = handoff.solo ? people.filter((p) => p.uid === uid) : people;
    const seats: Seat[] = [];
    const localSeats: number[] = [];

    // Exactly the real people in the room, in the same fixed order — no
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
      seed: session.seed,
      rules,
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
      // teams in, and there is no lobby here — carrying over whatever mode
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
    // whatever the rules panel is set to.
    if (players > rules.players) setRules((r) => ({ ...r, players: players as PlayerCount }));
    setView('pick');
  };

  return (
    <div className="h-[100dvh] w-full overflow-hidden">
      {(view === 'menu' || view === 'offline_menu') && (
        <Menu
          coins={coins}
          aiLevel={aiLevel}
          onAiLevel={setAiLevel}
          onSolo={() => openOffline(1)}
          onCouch={() => openOffline(2)}
          onSettings={() => setShowSettings(true)}
          onRules={() => setShowRules(true)}
          rules={rules}
          onBack={view === 'offline_menu' ? () => setView('room') : undefined}
        />
      )}

      {view === 'pick' && (
        <FacePick
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
          onRulesChange={setRules}
        />
      )}

      {showSettings && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
      )}
      {showRules && (
        <RulesPanel
          rules={rules}
          editable={!online || isHost}
          // The "Players" picker only means anything for an offline bot
          // table — see `offlineConfig`. Reached from the online room itself
          // (view === 'room'), the headcount is real people and is not a
          // knob to turn; reached from the offline menu or a couch match,
          // it is still the one thing choosing how many bots fill the table.
          showPlayerCount={!(online && view === 'room')}
          onChange={setRules}
          onClose={() => setShowRules(false)}
        />
      )}
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

// -- pieces -------------------------------------------------------------------

function Menu({
  coins,
  aiLevel,
  onAiLevel,
  onSolo,
  onCouch,
  onSettings,
  onRules,
  rules,
  onBack,
}: {
  coins: number;
  aiLevel: number;
  onAiLevel: (n: number) => void;
  onSolo: () => void;
  onCouch: () => void;
  onSettings: () => void;
  onRules: () => void;
  rules: MatchRules;
  onBack?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 overflow-y-auto overscroll-contain p-5">
      {onBack && (
        <div className="absolute left-4 top-4">
          <button onClick={onBack} aria-label="Back" className="panel rounded-2xl p-3">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>
      )}

      <div className="flex items-center gap-4">
        <Gallows pieces={PIECES} className="h-24 w-auto opacity-80" />
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-500">One line left</p>
          <h1 className="text-5xl font-black leading-none tracking-tighter text-slate-50 sm:text-6xl">
            HANG
            <br />
            MAN
          </h1>
          <p className="mt-1 text-xs font-black uppercase tracking-[0.24em] text-lime-400">
            Don't draw it
          </p>
        </div>
      </div>

      <div className="panel w-full max-w-md space-y-4 rounded-[2rem] p-5">
        <button
          onClick={onSolo}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-lime-500 py-4 text-lg font-black uppercase tracking-wider text-slate-950 transition-transform active:scale-95"
        >
          <Play className="h-5 w-5 fill-current" /> Play solo
        </button>

        <div className="space-y-1.5">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Bot rank</p>
          <div className="flex gap-1 rounded-xl bg-slate-800/70 p-1">
            {TIERS.map((tier, i) => (
              <button
                key={tier.label}
                onClick={() => onAiLevel(i)}
                className={`flex-1 rounded-lg py-2 text-[11px] font-black uppercase tracking-wide transition-colors ${
                  aiLevel === i ? 'bg-slate-100 text-slate-900' : 'text-slate-400'
                }`}
              >
                {tier.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={onCouch}
          className="w-full rounded-2xl border-2 border-slate-600/60 bg-slate-800/50 py-3 font-black uppercase tracking-wide text-slate-100"
        >
          Two on one screen
          <span className="mt-0.5 block text-[10px] font-bold normal-case tracking-normal text-slate-400">
            Pass it over to set a word, then race for the letters together.
          </span>
        </button>

        <button
          onClick={onRules}
          className="relative flex w-full items-center gap-3 overflow-hidden rounded-2xl border-2 border-lime-400/70 bg-lime-400/10 px-4 py-3 text-left transition-transform active:scale-[0.99]"
        >
          <span className="absolute -right-6 -top-6 h-16 w-16 animate-pulse rounded-full bg-lime-400/20" aria-hidden />
          <ScrollText className="h-6 w-6 shrink-0 text-lime-300" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black uppercase tracking-wide text-lime-200">
              First time? Read this
            </p>
            <p className="text-[11px] font-bold text-lime-300/70">It is not the hangman you know.</p>
          </div>
        </button>
      </div>

      <div className="flex items-center gap-2">
        <div className="panel flex items-center gap-2 rounded-2xl px-4 py-2.5 font-bold text-amber-300">
          <Coins className="h-4 w-4" /> {coins}
        </div>
        <button onClick={onSettings} aria-label="Settings" className="panel rounded-2xl p-3">
          <SettingsIcon className="h-5 w-5" />
        </button>
      </div>
      <p className="-mt-2 text-center text-[10px] font-bold text-slate-500">{rulesSummary(rules)}</p>
    </div>
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

function FacePick({
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

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-2 p-2.5 sm:gap-4 sm:p-5">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <button onClick={onBack} aria-label="Back" className="panel shrink-0 rounded-2xl p-3">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="min-w-0 truncate text-center text-base font-black uppercase tracking-wide text-slate-100 sm:text-2xl">
          {seatCount > 1 ? `Player ${seat + 1} — pick a face` : 'Pick a face'}
        </h2>
        <div className="panel flex shrink-0 items-center gap-2 rounded-2xl px-3 py-2 font-bold text-amber-300">
          <Coins className="h-4 w-4" /> {coins}
        </div>
      </div>
      <div className="panel min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-[2rem] p-3 sm:p-5">
        <FaceGrid owned={owned} coins={coins} selected={null} pickedBy={pickedBy} onPick={pick} />
      </div>
    </div>
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
  onRulesChange,
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
  /** Match type and team assignment live here, in the lobby itself — not behind the Rules modal. See ModeAndTeams. */
  onRulesChange: (r: MatchRules) => void;
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
        <h2 className="text-2xl font-black text-slate-100">{error}</h2>
        <p className="text-sm text-slate-400">Head back to the PlayBuddies lobby and try again.</p>
      </div>
    );
  }

  if (!ready || !uid) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-lime-400" />
        <p className="font-bold text-slate-400">Chalking up…</p>
      </div>
    );
  }

  const iAmReady = mine !== undefined && mine !== null;
  const everyonePicked = people.every((p) => p.skin !== undefined && p.skin !== null);
  const enoughPlayers = people.length >= 2;
  const canStart = iAmReady && everyonePicked && enoughPlayers;

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-2 p-2.5 sm:gap-4 sm:p-5">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-black uppercase tracking-wide text-slate-100 sm:text-2xl">
            Pick a face
          </h2>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-lime-400/80">
            {people.length} player{people.length === 1 ? '' : 's'} in the room — no bots online
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="panel flex items-center gap-2 rounded-2xl px-3 py-2 font-bold text-amber-300">
            <Coins className="h-4 w-4" /> {coins}
          </div>
          <button onClick={onFullscreen} className="panel rounded-2xl p-2.5" title="Full screen">
            <Maximize2 className="h-5 w-5" />
          </button>
          <button onClick={onSettings} aria-label="Settings" className="panel rounded-2xl p-2.5">
            <SettingsIcon className="h-5 w-5" />
          </button>
          {isHost && (
            <button onClick={askHostToEndGame} aria-label="End game" className="panel rounded-2xl p-2.5">
              <LogOut className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      {/* Loud on purpose — this is not the hangman anybody already knows, and
          the small Rules button below is easy to never notice at all. */}
      <button
        onClick={onRules}
        className="relative flex shrink-0 items-center gap-3 overflow-hidden rounded-2xl border-2 border-lime-400/70 bg-lime-400/10 px-4 py-3 text-left transition-transform active:scale-[0.99]"
      >
        <span className="absolute -right-6 -top-6 h-16 w-16 animate-pulse rounded-full bg-lime-400/20" aria-hidden />
        <ScrollText className="h-6 w-6 shrink-0 text-lime-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black uppercase tracking-wide text-lime-200">New here? Read the rules</p>
          <p className="text-[11px] font-bold text-lime-300/70">The twist is worth 30 seconds.</p>
        </div>
        <span className="shrink-0 rounded-xl bg-lime-500 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-slate-950">
          Guide
        </span>
      </button>

      <ModeAndTeams rules={rules} people={people} hostId={hostId} editable={isHost} onChange={onRulesChange} />

      <div className="panel shrink-0 rounded-2xl p-2.5">
        {isHost ? (
          <>
            <button
              onClick={onStart}
              disabled={!canStart}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-lime-500 py-2.5 text-sm font-black uppercase tracking-[0.18em] text-slate-950 disabled:opacity-40"
            >
              <Play className="h-4 w-4 fill-current" /> Start
            </button>
            {!enoughPlayers && (
              <p className="mt-1.5 text-center text-[10px] font-bold text-amber-400/90">
                Need at least one more player — invite a friend, or play offline against bots below.
              </p>
            )}
          </>
        ) : (
          <p className="py-1 text-center text-xs font-bold text-slate-400">
            {!iAmReady
              ? 'Pick a face to be ready.'
              : !enoughPlayers
                ? 'Waiting for one more player…'
                : !everyonePicked
                  ? 'Waiting for everyone…'
                  : 'Waiting for the host…'}
          </p>
        )}
        <button
          onClick={onPlayOffline}
          className="mt-2 w-full rounded-lg border-2 border-slate-600/50 bg-slate-800/50 py-2 text-xs font-black uppercase text-slate-300"
        >
          Play offline
        </button>
        <p className="mt-1.5 text-center text-[10px] font-bold text-slate-500">{rulesSummary(rules)}</p>
      </div>

      <div className="panel shrink-0 rounded-2xl p-2">
        <h3 className="mb-1 flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">
          <Users className="h-3 w-3" /> At the board ({people.length})
        </h3>
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          {people.map((p, i) => (
            <div
              key={p.uid}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border-2 px-2 py-1"
              style={{
                borderColor: `${SEAT_COLORS[i % SEAT_COLORS.length].main}55`,
                background: `${SEAT_COLORS[i % SEAT_COLORS.length].main}14`,
              }}
            >
              {p.skin !== undefined && p.skin !== null ? (
                <FaceToken skin={p.skin} size={28} ring={SEAT_COLORS[i % SEAT_COLORS.length].main} />
              ) : (
                <div className="h-7 w-7 rounded-full bg-slate-700/60" />
              )}
              <div className="min-w-0 max-w-[80px]">
                <p className="flex items-center gap-1 truncate text-[10px] font-black text-slate-100">
                  {p.displayName}
                  {p.uid === hostId && <Crown className="h-2.5 w-2.5 shrink-0 text-amber-400" />}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-[2rem] p-3 sm:p-5">
        <FaceGrid owned={owned} coins={coins} selected={mine ?? null} pickedBy={pickedBy} onPick={onPick} />
      </div>
    </div>
  );
}

/**
 * Who is setting a word for whom, decided right here in the lobby.
 *
 * Not in the Rules modal: a modal is for toggles that change what a match
 * *is* in the abstract (how many words, how fast a chain window closes), but
 * "which of these specific people are on my team" is a decision about the
 * actual roster in front of you, and it belongs where the roster already is.
 */
function ModeAndTeams({
  rules,
  people,
  hostId,
  editable,
  onChange,
}: {
  rules: MatchRules;
  people: { uid: string; displayName: string }[];
  hostId: string | null;
  editable: boolean;
  onChange: (r: MatchRules) => void;
}) {
  const teamOf = (seat: number) => rules.teamOf[seat] ?? seat % rules.teamCount;
  const cycleTeam = (seat: number) => {
    if (!editable) return;
    const next = [...rules.teamOf];
    while (next.length <= seat) next.push(next.length % rules.teamCount);
    next[seat] = (teamOf(seat) + 1) % rules.teamCount;
    onChange({ ...rules, teamOf: next });
  };

  // The real roster, not `rules.players` — there is no bot fill to pad up to
  // anymore, so a team chip only ever exists for someone actually in the room.
  const slots = people.length;

  return (
    <div className="panel shrink-0 space-y-2.5 rounded-2xl p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Match type</p>
        <div className="flex gap-1 rounded-lg bg-slate-800/70 p-1">
          {(['ffa', 'teams'] as Mode[]).map((m) => (
            <button
              key={m}
              disabled={!editable}
              onClick={() => onChange({ ...rules, mode: m, teamOf: m === 'teams' ? defaultTeams(rules.players, rules.teamCount) : rules.teamOf })}
              className={`rounded-md px-2.5 py-1 text-[10px] font-black uppercase tracking-wide disabled:opacity-60 ${
                rules.mode === m ? 'bg-slate-100 text-slate-900' : 'text-slate-400'
              }`}
            >
              {m === 'ffa' ? 'Free-For-All' : 'Teams'}
            </button>
          ))}
        </div>
      </div>

      {rules.mode === 'ffa' ? (
        <p className="text-[10px] leading-snug text-slate-500">
          One person sets a word each round. Everybody else races to crack it — anyone can call any letter, any time.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-bold text-slate-500">Teams</p>
            <div className="flex items-center gap-1">
              {Array.from({ length: MAX_TEAMS - MIN_TEAMS + 1 }, (_, i) => MIN_TEAMS + i).map((n) => (
                <button
                  key={n}
                  disabled={!editable}
                  onClick={() => onChange({ ...rules, teamCount: n, teamOf: defaultTeams(rules.players, n) })}
                  className={`h-6 w-6 rounded-md text-[10px] font-black disabled:opacity-60 ${
                    rules.teamCount === n ? 'bg-slate-100 text-slate-900' : 'bg-slate-800/70 text-slate-400'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: slots }, (_, seat) => {
              const person = people[seat];
              const color = TEAM_COLORS[teamOf(seat) % TEAM_COLORS.length];
              return (
                <button
                  key={seat}
                  disabled={!editable}
                  onClick={() => cycleTeam(seat)}
                  className="flex items-center gap-1.5 rounded-lg border-2 px-2 py-1 disabled:opacity-90"
                  style={{ borderColor: `${color.main}70`, background: `${color.main}18` }}
                  title={editable ? 'Tap to change team' : undefined}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color.main }} />
                  <span className="flex max-w-[80px] items-center gap-1 truncate text-[10px] font-black text-slate-100">
                    <span className="truncate">{person.displayName}</span>
                    {person.uid === hostId && <Crown className="h-2.5 w-2.5 shrink-0 text-amber-400" />}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[10px] leading-snug text-slate-500">
            Your team suggests words and votes on one; the other teams race to crack it together.
          </p>
        </>
      )}
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
              Colour the keys that have already been called — green for a hit, red for a miss.
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
    { n: 2, title: 'It is open to everyone', body: 'No turns. Anyone can call any letter, any moment — fastest right guess wins it.' },
    { n: 3, title: 'A hit buys you a window', body: `Get one right and you alone get ${BALANCE.CHAIN_WINDOW_MS / 1000}s to keep going. Chain hits pay more each time.` },
    { n: 4, title: 'A miss draws the gallows', body: `${PIECES} wrong guesses and he's finished — whoever drew the last line loses the word's points.` },
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
 * The rules of the match, set by the host and obeyed by everyone.
 *
 * Separate from Settings on purpose: these change what the game *is*, so both
 * sides have to be playing the same one. They travel to a guest over the wire
 * (see `packRules`), and a guest can read this panel but not touch it —
 * letting them change a copy that the host's next write overwrites would be a
 * lie about who is in charge.
 */
function RulesPanel({
  rules,
  editable,
  showPlayerCount,
  onChange,
  onClose,
}: {
  rules: MatchRules;
  editable: boolean;
  showPlayerCount: boolean;
  onChange: (r: MatchRules) => void;
  onClose: () => void;
}) {
  const sample = ['E', 'A', 'D', 'B', 'K', 'Z'];
  // Escape closes it too. See @shared/ui/dismiss.
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-5 overflow-y-auto rounded-[2rem] p-6">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-xl font-black uppercase tracking-wide text-slate-100">How to play</h3>
            <p className="text-[11px] font-semibold text-slate-400">
              {editable ? 'Applies to everyone. Takes effect next match.' : 'Set by the host.'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-slate-700/50">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <HowItWorks />
        <StageStrip />

        <div className="space-y-1.5 rounded-2xl border border-slate-600/40 bg-slate-800/40 p-3">
          <p className="text-[11px] font-black uppercase tracking-wide text-slate-200">
            Rare letters pay more
          </p>
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
            Per copy found, before any chain bonus. A safe E is worth one; a Z that lands is worth ten —
            the bet you're making every time you go for a letter instead of waiting for a safer one.
          </p>
        </div>

        {showPlayerCount && (
          <div className="space-y-1.5">
            <p className="text-sm font-bold text-slate-100">
              Players
              <span className="block text-[11px] font-normal text-slate-400">
                Seats past who's actually on the couch are filled with bots.
              </span>
            </p>
            <div className="grid grid-cols-7 gap-1">
              {PLAYER_COUNTS.map((n) => (
                <button
                  key={n}
                  disabled={!editable}
                  onClick={() => onChange({ ...rules, players: n })}
                  className={`rounded-lg border-2 py-2 text-xs font-black disabled:opacity-50 ${
                    rules.players === n
                      ? 'border-lime-400 bg-lime-400/15 text-lime-200'
                      : 'border-slate-600/50 bg-slate-800/50 text-slate-400'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <p className="text-sm font-bold text-slate-100">
            Words in a match
            <span className="block text-[11px] font-normal text-slate-400">
              Highest total when they run out takes it.
            </span>
          </p>
          <div className="grid grid-cols-3 gap-2">
            {ROUND_CHOICES.map((amount, i) => (
              <button
                key={amount}
                disabled={!editable}
                onClick={() => onChange({ ...rules, rounds: i })}
                className={`rounded-xl border-2 py-2.5 text-xs font-black disabled:opacity-50 ${
                  rules.rounds === i
                    ? 'border-lime-400 bg-lime-400/15 text-lime-200'
                    : 'border-slate-600/50 bg-slate-800/50 text-slate-400'
                }`}
              >
                {amount}
              </button>
            ))}
          </div>
        </div>

        <p className="text-center text-[10px] font-bold text-slate-500">
          Match type and teams are set right in the lobby, not here — see the board below "Pick a face".
        </p>
      </div>
    </div>
  );
}
