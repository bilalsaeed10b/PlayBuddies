import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, LogOut, Maximize2, Minimize2, Settings, Wifi, WifiOff } from 'lucide-react';
import { GameEngine } from '../engine/GameEngine';
import Joystick from '../components/Joystick';
import { GameSettings, NetMessage, PlayerPacket } from '../types/game';
// Type-only: the runtime value is pulled in by the dynamic import below, so
// neither the mesh nor the Firebase SDK it depends on lands in the main bundle.
import type { Mesh } from '../net/mesh';
import { audioService } from '../services/audio';
import { askHostToEndGame, toggleFullscreen } from '../fullscreen';

/**
 * How often each client publishes itself, and how often the host publishes the
 * AI. Both go peer-to-peer, so the only real budget is a phone's uplink: at 8
 * players a 15Hz position broadcast is about 6 KB/s out, and the culled AI
 * snapshot the host sends is a few KB/s per peer. Neither number grows with the
 * number of *rooms*, which is the point of not routing this through Firestore.
 */
const PLAYER_HZ = 15;
const ENEMY_HZ = 6;

/**
 * Peer-to-peer is not guaranteed. Signalling can be blocked, and a symmetric
 * NAT or a corporate proxy will defeat STUN with no TURN server to fall back
 * on. When that happens the mesh simply never opens a channel, and the first
 * version of this screen had nothing else — so a guest sat in an empty ocean
 * with no other players, which is exactly what got reported.
 *
 * So there is a slow, billed path underneath: positions through Firestore for
 * any peer we cannot reach directly. 5Hz is deliberately stingy — it is enough
 * to see each other and be eaten, and it costs a fraction of what running the
 * whole game through Firestore would.
 */
const FALLBACK_HZ = 5;
/** No AI snapshot for this long means the host is unreachable — grow our own reef. */
const HOST_TIMEOUT_MS = 4000;

export interface LobbyPerson {
  uid: string;
  displayName: string;
  fishIndex?: number;
}

interface Props {
  roomId: string | null;
  uid: string | null;
  hostId: string | null;
  people: LobbyPerson[];
  /** Local seats: one online, or several sharing a keyboard offline. */
  localIds: string[];
  localFish: Record<string, number>;
  localNames: Record<string, string>;
  settings: GameSettings;
  onOpenSettings: () => void;
  onExit: () => void;
  /** Called with the final score whenever a local player is eaten. */
  onRunEnded: (score: number) => void;
  /**
   * The run is over for this device, and whether it ended on top.
   *
   * Separate from onRunEnded, which fires once per fish: with three
   * players sharing a keyboard that is three deaths and would have been
   * counted as three games. A reef has no finish line, so topping the
   * board when the last local fish goes down is what counts as winning it.
   */
  onMatchOver: (won: boolean) => void;
}

