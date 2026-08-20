# Battle of Pirates — Requirements

A turn-based artillery duel for PlayBuddies. One or two players, against a bot,
across a room, or across the internet.

This document is the contract the implementation is written against. Where a
number appears here it is the number in `src/game/rules.ts`, and the two are
meant to stay in step.

---

## 1. Why this game

The platform has a co-op puzzler (Neon Elements), a free-for-all arcade game
(Go Eat Fish) and a real-time sport (Volley Clash). All three are games of
reflex: the person with the faster hands wins. There is nothing on the platform
you can play **slowly** — nothing you can play while talking to the person you
are playing against, nothing where the interesting part is the decision rather
than the execution, and nothing playable one-handed on a phone on a bus.

Turn-based artillery is the smallest game that fixes all of that. It is also the
one genre where the platform's hard constraint stops being a constraint: with
one shot per turn there is nothing to synchronise in real time, so **there is no
netcode problem to solve**.

---

## 2. Modes

| Mode | Players | How it starts |
|---|---|---|
| **Solo** | 1 human vs 1 bot | Menu → Solo |
| **Couch** | 2 humans, one device | Menu → Two captains, one device |
| **Online 1v1** | 2 humans | PlayBuddies lobby, 2 players |

- **R2.1** The mode is never chosen twice. Launched with a `room` query
  parameter it is online; without one the player picks Solo or Couch.
- **R2.2** A lobby with one person in it still plays a battle, against a bot.
  Being first into the room must never mean firing at an empty sea. Volley
  Clash and Go Eat Fish both shipped a version of this that only filled a
  *partly* full match, and a room of one started with no opponent at all.
- **R2.3** If a player disconnects mid-battle, a bot takes their wheel. The
  battle never stops for a dropout.
- **R2.4** Couch play is the mode that works on a laptop with no internet, and
  it must be reachable in two taps from the menu. Because turns alternate, one
  device genuinely supports two people — no shared keyboard, no split screen.

### The arena

| | Width | Height | Waterline | Hull anchors |
|---|---|---|---|---|
| The only one | 1600 | 900 | 690 | 300 and 1300 |

- **R2.5** The canvas letterboxes the arena: both ships and the whole arc
  between them are visible at all times. There is no camera, because an
  artillery duel you have to scroll is a guessing game.
- **R2.6** A shot may leave the top of the frame. It must not be deleted for
  doing so — gravity brings a lofted mortar back — and while it is up there an
  arrow at the top edge marks where it is.

---

## 3. The shot

- **R3.1** Constant gravity, plus a constant sideways acceleration from the
  wind. That is the whole flight model.
- **R3.2** Muzzle speed runs from `MIN_SPEED` to `MAX_SPEED` across the power
  range. The numbers are chosen against the distance between the hulls so that
  the *useful* band is roughly 45% to 100% power, not 80% to 100%: a control
  with three quarters of its travel doing nothing is a broken control.
- **R3.3** Wind is shown as an arrow with a direction and a length, and never
  as a number. It has to be readable in the half second between looking up and
  pulling back.
- **R3.4** Physics runs at a fixed 120 Hz through an accumulator, so a 144 Hz
  desktop and a 60 Hz phone simulate the identical flight. This is not only
  about feel — see §7.
- **R3.5** Every collision is a **swept** test against the shape: segment
  against inflated box for hulls and rigging, segment against circle for rocks,
  segment against the plane for the water. A ball at full power crosses many
  times its own diameter in a step, and a point-inside test would miss a hull
  exactly where a hit matters most.
- **R3.6** A projectile is **unarmed against its own ship** until it is clear of
  that ship's hull and rigging. The muzzle sits inside the hull's own hitbox, so
  without this every shot detonated on the deck it was fired from.
- **R3.7** Hitting your own hull on the way down is a real outcome and deals
  half damage. It is not a bug, it is what makes a near-vertical mortar a
  decision.

## 4. The ships

