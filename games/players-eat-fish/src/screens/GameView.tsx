import { useEffect, useRef, useState } from 'react';
import { Wifi, WifiOff } from 'lucide-react';
import { GameEngine, bodyRadius } from '../engine/GameEngine';
import Joystick from '../components/Joystick';
import { GameSettings, NetMessage, PlayerPacket } from '../types/game';
// Type-only: the runtime value is pulled in by the dynamic import below, so
// neither the mesh nor the Firebase SDK it depends on lands in the main bundle.
import type { Mesh } from '../net/mesh';
import { audioService } from '../services/audio';
import ControlsTray from '@shared/controls/ControlsTray';
import { isStaleChunkError, recoverFromStaleChunk } from '@shared/net/staleChunk';
import { createLogger } from '@shared/log/logger';
import { steadyInterval } from '@shared/net/steadyTimer';
import { ChatLayer } from '@shared/chat/ChatLayer';
import { useBubbleFeed } from '@shared/chat/useBubbleFeed';
import { SpeechBubble } from '@shared/ui/SpeechBubble';

const log = createLogger('players-eat-fish');

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
 * Peer-to-peer is not guaranteed, even with TURN. For any pair the mesh cannot
 * open, it relays everything through Realtime Database instead (see
 * net/mesh.ts) , positions, the host's reef, bites and chat , so a room that
 * falls back is still one ocean rather than each guest's own.
 */
