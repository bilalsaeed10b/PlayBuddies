/**
 * One logging system, shared by every game, that works in a real playtest.
 *
 * The thing this replaces did not. It was gated on `import.meta.env.DEV` and
 * shipped to a Vite dev-server plugin, which means it was inert in exactly the
 * two situations anybody actually plays in -- the LAN host and GitHub Pages,
 * both of which serve production bundles -- and its collector did not exist on
 * the LAN host at all. Four phones in a room produced precisely nothing to
 * read afterward.
 *
 * What this is instead:
 *
 *   - On in production. A playtest on four devices is the only place the
 *     interesting bugs live, so that is the case the logger is built for.
 *   - Batched and fire-and-forget. Gameplay never waits on a log line, and a
 *     dropped line is never worth surfacing.
 *   - Self-instrumenting for failure. Uncaught errors, unhandled rejections
 *     and console.error/warn are captured without any game asking, because
 *     "did it run fine" is mostly a question about things nobody predicted.
 *   - Correlated. Every line carries a client id, a per-client sequence, and
 *     -- once a game knows it -- the room code, so four devices' logs merge
 *     into one readable timeline of one match.
 *
 * What it is NOT is a trace of every function call. A 60fps loop would bury
 * the signal in millions of lines and cost frames doing it. Log discrete,
 * meaningful events: a packet in or out, a turn changing hands, a connection
 * dropping, a round resolving.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Client wall clock. Useful, but never trusted for ordering -- see `seq`. */
  t: string;
  /**
   * Per-client monotonic counter.
   *
   * Four phones do not agree on the time to better than a few seconds, so
   * wall clock cannot order a merged log. This orders one client's own lines
   * with certainty; the collector stamps a global arrival order for the rest.
   */
  seq: number;
  lvl: Level;
  game: string;
  /** Random per tab, so two tabs on one machine are still two players. */
  client: string;
  /** The lobby code, once the game knows it. The key that groups a match. */
  room?: string;
  /** Display name, so a line reads as a person rather than a uid. */
  who?: string;
  ev: string;
  data?: Record<string, unknown>;
}

/** Message understood by the PlayWithBuddies lobby shell around every game. */
const REMOTE_MESSAGE = 'diagnostics';

/** How many entries to keep in memory for a manual dump when there is no collector. */
const RING = 3000;
/** Ship a batch at least this often, and whenever it reaches BATCH_MAX. */
const FLUSH_MS = 1000;
const BATCH_MAX = 40;
/** Give up on the network after this many consecutive failures (GitHub Pages has no collector). */
const MAX_FAILS = 3;

const ENDPOINT = '/__log';

function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

class Logger {
  private clientId = randomId();
  private seq = 0;
  private ring: LogEntry[] = [];
  private pending: LogEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fails = 0;
  private shipping = true;
  private room: string | undefined;
  private who: string | undefined;
  /** Guards the console wrappers against logging their own output forever. */
  private inConsole = false;
  private installed = false;
  private stateAt = new Map<string, number>();

  get id(): string {
    return this.clientId;
  }

  /**
   * Attach the match this client is in.
   *
   * Called as soon as a game knows its room code. Everything logged after
   * this point carries it, which is what lets four devices' lines be pulled
   * out of a day's logs as one match.
   */
  setContext(ctx: { room?: string; who?: string }) {
    if (ctx.room) this.room = ctx.room;
    if (ctx.who) this.who = ctx.who;
  }

  write(lvl: Level, game: string, ev: string, data?: Record<string, unknown>) {
    let entry: LogEntry;
    try {
      entry = {
        t: new Date().toISOString(),
        seq: ++this.seq,
        lvl,
        game,
        client: this.clientId,
        ...(this.room ? { room: this.room } : {}),
        ...(this.who ? { who: this.who } : {}),
        ev,
        ...(data && Object.keys(data).length ? { data: safe(data) } : {}),
      };
    } catch {
      return; // logging must never be the thing that breaks a game
    }

    this.ring.push(entry);
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);

    if (!this.inConsole) {
      this.inConsole = true;
      try {
        const line = `[${game}] ${ev}`;
        if (lvl === 'error') console.error(line, data ?? '');
        else if (lvl === 'warn') console.warn(line, data ?? '');
        else console.log(line, data ?? '');
      } catch {
        /* a console that refuses is not a reason to stop */
      }
      this.inConsole = false;
    }

    // A production game is framed by the authenticated PlayWithBuddies lobby.
    // Even after the same-origin /__log endpoint proves absent on GitHub
    // Pages, that parent remains a working route to the remote collector.
    if (!this.shipping && !this.hasParentCollector()) return;
    this.pending.push(entry);
    if (this.pending.length >= BATCH_MAX) this.flush();
    else if (this.timer === null) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Everything this tab has logged, for a manual dump where no collector exists. */
  dump(): LogEntry[] {
    return [...this.ring];
  }