- **R4.1** 100 hull each. A clean strike with a plain round takes 22, so about
  five hits sink a ship and a battle runs six to ten shots a side.
- **R4.2** The hull is worth full damage; the **rigging** is a second, taller
  box worth 55%. A mast hit should be worth something and should not be worth
  as much as a hole below the gunwale.
- **R4.3** Splash falls off with the square of the distance to nothing at the
  blast radius, so a near miss in the water still rattles the hull. This is what
  keeps a bad shot from being a wasted turn.
- **R4.4** **Ships bob and drift.** The bob is vertical and continuous and it
  is on the hitbox, not just on the paint. The drift is horizontal and happens
  once per turn: the target has moved by the time you shoot again, so a perfect
  repeat of a shot that landed will not land twice.
- **R4.5** Both are deterministic. The bob is a function of the simulation
  clock, which advances in fixed steps; the drift is a function of the seed and
  the turn number. Neither can differ between two clients.
- **R4.6** Health is drawn **on the ship** as well as in the HUD. During a shot
  your eyes are on the water, and a number that changes where you are not
  looking may as well not have changed.
- **R4.7** A hull that is losing lists toward the sea, and a sunk one slides
  under rather than blinking out.

### Ships as a shop

Eight hulls, three free, the rest bought with the platform's shared coin
balance — the same `localStorage` economy the other two games use, so a
player's coins mean something across the site.

- **R4.8** **They are paint. There are no stats.** No hull fires further, turns
  faster or takes less damage, and none ever will. A shop that sells an
  advantage in a head-to-head game is worse than no shop, and Volley Clash
  removed exactly such a system after finding that every loss had an excuse
  attached to it.
- **R4.9** Two players in the same battle cannot pick the same hull.
- **R4.10** The card says "paint only" in as many words. Showing three identical
  full stat bars would imply a choice that does not exist, and hinting at one is
  worse than saying plainly what these are.

## 5. Ammunition, as a hand of cards

At the start of every turn the player is dealt **three cards from a deck of
seven** and plays exactly one. It loads for that shot and the hand is discarded.

| Card | What it does |
|---|---|
| **Round Shot** | The plain one, slightly heavier powder. |
| **Chain Shot** | Two balls in a tight pair. Both can bite. |
| **Grapeshot** | Five pellets in a wide fan. Forgiving aim, small teeth. |
| **Mortar** | Much heavier gravity. Huge blast, and it lobs over rocks. |
| **Firebomb** | Sets the deck alight for two of the target's turns. |
| **Bore Shot** | Passes straight through rock and ignores the wind. |
| **Patch Kit** | Repairs 14 hull, then fires a slightly weaker round anyway. |

- **R5.1** Three is the smallest hand that is still a decision and the largest
  that fits across a phone at a size a thumb can hit without aiming.
- **R5.2** A fresh hand every turn, rather than a persistent inventory. Nothing
  can be hoarded, so the interesting shots turn up on their own and a player
  who is losing is never also out of options.
- **R5.3** Round Shot is weighted highest in the deck. The unusual cards are
  interesting *because* they are not the default.
- **R5.4** The hand is dealt from the seeded generator, so both clients see the
  same three cards without exchanging a word about it.
- **R5.5** Patch Kit still fires. A card that costs you your turn is a card
  nobody plays.
- **R5.6** The card strip sits below the aim pad's bottom edge, so choosing a
  card can never be mistaken for pulling one back.

## 6. Rocks

One to three rocks stand in the water between the ships.

- **R6.1** They block a flat shot and are chipped away by hits; enough hits and
  one crumbles.
- **R6.2** They are what makes Mortar and Bore Shot worth their place in the
  deck, and what stops one good elevation being the answer for a whole match.
- **R6.3** They can be turned off in settings, and the change applies to the
  next battle rather than the one in progress.

## 7. Controls

**Pull back and let go.** The vector from where the finger went down to where
it is now, reversed, is the shot: its direction is the elevation and its length
is the powder.

