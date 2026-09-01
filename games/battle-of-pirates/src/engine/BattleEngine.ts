/**
 * The whole battle: ballistics, damage, the turn order and the rendering.
 *
 * Three things shape this file more than anything else.
 *
 * 1. **Fixed timestep.** Physics runs at a fixed 120 Hz through an
 *    accumulator, so a 144 Hz desktop and a 60 Hz phone simulate the identical
 *    flight. That is not only about feel: it is what lets two clients agree on
 *    where a shot went without exchanging a single position update.
 *
 * 2. **Swept collision, always.** A ball at full power crosses many times its
 *    own diameter in a step. Every collision here is a segment test against
 *    the shape, never a point-inside test, so nothing tunnels through a hull
 *    at close range, which is exactly where a hit matters most.
 *
 * 3. **Every random thing is seeded.** The hand you are dealt, the drift:
 *    all pure functions of (match seed, turn number). Two clients therefore
 *    deal themselves the same match with nothing to negotiate, and the wire
 *    carries turns rather than state.
 */
import { fxSprites, bakeSea, drawFallbackSea, drawRock, drawWaves, rockRadius } from '../game/sea';
import { SHIPS, drawShip } from '../game/ships';
import {
  BALANCE,
  CARDS,
  CardId,
  TEAM_COLORS,
  angleOf,
  arenaFor,
  clamp,
  dealHand,
  elevOf,
  elevRange,
  fleetSizeFor,
  mulberry32,
} from '../game/rules';
import type { Arena } from '../game/rules';
import type { Quality } from '../game/quality';
import type {
  Control,
  MatchRules,
  Phase,
  Projectile,
  FirePacket,
  Rock,
  Ship,
  Shot,
  ShotPacket,
  Team,
} from '../types/game';

export interface Seat {
  team: Team;
  id: string;
  name: string;
  control: Control;
  aiLevel: number;
  skin: number;
}

export type Sfx = 'fire' | 'hull' | 'splash' | 'rock' | 'deal' | 'burn' | 'sink';

export interface EngineConfig {
  /** Two, four or six hulls, evenly split. Order fixes the anchors and the turn order. */
  seats: Seat[];
  seed: number;
  /** Which side opens. The hull that actually fires is that side's front rank. */
  first: Team;
  /**
   * The host's rules, identical on both clients.
   *
   * These are simulation inputs, not preferences: the mountain they spawn and
   * the hands they deal have to match on both sides or the two engines are
   * running different battles.
   */
  rules: MatchRules;
  onPhase?: (phase: Phase) => void;
  /** `ship` is an index into `seats`, not a side. */
  onTurn?: (ship: number, hand: CardId[]) => void;
  onHp?: (hp: number[]) => void;
  /**
   * A packet this device is responsible for, ready to send: the instant
   * preview when a shot is fired, and again with the outcome once it lands.
   */
  onLocalShot?: (packet: FirePacket | ShotPacket) => void;
  onOver?: (winner: Team) => void;
  onSfx?: (kind: Sfx, power?: number) => void;
}

/** 0 fire, 1 smoke, 2 spark, 3 splash, 4 splinter. */
type ParticleKind = 0 | 1 | 2 | 3 | 4;

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  rot: number;
  spin: number;
  color: string;
  /**
   * The water level a spark or splinter drowns at, in world y.
   *
   * Every hull used to sit on the one shared waterline, so a single constant
   * worked for all of them. A back-row ship now sits well below that line,
   * so debris flung from its explosion has to drown at *its* row's depth --
   * fixed to where the burst actually happened, not the front row's.
   */
  sink: number;
}

interface Ring {
  x: number;
  y: number;
  r: number;
  max: number;
  life: number;
  width: number;
}

const STEP = 1 / 120;
const PARTICLE_CAP = 420;
const RING_CAP = 14;
/** Barrel length, so the ball leaves the muzzle rather than the deck. */
const BARREL = 58;
/** A rigging hit is real but glancing. */
const RIG_MULT = 0.55;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The tone a shout or a feed line is said in.
 *
 * Colour is the whole point: a wall of identical cream text scrolling past
 * the corner of a battle is unreadable at the speed things happen here, and
 * the one thing a player has to be able to pick out of it at a glance is
 * whether a hull just went under.
 */
export type CallTone = 'kill' | 'big' | 'hit' | 'graze' | 'miss';

/** One line in the running log, top right. Fades on its own. */
export interface FeedEntry {
  id: number;
  text: string;
  tone: CallTone;
  life: number;
  max: number;
}

/**
 * What one shot did, gathered while it is still in the air.
 *
 * `sweep` used to shout the instant a ball touched a hull, which was fine
 * when every card fired one ball and wrong the moment grapeshot existed:
 * five pellets landing is five calls to `shout`, four of which are overwritten
 * before a frame is drawn, so the loudest thing in the game -- all five
 * pellets connecting -- looked and sounded exactly like a single glancing
 * blow. Everything a shot does is banked here instead and read once, when the
 * last ball has stopped moving.
 */
interface ShotTally {
  shooter: number;
  /** Hulls struck, counted per projectile: five grape pellets on one ship is five. */
  hulls: number;
  rigs: number;
  damage: number;
  /** Ships that went under on this shot, by index. */
  sunk: number[];
  burned: boolean;
  /** A bore shot that went through the mountain and hit something anyway. */
  pierced: boolean;
  /** Nothing was struck, but a blast still reached a hull. */
  grazed: boolean;
}

/** How long a log line stays legible before it starts to go. */
const FEED_LIFE = 4.2;

/** Said when one shot lands more than one ball. Index is the number that landed. */
const MULTI = ['', '', 'double hit!', 'triple hit!', 'four aboard!', 'full broadside!'];

/** Cream for the ordinary, gold for the rare, red for a hull going under. */
const TONE_COLOR: Record<CallTone, string> = {
  kill: '#ff8a7d',
  big: '#fbbf24',
  hit: '#fff7e0',
  graze: '#bae6fd',
  miss: '#94a3b8',
};

export class BattleEngine {
  /**
   * Every hull on the water, in a fixed order both clients agree on.
   *
   * Indexed by ship, not by team: a battle can be six ships across two sides,
   * so `ships[1]` is the second hull in the order, not "the right-hand side".
   * Whose side it is on is `ships[i].team`.
   */
  readonly ships: Ship[];
  /** The water this battle is fought on, sized to the fleet. */
  readonly arena: Arena;
  rocks: Rock[] = [];

  phase: Phase = 'deal';
  /** Index into `ships` of whoever has the helm. */
  turn: number;
  turnNo = 0;
  winner: Team | null = null;
  /** Seconds left to aim. Only counted down on the device whose turn it is. */
  turnClock = BALANCE.TURN_TIME;
  hand: CardId[] = [];
  selected: CardId = 'round';
  /** Big centred shout. Fades on its own. */
  call = '';
  callLeft = 0;
  callTone: CallTone = 'hit';

  /**
   * The running log of what has actually happened, newest first.
   *
   * The centred shout says one thing for a second and a half and is gone.
   * That is right for the shout -- it is punctuation -- but it means a player
   * who was looking at their own aim rather than at the middle of the screen
   * has no way of finding out what the last shot did. This is that record,
   * and in a six-hull fleet action it is the only way to tell which of the
   * three ships over there just went under.
   */
  feed: FeedEntry[] = [];
  private feedId = 0;

  /** Consecutive turns this hull has landed a shot. Reset by a miss. */
  streak: number[] = [];

  /** What the shot currently in the air has done so far. Null between turns. */
  private tally: ShotTally | null = null;

  /** Aim the local player is holding, in world radians and 0..1. */
  aimAngle = -0.7;
  aimPower = 0.65;
  /** True while a finger or the mouse is down, so the arc only shows then. */
  aiming = false;
  /**
   * Did this team's last shot actually strike the enemy? null before its first.
   *
   * Deliberately a hit and not a distance. The obvious version compared where
   * the shot landed against the enemy's centre, and it never worked: a hull
   * hit is recorded where the swept segment first touches the box, which is up
   * to a hull's half-width plus a ball radius short of the middle. Every clean
   * hit therefore measured as a near miss, and the bots tightened their aim
   * forever instead of settling.
   */
  lastShotHit: (boolean | null)[] = [];

  private cfg: EngineConfig;
  private projectiles: Projectile[] = [];
  private particles: Particle[] = [];
  private pool: Particle[] = [];
  private rings: Ring[] = [];
  private backdrop: HTMLCanvasElement | null = null;
  private acc = 0;
  private clock = 0;
  private shake = 0;
  private phaseTimer = 0;
  private botTimer = 0;
  private sinkT = 0;
  private budget = 1;

