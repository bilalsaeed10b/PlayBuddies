import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Anchor,
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
import { FREE_SHIPS, SHIPS, drawShip } from './game/ships';
import { TEAM_COLORS } from './game/rules';
import { TIERS } from './engine/ai';
import { audioService } from './services/audio';
import { GameWallet, reportResult } from './platform/wallet';
import BattleView, { MatchConfig } from './screens/BattleView';
import type { Seat } from './engine/BattleEngine';
import { DEFAULT_RULES, packRules, unpackRules } from './types/game';
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

type View = 'menu' | 'pick' | 'room' | 'game' | 'offline_menu';

interface LobbyPerson {
  uid: string;
  displayName: string;
  /**
   * The lobby's per-player slot. Fish Eat Fish named it, Volley Clash reuses
   * it, and so does this: the security rules name the writable fields one by
   * one, so a new game inventing its own key would simply be refused.
   */
  fishIndex?: number | null;
}

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;
const coinFlip = (): Team => (Math.random() < 0.5 ? 0 : 1);

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
    matchRules?: number;
  } | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  /** Offline setup: how many people are at this device, and as what. */
  const [seatCount, setSeatCount] = useState(1);
  const [seatSkin, setSeatSkin] = useState<Record<number, number>>({});
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
    ...new Set([...wallet.current.unlocks, ...FREE_SHIPS]),
  ]);
  /** Nothing is saved until the account has answered, or declined to. */
  const [walletReady, setWalletReady] = useState(false);

  useEffect(() => {
    wallet.open((purse) => {
      setCoins(purse.coins);
      setOwned([...new Set([...purse.unlocks, ...FREE_SHIPS])]);
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
    const saved = localStorage.getItem('pirates_rules');
    return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : DEFAULT_RULES;
  });
  const [showRules, setShowRules] = useState(false);
  useEffect(() => {
    localStorage.setItem('pirates_rules', JSON.stringify(rules));
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
            matchStarted?: boolean;
            matchRules?: number;
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
        team: (i % 2) as Team,
      }));
  }, [lobby, rules.players]);

  const mySkin = uid ? lobby?.players?.[uid]?.fishIndex : undefined;
  const isHost = Boolean(uid && lobby && lobby.hostId === uid);

  useEffect(() => {
    // An offline battle is the player's own; the room does not get to start or
    // end it. This guard is also what stops an unrelated lobby update from
    // bouncing a couch battle straight back to the room.
    if (!online || offlineMatch) return;
    if (lobby?.matchStarted && mySkin !== undefined && mySkin !== null) setView('game');
    else if (view === 'game') setView('room');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.matchStarted, mySkin, online, offlineMatch]);

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
      if (!owned.includes(index) && !buy(index)) return;
      try {
        // Already loaded by the session effect on this path; the import cache
        // makes this a lookup rather than a second fetch.
        const { db, doc, updateDoc } = await import('./firebase');
        await updateDoc(doc(db, 'lobbies', handoff.room), { [`players.${uid}.fishIndex`]: index });
      } catch (e) {
        console.error('Could not save your ship', e);
      }
    },
    [uid, owned, buy, handoff.room],
  );

  const startMatch = useCallback(async () => {
    if (!isHost) return;
    try {
      const { db, doc, updateDoc } = await import('./firebase');
      // `matchRules` rides along with the go-signal in the same write, so it
      // lands in every guest's next snapshot at the same instant `matchStarted`
      // does -- there is no room for a guest to flip to the game view on a
      // `rules.players` that hasn't been corrected yet (see the lobby
      // snapshot handler above).
      log.info('host:start-match', { players: rules.players, packed: packRules(rules) });
      await updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: true, matchRules: packRules(rules) });
    } catch (e) {
      console.error('Could not start the battle', e);
    }
  }, [isHost, handoff.room, rules]);

  const award = useCallback((won: boolean, hpLeft: number) => {
    // Something for turning up, more for winning, and a bonus for coming
    // through it with your hull mostly intact.
    setCoins((c) => c + (won ? 95 : 30) + (won ? Math.round(hpLeft / 3) : 0));
    reportResult(won);
  }, []);

  /**
   * Leaving the battle, online: back to the room, and, for the host, the
   * go-signal comes down with it.
   *
   * `matchStarted` was never reset anywhere in the two games before this one,
   * and it broke a rematch two different ways: pressing Start again did
   * nothing, because true to true is not a change the effect above reacts to,
   * while picking a *different* ship was a change, so it launched a battle
   * nobody had started. Resetting it here, on the way out, also covers the
   * host quitting mid-match, which is what the platform's own End Game does.
   */
  const leaveBattle = useCallback(() => {
    setOfflineMatch(false);
    setView(online ? 'room' : 'menu');
    rollSession();
    if (!online || !isHost) return;
    void import('./firebase')
      .then(({ db, doc, updateDoc }) => updateDoc(doc(db, 'lobbies', handoff.room), { matchStarted: false }))
      .catch((e) => console.error('Could not reset the match flag', e));
  }, [online, isHost, handoff.room, rollSession]);

  // -- into the battle --------------------------------------------------------

  if (view === 'game') {
    const config = online && uid && !offlineMatch ? onlineConfig() : offlineConfig();
    return (
      <>
        <BattleView
          config={config}
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
    const crew = handoff.solo ? people.filter((p) => p.uid === uid) : people;
    const seats: Seat[] = [];
    const localShips: number[] = [];

    // Every berth the rules call for gets filled, in the fixed side-alternating
    // order every client derives the same way. A berth with nobody in it gets a
    // bot, so a half-empty room is still an even fight rather than a walkover.
    for (let i = 0; i < rules.players; i++) {
      const team = (i % 2) as Team;
      const person = crew[i];
      if (person && person.uid === uid) {
        localShips.push(i);
        seats.push({
          team,
          id: uid ?? 'me',
          name: handoff.displayName || 'You',
          control: 'local',
          aiLevel,
          skin: mySkin ?? FREE_SHIPS[0],
        });
      } else if (person) {
        seats.push({
          team,
          id: person.uid,
          name: person.displayName,
          control: 'remote',
          aiLevel,
          skin: person.skin ?? pickOtherShip(mySkin ?? FREE_SHIPS[0]),
        });
      } else {
        seats.push({
          team,
          id: `bot-${i}`,
          name: `${TIERS[aiLevel].label} Bot`,
          control: 'ai',
          aiLevel,
          skin: pickOtherShip(mySkin ?? FREE_SHIPS[0]),
        });
      }
    }

    const peerUids = crew.filter((p) => p.uid !== uid).map((p) => p.uid);
    // The exact thing that was silently wrong before: a guest whose local
    // `rules.players` hadn't caught up to the host's built a shorter seats
    // array than the host did. Logged every time this runs so that mismatch
    // is visible across two tabs' logs without having to reproduce it live.
    log.info('seats:built', {
      rulesPlayers: rules.players,
      peopleCount: people.length,
      crewCount: crew.length,
      peerUids,
      seatCount: seats.length,
      seats: seats.map((s) => ({ team: s.team, id: s.id, control: s.control })),
      localShips,
      isHost,
    });

    return {
      roomId: handoff.room,
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
      rules,
    };
  }

  function offlineConfig(): MatchConfig {
    const p1 = seatSkin[0] ?? FREE_SHIPS[0];
    const seats: Seat[] = [];
    const localShips: number[] = [];

    // The fleet-size rule applies offline too, so a solo player can take a
    // wing of bots against a fleet of them. Sides alternate down the list, so
    // the first two berths are opposite each other — which is what makes a
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

  // -- shells -----------------------------------------------------------------

  const openOffline = (players: number) => {
    audioService.unlock();
    rollSession();
    setOfflineMatch(true);
    setSeatCount(players);
    setSeatSkin({});
    setView('pick');
  };

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden text-white">
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
          onPick={pickOnline}
          onStart={startMatch}
          onSettings={() => setShowSettings(true)}
          onRules={() => setShowRules(true)}
          rules={rules}
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

const MOUNTAIN_LABEL: Record<MountainRule, string> = {
  off: 'No mountain',
  breakable: 'Breakable mountain',
  solid: 'Solid mountain',
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
    rules.cards ? 'cards on' : 'round shot only',
    rules.turnTimer ? '15s turns' : 'no clock',
    rules.aimArc ? 'aim arc on' : 'no aim arc',
  ].join(' · ');
}

/** The bot sails something other than what the player picked. */
function pickOtherShip(playerChoice: number) {
  const options = FREE_SHIPS.filter((i) => i !== playerChoice);
  return options[Math.floor(Math.random() * options.length)] ?? 0;
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
          <Anchor className="h-12 w-12 text-amber-300" />
        </div>
        <h1 className="text-4xl font-black leading-none tracking-tighter drop-shadow-lg sm:text-6xl">
          BATTLE OF <span className="text-amber-300">PIRATES</span>
        </h1>
        <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.3em] text-white/70">Aim, swipe, sink</p>
      </div>

      <div className="panel w-full max-w-md space-y-5 rounded-[2rem] p-6">
        <button
          onClick={onSolo}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 py-4 text-lg font-black text-slate-900 transition-transform active:scale-95"
        >
          <Play className="h-5 w-5 fill-current" /> Solo - you against the bot
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

        <button
          onClick={onCouch}
          className="w-full rounded-2xl border border-white/25 bg-white/10 py-4 font-black transition-colors hover:bg-white/20"
        >
          Two captains, one device
          <span className="mt-1 block text-[11px] font-bold normal-case tracking-normal text-white/50">
            Turns alternate. Whoever is up drags and lets go.
          </span>
        </button>

        <div className="rounded-2xl bg-black/25 p-3 text-center text-xs leading-relaxed text-white/50">
          <p className="mb-1 font-black uppercase tracking-[0.15em] text-white/40">How it works</p>
          <p>Drag back from anywhere and let go. Further back is more powder; the angle is the angle.</p>
          <p className="mt-1">Read the range, pick a card, and put a hole in the other hull first.</p>
          <p className="mt-2 text-white/40">
            Playing online? Start a lobby on PlayBuddies and pick this game. Two ships, one stretch of water.
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
        <button onClick={onSettings} aria-label="Settings" className="panel rounded-2xl p-3">
          <SettingsIcon className="h-5 w-5" />
        </button>
      </div>
      <p className="-mt-3 text-center text-[11px] font-semibold text-white/35">{rulesSummary(rules)}</p>
    </div>
  );
}

