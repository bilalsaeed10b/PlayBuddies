/**
 * Wall-time simulation, independent of canvas painting. Hidden timers are only
 * best effort: a browser may suspend all JavaScript. When callbacks return, the
 * unprocessed time is retained and paid down in bounded fixed-step batches.
 *
 * Safe to import during a static export: browser globals are read only by
 * startBattleClock(), which belongs inside the view's effect.
 */

export interface BattleClockRuntime {
  /** Wall time in milliseconds, including time spent asleep (normally Date.now). */
  now(): number;
  /** Monotonic milliseconds used only to budget CPU work (performance.now). */
  workNow(): number;
  isHidden(): boolean;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  setInterval(callback: () => void, delayMs: number): number;
  clearInterval(id: number): void;
  subscribeLifecycle(callback: (reason: 'visibility' | 'resume') => void): () => void;
}

export interface BattleClockResume {
  reason: 'visible' | 'resume' | 'gap';
  elapsedMs: number;
  debtMs: number;
  hiddenForMs: number;
  /** Aborted by stop(); asynchronous network work must respect this signal. */
  signal: AbortSignal;
}

/**
 * Return 'reset' after applying a current authoritative snapshot, or immediately
 * after starting an engine-owned resync that gates stale actions. Replaying old
 * debt on top of a snapshot would advance the match twice. Returning void keeps
 * the debt, suitable when the simulation is still behind.
 */
export type BattleClockResumeResult = 'reset' | void;

export interface BattleClockFrame {
  /** Actual time since the last visible paint callback, never a catch-up step. */
  elapsedSeconds: number;
  steps: number;
  debtMs: number;
}

export interface BattleClockOptions {
  step(dtSeconds: number): void;
  /** Paint/HUD work runs only on visible animation frames, once per frame. */
  frame?(frame: BattleClockFrame): void;
  /**
   * Called before any resume catch-up. An online caller should return a promise
   * that settles after reconciling fresh network state, not just after sending
   * a sync request. Alternatively, an engine that gates its own updates while
   * resyncing can requestSync() synchronously and return 'reset' immediately.
   * No simulation or painting runs while a returned promise is pending.
   * Rejection stops the clock and reports onError instead of advancing stale state.
   */
  beforeResume?(resume: BattleClockResume): BattleClockResumeResult | Promise<BattleClockResumeResult>;
  onError?(error: unknown): void;
  /** Defaults to 1/60 second; small enough for BattleEngine's inner physics cap. */
  stepSeconds?: number;
  /** Defaults to 120 updates (two simulated seconds) per callback. */
  maxStepsPerTick?: number;
  /** Defaults to 8 ms. One step always runs; a step itself cannot be preempted. */
  maxWorkMs?: number;
  /** Defaults to 250 ms; the browser is free to throttle or suspend this timer. */
  hiddenIntervalMs?: number;
  /** Callback gaps of at least 2000 ms (including hidden) trigger beforeResume. */
  resumeGapMs?: number;
}

export interface BattleClock {
  readonly running: boolean;
  readonly resuming: boolean;
  /** Outstanding time as of the last callback, in milliseconds. */
  readonly debtMs: number;
  /** Use immediately after replacing the simulation with current network state. */
  resetDebt(): void;
  /** Idempotent; removes both timers, lifecycle listeners and pending resumption. */
  stop(): void;
}

