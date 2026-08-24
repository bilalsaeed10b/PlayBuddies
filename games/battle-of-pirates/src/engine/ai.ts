/**
 * The bot.
 *
 * It does not cheat and it does not read your aim. It solves the same
 * ballistics problem the player is eyeballing -- including the wind, which it
 * can see on the same gauge you can -- then deliberately gets it wrong by an
 * amount set by its rank, and tightens up as it ranges in.
 *
 * That last part matters more than the accuracy number. A bot with a fixed
 * random error is a slot machine: it never threatens you and it never
 * surprises you. A bot that misses long, then short, then lands one plays like
 * an opponent, and it makes the opening shot of a match a genuinely safe one,
 * which is the right way to start.
 *
 * The obvious way to write "it ranges in" is to feed the last miss back in as
 * a correction, and that is what this did first. It is wrong here, and
 * measurably so: the solver has no systematic error to correct, so every miss
 * is either the deliberate spread or a wind that has since changed. Feeding
 * that back means aiming off by yesterday's noise, and it roughly doubled the
 * bot's average miss instead of shrinking it. What survives is the honest part
 * -- a miss narrows the spread, a hit resets it -- which tightens the group
 * without ever moving the point of aim off the target.
 */
import type { BattleEngine } from './BattleEngine';
import { BALANCE, CARDS, CardId, CardMeta, clamp, elevOf, elevRange } from '../game/rules';
import { rockRadius } from '../game/sea';
import type { Shot } from '../types/game';

export interface Tier {
  label: string;
  /** How far off the mark, in world pixels, a fresh shot lands. */
  spread: number;
  /** Fraction the spread shrinks to after a miss. 1 never tightens. */
  learn: number;
  /** However long it goes on missing, the spread never falls below this share. */
  floor: number;
  /** Whether it bothers to think about which card to play. */
  reads: boolean;
}

/**
 * The three ranks, in world pixels of aiming error.
 *
 * The numbers are not guesses. A hull is 224 wide and a ball is 15 across, so
 * anything inside about 127 pixels of the enemy's centre line is a direct hit
 * whatever else happens; the spreads are set around that figure and then
 * measured, bot against bot, over fifty shots each. As written, a Swab lands
 * roughly two shots in five, a Gunner three in four, and a Captain nine in
 * ten. The floors are what stop the top rank becoming a wall that never
 * misses, which is not difficulty, only a tax on your patience.
 */
export const TIERS: Tier[] = [
  { label: 'Swab', spread: 360, learn: 0.9, floor: 0.8, reads: false },
  { label: 'Gunner', spread: 215, learn: 0.72, floor: 0.6, reads: true },
  { label: 'Captain', spread: 155, learn: 0.58, floor: 0.45, reads: true },
];

export interface Brain {
  /** Multiplier on the tier's spread. Shrinks on a miss, resets on a hit. */
  focus: number;
}

export function newBrain(): Brain {
  return { focus: 1 };
}

/** Powers it is willing to use. Nothing at the very edges: those look robotic. */
const POWERS = [0.55, 0.62, 0.7, 0.78, 0.86, 0.93];

/**
 * Which enemy hull to shoot at.
 *
 * The nearest one it can plausibly reach, and among equals the one closest to
 * sinking. Nearest matters more than it sounds: a rear ship is a longer shot
 * over the same mountain, and a bot that always picks the wounded one across
 * the whole sea spends the battle lobbing at maximum range and missing. This
 * keeps it engaging the ship in front of it and finishing what it started.
 */