/** A ship card, drawn with the same code the battle uses. */
function Portrait({ index, size = 92 }: { index: number; size?: number }) {
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
      drawShip(ctx, {
        skin: index,
        x: size * 0.5,
        y: size * 0.84,
        facing: 1,
        accent: 'rgba(255,255,255,0.35)',
        aim: -0.55,
        lean: -0.05,
        flash: 0,
        clock: 0,
        scale: size / 390,
      });
    },
    [index, size],
  );
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
   * Everyone else who has also picked this ship. Purely informational — the
   * paint is cosmetic, so nothing stops two captains flying the same colours.
   */
  pickedBy: Record<number, string[]>;
  onPick: (index: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {SHIPS.map((ship, index) => {
        const isOwned = owned.includes(index);
        const others = pickedBy[index] ?? [];
        const isSelected = selected === index;
        const affordable = coins >= ship.price;

        return (
          <button
            key={ship.name}
            onClick={() => onPick(index)}
            disabled={!isOwned && !affordable}
            className={`relative flex flex-col items-center gap-1.5 overflow-hidden rounded-2xl border p-3 text-center transition-colors ${
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
                <span className="text-[11px] font-black text-amber-300">{ship.price}</span>
                {!affordable && <span className="text-[9px] font-bold text-rose-300">not enough</span>}
              </div>
            )}
            <Portrait index={index} />
            <span className="text-sm font-black uppercase tracking-wide">{ship.name}</span>
            {/*
              No stat bars, because there are no stats. Three identical full
              bars on every card would imply a choice that does not exist, and
              hinting at one is worse than saying plainly that these are paint.
            */}
            <span className="rounded-lg bg-black/25 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.15em] text-white/45">
              Paint only
            </span>
            <span className="text-[10px] leading-tight text-white/50">{ship.blurb}</span>
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

  const title = seatCount > 1 ? `Player ${seat + 1} - pick a ship` : 'Pick your ship';
  return (
    <Shell title={title} coins={coins} onBack={onBack}>
      <ShipGrid owned={owned} coins={coins} selected={null} pickedBy={pickedBy} onPick={pick} />
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
  onRules,
  rules,
  onFullscreen,
  onPlayOffline,
}: {
  ready: boolean;
  error: string | null;
  uid: string | null;
  people: { uid: string; displayName: string; skin?: number | null; team: Team }[];
  hostId: string | null;
  mine: number | null | undefined;
  owned: number[];
  coins: number;
  isHost: boolean;
  onPick: (index: number) => void;
  onStart: () => void;
  onSettings: () => void;
  onRules: () => void;
  rules: MatchRules;
  onFullscreen: () => void;
  onPlayOffline: () => void;
}) {
  /**
   * Whether the roster gets the compact chip strip or the roomy card list.
   *
   * A Tailwind width breakpoint got this wrong: a phone turned sideways is
   * wide enough to cross `sm:` and pick up the roomy layout, but it is
   * *short* on height, not width, which is the dimension actually being
   * fought over here. The roomy roster plus the mobile start/rules block
   * above it left as little as 49px for the ship grid on a landscape phone --
   * worse than doing nothing at all. Read like `compact`/`portrait` in
   * BattleView: real height, not a width proxy for it. Left off past desktop
   * width, where the roomy layout's own column is doing the flexing (see
   * `lg:max-h-none lg:flex-1` below) rather than fighting anything above it.
   */
  const [compactRoster, setCompactRoster] = useState(
    () => typeof window !== 'undefined' && window.innerHeight < 620 && window.innerWidth < 1024,
  );
  /**
   * A landscape phone: short *and* wider than it is tall. Short enough that
   * the roster and the CTA block stacked on top of each other, even both
   * compacted, still left the ship grid a sliver -- 129px in testing at
   * 812x375, less than one card's own height. Wide enough, though, that they
   * fit fine side by side in a single row instead of stacked in two. See the
   * `sideBySide` branch below.
   */
  const [sideBySide, setSideBySide] = useState(
    () => typeof window !== 'undefined' && window.innerHeight < 480 && window.innerWidth > window.innerHeight,
  );
  useEffect(() => {
    const probe = () => {
      setCompactRoster(window.innerHeight < 620 && window.innerWidth < 1024);
      setSideBySide(window.innerHeight < 480 && window.innerWidth > window.innerHeight);
    };
    probe();
    window.addEventListener('resize', probe);
    window.addEventListener('orientationchange', probe);
    return () => {
      window.removeEventListener('resize', probe);
      window.removeEventListener('orientationchange', probe);
    };
  }, []);

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
        <p className="text-sm text-white/60">Head back to the PlayBuddies lobby and try again.</p>
      </div>
    );
  }

  if (!ready || !uid) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-amber-300" />
        <p className="font-bold text-white/80">Coming alongside...</p>
      </div>
    );
  }

  const iAmReady = mine !== undefined && mine !== null;
  /** Berths the rules call for that nobody has walked into; bots take these. */
  const emptyBerths = Math.max(0, rules.players - people.length);
  /**
   * Nobody sails until everybody has chosen.
   *
   * The host used to be able to weigh anchor the moment its *own* ship was
   * picked, which left anyone still choosing to be dropped into a battle
   * sailing a hull the lobby had never recorded — their opponent saw a ship
   * they had not chosen, and the shop screen was still open over the top of it.
   */
  const everyonePicked = people.every((p) => p.skin !== undefined && p.skin !== null);
  const canStart = iAmReady && everyonePicked;
  const waitingFor = people.filter((p) => p.skin === undefined || p.skin === null).length;

  const header = (
    <div className="flex shrink-0 items-center justify-between gap-2">
      <div className="min-w-0">
        <h2 className="truncate text-lg font-black tracking-tight sm:text-2xl">Pick your ship</h2>
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-300/80">
          {formatSides(rules.players)} across open water
          {emptyBerths > 0 && ` · ${emptyBerths} ${emptyBerths === 1 ? 'helm' : 'helms'} to bots`}
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
          <button onClick={askHostToEndGame} aria-label="End game" className="panel rounded-2xl p-2.5" title="End the match for everyone">
            <LogOut className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );

  /**
   * WEIGH ANCHOR plus Rules/Offline, without its own wrapper -- the caller
   * decides whether that goes in its own full-width panel or shares a row
   * with the roster, so this is written once for both.
   */
  const ctaButtons = (
    <>
      {isHost ? (
        <button
          onClick={onStart}
          disabled={!canStart}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 py-2.5 text-sm font-black text-slate-900 disabled:opacity-40"
        >
          <Play className="h-4 w-4 fill-current" /> WEIGH ANCHOR
        </button>
      ) : (
        <p className="py-1 text-center text-xs font-bold text-white/60">
          {!iAmReady
            ? 'Pick a ship to be ready.'
            : !everyonePicked
              ? 'Waiting for everyone to pick...'
              : 'Waiting for the host...'}
        </p>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          onClick={onRules}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-white/20 bg-white/5 py-2 text-xs font-black text-white/70 transition-colors active:bg-white/15"
        >
          <ScrollText className="h-3.5 w-3.5" /> Rules
        </button>
        <button
          onClick={onPlayOffline}
          className="rounded-lg border border-white/20 bg-white/5 py-2 text-xs font-black text-white/70 transition-colors active:bg-white/15"
        >
          Play offline
        </button>
      </div>
    </>
  );

  /** Avatar-only chips in a horizontal strip. Used both by the compact roster panel and, on a landscape phone, next to the CTA. */
  const rosterChips = (
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto overscroll-contain">
      {people.map((p) => (
        <div
          key={p.uid}
          className="flex shrink-0 flex-col items-center gap-1 rounded-lg border px-2 py-1"
          style={{ borderColor: `${TEAM_COLORS[p.team].main}55`, background: `${TEAM_COLORS[p.team].main}18` }}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/25">
            {p.skin !== undefined && p.skin !== null ? (
              <Portrait index={p.skin} size={36} />
            ) : (
              <Anchor className="h-4 w-4 text-white/40" />
            )}
          </div>
          <div className="min-w-0 max-w-[64px]">
            <p className="flex items-center justify-center gap-1 truncate text-[9px] font-bold">
              {p.displayName}
              {p.uid === hostId && <Crown className="h-2.5 w-2.5 shrink-0 text-amber-300" />}
            </p>
          </div>
        </div>
      ))}
    </div>
  );

  const shipGridPanel = (extra: string) => (
    <div className={`panel min-h-0 overflow-y-auto overscroll-contain rounded-[2rem] p-3 sm:p-6 ${extra}`}>
      <ShipGrid owned={owned} coins={coins} selected={mine ?? null} pickedBy={pickedBy} onPick={onPick} />
    </div>
  );

  const desktopCta = (
    <div className="panel hidden shrink-0 rounded-[2rem] p-5 lg:block">
      {isHost ? (
        <>
          <button
            onClick={onStart}
            disabled={!canStart}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 py-4 text-lg font-black text-slate-900 disabled:opacity-40"
          >
            <Play className="h-5 w-5 fill-current" /> WEIGH ANCHOR
          </button>
          <p className="mt-2 text-center text-[11px] text-white/50">
            {!iAmReady
              ? 'Pick your own ship first.'
              : !everyonePicked
                ? `Waiting on ${waitingFor} more to pick a ship.`
                : emptyBerths > 0
                  ? `Bots will sail ${emptyBerths} of the ${rules.players} hulls.`
                  : 'Which side fires first is drawn at the start.'}
          </p>
        </>
      ) : (
        <p className="text-center text-sm font-bold text-white/60">
          {!iAmReady
            ? 'Pick a ship to be ready.'
            : !everyonePicked
              ? 'Waiting for everyone to pick...'
              : 'Waiting for the host...'}
        </p>
      )}
      <button
        onClick={onRules}
        className="mt-3 flex w-full flex-col items-center gap-1 rounded-2xl border border-white/20 bg-white/5 py-3 font-black text-white/60 transition-colors hover:bg-white/15"
      >
        <span className="flex items-center gap-2">
          <ScrollText className="h-4 w-4" /> {isHost ? 'Battle rules' : 'Battle rules (host sets these)'}
        </span>
        <span className="px-3 text-[10px] font-semibold leading-tight text-white/45">{rulesSummary(rules)}</span>
      </button>
      <button
        onClick={onPlayOffline}
        className="mt-3 w-full rounded-2xl border border-white/20 bg-white/5 py-3 font-black text-white/60 transition-colors hover:bg-white/15"
      >
        Play offline
      </button>
    </div>
  );

  // A landscape phone is wide enough to build a row but short on the one
  // thing that matters here -- see `sideBySide` above. CTA and roster share
  // a single slim row instead of stacking, and the ship grid gets everything
  // below it rather than splitting a second row with the roster again.
  if (sideBySide) {
    return (
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-2 p-2.5">
        {header}
        <div className="flex shrink-0 gap-2">
          <div className="panel min-w-0 flex-1 rounded-2xl p-2">{ctaButtons}</div>
          <div className="panel flex w-32 shrink-0 flex-col rounded-2xl p-1.5">
            <h3 className="mb-1 flex shrink-0 items-center gap-1 text-[8px] font-black uppercase tracking-wide text-white/50">
              <Users className="h-2.5 w-2.5" /> {people.length} up
            </h3>
            {rosterChips}
          </div>
        </div>
        {shipGridPanel('flex-1')}
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-2 p-2.5 sm:gap-4 sm:p-6">
      {header}

      {/* On a phone the start button would otherwise sit below the fold, which
          is exactly what made it unreachable in the other games. Kept to two
          short rows now rather than three stacked full-height buttons: that
          block plus the roster below it used to eat most of a phone's height
          before the ship grid -- the one thing this whole screen is for --
          ever got a pixel, leaving it a sliver you had to scroll through
          three cards at a time. */}
      <div className="panel shrink-0 rounded-2xl p-2.5 lg:hidden">{ctaButtons}</div>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-2 sm:gap-4 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
        {shipGridPanel('order-2 lg:order-1 lg:col-span-2')}

        <div className="order-1 flex min-h-0 flex-col gap-3 sm:gap-4 lg:order-2">
          {/* A horizontal strip of avatar chips when height is tight, the
              roomy vertical card list when it isn't. The roster only needs to
              say who's on the water and what side -- it does not need a
              quarter of a short screen to say it. See `compactRoster` above
              for why this branches on measured height rather than a width
              breakpoint. */}
          <div
            className={`panel flex min-h-0 shrink-0 flex-col lg:max-h-none lg:flex-1 lg:rounded-[2rem] lg:p-5 ${
              compactRoster ? 'max-h-[72px] rounded-2xl p-2' : 'max-h-44 rounded-[2rem] p-4 sm:p-5'
            }`}
          >
            <h3
              className={`mb-1 flex shrink-0 items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.18em] text-white/50 lg:mb-3 lg:gap-2 lg:text-[11px] lg:tracking-[0.2em] ${
                compactRoster ? '' : 'mb-3 gap-2 text-[11px] tracking-[0.2em]'
              }`}
            >
              <Users className={compactRoster ? 'h-3 w-3' : 'h-4 w-4'} /> On the water ({people.length})
            </h3>
            {compactRoster ? (
              rosterChips
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-0 space-y-2 overflow-x-hidden overflow-y-auto pr-1 lg:overflow-x-hidden lg:overflow-y-auto">
                {people.map((p) => (
                  <div
                    key={p.uid}
                    className="flex w-auto shrink-0 flex-row items-center gap-3 rounded-2xl border p-2.5"
                    style={{
                      borderColor: `${TEAM_COLORS[p.team].main}55`,
                      background: `${TEAM_COLORS[p.team].main}18`,
                    }}
                  >
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black/25">
                      {p.skin !== undefined && p.skin !== null ? (
                        <Portrait index={p.skin} size={42} />
                      ) : (
                        <Anchor className="h-5 w-5 text-white/40" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="flex items-center justify-start gap-1 truncate text-sm font-bold">
                        {p.displayName}
                        {p.uid === hostId && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
                      </p>
                      <p
                        className="text-[10px] font-black uppercase tracking-widest"
                        style={{ color: TEAM_COLORS[p.team].light }}
                      >
                        {TEAM_COLORS[p.team].name}
                        {p.uid === uid ? ' - you' : ''}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {desktopCta}
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
   * The aim guide, the turn clock and the mountain used to live here and no
   * longer do: they change how the battle plays, so both sides have to agree
   * on them. They are Battle Rules now, set by the host in the room. What is
   * left is genuinely local — how loud it is, and how hard this particular
   * machine is willing to work.
   */
  const toggles: { key: keyof GameSettings; label: string; hint: string }[] = [
    {
      key: 'lowPower',
      label: 'Low power mode',
      hint: 'Forces the cheap render path. The game already drops to it on its own when frames get long.',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
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
 * The rules of the battle, set once by the host and obeyed by everyone.
 *
 * Separate from Settings on purpose. Settings are this device's business —
 * volume, render cost — and nobody else is affected by them. These change what
 * the battle *is*, so both fleets have to be playing the same one: they travel
 * to the guest over the wire (see `packRules`) and its engine is built from
 * whatever arrives, not from anything stored locally.
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
  const toggles: { key: 'cards' | 'turnTimer' | 'aimArc'; label: string; hint: string }[] = [
    {
      key: 'cards',
      label: 'Cards',
      hint: 'Three dealt a turn: chain, grape, mortar, firebomb, bore, patch. Off means round shot every time, and the battle is pure gunnery.',
    },
    {
      key: 'turnTimer',
      label: 'Turn clock',
      hint: 'The shot goes off on its own after 15 seconds. Off lets a turn take as long as it takes.',
    },
    {
      key: 'aimArc',
      label: 'Aim arc',
      hint: 'Draws the opening stretch of the shot while aiming. It makes the game a great deal easier — line the dots up and let go. The aim arrow on the pad stays either way.',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="panel max-h-[88dvh] w-full max-w-md space-y-6 overflow-y-auto overscroll-contain rounded-[2rem] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xl font-black">Battle rules</h3>
            <p className="text-[11px] font-semibold text-white/45">
              {editable ? 'Applies to both fleets. Takes effect next battle.' : 'Set by the host.'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-white/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-bold">
            Ships on the water
            <span className="block text-[11px] font-normal text-white/50">
              Split evenly into two fleets. Anyone in the room beyond this watches — the two sides have to
              match. Empty berths are sailed by bots.
            </span>
          </p>
          <div className="grid grid-cols-3 gap-2">
            {([2, 4, 6] as PlayerCount[]).map((option) => (
              <button
                key={option}
                disabled={!editable}
                onClick={() => onChange({ ...rules, players: option })}
                className={`rounded-xl border px-2 py-2.5 text-xs font-black transition-colors disabled:opacity-50 ${
                  rules.players === option
                    ? 'border-amber-400 bg-amber-400/20 text-amber-200'
                    : 'border-white/15 bg-white/5 text-white/60 hover:bg-white/10'
                }`}
              >
                {formatSides(option)}
                <span className="block text-[10px] font-bold text-white/40">{option} ships</span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-white/40">
            {rules.players === 2
              ? 'The duel. One hull each, the whole sea between you.'
              : `The water widens to fit ${rules.players} hulls, and the guns reach further for it. The helm alternates sides every turn.`}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-bold">
            The mountain
            <span className="block text-[11px] font-normal text-white/50">
              Stone amidships, tall enough that no working elevation skims it. Going over it costs real powder;
              the only way through is a bore shot.
            </span>
          </p>
          <div className="grid grid-cols-3 gap-2">
            {(['off', 'breakable', 'solid'] as MountainRule[]).map((option) => (
              <button
                key={option}
                disabled={!editable}
                onClick={() => onChange({ ...rules, mountain: option })}
                className={`rounded-xl border px-2 py-2.5 text-xs font-black capitalize transition-colors disabled:opacity-50 ${
                  rules.mountain === option
                    ? 'border-amber-400 bg-amber-400/20 text-amber-200'
                    : 'border-white/15 bg-white/5 text-white/60 hover:bg-white/10'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-white/40">
            {rules.mountain === 'off'
              ? 'Open water. Every shot is a flat duel.'
              : rules.mountain === 'breakable'
                ? 'Crumbles after ten hits, so the lane opens up late in a long battle.'
                : 'Never crumbles. The lane over the top is the only lane there is.'}
          </p>
        </div>

        {toggles.map(({ key, label, hint }) => (
          <label key={key} className="flex items-center justify-between gap-3">
            <span className="text-sm font-bold">
              {label}
              <span className="block text-[11px] font-normal text-white/50">{hint}</span>
            </span>
            <input
              type="checkbox"
              disabled={!editable}
              checked={rules[key]}
              onChange={(e) => onChange({ ...rules, [key]: e.target.checked })}
              className="h-6 w-6 shrink-0 accent-amber-400 disabled:opacity-50"
            />
          </label>
        ))}
      </div>
    </div>
  );
}