function browserRuntime(): BattleClockRuntime {
  return {
    now: () => Date.now(),
    workNow: () => performance.now(),
    isHidden: () => document.visibilityState === 'hidden',
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (id) => window.clearInterval(id),
    subscribeLifecycle: (callback) => {
      const visibility = () => callback('visibility');
      const resume = () => callback('resume');
      const show = (event: PageTransitionEvent) => {
        if (event.persisted) resume();
      };
      document.addEventListener('visibilitychange', visibility);
      document.addEventListener('resume', resume);
      window.addEventListener('pageshow', show);
      return () => {
        document.removeEventListener('visibilitychange', visibility);
        document.removeEventListener('resume', resume);
        window.removeEventListener('pageshow', show);
      };
    },
  };
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`);
  return value;
}

export function startBattleClock(
  options: BattleClockOptions,
  runtime: BattleClockRuntime = browserRuntime(),
): BattleClock {
  const stepSeconds = positive(options.stepSeconds ?? 1 / 60, 'stepSeconds');
  const stepMs = stepSeconds * 1000;
  const maxSteps = positive(options.maxStepsPerTick ?? 120, 'maxStepsPerTick');
  if (!Number.isInteger(maxSteps)) throw new RangeError('maxStepsPerTick must be an integer');
  const maxWorkMs = positive(options.maxWorkMs ?? 8, 'maxWorkMs');
  const intervalMs = positive(options.hiddenIntervalMs ?? 250, 'hiddenIntervalMs');
  const resumeGapMs = positive(options.resumeGapMs ?? 2000, 'resumeGapMs');
  const abort = new AbortController();
  let running = true;
  let hidden = runtime.isHidden();
  let lastWall = runtime.now();
  let lastPaint = lastWall;
  let hiddenSince: number | null = hidden ? lastWall : null;
  let debt = 0;
  let raf: number | null = null;
  let interval: number | null = null;
  let unsubscribe: (() => void) | undefined;
  let pending: object | null = null;

  const clock: BattleClock = {
    get running() { return running; },
    get resuming() { return pending !== null; },
    get debtMs() { return debt; },
    resetDebt() {
      if (!running) return;
      debt = 0;
      lastWall = runtime.now();
    },
    stop() {
      if (!running) return;
      running = false;
      pending = null;
      if (raf !== null) runtime.cancelFrame(raf);
      if (interval !== null) runtime.clearInterval(interval);
      raf = null;
      interval = null;
      unsubscribe?.();
      abort.abort();
    },
  };

  function fail(error: unknown) {
    clock.stop();
    if (options.onError) options.onError(error);
    else console.error('[battleClock] stopped', error);
  }

  function accrue(now: number): number {
    // Keep a high-water mark if the system clock moves backwards, avoiding both
    // negative simulation and counting the same period again on the next tick.
    const elapsed = Math.max(0, now - lastWall);
    lastWall = Math.max(lastWall, now);
    debt += elapsed;
    return elapsed;
  }

  function scheduleFrame() {
    if (!running || hidden || pending || raf !== null) return;
    raf = runtime.requestFrame(() => {
      raf = null;
      pulse('frame');
    });
  }

  function resume(info: Omit<BattleClockResume, 'signal'>) {
    if (!options.beforeResume || pending) return;
    const token = {};
    pending = token;
    const complete = (result: BattleClockResumeResult) => {
      if (!running || pending !== token) return;
      accrue(runtime.now());
      if (result === 'reset') clock.resetDebt();
      pending = null;
      scheduleFrame();
    };
    const reject = (error: unknown) => {
      if (running && pending === token) fail(error);
    };
    try {
      const result = options.beforeResume({ ...info, signal: abort.signal });
      if (result && typeof result === 'object') void result.then(complete, reject);
      else complete(result);
    } catch (error) {
      reject(error);
    }
  }

  function pulse(source: 'frame' | 'interval' | 'visibility' | 'resume') {
    if (!running) return;
    try {
      const now = runtime.now();
      const elapsedMs = accrue(now);
      const wasHidden = hidden;
      hidden = runtime.isHidden();
      const becameVisible = wasHidden && !hidden;
      const hiddenForMs = hiddenSince === null ? 0 : Math.max(0, now - hiddenSince);
      if (hidden && !wasHidden) hiddenSince = now;
      if (!hidden) hiddenSince = null;
      if (hidden && raf !== null) {
        runtime.cancelFrame(raf);
        raf = null;
      }

      if (becameVisible || source === 'resume' || elapsedMs >= resumeGapMs) {
        resume({
          reason: becameVisible ? 'visible' : source === 'resume' ? 'resume' : 'gap',
          elapsedMs,
          debtMs: debt,
          hiddenForMs,
        });
      }

      if (!running || pending) return;
      // Lifecycle events account for time and request resync, but leave actual
      // simulation to a bounded timer/frame callback.
      if (source === 'frame' || source === 'interval') {
        const began = runtime.workNow();
        let steps = 0;
        // Tiny tolerance prevents 60 nominal 1/60 steps becoming 59 through
        // floating-point subtraction. It never removes a whole unpaid step.
        while (running && debt + 1e-7 >= stepMs && steps < maxSteps) {
          if (steps > 0 && runtime.workNow() - began >= maxWorkMs) break;
          debt = Math.max(0, debt - stepMs);
          steps++;
          options.step(stepSeconds);
        }
        if (running && !hidden && source === 'frame') {
          const elapsedSeconds = Math.max(0, now - lastPaint) / 1000;
          lastPaint = Math.max(lastPaint, now);
          options.frame?.({ elapsedSeconds, steps, debtMs: debt });
        }
      }
      scheduleFrame();
    } catch (error) {
      fail(error);
    }
  }

  unsubscribe = runtime.subscribeLifecycle((reason) => pulse(reason));
  interval = runtime.setInterval(() => {
    // Checking both handles a visibility transition even if its event was lost.
    if (hidden || runtime.isHidden()) pulse('interval');
  }, intervalMs);
  scheduleFrame();
  return clock;
}
