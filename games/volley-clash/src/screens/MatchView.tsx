/**
 * The court on screen: the render loop, the controls, and the wire.
 *
 * The engine knows nothing about React, the keyboard or WebRTC. This component
 * owns all three and hands the engine a plain `Map<id, Input>` every frame,
 * which is what keeps the simulation testable and the netcode swappable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trophy, Wifi, WifiOff } from 'lucide-react';
import TouchPad, { PadState } from '../components/TouchPad';
import { IN_IFRAME, toggleFullscreen } from '../fullscreen';
import ControlsTray from '@shared/controls/ControlsTray';
import { isStaleChunkError, recoverFromStaleChunk } from '@shared/net/staleChunk';
import { CHARACTERS } from '../game/characters';
import { BALANCE, POWER_META, TEAM_COLORS, arenaFor } from '../game/rules';
import { MatchEngine, Seat } from '../engine/MatchEngine';
import { QualityGovernor } from '../game/quality';
// Type-only: the runtime value comes from the dynamic import below, keeping the
// wire and the Firebase SDK it depends on out of the main bundle.
import type { Link, LinkStatus } from '../net/link';
import { audioService } from '../services/audio';
import {
  BodyMessage,
  GameSettings,
  Input,
  NO_INPUT,
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
 * How long a remote seat may go unheard before it is stood up, and before its
 * character is handed to a bot.
 *
 * A phone changing cell is a two-second hole in the wire and a perfectly normal
 * thing to play through, so the second number is generous — and the seat is
 * handed straight back the moment its owner speaks again.
 *
 * DROPPED_MS used to be 8 seconds, and it was wrong: it is measured from the
 * moment the match *engine* starts, which is before the wire has even begun
 * connecting. Entering an online match downloads this game's own Firebase
 * chunk for the first time that session — several hundred KB, on whatever
 * connection the player has — then opens a database socket, then attempts
 * WebRTC, then falls back to a relay if that fails. None of that is optional
 * and none of it is instant, and 8 seconds was not a fair trial for it: a
 * connection that would have come up fine in 10 or 12 seconds was declared
 * dead and handed to a bot before it had a real chance. This is what "the
 * bot controlled the other person" turned out to be — not a broken
 * connection, an impatient clock.
 */
const QUIET_MS = 1500;
const DROPPED_MS = 20000;

/**
 * Whether a packet is older than one already seen from the same sender.
 *
 * The channel is unordered, so this is needed at all. The second clause is what
 * makes it safe: a sender that reloads or remounts starts counting from one
 * again, and a plain `n <= last` test would then reject everything it ever sent
 * for the rest of the match. A big jump backwards is a new counter, not an old
 * packet.
 */
