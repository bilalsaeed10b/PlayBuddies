import { useCallback, useEffect, useMemo, useState } from 'react';
import { scrimProps, useEscape } from '@shared/ui/dismiss';
import {
  ArrowLeft,
  Castle,
  Coins,
  Crown,
  Loader2,
  Maximize2,
  Play,
  ScrollText,
  Settings as SettingsIcon,
  Shield,
  Swords,
  Users,
} from 'lucide-react';
import { askHostToEndGame, toggleFullscreen } from './fullscreen';
import { GameWallet, reportResult } from './platform/wallet';
import { TIERS } from './engine/ai';
import { ENEMIES, SEATS, TOWERS, TOWER_ORDER, DEFAULT_RULES, packRules, unpackRules } from './game/rules';
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

type View = 'menu' | 'room' | 'game' | 'offline_menu';

interface LobbyPerson {
  uid: string;
  displayName: string;
}

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;

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
  const [offlineMatch, setOfflineMatch] = useState(false);
  const [aiLevel, setAiLevel] = useState(1);
  const [soloSeats, setSoloSeats] = useState(1);

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

  const [rules, setRules] = useState<MatchRules>(() => {
    const saved = localStorage.getItem('siege_rules');
    return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : DEFAULT_RULES;
  });

  useEffect(() => {
    localStorage.setItem('siege_rules', JSON.stringify(rules));
  }, [rules]);

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
          const data = snap.data() as {
            hostId: string;
            players: Record<string, LobbyPerson>;
            matchStarted?: boolean;
            matchRules?: number;
          };
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

  /**
   * Everyone in the match, sorted by uid.
   *
   * Sorted rather than in arrival order so every client computes the identical
   * seating from data it already has — otherwise two players would disagree
   * about which keep is which, and a spectator arrow would land on the wrong
   * one.
   */
  const people = useMemo(() => {
    return Object.values(lobby?.players ?? {})
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .slice(0, rules.players)
      .map((p) => ({ uid: p.uid, displayName: p.displayName || 'Player' }));
  }, [lobby, rules.players]);

  /** A guest obeys the host's rules; its own copy is only a placeholder. */
  useEffect(() => {
    if (!online || isHost) return;
    const bits = lobby?.matchRules;
    if (typeof bits !== 'number') return;
    setRules(unpackRules(bits));
  }, [online, isHost, lobby?.matchRules]);

  useEffect(() => {
    if (!online || offlineMatch) return;
    if (lobby?.matchStarted && view === 'room') {
      rollSession();
      setView('game');
    }
    if (!lobby?.matchStarted && view === 'game' && !offlineMatch) setView('room');
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

  const leaveMatch = useCallback(async () => {
    setOfflineMatch(false);
    setView(online ? 'room' : 'menu');
    if (!online || !isHost) return;
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      await updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: false });
    } catch {
      /* the room may already be gone; nothing to do about it here */
    }
  }, [online, isHost, handoff.room]);

  const award = useCallback((won: boolean, wave: number) => {
    // Something for turning up, more for surviving, and a slice per wave so a
    // long losing stand still pays better than a short one.
    setCoins((c) => c + (won ? 120 : 30) + wave * 6);
    reportResult(won);
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
    for (let i = 0; i < Math.max(1, soloSeats); i++) {
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
      rules: { ...rules, players: Math.max(1, soloSeats) as PlayerCount },
    };
  }

  const openOffline = (count: number) => {
    audioService.unlock();
    rollSession();
    setSoloSeats(count);
    setOfflineMatch(true);
    setView('game');
  };

  // -- render -----------------------------------------------------------------

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden text-white">
      {(view === 'menu' || view === 'offline_menu') && (
        <Menu
          coins={coins}
          aiLevel={aiLevel}
          onAiLevel={setAiLevel}
          onSolo={() => openOffline(1)}
          onPractice={() => openOffline(2)}
          onSettings={() => setShowSettings(true)}
          onRules={() => setShowRules(true)}
          onFullscreen={() => toggleFullscreen(document.documentElement, !document.fullscreenElement)}
          rules={rules}
          onBack={view === 'offline_menu' ? () => setView('room') : undefined}
        />
      )}

      {view === 'room' && (
        <RoomScreen
          ready={authChecked && Boolean(lobby)}
          error={lobbyError}
          uid={uid}
          people={people}
          hostId={lobby?.hostId ?? null}
          isHost={isHost}
          rules={rules}
          onRules={() => setShowRules(true)}
          onSettings={() => setShowSettings(true)}
          onStart={startMatch}
          onFullscreen={() => toggleFullscreen(document.documentElement, !document.fullscreenElement)}
          onPlayOffline={() => {
            audioService.unlock();
            setView('offline_menu');
          }}
        />
      )}

      {view === 'game' && (
        <MatchView
          config={offlineMatch || !online ? offlineConfig() : onlineConfig()}
          settings={settings}
          coins={coins}
          onOpenSettings={() => setShowSettings(true)}
          onExit={() => {
            if (online && !offlineMatch && !isHost) askHostToEndGame();
            void leaveMatch();
          }}
          onResult={award}
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

// -- pieces -------------------------------------------------------------------

function rulesSummary(r: MatchRules): string {
  return [
    r.mode === 'siege' ? 'Siege — last keep standing' : 'Alliance — shared lives',
    `${r.players} keep${r.players === 1 ? '' : 's'}`,
    `${r.waves} waves`,
    r.mode === 'siege' ? (r.sends ? 'sending on' : 'no sending') : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function Menu({
  coins,
  aiLevel,
  onAiLevel,
  onSolo,
  onPractice,
  onSettings,
  onRules,
  onFullscreen,
  rules,
  onBack,
}: {
  coins: number;
  aiLevel: number;
  onAiLevel: (n: number) => void;
  onSolo: () => void;
  onPractice: () => void;
  onSettings: () => void;
  onRules: () => void;
  onFullscreen: () => void;
  rules: MatchRules;
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
        <div className="mb-4 inline-block rounded-3xl bg-amber-400/20 p-4">
          <Castle className="h-12 w-12 text-amber-300" />
        </div>
        <h1 className="text-4xl font-black leading-none tracking-tighter drop-shadow-lg sm:text-6xl">
          TOWER <span className="text-amber-300">SIEGE</span>
        </h1>
        <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.3em] text-white/70">
          Same waves · Separate keeps
        </p>
      </div>

      <div className="panel w-full max-w-md space-y-5 rounded-[2rem] p-6">
        <button
          onClick={onSolo}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 py-4 text-lg font-black text-slate-900 transition-transform active:scale-95"
        >
          <Play className="h-5 w-5 fill-current" /> Hold the keep alone
        </button>

        <button
          onClick={onPractice}
          className="w-full rounded-2xl border border-white/25 bg-white/10 py-4 font-black transition-colors hover:bg-white/20"
        >
          Race a bot
          <span className="mt-1 block text-[11px] font-bold normal-case tracking-normal text-white/50">
            Same waves hit both keeps. Whoever holds out longer takes it.
          </span>
        </button>

        <div className="space-y-2">
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-white/50">Bot rank</p>
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

        <div className="rounded-2xl bg-black/25 p-3 text-center text-xs leading-relaxed text-white/50">
          <p className="mb-1 font-black uppercase tracking-[0.15em] text-white/40">How it works</p>
          <p>Pick a tower, tap a plot twice to build it. Tap a standing tower to upgrade or sell it.</p>
          <p className="mt-1">Everyone faces the identical horde. Leak twenty and your keep falls.</p>
          <p className="mt-2 text-white/40">
            Playing online? Start a lobby on PlayBuddies and pick this game — up to four keeps.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="panel flex items-center gap-2 rounded-2xl px-4 py-3 font-bold text-amber-300">
          <Coins className="h-5 w-5" /> {coins}
        </div>
        <button onClick={onRules} className="panel flex items-center gap-2 rounded-2xl px-4 py-3 font-bold text-white/70">
          <ScrollText className="h-5 w-5" /> Rules
        </button>
        <button onClick={onFullscreen} aria-label="Full screen" className="panel rounded-2xl p-3">
          <Maximize2 className="h-5 w-5" />
        </button>
        <button onClick={onSettings} aria-label="Settings" className="panel rounded-2xl p-3">
          <SettingsIcon className="h-5 w-5" />
        </button>
      </div>
      <p className="-mt-3 text-center text-[11px] font-semibold text-white/35">{rulesSummary(rules)}</p>
    </div>
  );
}

function RoomScreen({
  ready,
  error,
  uid,
  people,
  hostId,
  isHost,
  rules,
  onRules,
  onSettings,
  onStart,
  onFullscreen,
  onPlayOffline,
}: {
  ready: boolean;
  error: string | null;
  uid: string | null;
  people: { uid: string; displayName: string }[];
  hostId: string | null;
  isHost: boolean;
  rules: MatchRules;
  onRules: () => void;
  onSettings: () => void;
  onStart: () => void;
  onFullscreen: () => void;
  onPlayOffline: () => void;
}) {
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-lg font-black">{error}</p>
        <button onClick={onPlayOffline} className="rounded-2xl bg-amber-400 px-5 py-3 font-black text-slate-900">
          Hold a keep on your own
        </button>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-amber-300" />
        <p className="font-bold text-white/70">Finding the room…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-y-auto overscroll-contain gap-3 p-4 sm:gap-4 sm:p-6">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <button onClick={onFullscreen} aria-label="Fullscreen" className="panel shrink-0 rounded-2xl p-3">
          <Users className="h-5 w-5" />
        </button>
        <h2 className="min-w-0 truncate text-center text-lg font-black tracking-tight sm:text-2xl">
          Tower Siege
        </h2>
        <button onClick={onSettings} aria-label="Settings" className="panel shrink-0 rounded-2xl p-3">
          <SettingsIcon className="h-5 w-5" />
        </button>
      </div>

      <div className="panel min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain rounded-[2rem] p-5">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-white/45">The defenders</p>
          <div className="mt-2 space-y-1.5">
            {people.map((p, i) => (
              <div key={p.uid} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: SEATS[i % SEATS.length].main }} />
                <span className="min-w-0 flex-1 truncate text-sm font-bold">
                  {p.displayName}
                  {p.uid === uid ? ' · you' : ''}
                </span>
                {p.uid === hostId && <Crown className="h-4 w-4 shrink-0 text-amber-300" />}
              </div>
            ))}
            {Array.from({ length: Math.max(0, rules.players - people.length) }).map((_, i) => (
              <div
                key={`bot-${i}`}
                className="flex items-center gap-2 rounded-xl border border-dashed border-white/12 px-3 py-2 text-white/40"
              >
                <span className="h-3 w-3 shrink-0 rounded-full bg-white/20" />
                <span className="text-sm font-bold">Empty berth — a bot holds it</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl bg-black/25 p-3">
          <p className="text-[11px] font-black uppercase tracking-[0.15em] text-white/40">This match</p>
          <p className="mt-1 text-xs font-semibold text-white/60">{rulesSummary(rules)}</p>
          <button onClick={onRules} className="mt-2 text-[11px] font-black text-amber-300">
            {isHost ? 'Change the rules' : 'See the rules'}
          </button>
        </div>
      </div>

      <div className="shrink-0 space-y-2">
        {isHost ? (
          <button
            onClick={onStart}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 py-4 text-lg font-black text-slate-900"
          >
            <Play className="h-5 w-5 fill-current" /> RAISE THE GATES
          </button>
        ) : (
          <p className="rounded-2xl border border-white/10 bg-white/5 py-3 text-center text-sm font-bold text-white/50">
            Waiting for the host to start.
          </p>
        )}
        <button onClick={onPlayOffline} className="w-full text-[11px] font-bold text-white/35 hover:text-white/60">
          Or hold a keep on your own
        </button>
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
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="panel w-full max-w-sm space-y-5 rounded-[2rem] p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-black">Settings</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-white/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

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
      </div>
    </div>
  );
}

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
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-6 overflow-y-auto overscroll-contain rounded-[2rem] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xl font-black">Match rules</h3>
            <p className="text-[11px] font-semibold text-white/45">
              {editable ? 'Applies to every keep. Takes effect next match.' : 'Set by the host.'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-white/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-bold">How it is won</p>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { id: 'siege' as Mode, icon: <Swords className="h-4 w-4" />, name: 'Siege', hint: 'Own lives. Last keep standing wins.' },
                { id: 'alliance' as Mode, icon: <Shield className="h-4 w-4" />, name: 'Alliance', hint: 'One pool of lives. Waves scale with the party.' },
              ]
            ).map((m) => (
              <button
                key={m.id}
                disabled={!editable}
                onClick={() => onChange({ ...rules, mode: m.id })}
                className={`rounded-xl border p-3 text-left transition-colors disabled:opacity-50 ${
                  rules.mode === m.id ? 'border-amber-400 bg-amber-400/15' : 'border-white/15 bg-white/5'
                }`}
              >
                <span className="flex items-center gap-1.5 text-sm font-black">
                  {m.icon} {m.name}
                </span>
                <span className="mt-1 block text-[10px] font-semibold leading-snug text-white/50">{m.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-bold">
            Keeps
            <span className="block text-[11px] font-normal text-white/50">
              Anyone in the room past this watches. Empty berths are held by bots.
            </span>
          </p>
          <div className="grid grid-cols-4 gap-2">
            {([1, 2, 3, 4] as PlayerCount[]).map((n) => (
              <button
                key={n}
                disabled={!editable}
                onClick={() => onChange({ ...rules, players: n })}
                className={`rounded-xl border py-2.5 text-sm font-black transition-colors disabled:opacity-50 ${
                  rules.players === n ? 'border-amber-400 bg-amber-400/20 text-amber-200' : 'border-white/15 bg-white/5 text-white/60'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-bold">
            Waves
            <span className="block text-[11px] font-normal text-white/50">
              Hold them all and the keeps still standing share the win.
            </span>
          </p>
          <div className="grid grid-cols-3 gap-2">
            {[10, 20, 30].map((n) => (
              <button
                key={n}
                disabled={!editable}
                onClick={() => onChange({ ...rules, waves: n })}
                className={`rounded-xl border py-2.5 text-sm font-black transition-colors disabled:opacity-50 ${
                  rules.waves === n ? 'border-amber-400 bg-amber-400/20 text-amber-200' : 'border-white/15 bg-white/5 text-white/60'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold">
            Sending
            <span className="block text-[11px] font-normal text-white/50">
              Siege only. Spend gold to push extra enemies into every other keep&apos;s next wave — it costs more than
              it pays them, so it is a real bet. Off makes it a pure race.
            </span>
          </span>
          <input
            type="checkbox"
            disabled={!editable || rules.mode !== 'siege'}
            checked={rules.sends && rules.mode === 'siege'}
            onChange={(e) => onChange({ ...rules, sends: e.target.checked })}
            className="h-6 w-6 shrink-0 accent-amber-400 disabled:opacity-40"
          />
        </label>

        <div className="space-y-2 rounded-2xl bg-black/25 p-3">
          <p className="text-[11px] font-black uppercase tracking-[0.15em] text-white/40">The towers</p>
          {TOWER_ORDER.map((id) => (
            <div key={id} className="flex gap-2">
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: TOWERS[id].trim }} />
              <p className="text-[11px] leading-snug text-white/55">
                <span className="font-black text-white/80">{TOWERS[id].name}</span> — {TOWERS[id].blurb}
                {!TOWERS[id].air && <span className="text-rose-300/80"> Cannot hit flyers.</span>}
              </p>
            </div>
          ))}
        </div>

        <div className="space-y-2 rounded-2xl bg-black/25 p-3">
          <p className="text-[11px] font-black uppercase tracking-[0.15em] text-white/40">What is coming</p>
          {(['runner', 'grunt', 'brute', 'flyer', 'warden', 'boss'] as const).map((id) => (
            <div key={id} className="flex items-center gap-2 text-[11px]">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ENEMIES[id].body }} />
              <span className="font-black text-white/80">{ENEMIES[id].name}</span>
              <span className="text-white/45">
                {ENEMIES[id].flying ? 'flies straight over' : `${ENEMIES[id].armour >= 5 ? 'armoured' : 'unarmoured'}`}
                {ENEMIES[id].speed >= 100 ? ' · fast' : ENEMIES[id].speed <= 40 ? ' · slow' : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
