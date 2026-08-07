import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Maximize2, Minimize2, Settings, Wifi, WifiOff } from 'lucide-react';
import { GameEngine } from '../engine/GameEngine';
import Joystick from '../components/Joystick';
import { GameSettings, NetMessage, PlayerPacket } from '../types/game';
import { Mesh } from '../net/mesh';
import { audioService } from '../services/audio';
import { toggleFullscreen } from '../fullscreen';

/**
 * How often each client publishes itself, and how often the host publishes the
 * AI. Both go peer-to-peer, so the only real budget is a phone's uplink: at 8
 * players a 15Hz position broadcast is about 6 KB/s out, and the culled AI
 * snapshot the host sends is a few KB/s per peer. Neither number grows with the
 * number of *rooms*, which is the point of not routing this through Firestore.
 */
const PLAYER_HZ = 15;
const ENEMY_HZ = 6;

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
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const meshRef = useRef<Mesh | null>(null);

  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  const [scoreboard, setScoreboard] = useState<{ id: string; name: string; size: number; score: number; local: boolean }[]>([]);
  const [defeat, setDefeat] = useState<{ by: string; score: number } | null>(null);

  const online = Boolean(roomId && uid);
  const isHost = !online || hostId === uid;

  // Latest packet from each seat/peer, read by the broadcast timers.
  const localPackets = useRef(new Map<string, PlayerPacket>());
  const peerPositions = useRef(new Map<string, { x: number; y: number }>());
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

    if (online && roomId && uid) {
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
              if (from === live.current.hostId) e.applyEnemies(msg.d, msg.b);
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
    }

    const board = window.setInterval(() => {
      setScoreboard(engineRef.current?.leaderboard() ?? []);
    }, 500);

    return () => {
      clearTimeout(settle);
      window.clearInterval(playerTimer);
      window.clearInterval(enemyTimer);
      window.clearInterval(board);
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
    engineRef.current?.setSimulateAI(hostId === uid);
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
    const onChange = () => setIsFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const fullscreen = (on: boolean) => {
    if (rootRef.current) toggleFullscreen(rootRef.current, on);
    setIsFull(on);
    setTimeout(() => engineRef.current?.resize(), 200);
  };

  const respawn = () => {
    setDefeat(null);
    localIds.forEach((id) => engineRef.current?.respawn(id));
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

      {/* HUD */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between p-3 gap-3">
        <div className="rounded-2xl border border-black/10 bg-white/50 px-4 py-2 shadow-sm backdrop-blur-md">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Size</p>
          <p className="text-2xl font-black leading-none text-emerald-700">{Math.floor(me?.size ?? 0)}</p>
          <p className="text-[11px] font-bold text-slate-500">{me?.score ?? 0} pts</p>
        </div>

        {scoreboard.length > 1 && (
          <div className="hidden sm:block rounded-2xl border border-black/10 bg-white/50 px-3 py-2 shadow-sm backdrop-blur-md">
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
              className="rounded-xl border border-black/10 bg-white/50 p-2 text-slate-700 backdrop-blur-md"
              title={peerCount > 0 ? `${peerCount} peer(s) connected` : 'Connecting to players…'}
            >
              {peerCount > 0 ? <Wifi size={18} className="text-emerald-600" /> : <WifiOff size={18} className="text-amber-600" />}
            </div>
          )}
          <button
            onClick={onOpenSettings}
            className="rounded-xl border border-black/10 bg-white/50 p-2 text-slate-800 backdrop-blur-md transition-colors hover:bg-white/80"
            title="Settings"
          >
            <Settings size={18} />
          </button>
          <button
            onClick={() => fullscreen(!isFull)}
            className="rounded-xl border border-black/10 bg-white/50 p-2 text-slate-800 backdrop-blur-md transition-colors hover:bg-white/80"
            title={isFull ? 'Exit full screen' : 'Full screen'}
          >
            {isFull ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <button
            onClick={onExit}
            className="rounded-xl border border-black/10 bg-white/50 p-2 text-slate-800 backdrop-blur-md transition-colors hover:bg-white/80"
            title="Leave"
          >
            <ArrowLeft size={18} />
          </button>
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
