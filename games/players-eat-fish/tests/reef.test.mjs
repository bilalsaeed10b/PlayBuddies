import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from '../node_modules/esbuild/lib/main.js';
import { createRequire } from 'node:module';
const result = await build({ entryPoints: [new URL('../src/engine/GameEngine.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], bundle: true, platform: 'node', format: 'cjs', write: false });
const mod = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, createRequire(import.meta.url));
const { GameEngine, BALANCE, bodyRadius } = mod.exports;
function reef() {
  const b = Object.create(GameEngine.prototype);
  Object.assign(b, { locals: new Map(), remotes: new Map(), enemies: new Map(), nextEnemyId: 0, spawnCursor: 0, config: {}, boss: null });
  return b;
}
test('the aquarium stays readable and new fish only travel horizontally', () => {
  const b = reef();
  b.locals.set('a', b.makeFish('a', 'player', 500, 0));
  for (let i = 0; i < 2000; i++) b.spawnEnemy();
  assert.ok([...b.enemies.values()].filter(f => f.asset === 29).length <= 2);
  assert.ok(new Set([...b.enemies.values()].map(f => f.asset)).size > 4);
  assert.ok(BALANCE.ENEMY_MAX <= 24);
  assert.ok(BALANCE.ENEMY_BASE + BALANCE.ENEMY_PER_PLAYER <= 14);
  assert.ok([...b.enemies.values()].every(f => f.vy === 0 && f.shoal === undefined));
  assert.ok([...b.enemies.values()].filter(f => f.size < 120).every(f => f.asset < 28));
  assert.ok(bodyRadius(10) < 14);
  assert.ok(bodyRadius(900) < 92);
});
test('spawn mix is 40% edible and 60% larger for its nearby player', () => {
  const b = reef();
  b.locals.set('a', b.makeFish('a', 'player', 50, 0));
  let state = 0x5eed1234;
  const originalRandom = Math.random;
  Math.random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 0x100000000);
  try {
    for (let i = 0; i < 1200; i++) b.spawnEnemy();
  } finally {
    Math.random = originalRandom;
  }
  const edible = [...b.enemies.values()].filter(f => Math.floor(f.size) <= 50).length;
  assert.ok(edible / b.enemies.size > 0.37 && edible / b.enemies.size < 0.43);
});
test('spawn anchors alternate between large and small living players', () => {
  const b = reef();
  b.locals.set('a', b.makeFish('a', 'player', 500, 0));
  b.remotes.set('b', b.makeFish('b', 'player', 10, 0));
  assert.deepEqual(Array.from({length: 4}, () => b.spawnAnchor().size), [500,10,500,10]);
});
test('every screen size keeps the entire fixed aquarium visible', () => {
  globalThis.window = { devicePixelRatio: 1 };
  for (const [width, height] of [[1920,1080],[812,375],[390,844]]) {
    const b = reef();
    const canvas = { style: {}, parentElement: { getBoundingClientRect: () => ({width,height}) } };
    b.config.canvas = canvas; b.ctx = { canvas };
    b.governor = { quality: { maxDpr: 1 } };
    b.resize();
    assert.equal(b.effViewW, BALANCE.WORLD_W);
    assert.equal(b.effViewH, BALANCE.WORLD_H);
  }
});
test('friendly fish prevent player kills; default permits eating smaller players', () => {
  for (const friendlyFish of [true, false]) {
    const b = reef(); b.config.friendlyFish = friendlyFish;
    const small = b.makeFish('a','player',10,0); small.bornAt = -100;
    const big = b.makeFish('b','player',30,0); big.bornAt = -100;
    b.locals.set('a',small); b.remotes.set('b',big);
    let killed = false; b.kill = () => { killed = true; };
    b.checkCollisions(); assert.equal(killed,!friendlyFish);
  }
  assert.ok(BALANCE.GROWTH >= 0.14 && BALANCE.GROWTH <= 0.18);
  assert.equal(BALANCE.SCORE_RATE, 0.8);
});
test('a player can eat an NPC with the same displayed size', () => {
  const b = reef();
  let eaten = 0;
  b.config = {
    localIds: ['a'],
    friendlyFish: false,
    onEnemyEaten: () => eaten++,
    onEat: () => {},
    onDeath: () => {},
  };
  b.simulateAI = false;
  b.grow = () => {};
  b.burst = () => {};
  const player = b.makeFish('a', 'player', 10.1, 0);
  player.bornAt = -100;
  const enemy = b.makeFish('1', 'enemy', 10.9, 0);
  player.x = enemy.x = 100;
  player.y = enemy.y = 100;
  b.locals.set('a', player);
  b.enemies.set(1, enemy);
  b.checkCollisions();
  assert.equal(eaten, 1);
  assert.equal(b.enemies.size, 0);
});
test('a movement control brings a defeated local fish back into the water', () => {
  const b = reef();
  let rejoined = 0;
  b.config = { localIds: ['a'], localFish: {}, onRejoin: () => rejoined++ };
  b.settings = { controlScheme: 0 };
  b.simulateAI = false;
  const fish = b.makeFish('a', 'player', 6, 0);
  fish.dead = true;
  b.locals.set('a', fish);
  const existingEnemy = b.makeFish('1', 'enemy', 30, 1);
  b.enemies.set(1, existingEnemy);
  b.resetReef = () => { throw new Error('movement rejoin must not replace the reef'); };
  b.setJoystick({ x: 1, y: 0 });
  assert.equal(fish.dead, false);
  assert.equal(rejoined, 1);
  assert.equal(b.enemies.get(1), existingEnemy);
});
