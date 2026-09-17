/**
 * The siege on screen: one battlefield shared by every defender.
 *
 * The component owns the canvas, the render loop and the wire. The engines own
 * the fight and know about none of the three, which is what keeps the
 * simulation testable off a browser entirely.
 *
 * Spectating (R4) falls out of the architecture rather than being built: all
 * four keeps are already running, so stepping to another one is a change of
 * which engine `render` reads. Nothing extra is simulated and nothing extra is
 * fetched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Coins, Gauge, Heart, Loader2, Play, Swords, Trophy, X } from 'lucide-react';
import ControlsTray from '@shared/controls/ControlsTray';
import { createLogger } from '@shared/log/logger';
import { isStaleChunkError, recoverFromStaleChunk } from '@shared/net/staleChunk';
import { ChatLayer } from '@shared/chat/ChatLayer';
import { useBubbleFeed } from '@shared/chat/useBubbleFeed';
import { SpeechBubble } from '@shared/ui/SpeechBubble';
import { SiegeEngine } from '../engine/SiegeEngine';
import type { BuildOrder } from '../engine/SiegeEngine';
import { decide } from '../engine/ai';
import {
  BALANCE,
  ENEMIES,
  SEATS,
  TILE,
  TOWERS,
  TOWER_ORDER,
  buildWaves,
  clamp,
  packRules,
  unpackRules,
} from '../game/rules';
import type { MatchRules, TowerId } from '../game/rules';
import { COLS, ROWS, WORLD_H, WORLD_W, isBuildable } from '../game/map';
import { drawKeep, drawTowerHead, enemySprite, towerBase } from '../game/art';
import { bakeGround, drawPlots, rounded, shade } from '../game/ground';
import { audioService } from '../services/audio';
import type { GameSettings, NetPacket } from '../types/game';
// Type only: the runtime value arrives through the dynamic import below, which
// is what keeps the Firebase SDK out of an offline player's bundle.
import type { TurnLink } from '../net/turnLink';

const log = createLogger('tower-siege');

export interface Seat {
  id: string;
  name: string;
  control: 'local' | 'remote' | 'bot';
}

export interface MatchConfig {
  /** null for offline play. */
  roomId: string | null;
  uid: string | null;
  peerUids: string[];
  isHost: boolean;
  /** Players sharing this battlefield, in the same stable order on every client. */
  seats: Seat[];
  /** Which economy and tower colour this device owns. */
  mine: number;
  aiLevel: number;
  seed: number;
  rules: MatchRules;
}

interface Session {
  seed: number;
  rules: MatchRules;
}

const BANNER_MS = 2000;

/** Fast-forward steps. 1x is implicit, everything to its right cycles in. */
const SPEEDS = [1, 2, 3, 5, 10] as const;

