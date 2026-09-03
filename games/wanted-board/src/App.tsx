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
import { FREE_OUTLAWS, OUTLAWS } from './game/outlaws';
import OutlawToken from './components/OutlawToken';
import { BALANCE, BANK, CARDS, CARD_GLYPH, CARD_ORDER, PLACES, ROADS, SEAT_COLORS } from './game/rules';
import { TIERS } from './engine/ai';
import { audioService } from './services/audio';
import { GameWallet, reportResult } from './platform/wallet';
import MatchView from './screens/MatchView';
import type { MatchConfig } from './screens/MatchView';
import type { Seat } from './engine/WantedEngine';
import { DEFAULT_RULES, TARGET_CHOICES, packRules, unpackRules } from './types/game';
import { createLogger } from '@shared/log/logger';
import type { GameSettings, MatchRules, PlayerCount } from './types/game';

const log = createLogger('wanted-board');

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

const DEFAULT_SETTINGS: GameSettings = { sfxVolume: 0.7, hints: true };

type View = 'menu' | 'pick' | 'room' | 'game' | 'offline_menu';

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
 * The tier picker in the menu is only ever reached offline, so it really means
 * "how hard should the practice bot be". Letting that leak into online rooms
 * is how a player who once tried Marshal ends up playing friends alongside
 * merciless fill-in bots.
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
    matchRules?: number;
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
          // listens to. Without this a guest seats the table by its own idea of
          // the player count and builds a different town — compared against
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
   * addressed by.
   */
  const people = useMemo(() => {
    return Object.values(lobby?.players ?? {})
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .slice(0, rules.players)
      .map((p) => ({ uid: p.uid, displayName: p.displayName || 'Player', skin: p.fishIndex }));
  }, [lobby, rules.players]);

  const mySkin = uid ? lobby?.players?.[uid]?.fishIndex : undefined;
  const isHost = Boolean(uid && lobby && lobby.hostId === uid);

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
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      // The rules ride along in the same write as the go-signal, so they land
      // in every guest's snapshot at the same instant `matchStarted` does.
      await updateDoc(doc(db, 'lobbies', handoff.room), {
        matchStarted: true,
        matchRules: packRules(rules),
      });
    } catch (e) {
      console.error('Could not start the game', e);
    }
  }, [isHost, handoff.room, rules]);

  const award = useCallback((won: boolean, banked: number) => {
    setCoins((c) => c + (won ? 95 : 30) + Math.round(banked / 25));
    reportResult(won);
  }, []);

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

    for (let i = 0; i < rules.players; i++) {
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
      seed: session.seed,
      rules,
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
    // rules panel is set to.
    if (players > rules.players) setRules((r) => ({ ...r, players: players as PlayerCount }));
    setView('pick');
  };

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden">
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
        <OutlawPick
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

      <div className="text-center">
        <p className="text-[10px] font-black uppercase tracking-[0.4em] text-amber-900/50">Reward offered for</p>
        <h1 className="text-5xl font-black leading-none tracking-tighter text-amber-950 sm:text-7xl">
          WANTED
        </h1>
        <p className="mt-1 text-xs font-black uppercase tracking-[0.3em] text-rose-800">Dead or in debt</p>
      </div>

      <div className="panel w-full max-w-md space-y-4 rounded-[2rem] p-5">
        <button
          onClick={onSolo}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-rose-800 py-4 text-lg font-black uppercase tracking-wider text-amber-50 transition-transform active:scale-95"
        >
          <Play className="h-5 w-5 fill-current" /> Ride alone
        </button>

        <div className="space-y-1.5">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-900/50">Bot rank</p>
          <div className="flex gap-1 rounded-xl bg-amber-900/10 p-1">
            {TIERS.map((tier, i) => (
              <button
                key={tier.label}
                onClick={() => onAiLevel(i)}
                className={`flex-1 rounded-lg py-2 text-[11px] font-black uppercase tracking-wide transition-colors ${
                  aiLevel === i ? 'bg-amber-950 text-amber-50' : 'text-amber-900/60'
                }`}
              >
                {tier.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={onCouch}
          className="w-full rounded-2xl border-2 border-amber-900/25 bg-[#f7ecd6] py-3 font-black uppercase tracking-wide text-amber-950"
        >
          Two on one device
          <span className="mt-0.5 block text-[10px] font-bold normal-case tracking-normal text-amber-900/50">
            You pass the phone. Nobody peeks.
          </span>
        </button>

        <div className="rounded-2xl bg-amber-900/5 p-3 text-center text-[11px] leading-relaxed text-amber-900/70">
          <p className="mb-1 font-black uppercase tracking-[0.15em] text-amber-900/50">How it works</p>
          <p>Everybody picks a card in secret. All of them flip at once.</p>
          <p className="mt-1">
            Your bounty climbs while you run — but it is only yours once you have banked it, and the Bank is the
            one place everyone knows you have to visit.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="panel flex items-center gap-2 rounded-2xl px-4 py-2.5 font-bold text-amber-800">
          <Coins className="h-4 w-4" /> {coins}
        </div>
        <button onClick={onRules} className="panel flex items-center gap-2 rounded-2xl px-4 py-2.5 font-bold text-amber-900/70">
          <ScrollText className="h-4 w-4" /> Rules
        </button>
        <button onClick={onSettings} aria-label="Settings" className="panel rounded-2xl p-3">
          <SettingsIcon className="h-5 w-5" />
        </button>
      </div>
      <p className="-mt-2 text-center text-[10px] font-bold text-amber-900/40">{rulesSummary(rules)}</p>
    </div>
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
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
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
            className={`relative flex flex-col items-center gap-1 overflow-hidden rounded-2xl border-2 p-2.5 text-center transition-colors ${
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
            <OutlawToken skin={index} size={62} />
            <span className="text-[11px] font-black uppercase tracking-wide text-amber-950">{outlaw.name}</span>
            <span className="text-[9px] leading-tight text-amber-900/50">{outlaw.blurb}</span>
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

function OutlawPick({
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
        <h2 className="min-w-0 truncate text-center text-base font-black uppercase tracking-wide text-amber-950 sm:text-2xl">
          {seatCount > 1 ? `Player ${seat + 1} — pick your face` : 'Pick your face'}
        </h2>
        <div className="panel flex shrink-0 items-center gap-2 rounded-2xl px-3 py-2 font-bold text-amber-800">
          <Coins className="h-4 w-4" /> {coins}
        </div>
      </div>
      <div className="panel min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-[2rem] p-3 sm:p-5">
        <OutlawGrid owned={owned} coins={coins} selected={null} pickedBy={pickedBy} onPick={pick} />
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
        <h2 className="text-2xl font-black text-amber-950">{error}</h2>
        <p className="text-sm text-amber-900/60">Head back to the PlayBuddies lobby and try again.</p>
      </div>
    );
  }

  if (!ready || !uid) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-rose-800" />
        <p className="font-bold text-amber-900/70">Riding into town…</p>
      </div>
    );
  }

  const iAmReady = mine !== undefined && mine !== null;
  const everyonePicked = people.every((p) => p.skin !== undefined && p.skin !== null);
  const canStart = iAmReady && everyonePicked;
  const emptySeats = Math.max(0, rules.players - people.length);

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-2 p-2.5 sm:gap-4 sm:p-5">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-black uppercase tracking-wide text-amber-950 sm:text-2xl">
            Pick your face
          </h2>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-rose-800/80">
            {rules.players} outlaws{emptySeats > 0 && ` · ${emptySeats} to bots`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="panel flex items-center gap-2 rounded-2xl px-3 py-2 font-bold text-amber-800">
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

      {/* Loud on purpose — this is the one moment before cards are hidden and
          money is on the line, and the small "Rules" button lower down is easy
          to never notice at all. */}
      <button
        onClick={onRules}
        className="relative flex shrink-0 items-center gap-3 overflow-hidden rounded-2xl border-2 border-rose-700 bg-rose-100 px-4 py-3 text-left shadow-[0_4px_16px_rgba(190,18,60,0.18)] transition-transform active:scale-[0.99]"
      >
        <span className="absolute -right-6 -top-6 h-16 w-16 animate-pulse rounded-full bg-rose-700/20" aria-hidden />
        <ScrollText className="h-6 w-6 shrink-0 text-rose-800" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black uppercase tracking-wide text-rose-900">New in town? Read the rules</p>
          <p className="text-[11px] font-bold text-rose-800/70">If you want to win, it's worth a minute.</p>
        </div>
        <span className="shrink-0 rounded-xl bg-rose-800 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-amber-50">
          Guide
        </span>
      </button>

      <div className="panel shrink-0 rounded-2xl p-2.5">
        {isHost ? (
          <button
            onClick={onStart}
            disabled={!canStart}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-rose-800 py-2.5 text-sm font-black uppercase tracking-[0.18em] text-amber-50 disabled:opacity-40"
          >
            <Play className="h-4 w-4 fill-current" /> Ride out
          </button>
        ) : (
          <p className="py-1 text-center text-xs font-bold text-amber-900/60">
            {!iAmReady ? 'Pick a face to be ready.' : !everyonePicked ? 'Waiting for everyone…' : 'Waiting for the host…'}
          </p>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            onClick={onRules}
            className="flex items-center justify-center gap-1.5 rounded-lg border-2 border-amber-900/20 bg-[#f7ecd6] py-2 text-xs font-black uppercase text-amber-900/70"
          >
            <ScrollText className="h-3.5 w-3.5" /> Rules
          </button>
          <button
            onClick={onPlayOffline}
            className="rounded-lg border-2 border-amber-900/20 bg-[#f7ecd6] py-2 text-xs font-black uppercase text-amber-900/70"
          >
            Play offline
          </button>
        </div>
        <p className="mt-1.5 text-center text-[10px] font-bold text-amber-900/40">{rulesSummary(rules)}</p>
      </div>

      <div className="panel shrink-0 rounded-2xl p-2">
        <h3 className="mb-1 flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.2em] text-amber-900/50">
          <Users className="h-3 w-3" /> In town ({people.length})
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
                <OutlawToken skin={p.skin} size={28} ring={SEAT_COLORS[i % SEAT_COLORS.length].main} />
              ) : (
                <div className="h-7 w-7 rounded-full bg-amber-900/15" />
              )}
              <div className="min-w-0 max-w-[80px]">
                <p className="flex items-center gap-1 truncate text-[10px] font-black text-amber-950">
                  {p.displayName}
                  {p.uid === hostId && <Crown className="h-2.5 w-2.5 shrink-0 text-amber-600" />}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-[2rem] p-3 sm:p-5">
        <OutlawGrid owned={owned} coins={coins} selected={mine ?? null} pickedBy={pickedBy} onPick={onPick} />
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

/** The board, drawn small and static — the same wheel TownMap draws, just for reading rather than playing. */
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
        Four spokes run straight to the Bank — fast, and everyone can see you take one. The rest of town is the
        rim: slower, and easier to disappear into.
      </p>
    </div>
  );
}

/**
 * The rules of the night, set by the host and obeyed by everyone.
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
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-amber-950/60 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-5 overflow-y-auto rounded-[2rem] p-6">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-xl font-black uppercase tracking-wide text-amber-950">The rules</h3>
            <p className="text-[11px] font-semibold text-amber-900/50">
              {editable ? 'Applies to everyone. Takes effect next game.' : 'Set by the host.'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-amber-900/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <HowItWorks />
        <MapDiagram />

        <div className="space-y-1.5">
          <p className="text-sm font-bold text-amber-950">Outlaws</p>
          <div className="grid grid-cols-5 gap-1.5">
            {([2, 3, 4, 5, 6] as PlayerCount[]).map((n) => (
              <button
                key={n}
                disabled={!editable}
                onClick={() => onChange({ ...rules, players: n })}
                className={`rounded-xl border-2 py-2.5 text-xs font-black disabled:opacity-50 ${
                  rules.players === n
                    ? 'border-rose-700 bg-rose-100 text-rose-900'
                    : 'border-amber-900/20 bg-[#f7ecd6] text-amber-900/60'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-bold text-amber-950">
            Banked to win
            <span className="block text-[11px] font-normal text-amber-900/50">
              Or the richest after {BALANCE.ROUNDS} rounds takes it.
            </span>
          </p>
          <div className="grid grid-cols-3 gap-2">
            {TARGET_CHOICES.map((amount, i) => (
              <button
                key={amount}
                disabled={!editable}
                onClick={() => onChange({ ...rules, target: i })}
                className={`rounded-xl border-2 py-2.5 text-xs font-black disabled:opacity-50 ${
                  rules.target === i
                    ? 'border-rose-700 bg-rose-100 text-rose-900'
                    : 'border-amber-900/20 bg-[#f7ecd6] text-amber-900/60'
                }`}
              >
                ${amount}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold text-amber-950">
            Round clock
            <span className="block text-[11px] font-normal text-amber-900/50">
              After {BALANCE.ROUND_SECONDS} seconds, anyone still deciding lays low.
            </span>
          </span>
          <input
            type="checkbox"
            disabled={!editable}
            checked={rules.roundTimer}
            onChange={(e) => onChange({ ...rules, roundTimer: e.target.checked })}
            className="h-6 w-6 shrink-0 accent-rose-800 disabled:opacity-50"
          />
        </label>

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
      </div>
    </div>
  );
}
