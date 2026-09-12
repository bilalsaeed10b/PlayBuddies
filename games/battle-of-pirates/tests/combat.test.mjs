import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './loadModule.mjs';

// Bundle the actual engine in memory: no test-only duplicate of combat rules.
const { BattleEngine } = await loadModule(new URL('../src/engine/BattleEngine.ts', import.meta.url));
const { CARDS, CARD_ORDER } = await loadModule(new URL('../src/game/rules.ts', import.meta.url));
const { HULLS } = await loadModule(new URL('../src/game/hulls.ts', import.meta.url));
const { SPECIALS } = await loadModule(new URL('../src/game/specials.ts', import.meta.url));
const rules = { players: 4, aimArc: true, cards: true, mountain: 'off', turnTimer: false, storm: false };
function create(count = 4, overrides = {}) {
  return new BattleEngine({
    seed: 3129, first: 0, rules: { ...rules, players: count },
    seats: Array.from({ length: count }, (_, i) => ({ team: i % 2, id: `p${i}`, name: `Captain ${i}`, control: 'local', aiLevel: 1, skin: 0, hull: 0 })),
    ...overrides,
  });
}
function advance(engine, seconds) {
  for (let i = 0; i < Math.ceil(seconds * 120); i++) engine.update(1 / 120);
}
function aim(engine) { advance(engine, 0.52); assert.equal(engine.phase, 'aim'); }
function grant(engine, hp = 100) { engine.ships[engine.turn].charge = 3; engine.ships[engine.turn].hp = hp; }
function snapshot(engine) { return { turn: engine.turn, tn: engine.turnNo, hp: engine.hp, charges: engine.ships.map(s => s.charge), x: engine.ships.map(s => Math.round(s.x)) }; }

