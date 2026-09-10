import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './loadModule.mjs';

const { TIERS, chooseMove, newBrain } = await loadModule(
  new URL('../src/engine/ai.ts', import.meta.url),
);
const { emptyPosition, layoutFor, moveLegal } = await loadModule(
  new URL('../src/game/rules.ts', import.meta.url),
);

test('the original bot ranks remain and three planning ranks follow Architect', () => {
  assert.deepEqual(
    TIERS.map((tier) => tier.label),
    ['Rookie', 'Runner', 'Architect', 'Strategist', 'Mastermind', 'Grandmaster'],
  );
});

test('every bot rank produces a legal opening in duel and 2v2', () => {
  for (const rules of [
    { players: 2, teams: false },
    { players: 4, teams: true },
  ]) {
    const layout = layoutFor(rules);
    for (let level = 0; level < TIERS.length; level++) {
      const pos = emptyPosition(layout);
      const move = chooseMove(pos, 0, layout, level, newBrain(), () => 0.9);
      assert.equal(moveLegal(pos, 0, move, layout), true, `${TIERS[level].label} made an illegal move`);
    }
  }
});
