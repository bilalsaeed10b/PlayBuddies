import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './loadModule.mjs';

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const { currentWeekId, recordBattle, readStats } = await loadModule(new URL('../src/platform/stats.ts', import.meta.url));

test('weekly aim leaderboard uses one shared Monday-Sunday UTC window', () => {
  assert.equal(currentWeekId(new Date('2026-09-13T23:59:59Z')), '2026-09-07');
  assert.equal(currentWeekId(new Date('2026-09-14T00:00:00Z')), '2026-09-14');
});

test('a new week retains all-time accuracy but starts its weekly accuracy fresh', () => {
  store.clear();
  store.set('pirates_stats_v1', JSON.stringify({
    ...readStats(), shots: 20, hits: 10, week: { id: '2000-01-03', shots: 9, hits: 7 },
  }));
  const next = recordBattle(false, {
    shots: 4, hits: 3, balls: 4, ballsLanded: 3, damage: 0, sunk: 0, bestStreak: 1, cards: {},
  });
  assert.equal(next.shots, 24);
  assert.equal(next.hits, 13);
  assert.deepEqual(next.week, { id: currentWeekId(), shots: 4, hits: 3 });
});
