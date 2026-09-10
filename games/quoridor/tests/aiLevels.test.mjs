import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './loadModule.mjs';

const { TIERS, chooseMove, newBrain } = await loadModule(
  new URL('../src/engine/ai.ts', import.meta.url),
);
const { applyMove, cell, distanceToGoal, emptyPosition, isWallMove, layoutFor, moveLegal } = await loadModule(
  new URL('../src/game/rules.ts', import.meta.url),
);

test('the original bot ranks remain and three planning ranks follow Architect', () => {
  assert.deepEqual(
    TIERS.map((tier) => tier.label),
    ['Rookie', 'Runner', 'Architect', 'Strategist', 'Mastermind', 'Grandmaster'],
  );
});

test('advanced ranks vary equally strong opening plans instead of repeating one script', () => {
  const layout = layoutFor({ players: 2, teams: false });
  for (let level = 3; level < TIERS.length; level++) {
    const plans = new Set();
    for (const roll of [0.02, 0.25, 0.5, 0.75, 0.98]) {
      const pos = emptyPosition(layout);
      const advancedBrain = newBrain();
      const runnerBrain = newBrain();
      const plan = [];
      for (let round = 0; round < 4; round++) {
        const move = chooseMove(pos, 0, layout, level, advancedBrain, () => roll);
        plan.push(move);
        applyMove(pos, 0, move);
        const reply = chooseMove(pos, 1, layout, 1, runnerBrain, () => 0.9);
        applyMove(pos, 1, reply);
      }
      plans.add(plan.join(','));
    }
    assert.ok(plans.size > 1, `${TIERS[level].label} repeated a single opening plan: ${[...plans].join(' | ')}`);
  }
});

test('Grandmaster always takes an available winning step', () => {
  const layout = layoutFor({ players: 2, teams: false });
  const pos = emptyPosition(layout);
  pos.pawns[0] = 13;
  const move = chooseMove(pos, 0, layout, TIERS.length - 1, newBrain(), () => 0.99);
  assert.equal(move, 0);
  assert.equal(moveLegal(pos, 0, move, layout), true);
});

test('Grandmaster blocks an enemy that would win on its next step', () => {
  const layout = layoutFor({ players: 2, teams: false });
  const pos = emptyPosition(layout);
  pos.pawns[0] = cell(4, 0);
  pos.pawns[1] = cell(7, 4);
  const before = distanceToGoal(pos, 1, layout);
  const move = chooseMove(pos, 0, layout, TIERS.length - 1, newBrain(), () => 0.5);
  assert.equal(isWallMove(move), true, 'Grandmaster ran instead of stopping the immediate threat');
  assert.equal(moveLegal(pos, 0, move, layout), true);
  applyMove(pos, 0, move);
  assert.ok(distanceToGoal(pos, 1, layout) > before);
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
