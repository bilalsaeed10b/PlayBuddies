/**
 * The court on screen: the render loop, the controls, and the wire.
 *
 * The engine knows nothing about React, the keyboard or WebRTC. This component
 * owns all three and hands the engine a plain `Map<id, Input>` every frame,
 * which is what keeps the simulation testable and the netcode swappable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Maximize2, Settings as SettingsIcon, Trophy, Wifi, WifiOff } from 'lucide-react';
import TouchPad, { PadState } from '../components/TouchPad';
import { toggleFullscreen } from '../fullscreen';
import { CHARACTERS } from '../game/characters';
import { POWER_META, TEAM_COLORS, arenaFor } from '../game/rules';
import { MatchEngine, Seat } from '../engine/MatchEngine';
import { Mesh } from '../net/mesh';
import { audioService } from '../services/audio';
import {
  GameSettings,
  Input,
  NO_INPUT,
  NetMessage,
  Snapshot,
  Team,
  packInput,
  unpackInput,
} from '../types/game';

export interface Person {
  uid: string;
  displayName: string;
  character?: number | null;
  team?: Team;
}

export interface MatchConfig {
  /** null for offline play. */
  roomId: string | null;
  uid: string | null;
  hostId: string | null;
  people: Person[];
  /** Seats driven by this device. One online, one or two on a couch. */
  localIds: string[];
  localCharacter: Record<string, number>;
  localNames: Record<string, string>;
  localTeams: Record<string, Team>;
  /** Extra AI seats to fill the court. */
  bots: { id: string; team: Team; character: number; level: number; name: string }[];
}

/**
 * Two keyboard layouts, so two people can share a laptop without arguing.
 *
 * There is no space bar binding any more. It used to hold a charge meter, which
 * is gone — and on a shared keyboard the space bar was the one key both players
 * reached for anyway.
 */
const KEYSETS = [
  { left: ['KeyA'], right: ['KeyD'], jump: ['KeyW'], dash: ['ShiftLeft'] },
  { left: ['ArrowLeft'], right: ['ArrowRight'], jump: ['ArrowUp'], dash: ['ShiftRight', 'Slash'] },
];