- **R7.1** The drag starts wherever the finger lands, not on the ship.
  Anchoring it to the hull means aiming with your thumb on top of the thing you
  are trying to see, on the screens where that matters most.
- **R7.2** Identical with a mouse and with a thumb. There is one gesture and no
  buttons.
- **R7.3** Elevation is measured in the ship's own frame, so the same gesture
  means the same shot on both sides of the water.
- **R7.4** Keyboard alternative: up and down for elevation, left and right for
  power, shift for the fine adjustment, space to fire, 1–3 to pick a card. The
  fine adjustment is the difference between landing a shot and walking past it
  in one press.
- **R7.5** A tap is not a shot. Under a tenth of full pull, nothing fires.
- **R7.6** The aim guide shows the opening stretch of the arc and no more. Long
  enough to read direction and strength, short enough not to be a solution, and
  it can be switched off entirely for the harder game.
- **R7.7** The first touch of a battle requests fullscreen, because the
  Fullscreen API only grants a request that is handling a real user gesture.
  Skipped while embedded: PlayBuddies drives fullscreen for the whole frame.
- **R7.8** A turn clock fires the shot on its own after 30 seconds, so an
  online battle cannot be held hostage by someone who has walked away. It can
  be turned off.

## 8. The bot

- **R8.1** It does not cheat and it does not read your aim. It solves the same
  ballistics problem you are eyeballing, wind included — it can see the same
  gauge you can — closed form, then three passes to settle the wind against the
  flight time.
- **R8.2** It then misses on purpose, by an amount set by its rank.
- **R8.3** **A miss narrows its spread; a hit resets it.** It ranges in like
  anyone firing artillery, and because a hit puts it back to its rank's honest
  accuracy it oscillates around its rank rather than converging on perfect.
- **R8.4** It must never feed the last miss back in as a *correction* to the
  point of aim. The solver has no systematic error to correct, so every miss is
  either the deliberate spread or a wind that has since changed; aiming off by
  yesterday's noise roughly doubled the average miss. This was measured, and it
  is why R8.3 is worded the way it is.
- **R8.5** Above the bottom rank it reads the board before choosing a card:
  patch a hull that is about to go under, and reach for the lobbing or
  rock-piercing shot when there is a rock in the line.
- **R8.6** It pauses before firing. A shot that appears from nowhere reads as a
  glitch rather than as an opponent.
- **R8.7** The ranks are verified by measurement, not by feel. Bot against bot:
  a Captain beats a Swab essentially every time, and the mirror matchups are
  even from both sides of the water.

## 9. Netcode

The platform is a static site with no game server. This game does not need one.

**One turn is one document write.**

- **R9.1** No WebRTC. The other three games open a mesh because they need
  twenty updates a second; a turn-based duel needs a dozen writes for a whole
  battle. Not opening a peer connection also means no STUN, no NAT traversal,
  and nothing to fail silently on a network that blocks it.
- **R9.2** Each side writes only `lobbies/{room}/updates/{ownUid}`, which is
  exactly what the security rules allow and nothing more.
- **R9.3** The host draws a seed and a coin toss and sends those two numbers,
  once. That is the entire handshake: the wind, the drift, the rocks and every
  hand for the rest of the battle all fall out of the seed.
- **R9.4** **Who fires first is drawn at random** at the start of every battle,
  and online the host's draw is the one that counts.
- **R9.5** A shot on the wire carries the angle, the power, the card, and the
  state the turn left behind. The receiver replays the identical shot for the
  animation and takes the shooter's numbers as the truth when the dust settles,
  so the two clients only ever have to agree on the *picture*, never on the last
  bit of a float.
- **R9.6** Every shot is stamped with the match seed. A player's update document
  outlives the match that wrote it, so the first snapshot after subscribing can
  be last night's final shot; the stamp makes a stale turn obvious instead of
  replayable.
- **R9.7** A peer's claim is clamped: no single turn may take more than one
  turn's worth of hull off. Trust here is social, not cryptographic — these are
  friends in a room — but a tampered client should not be able to end a battle
  in one write.
