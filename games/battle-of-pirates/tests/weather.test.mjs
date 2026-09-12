import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './loadModule.mjs';

const { BattleEngine } = await loadModule(new URL('../src/engine/BattleEngine.ts', import.meta.url));
const { DEFAULT_RULES, packRules, unpackRules } = await loadModule(new URL('../src/types/game.ts', import.meta.url));
const { WEATHER, weatherFor, weatherForRound, wetWeather } = await loadModule(new URL('../src/game/weather.ts', import.meta.url));
const { drawWeather } = await loadModule(new URL('../src/game/sea.ts', import.meta.url));
const { arenaFor } = await loadModule(new URL('../src/game/rules.ts', import.meta.url));

function create(weather, onSfx) {
  return new BattleEngine({ seed: 3129, first: 0,
    rules: { ...DEFAULT_RULES, players: 2, mountain: 'off', turnTimer: false, weather, storm: wetWeather(weather) },
    seats: [0, 1].map(i => ({ team: i, id: `p${i}`, name: `Captain ${i}`, control: 'local', aiLevel: 1, skin: 11 + i, hull: 0 })),
    onSfx,
  });
}
function advance(engine, seconds) { for (let i = 0; i < Math.round(seconds * 120); i++) engine.update(1 / 120); }

test('all weather choices survive wire encoding and old storm rooms become rain', () => {
  for (const { id } of WEATHER) {
    const rules = { ...DEFAULT_RULES, weather: id, storm: wetWeather(id) };
    assert.deepEqual(unpackRules(packRules(rules)), rules);
  }
  assert.equal(weatherFor(unpackRules(128)), 'rain');
  assert.equal(weatherFor(unpackRules(0)), 'clear');
  assert.equal(weatherFor(unpackRules(7 << 8)), 'clear');
  const random = { ...DEFAULT_RULES, weather: 'random', storm: false };
  assert.deepEqual(unpackRules(packRules(random)), random);
});

test('random weather uses one shared seeded deck and changes at each round', () => {
  const rules = { ...DEFAULT_RULES, weather: 'random', storm: false };
  const first = Array.from({ length: WEATHER.length }, (_, round) => weatherForRound(rules, 3129, round));
  assert.equal(new Set(first).size, WEATHER.length);
  assert.deepEqual(
    first,
    Array.from({ length: WEATHER.length }, (_, round) => weatherForRound(rules, 3129, round)),
  );
  assert.equal(weatherForRound(rules, 3129, WEATHER.length), first[0]);
});

test('weather never changes flight, damage, cards or between-turn drift', () => {
  let expected;
  for (const { id } of WEATHER) {
    const engine = create(id);
    const outcomes = [];
    advance(engine, 0.52);
    for (let turn = 0; turn < 3; turn++) {
      assert.equal(engine.gust, 0);
      engine.fire({ angle: engine.turn === 0 ? -0.6 : Math.PI + 0.6, power: 0.7, card: 'round' });
      advance(engine, 0.25);
      outcomes.push(engine.projectiles.map(p => [p.x, p.y, p.vx, p.vy]));
      advance(engine, 8);
      outcomes.push({ hp: engine.hp, turn: engine.turn, ships: engine.ships.map(s => s.x), hand: engine.hand });
    }
    if (!expected) expected = outcomes;
    else assert.deepEqual(outcomes, expected, `${id} changed the match`);
  }
});

test('rain falls vertically and the cached rain field follows changing arena sizes', () => {
  for (const fleet of [1, 3, 1]) {
    const arena = arenaFor(fleet);
    const segments = [];
    let from;
    const ctx = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, stroke() {}, ellipse() {}, rect() {}, clip() {},
      moveTo(x, y) { from = [x, y]; }, lineTo(x, y) { segments.push([...from, x, y]); } };
    drawWeather(ctx, arena, 3.2, 'rain', 35);
    assert.equal(segments.length, 35);
    for (const [x, y, toX, toY] of segments) {
      assert.equal(x, toX);
      assert.ok(toY > y);
      assert.ok(x >= 0 && x <= arena.w);
    }
  }
});

test('thunder sounds once per distant lightning event and never in plain rain', () => {
  for (const kind of ['thunder', 'rain']) {
    const sounds = [];
    const engine = create(kind, sound => { if (sound === 'thunder') sounds.push(sound); });
    advance(engine, 4.7); assert.equal(sounds.length, 0);
    advance(engine, 0.3); assert.equal(sounds.length, kind === 'thunder' ? 1 : 0);
    advance(engine, 14); assert.equal(sounds.length, kind === 'thunder' ? 2 : 0);
  }
});
