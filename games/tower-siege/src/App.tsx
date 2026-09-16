import { useCallback, useEffect, useMemo, useState } from 'react';
import { scrimProps, useEscape } from '@shared/ui/dismiss';
import {
  ArrowLeft,
  Castle,
  Coins,
  Crown,
  Loader2,
  LogOut,
  Maximize2,
  Play,
  ShoppingBag,
  Settings as SettingsIcon,
  Shield,
  Swords,
  Users,
  User,
} from 'lucide-react';
import { askHostToEndGame, askToLeaveLobby, isNativeFullscreen, toggleFullscreen, useAutoFullscreen } from './fullscreen';
import { GameWallet, reportResult } from './platform/wallet';
import { TIERS } from './engine/ai';
import { SEATS, DEFAULT_RULES, packRules, unpackRules } from './game/rules';
import type { MatchRules, PlayerCount } from './game/rules';
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
  useAutoFullscreen(online || view === 'game');
  const [showSettings, setShowSettings] = useState(false);
  const [showShop, setShowShop] = useState(false);
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
   * Match size follows the live room so an old local setting cannot create
   * ghost seats. Tower Siege supports a duel or a four-player 2v2.
   *
   * A previous room choice must never turn two live players into four stale
   * seats. The current roster is the source of truth before the host starts.
   */
  useEffect(() => {
    if (!online || !isHost || !lobby) return;
    const roomSize = Object.keys(lobby.players ?? {}).length;
    const fits: PlayerCount = roomSize > 2 ? 4 : 2;
    if (fits !== rules.players || (fits === 4 && rules.mode === 'alliance')) {
      setRules((r) => ({ ...r, players: fits, mode: fits === 4 ? 'siege' : r.mode, sends: false }));
    }
  }, [online, isHost, lobby, rules.players, rules.mode]);

  /**
   * Everyone in the match, sorted by uid.
   *
   * Sorted rather than in arrival order so every client computes the identical
   * seating from data it already has; ownership and 2v2 teams depend on this.
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

  // Publish mode choices while everyone is still in the room. Guests must
  // know the seat count before MatchView freezes its roster at the start.
  useEffect(() => {
    if (!online || !isHost) return;
    void import('./firebase').then(({ db, doc, updateDoc }) =>
      updateDoc(doc(db, 'lobbies', handoff.room), { matchRules: packRules(rules) }),
    ).catch((error) => console.error('Could not share the Tower Siege mode', error));
  }, [online, isHost, handoff.room, rules]);

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

  // Frozen to match identity, not recomputed live: MatchView reads config
  // fields like seat team every frame, and a live roster reorder mid-round
  // (reconnect, late write) would otherwise flip them under a running game.
  const pregameConfigKey = view === 'game'
    ? 'locked'
    : `${packRules(rules)}:${people.map((person) => person.uid).join(',')}`;
  const matchConfig = useMemo(
    () => (offlineMatch || !online ? offlineConfig() : onlineConfig()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.seed, offlineMatch, online, pregameConfigKey],
  );

  // -- render -----------------------------------------------------------------

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden text-white">
      {(view === 'menu' || view === 'offline_menu') && (
        <Menu
          coins={coins}
          aiLevel={aiLevel}
          onAiLevel={setAiLevel}
          onSolo={() => openOffline(1)}
          onMultiplayer={() => (online ? setView('room') : askToLeaveLobby())}
          onSettings={() => setShowSettings(true)}
          onShop={() => setShowShop(true)}
          onFullscreen={() => toggleFullscreen(document.documentElement, !isNativeFullscreen())}
          onExit={askToLeaveLobby}
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
          coins={coins}
          onMode={(mode, players) => setRules((r) => ({ ...r, mode, players, sends: false }))}
          onSettings={() => setShowSettings(true)}
          onStart={startMatch}
          onFullscreen={() => toggleFullscreen(document.documentElement, !isNativeFullscreen())}
          onExit={askToLeaveLobby}
          onPlayOffline={() => {
            audioService.unlock();
            setView('offline_menu');
          }}
        />
      )}

      {view === 'game' && (
        <MatchView
          config={matchConfig}
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

      {showShop && <ShopPanel coins={coins} onClose={() => setShowShop(false)} />}
    </div>
  );
}

// -- pieces -------------------------------------------------------------------

function Menu({
  coins,
  aiLevel,
  onAiLevel,
  onSolo,
  onMultiplayer,
  onSettings,
  onShop,
  onFullscreen,
  onExit,
  onBack,
}: {
  coins: number;
  aiLevel: number;
  onAiLevel: (n: number) => void;
  onSolo: () => void;
  onMultiplayer: () => void;
  onSettings: () => void;
  onShop: () => void;
  onFullscreen: () => void;
  onExit: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="menu-sky flex h-full flex-col overflow-y-auto overscroll-contain p-3 sm:p-6">
      <div className="flex shrink-0 items-start justify-between gap-2">
        <div>{onBack && <button onClick={onBack} aria-label="Back" className="panel rounded-2xl p-3"><ArrowLeft className="h-5 w-5" /></button>}</div>
        <div className="flex items-center gap-2">
          <div className="panel flex items-center gap-2 rounded-2xl px-3 py-2 font-black text-amber-300"><Coins className="h-4 w-4" /> {coins}</div>
          <button onClick={onFullscreen} aria-label="Full screen" className="panel rounded-2xl p-2.5"><Maximize2 className="h-5 w-5" /></button>
          <button onClick={onExit} aria-label="Leave" className="panel rounded-2xl p-2.5"><LogOut className="h-5 w-5" /></button>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center gap-4 py-4 short:py-1">
        <div className="text-center">
          <div className="mx-auto mb-2 grid h-16 w-16 place-items-center rounded-[1.4rem] border-2 border-amber-200/60 bg-amber-400 text-slate-900 shadow-[0_10px_35px_rgba(251,191,36,.35)] short:h-11 short:w-11"><Castle className="h-9 w-9 short:h-6 short:w-6" /></div>
          <h1 className="text-4xl font-black leading-none tracking-tighter drop-shadow-lg sm:text-6xl short:text-3xl">TOWER <span className="text-amber-300">SIEGE</span></h1>
          <p className="mt-2 text-[11px] font-black uppercase tracking-[0.28em] text-cyan-100/75">One battlefield · every machine matters</p>
        </div>

        <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4">
          <MenuCard icon={<User />} title="Single Player" hint="Defend the keep alone" tone="amber" onClick={onSolo} />
          <MenuCard icon={<Users />} title="Multiplayer" hint="Co-op, 1v1 or 2v2" tone="cyan" onClick={onMultiplayer} />
          <MenuCard icon={<ShoppingBag />} title="Shop" hint="Battlefield collection" tone="violet" onClick={onShop} />
          <MenuCard icon={<SettingsIcon />} title="Settings" hint="Sound and display" tone="emerald" onClick={onSettings} />
        </div>

        <div className="panel w-full max-w-xl rounded-2xl p-3">
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-xs font-black uppercase tracking-wider text-white/75">Commander AI</p><p className="text-[10px] text-white/45">Used for empty seats and solo practice.</p></div>
            <div className="flex gap-1 rounded-xl bg-black/25 p-1">
              {TIERS.map((tier, i) => <button key={tier.label} onClick={() => onAiLevel(i)} className={`rounded-lg px-3 py-2 text-[10px] font-black uppercase ${aiLevel === i ? 'bg-amber-400 text-slate-950' : 'text-white/55'}`}>{tier.label}</button>)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MenuCard({ icon, title, hint, tone, onClick }: { icon: React.ReactNode; title: string; hint: string; tone: 'amber' | 'cyan' | 'violet' | 'emerald'; onClick: () => void }) {
  const colors = { amber: 'from-amber-300 to-orange-500 text-slate-950', cyan: 'from-cyan-300 to-blue-500 text-slate-950', violet: 'from-violet-400 to-fuchsia-500 text-white', emerald: 'from-emerald-300 to-teal-500 text-slate-950' };
  return <button onClick={onClick} className={`group min-h-32 rounded-[1.6rem] bg-gradient-to-br ${colors[tone]} p-[2px] text-left shadow-xl transition-transform hover:-translate-y-1 active:scale-95 short:min-h-20`}><span className="flex h-full flex-col justify-between rounded-[1.5rem] bg-slate-950/82 p-4 text-white short:p-2"><span className="grid h-10 w-10 place-items-center rounded-xl bg-white/12 [&>svg]:h-5 [&>svg]:w-5">{icon}</span><span><strong className="block text-base font-black short:text-sm">{title}</strong><small className="text-[10px] font-bold text-white/50 short:hidden">{hint}</small></span></span></button>;
}

function RoomScreen({
  ready, error, uid, people, hostId, isHost, rules, coins, onMode, onSettings, onStart, onFullscreen, onExit, onPlayOffline,
}: {
  ready: boolean; error: string | null; uid: string | null;
  people: { uid: string; displayName: string }[]; hostId: string | null; isHost: boolean;
  rules: MatchRules; coins: number;
  onMode: (mode: MatchRules['mode'], players: PlayerCount) => void;
  onSettings: () => void; onStart: () => void; onFullscreen: () => void; onExit: () => void; onPlayOffline: () => void;
}) {
  if (error) return <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"><p className="text-lg font-black">{error}</p><button onClick={onPlayOffline} className="rounded-2xl bg-amber-400 px-5 py-3 font-black text-slate-900">Play single player</button></div>;
  if (!ready) return <div className="flex h-full flex-col items-center justify-center gap-3"><Loader2 className="h-10 w-10 animate-spin text-amber-300" /><p className="font-bold text-white/70">Finding the room…</p></div>;
  const active = (mode: MatchRules['mode'], players: number) => rules.mode === mode && rules.players === players;
  const modeCards = [
    { mode: 'alliance' as const, players: 2 as PlayerCount, icon: <Shield />, name: 'Shared Keep', hint: 'Two defenders, one base. Private money from your own towers.' },
    { mode: 'siege' as const, players: 2 as PlayerCount, icon: <Swords />, name: 'Head-to-Head', hint: '1v1 on one battlefield. Most tower kills wins.' },
    { mode: 'siege' as const, players: 4 as PlayerCount, icon: <Users />, name: 'Team Siege', hint: 'Four players, 2v2. Alternating seats form the teams.' },
  ];
  return (
    <div className="menu-sky mx-auto flex h-full w-full flex-col overflow-y-auto overscroll-contain p-3 sm:p-6">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div><h2 className="text-xl font-black sm:text-3xl">Choose the battle</h2><p className="text-[10px] font-black uppercase tracking-[.2em] text-cyan-100/55">One shared battlefield</p></div>
        <div className="flex items-center gap-2"><div className="panel flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-black text-amber-300"><Coins className="h-4 w-4" />{coins}</div><button onClick={onFullscreen} className="panel rounded-xl p-2.5"><Maximize2 className="h-5 w-5" /></button><button onClick={onSettings} className="panel rounded-xl p-2.5"><SettingsIcon className="h-5 w-5" /></button><button onClick={onExit} className="panel rounded-xl p-2.5"><LogOut className="h-5 w-5" /></button></div>
      </div>
      <div className="mx-auto grid min-h-0 w-full max-w-5xl flex-1 gap-3 py-3 lg:grid-cols-[1.4fr_.8fr]">
        <section className="panel rounded-[2rem] p-3 sm:p-5">
          <p className="mb-3 text-xs font-black uppercase tracking-[.18em] text-white/50">Game modes</p>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            {modeCards.map((m) => {
              const wrongRoomSize = m.players === 4 ? people.length < 3 : people.length > 2;
              return <button key={`${m.mode}-${m.players}`} disabled={!isHost || wrongRoomSize} onClick={() => onMode(m.mode, m.players)} className={`flex items-center gap-3 rounded-2xl border-2 p-4 text-left transition-all disabled:cursor-default disabled:opacity-40 ${active(m.mode, m.players) ? 'border-amber-300 bg-amber-400/18 shadow-[0_0_28px_rgba(251,191,36,.18)]' : 'border-white/12 bg-white/5 hover:bg-white/10'}`}><span className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl [&>svg]:h-6 [&>svg]:w-6 ${active(m.mode,m.players) ? 'bg-amber-400 text-slate-950' : 'bg-cyan-400/15 text-cyan-200'}`}>{m.icon}</span><span><strong className="block text-base font-black">{m.name}</strong><small className="mt-1 block text-[11px] font-semibold leading-snug text-white/50">{m.hint}{wrongRoomSize ? ' Room size does not fit this mode.' : ''}</small></span></button>;
            })}
          </div>
          {!isHost && <p className="mt-3 text-center text-[11px] font-bold text-amber-200/70">The host is choosing the mode.</p>}
        </section>
        <section className="panel flex min-h-0 flex-col rounded-[2rem] p-3 sm:p-5">
          <p className="text-xs font-black uppercase tracking-[.18em] text-white/50">Players on the field</p>
          <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
            {people.slice(0, rules.players).map((person, i) => <div key={person.uid} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/35 p-3"><span className="grid h-9 w-9 place-items-center rounded-xl font-black text-slate-950" style={{background: SEATS[i].main}}>{i + 1}</span><span className="min-w-0 flex-1 truncate text-sm font-black">{person.displayName}{person.uid === uid ? ' · you' : ''}</span>{rules.mode === 'siege' && <span className="rounded-lg bg-white/8 px-2 py-1 text-[9px] font-black" style={{color: SEATS[i % 2].light}}>TEAM {(i % 2) + 1}</span>}{person.uid === hostId && <Crown className="h-4 w-4 text-amber-300" />}</div>)}
            {Array.from({length: Math.max(0, rules.players - people.length)}).map((_, i) => <div key={i} className="rounded-2xl border border-dashed border-white/15 p-3 text-xs font-bold text-white/35">Commander bot fills seat {people.length + i + 1}</div>)}
          </div>
          <div className="mt-3 space-y-2">{isHost ? <button onClick={onStart} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-amber-300 to-orange-500 py-3.5 font-black text-slate-950 shadow-lg"><Play className="h-4 w-4 fill-current" />Start {rules.mode === 'alliance' ? 'co-op' : rules.players === 4 ? '2v2' : 'duel'}</button> : <p className="rounded-2xl bg-white/5 py-3 text-center text-sm font-bold text-white/50">Waiting for the host</p>}<button onClick={onPlayOffline} className="w-full py-1 text-[10px] font-bold text-white/40">Single-player menu</button></div>
        </section>
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

function ShopPanel({ coins, onClose }: { coins: number; onClose: () => void }) {
  useEscape(true, onClose);
  return (
    <div {...scrimProps(onClose)} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm">
      <div className="panel w-full max-w-lg rounded-[2rem] p-6">
        <div className="flex items-center justify-between"><div><h3 className="text-2xl font-black">Siege Shop</h3><p className="text-xs text-white/45">Cosmetic banners and field styles are arriving next.</p></div><button onClick={onClose} className="rounded-xl p-2 hover:bg-white/10"><ArrowLeft /></button></div>
        <div className="mt-5 grid grid-cols-3 gap-3">{['Royal Gold', 'Ocean Blue', 'Dragon Red'].map((name, i) => <div key={name} className="rounded-2xl border border-white/12 bg-white/5 p-3 text-center"><div className="mx-auto h-16 rounded-xl" style={{background: ['#fbbf24','#22d3ee','#fb7185'][i]}} /><p className="mt-2 text-xs font-black">{name}</p><p className="text-[10px] text-white/40">Coming soon</p></div>)}</div>
        <p className="mt-5 text-center text-sm font-black text-amber-300"><Coins className="mr-1 inline h-4 w-4" />{coins} available</p>
      </div>
    </div>
  );
}
