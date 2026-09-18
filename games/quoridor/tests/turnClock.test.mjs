import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './loadModule.mjs';

const { PASS_MOVE, applyMove, emptyPosition, isWallMove, layoutFor, moveLegal, pawnMoves } = await loadModule(
  new URL('../src/game/rules.ts', import.meta.url),
);

test('a skipped turn is a legal move that changes nothing on the board', () => {
  const layout = layoutFor({ players: 2, teams: false });
  const pos = emptyPosition(layout);
  const before = JSON.stringify(pos);

  assert.equal(moveLegal(pos, 0, PASS_MOVE, layout), true);
  assert.equal(isWallMove(PASS_MOVE), false, 'a skip must not be read as a wall and spend one');
  applyMove(pos, 0, PASS_MOVE);
  assert.equal(JSON.stringify(pos), before);
});

test('codes past the skip are still refused', () => {
  const layout = layoutFor({ players: 2, teams: false });
  const pos = emptyPosition(layout);
  assert.equal(moveLegal(pos, 0, PASS_MOVE + 1, layout), false);
  assert.ok(pawnMoves(pos, 0, layout).length > 0);
});