function pickTarget(engine: BattleEngine, me: number): number {
  const mine = engine.ships[me];
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < engine.ships.length; i++) {
    const foe = engine.ships[i];
    if (foe.team === mine.team || foe.hp <= 0) continue;
    // Distance dominates; a hull already down to its last planks is worth a
    // few hundred pixels of extra reach, no more.
    const score = Math.abs(foe.x - mine.x) + foe.hp * 4;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export function chooseShot(engine: BattleEngine, me: number, level: number, brain: Brain): Shot {
  const tier = TIERS[clamp(level, 0, TIERS.length - 1)];
  const foe = pickTarget(engine, me);
  const facing = engine.facing(me);
  // Every enemy is under; nothing sensible to aim at, and resolve() is about
  // to end the battle anyway.
  if (foe < 0) {
    return { angle: facing > 0 ? -0.72 : -Math.PI + 0.72, power: 0.6, card: engine.hand[0] ?? 'round' };
  }
  const enemy = engine.ships[foe];

  // Range in on the last shot before aiming the next one. A miss narrows the
  // group; landing one puts it straight back to the tier's honest accuracy, so
  // a bot oscillates around its rank rather than converging on perfect and
  // staying there.
  const hit = engine.lastShotHit[me];
  if (hit !== null && hit !== undefined) {
    brain.focus = hit ? 1 : Math.max(tier.floor, brain.focus * tier.learn);
  }

  const card = pickCard(engine, me, foe, tier);
  engine.select(card);
  const meta = CARDS[card];

  const targetY = engine.shipY(foe) - 24;
  const aimX = enemy.x + (Math.random() * 2 - 1) * tier.spread * brain.focus;

  const options: Shot[] = [];

  // Lofting over the mountain is worth doing on purpose, so both arcs are
  // tried and the one with a clear line wins. A bot that fires flat into the
  // same mountain three turns running is the fastest way to look broken.
  const [loElev, hiElev] = elevRange(card);
  for (const high of [false, true]) {
    for (const power of POWERS) {
      const angle = solve(engine, me, aimX, targetY, power, meta.gravity, meta.speed, Boolean(meta.windproof), high);
      if (angle === null) continue;
      // Mortar cannot leave the barrel below 45 degrees, same as a human's
      // aim pad -- without this the solver's flat root would have the bot
      // firing mortars the engine's own fire() would just clamp away from
      // the target it was aimed at.
      const elev = elevOf(angle, facing);
      if (elev < loElev || elev > hiElev) continue;
      if (!meta.pierce && blocked(engine, me, angle, power, meta.gravity, meta.speed, Boolean(meta.windproof))) continue;
      options.push({ angle, power, card });
    }
  }

  if (options.length === 0) {
    // Nothing solved: throw something plausible downrange rather than freeze.
    return {
      angle: facing > 0 ? -0.72 : -Math.PI + 0.72,
      power: 0.6 + Math.random() * 0.3,
      card,
    };
  }

  // Prefer a middling power: it keeps the flight watchable and leaves the bot
  // somewhere to go when it needs to correct.
  options.sort((a, b) => Math.abs(a.power - 0.74) - Math.abs(b.power - 0.74));
  return options[Math.floor(Math.random() * Math.min(3, options.length))];
}

/**
 * Which card to play.
 *
 * A swab plays whatever is on top of the hand. Anything above that reads the
 * board first: patch a hull that is about to go under, and reach for the
 * lobbing or rock-piercing shot when there is a rock in the way.
 */
/**
 * The furthest a card could possibly travel, at full power and the angle
 * that maximises range for its own speed and gravity. Not how the ballistics
 * actually get solved -- solve() below does that, angle by angle -- just a
 * cheap ceiling to rule a card out before spending any real work on it.
 *
 * Mortar and grapeshot both trade range for what they're good at up close,
 * which means the water is now wide enough that either can be flatly
 * unreachable from the anchors. Without this check the bot judged every card
 * on damage alone and happily spent a turn heaving a mortar into the sea
 * fifteen ship-lengths short of anything, which reads as broken rather than
 * as the card doing what it says on the tin.
 */
function maxReach(card: CardMeta, maxSpeed: number, dropHeight: number): number {
  const g = BALANCE.GRAVITY * card.gravity;
  const v = maxSpeed * card.speed;
  return (v / g) * Math.sqrt(v * v + Math.max(0, 2 * g * dropHeight));
}

function pickCard(engine: BattleEngine, self: number, target: number, tier: Tier): CardId {
  const hand = engine.hand;
  if (!tier.reads) return hand[Math.floor(Math.random() * hand.length)] ?? 'round';

  const me = engine.ships[self];
  const foe = engine.ships[target];
  if (me.hp <= 38 && hand.includes('patch')) return 'patch';

  const mountainInTheWay = engine.rocks.some((r) => {
    if (r.hp <= 0) return false;
    const lo = Math.min(me.x, foe.x);
    const hi = Math.max(me.x, foe.x);
    return r.x > lo && r.x < hi;
  });
  // Bore is the only card built to ignore the mountain outright, whatever the
  // angle. Mortar could clear it too, but only from within its own locked
  // band -- see elevRange -- which the options loop above already tries and
  // discards on its own merits, so this only needs the one sure thing.
  if (mountainInTheWay && hand.includes('bore')) return 'bore';

  if (me.hp <= 55 && hand.includes('patch')) return 'patch';

  // Distance to the target rules out anything that cannot physically arrive,
  // one card-length of slack for the height difference the bob and the drift
  // put between the two decks.
  const distance = Math.abs(foe.x - me.x);
  const inReach = hand.filter((id) => maxReach(CARDS[id], engine.arena.maxSpeed, 60) >= distance);
  const pool = inReach.length > 0 ? inReach : hand;

  // The biggest stick that can actually land, counting a fan as its total
  // weight.
  return [...pool].sort(
    (a, b) => CARDS[b].damage * CARDS[b].shots - CARDS[a].damage * CARDS[a].shots,
  )[0];
}

/**
 * The elevation that puts a ball of this speed onto that point.
 *
 * Closed form, then three passes to fold the wind in: the crosswind
 * displacement depends on the flight time, and the flight time depends on the
 * angle, so the two are settled by iteration rather than by algebra. Three
 * passes is comfortably enough at these speeds.
 */
function solve(
  engine: BattleEngine,
  self: number,
  targetX: number,
  targetY: number,
  power: number,
  gravityMult: number,
  speedMult: number,
  windproof: boolean,
  high: boolean,
): number | null {
  const g = BALANCE.GRAVITY * gravityMult;
  const v = (BALANCE.MIN_SPEED + (engine.arena.maxSpeed - BALANCE.MIN_SPEED) * power) * speedMult;
  const facing = engine.facing(self);
  const wind = windproof ? 0 : engine.wind * BALANCE.WIND_ACCEL;

  // Everything is solved as if firing rightward, then mirrored back. Halves
  // the sign handling and removes the whole class of bug that lives there.
  const mirror = facing < 0 ? -1 : 1;

  let angle: number | null = null;
  let flight = 0.8;

  for (let pass = 0; pass < 3; pass++) {
    const start = engine.muzzle(self, angle ?? (facing > 0 ? -0.7 : -Math.PI + 0.7));
    const dx = (targetX - start.x) * mirror;
    const dy = targetY - start.y;
    if (dx <= 40) return null;

    // Aim upwind by however far the wind will have pushed the ball by then.
    const dxEff = dx - 0.5 * wind * mirror * flight * flight;
    if (dxEff <= 40) return null;

    const local = arc(dxEff, dy, v, g, high);
    if (local === null) return null;

    flight = dxEff / Math.max(60, v * Math.cos(local));
    // Kept in the same range the aim pad produces, so a bot's parting shot is
    // a valid starting elevation for whoever takes the wheel after it.
    angle = mirror > 0 ? local : -local - Math.PI;
  }
  return angle;
}

/**
 * tan of the launch angle for a flat-fire problem, y measured downward.
 *
 * k*u^2 + dx*u + (k - dy) = 0, where k = g*dx^2 / 2v^2. Two roots: the flat
 * one and the lobbed one.
 */
function arc(dx: number, dy: number, v: number, g: number, high: boolean): number | null {
  const k = (g * dx * dx) / (2 * v * v);
  if (k < 1e-6) return null;
  const disc = dx * dx - 4 * k * (k - dy);
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const flat = (-dx + root) / (2 * k);
  const lobbed = (-dx - root) / (2 * k);
  return Math.atan(high ? Math.min(flat, lobbed) : Math.max(flat, lobbed));
}

/** Walk the arc forward and see whether a rock eats it first. */
function blocked(
  engine: BattleEngine,
  self: number,
  angle: number,
  power: number,
  gravityMult: number,
  speedMult: number,
  windproof: boolean,
): boolean {
  if (engine.rocks.length === 0) return false;
  const g = BALANCE.GRAVITY * gravityMult;
  const v = (BALANCE.MIN_SPEED + (engine.arena.maxSpeed - BALANCE.MIN_SPEED) * power) * speedMult;
  const wind = windproof ? 0 : engine.wind * BALANCE.WIND_ACCEL;

  const start = engine.muzzle(self, angle);
  let x = start.x;
  let y = start.y;
  let vx = Math.cos(angle) * v;
  let vy = Math.sin(angle) * v;
  const dt = 1 / 60;

  for (let i = 0; i < 600; i++) {
    vx += wind * dt;
    vy += g * dt;
    x += vx * dt;
    y += vy * dt;
    if (y > engine.arena.seaY || x < -200 || x > engine.arena.w + 200) return false;
    for (const rock of engine.rocks) {
      if (rock.hp <= 0) continue;
      // Same worn radius the ballistics use, so the bot does not refuse an arc
      // over a rock that is no longer there.
      if (Math.hypot(x - rock.x, y - rock.y) < rockRadius(rock) + BALANCE.BALL_R) return true;
    }
  }
  return false;
}
