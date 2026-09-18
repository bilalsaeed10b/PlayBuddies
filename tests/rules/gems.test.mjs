/**
 * The gem rules, against the Firestore emulator.
 *
 *   npx firebase emulators:exec --only firestore --project demo-playbuddies "node --test tests/rules/gems.test.mjs"
 *
 * Gems are the one balance on the account that is meant to be worth money,
 * so these pin down the whole of what a player's own client may do to it:
 * spend freely, earn exactly two at a time against one newly completed daily
 * challenge, and complete no more than three of those in a UTC day.
 */
import { readFileSync } from 'node:fs';
import test, { after, before, beforeEach } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, increment, setDoc, updateDoc } from 'firebase/firestore';

const UID = 'player-1';
const now = new Date();
const TODAY = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
const YESTERDAY = (() => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
})();

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-playbuddies',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});

after(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled((ctx) =>
    setDoc(doc(ctx.firestore(), 'users', UID), { email: 'p@example.com', gems: 10 }),
  );
});

const me = () => doc(env.authenticatedContext(UID).firestore(), 'users', UID);
const state = (done, progress = {}) => ({ day: TODAY, progress, done });

test('completing one challenge pays exactly two gems', async () => {
  await assertSucceeds(updateDoc(me(), { challenges: state(['quoridor'], { quoridor: 1 }), gems: increment(2) }));
  let gems;
  await env.withSecurityRulesDisabled(async (ctx) => {
    gems = (await getDoc(doc(ctx.firestore(), 'users', UID))).data().gems;
  });
  if (gems !== 12) throw new Error(`expected 12 gems, got ${gems}`);
});

test('gems cannot rise without a completed challenge', async () => {
  await assertFails(updateDoc(me(), { gems: increment(2) }));
  await assertFails(updateDoc(me(), { challenges: state([], { quoridor: 1 }), gems: increment(2) }));
});

test('a completion cannot pay more than two', async () => {
  await assertFails(updateDoc(me(), { challenges: state(['quoridor']), gems: increment(4) }));
});

test('two completions in one write are refused', async () => {
  await assertFails(updateDoc(me(), { challenges: state(['quoridor', 'mini-golf']), gems: increment(2) }));
});

test('no fourth completion in a day', async () => {
  await env.withSecurityRulesDisabled((ctx) =>
    updateDoc(doc(ctx.firestore(), 'users', UID), { challenges: state(['a', 'b', 'c']) }),
  );
  await assertFails(updateDoc(me(), { challenges: state(['a', 'b', 'c', 'd']), gems: increment(2) }));
});

test('a completed game cannot be listed twice to be paid twice', async () => {
  await env.withSecurityRulesDisabled((ctx) =>
    updateDoc(doc(ctx.firestore(), 'users', UID), { challenges: state(['quoridor']) }),
  );
  await assertFails(updateDoc(me(), { challenges: state(['quoridor', 'quoridor']), gems: increment(2) }));
});

test('completions cannot be removed to make room for more', async () => {
  await env.withSecurityRulesDisabled((ctx) =>
    updateDoc(doc(ctx.firestore(), 'users', UID), { challenges: state(['a', 'b', 'c']) }),
  );
  await assertFails(updateDoc(me(), { challenges: state(['d']), gems: increment(2) }));
});

test('yesterday is over: a new day starts a fresh list', async () => {
  await env.withSecurityRulesDisabled((ctx) =>
    updateDoc(doc(ctx.firestore(), 'users', UID), { challenges: { day: YESTERDAY, progress: {}, done: ['a', 'b', 'c'] } }),
  );
  await assertSucceeds(updateDoc(me(), { challenges: state(['quoridor']), gems: increment(2) }));
});

test('a record cannot be dated for another day', async () => {
  await assertFails(updateDoc(me(), { challenges: { day: TODAY + 1, progress: {}, done: ['q'] }, gems: increment(2) }));
});

test('progress alone is the player’s own business', async () => {
  await assertSucceeds(updateDoc(me(), { challenges: state([], { quoridor: 1, 'mini-golf': 2 }) }));
});

test('gems can be spent but not driven negative', async () => {
  await assertSucceeds(updateDoc(me(), { gems: 4 }));
  await assertFails(updateDoc(me(), { gems: -1 }));
});

test('another player cannot touch my gems', async () => {
  const them = doc(env.authenticatedContext('player-2').firestore(), 'users', UID);
  await assertFails(updateDoc(them, { challenges: state(['q']), gems: increment(2) }));
});