  /** Burn stacks as they stood before the current shot, so a firebomb cannot tick on itself. */
  private burnBefore: number[] = [];
  /** The last hull on each side to take a shot, so the helm goes round a fleet rather than sticking. */
  private lastFired: Record<Team, number> = { 0: -1, 1: -1 };
  /** The preview of the other side's shot: what was fired, before its outcome is known. */
  private pendingFire: FirePacket | null = null;
  /** The other side's shot, fully resolved -- HP, drift, the mountain, next turn. */
  private pendingRemote: ShotPacket | null = null;
  /**
   * True from the moment a remote shot starts flying until its outcome is
   * known, whichever order the preview and the outcome arrive in.
   *
   * Set so the impact phase knows to hold the picture rather than guess if
   * the outcome is still in flight over the network when the local hold
   * would otherwise have ended it.
   */
  private awaitingOutcome = false;
  /**
   * How long this side has been holding at the end of the impact phase,
   * waiting for an outcome that hasn't shown up.
   *
   * Every other source of applyShot/applyFire eventually gets its packet;
   * the one that doesn't is a partner who vanished between firing and
   * landing. Without a ceiling on the wait, that seat's screen freezes on
   * the impact for good, since nothing else in the engine ever calls
   * resolve() on its own. handOverToAI() clears this the moment a bye or a
   * dropped connection is actually noticed; this is the fallback for a
   * partner who is gone but hasn't been declared so yet.
   */
  private outcomeWait = 0;
  /**
   * Did fire() send a preview for the shot currently resolving?
   *
   * Almost always yes. The one time it doesn't is a partner's shot that was
   * still in the air over the wire when they dropped and their seat flipped
   * from 'remote' to 'ai' -- fire() saw 'remote' and stayed quiet, resolve()
   * sees 'ai' and would otherwise reuse a sequence number that was never
   * actually sent for this shot.
   */
  private firedPreviewThisShot = false;
  private lastShot: Shot | null = null;
  /** Counted separately: one is what we have sent, the other what we have seen. */
  private localSeq = 0;
  /**
   * The last sequence number seen FROM EACH SENDER, keyed by their uid.
   *
   * Per sender, not one number for "the wire", and that distinction is the
   * whole reason a fleet action works at all. `localSeq` is a per-client
   * counter that starts at zero, so every player's first shot of a match is
   * numbered 1, their second 2, and so on -- the numbers are only meaningful
   * relative to the person who wrote them. A single shared counter therefore
   * did the right thing in a duel, where there is exactly one other person
   * sending, and silently ate shots in a 2v2: the first captain to fire set
   * it to 1, and the next captain's own first shot arrived as 1, failed the
   * `<=` staleness test, and was dropped without a trace. Which shots
   * vanished depended on the order people had fired on each particular
   * device, so the same turn would land on some screens and not others --
   * exactly the report this fixes.
   */
  private remoteFireSeq = new Map<string, number>();
  private remoteSeq = new Map<string, number>();

  // Viewport transform, recomputed on resize.
  private scale = 1;
  private offX = 0;
  private offY = 0;
  private dpr = 1;

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;

    // Slots run back from the front rank in the order the seats were handed
    // over, so both clients put the same captain on the same anchor.
    const filled: Record<Team, number> = { 0: 0, 1: 0 };
    this.arena = arenaFor(fleetSizeFor(cfg.seats.length));
    this.ships = cfg.seats.map((seat, i) => this.makeShip(seat, filled[seat.team]++, i * 2.1));
    this.lastShotHit = this.ships.map(() => null);
    this.streak = this.ships.map(() => 0);
    this.burnBefore = this.ships.map(() => 0);

    // `first` names the side that opens; the hull that actually fires is that
    // side's front rank.
    this.turn = Math.max(0, this.ships.findIndex((s) => s.team === cfg.first));

    const rnd = this.rngFor(0);
    for (const ship of this.ships) {
      ship.x = ship.anchorX + (rnd() * 2 - 1) * this.arena.driftStep;
    }
    if (cfg.rules.mountain !== 'off') this.spawnRocks(rnd);

