import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './loadModule.mjs';

const { QuoridorEngine } = await loadModule(
  new URL('../src/engine/QuoridorEngine.ts', import.meta.url),
);
const { layoutFor } = await loadModule(
  new URL('../src/game/rules.ts', import.meta.url),
);

function engine() {
  return new QuoridorEngine({
    seats: Array.from({ length: 4 }, (_, i) => ({
      id: `bot-${i}`,
      name: 'Runner Bot',
      control: 'ai',
      aiLevel: 1,
      skin: 0,
    })),
    layout: layoutFor({ players: 4, teams: true }),
    first: 0,
    seedTag: 72,
  });
}

test('a late complete roster restores another human as remote', () => {
  const board = engine();
  board.correctSeat(2, 'fahad', 'Fahad', 'remote');
  assert.deepEqual(
    { id: board.seats[2].id, name: board.seats[2].name, control: board.seats[2].control },
    { id: 'fahad', name: 'Fahad', control: 'remote' },
  );
});

test('a client also reclaims its own seat if it was initially invented as a bot', () => {
  const board = engine();
  board.correctSeat(3, 'bilal', 'Bilal', 'local');
  assert.deepEqual(
    { id: board.seats[3].id, name: board.seats[3].name, control: board.seats[3].control },
    { id: 'bilal', name: 'Bilal', control: 'local' },
  );
});