export default function GameView({
  roomId,
  uid,
  hostId,
  people,
  localIds,
  localFish,
  localNames,
  settings,
  onOpenSettings,
  onExit,
  onRunEnded,
  onMatchOver,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const meshRef = useRef<Mesh | null>(null);

  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  const [link, setLink] = useState<'direct' | 'relayed' | 'alone'>('alone');
  const [scoreboard, setScoreboard] = useState<{ id: string; name: string; size: number; score: number; local: boolean }[]>([]);
  const [defeat, setDefeat] = useState<{ by: string; score: number } | null>(null);

  const online = Boolean(roomId && uid);
  const isHost = !online || hostId === uid;

  // Latest packet from each seat/peer, read by the broadcast timers.
  const localPackets = useRef(new Map<string, PlayerPacket>());
  const peerPositions = useRef(new Map<string, { x: number; y: number }>());
  /** When the host's AI snapshot last landed, so we can notice it stopping. */
  const lastHostSnapshot = useRef(0);
  /** Firestore listeners for peers the mesh could not reach, keyed by uid. */
  const fallbackReaders = useRef(new Map<string, () => void>());
  // Props the engine and mesh callbacks read, held in a ref so that a changing
  // roster or a host migration never tears down a match in progress.
  const live = useRef({ people, hostId, uid, isHost });
  useEffect(() => {
    live.current = { people, hostId, uid, isHost };
  }, [people, hostId, uid, isHost]);

  useEffect(() => {
    engineRef.current?.updateSettings(settings);
  }, [settings]);

  // ── engine + networking. Deliberately keyed on the room and the seat list
  // only: rebuilding this because someone's score changed would restart the
  // match.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new GameEngine({
      canvas,
      localIds,
      localFish,
      localNames,
      settings,
      simulateAI: !online || hostId === uid,
      onProgress: (p) => {
        setProgress(p);
        if (p >= 1) setTimeout(() => setReady(true), 250);
      },
      onEat: () => {},
      onLocalState: (id, packet) => {
        localPackets.current.set(id, packet);
      },
      onEnemyEaten: (enemyId) => {
        // Guests ask the host to confirm; the host already removed it.
        const host = live.current.hostId;
        if (!live.current.isHost && host) meshRef.current?.sendTo(host, { t: 'x', id: enemyId } satisfies NetMessage);
      },
      onDeath: (id, killedBy, eaterId, size) => {
        const fish = engineRef.current?.localFish(id);
        onRunEnded(fish?.score ?? 0);
        // With two or three players sharing a keyboard, one being eaten must
        // not freeze the others — the screen only comes up once nobody is left.
        if (engineRef.current?.allLocalsDead()) {
          setDefeat({ by: killedBy, score: fish?.score ?? 0 });
          onMatchOver(engineRef.current.leaderboard()[0]?.local === true);
        }

        if (!eaterId || !size) return;
        // Hand the growth to whoever ate us. A local seat can be credited
        // directly; a remote one is told, and takes our word for it — we are
        // the only client that can be certain the bite landed.
        if (engineRef.current?.localFish(eaterId)) {
          engineRef.current.creditKill(eaterId, size);
        } else {
          meshRef.current?.sendTo(eaterId, { t: 'd', by: eaterId, size } satisfies NetMessage);
        }
      },
    });

    engineRef.current = engine;
    // Handle for poking at a running match from the console. `import.meta.env.DEV`
    // is a compile-time constant, so this whole branch is dropped from the
    // production bundle rather than shipping a global anyone can grab.
    if (import.meta.env.DEV) (window as unknown as { __fishEngine?: GameEngine }).__fishEngine = engine;
    engine.start();
    const resize = () => engine.resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    // The parent may still be laying out when we mount.
    const settle = setTimeout(resize, 120);

    let mesh: Mesh | null = null;
    let playerTimer = 0;
    let enemyTimer = 0;
    let supervisorTimer = 0;
    let fallbackTimer = 0;
    /**
     * Set by the cleanup below. The whole networking half of this effect is
     * loaded asynchronously now (see the import comment in App.tsx — the
     * Firebase SDK and the mesh that depends on it are only worth fetching for
     * an online match), so the component can perfectly well unmount while that
     * import is still in flight. Without this flag, a match the player has
     * already left would come up moments later with live timers and an open
     * peer connection that nothing holds a handle to any more.
     */
    let disposed = false;

    // roomId and uid arrive as parameters so they stay narrowed to `string`.
    // The `online && roomId && uid` check at the call site used to do that job
    // inline; splitting the body out into its own function loses the narrowing.
    const startNetworking = async (roomId: string, uid: string) => {
      const [{ Mesh }, { db, doc, setDoc, onSnapshot }] = await Promise.all([
        import('../net/mesh'),
        import('../firebase'),
      ]);
      if (disposed) return;

      mesh = new Mesh(
        roomId,
        uid,
        (from, raw) => {
          const msg = raw as NetMessage;
          const e = engineRef.current;
          if (!e || !msg || typeof msg !== 'object') return;

          switch (msg.t) {
            case 'p': {
              const person = live.current.people.find((p) => p.uid === from);
              e.setRemotePlayer(from, msg.d, person?.displayName ?? 'Player');
              peerPositions.current.set(from, { x: msg.d[0], y: msg.d[1] });
              break;
            }
            case 'e':
              // Only the host's word counts; anyone else claiming to run the AI
              // is ignored rather than allowed to rewrite the ocean.
              if (from !== live.current.hostId) break;
              lastHostSnapshot.current = Date.now();
              // We may have been running a stand-in reef while out of contact;
              // stand down before adopting theirs.
              if (e.runningAI && !live.current.isHost) e.setSimulateAI(false);
              e.applyEnemies(msg.d, msg.b);
              break;
            case 'k':
              if (from === live.current.hostId) e.removeEnemies(msg.ids);
              break;
            case 'x':
              if (live.current.isHost) e.removeEnemy(msg.id);
              break;
            case 'd': {
              // Someone reports we ate them.
              if (e.localFish(msg.by)) e.creditKill(msg.by, msg.size);
              break;
            }
          }
        },
        (connected) => setPeerCount(connected.length),
      );
      meshRef.current = mesh;

      playerTimer = window.setInterval(() => {
        const packet = localPackets.current.get(uid);
        if (packet) mesh?.broadcast({ t: 'p', d: packet, n: Date.now() } satisfies NetMessage);
      }, 1000 / PLAYER_HZ);

      enemyTimer = window.setInterval(() => {
        const e = engineRef.current;
        if (!e || !live.current.isHost || !mesh) return;
        // Culled per recipient: a fish on the far side of the map is invisible
        // to that player and correcting it costs bandwidth for nothing.
        for (const peer of mesh.connectedPeers) {
          const at = peerPositions.current.get(peer) ?? null;
          mesh.sendTo(peer, { t: 'e', d: e.enemyPacketsFor(at), b: e.bossPacket(), n: Date.now() } satisfies NetMessage);
        }
        const kills = e.takePendingKills();
        if (kills.length) mesh.broadcast({ t: 'k', ids: kills } satisfies NetMessage);
      }, 1000 / ENEMY_HZ);

      // ── the safety net ───────────────────────────────────────────────────
      // Once a second, work out who we actually reached and patch the gaps.
      supervisorTimer = window.setInterval(() => {
        const e = engineRef.current;
        if (!e || !mesh) return;
        const direct = new Set(mesh.connectedPeers);
        const others = live.current.people.filter((p) => p.uid !== uid);

        // Open a Firestore listener for anyone the mesh could not reach, and
        // close it the moment a direct channel comes up.
        for (const person of others) {
          const has = fallbackReaders.current.has(person.uid);
          if (direct.has(person.uid)) {
            if (has) {
              fallbackReaders.current.get(person.uid)!();
              fallbackReaders.current.delete(person.uid);
            }
            continue;
          }
          if (has) continue;
          const stop = onSnapshot(
            doc(db, 'lobbies', roomId, 'updates', person.uid),
            (snap) => {
              const data = snap.data() as { p?: PlayerPacket } | undefined;
              if (!data?.p) return;
              const who = live.current.people.find((x) => x.uid === person.uid);
              engineRef.current?.setRemotePlayer(person.uid, data.p, who?.displayName ?? 'Player');
              peerPositions.current.set(person.uid, { x: data.p[0], y: data.p[1] });
            },
            () => {
              /* permission denied means the rules aren't deployed; nothing to retry */
            },
          );
          fallbackReaders.current.set(person.uid, stop);
        }
        for (const [id, stop] of fallbackReaders.current) {
          if (!others.some((p) => p.uid === id)) {
            stop();
            fallbackReaders.current.delete(id);
          }
        }

        // A guest with no word from the host grows its own reef rather than
        // swimming in a void. Not the same ocean as everyone else's, but a
        // playable one — and it stands down the instant the host is heard from.
        if (!live.current.isHost) {
          const stale = Date.now() - lastHostSnapshot.current > HOST_TIMEOUT_MS;
          if (stale && !e.runningAI) e.setSimulateAI(true);
        }

        setLink(others.length === 0 ? 'alone' : fallbackReaders.current.size === 0 ? 'direct' : 'relayed');
      }, 1000);

      // Slow position publish for peers we have no channel to.
      fallbackTimer = window.setInterval(() => {
        if (fallbackReaders.current.size === 0) return;
        const packet = localPackets.current.get(uid);
        if (!packet) return;
        setDoc(doc(db, 'lobbies', roomId, 'updates', uid), { p: packet, n: Date.now() }).catch(() => {});
      }, 1000 / FALLBACK_HZ);
    };

    if (online && roomId && uid) {
      // Deliberately not awaited: the reef starts rendering immediately and the
      // networking attaches to it a moment later, rather than the whole match
      // waiting on a download.
      void startNetworking(roomId, uid).catch((e) => console.error('Could not start networking', e));
    }

    const board = window.setInterval(() => {
      setScoreboard(engineRef.current?.leaderboard() ?? []);
    }, 500);

    return () => {
      disposed = true;
      clearTimeout(settle);
      window.clearInterval(playerTimer);
      window.clearInterval(enemyTimer);
      window.clearInterval(supervisorTimer);
      window.clearInterval(fallbackTimer);
      window.clearInterval(board);
      fallbackReaders.current.forEach((stop) => stop());
      fallbackReaders.current.clear();
      window.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', resize);
      mesh?.close();
      meshRef.current = null;
      engine.stop();
      engineRef.current = null;
      audioService.stopBackgroundMusic();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, uid, online, localIds.join(',')]);

  // Keep the peer set in step with the lobby roster, and follow host migration.
  useEffect(() => {
    if (!online || !uid) return;
    meshRef.current?.setPeers(people.map((p) => p.uid));
    // Only ever switched *on* here. Turning it off is the job of the host's
    // first snapshot arriving — otherwise every roster change would yank the
    // reef out from under a guest that is running its own because it cannot
    // reach the host.
    if (hostId === uid) engineRef.current?.setSimulateAI(true);
    const present = new Set(people.map((p) => p.uid));
    for (const row of engineRef.current?.leaderboard() ?? []) {
      if (!row.local && !present.has(row.id)) engineRef.current?.removeRemotePlayer(row.id);
    }
  }, [people, hostId, uid, online]);

  useEffect(() => {
    if (ready && settings.bgmVolume > 0) audioService.playBackgroundMusic();
    else audioService.stopBackgroundMusic();
  }, [ready, settings.bgmVolume]);

  useEffect(() => {
    // The authoritative signal that the browser actually finished entering or
    // leaving real fullscreen — unlike our own 200ms guess below, this fires
    // exactly when the viewport has settled, orientation lock included.
    const onChange = () => {
      setIsFull(Boolean(document.fullscreenElement));
      engineRef.current?.resize();
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const fullscreen = (on: boolean) => {
    if (rootRef.current) toggleFullscreen(rootRef.current, on);
    setIsFull(on);
    // Covers the CSS-only fallback path (iOS, or a denied fullscreen request),
    // where 'fullscreenchange' above never fires at all.
    setTimeout(() => engineRef.current?.resize(), 200);
  };

  const respawn = () => {
    setDefeat(null);
    localIds.forEach((id) => engineRef.current?.respawn(id));
    // After the seats are back at starting size, so the reef is rebuilt around
    // the new reference rather than the one the last run ended on.
    engineRef.current?.resetReef();
  };

  const me = scoreboard.find((r) => r.local);

  return (
    <div ref={rootRef} className="relative w-full h-[100dvh] overflow-hidden bg-sky-950">
      <canvas
        ref={canvasRef}
        className={`block w-full h-full transition-opacity duration-500 ${ready ? 'opacity-100' : 'opacity-0'}`}
      />

      {ready && !defeat && (
        <Joystick
          onMove={(v) => engineRef.current?.setJoystick(v)}
          onEnd={() => engineRef.current?.setJoystick({ x: 0, y: 0 })}
        />
      )}

      {/* HUD. z-40 rather than the usual z-20 for a HUD row: the tray living in
          here (fullscreen, settings, leave, end game) has to stay reachable
          through the z-30 loading and defeat overlays below, not just once a
          run is actually underway. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-start justify-between p-3 gap-3">
        <div className="rounded-2xl border border-black/10 bg-white/80 px-4 py-2 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Size</p>
          <p className="text-2xl font-black leading-none text-emerald-700">{Math.floor(me?.size ?? 0)}</p>
          <p className="text-[11px] font-bold text-slate-500">{me?.score ?? 0} pts</p>
        </div>

        {scoreboard.length > 1 && (
          <div className="hidden sm:block rounded-2xl border border-black/10 bg-white/80 px-3 py-2 shadow-sm">
            {scoreboard.slice(0, 5).map((row, i) => (
              <div
                key={row.id}
                className={`flex items-center gap-2 text-xs ${row.local ? 'font-black text-emerald-700' : 'font-bold text-slate-600'}`}
              >
                <span className="w-3 text-slate-400">{i + 1}</span>
                <span className="max-w-[8rem] truncate">{row.name}</span>
                <span className="ml-auto tabular-nums">{Math.floor(row.size)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="pointer-events-auto flex items-center gap-2">
          {online && (
            <div
              className="rounded-xl border border-black/10 bg-white/80 p-2 text-slate-700"
              title={
                link === 'alone'
                  ? 'Nobody else in the room yet'
                  : link === 'direct'
                    ? `Direct connection to ${peerCount} player(s)`
                    : 'Direct connection failed. Using the slower fallback'
              }
            >
              {link === 'relayed' ? (
                <WifiOff size={18} className="text-amber-600" />
              ) : (
                <Wifi size={18} className={link === 'direct' ? 'text-emerald-600' : 'text-slate-400'} />
              )}
            </div>
          )}
          <button
            onClick={onOpenSettings}
            className="rounded-xl border border-black/10 bg-white/80 p-2 text-slate-800 transition-colors hover:bg-white"
            title="Settings"
          >
            <Settings size={18} />
          </button>
          <button
            onClick={() => fullscreen(!isFull)}
            className="rounded-xl border border-black/10 bg-white/80 p-2 text-slate-800 transition-colors hover:bg-white"
            title={isFull ? 'Exit full screen' : 'Full screen'}
          >
            {isFull ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <button
            onClick={onExit}
            className="rounded-xl border border-black/10 bg-white/80 p-2 text-slate-800 transition-colors hover:bg-white"
            title="Leave"
          >
            <ArrowLeft size={18} />
          </button>
          {(!online || isHost) && (
            <button
              onClick={askHostToEndGame}
              className="flex items-center gap-1.5 rounded-xl border border-black/10 bg-white/80 px-3 py-2 text-sm font-bold text-slate-800 transition-colors hover:bg-white"
              title="End the match for everyone"
            >
              <LogOut size={16} /> End Game
            </button>
          )}
        </div>
      </div>

      {!ready && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-sky-100">
          <p className="text-3xl font-black tracking-tighter text-slate-900">LOADING REEF</p>
          <div className="h-3 w-64 overflow-hidden rounded-full border border-black/10 bg-white p-0.5">
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-200"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      {defeat && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-sky-950/70 p-6 backdrop-blur-sm">
          <div className="w-full max-w-sm space-y-6 rounded-[2rem] border border-white/20 bg-white/90 p-8 text-center shadow-2xl">
            <div>
              <h2 className="text-4xl font-black tracking-tighter text-slate-900">EATEN</h2>
              <p className="mt-1 text-sm font-medium text-slate-500">{defeat.by} got you.</p>
            </div>
            <div className="rounded-2xl bg-slate-900/5 p-6">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Score</p>
              <p className="text-5xl font-black text-emerald-600">{defeat.score}</p>
            </div>
            <div className="flex flex-col gap-3">
              <button
                onClick={respawn}
                className="w-full rounded-2xl bg-emerald-600 py-4 text-lg font-black text-white transition-transform active:scale-95"
              >
                {online ? 'BACK IN THE WATER' : 'TRY AGAIN'}
              </button>
              <button
                onClick={onExit}
                className="w-full rounded-2xl bg-slate-900/5 py-3 font-bold text-slate-700 transition-colors hover:bg-slate-900/10"
              >
                {online ? 'Back to lobby' : 'Main menu'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
