// Run from the repo root with Node 20+: node --test games/battle-of-pirates/tests/battleClock.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './loadModule.mjs';
const { startBattleClock } = await loadModule(new URL('../src/engine/battleClock.ts', import.meta.url));

class FakeRuntime {
  wall = 10_000;
  cpu = 0;
  hidden = false;
  nextId = 0;
  frames = new Map();
  intervals = new Map();
  listeners = new Set();

  now() { return this.wall; }
  workNow() { return this.cpu; }
  isHidden() { return this.hidden; }
  requestFrame(callback) {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  }
  cancelFrame(id) { this.frames.delete(id); }
  setInterval(callback, delayMs) {
    const id = this.nextId++;
    this.intervals.set(id, { callback, delayMs });
    return id;
  }
  clearInterval(id) { this.intervals.delete(id); }
  subscribeLifecycle(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  advance(ms) { this.wall += ms; }
  frame() {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback();
  }
  interval() {
    for (const { callback } of [...this.intervals.values()]) callback();
  }
  lifecycle(reason) {
    for (const callback of [...this.listeners]) callback(reason);
  }
  visibility(hidden) {
    this.hidden = hidden;
    this.lifecycle('visibility');
  }
  assertStopped() {
    assert.equal(this.frames.size, 0, 'no animation frame survives stop');
    assert.equal(this.intervals.size, 0, 'no background timer survives stop');
    assert.equal(this.listeners.size, 0, 'no lifecycle listener survives stop');
  }
}

function fixture(options = {}, hidden = false) {
  const runtime = new FakeRuntime();
  runtime.hidden = hidden;
  const steps = [];
  const paints = [];
  const clock = startBattleClock({
    step: (dt) => steps.push(dt),
    frame: (info) => paints.push(info),
    ...options,
  }, runtime);
  return { runtime, clock, steps, paints };
}

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not close to ${expected}`);
}

test('foreground uses fixed steps, keeps fractional debt and paints once', () => {
  const { runtime, clock, steps, paints } = fixture({ stepSeconds: 0.01 });
  runtime.advance(25);
  runtime.frame();
  assert.deepEqual(steps, [0.01, 0.01]);
  closeTo(clock.debtMs, 5);
  assert.deepEqual(paints, [{ elapsedSeconds: 0.025, steps: 2, debtMs: 5 }]);
  runtime.interval();
  assert.equal(steps.length, 2, 'visible interval must not run another batch');
  runtime.advance(5);
  runtime.frame();
  assert.equal(steps.length, 3);
  assert.equal(runtime.frames.size, 1);
  clock.stop();
});

test('default rate accounts for all sixty steps in one second', () => {
  const { runtime, clock, steps } = fixture();
  runtime.advance(1000);
  runtime.frame();
  assert.equal(steps.length, 60);
  assert.ok(steps.every((dt) => dt === 1 / 60));
  closeTo(clock.debtMs, 0);
  clock.stop();
});

test('a match started hidden advances on throttled intervals without painting', () => {
  const { runtime, clock, steps, paints } = fixture({}, true);
  assert.equal(runtime.frames.size, 0);
  assert.equal([...runtime.intervals.values()][0].delayMs, 250);
  for (let i = 0; i < 10; i++) {
    runtime.advance(1000); // A throttled browser need not honor the 250 ms request.
    runtime.interval();
  }
  assert.equal(steps.length, 600);
  assert.equal(paints.length, 0);
  closeTo(clock.debtMs, 0);
  clock.stop();
  runtime.assertStopped();
});

test('hiding cancels painting and normal hidden intervals still advance online', () => {
  let syncs = 0;
  const { runtime, clock, steps, paints } = fixture({
    beforeResume: () => { syncs++; return 'reset'; },
  });
  runtime.visibility(true);
  assert.equal(runtime.frames.size, 0);
  for (let i = 0; i < 4; i++) {
    runtime.advance(250);
    runtime.interval();
  }
  assert.equal(steps.length, 60);
  assert.equal(syncs, 0);
  assert.equal(paints.length, 0);
  clock.stop();
});

test('online foreground requests sync before discarding stale sleep debt', () => {
  const events = [];
  let resumeInfo;
  const { runtime, clock } = fixture({
    step: () => events.push('step'),
    beforeResume: (info) => {
      resumeInfo = info;
      events.push('sync'); // engine.requestSync() may gate its own updates.
      return 'reset';
    },
  });
  runtime.visibility(true);
  runtime.advance(60_000); // No callbacks at all during suspension.
  assert.equal(events.length, 0);
  runtime.visibility(false);
  assert.deepEqual(events, ['sync']);
  assert.equal(resumeInfo.reason, 'visible');
  assert.equal(resumeInfo.hiddenForMs, 60_000);
  assert.equal(resumeInfo.debtMs, 60_000);
  runtime.frame();
  assert.deepEqual(events, ['sync']);
  closeTo(clock.debtMs, 0);
  runtime.advance(17);
  runtime.frame();
  assert.deepEqual(events, ['sync', 'step']);
  clock.stop();
});

for (const hidden of [false, true]) {
  test(`online ${hidden ? 'hidden' : 'visible'} gap >= 2s syncs and drops old time`, () => {
    const events = [];
    const { runtime, clock } = fixture({
      step: () => events.push('step'),
      beforeResume: (info) => {
        assert.equal(info.reason, 'gap');
        events.push('sync');
        return 'reset';
      },
    }, hidden);
    runtime.advance(2000);
    if (hidden) runtime.interval();
    else runtime.frame();
    assert.deepEqual(events, ['sync']);
    closeTo(clock.debtMs, 0);
    runtime.advance(1000);
    if (hidden) runtime.interval();
    else runtime.frame();
    assert.equal(events.length, 61, 'normal wakeups still advance sixty steps');
    clock.stop();
  });
}

test('offline resume retains the whole suspension debt and pays it in bounded batches', () => {
  const { runtime, clock, steps } = fixture({ stepSeconds: 0.1, maxStepsPerTick: 5 });
  runtime.visibility(true);
  runtime.advance(120_000);
  runtime.visibility(false);
  assert.equal(steps.length, 0, 'visibility event does no synchronous simulation');
  runtime.frame();
  assert.equal(steps.length, 5);
  assert.equal(clock.debtMs, 119_500);
  runtime.frame();
  assert.equal(steps.length, 10);
  assert.equal(clock.debtMs, 119_000);
  for (let i = 0; i < 238; i++) runtime.frame();
  assert.equal(steps.length, 1200);
  assert.equal(clock.debtMs, 0);
  clock.stop();
});

test('hidden catch-up also respects the maximum work per callback', () => {
  const { runtime, clock, steps } = fixture({ stepSeconds: 0.01, maxStepsPerTick: 3 }, true);
  runtime.advance(60_000);
  runtime.interval();
  assert.equal(steps.length, 3);
  assert.equal(clock.debtMs, 59_970);
  runtime.interval();
  assert.equal(steps.length, 6);
  assert.equal(clock.debtMs, 59_940);
  clock.stop();
});

test('CPU budget yields while preserving unpaid time', () => {
  const runtime = new FakeRuntime();
  let steps = 0;
  const clock = startBattleClock({
    stepSeconds: 0.01,
    maxWorkMs: 5,
    step: () => { steps++; runtime.cpu += 3; },
  }, runtime);
  runtime.advance(1000);
  runtime.frame();
  assert.equal(steps, 2); // Check at each boundary; the second step finishes at 6 ms.
  assert.equal(clock.debtMs, 980);
  runtime.frame();
  assert.equal(steps, 4);
  assert.equal(clock.debtMs, 960);
  clock.stop();
});

test('one expensive step can finish but a second cannot exceed the CPU budget', () => {
  const runtime = new FakeRuntime();
  let steps = 0;
  const clock = startBattleClock({
    stepSeconds: 0.01,
    maxWorkMs: 5,
    step: () => { steps++; runtime.cpu += 20; },
  }, runtime);
  runtime.advance(1000);
  runtime.frame();
  assert.equal(steps, 1);
  assert.equal(clock.debtMs, 990);
  clock.stop();
});

test('asynchronous resync blocks all simulation until the fresh snapshot is applied', async () => {
  let finish;
  let syncs = 0;
  const { runtime, clock, steps, paints } = fixture({
    beforeResume: () => {
      syncs++;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  runtime.visibility(true);
  runtime.advance(5000);
  runtime.visibility(false);
  assert.equal(clock.resuming, true);
  runtime.lifecycle('resume');
  runtime.frame();
  runtime.advance(5000);
  runtime.interval();
  assert.equal(syncs, 1, 'lifecycle events cannot duplicate an in-flight request');
  assert.equal(steps.length, 0);
  assert.equal(paints.length, 0);
  finish('reset');
  await Promise.resolve();
  assert.equal(clock.resuming, false);
  assert.equal(clock.debtMs, 0, 'snapshot also replaces time spent waiting for sync');
  assert.equal(runtime.frames.size, 1);
  runtime.advance(17);
  runtime.frame();
  assert.equal(syncs, 1, 'the network wait itself must not trigger another sync');
  assert.equal(steps.length, 1);
  clock.stop();
});

test('a resume callback may keep debt, including time spent awaiting the callback', async () => {
  let finish;
  const { runtime, clock, steps } = fixture({
    beforeResume: () => new Promise((resolve) => { finish = resolve; }),
  });
  runtime.visibility(true);
  runtime.advance(1000);
  runtime.visibility(false);
  runtime.advance(500);
  finish();
  await Promise.resolve();
  closeTo(clock.debtMs, 1500);
  runtime.frame();
  assert.equal(steps.length, 90);
  closeTo(clock.debtMs, 0);
  clock.stop();
});

test('failed asynchronous resync stops cleanly without stale simulation', async () => {
  const problem = new Error('snapshot unavailable');
  const errors = [];
  const { runtime, clock, steps } = fixture({
    beforeResume: () => Promise.reject(problem),
    onError: (error) => errors.push(error),
  });
  runtime.advance(5000);
  runtime.frame();
  await Promise.resolve();
  assert.deepEqual(errors, [problem]);
  assert.equal(clock.running, false);
  assert.equal(steps.length, 0);
  runtime.assertStopped();
});

test('failed synchronous resync stops before stale simulation', () => {
  const problem = new Error('cannot request snapshot');
  const errors = [];
  const { runtime, clock, steps } = fixture({
    beforeResume: () => { throw problem; },
    onError: (error) => errors.push(error),
  });
  runtime.advance(5000);
  runtime.frame();
  assert.deepEqual(errors, [problem]);
  assert.equal(clock.running, false);
  assert.equal(steps.length, 0);
  runtime.assertStopped();
});

test('stop removes timers/listeners and stale queued callbacks cannot restart them', () => {
  const { runtime, clock, steps, paints } = fixture();
  const staleFrame = [...runtime.frames.values()][0];
  const staleInterval = [...runtime.intervals.values()][0].callback;
  const staleListener = [...runtime.listeners][0];
  clock.stop();
  clock.stop();
  runtime.advance(60_000);
  staleFrame();
  runtime.hidden = true;
  staleInterval();
  staleListener('resume');
  assert.equal(clock.running, false);
  assert.equal(steps.length, 0);
  assert.equal(paints.length, 0);
  runtime.assertStopped();
});

test('stop from inside a step immediately ends a catch-up batch and skips painting', () => {
  let steps = 0;
  const { runtime, clock, paints } = fixture({ step: () => { steps++; clock.stop(); } });
  runtime.advance(1000);
  runtime.frame();
  assert.equal(steps, 1);
  assert.equal(paints.length, 0);
  runtime.assertStopped();
});

test('stop aborts pending resync and its eventual success cannot restart the clock', async () => {
  let finish;
  let signal;
  const { runtime, clock, steps } = fixture({
    beforeResume: (info) => {
      signal = info.signal;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  runtime.advance(60_000);
  runtime.frame();
  clock.stop();
  assert.equal(signal.aborted, true);
  finish('reset');
  await Promise.resolve();
  assert.equal(clock.resuming, false);
  assert.equal(steps.length, 0);
  runtime.assertStopped();
});

test('a resync rejection arriving after stop is handled without another error report', async () => {
  let reject;
  const errors = [];
  const { runtime, clock } = fixture({
    beforeResume: () => new Promise((_, fail) => { reject = fail; }),
    onError: (error) => errors.push(error),
  });
  runtime.advance(5000);
  runtime.frame();
  clock.stop();
  reject(new Error('aborted'));
  await Promise.resolve();
  assert.deepEqual(errors, []);
  runtime.assertStopped();
});

test('resetDebt rebases time when network code applies a replacement snapshot later', () => {
  const { runtime, clock, steps } = fixture({ maxStepsPerTick: 1 });
  runtime.advance(60_000);
  runtime.frame();
  assert.equal(steps.length, 1);
  runtime.advance(3000);
  clock.resetDebt();
  runtime.advance(17);
  runtime.frame();
  assert.equal(steps.length, 2);
  closeTo(clock.debtMs, 17 - 1000 / 60);
  clock.stop();
});

test('a backwards wall-clock correction cannot create negative or duplicate time', () => {
  const { runtime, clock, steps } = fixture();
  runtime.advance(100);
  runtime.frame();
  assert.equal(steps.length, 6);
  runtime.advance(-50);
  runtime.frame();
  runtime.advance(50);
  runtime.frame();
  assert.equal(steps.length, 6);
  runtime.advance(100);
  runtime.frame();
  assert.equal(steps.length, 12);
  clock.stop();
});

test('visibility is also checked by callbacks when a visibility event was missed', () => {
  let syncs = 0;
  const { runtime, clock, paints } = fixture({
    beforeResume: () => { syncs++; return 'reset'; },
  });
  runtime.hidden = true;
  runtime.advance(250);
  runtime.frame();
  assert.equal(paints.length, 0);
  assert.equal(runtime.frames.size, 0);
  runtime.hidden = false;
  runtime.advance(250);
  runtime.interval();
  assert.equal(syncs, 1);
  assert.equal(clock.debtMs, 0);
  assert.equal(runtime.frames.size, 1);
  clock.stop();
});

test('explicit page restoration requests resync without duplicating the frame loop', () => {
  let syncs = 0;
  const { runtime, clock, steps } = fixture({
    beforeResume: () => { syncs++; return 'reset'; },
  });
  runtime.advance(1000);
  runtime.lifecycle('resume');
  assert.equal(syncs, 1);
  assert.equal(steps.length, 0);
  assert.equal(runtime.frames.size, 1);
  runtime.frame();
  assert.equal(runtime.frames.size, 1);
  clock.stop();
});

test('invalid limits are rejected before any resources are installed', () => {
  for (const options of [
    { stepSeconds: 0 }, { stepSeconds: NaN }, { stepSeconds: Infinity },
    { maxStepsPerTick: 0 }, { maxStepsPerTick: 1.5 },
    { maxWorkMs: -1 }, { hiddenIntervalMs: 0 }, { resumeGapMs: 0 },
  ]) {
    const runtime = new FakeRuntime();
    assert.throws(() => startBattleClock({ step: () => {}, ...options }, runtime), RangeError);
    runtime.assertStopped();
  }
});