    this.beginTurn();
  }

  private makeShip(seat: Seat, slot: number, bobPhase: number): Ship {
    const anchorX = this.arena.anchor[seat.team][slot] ?? this.arena.anchor[seat.team][0];
    return {
      team: seat.team,
      slot,
      id: seat.id,
      name: seat.name,
      control: seat.control,
      aiLevel: seat.aiLevel,
      skin: clamp(seat.skin, 0, SHIPS.length - 1),
      hp: BALANCE.MAX_HP,
      anchorX,
      x: anchorX,
      burn: 0,
      bobPhase,
      flash: 0,
      lean: 0,
      lastAim: { angle: seat.team === 0 ? -0.72 : -Math.PI + 0.72, power: 0.65 },
    };
  }

  /** Living hulls still flying a side's colours. */
  private afloat(team: Team): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.ships.length; i++) {
      if (this.ships[i].team === team && this.ships[i].hp > 0) out.push(i);
    }
    return out;
  }

  /**
   * Who fires after this hull.
   *
   * The helm alternates sides every single turn, however lopsided the battle
   * has become: a fleet down to its last ship still gets every other shot
   * rather than being pounded three times between replies. Within a side it
   * goes round the survivors in order, so the same captain does not fire twice
   * while a crewmate waits.
   */
  private nextTurn(from: number): number {
    const other = (1 - this.ships[from].team) as Team;
    const theirs = this.afloat(other);
    if (theirs.length > 0) {
      // Whoever on that side has waited longest — the first one past the last
      // of theirs to fire, wrapping around.
      const after = theirs.find((i) => i > (this.lastFired[other] ?? -1));
      return after ?? theirs[0];
    }
    // Nobody left to answer; the same side keeps firing until finish() notices.
    const mine = this.afloat(this.ships[from].team);
    return mine.find((i) => i > from) ?? mine[0] ?? from;
  }

  /**
   * One generator per turn, derived from the match seed.
   *
   * Not one long stream: a client replaying a turn to animate it must draw the
   * same hand and the same drift as the client that played it. Keying on the
   * turn number makes every draw reproducible from the two numbers both sides
   * already hold.
   */
  private rngFor(turn: number): () => number {
    return mulberry32((this.cfg.seed ^ Math.imul(turn, 0x9e3779b1)) >>> 0);
  }

  /**
   * A fresh, seeded stream for one bot's decision this turn.
   *
   * `chooseShot` used to reach for `Math.random()` directly, which was fine
   * for the single-device case it was written for but not for an online
   * match: every connected client runs its own copy of this engine and its
   * own copy of `update()`'s `ship.control === 'ai'` branch, so an
   * unseeded bot decision meant the host, and every guest, independently
   * rolled a *different* shot for the exact same bot on the exact same turn
   * -- different aim, different card, sometimes a different target -- and
   * then each broadcast its own guess as if it were authoritative. Two
   * clients disagreeing about what a bot just did, mid-turn-cycle, is what
   * "not synced" and "wasn't waiting for other players" both look like from
   * the outside.
   *
   * Salted on the shooter as well as the turn so two different bots acting
   * in the same match never draw from the same stream, the same reason
   * `rngFor` itself is keyed on the turn rather than one long-running
   * generator.
   */
  aiRng(shooter: number): () => number {
    return this.rngFor(this.turnNo * 97 + shooter * 131 + 700003);
  }

  /**
   * The mountain between the two anchors.
   *
   * One landmass, not a reef of two or three -- tall enough (see ROCK_R_MIN)
   * that nothing at a working elevation skims past it. Going over the top,
   * dropping a mortar on the far side, or boring straight through are the
   * three answers, and picking one is the turn's real decision.
   *
   * It spawns within a band held clear of either hull at its furthest drift,
   * with a little wander so it is not the same shot every match, but always
   * roughly amidships -- there is only the one, and putting it near either
   * anchor would just hand that side a free flat lane down the far side.
   */
  private spawnRocks(rnd: () => number) {
    // Measured from the innermost hull of each fleet, so the mountain always
    // sits in the open water between the two front ranks rather than drifting
    // out among the rear ships as the battle gets bigger.
    const lo = this.arena.anchor[0][0] + BALANCE.ROCK_MARGIN;
    const hi = this.arena.anchor[1][0] - BALANCE.ROCK_MARGIN;
    const mid = (lo + hi) / 2;
    const wander = (hi - lo) * 0.22;
    const r = BALANCE.ROCK_R_MIN + rnd() * (BALANCE.ROCK_R_MAX - BALANCE.ROCK_R_MIN);
    this.rocks.push({
      x: clamp(mid + (rnd() * 2 - 1) * wander, lo, hi),
      y: this.arena.seaY - 6 - rnd() * 26,
      r,
      hp: BALANCE.ROCK_HP,
      seed: (rnd() * 0xffffff) | 0,
    });
  }

  // -- geometry ---------------------------------------------------------------
  //
  // Every one of these takes a ship index, not a team. In a duel the two were
  // the same number and the distinction did not exist; with six hulls it is
  // the difference between aiming at a ship and aiming at a side.

  /** Waterline the hull is riding on this instant. The bob is real, not paint. */
  shipY(i: number): number {
    const ship = this.ships[i];
    return this.waterLevelFor(i) + Math.sin(this.clock * BALANCE.BOB_SPEED + ship.bobPhase) * BALANCE.BOB_AMP;
  }

  /** The still-water level (no bob) a given hull's own row sits at. */
  private waterLevelFor(i: number): number {
    return this.arena.seaY + (this.arena.rowDepth[this.ships[i].slot] ?? 0);
  }

  /** Which way this hull points, which is always across the water at the enemy. */
  facing(i: number): 1 | -1 {
    return this.ships[i].team === 0 ? 1 : -1;
  }

  /** The pivot the barrel turns about. */
  private trunnion(i: number): { x: number; y: number } {
    return {
      x: this.ships[i].x + this.facing(i) * BALANCE.MUZZLE_X,
      y: this.shipY(i) + BALANCE.MUZZLE_Y,
    };
  }

  /** The mouth of the barrel at a given elevation, where a ball actually appears. */
  muzzle(i: number, angle: number): { x: number; y: number } {
    const t = this.trunnion(i);
    return { x: t.x + Math.cos(angle) * BARREL, y: t.y + Math.sin(angle) * BARREL };
  }

  private hullBox(i: number): Box {
    const x = this.ships[i].x;
    const y = this.shipY(i);
    return { x0: x - BALANCE.HULL_W / 2, y0: y - 62, x1: x + BALANCE.HULL_W / 2, y1: y + 22 };
  }

  /** Mast and canvas. Worth hitting, worth less than the hull. */
  private rigBox(i: number): Box {
    const x = this.ships[i].x;
    const y = this.shipY(i);
    const f = this.facing(i);
    const a = x + f * -92;
    const b = x + f * 104;
    return { x0: Math.min(a, b), y0: y - 242, x1: Math.max(a, b), y1: y - 62 };
  }

  // -- the turn ---------------------------------------------------------------

  private beginTurn() {
    const rnd = this.rngFor(this.turnNo + 1);
    // Cards off is a real mode, not a hidden hand: everyone fires the plain
    // round shot every turn, so the battle is aim and range and nothing else.
    // Skipping the deal leaves this turn's generator untouched, which costs
    // nothing — drift rolls from its own stream (see resolve), and both
    // clients are on the same rule either way.
    this.hand = this.cfg.rules.cards ? dealHand(rnd) : ['round'];
    this.selected = this.hand[0];
    this.phase = 'deal';
    this.phaseTimer = 0.5;
    this.turnClock = BALANCE.TURN_TIME;
    const ship = this.ships[this.turn];
    this.aimAngle = ship.lastAim.angle;
    this.aimPower = ship.lastAim.power;
    this.cfg.onSfx?.('deal');
    this.cfg.onTurn?.(this.turn, this.hand);
    this.cfg.onPhase?.(this.phase);
  }

  /** True when the human sitting at this device is the one who has to shoot. */
  get awaitingLocal(): boolean {
    return this.phase === 'aim' && this.ships[this.turn].control === 'local';
  }

  /** True while the turn belongs to somebody at the other end of a wire. */
  get awaitingRemote(): boolean {
    return (
      (this.phase === 'aim' || this.phase === 'deal') && this.ships[this.turn].control === 'remote'
    );
  }

  get hp(): number[] {
    return this.ships.map((s) => Math.max(0, Math.round(s.hp)));
  }

  select(card: CardId) {
    if (this.phase === 'aim' && this.hand.includes(card)) this.selected = card;
  }

  setBudget(scale: number) {
    this.budget = scale;
  }

  /**
   * Fire from the ship whose turn it is.
   *
   * One entry point for every source of a shot: a thumb, a keyboard, the turn
   * clock running out, a bot, or the far end of a wire. Nothing downstream has
   * to know which it was.
   */
  fire(shot: Shot) {
    if (this.phase !== 'aim' && this.phase !== 'deal') return;
    const shooter = this.turn;
    const ship = this.ships[shooter];
    const card = CARDS[shot.card] ?? CARDS.round;
    // The aim pad, the keyboard and the bot's solver all already respect a
    // card's elevation band, but this is the one place every source of a shot
    // -- including whatever a peer's client claims it fired -- actually has to
    // pass through, so it is the one place the mortar's lock is guaranteed
    // rather than merely usually true.
    const facing = this.facing(shooter);
    const [loElev, hiElev] = elevRange(card.id);
    const angle = angleOf(clamp(elevOf(shot.angle, facing), loElev, hiElev), facing);
    const power = clamp(shot.power, 0.05, 1);

    ship.lastAim = { angle, power };
    this.lastShot = { angle, power, card: card.id };
    this.lastShotHit[shooter] = false;
    this.lastFired[ship.team] = shooter;
    this.burnBefore = this.ships.map((s) => s.burn);
    this.tally = { shooter, hulls: 0, rigs: 0, damage: 0, sunk: [], burned: false, pierced: false, grazed: false };

    // Sent before a single physics step has run. Only for a shot this device
    // actually owns -- not a replay of what the wire just handed us, and not
    // a bot's turn, which every client now decides identically on its own
    // (see aiRng) and so never needs to send at all. This used to read
    // `!== 'remote'`, which -- despite what this very comment already
    // claimed -- included 'ai' and broadcast every bot decision from every
    // connected device at once.
    this.firedPreviewThisShot = Boolean(this.cfg.onLocalShot) && ship.control === 'local';
    if (this.firedPreviewThisShot) {
      this.localSeq += 1;
      this.cfg.onLocalShot!({
        t: 'fire',
        n: this.localSeq,
        s: this.cfg.seed,
        a: round3(angle),
        p: round3(power),
        c: card.id,
      });
    }

    if (card.heal) {
      ship.hp = Math.min(BALANCE.MAX_HP, ship.hp + card.heal);
      this.cfg.onHp?.(this.hp);
    }

    const speed = (BALANCE.MIN_SPEED + (this.arena.maxSpeed - BALANCE.MIN_SPEED) * power) * card.speed;
    const mouth = this.muzzle(shooter, angle);

    for (let i = 0; i < card.shots; i++) {
      // Fanned symmetrically about the aim, so a single-shot card is dead on
      // and a five-pellet card still centres where the player pointed.
      const offset = card.shots === 1 ? 0 : (i - (card.shots - 1) / 2) * card.spread;
      const a = angle + offset;
      this.projectiles.push({
        x: mouth.x,
        y: mouth.y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        r: BALANCE.BALL_R * (card.shots > 2 ? 0.62 : 1),
        team: ship.team,
        from: shooter,
        damage: BALANCE.DIRECT * card.damage,
        blast: BALANCE.BLAST_R * card.blast,
        gravity: BALANCE.GRAVITY * card.gravity,
        pierce: Boolean(card.pierce),
        through: false,
        burn: card.burn ?? 0,
        alive: true,
        age: 0,
        trail: [],
      });
    }

    // The hull kicks away from the shot and rights itself.
    ship.lean += facing * -0.09;
    this.muzzleFlash(mouth.x, mouth.y, angle);
    this.shake = Math.max(this.shake, 6 + power * 8);
    this.phase = 'flight';
    this.cfg.onSfx?.('fire', power);
    this.cfg.onPhase?.(this.phase);
  }

  /**
   * The preview of a shot that just left the other side's barrel.
   *
   * Picked up in update() the instant it's this seat's turn to receive it,
   * which starts the flight animating in step with the shooter rather than
   * waiting for their whole resolution to cross the wire first. It is not
   * itself trusted for the outcome -- ShotPacket still is -- only for what
   * to point the barrel at and when to let go.
   */
  applyFire(packet: FirePacket, from: string) {
    if (packet.s !== this.cfg.seed) return;
    if (packet.n <= (this.remoteFireSeq.get(from) ?? 0)) return;
    this.remoteFireSeq.set(from, packet.n);
    this.pendingFire = packet;
  }

  /**
   * A turn that arrived over the wire, fully resolved.
   *
   * Usually this lands while the preview above is already animating and just
   * waits to be picked up once that flight settles. If the preview was lost
   * or came from a peer old enough not to send one, this doubles as its own
   * trigger -- it carries the same angle and power a FirePacket would have.
   */
  applyShot(packet: ShotPacket, from: string) {
    // A player's update document outlives the match that wrote it, so the
    // first snapshot after subscribing can be last night's final shot.
    if (packet.s !== this.cfg.seed) return;
    if (packet.n <= (this.remoteSeq.get(from) ?? 0)) return;
    this.remoteSeq.set(from, packet.n);
    this.pendingRemote = packet;
  }

  /** A player who left hands their wheel to a bot rather than stranding the match. */
  handOverToAI(i: number, level = 1) {
    const ship = this.ships[i];
    if (ship.control !== 'remote') return;
    ship.control = 'ai';
    ship.aiLevel = level;
    ship.name = `${ship.name} (adrift)`;
    this.pendingFire = null;
    this.pendingRemote = null;
    this.awaitingOutcome = false;
    if (this.phase === 'aim' && this.turn === i) this.botTimer = BALANCE.BOT_THINK;
  }

  /**
   * The other half of handOverToAI: a captain who came back gets their wheel
   * back, even mid-match.
   *
   * Deliberately does not check whose turn it is. A bot may already be
   * mid-think for this ship when the real captain returns — the check inside
   * `update()`'s bot-decision branch is against `ship.control`, so flipping
   * it here is enough to stop the bot from acting again; there is nothing
   * further to unwind because nothing has been decided yet, only queued.
   */
  reclaimControl(i: number) {
    const ship = this.ships[i];
    if (ship.control !== 'ai') return;
    ship.control = 'remote';
    ship.name = ship.name.replace(/ \(adrift\)$/, '');
    this.botTimer = 0;
  }

  // -- simulation -------------------------------------------------------------

  update(dt: number, decide?: (ship: number) => Shot) {
    this.clock += dt;
    this.acc += Math.min(dt, 0.25);

    let steps = 0;
    while (this.acc >= STEP && steps < 10) {
      this.acc -= STEP;
      steps++;
      this.step(STEP);
    }
    // A tab that was asleep must not spend a minute on catch-up frames.
    if (this.acc > STEP * 10) this.acc = 0;

    this.decay(dt);

    if (this.phase === 'over') {
      this.sinkT = Math.min(1, this.sinkT + dt * 0.55);
      return;
    }

    if (this.phase === 'deal') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        this.phase = 'aim';
        this.botTimer = BALANCE.BOT_THINK;
        this.cfg.onPhase?.(this.phase);
      }
      return;
    }

    if (this.phase === 'aim') {
      const ship = this.ships[this.turn];

      if (ship.control === 'remote') {
        // Whichever arrived first triggers the flight -- the preview, or,
        // failing that, the fully resolved packet, which carries the same
        // aim and doubles as its own trigger. Either way `this.pendingRemote`
        // is left exactly as it was: still null if only the preview has
        // shown up, or holding the outcome that resolve() will read once the
        // flight settles.
        const trigger = this.pendingFire ?? this.pendingRemote;
        if (!trigger) return;
        this.pendingFire = null;
        this.awaitingOutcome = this.pendingRemote === null;
        this.fire({ angle: trigger.a, power: trigger.p, card: trigger.c });
        return;
      }

      if (ship.control === 'ai' && decide) {
        this.botTimer -= dt;
        if (this.botTimer <= 0) this.fire(decide(this.turn));
        return;
      }

      if (this.cfg.rules.turnTimer) {
        this.turnClock -= dt;
        if (this.turnClock <= 0) {
          this.shout('out of time');
          this.fire({ angle: this.aimAngle, power: this.aimPower, card: this.selected });
        }
      }
      return;
    }

    if (this.phase === 'impact') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        // The local hold is over, but if this was a remote shot started from
        // a preview, its outcome might genuinely not be here yet -- hold the
        // picture rather than guess. In practice the two arrive within a
        // frame of each other: this side's own hold and the shooter's send
        // both start from the same shot and run for close to the same
        // length of time, so the wait, when it happens at all, is a network
        // round trip, not the multi-second one this replaced. The ceiling
        // below is only for a partner who went quiet mid-turn.
        if (this.awaitingOutcome && !this.pendingRemote) {
          this.outcomeWait += dt;
          if (this.outcomeWait < BALANCE.OUTCOME_TIMEOUT) return;
          this.awaitingOutcome = false;
        }
        this.resolve();
      }
    }
  }

  private step(dt: number) {
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.age += dt;
      p.vy += p.gravity * dt;

      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;

      this.sweep(p, nx, ny);

      if (!p.alive) continue;
      p.x = nx;
      p.y = ny;
      if (p.trail.length > 30) p.trail.splice(0, 2);
      p.trail.push(nx, ny);

      // Off the sides is a miss, not an explosion. Above is fine: gravity
      // brings a lofted mortar back, and despawning at y < 0 is precisely the
      // bug that eats every high shot.
      if (p.x < -260 || p.x > this.arena.w + 260 || p.age > BALANCE.MAX_FLIGHT) p.alive = false;
    }

    if (this.phase === 'flight' && !this.projectiles.some((p) => p.alive)) {
      this.projectiles.length = 0;
      this.callShot();
      this.phase = 'impact';
      this.phaseTimer = BALANCE.IMPACT_HOLD;
      this.cfg.onPhase?.(this.phase);
    }

    this.stepParticles(dt);
  }

  /**
   * Swept collision for one projectile step.
   *
   * Everything is tested against the segment from where the ball is to where
   * it is about to be, and the earliest hit wins. A point-in-shape test would
   * miss a hull entirely at full power, and it would do it most often on the
   * shots the player cared about.
   */
  private sweep(p: Projectile, nx: number, ny: number) {
    let best = 2;
    let kind: 'hull' | 'rig' | 'rock' | 'water' | null = null;
    let struckShip = 0;
    let struck: Rock | null = null;

    for (let i = 0; i < this.ships.length; i++) {
      // Friendly fire is off: a shot passes straight through every hull and
      // yard of rigging flying its own colours, own ship included, so a
      // crewmate parked in the flight path is never an obstacle.
      if (this.ships[i].team === p.team) continue;
      if (this.ships[i].hp <= 0) continue;

      const th = segmentBox(p.x, p.y, nx, ny, this.hullBox(i), p.r);
      if (th !== null && th < best) {
        best = th;
        kind = 'hull';
        struckShip = i;
      }
      const tr = segmentBox(p.x, p.y, nx, ny, this.rigBox(i), p.r);
      if (tr !== null && tr < best) {
        best = tr;
        kind = 'rig';
        struckShip = i;
      }
    }

    if (p.pierce) {
      // Not a collision test -- a bore shot never stops at the rock. Purely
      // so the shout can tell a bore that punched through the mountain from
      // one that simply flew past where the mountain was not.
      for (const rock of this.rocks) {
        if (rock.hp <= 0) continue;
        if (segmentCircle(p.x, p.y, nx, ny, rock.x, rock.y, rockRadius(rock)) !== null) p.through = true;
      }
    } else {
      for (const rock of this.rocks) {
        if (rock.hp <= 0) continue;
        const t = segmentCircle(p.x, p.y, nx, ny, rock.x, rock.y, rockRadius(rock) + p.r);
        if (t !== null && t < best) {
          best = t;
          kind = 'rock';
          struck = rock;
        }
      }
    }

    // The deep plane, not the front rank's own waterline -- see Arena.deepSeaY.
    // A ball is only a genuine miss once it has fallen past every row that
    // exists in this battle, not the instant it reaches the shallowest one.
    if (p.vy > 0 && ny + p.r >= this.arena.deepSeaY) {
      const denom = ny - p.y;
      const t = clamp(Math.abs(denom) < 1e-6 ? 0 : (this.arena.deepSeaY - (p.y + p.r)) / denom, 0, 1);
      if (t < best) {
        best = t;
        kind = 'water';
      }
    }

    if (!kind) return;

    const ix = p.x + (nx - p.x) * best;
    const iy = p.y + (ny - p.y) * best;
    p.alive = false;

    if (kind === 'hull' || kind === 'rig') {
      // Struck ships are always the enemy now -- friendly hulls and rigging
      // are skipped entirely above, before a segment test is even run against
      // them.
      const mult = kind === 'rig' ? RIG_MULT : 1;
      this.lastShotHit[p.from] = true;
      if (this.tally) {
        if (kind === 'rig') this.tally.rigs++;
        else this.tally.hulls++;
        // A bore that has already been through the rock and still found a
        // hull is the one shot in the deck worth calling by name.
        if (p.through) this.tally.pierced = true;
      }
      this.damage(struckShip, p.damage * mult, ix);
      if (p.burn > 0) {
        this.ships[struckShip].burn = p.burn + 1;
        if (this.tally) this.tally.burned = true;
      }
      this.explode(ix, iy, p, 'hull', this.waterLevelFor(struckShip));
      return;
    }

    if (kind === 'rock' && struck) {
      // A solid mountain still takes the shot and still stops the ball — it
      // just never wears through, so `drawRock` keeps drawing it whole.
      if (this.cfg.rules.mountain !== 'solid') struck.hp -= 1;
      // The mountain sits at row 0 always, whichever ship fired at it.
      this.explode(ix, iy, p, 'rock', this.arena.seaY);
      this.splashDamage(ix, iy, p);
      return;
    }

    this.explode(ix, this.arena.deepSeaY, p, 'water', this.arena.deepSeaY);
    this.splashDamage(ix, this.arena.deepSeaY, p);
  }

  /** Blast falls off to nothing at the edge, so a near miss still counts for something. */
  private splashDamage(x: number, y: number, p: Projectile) {
    let closest = Infinity;
    for (let i = 0; i < this.ships.length; i++) {
      if (this.ships[i].hp <= 0) continue;
      // Friendly fire is off: a blast reaching a hull flying its own colours
      // never damages it, same as a direct hit above.
      if (this.ships[i].team === p.team) continue;
      const box = this.hullBox(i);
      const dx = Math.max(box.x0 - x, 0, x - box.x1);
      const dy = Math.max(box.y0 - y, 0, y - box.y1);
      const dist = Math.hypot(dx, dy);
      closest = Math.min(closest, dist);
      if (dist >= p.blast) continue;

      const falloff = 1 - dist / p.blast;
      const dealt = BALANCE.BLAST * falloff * falloff * (p.damage / BALANCE.DIRECT);
      if (dealt > 0.7) this.damage(i, dealt, x);
    }
    if (closest < p.blast && this.tally) this.tally.grazed = true;
  }

  private damage(i: number, amount: number, fromX: number) {
    const ship = this.ships[i];
    if (ship.hp <= 0 || amount <= 0) return;
    ship.hp = Math.max(0, ship.hp - amount);
    if (this.tally) {
      this.tally.damage += amount;
      // Checked here rather than by scanning the fleet afterwards, because
      // this is the only place that knows a hull crossed zero *on this shot*
      // rather than having already been under before it was fired.
      if (ship.hp <= 0) this.tally.sunk.push(i);
    }
    ship.flash = Math.min(1, ship.flash + amount / 30);
    ship.lean += (fromX < ship.x ? 1 : -1) * Math.min(0.12, amount / 260);
    this.shake = Math.min(34, this.shake + amount * 0.4);
    this.cfg.onSfx?.('hull', clamp(amount / BALANCE.DIRECT, 0.2, 1));
    this.cfg.onHp?.(this.hp);
  }

  /**
   * The turn is over: fires tick, the sea shifts, and the helm changes hands.
   *
   * A shot that came over the wire hands us its own numbers here. We animated
   * the identical flight, but the shooter decides what it did, which is the
   * whole reason the two clients never have to agree on a float.
   */
  private resolve() {
    const packet = this.pendingRemote;
    this.pendingRemote = null;
    this.awaitingOutcome = false;
    this.outcomeWait = 0;

    for (let i = 0; i < this.ships.length; i++) {
      const ship = this.ships[i];
      if ((this.burnBefore[i] ?? 0) > 0 && ship.hp > 0) {
        ship.hp = Math.max(0, ship.hp - BALANCE.BURN_PER_TURN);
        ship.burn = Math.max(0, ship.burn - 1);
        this.burnAt(i);
        this.cfg.onSfx?.('burn');
      }
    }

    const next = this.turnNo + 1;

    if (packet) {
      // Trust here is social, not cryptographic: these are friends in a room,
      // and a static site has no server to be the authority. But a single turn
      // still cannot take more than a turn's worth of hull off, so a tampered
      // client cannot end a match in one write.
      for (let i = 0; i < this.ships.length; i++) {
        // A packet from a client that somehow has a different idea of the
        // fleet size leaves the missing hulls exactly as they were, rather
        // than reading `undefined` into the simulation.
        if (packet.hp[i] !== undefined) this.ships[i].hp = clampClaim(this.ships[i].hp, packet.hp[i]);
        if (packet.f[i] !== undefined) this.ships[i].burn = clamp(Math.round(packet.f[i]), 0, 4);
        if (packet.d[i] !== undefined) this.ships[i].x = this.clampDrift(i, packet.d[i]);
      }
      // The mountain's hull is authoritative here too, the same reason ship hp
      // is: two clients replaying the identical flight can still land on two
      // different ideas of whether it grazed the rock, and nothing else ever
      // corrected that divergence once it happened -- the same rock stayed
      // wrong, differently, on each screen for the rest of the match.
      for (let i = 0; i < this.rocks.length; i++) {
        if (packet.rk[i] !== undefined) this.rocks[i].hp = clamp(packet.rk[i], 0, BALANCE.ROCK_HP);
      }
      this.turnNo = next;
      this.turn = clamp(Math.round(packet.o), 0, this.ships.length - 1);
      this.lastFired[this.ships[this.turn].team] = this.turn;
    } else {
      const rnd = this.rngFor(next + 977);
      for (let i = 0; i < this.ships.length; i++) this.ships[i].x = this.drift(i, rnd);
      const shooter = this.turn;
      this.turnNo = next;
      this.turn = this.nextTurn(shooter);

      // Only a real local human's seat produces a packet. A bot never does --
      // whether it started the match that way or took over for someone who
      // left, aiRng makes its decision a pure function of the match seed, the
      // turn and the seat, so every connected client (host, every guest, and
      // a device that only just inherited the wheel after a `bye`) computes
      // the identical shot on its own and there is nothing to exchange. An
      // offline match has nobody listening either way, and the hook is
      // simply absent.
      if (this.cfg.onLocalShot && this.lastShot && this.ships[shooter].control === 'local') {
        this.cfg.onLocalShot({
          t: 'shot',
          // The same number the preview went out under, so the two halves of
          // this shot correlate on the far side -- unless there was no
          // preview to match (see firedPreviewThisShot), in which case this
          // is the first anyone has heard of the shot and needs a fresh one.
          n: this.firedPreviewThisShot ? this.localSeq : ++this.localSeq,
          s: this.cfg.seed,
          a: round3(this.lastShot.angle),
          p: round3(this.lastShot.power),
          c: this.lastShot.card,
          hp: this.ships.map((s) => Math.round(s.hp)),
          f: this.ships.map((s) => s.burn),
          d: this.ships.map((s) => Math.round(s.x)),
          rk: this.rocks.map((r) => Math.round(r.hp)),
          o: this.turn,
        });
      }
    }

    this.cfg.onHp?.(this.hp);

    // A side is beaten when every one of its hulls is under, not when any one
    // of them is — which is the whole difference between a duel and a fleet.
    if (this.afloat(0).length === 0 || this.afloat(1).length === 0) {
      this.finish();
      return;
    }
    this.beginTurn();
  }

  private clampDrift(i: number, x: number): number {
    const anchor = this.ships[i].anchorX;
    return clamp(x, anchor - this.arena.driftMax, anchor + this.arena.driftMax);
  }

  private drift(i: number, rnd: () => number): number {
    return this.clampDrift(i, this.ships[i].x + (rnd() * 2 - 1) * this.arena.driftStep);
  }

  private finish() {
    const timber = (team: Team) =>
      this.ships.reduce((sum, s) => (s.team === team ? sum + Math.max(0, s.hp) : sum), 0);
    const a = timber(0);
    const b = timber(1);
    // Both fleets gone is a real outcome: a mortar into your own rigging can
    // do it. Whichever side is still floating on more timber takes it; dead
    // level, the side that did not fire survives.
    this.winner = a > b ? 0 : b > a ? 1 : ((1 - this.ships[this.turn].team) as Team);
    this.phase = 'over';
    this.sinkT = 0;
    const loser = (1 - this.winner) as Team;
    for (let i = 0; i < this.ships.length; i++) if (this.ships[i].team === loser) this.wreck(i);
    this.shout('she goes down!');
    this.cfg.onSfx?.('sink');
    this.cfg.onPhase?.(this.phase);
    this.cfg.onOver?.(this.winner);
  }

  // -- effects ---------------------------------------------------------------

  /**
   * A pool, not an allocation.
   *
   * A hundred short-lived objects per explosion is a hundred objects for the
   * collector to find later, and it finds them mid-rally. At the cap the
   * oldest live particle is reused rather than the burst being refused: a
   * thinner explosion still reads as an explosion, a missing one does not.
   */
  private take(): Particle {
    if (this.particles.length >= PARTICLE_CAP) {
      const oldest = this.particles.shift() as Particle;
      this.particles.push(oldest);
      return oldest;
    }
    const p =
      this.pool.pop() ??
      ({ kind: 0, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 1, grow: 1, rot: 0, spin: 0, color: '#fff' } as Particle);
    this.particles.push(p);
    return p;
  }

  /** Counts are multiplied by the quality budget, so one tier drop thins every burst. */
  private burst(
    count: number,
    kind: ParticleKind,
    x: number,
    y: number,
    sinkY: number,
    make: (p: Particle, t: number) => void,
  ) {
    const n = Math.max(1, Math.round(count * this.budget));
    for (let i = 0; i < n; i++) {
      const p = this.take();
      p.kind = kind;
      p.x = x;
      p.y = y;
      p.rot = 0;
      p.spin = 0;
      p.grow = 1;
      p.color = '#fff';
      // Set on every particle, spark or not: a pooled one that used to be a
      // spark can come back as anything, and a stale value from its last
      // life would drown it at the wrong depth.
      p.sink = sinkY;
      make(p, n === 1 ? 0 : i / (n - 1));
    }
  }

  /**
   * @param sinkY The water level, in world y, that debris from this blast
   * drowns at -- the struck ship's own row for a hull hit, `seaY` for the
   * mountain (always row 0), or the impact point itself for a water splash.
   */
  private explode(x: number, y: number, p: Projectile, surface: 'hull' | 'water' | 'rock', sinkY: number) {
    const power = clamp(p.damage / BALANCE.DIRECT, 0.35, 1.7);
    const scale = p.blast / BALANCE.BLAST_R;

    this.pushRing({ x, y, r: 8, max: 60 * scale + power * 60, life: 1, width: 7 * scale });
    this.shake = Math.min(34, this.shake + 9 * power);

    // Fireball.
    this.burst(11 * power, 0, x, y, sinkY, (q, t) => {
      const a = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 210 * power;
      q.vx = Math.cos(a) * speed;
      q.vy = Math.sin(a) * speed - 40;
      q.max = 0.32 + Math.random() * 0.36;
      q.life = q.max;
      q.size = (34 + t * 46) * scale;
      q.grow = 1.9;
    });

    // Sparks.
    this.burst(14 * power, 2, x, y, sinkY, (q) => {
      const a = Math.random() * Math.PI * 2;
      const speed = 180 + Math.random() * 520 * power;
      q.vx = Math.cos(a) * speed;
      q.vy = Math.sin(a) * speed - 90;
      q.max = 0.45 + Math.random() * 0.5;
      q.life = q.max;
      q.size = 7 + Math.random() * 9;
      q.grow = 0.4;
    });

    // Smoke, which is what is still there a second later.
    this.burst(7 * power, 1, x, y, sinkY, (q) => {
      q.vx = (Math.random() - 0.5) * 130;
      q.vy = -30 - Math.random() * 110;
      q.max = 1.1 + Math.random() * 1.1;
      q.life = q.max;
      q.size = 30 + Math.random() * 46;
      q.grow = 2.4;
    });

    if (surface === 'water') {
      // The passed-in y, not the shallow front-row waterline: a miss past a
      // back-row fleet lands deep in the frame, and a splash drawn at the
      // shallow line while the ring and shake happened down at the real
      // impact point would read as two different events.
      this.burst(15 * power, 3, x, y, sinkY, (q) => {
        q.vx = (Math.random() - 0.5) * 340;
        q.vy = -180 - Math.random() * 460 * power;
        q.max = 0.7 + Math.random() * 0.55;
        q.life = q.max;
        q.size = 16 + Math.random() * 30;
        q.grow = 1.5;
      });
      this.pushRing({ x, y, r: 10, max: 120 * scale, life: 1, width: 5 });
      this.cfg.onSfx?.('splash');
    } else if (surface === 'rock') {
      this.debris(x, y, power, '#5b6675', sinkY);
      this.cfg.onSfx?.('rock');
    } else {
      this.debris(x, y, power, '#8b5a2b', sinkY);
    }
  }

  private pushRing(ring: Ring) {
    if (this.rings.length >= RING_CAP) this.rings.shift();
    this.rings.push(ring);
  }

  private debris(x: number, y: number, power: number, color: string, sinkY: number) {
    this.burst(9 * power, 4, x, y, sinkY, (q) => {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      const speed = 190 + Math.random() * 430 * power;
      q.vx = Math.cos(a) * speed;
      q.vy = Math.sin(a) * speed;
      q.max = 1 + Math.random() * 0.9;
      q.life = q.max;
      q.size = 5 + Math.random() * 11;
      q.rot = Math.random() * Math.PI;
      q.spin = (Math.random() - 0.5) * 14;
      q.color = color;
    });
  }

  private muzzleFlash(x: number, y: number, angle: number) {
    // Neither burst below is a spark, splash or splinter, so sinkY is never
    // read for these -- passed as y itself only because burst() takes it
    // unconditionally.
    this.burst(9, 0, x, y, y, (q) => {
      const a = angle + (Math.random() - 0.5) * 0.7;
      const speed = 200 + Math.random() * 400;
      q.vx = Math.cos(a) * speed;
      q.vy = Math.sin(a) * speed;
      q.max = 0.2 + Math.random() * 0.2;
      q.life = q.max;
      q.size = 26 + Math.random() * 26;
      q.grow = 1.7;
    });
    this.burst(6, 1, x, y, y, (q) => {
      const a = angle + (Math.random() - 0.5) * 1.1;
      const speed = 90 + Math.random() * 160;
      q.vx = Math.cos(a) * speed;
      q.vy = Math.sin(a) * speed - 30;
      q.max = 0.9 + Math.random() * 0.8;
      q.life = q.max;
      q.size = 22 + Math.random() * 30;
      q.grow = 2.2;
    });
  }

  private burnAt(i: number) {
    const x = this.ships[i].x + (Math.random() - 0.5) * BALANCE.HULL_W * 0.7;
    const y = this.shipY(i) - 58;
    // Fire, kind 0 -- never drowns, so sinkY is unused here.
    this.burst(7, 0, x, y, y, (q) => {
      q.vx = (Math.random() - 0.5) * 60;
      q.vy = -70 - Math.random() * 120;
      q.max = 0.5 + Math.random() * 0.4;
      q.life = q.max;
      q.size = 22 + Math.random() * 22;
      q.grow = 1.4;
    });
  }

  private wreck(i: number) {
    const ship = this.ships[i];
    // Smoke, kind 1 -- never drowns, so sinkY is unused here.
    this.burst(20, 1, ship.x, this.shipY(i) - 70, this.shipY(i), (q) => {
      q.vx = (Math.random() - 0.5) * 180;
      q.vy = -40 - Math.random() * 150;
      q.max = 1.8 + Math.random() * 1.4;
      q.life = q.max;
      q.size = 50 + Math.random() * 70;
      q.grow = 2.6;
    });
    this.debris(ship.x, this.shipY(i) - 40, 1.6, '#6b4423', this.waterLevelFor(i));
  }

  /**
   * Everything the shot just did, said once.
   *
   * Called the instant the last ball stops moving, which is the only moment
   * the whole outcome is known and still before `resolve` hands the helm
   * over -- so the shout lands on the shot that earned it rather than a beat
   * into the next player's turn. Order here is loudest-first on purpose: a
   * grapeshot volley that sinks a ship is a sinking, not a five-hit.
   */
  private callShot() {
    const t = this.tally;
    this.tally = null;
    if (!t) return;

    const who = this.shipName(t.shooter);
    const landed = t.hulls + t.rigs;
    const dealt = Math.round(t.damage);

    // A shot only extends a streak by connecting. Rigging counts -- it is a
    // real hit for less damage, not a miss.
    if (landed > 0) this.streak[t.shooter] = (this.streak[t.shooter] ?? 0) + 1;
    else this.streak[t.shooter] = 0;

    if (t.sunk.length > 0) {
      const names = t.sunk.map((i) => this.shipName(i)).join(' and ');
      this.shout(t.sunk.length > 1 ? 'two under!' : 'sank her!', 'kill');
      this.logLine(`${who} sank ${names}`, 'kill');
      this.cfg.onSfx?.('sink');
      return;
    }

    if (landed === 0) {
      this.shout(t.grazed ? 'close!' : 'miss', t.grazed ? 'graze' : 'miss');
      this.logLine(t.grazed ? `${who} — near miss` : `${who} missed`, t.grazed ? 'graze' : 'miss');
      return;
    }

    // Multi-hit outranks the flourishes below it: landing four of five
    // pellets is the rarer and harder thing than the card having been a bore.
    if (landed >= 2) {
      this.shout(MULTI[Math.min(landed, MULTI.length - 1)], 'big');
    } else if (t.pierced) {
      this.shout('through the rock!', 'big');
    } else if (t.burned) {
      this.shout('she burns!', 'big');
    } else {
      this.shout(t.hulls > 0 ? 'direct hit!' : 'rigging hit', 'hit');
    }

    this.logLine(`${who} hit for ${dealt}`, landed >= 2 ? 'big' : 'hit');

    // Said after the hit, not instead of it, so the shout stays about the
    // shot and the streak is the footnote it should be.
    const run = this.streak[t.shooter] ?? 0;
    if (run >= 3) this.logLine(`${who} — ${run} in a row`, 'big');
  }

  private shout(text: string, tone: CallTone = 'hit') {
    this.call = text;
    this.callTone = tone;
    this.callLeft = 1.5;
  }

  /** Push a line onto the running log. Newest first, and the tail is dropped. */
  private logLine(text: string, tone: CallTone) {
    this.feed.unshift({ id: ++this.feedId, text, tone, life: FEED_LIFE, max: FEED_LIFE });
    // Five is what fits down the side of a phone without covering the water.
    if (this.feed.length > 5) this.feed.length = 5;
  }

  private shipName(i: number): string {
    return this.ships[i]?.name ?? 'A ship';
  }

  private stepParticles(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        this.pool.push(p);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;

      if (p.kind === 1) {
        // Smoke rises and slows.
        p.vy -= 26 * dt;
        p.vx *= 0.985;
        p.vy *= 0.985;
      } else if (p.kind === 0) {
        p.vy -= 90 * dt;
        p.vx *= 0.93;
        p.vy *= 0.93;
      } else {
        p.vy += 900 * dt;
        p.vx *= 0.995;
        // Sparks, spray and splinters all drown when they reach the water --
        // their own row's water, set once at the burst that spawned them
        // (see burst()'s sinkY), not the arena's single shallow line.
        if (p.y > p.sink + 6) {
          this.particles.splice(i, 1);
          this.pool.push(p);
        }
      }
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt * 2.1;
      r.r += (r.max - r.r) * Math.min(1, dt * 7);
      if (r.life <= 0) this.rings.splice(i, 1);
    }
  }

  private decay(dt: number) {
    this.shake = Math.max(0, this.shake - dt * 46);
    this.callLeft = Math.max(0, this.callLeft - dt);
    for (let i = this.feed.length - 1; i >= 0; i--) {
      this.feed[i].life -= dt;
      if (this.feed[i].life <= 0) this.feed.splice(i, 1);
    }
    for (const ship of this.ships) {
      ship.flash = Math.max(0, ship.flash - dt * 3.2);
      // A hull that is losing lists toward the sea; a healthy one rides level.
      const list = ship.hp <= 0 ? 0.55 : (1 - ship.hp / BALANCE.MAX_HP) * 0.09;
      const want = (ship.team === 0 ? 1 : -1) * list;
      ship.lean += (want - ship.lean) * Math.min(1, dt * 3.4);
    }
  }

  // -- aim guide -------------------------------------------------------------

  /**
   * The opening stretch of the arc, and no more.
   *
   * Long enough to read direction and strength at a glance, short enough that
   * it is not a solution. A full trajectory line would remove the only thing
   * this game asks of you.
   */
  previewArc(dots: number): { x: number; y: number }[] {
    const card = CARDS[this.selected] ?? CARDS.round;
    const power = clamp(this.aimPower, 0, 1);
    const speed = (BALANCE.MIN_SPEED + (this.arena.maxSpeed - BALANCE.MIN_SPEED) * power) * card.speed;
    const start = this.muzzle(this.turn, this.aimAngle);
    let vx = Math.cos(this.aimAngle) * speed;
    let vy = Math.sin(this.aimAngle) * speed;
    let x = start.x;
    let y = start.y;
    const out: { x: number; y: number }[] = [];
    const dt = 1 / 60;
    const perDot = 3;
    // The shooter's own row, not the shallow front-rank line -- a back-row
    // ship's muzzle already starts below that line, and cutting the preview
    // off at it would draw nothing at all.
    const localSeaY = this.waterLevelFor(this.turn);
    for (let i = 0; i < dots * perDot; i++) {
      vy += BALANCE.GRAVITY * card.gravity * dt;
      x += vx * dt;
      y += vy * dt;
      if (i % perDot === perDot - 1) out.push({ x, y });
      if (y > localSeaY) break;
    }
    return out;
  }

  // -- rendering --------------------------------------------------------------

  resize(canvas: HTMLCanvasElement, cssW: number, cssH: number, q: Quality) {
    // Backing-store pixels, not CSS pixels, are what a weak GPU actually has
    // to fill. Capping the total width is the single biggest thing keeping a
    // cheap phone at a steady rate.
    const maxWidth = q.tier === 0 ? 1280 : q.tier === 1 ? 1800 : 2600;
    let dpr = Math.min(window.devicePixelRatio || 1, q.maxDpr);
    dpr = Math.min(dpr, maxWidth / Math.max(1, cssW));
    this.dpr = Math.max(0.6, dpr);

    canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    // Letterbox. Both ships and the whole arc between them stay on screen at
    // every aspect ratio, because an artillery duel you have to scroll is a
    // guessing game.
    this.scale = Math.min(cssW / this.arena.w, cssH / this.arena.h) * this.dpr;
    this.offX = (canvas.width - this.arena.w * this.scale) / 2;
    this.offY = (canvas.height - this.arena.h * this.scale) / 2;

    if (!this.backdrop) this.backdrop = bakeSea(this.arena, q.fancy);
  }

  /** Screen point to world point, so a drag can be measured in world units. */
  toWorld(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number } {
    const px = (clientX - rect.left) * this.dpr;
    const py = (clientY - rect.top) * this.dpr;
    return { x: (px - this.offX) / this.scale, y: (py - this.offY) / this.scale };
  }

  render(ctx: CanvasRenderingContext2D, q: Quality) {
    const { canvas } = ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Letterbox bars, painted as sky above the horizon and sea below it
    // rather than a flat colour, so a wide desktop window reads as more sky
    // and more water instead of a stripe of a third colour top and bottom.
    const horizon = clamp((this.offY + this.arena.seaY * this.scale) / canvas.height, 0.04, 0.96);
    const bg = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bg.addColorStop(0, '#071b33');
    bg.addColorStop(Math.max(0, horizon - 0.08), '#14507f');
    bg.addColorStop(horizon, '#2f8fb8');
    bg.addColorStop(Math.min(1, horizon + 0.001), '#1a6a96');
    bg.addColorStop(1, '#062744');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const sx = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offX + sx * this.scale, this.offY + sy * this.scale);

    if (this.backdrop) ctx.drawImage(this.backdrop, 0, 0);
    else drawFallbackSea(ctx, this.arena);

    drawWaves(ctx, this.arena, this.clock, q.waves);

    for (const rock of this.rocks) if (rock.hp > 0) drawRock(ctx, rock);
    // Every hull, not a fixed pair -- `[0,1] as Team[]` only ever drew ships 0
    // and 1, which was invisible in a duel (there were only ever two) and
    // silently dropped every third-and-up hull once a side could have more.
    // Sorted by depth so a back-row ship, correctly, draws in front of
    // whatever's shallower where the two overlap on screen.
    const order = this.ships.map((_, i) => i).sort((a, b) => this.shipY(a) - this.shipY(b));
    for (const i of order) this.drawOneShip(ctx, i, q);

    this.drawProjectiles(ctx, q);
    this.drawParticles(ctx);
    this.drawRings(ctx);
    // The arc is a rule now, and off by default. `aiming` only says a drag is
    // live; whether that drag is allowed to show where the ball lands is the
    // host's call, and it applies to both fleets or neither.
    if (this.cfg.rules.aimArc && this.aiming && this.awaitingLocal) this.drawGuide(ctx, q);
    this.drawOffscreenMarkers(ctx);
    this.drawCall(ctx);
    this.drawFeed(ctx);
  }

  private drawOneShip(ctx: CanvasRenderingContext2D, i: number, q: Quality) {
    const ship = this.ships[i];
    const sunk = ship.hp <= 0;
    // A sunk hull slides under rather than blinking out, which is the part of
    // the ending anybody actually remembers.
    const settle = sunk ? easeIn(this.sinkT) * 150 : 0;

    // The barrel tracks whoever is shooting; an idle ship rests its gun at the
    // elevation it last used, so it never looks unmanned.
    const live = this.turn === i && (this.phase === 'aim' || this.phase === 'deal');

    drawShip(ctx, {
      skin: ship.skin,
      x: ship.x,
      y: this.shipY(i) + settle,
      facing: this.facing(i),
      accent: TEAM_COLORS[ship.team].main,
      aim: live ? this.aimAngle : ship.lastAim.angle,
      lean: ship.lean,
      flash: ship.flash,
      clock: this.clock,
    });

    if (ship.burn > 0 && q.fancy && Math.random() < 0.35) this.burnAt(i);
    if (!sunk) this.drawHealthBar(ctx, i);
  }

  /**
   * The bar over the hull.
   *
   * On the ship as well as in the HUD on purpose: during a shot your eyes are
   * on the water, not on a corner of the screen, and a number that changes
   * where you are not looking may as well not have changed.
   */
  private drawHealthBar(ctx: CanvasRenderingContext2D, i: number) {
    const ship = this.ships[i];
    const w = 190;
    const h = 17;
    const x = ship.x - w / 2;
    const y = this.shipY(i) - 300;
    const frac = clamp(ship.hp / BALANCE.MAX_HP, 0, 1);

    ctx.save();
    ctx.fillStyle = 'rgba(4, 16, 28, 0.66)';
    roundRect(ctx, x - 3, y - 3, w + 6, h + 6, 8);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(ctx, x, y, w, h, 6);
    ctx.fill();

    // Red under thirty per cent: the one moment the colour has to carry meaning.
    ctx.fillStyle = frac > 0.55 ? '#4ade80' : frac > 0.3 ? '#fbbf24' : '#f87171';
    roundRect(ctx, x, y, Math.max(4, w * frac), h, 6);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#08121c';
    ctx.font = '800 13px system-ui, sans-serif';
    ctx.fillText(`${Math.ceil(ship.hp)}`, ship.x, y + h / 2 + 1);

    ctx.font = '700 15px system-ui, sans-serif';
    ctx.fillStyle = TEAM_COLORS[ship.team].light;
    ctx.fillText(ship.name.length > 16 ? `${ship.name.slice(0, 15)}.` : ship.name, ship.x, y - 15);

    if (ship.burn > 0) {
      ctx.fillStyle = '#fb923c';
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.fillText(`on fire (${ship.burn})`, ship.x, y + h + 14);
    }
    ctx.restore();
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D, q: Quality) {
    const fx = fxSprites();
    for (const p of this.projectiles) {
      if (!p.alive) continue;

      if (q.trails && p.trail.length > 4) {
        ctx.save();
        ctx.lineCap = 'round';
        for (let i = 2; i < p.trail.length; i += 2) {
          const t = i / p.trail.length;
          ctx.strokeStyle = `rgba(226, 232, 240, ${t * 0.28})`;
          ctx.lineWidth = p.r * 1.5 * t;
          ctx.beginPath();
          ctx.moveTo(p.trail[i - 2], p.trail[i - 1]);
          ctx.lineTo(p.trail[i], p.trail[i + 1]);
          ctx.stroke();
        }
        ctx.restore();
      }

      if (fx.spark && q.fancy) {
        const glow = p.r * 4;
        ctx.globalAlpha = 0.45;
        ctx.drawImage(fx.spark, p.x - glow / 2, p.y - glow / 2, glow, glow);
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = '#12161d';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.beginPath();
      ctx.arc(p.x - p.r * 0.32, p.y - p.r * 0.36, p.r * 0.34, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D) {
    const fx = fxSprites();
    for (const p of this.particles) {
      const t = p.life / p.max;
      const size = p.size * (1 + (1 - t) * (p.grow - 1));

      if (p.kind === 4) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, t * 1.6);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-size / 2, -size / 5, size, size / 2.5);
        ctx.restore();
        continue;
      }

      const sprite = p.kind === 0 ? fx.fire : p.kind === 1 ? fx.smoke : p.kind === 2 ? fx.spark : fx.splash;
      if (!sprite) continue;
      ctx.globalAlpha = p.kind === 1 ? Math.min(0.5, t * 0.7) : Math.min(1, t * 1.5);
      ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  private drawRings(ctx: CanvasRenderingContext2D) {
    for (const r of this.rings) {
      ctx.strokeStyle = `rgba(255, 236, 190, ${Math.max(0, r.life) * 0.55})`;
      ctx.lineWidth = r.width * Math.max(0.2, r.life);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawGuide(ctx: CanvasRenderingContext2D, q: Quality) {
    const arc = this.previewArc(q.aimDots);
    const color = TEAM_COLORS[this.ships[this.turn].team].light;
    ctx.save();
    for (let i = 0; i < arc.length; i++) {
      ctx.globalAlpha = 0.85 - (i / arc.length) * 0.6;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(arc[i].x, arc[i].y, Math.max(2, 6 - i * 0.22), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** A shot that has climbed out of the frame still has to be findable. */
  private drawOffscreenMarkers(ctx: CanvasRenderingContext2D) {
    for (const p of this.projectiles) {
      if (!p.alive || p.y > 26) continue;
      const x = clamp(p.x, 30, this.arena.w - 30);
      ctx.fillStyle = 'rgba(255, 244, 214, 0.9)';
      ctx.beginPath();
      ctx.moveTo(x, 12);
      ctx.lineTo(x - 13, 34);
      ctx.lineTo(x + 13, 34);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawCall(ctx: CanvasRenderingContext2D) {
    if (this.callLeft <= 0 || !this.call) return;
    const t = Math.min(1, this.callLeft / 0.4);
    ctx.save();
    ctx.globalAlpha = t;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 62px system-ui, sans-serif';
    ctx.lineWidth = 10;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(4, 16, 28, 0.75)';
    ctx.fillStyle = TONE_COLOR[this.callTone];
    const y = 150 - (1 - t) * 26;
    ctx.strokeText(this.call.toUpperCase(), this.arena.w / 2, y);
    ctx.fillText(this.call.toUpperCase(), this.arena.w / 2, y);
    ctx.restore();
  }

  /**
   * The running log, down the top right.
   *
   * Drawn in world space like everything else on this canvas, so it scales
   * with the arena and needs no separate layout pass -- the trade is that a
   * six-hull arena is a wider frame, so the type is sized against the arena
   * width rather than fixed, and reads the same on a phone either way.
   */
  private drawFeed(ctx: CanvasRenderingContext2D) {
    if (this.feed.length === 0) return;
    const size = Math.round(this.arena.w * 0.0125);
    const pad = size * 0.7;
    const lineH = size * 2.05;
    const right = this.arena.w - size * 1.6;

    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${size}px system-ui, sans-serif`;

    for (let i = 0; i < this.feed.length; i++) {
      const entry = this.feed[i];
      // Full strength until the last second, then out. A line that starts
      // fading the moment it appears is unreadable exactly when it matters.
      const fade = Math.min(1, entry.life / 1);
      const y = size * 2.6 + i * lineH;
      const w = ctx.measureText(entry.text).width;

      ctx.globalAlpha = fade * 0.55;
      ctx.fillStyle = '#04101c';
      roundRect(ctx, right - w - pad * 1.4, y - lineH * 0.38, w + pad * 2, lineH * 0.76, size * 0.5);
      ctx.fill();

      ctx.globalAlpha = fade;
      ctx.fillStyle = TONE_COLOR[entry.tone];
      ctx.fillText(entry.text, right, y);
    }
    ctx.restore();
  }
}


// -- helpers -----------------------------------------------------------------

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function easeIn(t: number): number {
  return t * t;
}

/** Nothing may take more than one turn's worth of hull off in one write. */
function clampClaim(current: number, claimed: number): number {
  const floor = Math.max(0, current - BALANCE.MAX_TURN_DAMAGE);
  const ceiling = Math.min(BALANCE.MAX_HP, current + 20);
  return clamp(claimed, floor, ceiling);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Earliest intersection of a moving circle with an axis-aligned box, as a
 * fraction of the step, or null.
 *
 * The box is inflated by the radius, which turns the moving-circle test into a
 * segment-versus-box one. The corners come out square rather than round: a few
 * pixels of generosity at the very corner of a hull, in exchange for a test
 * that is four comparisons instead of four more quadratics.
 */
function segmentBox(x0: number, y0: number, x1: number, y1: number, box: Box, r: number): number | null {
  const minX = box.x0 - r;
  const maxX = box.x1 + r;
  const minY = box.y0 - r;
  const maxY = box.y1 + r;

  if (x0 >= minX && x0 <= maxX && y0 >= minY && y0 <= maxY) return 0;

  const dx = x1 - x0;
  const dy = y1 - y0;
  let tMin = 0;
  let tMax = 1;

  for (let axis = 0; axis < 2; axis++) {
    const p = axis === 0 ? x0 : y0;
    const d = axis === 0 ? dx : dy;
    const lo = axis === 0 ? minX : minY;
    const hi = axis === 0 ? maxX : maxY;

    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return null;
      continue;
    }
    let t1 = (lo - p) / d;
    let t2 = (hi - p) / d;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin <= 1 ? tMin : null;
}

/** The same idea against a circle, for the rocks. */
function segmentCircle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  r: number,
): number | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const fx = x0 - cx;
  const fy = y0 - cy;

  const a = dx * dx + dy * dy;
  if (a < 1e-9) return fx * fx + fy * fy <= r * r ? 0 : null;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const root = Math.sqrt(disc);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}
