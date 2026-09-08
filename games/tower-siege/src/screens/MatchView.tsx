/**
 * The siege on screen: every keep simulated, one of them drawn.
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
import { ChevronLeft, ChevronRight, Coins, Eye, Heart, Loader2, Play, Send, Swords, Trophy, X } from 'lucide-react';
import ControlsTray from '@shared/controls/ControlsTray';
import { isStaleChunkError, recoverFromStaleChunk } from '@shared/net/staleChunk';
import { SiegeEngine } from '../engine/SiegeEngine';
import type { BuildOrder } from '../engine/SiegeEngine';
import { decide } from '../engine/ai';
import {
  BALANCE,
  ENEMIES,
  SEATS,
  SENDS,
  TILE,
  TOWERS,
  TOWER_ORDER,
  buildWaves,
  clamp,
  packRules,
  unpackRules,
} from '../game/rules';
import type { EnemyId, MatchRules, TowerId } from '../game/rules';
import { COLS, ROWS, WORLD_H, WORLD_W, isBuildable } from '../game/map';
import { drawKeep, drawTowerHead, enemySprite, towerBase } from '../game/art';
import { bakeGround, drawPlots } from '../game/ground';
import { audioService } from '../services/audio';
import { IN_IFRAME, toggleFullscreen } from '../fullscreen';
import type { GameSettings, NetPacket } from '../types/game';
// Type only: the runtime value arrives through the dynamic import below, which
// is what keeps the Firebase SDK out of an offline player's bundle.
import type { TurnLink } from '../net/turnLink';

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
  /** One keep per seat, in the fixed order every client derives the same way. */
  seats: Seat[];
  /** Which seat this device holds. -1 for a spectator with no keep. */
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

  const online = Boolean(config.roomId && config.uid && config.peerUids.length > 0);
  const rulesBits = packRules(config.rules);

  const [session, setSession] = useState<Session | null>(
    online && !config.isHost ? null : { seed: config.seed, rules: config.rules },
  );

  /** Which keep is on screen. Starts on your own; the arrows move it. */
  const [watching, setWatching] = useState(Math.max(0, config.mine));
  const [selected, setSelected] = useState<TowerId>('arrow');
  const [picked, setPicked] = useState<number | null>(null);
  const [banner, setBanner] = useState<{ id: number; text: string; tone: 'good' | 'bad' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [over, setOver] = useState<{ won: boolean; standing: number[] } | null>(null);
  const [showSends, setShowSends] = useState(false);

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
  const [board, setBoard] = useState<{ lives: number; wave: number; down: boolean }[]>(() =>
    config.seats.map(() => ({ lives: BALANCE.LIVES, wave: 0, down: false })),
  );

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
   * Every keep, simulated.
   *
   * Rebuilt only when the *match* changes — a new seed or new rules. Listing
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

  // -- the wire ---------------------------------------------------------------

  const handlePacket = useCallback(
    (packet: NetPacket, from: string) => {
      if (packet.t === 'start') {
        setSession((cur) => (cur && cur.seed === packet.seed ? cur : { seed: packet.seed, rules: unpackRules(packet.r) }));
        return;
      }
      const engines = enginesRef.current;
      if (engines.length === 0) {
        queued.current.push({ packet, from });
        return;
      }
      const seat = seatOfUid.get(from);

      if (packet.t === 'bye') {
        if (seat === undefined) return;
        const e = engines[seat];
        if (e && e.control === 'remote') {
          e.control = 'bot';
          setNotice(`${e.name} dropped. A bot is holding their keep.`);
        }
        return;
      }
      if (packet.t === 'hello') {
        if (seat === undefined) return;
        const e = engines[seat];
        if (e && e.control === 'bot') {
          e.control = 'remote';
          setNotice(`${e.name} is back.`);
        }
        return;
      }
      if (packet.t === 'build') {
        if (seat === undefined) return;
        // Not charged: the owner already paid on their own device, and
        // charging again here would have a peer's keep run out of gold it
        // never spent. See SiegeEngine.apply.
        engines[seat]?.apply({ plot: packet.p, kind: packet.k, level: packet.lv }, false);
        return;
      }
      if (packet.t === 'send') {
        // Lands on everyone but whoever bought it, which is what stops a
        // four-player siege turning into three players ganging up on one.
        for (let i = 0; i < engines.length; i++) {
          if (i === seat) continue;
          engines[i].pushIncoming(packet.w, packet.k, packet.c);
        }
        if (seat !== mine) {
          const who = engines[seat ?? 0]?.name ?? 'Someone';
          shout(`${who} sent ${packet.c} ${ENEMIES[packet.k].name}`, 'bad');
        }
        return;
      }
      if (packet.t === 'state') {
        if (seat === undefined) return;
        engines[seat]?.reconcile(packet.w, packet.lives, packet.gold, packet.down === 1);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seatOfUid, mine, shout],
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
      session.rules.mode === 'alliance',
    );

    const engines = config.seats.map(
      (seat, i) =>
        new SiegeEngine({
          control: seat.control,
          name: seat.name,
          seat: i,
          waves,
          seed: session.seed ^ (i * 0x9e37),
          lives: BALANCE.LIVES,
          gold: BALANCE.START_GOLD,
          onSfx: i === mine ? (kind) => playSfx(kind) : undefined,
          onWaveEnd:
            i === mine
              ? (wave, lives, gold, down) => {
                  linkRef.current?.send({
                    t: 'state', n: Date.now(), s: session.seed, w: wave, lives, gold, down: down ? 1 : 0, r: rulesBits,
                  });
                  if (!down) shout(`Wave ${wave + 1} cleared`, 'good');
                }
              : undefined,
        }),
    );
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

  const spectating = watching !== mine;

  /** Build, upgrade or sell, and tell everyone what actually happened. */
  const order = useCallback(
    (o: BuildOrder) => {
      const engine = enginesRef.current[mine];
      if (!engine || spectating) return;
      const done = engine.apply(o);
      if (!done) return;
      audioService.unlock();
      linkRef.current?.send({
        t: 'build', n: Date.now(), s: session?.seed ?? 0, p: done.plot, k: done.kind, lv: done.level,
      });
      setPicked(null);
    },
    [mine, spectating, session?.seed],
  );

  const buySend = useCallback(
    (kind: EnemyId, count: number, cost: number) => {
      const engine = enginesRef.current[mine];
      if (!engine || engine.gold < cost) return;
      engine.gold -= cost;
      // Lands on the wave after the one being fought, so it is always a
      // boundary both sides agree on.
      const wave = engine.wave + 1;
      for (let i = 0; i < enginesRef.current.length; i++) {
        if (i === mine) continue;
        enginesRef.current[i].pushIncoming(wave, kind, count);
      }
      linkRef.current?.send({ t: 'send', n: Date.now(), s: session?.seed ?? 0, k: kind, c: count, w: wave });
      shout(`Sent ${count} ${ENEMIES[kind].name} at wave ${wave + 1}`, 'good');
      setShowSends(false);
    },
    [mine, session?.seed, shout],
  );

  const startNow = useCallback(() => {
    enginesRef.current[mine]?.startWaveNow();
    audioService.unlock();
  }, [mine]);

  const step = useCallback((dir: 1 | -1) => {
    setWatching((w) => (w + dir + config.seats.length) % config.seats.length);
    setPicked(null);
  }, [config.seats.length]);

  // -- the loop ---------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let last = performance.now();
    let clock = 0;
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

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      clock += dt;

      const engines = enginesRef.current;
      if (engines.length === 0) return;

      // Every keep advances, not only the one being watched — that is what
      // makes the spectator view live rather than a snapshot, and what lets a
      // bot lose a match while you are looking the other way.
      for (const e of engines) e.update(dt);

      // Bots spend during their build phase, a tower at a time so the buying
      // is spread across the phase rather than landing in one frame.
      for (const e of engines) {
        if (e.control !== 'bot' || e.phase !== 'build') {
          if (e.phase !== 'build') botNth.delete(e.seat);
          continue;
        }
        const nth = botNth.get(e.seat) ?? 0;
        // Paced off the build clock: roughly one purchase a second, which
        // reads as a keep being fortified rather than one appearing whole.
        const due = Math.floor((BALANCE.BUILD_TIME - e.timer) / 1.1);
        if (nth >= due) continue;
        const want = decide(e, aiLevel, nth);
        botNth.set(e.seat, nth + 1);
        if (want) e.apply(want);
      }

      render(ctx, engines[watchRef.current] ?? engines[0], clock);

      // -- HUD, only when something a human can read has changed --
      const own = engines[mine];
      if (own) {
        const t = Math.ceil(own.phase === 'build' ? own.timer : own.timer);
        if (
          own.lives !== shown.lives || Math.floor(own.gold) !== shown.gold ||
          own.wave !== shown.wave || own.phase !== shown.phase || t !== shown.timer
        ) {
          shown.lives = own.lives;
          shown.gold = Math.floor(own.gold);
          shown.wave = own.wave;
          shown.phase = own.phase;
          shown.timer = t;
          setHud({ lives: own.lives, gold: Math.floor(own.gold), wave: own.wave, phase: own.phase, timer: t });
        }
      }

      const boardKey = engines.map((e) => `${e.lives}:${e.wave}:${e.phase === 'fallen' ? 1 : 0}`).join('|');
      if (boardKey !== shown.boardKey) {
        shown.boardKey = boardKey;
        setBoard(engines.map((e) => ({ lives: e.lives, wave: e.wave, down: e.phase === 'fallen' })));
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.seed, aiLevel, mine]);

  /** Read inside the loop so changing it does not tear the loop down. */
  const watchRef = useRef(watching);
  watchRef.current = watching;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const viewRef = useRef({ scale: 1, offX: 0, offY: 0, dpr: 1 });

  // -- rendering --------------------------------------------------------------

  const render = useCallback((ctx: CanvasRenderingContext2D, engine: SiegeEngine, clock: number) => {
    const { canvas } = ctx;
    const { scale, offX, offY } = viewRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, offX, offY);

    const ground = bakeGround();
    if (ground) ctx.drawImage(ground, 0, 0);

    // The plots only while a tower is actually being placed. Baked into the
    // ground they were a cage over every inch of the map; see ground.ts.
    const placing = pickedRef.current !== null && !engine.towerAt(pickedRef.current);
    if (placing && watchRef.current === mine) {
      drawPlots(ctx, new Set(engine.towers.map((t) => t.plot)));
    }

    // Range rings under everything, so a tower never hides its own reach.
    const showAll = settingsRef.current.showRanges;
    const sel = pickedRef.current;
    for (const t of engine.towers) {
      if (!showAll && t.plot !== sel) continue;
      const lv = TOWERS[t.kind].levels[t.level];
      ctx.fillStyle = `${TOWERS[t.kind].trim}14`;
      ctx.strokeStyle = `${TOWERS[t.kind].trim}55`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(t.x, t.y, lv.range, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // The plot under the thumb, while a tower is picked up.
    if (sel !== null && !engine.towerAt(sel) && watchRef.current === mine) {
      const col = sel % COLS;
      const row = Math.floor(sel / COLS);
      const kind = selectedRef.current;
      const ok = engine.costOf(sel, kind) >= 0 && engine.gold >= engine.costOf(sel, kind);
      ctx.fillStyle = ok ? 'rgba(120, 255, 170, 0.18)' : 'rgba(255, 90, 90, 0.2)';
      ctx.fillRect(col * TILE + 4, row * TILE + 4, TILE - 8, TILE - 8);
      ctx.strokeStyle = ok ? '#7dffaa' : '#ff6b6b';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(col * TILE + 4, row * TILE + 4, TILE - 8, TILE - 8);
      const lv = TOWERS[kind].levels[0];
      ctx.fillStyle = `${TOWERS[kind].trim}12`;
      ctx.strokeStyle = `${TOWERS[kind].trim}55`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(col * TILE + TILE / 2, row * TILE + TILE / 2, lv.range, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    drawKeep(ctx, engine.lives, BALANCE.LIVES, clock);

    // Towers: baked base, live head.
    for (const t of engine.towers) {
      const base = towerBase(t.kind, t.level);
      if (base) ctx.drawImage(base, t.x - base.width / 2, t.y - base.height / 2);
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(t.face);
      drawTowerHead(ctx, t.kind, t.level, t.fired, clock);
      ctx.restore();
      if (t.plot === sel) {
        ctx.strokeStyle = '#ffe9a8';
        ctx.lineWidth = 2.5;
        ctx.strokeRect((t.plot % COLS) * TILE + 4, Math.floor(t.plot / COLS) * TILE + 4, TILE - 8, TILE - 8);
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
        ctx.fillStyle = 'rgba(140, 220, 255, 0.3)';
        ctx.beginPath();
        ctx.arc(0, 0, meta.size * 1.25, 0, Math.PI * 2);
        ctx.fill();
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

      // Health bar, only once it has actually been hurt — a full bar over
      // every walker turns the board into a bar chart.
      if (e.hp < e.maxHp) {
        const w = meta.size * 2.1;
        const frac = clamp(e.hp / e.maxHp, 0, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(-w / 2, -meta.size - 9, w, 5);
        ctx.fillStyle = frac > 0.5 ? '#4ade80' : frac > 0.22 ? '#fbbf24' : '#f87171';
        ctx.fillRect(-w / 2, -meta.size - 9, w * frac, 5);
      }
      ctx.restore();
    }

    // Shots.
    for (const s of engine.shots) {
      const meta = TOWERS[s.kind];
      if (s.arc) {
        // The coil's chain, drawn as one jagged polyline with a glow under it.
        ctx.strokeStyle = meta.trim;
        ctx.lineWidth = 3.5;
        ctx.globalAlpha = clamp(1 - s.age / 0.12, 0, 1);
        ctx.shadowColor = meta.trim;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        for (let i = 0; i < s.arc.length; i++) {
          const p = s.arc[i];
          if (i === 0) ctx.moveTo(p.x, p.y);
          else {
            // A midpoint kicked off the straight line, so a bolt looks like a
            // bolt rather than a ruler.
            const q = s.arc[i - 1];
            const mx = (p.x + q.x) / 2 + Math.sin(clock * 40 + i) * 9;
            const my = (p.y + q.y) / 2 + Math.cos(clock * 37 + i) * 9;
            ctx.quadraticCurveTo(mx, my, p.x, p.y);
          }
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.fillStyle = meta.trim;
      ctx.beginPath();
      const r = s.kind === 'cannon' ? 5.5 : s.kind === 'ballista' ? 4 : 3.2;
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      // A short tail in the direction of travel reads as speed and costs one
      // line, where a real particle trail would cost hundreds of objects.
      const dx = s.tx - s.x;
      const dy = s.ty - s.y;
      const d = Math.hypot(dx, dy) || 1;
      ctx.strokeStyle = `${meta.trim}88`;
      ctx.lineWidth = r * 1.1;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - (dx / d) * 13, s.y - (dy / d) * 13);
      ctx.stroke();
    }

    // Bursts.
    for (const b of engine.bursts) {
      const a = clamp(b.life, 0, 1);
      if (b.kind === 'frost') {
        ctx.strokeStyle = `rgba(165, 232, 255, ${a * 0.8})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.stroke();
      } else if (b.kind === 'leak') {
        ctx.strokeStyle = `rgba(244, 63, 94, ${a})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, Math.max(1, b.r));
        g.addColorStop(0, `${b.color}${Math.round(a * 200).toString(16).padStart(2, '0')}`);
        g.addColorStop(1, `${b.color}00`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
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
      const engine = enginesRef.current[watchRef.current];
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

      // A spectated keep is read-only (R4). Tapping it selects a tower so its
      // range can be read, and nothing more.
      if (watchRef.current !== mine) {
        setPicked(engine.towerAt(plot) ? plot : null);
        return;
      }

      const existing = engine.towerAt(plot);
      if (existing) {
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
      if (pickedRef.current === plot) order({ plot, kind: selectedRef.current, level: 0 });
      else setPicked(plot);
    },
    [mine, order],
  );

  // -- outcome ----------------------------------------------------------------

  useEffect(() => {
    if (over) return;
    const engines = enginesRef.current;
    if (engines.length === 0) return;
    const standing = board.map((b, i) => (b.down ? -1 : i)).filter((i) => i >= 0);
    const meDown = board[mine]?.down ?? false;
    const coop = session?.rules.mode === 'alliance';

    if (coop) {
      // One pool: everybody's keep falls together, and clearing the list
      // together is the win.
      if (meDown) finish(false);
      else if (engines[mine]?.phase === 'won') finish(true);
      return;
    }
    if (standing.length <= 1 && config.seats.length > 1) {
      finish(standing[0] === mine);
    } else if (meDown) {
      finish(false);
    } else if (engines[mine]?.phase === 'won' && standing.length === 1) {
      finish(true);
    } else if (engines[mine]?.phase === 'won' && config.seats.length === 1) {
      finish(true);
    }

    function finish(won: boolean) {
      setOver({ won, standing });
      onResult(won, engines[mine]?.wave ?? 0);
      audioService.end(won);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, mine, over, session?.rules.mode]);

  useEffect(
    () => () => {
      if (bannerTimer.current !== null) window.clearTimeout(bannerTimer.current);
    },
    [],
  );

  // -- render -----------------------------------------------------------------

  const engine = enginesRef.current[watching];
  const own = enginesRef.current[mine];
  const wave = own?.current;
  const seatColor = SEATS[watching % SEATS.length];
  const canAfford = (id: TowerId) => (own ? own.gold >= TOWERS[id].levels[0].cost : false);
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
      {config.seats.length > 1 && (
        <div className="z-30 flex shrink-0 items-center justify-center gap-2 px-2 pb-1 short:pb-0">
          <button
            onClick={() => step(-1)}
            aria-label="Previous keep"
            className="rounded-xl border border-white/20 bg-black/40 p-2 backdrop-blur-md transition-colors hover:bg-white/10"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div
            className="flex min-w-0 items-center gap-2 rounded-xl border px-3 py-1.5 backdrop-blur-md"
            style={{
              borderColor: `${seatColor.main}88`,
              background: spectating ? `${seatColor.main}22` : 'rgba(0,0,0,0.4)',
            }}
          >
            {spectating && <Eye className="h-3.5 w-3.5 shrink-0" style={{ color: seatColor.light }} />}
            <span className="truncate text-xs font-black" style={{ color: seatColor.light }}>
              {spectating ? `${engine?.name ?? 'Keep'}'s keep` : 'Your keep'}
            </span>
            {board[watching]?.down && <span className="text-[10px] font-black text-rose-300">FALLEN</span>}
          </div>
          <button
            onClick={() => step(1)}
            aria-label="Next keep"
            className="rounded-xl border border-white/20 bg-black/40 p-2 backdrop-blur-md transition-colors hover:bg-white/10"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          {spectating && (
            <button
              onClick={() => setWatching(mine)}
              className="rounded-xl border border-amber-400/50 bg-amber-400/20 px-3 py-1.5 text-[11px] font-black text-amber-200"
            >
              Back to yours
            </button>
          )}
        </div>
      )}

      {/* ── the board ── */}
      <div ref={boardRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} onPointerDown={onTap} className="absolute inset-0 h-full w-full touch-none" />

        {/* A spectated keep is framed in its owner's colour, so there is never
            a moment where a player is unsure which board their taps go to. */}
        {spectating && (
          <div
            className="pointer-events-none absolute inset-0 border-4"
            style={{ borderColor: `${seatColor.main}99` }}
          />
        )}

        {/* Wave preview, so the build phase is a decision and not a guess. */}
        {hud.phase === 'build' && wave && !spectating && (
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

        {/* The other keeps, at a glance. Tap one to jump to it. */}
        {config.seats.length > 1 && (
          <div className="pointer-events-auto absolute right-2 top-2 z-20 flex flex-col gap-1">
            {config.seats.map((s, i) => {
              const c = SEATS[i % SEATS.length];
              const b = board[i];
              return (
                <button
                  key={s.id}
                  onClick={() => setWatching(i)}
                  className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-black backdrop-blur-md transition-colors ${
                    i === watching ? 'bg-white/15' : 'bg-black/45 hover:bg-white/10'
                  }`}
                  style={{ borderColor: `${c.main}66` }}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.main }} />
                  <span className="max-w-[74px] truncate" style={{ color: c.light }}>
                    {i === mine ? 'You' : s.name}
                  </span>
                  {b?.down ? (
                    <X className="h-3 w-3 text-rose-400" />
                  ) : (
                    <span className="tabular-nums text-white/70">{b?.lives ?? 0}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── the build bar ──
          Sideways, the three bars of chrome came to 183px against 176px of
          actual keep -- more furniture than game. Each one gives back what it
          can: padding here, the tower's role line below. */}
      {!spectating && !over && (
        <div className="z-30 shrink-0 border-t border-white/10 bg-slate-950/80 p-2 backdrop-blur-md short:p-1">
          {pickedTower ? (
            <TowerPanel
              engine={enginesRef.current[mine]}
              plot={pickedTower.plot}
              onUpgrade={() => order({ plot: pickedTower.plot, kind: pickedTower.kind, level: pickedTower.level + 1 })}
              onSell={() => order({ plot: pickedTower.plot, kind: null, level: 0 })}
              onClose={() => setPicked(null)}
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
                {hud.phase === 'build' && (
                  <button
                    onClick={startNow}
                    className="flex items-center gap-1 rounded-xl bg-emerald-400 px-3 py-1.5 text-[11px] font-black text-emerald-950"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" /> Start
                  </button>
                )}
                {session.rules.sends && session.rules.mode === 'siege' && config.seats.length > 1 && (
                  <button
                    onClick={() => setShowSends((s) => !s)}
                    className="flex items-center gap-1 rounded-xl border border-violet-400/50 bg-violet-500/20 px-3 py-1.5 text-[11px] font-black text-violet-200"
                  >
                    <Send className="h-3.5 w-3.5" /> Send
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {spectating && (
        <div className="z-30 shrink-0 border-t border-white/10 bg-slate-950/80 p-3 text-center text-[11px] font-bold text-white/50 backdrop-blur-md">
          Watching {engine?.name ?? 'another keep'} — your own towers are on your own board.
        </div>
      )}

      {/* ── sending ── */}
      {showSends && !spectating && (
        <div className="absolute inset-0 z-40 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center">
          <div className="max-h-[88dvh] w-full max-w-sm overflow-y-auto overscroll-contain space-y-2 rounded-[1.75rem] border border-white/15 bg-slate-900/95 p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-black">Send a horde</h3>
              <button onClick={() => setShowSends(false)} className="rounded-lg p-1.5 hover:bg-white/10">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[11px] text-white/50">
              Lands on every other keep at wave {Math.min(hud.wave + 2, session.rules.waves)}. It costs more than it pays
              them in bounty, so it is a real bet.
            </p>
            {SENDS.map((s) => (
              <button
                key={s.kind}
                disabled={hud.gold < s.cost}
                onClick={() => buySend(s.kind, s.count, s.cost)}
                className="flex w-full items-center justify-between rounded-xl border border-white/12 bg-white/5 px-3 py-2.5 text-left disabled:opacity-40"
              >
                <span className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ background: ENEMIES[s.kind].body }} />
                  <span className="text-sm font-bold">{s.label}</span>
                </span>
                <span className="text-sm font-black text-amber-300">{s.cost}g</span>
              </button>
            ))}
          </div>
        </div>
      )}

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
                {over.won ? (session.rules.mode === 'alliance' ? 'The line held' : 'Last keep standing') : 'Your keep fell'}
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
                    {board[i]?.down ? 'fell' : `wave ${(board[i]?.wave ?? 0) + 1}`}
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
            {!over.won && config.seats.length > 1 && (
              <button
                onClick={() => setOver(null)}
                className="w-full text-[11px] font-bold text-white/40 hover:text-white/70"
              >
                Keep watching the others
              </button>
            )}
          </div>
        </div>
      )}

      {/* First touch unlocks audio and, when not embedded, goes fullscreen. */}
      <div
        className="pointer-events-none absolute inset-0"
        onPointerDown={() => {
          audioService.unlock();
          if (IN_IFRAME || document.fullscreenElement) return;
          toggleFullscreen(shellRef.current ?? document.documentElement, true);
        }}
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
}: {
  engine: SiegeEngine | undefined;
  plot: number;
  onUpgrade: () => void;
  onSell: () => void;
  onClose: () => void;
}) {
  const tower = engine?.towerAt(plot);
  if (!engine || !tower) return null;
  const meta = TOWERS[tower.kind];
  const lv = meta.levels[tower.level];
  const next = tower.level < 2 ? meta.levels[tower.level + 1] : null;
  const upCost = next ? next.cost : 0;
  const canUp = next !== null && engine.gold >= upCost;

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-xs font-black">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: meta.trim }} />
          {meta.name}
          <span className="text-white/40">lvl {tower.level + 1}</span>
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
        className="rounded-xl border border-rose-400/40 bg-rose-500/15 px-3 py-2 text-[11px] font-black text-rose-200"
      >
        Sell {engine.refundOf(plot)}g
      </button>
      <button onClick={onClose} aria-label="Close" className="rounded-xl p-2 hover:bg-white/10">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