export default function MatchView({
  config,
  settings,
  coins,
  onOpenSettings,
  onExit,
  onResult,
}: {
  config: MatchConfig;
  settings: GameSettings;
  coins: number;
  onOpenSettings: () => void;
  onExit: () => void;
  onResult: (won: boolean, wave: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const linkRef = useRef<TurnLink | null>(null);
  /** Keyed by seat index rather than uid , a couch seat has no uid at all. */
  const { bubbles, show: showBubble } = useBubbleFeed();

  const online = Boolean(config.roomId && config.uid && config.peerUids.length > 0);
  const rulesBits = packRules(config.rules);

  const [session, setSession] = useState<Session | null>(
    online && !config.isHost ? null : { seed: config.seed, rules: config.rules },
  );

  const [selected, setSelected] = useState<TowerId>('arrow');
  const [picked, setPicked] = useState<number | null>(null);
  const [banner, setBanner] = useState<{ id: number; text: string; tone: 'good' | 'bad' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [over, setOver] = useState<{ won: boolean; standing: number[] } | null>(null);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);

  // HUD mirrors. Written from the frame loop only when the number a human is
  // reading has actually changed, so a quiet frame costs no React work at all.
  // Annotated, because BALANCE is `as const` and the inferred shape would
  // otherwise pin `lives` to the literal 20 and `gold` to 260.
  const [hud, setHud] = useState<{ lives: number; gold: number; wave: number; phase: string; timer: number }>({
    lives: BALANCE.LIVES,
    gold: BALANCE.START_GOLD,
    wave: 0,
    phase: 'build',
    timer: 0,
  });
  const [scores, setScores] = useState<number[]>(() => config.seats.map(() => 0));

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const bannerTimer = useRef<number | null>(null);
  const bannerId = useRef(0);
  const queued = useRef<{ packet: NetPacket; from: string }[]>([]);

  const peerKey = config.peerUids.join(',');
  const seatIdKey = config.seats.map((s) => s.id).join(',');
  const { aiLevel, mine } = config;

  /** Which keep each remote player holds, so a packet lands on the right one. */
  const seatOfUid = useMemo(() => {
    const map = new Map<string, number>();
    config.seats.forEach((s, i) => map.set(s.id, i));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatIdKey]);

  /**
   * The one shared keep.
   *
   * Rebuilt only when the *match* changes , a new seed or new rules. Listing
   * anything the lobby can touch here would reset a siege in progress the
   * moment somebody's name changed.
   */
  const enginesRef = useRef<SiegeEngine[]>([]);

  const shout = useCallback((text: string, tone: 'good' | 'bad') => {
    if (!settingsRef.current.shouts) return;
    bannerId.current += 1;
    setBanner({ id: bannerId.current, text, tone });
    if (bannerTimer.current !== null) window.clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => setBanner(null), BANNER_MS);
  }, []);

  const broadcastSnapshot = useCallback((engine: SiegeEngine, seed: number) => {
    if (!config.isHost) return;
    const snap = engine.sharedSnapshot();
    linkRef.current?.send({
      t: 'state', n: Date.now(), s: seed, w: engine.wave,
      lives: snap.lives, golds: snap.golds, down: engine.phase === 'fallen' ? 1 : 0,
      towers: snap.towers, kills: snap.kills, snap: 1, phase: engine.phase, r: rulesBits,
    });
  }, [config.isHost, rulesBits]);

  // -- the wire ---------------------------------------------------------------

  const handlePacket = useCallback(
    (packet: NetPacket, from: string) => {
      if (packet.t === 'start') {
        setSession((cur) => (cur && cur.seed === packet.seed ? cur : { seed: packet.seed, rules: unpackRules(packet.r) }));
        return;
      }
      // The host's start document is replaced by later actions. A player who
      // reconnects can therefore recover the session from any host snapshot.
      if (packet.t === 'state' && typeof packet.r === 'number') {
        setSession((cur) => cur ?? { seed: packet.s, rules: unpackRules(packet.r) });
      }
      if (packet.t === 'wave' && typeof packet.r === 'number') {
        setSession((cur) => cur ?? { seed: packet.s, rules: unpackRules(packet.r) });
      }
      const engines = enginesRef.current;
      if (engines.length === 0) {
        queued.current.push({ packet, from });
        return;
      }
      const seat = seatOfUid.get(from);

      if (packet.t === 'chat') {
        if (seat !== undefined) showBubble(String(seat), packet.msg);
        return;
      }
      if (packet.t === 'bye') {
        if (seat === undefined) return;
        if (config.seats[seat]?.control === 'remote') {
          config.seats[seat].control = 'bot';
          setNotice(`${config.seats[seat]?.name} dropped. A bot took over their machines.`);
        }
        return;
      }
      if (packet.t === 'hello') {
        if (seat === undefined) return;
        if (config.seats[seat]?.control === 'bot') {
          config.seats[seat].control = 'remote';
          setNotice(`${config.seats[seat]?.name} is back.`);
        }
        return;
      }
      if (packet.t === 'build') {
        if (seat === undefined) return;
        // Every peer applies the same charged action to the same shared board.
        // The sender does not receive its own packet, so each economy is charged once.
        const shared = engines[0];
        shared?.apply({ plot: packet.p, kind: packet.k, level: packet.lv, owner: packet.o ?? seat }, true);
        if (shared && config.isHost) broadcastSnapshot(shared, packet.s);
        return;
      }
      if (packet.t === 'wave') {
        const shared = engines[0];
        if (!shared) return;
        if (packet.towers && packet.kills && packet.golds && typeof packet.lives === 'number') {
          shared.syncShared(packet.lives, packet.golds, packet.towers, packet.kills);
        }
        if (packet.w > shared.wave) shared.reconcile(packet.w - 1, shared.lives, shared.golds, false);
        if (packet.w === shared.wave) shared.startWaveNow();
        return;
      }
      if (packet.t === 'send') return; // Legacy packets from separate-keep builds.
      if (packet.t === 'state') {
        if (seat === undefined) return;
        const shared = engines[0];
        if (packet.towers && packet.kills) {
          shared?.syncShared(packet.lives, packet.golds, packet.towers, packet.kills);
        }
        if (packet.snap === 1) {
          if (shared && packet.down === 1) shared.reconcile(packet.w, packet.lives, packet.golds, true);
          if (shared && packet.w > shared.wave) shared.reconcile(packet.w - 1, packet.lives, packet.golds, false);
          if (shared && packet.phase === 'wave' && shared.phase === 'build') shared.startWaveNow();
          return;
        }
        shared?.reconcile(packet.w, packet.lives, packet.golds, packet.down === 1);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seatOfUid, mine, shout, broadcastSnapshot, config.isHost, showBubble],
  );

  /** Shown over the sender's own machines the instant it's typed , the round trip only needs to reach everyone else. */
  const sendChat = useCallback(
    (text: string) => {
      showBubble(String(mine), text);
      linkRef.current?.send({ t: 'chat', n: Date.now(), msg: text });
    },
    [mine, showBubble],
  );

  useEffect(() => {
    if (!online || !config.roomId || !config.uid || config.peerUids.length === 0) return;

    let disposed = false;
    let link: TurnLink | null = null;
    let leave: ((e: PageTransitionEvent) => void) | undefined;
    let cancelLeave: (() => void) | undefined;
    let onVisible: (() => void) | undefined;

    void import('../net/turnLink')
      .then(({ TurnLink: Link }) => {
        if (disposed) return;
        link = new Link(
          config.roomId as string,
          config.uid as string,
          config.peerUids,
          handlePacket,
          (message) => setNotice(message),
          config.isHost ? { r: rulesBits } : undefined,
        );
        linkRef.current = link;
        // The host already knows the match; a guest overwrites this the moment
        // the start packet lands. Either way a `bye` from this link names the
        // match it belongs to, so the next one can ignore it.
        link.setSeed(config.seed);

        if (config.isHost) {
          link.send({ t: 'start', n: Date.now(), seed: config.seed, r: rulesBits });
        } else {
          // Tells the others this link is open, whether that is the first time
          // or a reconnect after a real `bye`. See HelloPacket.
          link.send({ t: 'hello', n: Date.now() });
        }

        // `pagehide` fires with `persisted: false` on plenty of things that
        // are not a real close -- a phone screen locking, a tab switch, a page
        // holding an open Firestore listener not being bfcache-eligible. Give
        // it a chance to come back before handing the keep to a bot.
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
          leaveTimer = window.setTimeout(() => link?.close(), 15000);
        };
        onVisible = () => {
          if (document.visibilityState === 'visible') cancelLeave?.();
        };
        window.addEventListener('pagehide', leave);
        window.addEventListener('pageshow', cancelLeave);
        document.addEventListener('visibilitychange', onVisible);
      })
      .catch((err) => {
        // A stale build, not a dead connection: this tab has been open since
        // before the deploy that just replaced the exact file it's asking for.
        // Reloading fetches the new `index.html`, which asks for the file that
        // actually exists -- so this fixes itself rather than leaving the
        // player on a screen whose only way out is a "Back" that fails the
        // same way.
        if (isStaleChunkError(err)) {
          recoverFromStaleChunk();
          return;
        }
        console.error('Could not open the wire', err);
        setNotice('Could not reach the other players. Your own keep still stands.');
      });

    return () => {
      disposed = true;
      cancelLeave?.();
      if (leave) window.removeEventListener('pagehide', leave);
      if (cancelLeave) window.removeEventListener('pageshow', cancelLeave);
      if (onVisible) document.removeEventListener('visibilitychange', onVisible);
      link?.close(true);
      linkRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, config.roomId, config.uid, peerKey, config.isHost, config.seed, rulesBits, handlePacket]);

  // -- the engines ------------------------------------------------------------

  useEffect(() => {
    if (!session) return;

    const waves = buildWaves(
      session.seed,
      session.rules.waves,
      session.rules.players,
      true,
    );

    const engines = [
      new SiegeEngine({
        waves,
        seed: session.seed,
        lives: BALANCE.LIVES,
        golds: config.seats.map(() => BALANCE.START_GOLD),
        playerCount: config.seats.length,
        onSfx: (kind) => playSfx(kind),
        onWaveEnd: (wave, lives, golds, down) => {
          if (config.isHost) {
            const shared = enginesRef.current[0];
            const snap = shared?.sharedSnapshot();
            linkRef.current?.send({
              t: 'state', n: Date.now(), s: session.seed, w: wave, lives, golds, down: down ? 1 : 0,
              towers: snap?.towers, kills: snap?.kills, r: rulesBits,
            });
          }
          if (!down) shout(`Wave ${wave + 1} cleared`, 'good');
        }
      })
    ];
    enginesRef.current = engines;

    for (const { packet, from } of queued.current) handlePacket(packet, from);
    queued.current = [];

    if (import.meta.env.DEV) {
      (window as unknown as { __siege?: SiegeEngine[] }).__siege = engines;
    }

    return () => {
      enginesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.seed, session?.rules.mode, session?.rules.waves, session?.rules.players]);

  function playSfx(kind: 'build' | 'sell' | 'shoot' | 'boom' | 'leak' | 'clear' | 'fall') {
    if (kind === 'shoot') audioService.shoot();
    else if (kind === 'boom') audioService.boom();
    else if (kind === 'build') audioService.build();
    else if (kind === 'sell') audioService.sell();
    else if (kind === 'leak') audioService.leak();
    else if (kind === 'clear') audioService.clear();
    else audioService.fall();
  }

  // -- actions ----------------------------------------------------------------

  /** Build, upgrade or sell, and tell everyone what actually happened. */
  const order = useCallback(
    (o: BuildOrder) => {
      const engine = enginesRef.current[0];
      if (!engine) return;
      const done = engine.apply({ ...o, owner: mine });
      if (!done) return;
      audioService.unlock();
      if (config.isHost) broadcastSnapshot(engine, session?.seed ?? 0);
      else linkRef.current?.send({
        t: 'build', n: Date.now(), s: session?.seed ?? 0, p: done.plot, k: done.kind, lv: done.level, o: mine,
      });
      setPicked(null);
    },
    [mine, session?.seed, config.isHost, broadcastSnapshot],
  );

  const startNow = useCallback(() => {
    const engine = enginesRef.current[0];
    if (!engine || (online && !config.isHost)) return;
    const snap = engine.sharedSnapshot();
    engine.startWaveNow();
    linkRef.current?.send({
      t: 'wave', n: Date.now(), s: session?.seed ?? 0, w: engine.wave, r: rulesBits,
      lives: snap.lives, golds: snap.golds, towers: snap.towers, kills: snap.kills,
    });
    audioService.unlock();
  }, [session?.seed, online, config.isHost, rulesBits]);

  // -- the loop ---------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let bgTimer: number | null = null;
    let last = performance.now();
    let clock = 0;
    let accumulator = 0;
    let dpr = 1;
    let scale = 1;
    let offX = 0;
    let offY = 0;
    /** Build orders the bots have queued this phase, one per call to `decide`. */
    const botNth = new Map<number, number>();
    const shown = { lives: -1, gold: -1, wave: -1, phase: '', timer: -1, boardKey: '' };

    const fit = () => {
      const box = boardRef.current?.getBoundingClientRect();
      const cssW = box?.width ?? window.innerWidth;
      const cssH = box?.height ?? window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      // Letterboxed, so the whole map is on screen at every aspect ratio. A
      // tower defence you have to scroll is a tower defence you lose to
      // something you could not see.
      scale = Math.min(canvas.width / WORLD_W, canvas.height / WORLD_H);
      offX = (canvas.width - WORLD_W * scale) / 2;
      offY = (canvas.height - WORLD_H * scale) / 2;
      viewRef.current = { scale, offX, offY, dpr };
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (boardRef.current) observer.observe(boardRef.current);

    /**
     * One simulation step: up to `dtCap` seconds of real time, ticked once
     * per point of the speed multiplier so a fast-forwarded match still moves
     * in small, accurate steps rather than one huge one. Shared by the
     * visible loop and the backgrounded one below , the caller decides how
     * tightly to cap a stutter versus how much wall clock to catch up on.
     */
    const step = (now: number, dtCap: number) => {
      const dt = Math.min(dtCap, Math.max(0, (now - last) / 1000));
      last = now;
      const mul = speedRef.current;
      clock += dt * mul;

      const engines = enginesRef.current;
      if (engines.length === 0) return null;

      // Fixed simulation ticks make tower targeting and kills independent of
      // each device's frame rate. A 30fps phone and a 144Hz host now resolve
      // the same wave instead of slowly producing different battlefields.
      const fixed = 1 / 60;
      accumulator += dt * mul;
      let ticks = Math.min(300, Math.floor(accumulator / fixed));
      accumulator -= ticks * fixed;
      while (ticks-- > 0) for (const e of engines) e.update(fixed);

      // Every bot owns a private purse and places its own machines on this map.
      const shared = engines[0];
      for (let seat = 0; seat < config.seats.length; seat++) {
        if (config.seats[seat]?.control !== 'bot' || shared.phase !== 'build') {
          if (shared.phase !== 'build') botNth.delete(seat);
          continue;
        }
        const nth = botNth.get(seat) ?? 0;
        // Paced off the build clock: roughly one purchase a second, which
        // reads as a keep being fortified rather than one appearing whole.
        const due = Math.floor((BALANCE.BUILD_TIME - shared.timer) / 1.1);
        if (nth >= due) continue;
        if (online && !config.isHost) continue;
        const want = decide(shared, aiLevel, nth, seat);
        botNth.set(seat, nth + 1);
        if (want) {
          const done = shared.apply({ ...want, owner: seat });
          if (done && online && config.isHost) broadcastSnapshot(shared, session.seed);
        }
      }

      return engines;
    };

    /** HUD mirrors, only touched when something a human can read has changed. */
    const publish = (engines: SiegeEngine[]) => {
      const own = engines[0];
      if (own) {
        const t = Math.ceil(own.phase === 'build' ? own.timer : own.timer);
        if (
          own.lives !== shown.lives || Math.floor(own.golds[mine]) !== shown.gold ||
          own.wave !== shown.wave || own.phase !== shown.phase || t !== shown.timer
        ) {
          shown.lives = own.lives;
          shown.gold = Math.floor(own.golds[mine]);
          shown.wave = own.wave;
          shown.phase = own.phase;
          shown.timer = t;
          setHud({ lives: own.lives, gold: Math.floor(own.golds[mine]), wave: own.wave, phase: own.phase, timer: t });
        }
      }

      const boardKey = `${own?.lives}:${own?.wave}:${own?.phase}:${own?.killsByPlayer.join(',')}`;
      if (boardKey !== shown.boardKey && own) {
        shown.boardKey = boardKey;
        setScores(own.killsByPlayer.slice());
      }
      log.state({
        seed: session?.seed,
        rev: own?.wave ?? 0,
        phases: [own?.phase],
        wave: [own?.wave],
        lives: [own?.lives],
        board: boardKey,
        local: mine,
      });
    };

    /** Set every time `frame` actually runs, so the watchdog below can tell rAF is alive. */
    let lastFrameStamp = performance.now();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      lastFrameStamp = now;
      const engines = step(now, 0.05);
      if (!engines) return;
      render(ctx, engines[0], clock);
      publish(engines);
    };

    /**
     * requestAnimationFrame stalls in a background tab -- throttled hard, or
     * simply never called again -- and it does it without any obligation to
     * fire `visibilitychange` first. Watching the clock instead of that event
     * catches every way a browser can go quiet: a hidden tab, a minimised
     * window, a phone screen locking. `step` measures real elapsed time
     * itself, so the towers land on schedule whether this ran sixty times a
     * second or once every half.
     */
    const watchdog = () => {
      const now = performance.now();
      if (now - lastFrameStamp < 400) return;
      const engines = step(now, 2);
      if (engines) publish(engines);
    };
    bgTimer = window.setInterval(watchdog, 500);

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      if (bgTimer !== null) window.clearInterval(bgTimer);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.seed, aiLevel, mine]);

  /** Read inside the loop so changing it does not tear the loop down. */
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const viewRef = useRef({ scale: 1, offX: 0, offY: 0, dpr: 1 });

  /**
   * World point to a viewport pixel point.
   *
   * Camera math lives in this file rather than in `SiegeEngine`, which owns no
   * canvas or rendering code of its own , see the file's own header comment.
   * Mirrors `render`'s own `ctx.setTransform(scale, 0, 0, scale, offX, offY)`.
   */
  const toClient = useCallback((wx: number, wy: number, rect: DOMRect): { x: number; y: number } => {
    const { scale, offX, offY, dpr } = viewRef.current;
    return { x: rect.left + (offX + wx * scale) / dpr, y: rect.top + (offY + wy * scale) / dpr };
  }, []);

  /**
   * Where this seat's chat bubble should point.
   *
   * There is no per-player avatar on this shared board , only towers, each
   * with an `owner`. Their most recently built machine is the closest thing
   * to "where they are"; before they've built anything at all, a fixed spot
   * along the top of the field, one per seat, gives the bubble somewhere to
   * point during the build phase.
   */
  const chatAnchor = useCallback(
    (seat: number): { x: number; y: number } => {
      const towers = enginesRef.current[0]?.towers ?? [];
      for (let i = towers.length - 1; i >= 0; i--) {
        if (towers[i].owner === seat) return { x: towers[i].x, y: towers[i].y - 46 };
      }
      return { x: ((seat + 1) / (config.seats.length + 1)) * WORLD_W, y: 34 };
    },
    [config.seats.length],
  );

  // -- rendering --------------------------------------------------------------

  const render = useCallback((ctx: CanvasRenderingContext2D, engine: SiegeEngine, clock: number) => {
    const { canvas } = ctx;
    const { scale, offX, offY } = viewRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const surround = ctx.createLinearGradient(0, 0, 0, canvas.height);
    surround.addColorStop(0, '#5ec8ff');
    surround.addColorStop(0.17, '#b6ecff');
    surround.addColorStop(0.175, '#8ce46a');
    surround.addColorStop(1, '#4eb95a');
    ctx.fillStyle = surround;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, offX, offY);

    // A drawn edge around the board, the same dark green everything else on it
    // is outlined in. Without it the map dissolves into the surround at exactly
    // the point a player is trying to judge whether a plot is on the map.
    ctx.strokeStyle = 'rgba(37, 74, 44, 0.55)';
    ctx.lineWidth = 6;
    ctx.strokeRect(-3, -3, WORLD_W + 6, WORLD_H + 6);

    const ground = bakeGround();
    if (ground) ctx.drawImage(ground, 0, 0);

    // The plots only while a tower is actually being placed. Baked into the
    // ground they were a cage over every inch of the map; see ground.ts.
    const placing = pickedRef.current !== null && !engine.towerAt(pickedRef.current);
    if (placing) {
      drawPlots(ctx, new Set(engine.towers.map((t) => t.plot)));
    }

    // Range rings under everything, so a tower never hides its own reach.
    const showAll = settingsRef.current.showRanges;
    const sel = pickedRef.current;
    for (const t of engine.towers) {
      if (!showAll && t.plot !== sel) continue;
      const lv = TOWERS[t.kind].levels[t.level];
      ctx.fillStyle = `${TOWERS[t.kind].trim}1a`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, lv.range, 0, Math.PI * 2);
      ctx.fill();
      // Dashed and slowly turning, so a reach ring never gets mistaken for
      // something painted on the ground.
      ctx.strokeStyle = `${TOWERS[t.kind].trim}aa`;
      ctx.lineWidth = 3;
      ctx.setLineDash([12, 9]);
      ctx.lineDashOffset = -clock * 18;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }

    // The plot under the thumb, while a tower is picked up.
    if (sel !== null && !engine.towerAt(sel)) {
      const col = sel % COLS;
      const row = Math.floor(sel / COLS);
      const kind = selectedRef.current;
      const ok = engine.costOf(sel, kind) >= 0 && engine.golds[mine] >= engine.costOf(sel, kind);
      // Breathing, so the plot under the thumb is obviously the live one even
      // on a board with a wave crossing it.
      const pulse = 0.5 + Math.sin(clock * 5) * 0.5;
      rounded(ctx, col * TILE + 5, row * TILE + 5, TILE - 10, TILE - 10, 10);
      ctx.fillStyle = ok ? `rgba(126, 255, 170, ${0.16 + pulse * 0.14})` : 'rgba(255, 96, 96, 0.24)';
      ctx.fill();
      ctx.strokeStyle = ok ? '#6cf5a3' : '#ff6b6b';
      ctx.lineWidth = 4;
      ctx.stroke();
      const lv = TOWERS[kind].levels[0];
      ctx.fillStyle = `${TOWERS[kind].trim}18`;
      ctx.beginPath();
      ctx.arc(col * TILE + TILE / 2, row * TILE + TILE / 2, lv.range, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `${TOWERS[kind].trim}aa`;
      ctx.lineWidth = 3;
      ctx.setLineDash([12, 9]);
      ctx.lineDashOffset = -clock * 18;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }

    drawKeep(ctx, engine.lives, BALANCE.LIVES, clock);

    // Towers: baked base, live head.
    for (const t of engine.towers) {
      const ownerColor = SEATS[t.owner % SEATS.length];
      ctx.fillStyle = `${ownerColor.main}38`;
      ctx.strokeStyle = ownerColor.light;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(t.x, t.y + 19, 28, 11, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const base = towerBase(t.kind, t.level);
      if (base) ctx.drawImage(base, t.x - base.width / 2, t.y - base.height / 2);
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(t.face);
      drawTowerHead(ctx, t.kind, t.level, t.fired, clock);
      ctx.restore();
      ctx.fillStyle = ownerColor.main;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(t.x + 21, t.y - 21, 8.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (t.plot === sel) {
        rounded(ctx, (t.plot % COLS) * TILE + 5, Math.floor(t.plot / COLS) * TILE + 5, TILE - 10, TILE - 10, 10);
        ctx.strokeStyle = '#ffd93d';
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    }

    // Enemies, back to front so the ones nearer the keep overlap correctly.
    for (const e of engine.enemies) {
      const meta = ENEMIES[e.kind];
      const sprite = enemySprite(e.kind);
      const bob = Math.sin(clock * 9 + e.phase) * (meta.flying ? 3.2 : 1.4);
      ctx.save();
      ctx.translate(e.x, e.y + bob);

      if (e.chill > 0) {
        // Frost reads as a rimed shell with spikes on it, not as a blue haze.
        // The haze was invisible against a bright board.
        ctx.beginPath();
        ctx.arc(0, 0, meta.size * 1.3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(160, 232, 255, 0.45)';
        ctx.fill();
        ctx.strokeStyle = '#9fe8ff';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = '#e8fbff';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + clock * 0.6;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * meta.size * 1.1, Math.sin(a) * meta.size * 1.1);
          ctx.lineTo(Math.cos(a) * meta.size * 1.55, Math.sin(a) * meta.size * 1.55);
          ctx.stroke();
        }
      }
      if (sprite) {
        ctx.save();
        ctx.rotate(meta.flying ? 0 : e.face);
        ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
        ctx.restore();
      }
      if (e.flash > 0.02) {
        ctx.globalAlpha = Math.min(0.8, e.flash);
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(0, 0, meta.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Health bar, only once it has actually been hurt , a full bar over
      // every walker turns the board into a bar chart.
      if (e.hp < e.maxHp) {
        const w = meta.size * 2.2;
        const h = 7;
        const top = -meta.size - 13;
        const frac = clamp(e.hp / e.maxHp, 0, 1);
        rounded(ctx, -w / 2, top, w, h, h / 2);
        ctx.fillStyle = 'rgba(24, 34, 28, 0.75)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(16, 24, 20, 0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
        if (frac > 0.02) {
          rounded(ctx, -w / 2 + 1.5, top + 1.5, (w - 3) * frac, h - 3, (h - 3) / 2);
          ctx.fillStyle = frac > 0.5 ? '#5cf08a' : frac > 0.22 ? '#ffd93d' : '#ff6b6b';
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Shots.
    for (const s of engine.shots) {
      const meta = TOWERS[s.kind];
      if (s.arc) {
        // The coil's chain: the same jagged polyline stroked three times, wide
        // and dark to narrow and white. A shadowBlur glow is expensive and on
        // this board it just fogged the bolt; three strokes is a drawn bolt.
        ctx.globalAlpha = clamp(1 - s.age / 0.12, 0, 1);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const bolt = () => {
          ctx.beginPath();
          for (let i = 0; i < s.arc!.length; i++) {
            const p = s.arc![i];
            if (i === 0) ctx.moveTo(p.x, p.y);
            else {
              // A midpoint kicked off the straight line, so a bolt looks like a
              // bolt rather than a ruler.
              const q = s.arc![i - 1];
              const mx = (p.x + q.x) / 2 + Math.sin(clock * 40 + i) * 9;
              const my = (p.y + q.y) / 2 + Math.cos(clock * 37 + i) * 9;
              ctx.quadraticCurveTo(mx, my, p.x, p.y);
            }
          }
          ctx.stroke();
        };
        for (const [colour, width] of [
          [shade(meta.hue, 0.5), 10],
          [meta.trim, 6],
          ['#ffffff', 2.5],
        ] as [string, number][]) {
          ctx.strokeStyle = colour;
          ctx.lineWidth = width;
          bolt();
        }
        // A spark where the bolt lands on each target.
        ctx.fillStyle = '#ffffff';
        for (const p of s.arc) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        continue;
      }
      const r = s.kind === 'cannon' ? 7 : s.kind === 'ballista' ? 5 : 4.2;
      // A short tail in the direction of travel reads as speed and costs one
      // line, where a real particle trail would cost hundreds of objects.
      // Drawn under the pellet so the pellet keeps its own clean outline.
      const dx = s.tx - s.x;
      const dy = s.ty - s.y;
      const d = Math.hypot(dx, dy) || 1;
      ctx.strokeStyle = `${meta.trim}77`;
      ctx.lineWidth = r * 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - (dx / d) * 16, s.y - (dy / d) * 16);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = meta.trim;
      ctx.fill();
      ctx.strokeStyle = shade(meta.hue, 0.45);
      ctx.lineWidth = 2.5;
      ctx.stroke();
      // A hard white catchlight: the same trick the enemies' eyes use, and it
      // is what keeps a pellet visible over a bright road.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(s.x - r * 0.3, s.y - r * 0.3, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Bursts.
    // Bursts. Every one is a hard-edged shape that grows and fades, not a
    // soft glow: a radial gradient on a flat bright board reads as a smudge,
    // and the frost ring in particular was all but invisible over the road.
    for (const b of engine.bursts) {
      const a = clamp(b.life, 0, 1);
      if (b.kind === 'frost') {
        ctx.strokeStyle = `rgba(200, 244, 255, ${a})`;
        ctx.lineWidth = 6 * a + 1;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = `rgba(79, 195, 247, ${a * 0.9})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      } else if (b.kind === 'leak') {
        // Two rings chasing each other outward, in the one colour on the board
        // that means "that got through".
        for (const k of [1, 0.72]) {
          ctx.strokeStyle = `rgba(255, 90, 110, ${a * k})`;
          ctx.lineWidth = 6 * k;
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.r * k, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else {
        // A splash: a filled puff with a ring around it, so a shell landing
        // has an edge you can actually see it expand past.
        ctx.globalAlpha = a * 0.85;
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 0.78, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = a;
        ctx.fillStyle = '#fff3c4';
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 4 * a + 1;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // A fallen keep is drawn under a wash, so a spectator can tell at a glance
    // that what they are looking at is over.
    if (engine.phase === 'fallen') {
      ctx.fillStyle = 'rgba(60, 6, 16, 0.55)';
      ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    }
  }, [mine]);

  // -- input ------------------------------------------------------------------

  const onTap = useCallback(
    (ev: React.PointerEvent<HTMLCanvasElement>) => {
      const engine = enginesRef.current[0];
      if (!engine) return;
      audioService.unlock();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const { scale, offX, offY, dpr } = viewRef.current;
      const px = (ev.clientX - rect.left) * dpr;
      const py = (ev.clientY - rect.top) * dpr;
      const wx = (px - offX) / scale;
      const wy = (py - offY) / scale;
      const col = Math.floor(wx / TILE);
      const row = Math.floor(wy / TILE);
      if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return;
      const plot = row * COLS + col;

      const existing = engine.towerAt(plot);
      if (existing) {
        if (existing.owner !== mine) {
          setNotice(`${config.seats[existing.owner]?.name ?? 'A teammate'} owns this machine.`);
        }
        setPicked((p) => (p === plot ? null : plot));
        return;
      }
      if (!isBuildable(col, row)) {
        setPicked(null);
        return;
      }
      // An empty plot: first tap shows the footprint and the reach, second
      // builds. Two taps rather than one because a mis-tap that spends a
      // hundred and fifty gold mid-wave is a real loss.
      if (pickedRef.current === plot) order({ plot, kind: selectedRef.current, level: 0, owner: mine });
      else setPicked(plot);
    },
    [mine, order],
  );

  // -- outcome ----------------------------------------------------------------

  useEffect(() => {
    if (over) return;
    const engine = enginesRef.current[0];
    if (!engine || (engine.phase !== 'won' && engine.phase !== 'fallen')) return;
    const teamScores = [0, 0];
    engine.killsByPlayer.forEach((kills, seat) => { teamScores[seat % 2] += kills; });
    const coop = session?.rules.mode === 'alliance' || config.seats.length === 1;
    const won = engine.phase === 'won' && (coop || teamScores[mine % 2] >= teamScores[(mine + 1) % 2]);
    finish(won);

    function finish(won: boolean) {
      setOver({ won, standing: config.seats.map((_, i) => i) });
      onResult(won, engine.wave);
      audioService.end(won);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scores, mine, over, session?.rules.mode]);

  useEffect(
    () => () => {
      if (bannerTimer.current !== null) window.clearTimeout(bannerTimer.current);
    },
    [],
  );

  // -- render -----------------------------------------------------------------

  const engine = enginesRef.current[0];
  const own = engine;
  const wave = own?.current;
  const canAfford = (id: TowerId) => (own ? own.golds[mine] >= TOWERS[id].levels[0].cost : false);
  const pickedTower = picked !== null && engine ? engine.towerAt(picked) : undefined;

  if (!session) {
    return (
      <div className="flex h-[100dvh] w-full flex-col items-center justify-center gap-3 bg-[#0b1220] text-white">
        <Loader2 className="h-10 w-10 animate-spin text-amber-300" />
        <p className="font-bold">Waiting for the host to raise the gates.</p>
        {notice && <p className="text-xs text-amber-200">{notice}</p>}
        <button onClick={onExit} className="mt-2 rounded-2xl border border-white/25 bg-white/10 px-5 py-2 text-sm font-bold">
          Back
        </button>
      </div>
    );
  }

  return (
    <div ref={shellRef} className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-[#0b1220] text-white">
      {/* ── top bar: your keep, and the arrows to everyone else's ── */}
      <div className="z-30 flex shrink-0 items-start justify-between gap-2 p-2 sm:p-3 short:p-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Stat icon={<Heart className="h-3.5 w-3.5" />} value={hud.lives} tone="rose" label="lives" />
          <Stat icon={<Coins className="h-3.5 w-3.5" />} value={hud.gold} tone="amber" label="gold" />
          <div className="flex items-center gap-1.5 rounded-xl border border-white/15 bg-black/40 px-2.5 py-1.5 backdrop-blur-md">
            <Swords className="h-3.5 w-3.5 text-violet-300" />
            <span className="text-xs font-black">
              Wave {Math.min(hud.wave + 1, session.rules.waves)}
              <span className="opacity-50">/{session.rules.waves}</span>
            </span>
          </div>
          {hud.phase === 'build' && (
            <div className="flex items-center gap-1.5 rounded-xl border border-emerald-400/40 bg-emerald-500/15 px-2.5 py-1.5 backdrop-blur-md">
              <span className="text-xs font-black tabular-nums text-emerald-200">Build {hud.timer}s</span>
            </div>
          )}
          {config.seats.length > 1 && (
            <div className="hidden items-center gap-2 rounded-xl border border-white/15 bg-black/40 px-2.5 py-1.5 backdrop-blur-md sm:flex">
              {config.seats.map((seat, i) => (
                <span key={seat.id} className={`text-[10px] font-black ${i === mine ? 'text-white' : 'text-white/55'}`}>
                  <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: SEATS[i].main }} />
                  {session.rules.mode === 'siege' ? `T${(i % 2) + 1} ` : ''}{i === mine ? 'You' : seat.name}: {scores[i] ?? 0}
                </span>
              ))}
            </div>
          )}
          {!online && <button
            onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])}
            aria-label="Game speed"
            className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 backdrop-blur-md transition-colors ${
              speed > 1 ? 'border-sky-400/40 bg-sky-500/15 text-sky-200' : 'border-white/15 bg-black/40 text-white/70'
            }`}
          >
            <Gauge className="h-3.5 w-3.5" />
            <span className="text-xs font-black tabular-nums">{speed}×</span>
          </button>}
        </div>

        <div className="pointer-events-auto shrink-0">
          <ControlsTray
            shellRef={shellRef}
            online={online}
            isHost={config.isHost}
            onSettings={onOpenSettings}
            onExit={onExit}
            theme="dark"
            before={
              <div className="flex items-center gap-1.5 rounded-2xl border border-white/20 bg-slate-950/60 px-3 py-2.5 text-xs font-bold text-amber-300 backdrop-blur-md">
                <Coins className="h-4 w-4" /> {coins}
              </div>
            }
          />
        </div>
      </div>

      {/* ── whose keep is on screen ── */}

      {/* ── chat bubbles, anchored over the speaker's own machines ── */}
      {Object.entries(bubbles).map(([seatKey, text]) => {
        const i = Number(seatKey);
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const anchor = chatAnchor(i);
        const p = toClient(anchor.x, anchor.y, canvas.getBoundingClientRect());
        return <SpeechBubble key={seatKey} text={text} style={{ left: p.x, top: p.y }} />;
      })}

      {/* Below the top bar, not in the default top-left corner: this game puts
          lives and gold there, and the chat button was sitting squarely on top
          of the lives counter , the one number a player checks most. */}
      {!over && <ChatLayer onSend={sendChat} buttonClassName="absolute left-2 top-16 z-30 short:top-12" />}

      {/* ── the board ── */}
      <div ref={boardRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} onPointerDown={onTap} className="absolute inset-0 h-full w-full touch-none" />

        {/* A spectated keep is framed in its owner's colour, so there is never
            a moment where a player is unsure which board their taps go to. */}

        {/* Wave preview, so the build phase is a decision and not a guess. */}
        {hud.phase === 'build' && wave && (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-3">
            <div className="flex max-w-full flex-wrap items-center gap-2 rounded-2xl border border-white/15 bg-black/60 px-3 py-2 backdrop-blur-md">
              <span className="text-[10px] font-black uppercase tracking-wider text-white/50">Incoming</span>
              {wave.preview.map((p) => (
                <span key={p.kind} className="flex items-center gap-1 text-[11px] font-bold">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: ENEMIES[p.kind].body }} />
                  {ENEMIES[p.kind].name} ×{p.count}
                </span>
              ))}
              {wave.boss && <span className="text-[11px] font-black text-rose-300">BOSS</span>}
            </div>
          </div>
        )}

        {banner && (
          <div className="pointer-events-none absolute inset-x-0 top-1/3 z-30 flex justify-center px-4">
            <div
              className={`rounded-2xl border px-5 py-2.5 text-center text-xl font-black uppercase tracking-tight shadow-2xl sm:text-3xl ${
                banner.tone === 'good'
                  ? 'border-emerald-300/60 bg-emerald-400/95 text-emerald-950'
                  : 'border-rose-300/60 bg-rose-400/95 text-rose-950'
              }`}
            >
              {banner.text}
            </div>
          </div>
        )}

        {/* The sidebars were removed for single base game. */}
      </div>

      {/* ── the build bar ──
          Sideways, the three bars of chrome came to 183px against 176px of
          actual keep -- more furniture than game. Each one gives back what it
          can: padding here, the tower's role line below. */}
      {!over && (
        <div className="z-30 shrink-0 border-t border-white/10 bg-slate-950/80 p-2 backdrop-blur-md short:p-1">
          {pickedTower ? (
            <TowerPanel
              engine={enginesRef.current[0]}
              plot={pickedTower.plot}
              onUpgrade={() => order({ plot: pickedTower.plot, kind: pickedTower.kind, level: pickedTower.level + 1, owner: mine })}
              onSell={() => order({ plot: pickedTower.plot, kind: null, level: 0, owner: mine })}
              onClose={() => setPicked(null)}
              mine={mine}
            />
          ) : (
            <div className="flex items-stretch gap-1.5 overflow-x-auto">
              {TOWER_ORDER.map((id) => {
                const meta = TOWERS[id];
                const cost = meta.levels[0].cost;
                const afford = canAfford(id);
                return (
                  <button
                    key={id}
                    onClick={() => {
                      setSelected(id);
                      setPicked(null);
                    }}
                    className={`flex min-w-[86px] flex-1 flex-col items-start gap-0.5 rounded-xl border px-2 py-1.5 text-left transition-colors short:min-w-[64px] short:px-1.5 short:py-1 ${
                      selected === id ? 'border-amber-400 bg-amber-400/15' : 'border-white/12 bg-white/5'
                    } ${afford ? '' : 'opacity-45'}`}
                  >
                    <span className="flex w-full items-center gap-1.5">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: meta.trim }} />
                      <span className="truncate text-[11px] font-black">{meta.name}</span>
                    </span>
                    <span className="text-[9px] font-bold leading-tight text-white/45 short:hidden">{meta.role}</span>
                    <span className={`text-[10px] font-black tabular-nums ${afford ? 'text-amber-300' : 'text-rose-300'}`}>
                      {cost}g
                    </span>
                  </button>
                );
              })}

              <div className="flex shrink-0 flex-col gap-1.5">
                {hud.phase === 'build' && (!online || config.isHost) && (
                  <button
                    onClick={startNow}
                    className="flex items-center gap-1 rounded-xl bg-emerald-400 px-3 py-1.5 text-[11px] font-black text-emerald-950"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" /> Start
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── sending ── */}

      {notice && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex justify-center px-4">
          <div className="rounded-xl border border-amber-300/40 bg-slate-950/85 px-4 py-2 text-center text-xs font-bold text-amber-200">
            {notice}
          </div>
        </div>
      )}

      {/* ── the end ── */}
      {over && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
          <div className="w-full max-w-sm space-y-5 rounded-[2rem] border border-white/20 bg-slate-900/95 p-7 text-center">
            <Trophy className={`mx-auto h-14 w-14 ${over.won ? 'text-amber-300' : 'text-slate-500'}`} />
            <div>
              <h2 className="text-3xl font-black tracking-tight">
                {over.won ? (session.rules.mode === 'alliance' ? 'The keep stands' : 'Your team wins') : (session.rules.mode === 'alliance' ? 'The keep fell' : 'Rival team wins')}
              </h2>
              <p className="mt-1 text-sm font-semibold text-white/50">
                {`Wave ${Math.min((own?.wave ?? 0) + 1, session.rules.waves)} of ${session.rules.waves}`}
                {own ? ` · ${own.totalKills} slain` : ''}
              </p>
            </div>

            <div className="space-y-1.5 rounded-2xl bg-black/30 p-3">
              {config.seats.map((s, i) => (
                <div key={s.id} className="flex items-center gap-2 text-sm">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SEATS[i % SEATS.length].main }} />
                  <span className="min-w-0 flex-1 truncate text-left font-bold">{i === mine ? 'You' : s.name}</span>
                  <span className="font-black tabular-nums">
                    {scores[i] ?? 0} kills
                  </span>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <button onClick={onExit} className="flex-1 rounded-2xl bg-amber-400 py-3 font-black text-slate-900">
                {online ? 'Back to the room' : 'Back'}
              </button>
            </div>
            {/* A fallen player can still watch the rest of it out, which is the
                only thing that makes losing first bearable in a four-hander. */}
          </div>
        </div>
      )}

      {/* First touch unlocks audio. */}
      <div
        className="pointer-events-none absolute inset-0"
        onPointerDown={() => audioService.unlock()}
      />
    </div>
  );
}

function Stat({ icon, value, tone, label }: { icon: React.ReactNode; value: number; tone: 'rose' | 'amber'; label: string }) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 backdrop-blur-md ${
        tone === 'rose' ? 'border-rose-400/35 bg-rose-500/12' : 'border-amber-400/35 bg-amber-400/12'
      }`}
    >
      <span className={tone === 'rose' ? 'text-rose-300' : 'text-amber-300'}>{icon}</span>
      <span className="text-xs font-black tabular-nums">{value}</span>
      <span className="text-[9px] font-bold uppercase tracking-wider text-white/35">{label}</span>
    </div>
  );
}

/** The panel for one standing tower: what it does, what an upgrade costs. */
function TowerPanel({
  engine,
  plot,
  onUpgrade,
  onSell,
  onClose,
  mine,
}: {
  engine: SiegeEngine;
  plot: number;
  onUpgrade: () => void;
  onSell: () => void;
  onClose: () => void;
  mine: number;
}) {
  const tower = engine?.towerAt(plot);
  if (!engine || !tower) return null;
  const meta = TOWERS[tower.kind];
  const lv = meta.levels[tower.level];
  const next = tower.level < 2 ? meta.levels[tower.level + 1] : null;
  const upCost = next ? next.cost : 0;
  const isMine = tower.owner === mine;
  const canUp = isMine && next !== null && engine.golds[mine] >= upCost;

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-xs font-black">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: meta.trim }} />
          {meta.name}
          <span className="text-white/40">lvl {tower.level + 1}</span>
          <span className="rounded-md px-1.5 py-0.5 text-[8px] uppercase" style={{ color: SEATS[tower.owner].light, background: `${SEATS[tower.owner].main}22` }}>
            {isMine ? 'yours' : `P${tower.owner + 1}`}
          </span>
        </p>
        <p className="truncate text-[10px] font-bold text-white/45">
          {lv.damage} dmg · {Math.round(lv.range)} reach · {tower.kills} slain
        </p>
      </div>
      {next ? (
        <button
          onClick={onUpgrade}
          disabled={!canUp}
          className="rounded-xl border border-emerald-400/50 bg-emerald-500/20 px-3 py-2 text-[11px] font-black text-emerald-200 disabled:opacity-40"
        >
          Upgrade {upCost}g
          <span className="block text-[9px] font-bold text-emerald-200/60">
            {next.damage} dmg · {Math.round(next.range)} reach
          </span>
        </button>
      ) : (
        <span className="rounded-xl border border-white/12 px-3 py-2 text-[11px] font-black text-white/40">Maxed</span>
      )}
      <button
        onClick={onSell}
        disabled={!isMine}
        className="rounded-xl border border-rose-400/40 bg-rose-500/15 px-3 py-2 text-[11px] font-black text-rose-200 disabled:opacity-30"
      >
        Sell {engine.refundOf(plot)}g
      </button>
      <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-white/10">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