/** No AI snapshot for this long means the host is unreachable , grow our own reef. */
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
  friendlyFish?: boolean;
  onOpenSettings: () => void;
  onExit: () => void;
  /** Called with the final score whenever a local player is eaten. */
  onRunEnded: (score: number) => void;
  /**
   * An offline run is over for this device, and whether it ended on top.
   *
   * Separate from onRunEnded, which fires once per fish: with three
   * players sharing a keyboard that is three deaths and would have been
   * counted as three games. A reef has no finish line, so topping the
   * board when the last local fish goes down is what counts as winning it.
   * Online death is only a life lost and never calls this callback.
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
  friendlyFish = false,
  onOpenSettings,
  onExit,
  onRunEnded,
  onMatchOver,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const meshRef = useRef<Mesh | null>(null);
  /** Keyed by fish id , the same uid/local-id string every other lookup here already uses. */
  const { bubbles, show: showBubble } = useBubbleFeed();

  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  /**
   * The worst link to anybody: every peer direct, some through the relay, or
   * somebody not reached yet. The last is the one worth the warning icon.
   */
  const [link, setLink] = useState<'direct' | 'relayed' | 'connecting' | 'alone'>('alone');
  const [scoreboard, setScoreboard] = useState<
    { id: string; name: string; size: number; score: number; bestSize: number; bestScore: number; local: boolean }[]
  >([]);
  const [defeat, setDefeat] = useState<{ by: string; score: number; best: number } | null>(null);

  const online = Boolean(roomId && uid);
  const isHost = !online || hostId === uid;

  // Latest packet from each seat/peer, read by the broadcast timers.
  const localPackets = useRef(new Map<string, PlayerPacket>());
  const peerPositions = useRef(new Map<string, { x: number; y: number }>());
  /** When the host's AI snapshot last landed, so we can notice it stopping. */
  const lastHostSnapshot = useRef(0);
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
      friendlyFish,
      simulateAI: !online || hostId === uid,
      onProgress: (p) => {
        setProgress(p);
        if (p >= 1) setTimeout(() => setReady(true), 250);
      },
      onEat: () => {},
      onRejoin: () => setDefeat(null),
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
        // not freeze the others , the screen only comes up once nobody is left.
        if (engineRef.current?.allLocalsDead()) {
          setDefeat({ by: killedBy, score: fish?.score ?? 0, best: fish?.bestScore ?? 0 });
          // Multiplayer is one continuous reef: death removes this fish until
          // its player moves again. It is not a match result or a new game.
          if (!online) onMatchOver(engineRef.current.leaderboard()[0]?.local === true);
        }

        if (!eaterId || !size) return;
        // Hand the growth to whoever ate us. A local seat can be credited
        // directly; a remote one is told, and takes our word for it , we are
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
    // The network runs on steady timers: an ordinary interval in a background
    // tab slows to once a second, which is a player freezing on everyone
    // else's screen, and a host freezing the whole reef.
    let stopPlayerTimer = () => {};
    let stopEnemyTimer = () => {};
    let stopSupervisor = () => {};
    /**
     * Set by the cleanup below. The whole networking half of this effect is
     * loaded asynchronously now (see the import comment in App.tsx , the
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
      const { Mesh } = await import('../net/mesh');
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
            case 'c':
              showBubble(from, msg.msg);
              break;
          }
        },
        (connected) => {
          log.info('mesh:peers', { connected: connected.length, of: live.current.people.length });
          setPeerCount(connected.length);
        },
      );
      meshRef.current = mesh;
      // Connect to everyone already in the room, now. This used to wait for
      // the roster effect below, which only runs when the roster *changes* ,
      // and a room whose players were all in before the match started never
      // changed again, so nobody ever connected to anybody.
      mesh.setPeers(live.current.people.map((p) => p.uid));

      stopPlayerTimer = steadyInterval(() => {
        const packet = localPackets.current.get(uid);
        if (packet) mesh?.broadcast({ t: 'p', d: packet, n: Date.now() } satisfies NetMessage, 'p');
      }, 1000 / PLAYER_HZ);

      stopEnemyTimer = steadyInterval(() => {
        const e = engineRef.current;
        if (!e || !live.current.isHost || !mesh) return;
        // Culled per recipient: a fish on the far side of the map is invisible
        // to that player and correcting it costs bandwidth for nothing. Every
        // peer, not just the directly connected ones , the mesh relays the
        // snapshot to anyone it has no channel to.
        for (const peer of mesh.peerIds) {
          const at = peerPositions.current.get(peer) ?? null;
          mesh.sendTo(peer, { t: 'e', d: e.enemyPacketsFor(at), b: e.bossPacket(), n: Date.now() } satisfies NetMessage, 'e');
        }
        const kills = e.takePendingKills();
        if (kills.length) mesh.broadcast({ t: 'k', ids: kills } satisfies NetMessage);
      }, 1000 / ENEMY_HZ);

      // ── the safety net ───────────────────────────────────────────────────
      stopSupervisor = steadyInterval(() => {
        const e = engineRef.current;
        if (!e || !mesh) return;
        // A guest that hears nothing from the host, not even through the
        // relay, grows its own reef rather than swimming in a void. It stands
        // down the instant the host's reef arrives again.
        if (!live.current.isHost) {
          const stale = Date.now() - lastHostSnapshot.current > HOST_TIMEOUT_MS;
          if (stale && !e.runningAI) e.setSimulateAI(true);
        }

        const states = Object.values(mesh.linkStates());
        const nextLink =
          states.length === 0 ? 'alone'
            : states.includes('connecting') ? 'connecting'
              : states.includes('relayed') ? 'relayed'
                : 'direct';
        // A room on the relay still plays, so nobody reports it -- but it is
        // exactly the kind of thing worth finding in a log afterwards.
        if (nextLink !== 'direct' && nextLink !== 'alone') {
          log.warn('mesh:' + nextLink, { links: mesh.linkStates() });
        }
        setLink(nextLink);
      }, 1000);
    };

    if (online && roomId && uid) {
      // Deliberately not awaited: the reef starts rendering immediately and the
      // networking attaches to it a moment later, rather than the whole match
      // waiting on a download.
      log.context({ room: roomId });
      log.info('match:start', { roomId, isHost, seats: localIds.length });
      void startNetworking(roomId, uid).catch((e) => {
        // A stale build, not a dead connection: this tab has been open since
        // before the deploy that just replaced the exact file it's asking for.
        // Reloading fetches the new `index.html`, which asks for the file that
        // actually exists -- so this fixes itself rather than leaving the
        // player on a screen whose only way out is a "Back" that fails the
        // same way.
        if (isStaleChunkError(e)) {
          recoverFromStaleChunk();
          return;
        }
        log.error('mesh:start-failed', { message: String(e?.message ?? e) });
        console.error('Could not start networking', e);
      });
    }

    const board = window.setInterval(() => {
      const rows = engineRef.current?.leaderboard() ?? [];
      setScoreboard(rows);
      log.state({
        rev: Math.max(0, ...rows.map((row) => row.score)),
        scores: rows.map((row) => [row.id, row.score, Math.round(row.size)]),
        host: live.current.hostId,
        runningAI: engineRef.current?.runningAI ?? false,
        transport: meshRef.current?.linkStates() ?? {},
        peers: meshRef.current?.connectedPeers.length ?? 0,
        local: localIds,
      });
    }, 500);

    return () => {
      disposed = true;
      clearTimeout(settle);
      stopPlayerTimer();
      stopEnemyTimer();
      stopSupervisor();
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
    // Only ever switched *on* here. Turning it off is the job of the host's
    // first snapshot arriving , otherwise every roster change would yank the
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

  /** Shown over the sender's own fish the instant it's typed , the round trip only needs to reach everyone else. */
  const sendChat = (text: string) => {
    const mine = localIds[0];
    if (mine !== undefined) showBubble(mine, text);
    meshRef.current?.broadcast({ t: 'c', msg: text, n: Date.now() } satisfies NetMessage);
  };

  const respawn = () => {
    setDefeat(null);
    localIds.forEach((id) => engineRef.current?.respawn(id));
    // This action only exists offline. A fresh solo attempt gets a fresh reef;
    // online players return with movement and preserve the shared population.
    engineRef.current?.resetReef();
  };

  const me = scoreboard.find((r) => r.local);

  return (
    <div ref={rootRef} className="relative w-full h-[100dvh] overflow-hidden bg-sky-950">
      <canvas
        ref={canvasRef}
        className={`block w-full h-full transition-opacity duration-500 ${ready ? 'opacity-100' : 'opacity-0'}`}
      />

      {/* ── chat bubbles, anchored over the speaker's own fish ── */}
      {Object.entries(bubbles).map(([id, text]) => {
        const engine = engineRef.current;
        const canvas = canvasRef.current;
        const fish = engine?.fishAt(id);
        if (!engine || !canvas || !fish) return null;
        const pos = engine.toClient(fish.x, fish.y - bodyRadius(fish.size) * 0.95 - 40, canvas.getBoundingClientRect());
        return <SpeechBubble key={id} text={text} style={{ left: pos.x, top: pos.y }} />;
      })}

      {/* Bottom-left, clear of the top HUD row's opaque Size/leaderboard cards
          and the top-right ControlsTray , the default top-left slot sits right
          under the Size card here. */}
      {ready && <ChatLayer onSend={sendChat} buttonClassName="absolute left-2 bottom-2 z-30" />}

      {ready && (!defeat || online) && (
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
          {/* The run's own score resets on every respawn; this is the one
              number on screen that doesn't -- your best this match, however
              many lives it took to get there. */}
          {(me?.bestScore ?? 0) > 0 && (
            <p className="text-[11px] font-bold text-amber-600">Best {me?.bestScore} pts</p>
          )}
        </div>

        {scoreboard.length > 1 && (
          <div className="hidden sm:block rounded-2xl border border-black/10 bg-white/80 px-3 py-2 shadow-sm">
            <p className="mb-1 text-[9px] font-black uppercase tracking-widest text-slate-400">Best this game</p>
            {scoreboard.slice(0, 5).map((row, i) => (
              <div
                key={row.id}
                className={`flex items-center gap-2 text-xs ${row.local ? 'font-black text-emerald-700' : 'font-bold text-slate-600'}`}
              >
                <span className="w-3 text-slate-400">{i + 1}</span>
                <span className="max-w-[8rem] truncate">{row.name}</span>
                {/* Current size stays visible in small type -- it's who's
                    dangerous right now, which the peak score next to it
                    doesn't tell you if they've since respawned tiny. */}
                <span className="text-[10px] font-normal text-slate-400 tabular-nums">{Math.floor(row.size)}</span>
                <span className="ml-auto tabular-nums">{row.bestScore}</span>
              </div>
            ))}
          </div>
        )}

        {/* The row above is pointer-events-none so taps fall through to the
            canvas/joystick underneath; the tray itself has to opt back in or
            none of its buttons -- fullscreen, settings, leave, end game --
            are reachable once a match is actually running. */}
        <div className="pointer-events-auto">
          <ControlsTray
            shellRef={rootRef}
            online={online}
            isHost={isHost}
            onSettings={onOpenSettings}
            onExit={onExit}
            theme="light"
            onFullscreenChange={() => engineRef.current?.resize()}
            before={
              online && (
                <div
                  className="rounded-xl border border-black/10 bg-white/80 p-2 text-slate-700"
                  title={
                    link === 'alone'
                      ? 'Nobody else in the room yet'
                      : link === 'direct'
                        ? `Direct connection to ${peerCount} player(s)`
                        : link === 'relayed'
                          ? 'In sync through the relay. A little slower than direct'
                          : 'Still connecting to someone'
                  }
                >
                  {link === 'connecting' ? (
                    <WifiOff size={18} className="text-rose-600" />
                  ) : (
                    <Wifi
                      size={18}
                      className={
                        link === 'direct' ? 'text-emerald-600' : link === 'relayed' ? 'text-amber-600' : 'text-slate-400'
                      }
                    />
                  )}
                </div>
              )
            }
          />
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

      {online && defeat && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-6">
          <div className="rounded-3xl border border-white/25 bg-sky-950/80 px-7 py-5 text-center text-white shadow-2xl backdrop-blur-md">
            <h2 className="text-3xl font-black tracking-tighter">EATEN</h2>
            <p className="mt-1 text-sm font-bold text-sky-100">{defeat.by} got you.</p>
            <p className="mt-3 text-xs font-black uppercase tracking-[0.18em] text-emerald-300">
              Move to dive back into this reef
            </p>
            <p className="mt-1 text-xs font-bold text-sky-200">Run score {defeat.score}</p>
          </div>
        </div>
      )}

      {!online && defeat && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-sky-950/70 p-6 backdrop-blur-sm">
          <div className="max-h-[88dvh] w-full max-w-sm overflow-y-auto overscroll-contain space-y-6 rounded-[2rem] border border-white/20 bg-white/90 p-8 text-center shadow-2xl">
            <div>
              <h2 className="text-4xl font-black tracking-tighter text-slate-900">EATEN</h2>
              <p className="mt-1 text-sm font-medium text-slate-500">{defeat.by} got you.</p>
            </div>
            <div className="rounded-2xl bg-slate-900/5 p-6">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Score</p>
              <p className="text-5xl font-black text-emerald-600">{defeat.score}</p>
              {defeat.best > defeat.score && (
                <p className="mt-1 text-xs font-bold text-amber-600">Best this game: {defeat.best}</p>
              )}
            </div>
            <div className="flex flex-col gap-3">
              <button
                onClick={respawn}
                className="w-full rounded-2xl bg-emerald-600 py-4 text-lg font-black text-white transition-transform active:scale-95"
              >
                TRY AGAIN
              </button>
              <button
                onClick={onExit}
                className="w-full rounded-2xl bg-slate-900/5 py-3 font-bold text-slate-700 transition-colors hover:bg-slate-900/10"
              >
                Back to match setup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