export default function MatchView({
  config,
  settings,
  onOpenSettings,
  onExit,
  onResult,
}: {
  config: MatchConfig;
  settings: GameSettings;
  onOpenSettings: () => void;
  onExit: () => void;
  onResult: (won: boolean, score: [number, number]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MatchEngine | null>(null);
  const meshRef = useRef<Mesh | null>(null);

  const [score, setScore] = useState<[number, number]>([0, 0]);
  const [powers, setPowers] = useState<{ kind: string; team: Team; left: number }[]>([]);
  const [over, setOver] = useState<{ winner: Team } | null>(null);
  const [peers, setPeers] = useState(0);
  const [touch, setTouch] = useState(false);

  const online = Boolean(config.roomId && config.uid);
  const isHost = !online || config.uid === config.hostId;

  // ── seats ────────────────────────────────────────────────────────────────
  //
  // Built once. Re-deriving them mid-match would rebuild the engine and reset
  // the score, which is exactly what a player leaving used to do.
  const seats = useMemo<Seat[]>(() => {
    const out: Seat[] = [];
    for (const id of config.localIds) {
      out.push({
        id,
        name: config.localNames[id] ?? 'You',
        team: config.localTeams[id] ?? 0,
        character: config.localCharacter[id] ?? 0,
        control: 'local',
      });
    }
    for (const person of config.people) {
      if (config.localIds.includes(person.uid)) continue;
      out.push({
        id: person.uid,
        name: person.displayName,
        team: person.team ?? 1,
        character: person.character ?? 0,
        control: 'remote',
      });
    }
    for (const bot of config.bots) {
      out.push({
        id: bot.id,
        name: bot.name,
        team: bot.team,
        character: bot.character,
        control: 'ai',
        aiLevel: bot.level,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live input state, outside React — this is read 120 times a second and has
  // no business causing a re-render.
  const held = useRef<Record<string, boolean>>({});
  /** Written by the touch pad, read by the render loop. Never causes a render. */
  const padRef = useRef<PadState>({ left: false, right: false, jump: false });
  const remoteInputs = useRef(new Map<string, Input>());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      held.current[e.code] = true;
      // Space and the arrows scroll the page otherwise, which on a phone in
      // landscape means the court walks off the top of the screen.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      held.current[e.code] = false;
    };
    const blur = () => {
      held.current = {};
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useEffect(() => {
    const probe = () => setTouch(window.matchMedia('(pointer: coarse)').matches);
    probe();
    window.addEventListener('resize', probe);
    return () => window.removeEventListener('resize', probe);
  }, []);

  const powersRef = useRef(0);
  const scoreRef = useRef<[number, number]>([0, 0]);

  const readInput = useCallback((seatIndex: number, isOnlySeat: boolean): Input => {
    const set = KEYSETS[(seatIndex + settingsRef.current.controlScheme) % KEYSETS.length];
    const on = (codes: string[]) => codes.some((c) => held.current[c]);

    const keyboard: Input = {
      left: on(set.left),
      right: on(set.right),
      jump: on(set.jump),
      dash: on(set.dash),
    };

    // Touch only ever drives the first seat — nobody plays couch co-op on one
    // phone, and letting the pad drive seat two makes it feel broken.
    if (!isOnlySeat || !touch) return keyboard;

    // No dash on touch, deliberately. Two zones is the whole scheme; a third
    // gesture to learn is what the old jump-or-charge-depending-on-how-long-you
    // -held-it button was, and nobody worked it out.
    const pad = padRef.current;
    return {
      left: keyboard.left || pad.left,
      right: keyboard.right || pad.right,
      jump: keyboard.jump || pad.jump,
      dash: keyboard.dash,
    };
  }, [touch]);

  // The render loop must not be rebuilt when `touch` flips — rebuilding it
  // rebuilds the engine, and rebuilding the engine resets the score mid-match.
  const readInputRef = useRef(readInput);
  readInputRef.current = readInput;

  // ── the engine ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const engine = new MatchEngine({
      arena: arenaFor(seats.length),
      seats,
      targetPoints: settingsRef.current.targetPoints,
      powerUps: settingsRef.current.powerUps,
      isHost,
      onPoint: (_team, sc) => setScore(sc),
      onOver: (winner) => {
        setOver({ winner });
        const mine = config.localTeams[config.localIds[0]] ?? 0;
        onResult(winner === mine, engine.score);
        audioService.playWin(winner === mine);
      },
      onHit: (power) => audioService.playHit(power),
      onWhistle: () => audioService.playWhistle(),
    });
    engineRef.current = engine;
    // Dev-only handle. Court state is otherwise unreachable from the console,
    // and "who is actually on the court" is the first question worth asking
    // when a seat does not show up.
    if (import.meta.env.DEV) (window as unknown as { __engine?: MatchEngine }).__engine = engine;

    const fit = () => {
      const box = shellRef.current?.getBoundingClientRect();
      engine.resize(canvas, box?.width ?? window.innerWidth, box?.height ?? window.innerHeight);
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);

    let raf = 0;
    let last = performance.now();
    let sinceSnapshot = 0;
    let sinceInput = 0;
    let seq = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;

      const inputs = new Map<string, Input>();
      config.localIds.forEach((id, i) => {
        inputs.set(id, readInputRef.current(i, config.localIds.length === 1));
      });
      // Remote seats keep their last known input until a newer packet lands.
      // Zeroing them between packets makes every other player stutter.
      for (const [id, input] of remoteInputs.current) if (!inputs.has(id)) inputs.set(id, input);

      engine.update(dt, inputs);
      engine.render(ctx);

      if (online && meshRef.current) {
        if (isHost) {
          sinceSnapshot += dt;
          if (sinceSnapshot >= 1 / 20) {
            sinceSnapshot = 0;
            meshRef.current.broadcast(engine.snapshot());
          }
        } else {
          sinceInput += dt;
          if (sinceInput >= 1 / 30) {
            sinceInput = 0;
            const mine = inputs.get(config.localIds[0]) ?? NO_INPUT;
            meshRef.current.broadcast({ t: 'i', d: packInput(mine), n: ++seq });
          }
        }
      }

      // The HUD only needs to know about things that changed, and only at a
      // rate a human can read.
      if (engine.powers.length !== powersRef.current) {
        powersRef.current = engine.powers.length;
        setPowers(engine.powers.map((p) => ({ kind: p.kind, team: p.team, left: p.left })));
      }
      if (engine.score[0] !== scoreRef.current[0] || engine.score[1] !== scoreRef.current[1]) {
        scoreRef.current = [...engine.score] as [number, number];
        setScore(scoreRef.current);
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
      window.removeEventListener('orientationchange', fit);
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seats, isHost, online]);

  // ── the wire ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const roomId = config.roomId;
    const uid = config.uid;
    if (!online || !roomId || !uid) return;

    const mesh = new Mesh(
      roomId,
      uid,
      (from, raw) => {
        const msg = raw as NetMessage;
        const engine = engineRef.current;
        if (!engine) return;

        if (msg.t === 's' && !isHost) {
          engine.applySnapshot(msg as Snapshot);
        } else if (msg.t === 'i' && isHost) {
          remoteInputs.current.set(from, unpackInput(msg.d));
        } else if (msg.t === 'bye') {
          remoteInputs.current.delete(msg.id);
          engine.handOverToAI(msg.id);
        }
      },
      (connected) => setPeers(connected.length),
    );
    meshRef.current = mesh;
    mesh.setPeers(config.people.map((p) => p.uid));

    const leave = () => mesh.broadcast({ t: 'bye', id: uid });
    window.addEventListener('pagehide', leave);

    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
      mesh.close();
      meshRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, config.roomId, config.uid, isHost]);

  // A player who vanishes from the lobby hands their character to a bot rather
  // than leaving it standing in the sand for the rest of the match.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !online) return;
    const present = new Set(config.people.map((p) => p.uid));
    for (const seat of seats) {
      if (seat.control === 'remote' && !present.has(seat.id)) engine.handOverToAI(seat.id);
    }
  }, [config.people, seats, online]);

  const myTeam = config.localTeams[config.localIds[0]] ?? 0;

  return (
    <div ref={shellRef} className="relative h-[100dvh] w-full overflow-hidden bg-[#06182a]">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />

      {/* ── scoreboard ── */}
      <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-stretch gap-1 rounded-2xl border border-white/20 bg-black/45 p-1 backdrop-blur-md">
        {([0, 1] as Team[]).map((team) => (
          <div
            key={team}
            className="flex min-w-[92px] flex-col items-center rounded-xl px-4 py-1.5"
            style={{ background: team === myTeam ? `${TEAM_COLORS[team].main}33` : 'transparent' }}
          >
            <span
              className="text-[10px] font-black uppercase tracking-[0.18em]"
              style={{ color: TEAM_COLORS[team].light }}
            >
              {TEAM_COLORS[team].name}
              {team === myTeam ? ' · you' : ''}
            </span>
            <span className="text-3xl font-black leading-none text-white tabular-nums">{score[team]}</span>
          </div>
        ))}
      </div>

      {/* ── power-ups ── */}
      {powers.length > 0 && (
        <div className="pointer-events-none absolute left-1/2 top-24 z-20 flex -translate-x-1/2 gap-2">
          {powers.map((p) => (
            <div
              key={p.kind}
              className="flex items-center gap-1.5 rounded-full border border-white/25 bg-black/55 px-3 py-1 text-xs font-bold text-white backdrop-blur-md"
            >
              <span>{POWER_META[p.kind].glyph}</span>
              <span>{POWER_META[p.kind].label}</span>
              <span className="opacity-60">
                {p.team === myTeam ? 'us' : 'them'}
                {Number.isFinite(p.left) ? ` · ${Math.ceil(p.left)}s` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── top-right controls ── */}
      <div className="absolute right-3 top-3 z-20 flex gap-2">
        {online && (
          <div
            className="flex items-center gap-1.5 rounded-2xl border border-white/20 bg-black/45 px-3 py-2 text-xs font-bold text-white backdrop-blur-md"
            title={peers > 0 ? `${peers} peer(s) connected` : 'Connecting to the other players…'}
          >
            {peers > 0 ? <Wifi className="h-4 w-4 text-emerald-400" /> : <WifiOff className="h-4 w-4 text-amber-400" />}
            {isHost ? 'host' : 'guest'}
          </div>
        )}
        <button
          onClick={() => toggleFullscreen(shellRef.current ?? document.documentElement, !document.fullscreenElement)}
          className="rounded-2xl border border-white/20 bg-black/45 p-2.5 text-white backdrop-blur-md"
          title="Full screen"
        >
          <Maximize2 className="h-5 w-5" />
        </button>
        <button
          onClick={onOpenSettings}
          className="rounded-2xl border border-white/20 bg-black/45 p-2.5 text-white backdrop-blur-md"
        >
          <SettingsIcon className="h-5 w-5" />
        </button>
        <button
          onClick={onExit}
          className="rounded-2xl border border-white/20 bg-black/45 p-2.5 text-white backdrop-blur-md"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      </div>

      {/* ── touch controls ── */}
      {touch && !over && (
        <TouchPad
          state={padRef}
          hintKey={0}
          onFirstTouch={() => {
            // The Fullscreen API only grants a request that is handling a real
            // user gesture, and the first touch of the match is one. Once only,
            // so quitting fullscreen on purpose is respected.
            if (document.fullscreenElement) return;
            toggleFullscreen(shellRef.current ?? document.documentElement, true);
          }}
        />
      )}

      {/* ── result ── */}
      {over && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
          <div className="w-full max-w-sm space-y-5 rounded-[2rem] border border-white/20 bg-slate-900/90 p-8 text-center text-white">
            <Trophy
              className="mx-auto h-14 w-14"
              style={{ color: over.winner === myTeam ? '#fbbf24' : '#64748b' }}
            />
            <h2 className="text-3xl font-black">{over.winner === myTeam ? 'You win!' : 'You lost'}</h2>
            <p className="text-5xl font-black tabular-nums">
              <span style={{ color: TEAM_COLORS[0].light }}>{score[0]}</span>
              <span className="opacity-40"> — </span>
              <span style={{ color: TEAM_COLORS[1].light }}>{score[1]}</span>
            </p>
            <button
              onClick={onExit}
              className="w-full rounded-2xl bg-amber-500 py-4 text-lg font-black text-slate-900 transition-transform active:scale-95"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {/* ── control hint ── */}
      {!touch && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-xl border border-white/15 bg-black/40 px-4 py-1.5 text-[11px] font-semibold text-white/70 backdrop-blur-md">
          {config.localIds
            .map((id, i) => {
              const set = (i + settings.controlScheme) % 2;
              const keys = set === 0 ? 'A / D move · W jump · Shift dash' : '← → move · ↑ jump · / dash';
              return `${config.localNames[id] ?? `P${i + 1}`}: ${keys}`;
            })
            .join('   |   ')}
          {'   ·   '}
          {CHARACTERS[config.localCharacter[config.localIds[0]] ?? 0].name}
        </div>
      )}
    </div>
  );
}
