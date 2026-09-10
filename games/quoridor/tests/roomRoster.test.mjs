import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './loadModule.mjs';

const { balancedTeams, orderedRoomPlayers, teamSeatOrder } = await loadModule(
  new URL('../src/game/roomRoster.ts', import.meta.url),
);

test('a guest keeps all four humans before the host 2v2 rules arrive', () => {
  // Deliberately inserted out of order, as Firestore map fields may arrive.
  const room = {
    d: { uid: 'd', displayName: 'Daniyal', fishIndex: 3 },
    b: { uid: 'b', displayName: 'Bilal', fishIndex: 1 },
    a: { uid: 'a', displayName: 'Ayesha', fishIndex: 0 },
    c: { uid: 'c', displayName: 'Fahad', fishIndex: 2 },
  };
  const people = orderedRoomPlayers(room);
  assert.deepEqual(people.map((person) => person.uid), ['a', 'b', 'c', 'd']);
  assert.deepEqual(people.map((person) => person.skin), [0, 1, 2, 3]);
  assert.equal(people.some((person) => person.uid.startsWith('bot-')), false);
});

test('only people beyond Quoridor four-seat capacity become spectators', () => {
  const room = Object.fromEntries(
    ['e', 'c', 'a', 'd', 'b'].map((uid) => [uid, { uid, displayName: uid.toUpperCase() }]),
  );
  assert.deepEqual(orderedRoomPlayers(room).map((person) => person.uid), ['a', 'b', 'c', 'd']);
});

test('host team choices become the alternating 2v2 seat order', () => {
  const people = ['a', 'b', 'c', 'd'].map((uid) => ({ uid, displayName: uid.toUpperCase() }));
  const teams = { a: 1, b: 0, c: 1, d: 0 };
  assert.deepEqual(teamSeatOrder(people, teams).map((person) => person?.uid), ['b', 'a', 'd', 'c']);
});

test('a three-human 2v2 leaves the missing partner on the correct team', () => {
  const people = ['a', 'b', 'c'].map((uid) => ({ uid, displayName: uid.toUpperCase() }));
  const teams = balancedTeams(people, { a: 1, b: 1, c: 1 });
  assert.deepEqual(Object.values(teams).sort(), [0, 1, 1]);
  assert.deepEqual(teamSeatOrder(people, teams).map((person) => person?.uid), ['c', 'a', undefined, 'b']);
});