function isStale(last: number | undefined, n: number): boolean {
  if (last === undefined) return false;
  return n <= last && n > last - 60;
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
  const linkRef = useRef<Link | null>(null);

  const [score, setScore] = useState<[number, number]>([0, 0]);
  const [powers, setPowers] = useState<{ kind: string; team: Team; left: number }[]>([]);
  const [over, setOver] = useState<{ winner: Team } | null>(null);
  const [wire, setWire] = useState<{
    peers: number;
    relayed: number;
    rtt: number;
    jitter: number;
    stalled: boolean;
    reason: string | null;
  }>({
    peers: 0,
    relayed: 0,
    rtt: 0,
    jitter: 0,
    stalled: false,
    reason: null,
  });
  // The render loop reads this rather than `wire` directly — it is not in that
  // effect's dependency list, since putting it there would rebuild the engine
  // (and reset the score) on every connection status change.
  const wireRef = useRef(wire);
  wireRef.current = wire;
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
  /**
   * When each remote seat was last heard from, and the newest packet it sent.
   *
   * The channel is unordered — that is what keeps it from stalling to
   * retransmit a position that is already stale — so a packet that arrives out
   * of order has to be recognised and dropped rather than believed.
   */
  const heardAt = useRef(new Map<string, number>());
  const heardSeq = useRef(new Map<string, number>());
  /** The roster as of this render, for the connection to read when it opens. */
  const peopleRef = useRef(config.people);
  peopleRef.current = config.people;
  /** `performance.now()` of the last snapshot from the host. Guests only. */
  const lastSnapshotAt = useRef(performance.now());
  /** Whether a snapshot has ever arrived, which is a different thing entirely. */
  const heardHost = useRef(false);
  const stalledRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Power-up frequency is the one match rule that can be retuned mid-game: the
  // rest (target score, win-by-two) would change what the players are already
  // playing for, so those are read once when the engine is built.
  useEffect(() => {
    engineRef.current?.setPowerRate(settings.powerRate);
  }, [settings.powerRate]);

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
      winByTwo: settingsRef.current.winByTwo,
      powerUps: settingsRef.current.powerUps,
      powerRate: settingsRef.current.powerRate,
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

    const governor = new QualityGovernor(settingsRef.current.lowPower);
    let tier = governor.quality.tier;

    const fit = () => {
      const box = shellRef.current?.getBoundingClientRect();
      engine.resize(canvas, box?.width ?? window.innerWidth, box?.height ?? window.innerHeight, governor.quality);
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);

    let raf = 0;
    let last = performance.now();
    // Nobody has been heard from yet at kick-off, and a seat must not be handed
    // to a bot for that. The clock on every remote seat starts here.
    const mountedAt = last;
    lastSnapshotAt.current = last;
    let sinceSnapshot = 0;
    let sinceBody = 0;
    let seq = 0;
    let lastSent = -1;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;

      governor.sample(dt);
      const q = governor.quality;
      if (q.tier !== tier) {
        // A tier change moves the backing-store size, so the canvas has to be
        // resized for the downgrade to buy anything at all.
        tier = q.tier;
        fit();
      }
      engine.setBudget(q.particles);

      const inputs = new Map<string, Input>();
      config.localIds.forEach((id, i) => {
        inputs.set(id, readInputRef.current(i, config.localIds.length === 1));
      });
      // Remote seats keep their last known input until a newer packet lands.
      // Zeroing them between packets makes every other player stutter.
      //
      // Up to a point: a seat nobody has heard from in a second and a half is
      // not still holding the key down, it is gone, and simulating it sprinting
      // into the wall for the rest of the match is worse than standing it up.
      const quietAt = now - QUIET_MS;
      for (const [id, input] of remoteInputs.current) {
        if (inputs.has(id)) continue;
        inputs.set(id, (heardAt.current.get(id) ?? 0) > quietAt ? input : NO_INPUT);
      }
      // Host only. A guest hears about everyone else through the host's
      // snapshots, never directly, so silence from a peer says nothing at all
      // about whether that player is still there — and acting on it would hand
      // the host's own character to a bot while the match ran perfectly.
      if (online && engine.isHost) {
        for (const seat of seats) {
          if (seat.control !== 'remote') continue;
          const heard = heardAt.current.get(seat.id) ?? mountedAt;
          if (now - heard > DROPPED_MS) {
            // This used to happen silently. It is the single most confusing
            // thing that can occur in a match — a real player's seat starts
            // moving on its own — and it deserves a paper trail explaining why.
            console.warn(
              `[net] no contact from ${seat.name} (${seat.id}) for ${Math.round((now - heard) / 1000)}s` +
                ` — handing their seat to a bot. Link status at the time:`,
              wireRef.current,
            );
            engine.handOverToAI(seat.id);
            engine.forget(seat.id);
            remoteInputs.current.delete(seat.id);
          }
        }
      }

      engine.update(dt, inputs);
      engine.render(ctx, q);

      if (online && linkRef.current) {
        const link = linkRef.current;
        if (engine.isHost) {
          sinceSnapshot += dt;
          if (sinceSnapshot >= 1 / BALANCE.SNAPSHOT_HZ) {
            sinceSnapshot = 0;
            link.send(engine.snapshot(), true);
          }
        } else {
          sinceBody += dt;
          const mine = inputs.get(config.localIds[0]) ?? NO_INPUT;
          const bits = packInput(mine);
          // Sent on the frame the key changes, not on the next tick of a timer.
          // A fixed 30Hz send adds up to 33ms of pure waiting to every single
          // press, on top of the trip itself, and it is the kind of delay a
          // player feels without being able to name.
          if (bits !== lastSent || sinceBody >= 1 / BALANCE.BODY_HZ) {
            sinceBody = 0;
            lastSent = bits;
            const body = engine.bodyPacket(config.localIds[0]);
            if (body) {
              link.send(
                {
                  t: 'b',
                  d: body,
                  i: bits,
                  ts: link.stamp(),
                  n: ++seq,
                  k: engine.lastAppliedTick,
                } satisfies BodyMessage,
                true,
              );
            }
          }
        }

        // A host that has gone quiet is not a slow host. Nobody but the host
        // can score, serve or spawn, so a guest left waiting on one is watching
        // a frozen court — which is exactly what "multiplayer doesn't work"
        // looked like from the other side.
        if (!engine.isHost) {
          const quiet = (now - lastSnapshotAt.current) / 1000;
          // "Reconnecting" is only honest once there was a connection. Before
          // the first snapshot the badge already says we are still connecting.
          const stalled = heardHost.current && quiet > BALANCE.STALL_WARN;
          if (stalled !== stalledRef.current) {
            stalledRef.current = stalled;
            setWire((w) => ({ ...w, stalled }));
          }
          // Opening a data channel can legitimately take a couple of tries, so
          // a match that has not started yet is given twice as long as one that
          // was running a moment ago.
          const patience = heardHost.current ? BALANCE.STALL_PROMOTE : BALANCE.STALL_PROMOTE * 2;
          if (quiet > patience) {
            console.warn('[net] host silent for', quiet.toFixed(1), 's — running the match here');
            engine.promote();
            lastSnapshotAt.current = now;
            stalledRef.current = false;
            setWire((w) => ({ ...w, stalled: false }));
            // Anyone we cannot hear either gets a bot, so the match has an
            // opponent rather than a statue. The seat goes straight back to
            // them if they turn up again.
            for (const seat of seats) {
              if (seat.control === 'remote' && (heardAt.current.get(seat.id) ?? 0) < now - QUIET_MS) {
                engine.handOverToAI(seat.id);
              }
            }
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
    // `isHost` is deliberately not a dependency. The lobby can elect a new host
    // mid-match — the platform does exactly that when a host walks away — and
    // rebuilding the engine for it would throw away the score along with the
    // rally in progress. Authority is handed over in place instead; see below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seats, online]);

  /** Follows the lobby's choice of host without disturbing the match. */
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !online) return;
    // Only worth a line in the console when it actually changes something —
    // every match hits this once at mount as a no-op, confirming what the
    // engine was already built with.
    if (engine.isHost !== isHost) {
      console.warn(
        `[net] lobby reassigned the host — this machine is now ${isHost ? 'authoritative' : 'a guest'}`,
      );
    }
    if (isHost) engine.promote();
    else engine.demote();
  }, [isHost, online]);

  // ── the wire ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const roomId = config.roomId;
    const uid = config.uid;
    if (!online || !roomId || !uid) return;

    // The wire drags in the Firebase SDK for its signalling, so it is fetched
    // only now — on the online path — rather than by every solo player. See the
    // import comment in App.tsx.
    let disposed = false;
    let link: Link | null = null;
    let leave: ((e: PageTransitionEvent) => void) | undefined;
    let cancelLeave: (() => void) | undefined;
    let onVisible: (() => void) | undefined;

    void import('../net/link')
      .then(({ Link }) => {
        // The match can be left while this import is still in flight; without
        // this guard the connection would open with nothing left to close it.
        if (disposed) return;

        link = new Link(
          roomId,
          uid,
          (from, msg) => {
            const engine = engineRef.current;
            if (!engine) return;

            /**
             * How far this packet's contents have to be run forward to
             * describe the present.
             *
             * Measured from the sender's own stamp against the offset between
             * the two clocks, rather than assumed to be half a round trip.
             * The old assumption only held on a path costing the same in both
             * directions, which the Firestore relay very much is not — see
             * net/clock.ts.
             *
             * The jitter lead on top is the one part still a guess: the packet
             * after this one has not arrived, and on an unsteady link it is
             * late more often than early, so leaning a fraction of the
             * measured jitter forward lands closer than sitting still does.
             */
            const lagOf = (msg: { ts?: number }) => {
              if (!link) return 0;
              const t = link.timingTo(from);
              const lead = Math.min(
                (t.jitter / 1000) * BALANCE.JITTER_LEAD,
                BALANCE.MAX_JITTER_LEAD,
              );
              const age = link.ageOf(from, msg.ts ?? 0, BALANCE.MAX_EXTRAP);
              return Math.min(age + lead, BALANCE.MAX_EXTRAP);
            };

            switch (msg.t) {
              case 's':
                // A snapshot from the room's real host, while we are running
                // the match ourselves, means it came back. Stand down: two
                // machines scoring the same rally is worse than a pause was.
                if (engine.isHost && !isHost && from === config.hostId) {
                  console.warn('[net] host is back — handing the match back');
                  engine.demote();
                  // Their character was handed to a bot while they were gone.
                  engine.reclaim(from);
                }
                if (engine.isHost) break;
                lastSnapshotAt.current = performance.now();
                heardHost.current = true;
                if (stalledRef.current) {
                  stalledRef.current = false;
                  setWire((w) => ({ ...w, stalled: false }));
                }
                engine.applySnapshot(msg as Snapshot, lagOf(msg));
                break;
              case 'b':
                // A guest's own account of itself. The input rides along so the
                // host can keep simulating it between packets.
                if (isStale(heardSeq.current.get(from), msg.n)) break;
                heardSeq.current.set(from, msg.n);
                heardAt.current.set(from, performance.now());
                // Back from a dropout: their seat is theirs again.
                engine.reclaim(from);
                remoteInputs.current.set(from, unpackInput(msg.i));
                engine.applyBody(from, msg.d, msg.k, lagOf(msg));
                break;
              case 'i':
                heardAt.current.set(from, performance.now());
                remoteInputs.current.set(from, unpackInput(msg.d));
                break;
              case 'bye':
                remoteInputs.current.delete(msg.id);
                engine.forget(msg.id);
                engine.handOverToAI(msg.id);
                break;
            }
          },
          (status: LinkStatus) =>
            setWire((w) => ({
              ...w,
              peers: status.direct.length,
              relayed: status.relayed.length,
              rtt: Math.round(status.rtt),
              jitter: Math.round(status.jitter),
              reason: status.reason,
            })),
        );
        linkRef.current = link;
        link.setPeers(peopleRef.current.map((p) => p.uid));

        // `pagehide` fires on a phone screen locking or a tab switch, not
        // just a real close — a page with an open connection like this one is
        // not bfcache-eligible in most browsers, so there is no reliable
        // `persisted` flag to lean on here at all. Give the tab a chance to
        // come back (cancelled by `pageshow` or the tab going visible again)
        // before telling everyone else to hand this player over to AI.
        let leaveTimer: number | undefined;
        cancelLeave = () => {
          if (leaveTimer !== undefined) {
            window.clearTimeout(leaveTimer);
            leaveTimer = undefined;
          }
        };
        leave = (e) => {
          if (e.persisted) return;
          cancelLeave?.();
          leaveTimer = window.setTimeout(() => link?.send({ t: 'bye', id: uid }), 15000);
        };
        onVisible = () => {
          if (document.visibilityState === 'visible') cancelLeave?.();
        };
        window.addEventListener('pagehide', leave);
        window.addEventListener('pageshow', cancelLeave);
        document.addEventListener('visibilitychange', onVisible);
      })
      .catch((e) => {
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
        console.error('Could not open the connection', e);
      });

    return () => {
      disposed = true;
      cancelLeave?.();
      if (leave) {
        window.removeEventListener('pagehide', leave);
        if (cancelLeave) window.removeEventListener('pageshow', cancelLeave);
        if (onVisible) document.removeEventListener('visibilitychange', onVisible);
        link?.send({ t: 'bye', id: uid });
      }
      link?.close();
      linkRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, config.roomId, config.uid]);

  /**
   * Keeps the connection set in step with the room.
   *
   * This is the one that mattered most. The peer list used to be handed over
   * exactly once, in the callback of a dynamic import, and never again — so a
   * roster that changed by so much as a re-render after the match began left
   * the mesh connecting to nobody, with no error anywhere to say so. A player
   * who joined, left and came back, or simply arrived while the import was
   * still in flight, was invisible for the rest of the match.
   *
   * A player who vanishes from the lobby hands their character to a bot rather
   * than leaving it standing in the sand for the rest of the match.
   */
  useEffect(() => {
    if (!online) return;
    linkRef.current?.setPeers(config.people.map((p) => p.uid));

    const engine = engineRef.current;
    if (!engine) return;
    const present = new Set(config.people.map((p) => p.uid));
    for (const seat of seats) {
      if (seat.control === 'remote' && !present.has(seat.id)) {
        engine.forget(seat.id);
        engine.handOverToAI(seat.id);
      }
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
      <div className="absolute right-3 top-3 z-20 flex flex-col items-end gap-2">
        <ControlsTray
          shellRef={shellRef}
          online={online}
          isHost={isHost}
          onSettings={onOpenSettings}
          onExit={onExit}
          theme="dark"
          before={
            online && (
              <div
                className="flex items-center gap-1.5 rounded-2xl border border-white/20 bg-black/45 px-3 py-2 text-xs font-bold text-white backdrop-blur-md"
                title={
                  wire.peers + wire.relayed === 0
                    ? 'Connecting to the other players…'
                    : `${wire.peers} direct, ${wire.relayed} relayed · ${wire.rtt}ms round trip` +
                      // Jitter is the half of the picture a ping alone hides: a
                      // steady 120ms plays better than a 60ms that keeps moving,
                      // because the steady one can be predicted and the other
                      // cannot.
                      (wire.jitter > 0 ? ` ±${wire.jitter}ms` : '')
                }
              >
                {wire.peers + wire.relayed > 0 ? (
                  <Wifi className={`h-4 w-4 ${wire.relayed > 0 ? 'text-amber-300' : 'text-emerald-400'}`} />
                ) : (
                  <WifiOff className="h-4 w-4 text-rose-400" />
                )}
                {/* The number players actually want during a competitive match is
                    the round trip, not a peer count. It appears as soon as there is
                    one to show. */}
                {wire.rtt > 0 ? `${wire.rtt}ms` : isHost ? 'host' : 'guest'}
                {/* Named, not just coloured. "Amber means relayed" is knowledge
                    nobody has at the moment they need it, and the difference
                    between the two paths is the difference between a game that
                    feels instant and one that does not. */}
                {wire.relayed > 0 && <span className="text-amber-300">· relay</span>}
                {wire.stalled && <span className="text-amber-300">· reconnecting</span>}
              </div>
            )
          }
        />
        {online && wire.reason && (
          // The verdict, on screen, because the person wondering why the game
          // says relay is not the person with DevTools open.
          <div className="max-w-[220px] rounded-xl border border-amber-300/30 bg-black/55 px-2.5 py-1.5 text-right text-[10px] font-semibold leading-tight text-amber-200 backdrop-blur-md">
            {wire.reason}
          </div>
        )}
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
            //
            // Skipped when embedded: PlayBuddies drives fullscreen for the whole
            // frame, and a game that grabs it from underneath leaves the two
            // disagreeing about what is fullscreen and strands the host's bar
            // on top of the court.
            if (IN_IFRAME || document.fullscreenElement) return;
            toggleFullscreen(shellRef.current ?? document.documentElement, true);
          }}
        />
      )}

      {/* ── result ── */}
      {over && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
          <div className="max-h-[88dvh] w-full max-w-sm overflow-y-auto overscroll-contain space-y-5 rounded-[2rem] border border-white/20 bg-slate-900/90 p-8 text-center text-white">
            <Trophy
              className="mx-auto h-14 w-14"
              style={{ color: over.winner === myTeam ? '#fbbf24' : '#64748b' }}
            />
            <h2 className="text-3xl font-black">{over.winner === myTeam ? 'You win!' : 'You lost'}</h2>
            <p className="text-5xl font-black tabular-nums">
              <span style={{ color: TEAM_COLORS[0].light }}>{score[0]}</span>
              <span className="opacity-40"> / </span>
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