test('strict living-seat round robin in a 2v1, with either first team', () => {
  for (const first of [0, 1]) {
    const b = create(4, { first });
    b.ships[3].hp = 0;
    const seen = [];
    for (let i = 0; i < 6; i++) {
      aim(b); seen.push(b.turn); b.skipTurn(); advance(b, 0.36);
    }
    assert.deepEqual(seen, first === 0 ? [0, 1, 2, 0, 1, 2] : [1, 2, 0, 1, 2, 0]);
  }
});
test('round robin skips sunk seats and wraps in 3v3', () => {
  const b = create(6); b.ships[1].hp = 0; b.ships[4].hp = 0;
  let cursor = 0; const seen = [];
  for (let i = 0; i < 8; i++) { seen.push(cursor); cursor = b.nextTurn(cursor); }
  assert.deepEqual(seen, [0, 3, 2, 5, 0, 3, 2, 5]);
});
test('living teammates rotate formation after every full fleet cycle', () => {
  for (const first of [0, 1]) {
    const b = create(4, { first });
    const initial = b.ships.map((ship) => ship.slot);
    for (let turn = 0; turn < 4; turn++) {
      aim(b); b.skipTurn(); advance(b, 0.36);
    }
    assert.deepEqual(b.ships.map((ship) => ship.slot), [initial[2], initial[3], initial[0], initial[1]]);
  }
});
test('a direct hit deals the same damage to a sail and hull', () => {
  const strike = (boxFor) => {
    const b = create(2); aim(b); b.fire({ angle: -0.6, power: 0.5, card: 'round' });
    const p = b.projectiles[0]; const box = boxFor(b, 1);
    p.x = box.x0 - 30; p.y = (box.y0 + box.y1) / 2; p.vx = 1000; p.vy = 0;
    b.step(0.06);
    return b.ships[1].maxHp - b.ships[1].hp;
  };
  assert.equal(strike((b, i) => b.hullBox(i)), strike((b, i) => b.rigBox(i)));
});
test('three successful cannon attacks charge; pellets, misses, burn and specials do not double-charge', () => {
  const b = create(); aim(b);
  for (let n = 1; n <= 3; n++) {
    b.phase = 'aim'; b.fire({ angle: -0.6, power: 0.5, card: 'round' });
    b.earnCharge(b.projectiles.at(-1));
    b.damage(1, 2, b.ships[0].x); b.damage(3, 2, b.ships[0].x);
    assert.equal(b.ships[0].charge, n);
  }
  b.phase = 'aim'; b.fire({ angle: -0.6, power: 0.5, card: 'round' });
  assert.equal(b.ships[0].charge, 3, 'miss does not erase banked hits');
  b.phase = 'aim'; assert.ok(b.useSpecial('acid-rain'));
  advance(b, 2.5); assert.equal(b.ships[0].charge, 0, 'special cannot recharge itself');
});
test('multi-shot damage and special-meter rules are explicit per ammunition', () => {
  const cases = [
    ['chain', 2, 4, 2, 2],
    ['twin', 2, 8, 1, 2],
    ['broadside', 3, 6, 1, 3],
    ['grape', 5, null, 2, 2],
    ['bore', 1, null, 1, 1],
  ];
  for (const [card, balls, exactDamage, expectedCharge, directHits] of cases) {
    const b = create(2); aim(b);
    b.fire({ angle: -0.6, power: 0.5, card });
    assert.equal(b.projectiles.length, balls, `${card} ball count`);
    if (exactDamage !== null) {
      assert.ok(b.projectiles.every((p) => p.damage === exactDamage * HULLS[0].damage), `${card} damage`);
    }
    const box = b.hullBox(1);
    for (const projectile of b.projectiles.slice(0, directHits)) {
      projectile.x = box.x0 - 30;
      projectile.y = (box.y0 + box.y1) / 2;
      projectile.vx = 1000;
      projectile.vy = 0;
    }
    b.step(0.06);
    assert.equal(b.ships[0].charge, expectedCharge, `${card} meter gain`);
  }
  assert.equal(CARDS.broadside.name, 'Triple Shot');
});
test('blast damage hurts but does not charge the special meter', () => {
  const b = create(2); aim(b);
  b.fire({ angle: -0.6, power: 0.5, card: 'round' });
  const projectile = b.projectiles[0];
  const box = b.hullBox(1);
  const before = b.ships[1].hp;
  b.splashDamage((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, projectile);
  assert.ok(b.ships[1].hp < before);
  assert.equal(b.ships[0].charge, 0);
});
test('normal cannon projectile collision earns charge and floating damage text', () => {
  const b = create(2); aim(b);
  b.fire({ angle: -0.6, power: 0.5, card: 'round' });
  const box = b.hullBox(1); const p = b.projectiles[0];
  p.x = box.x0 - 30; p.y = (box.y0 + box.y1) / 2; p.vx = 1000; p.vy = 0;
  b.step(0.06);
  assert.ok(b.ships[1].hp < b.ships[1].maxHp, JSON.stringify({ box, p, hp: b.hp }));
  assert.equal(b.ships[0].charge, 1);
  assert.ok(b.damageTexts.some(t => t.text.startsWith('−')));
});
test('every ammunition type has identical range at the same angle and power', () => {
  const b = create(2); aim(b);
  b.aimAngle = -0.82; b.aimPower = 0.74;
  const baseline = (() => { b.selected = 'round'; return b.previewArc(30); })();
  for (const id of CARD_ORDER) {
    assert.equal(CARDS[id].speed, 1, `${id} muzzle speed`);
    assert.equal(CARDS[id].gravity, 1, `${id} gravity`);
    b.selected = id;
    assert.deepEqual(b.previewArc(30), baseline, `${id} centre trajectory`);
  }
});
test('torpedo drag targeting accepts living enemies and rejects allies and empty water', () => {
  const b = create();
  b.dpr = 1; b.scale = 1; b.offX = 0; b.offY = 0;
  const rect = { left: 0, top: 0 };
  assert.equal(b.pickEnemyAt(b.ships[1].x, b.shipY(1), rect, 0), 1);
  const origin = b.torpedoOrigin(rect);
  assert.ok(origin.x > b.ships[0].x, 'guide starts at the attacking hull toward its enemy');
  const lock = b.snapEnemyAt(b.ships[1].x + 70, b.shipY(1), rect, 1);
  assert.equal(lock?.index, 1);
  assert.ok(Math.abs(lock.x - b.ships[1].x) < 30, 'reticle magnets to the hull centre');
  assert.equal(b.snapEnemyAt(b.arena.w / 2, 40, rect, 1), null);
  assert.equal(b.pickEnemyAt(b.ships[0].x, b.shipY(0), rect, 0), null);
  assert.equal(b.pickEnemyAt(b.arena.w / 2, 40, rect, 0), null);
  b.ships[1].hp = 0;
  assert.equal(b.pickEnemyAt(b.ships[1].x, b.shipY(1), rect, 0), null);
});
test('torpedo damages only the selected enemy by 25 and consumes exactly one turn', () => {
  const b = create(); aim(b); grant(b);
  const before = b.hp;
  assert.ok(b.useSpecial('torpedo', 3));
  assert.equal(b.ships[0].charge, 0);
  assert.equal(b.useSpecial('torpedo', 1), false);
  b.fire({ angle: 0, power: 1, card: 'round' });
  assert.equal(b.phase, 'special');
  advance(b, SPECIALS.torpedo.impact - 0.02); assert.deepEqual(b.hp, before);
  advance(b, 0.04); assert.deepEqual(b.hp, before.map((hp, i) => i === 3 ? hp - 25 : hp));
  advance(b, SPECIALS.torpedo.duration - SPECIALS.torpedo.impact + 0.2); assert.equal(b.turnNo, 1); assert.equal(b.turn, 1);
});
test('acid rain hits every living enemy once, and keeps the full six-second cinematic', () => {
  const b = create(6); aim(b); grant(b); b.ships[5].hp = 0;
  const before = b.hp;
  assert.ok(b.useSpecial('acid-rain'));
  advance(b, 1.5); assert.deepEqual(b.hp, before);
  advance(b, 1); assert.deepEqual(b.hp, before.map((hp, i) => i === 1 || i === 3 ? hp - 15 : hp));
  advance(b, 3.49); assert.equal(b.turnNo, 0);
  advance(b, 0.04); assert.equal(b.turnNo, 1);
  assert.equal(b.ships[0].charge, 0);
});
test('last enemy dying to acid rain waits for sunrise before results', () => {
  let won = 0; const b = create(2, { onOver: () => won++ }); aim(b); grant(b); b.ships[1].hp = 5;
  assert.ok(b.useSpecial('acid-rain')); advance(b, 5.9);
  assert.equal(b.hp[1], 0); assert.equal(won, 0);
  advance(b, 0.2); assert.equal(won, 1); assert.equal(b.phase, 'over');
});
test('heal restores 20/25, caps at own maxHP, never revives, and consumes a turn', () => {
  for (const missing of [10, 35]) {
    const b = create(); aim(b); grant(b, b.ships[0].maxHp - missing);
    const before = b.ships[0].hp;
    assert.ok(b.useSpecial('heal', 0)); advance(b, 2.3);
    assert.equal(b.ships[0].hp, Math.min(b.ships[0].maxHp, before + 20));
    assert.equal(b.turnNo, 1); assert.equal(b.turn, 1);
    assert.equal(b.ships[0].charge, 0);
  }
  const b = create(); aim(b); grant(b);
  assert.equal(b.useSpecial('heal', 0), false); assert.equal(b.ships[0].charge, 3);
  b.ships[0].hp = 0; assert.equal(b.useSpecial('heal', 0), false);
});
test('invalid special, friendly/dead targets, insufficient charge, remote turns cannot spend a meter', () => {
  const b = create(); aim(b);
  assert.equal(b.useSpecial('torpedo', 1), false); grant(b);
  for (const target of [undefined, 0, 2, -1, 99, NaN, 1.5]) assert.equal(b.useSpecial('torpedo', target), false);
  assert.equal(b.useSpecial('bogus'), false);
  b.ships[1].hp = 0; assert.equal(b.useSpecial('torpedo', 1), false);
  b.ships[0].control = 'remote'; assert.equal(b.useSpecial('acid-rain'), false);
  assert.equal(b.ships[0].charge, 3);
});

function pair() {
  const messages = [];
  const host = create(4, { isHost: true, hostUid: 'p0', onLocalShot: p => messages.push(['p0', p]), onAsk: p => messages.push(['p0', p]) });
  const guest = create(4, { isHost: false, hostUid: 'p0', onLocalShot: p => messages.push(['p1', p]), onAsk: p => messages.push(['p1', p]) });
  host.ships.forEach((s, i) => s.control = i === 0 ? 'local' : 'remote');
  guest.ships.forEach((s, i) => s.control = i === 1 ? 'local' : 'remote');
  const deliver = (filter = () => true) => {
    for (const [from, packet] of messages.splice(0)) {
      if (!filter(packet, from)) continue;
      const receiver = from === 'p0' ? guest : host;
      if (packet.t === 'sync') receiver.applySync(packet);
      else if (packet.t === 'fire') receiver.applyFire(packet, from);
      else receiver.applyShot(packet, from);
    }
  };
  const run = (seconds, filter) => {
    for (let i = 0; i < Math.ceil(seconds * 120); i++) { host.update(1 / 120); guest.update(1 / 120); deliver(filter); }
  };
  run(0.55);
  return { host, guest, run, deliver, messages };
}
for (const kind of ['torpedo', 'acid-rain', 'heal']) {
  for (const dropPreview of [false, true]) test(`${kind} multiplayer outcome agrees ${dropPreview ? 'without preview' : 'with preview'}`, () => {
    const { host, guest, run } = pair();
    for (const b of [host, guest]) { b.ships[0].charge = 3; b.ships[0].hp = 60; b.ships[2].hp = 60; }
    assert.ok(host.useSpecial(kind, kind === 'heal' ? 2 : 3));
    run(14, p => !(dropPreview && p.t === 'fire'));
    assert.deepEqual(snapshot(guest), snapshot(host));
    assert.equal(host.turnNo, 1);
  });
}
test('late previews never fire for a different captain, duplicate outcomes never advance twice', () => {
  const { host, guest, run, messages } = pair();
  host.ships[0].charge = guest.ships[0].charge = 3;
  host.useSpecial('torpedo', 3); const preview = messages.find(([,p]) => p.t === 'fire')[1];
  run(SPECIALS.torpedo.duration + 0.2); const before = snapshot(guest);
  guest.applyFire({ ...preview, n: 999 }, 'p0');
  guest.applyShot({ ...host.snapshot(), st: undefined, tn: 1, who: 0, n: 999 }, 'p0');
  advance(guest, 1.5); assert.deepEqual(snapshot(guest), before); assert.equal(guest.phase, 'aim');
});
test('background sync discards partial animation and restores HP, charge, captain, and clock', () => {
  const { host, guest, run, deliver, messages } = pair();
  host.ships[0].charge = guest.ships[0].charge = 3;
  host.useSpecial('torpedo', 3); deliver(); advance(guest, 0.2);
  advance(host, 4.2); messages.length = 0;
  guest.requestSync(); assert.equal(guest.resyncing, true); deliver(); deliver();
  assert.equal(guest.resyncing, false);
  assert.equal(guest.special, null);
  assert.deepEqual(snapshot(guest), snapshot(host));
  assert.ok(Math.abs(guest.turnClock - host.turnClock) < 0.2);
  run(0.2); assert.equal(guest.turn, 1);
});
test('fresh sync ack required; stale beacons cannot unlock a waking captain', () => {
  const { host, guest, deliver } = pair();
  guest.requestSync(); guest.applyShot(host.snapshot(), 'p0');
  assert.equal(guest.resyncing, true);
  deliver(); deliver(); assert.equal(guest.resyncing, false);
});
test('a same-turn beacon cannot steal an active helm or restore an old special meter', () => {
  const { host, guest } = pair();
  guest.turn = 1;
  guest.phase = 'aim';
  guest.turnClock = 8;
  guest.ships[1].control = 'local';
  guest.ships[1].charge = 0;
  host.ships[1].charge = 3;

  // This is an old periodic host snapshot from before the guest spent its
  // meter. It describes the same turn, so it carries no new action.
  guest.applyShot(host.snapshot(), 'p0');
  guest.update(0);
  assert.equal(guest.turn, 1);
  assert.equal(guest.turnClock, 8);
  assert.equal(guest.ships[1].charge, 0);
});
test('a valid captain cannot preview or resolve another captain\'s live turn', () => {
  const { guest } = pair();
  assert.equal(guest.turn, 0);

  // `p1` is a real member of the fleet, so sender validation alone accepts
  // it. It is nevertheless p0's turn; accepting this is how split seat maps
  // used to leave each device waiting for a different captain.
  guest.applyFire({ t: 'fire', n: 71, s: guest.cfg.seed, tn: 1, who: 1, a: -0.8, p: 0.5, c: 'round' }, 'p1');
  assert.equal(guest.pendingFire, null);
  guest.applyShot({ ...guest.snapshot(), st: undefined, n: 72, tn: 1, who: 1 }, 'p1');
  assert.equal(guest.remoteTurns.length, 0);
});
test('host alone drives online bots, broadcasting their special outcome', () => {
  const { host, guest, run } = pair();
  for (const b of [host, guest]) { b.ships[0].control = 'ai'; b.ships[0].charge = 3; }
  for (let i = 0; i < 3 * 120; i++) {
    host.update(1 / 120, () => ({ angle: -1, power: .5, card: 'round' }));
    guest.update(1 / 120, () => { throw Error('guest must not decide bot shot'); });
  }
  run(10); assert.equal(host.turnNo, 1); assert.deepEqual(snapshot(guest), snapshot(host));
});

test('3v3 with four devices and two bots recovers from a guest and then the host sleeping', () => {
  const docs = new Map(); const delivered = Array.from({length:4},()=>new Map());
  let sequence = 0;
  const engines = Array.from({length:4},(_,client)=>create(6,{
    isHost:client===0,hostUid:'p0',
    onLocalShot:p=>docs.set(`p${client}`,{packet:p,version:++sequence}),
    onAsk:p=>docs.set(`p${client}`,{packet:p,version:++sequence}),
  }));
  engines.forEach((b,client)=>b.ships.forEach((s,i)=>{
    s.control=i>=4?'ai':i===client?'local':'remote';s.charge=3;
  }));
  const asleep=(client,tick)=>(client===1&&tick>=180&&tick<1700)||(client===0&&tick>=1900&&tick<2500);
  const receive=(client)=>{
    const b=engines[client];
    for(const [from,{packet,version}] of docs){
      if(from===`p${client}`||delivered[client].get(from)===version)continue;
      delivered[client].set(from,version);
      if(packet.t==='sync')b.applySync(packet);
      else if(packet.t==='fire')b.applyFire(packet,from);
      else b.applyShot(packet,from);
    }
  };
  for(let tick=0;tick<6000;tick++){
    engines.forEach((b,client)=>{
      if(asleep(client,tick))return;
      if((client===1&&tick===1700)||(client===0&&tick===2500))b.requestSync();
      if(tick%7===client)receive(client);
      b.update(1/120,()=>({angle:-1,power:.45,card:'round'}));
      if(tick<4000&&b.awaitingLocal){
        if(b.ships[b.turn].charge===3){
          const enemy=b.ships.findIndex(s=>s.hp>0&&s.team!==b.ships[b.turn].team);
          b.useSpecial(b.turn===1?'acid-rain':'torpedo',enemy);
        }else b.skipTurn();
      }
    });
  }
  assert.ok(engines[0].turnNo>=6,'multiple captains completed turns');
  for(const b of engines.slice(1))assert.deepEqual(snapshot(b),snapshot(engines[0]));
  for(const b of engines)assert.ok(b.phase==='over'||b.ships[b.turn].hp>0,'a living captain has the turn');
});