  flush(useBeacon = false) {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const body = JSON.stringify(batch);

    this.relayToParent(batch);

    // Once a static host has returned enough 404s, stop probing it. Remote
    // delivery above is independent and continues for the life of the frame.
    if (!this.shipping) return;

    // On the way out of a page, fetch() is unreliable and sendBeacon is the
    // only thing the browser promises to finish -- which is exactly when the
    // most interesting line (a disconnect, a crash) gets written.
    if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
        return;
      } catch {
        /* fall through to fetch */
      }
    }

    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    })
      .then((res) => {
        if (res.ok) {
          this.fails = 0;
          return;
        }
        this.noteFailure();
      })
      .catch(() => this.noteFailure());
  }

  /**
   * There is no collector here.
   *
   * Served from GitHub Pages there is nothing listening on /__log, and
   * retrying forever would mean a failed request per second for the whole
   * session. Stop shipping, keep buffering: `dump()` still has everything.
   */
  private noteFailure() {
    this.fails++;
    if (this.fails >= MAX_FAILS) this.shipping = false;
  }

  private hasParentCollector(): boolean {
    try {
      return typeof window !== 'undefined' && window.parent !== window;
    } catch {
      return false;
    }
  }

  /**
   * Public deployments are static, so their authenticated parent page is the
   * collector. The parent verifies both origin and source window before it
   * accepts this batch; a random page cannot post logs into somebody's room.
   */
  private relayToParent(batch: LogEntry[]) {
    if (!this.hasParentCollector()) return;
    try {
      window.parent.postMessage(
        { source: 'playbuddies-game', type: REMOTE_MESSAGE, version: 1, entries: batch },
        window.location.origin,
      );
    } catch {
      /* diagnostics are never allowed to disturb a match */
    }
  }

  /** A cheap, throttled state sample for cross-device desync detection. */
  state(game: string, data: Record<string, unknown>) {
    const now = Date.now();
    if (now - (this.stateAt.get(game) ?? 0) < 5000) return;
    this.stateAt.set(game, now);
    this.write('debug', game, 'state:heartbeat', {
      ...data,
      visibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
    });
  }

  /**
   * Capture the failures nobody wrote a log line for.
   *
   * This is most of the value of the whole system: "did the game run fine"
   * is usually answered by something no one predicted, so an uncaught error
   * on somebody's phone has to end up in the same timeline as the turns.
   */
  install(game: string) {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;

    window.addEventListener('error', (e) => {
      this.write('error', game, 'js:error', {
        message: String(e.message ?? ''),
        source: `${e.filename ?? ''}:${e.lineno ?? 0}`,
        stack: e.error?.stack ? String(e.error.stack).split('\n').slice(0, 4).join(' | ') : undefined,
      });
      this.flush();
    });

    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason as { message?: string; stack?: string } | undefined;
      this.write('error', game, 'js:unhandled-rejection', {
        message: String(reason?.message ?? reason ?? ''),
        stack: reason?.stack ? String(reason.stack).split('\n').slice(0, 4).join(' | ') : undefined,
      });
      this.flush();
    });

    // A last flush on the way out. `pagehide` fires on a real close and on a
    // phone locking its screen alike; both are moments a log is worth having.
    window.addEventListener('pagehide', () => this.flush(true));
    document.addEventListener('visibilitychange', () => {
      this.write('info', game, 'client:visibility', { state: document.visibilityState });
      if (document.visibilityState === 'hidden') this.flush(true);
    });
    window.addEventListener('online', () => this.write('info', game, 'client:network', { online: true }));
    window.addEventListener('offline', () => {
      this.write('warn', game, 'client:network', { online: false });
      this.flush(true);
    });

    const startedAt = Date.now();
    window.setInterval(() => {
      this.write('debug', game, 'client:heartbeat', {
        elapsedMs: Date.now() - startedAt,
        visibility: document.visibilityState,
        online: navigator.onLine,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        build: new URLSearchParams(window.location.search).get('v') ?? 'unknown',
      });
    }, 15_000);

    for (const level of ['error', 'warn'] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        original(...args);
        if (this.inConsole) return;
        this.inConsole = true;
        try {
          this.write(level, game, `console:${level}`, { args: args.map(brief).slice(0, 4) });
        } catch {
          /* ignore */
        }
        this.inConsole = false;
      };
    }
  }
}

const logger = new Logger();

/** One entry point per game, so no call site repeats the game's own name. */
export interface GameLogger {
  debug(ev: string, data?: Record<string, unknown>): void;
  info(ev: string, data?: Record<string, unknown>): void;
  warn(ev: string, data?: Record<string, unknown>): void;
  error(ev: string, data?: Record<string, unknown>): void;
  /** At most one compact state sample every five seconds. */
  state(data: Record<string, unknown>): void;
  /** Attach the room code and player name once the lobby is known. */
  context(ctx: { room?: string; who?: string }): void;
  /** Everything this tab has recorded -- for a device with no collector to reach. */
  dump(): LogEntry[];
  flush(): void;
  readonly clientId: string;
}

export function createLogger(game: string): GameLogger {
  logger.install(game);
  const api: GameLogger = {
    debug: (ev, data) => logger.write('debug', game, ev, data),
    info: (ev, data) => logger.write('info', game, ev, data),
    warn: (ev, data) => logger.write('warn', game, ev, data),
    error: (ev, data) => logger.write('error', game, ev, data),
    state: (data) => logger.state(game, data),
    context: (ctx) => logger.setContext(ctx),
    dump: () => logger.dump(),
    flush: () => logger.flush(),
    get clientId() {
      return logger.id;
    },
  };
  // A handle for pulling the log off a device that could not reach a
  // collector -- open the console on the phone, or read it from a driven
  // browser, and copy what it returns.
  try {
    (window as unknown as { __gamelog?: unknown }).__gamelog = {
      dump: () => logger.dump(),
      text: () => logger.dump().map((e) => JSON.stringify(e)).join('\n'),
      flush: () => logger.flush(),
    };
  } catch {
    /* no window: nothing to hang it off */
  }
  return api;
}

/** Trim anything unbounded before it goes on the wire or into the ring. */
function brief(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'object' && value !== null) {
    try {
      const json = JSON.stringify(value);
      return json.length > 300 ? `${json.slice(0, 300)}…` : JSON.parse(json);
    } catch {
      return '[unserialisable]';
    }
  }
  return value;
}

/**
 * A payload that is certain to survive JSON.stringify.
 *
 * Game state is full of cyclic references and class instances, and a logger
 * that throws on one of them takes the game down with it.
 */
function safe(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    out[k] = brief(v);
  }
  return out;
}