- **R9.8** A shot that arrives while the previous explosion is still settling is
  held, not dropped, and played when its turn comes round.
- **R9.9** A shot fired in the second before the document handle resolved is
  queued rather than lost. Losing the opening shot of a battle to an import that
  had not finished reads as "multiplayer is broken".

## 10. Performance

The target is a cheap Android phone, not a desktop.

- **R10.1** The sky, the sun, the clouds, the far headlands and the body of the
  water are painted **once** into an offscreen canvas and blitted with a single
  `drawImage`. Go Eat Fish paid for this lesson: a per-frame vector background
  is where the frame budget goes, and none of it is animation anybody watches.
- **R10.2** Each hull is baked to a sprite on first use. Only the cannon barrel
  and the flag are drawn live, because only they move.
- **R10.3** Explosions are **baked sprites**, drawn with an alpha and a scale.
  Building a radial gradient per particle per frame is the single most
  expensive thing a canvas game can do.
- **R10.4** Particles come from a pool. A hundred short-lived objects per
  explosion is a hundred objects for the collector to find later, and it finds
  them mid-battle.
- **R10.5** The quality tier is guessed once from `deviceMemory` and
  `hardwareConcurrency` and then **corrected from real frame times**. Neither
  hint is trustworthy alone; the frame clock is. Downgrades are quick, upgrades
  are slow and capped, and the ceiling never rises above where it started.
- **R10.6** One tier drop thins every burst, drops the trails, shrinks the
  backing store and halves the aim-guide dots together. The game degrades in
  one step rather than getting gradually stranger.
- **R10.7** Backing-store pixels, not CSS pixels, are the budget. Device pixel
  ratio is capped by tier *and* the total width is capped outright.
- **R10.8** While nothing is moving — a quiet aim phase, no drag in progress —
  the cheap tiers paint at half rate. The simulation still runs every frame;
  only the paint is skipped.
- **R10.9** Nothing in the render loop causes a React render. The HUD is updated
  only when a value a human can read has actually changed.
- **R10.10** Firebase is behind a dynamic import and is reached only on the
  online path. It is several times the weight of the entire rest of the game,
  and a solo or couch battle never calls into it once.

## 11. Platform contract

- **R11.1** The game lives entirely in `games/battle-of-pirates/`. Adding it
  required **zero** edits elsewhere: `scripts/build-games.mjs` discovers it from
  `game.json` and the catalog picks it up.
- **R11.2** It reads its session from the query string: `room`, `displayName`,
  `mode=single`. It writes only its own slot in the lobby document, and it
  reuses the `fishIndex` field for the chosen hull — the security rules name the
  writable fields one by one, so a new game inventing its own key would simply
  be refused.
- **R11.3** Host status is read from `hostId` on the lobby document, never from
  a query parameter.
- **R11.4** `matchStarted` is **reset when the battle is left**. Left set, a
  rematch breaks two ways: pressing Start again does nothing, because true to
  true is not a change; and picking a different ship *is* a change, so it
  launches a battle nobody started. Both of the other two games shipped with
  this bug.
- **R11.5** `base: './'` in the Vite config, so the bundle works under the
  `/PlayBuddies/` prefix GitHub Pages serves from.
- **R11.6** The address bar is cleaned after the handoff is read, so a copied
  link is not a stale room join.
- **R11.7** The in-game controls sit below the platform's own floating bar while
  embedded. It paints over the top-right corner at a z-index the iframe cannot
  reach, and full screen is deliberately not repeated inside the game.

## 12. Out of scope

Stated so it is a decision and not an oversight:

- More than two ships. Three hulls in a row on a phone is a row of dots.
- Destructible terrain. Rocks chip away; the sea does not deform.
- Multiple gunners per ship. It doubles the UI to add one more decision.
- Host migration, spectators, ranked play, persistent stats. The platform has
  no backend for it and the lobby is the matchmaking.
