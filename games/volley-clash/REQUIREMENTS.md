# Volley Clash — Requirements

A two-touch arcade volleyball game for PlayBuddies. One to four players, on a
keyboard, on a phone, or across the internet.

This document is the contract the implementation is written against. Where a
number appears here it is the number in `src/game/rules.ts`, and the two are
meant to stay in step.

---

## 1. Why this game

The platform has a co-op puzzler (Neon Elements) and a free-for-all arcade game
(Fish Eat Fish). It has nothing **competitive and symmetrical** — no game where
two people are trying to beat each other at the same task, and no game that
supports teams. Volleyball is the smallest possible sport that does both: one
ball, one rule ("don't let it land on your side"), and a skill ceiling that
comes entirely from the physics rather than from content.

It also has to survive the platform's hard constraint: **there is no game
server.** PlayBuddies is a static site. Every design decision below that looks
unusual is downstream of that.

---

## 2. Modes

| Mode | Players | Arena | How it starts |
|---|---|---|---|
| **Solo** | 1 human vs 1 AI | Standard | Menu → Solo |
| **Couch** | 2 humans, one keyboard | Standard | Menu → Couch |
| **Online 1v1** | 2 humans | Standard | PlayBuddies lobby, 2 players |
| **Online 2v2** | 4 humans, two teams | **Wide** | PlayBuddies lobby, 3–4 players |

Rules that follow from the table:

- **R2.1** The mode is never chosen twice. If the game is launched with a `room`
  query parameter it is online, and the number of people in the lobby decides
  1v1 or 2v2. If it is launched without one, the player picks Solo or Couch.
- **R2.2** A 3-player lobby plays 2v2 with an AI filling the fourth slot. Being
  a person short must not block a match.
- **R2.3** If a player disconnects mid-match, an AI takes their character over
  within one second. The match never stops for a dropout.
- **R2.4** Couch mode is not a stand-in for online play — it is the mode that
  works on a laptop with no internet, and it must be reachable in two clicks
  from the menu.

### Arena sizes

| | Width | Height | Net height | Reason |
|---|---|---|---|---|
| Standard (2P) | 1280 | 720 | 210 | Two players; the court should feel tight enough that positioning matters. |
| Wide (4P) | 1760 | 780 | 230 | Four bodies need lateral room or 2v2 collapses into a scrum at the net. The taller net keeps rallies alive now that two people can block. |

- **R2.5** The arena is chosen once at match start from the player count and
  never changes mid-match.
- **R2.6** The canvas letterboxes the arena — the whole court is always visible.
  There is no camera to follow, because a volleyball court that scrolls is
  unplayable.

---

## 3. The ball

- **R3.1** Gravity is constant. The ball has a radius, a velocity, and a spin.
- **R3.2** Spin curves the flight (a Magnus term proportional to spin × speed).
  Spin is imparted by hitting the ball with a moving player: the player's
  horizontal velocity at contact is what puts spin on it.
- **R3.3** The ball bounces off the side walls and the ceiling with restitution
  slightly below 1, so a rally that gets stuck in the roof still decays.
- **R3.4** The ball bounces off the **net post** — the net is a solid vertical
  bar, not a plane the ball passes through. Clipping the tape and dribbling over
  is a legitimate and delightful outcome, so the collision must be a real
  circle-vs-rounded-rectangle test, not an axis test.
- **R3.5** The ball's speed is capped. Uncapped, a charged spike off a dashing
  player tunnels through the floor.
- **R3.6** Continuous collision against the floor: at spike speeds the ball
  moves further per frame than its own diameter, and a naive `y > floor` test
  misses it. Point detection must never depend on frame rate.

## 4. The players

Each character is a rounded capsule with a head. Physics is deliberately
simple — the depth comes from timing, not from a complex character controller.

- **R4.1** **Run.** Ground acceleration toward the input direction, with a
  friction term. Air control is weaker than ground control.
- **R4.2** **Jump.** One jump from the ground. Holding the jump key longer gives
  a higher jump (variable-height jump), because a fixed jump makes every set
  identical.
- **R4.3** **Dash.** A short horizontal burst on a cooldown, usable in the air
  exactly once per airtime. This is the whole movement skill ceiling: a dash
  used to reach a ball is a save, a dash used into the ball is a spike.
- **R4.4** **Charge.** Holding the action key builds charge up to a maximum.
  Contact with the ball while charged multiplies the hit power and adds a
  screen shake and a trail. Charging slows the player, so it is a real choice.
- **R4.5** Players collide with each other (soft push-apart) but cannot pass
  through the net or the walls, and cannot cross into the opponent's half.
- **R4.6** Hitting the ball is not a button press — it is **contact**. Where the
  ball hits the player relative to their centre determines the outgoing angle.
  Hitting it off the top of your head sends it straight up (a set); hitting it
  off the side sends it sideways (a pass); hitting it while descending onto it
  from above sends it down (a spike).
- **R4.7** On the ground the outgoing angle is clamped upward, hard. A grazing
  contact would otherwise leave almost horizontally, and a horizontal ball at
  hit speed is unreturnable — rallies died after 1.4 touches. The clamp is what
  teaches the one rule the game rests on: **you can only spike in the air.**
- **R4.8** A hit returns only a tenth of the incoming speed. Any more and a
  rally escalates — each swing adds to an already-fast ball until it crosses
  the whole court every touch and both players are pinned to opposite walls.
  Energy must leave a rally faster than the swings put it in.

### Characters

Eight characters, three free, the rest bought with the platform's coin balance
(the same `localStorage` economy Fish Eat Fish uses, so a player's coins mean
something across the site).

Each has three stats in the 0.80–1.20 range: **speed**, **jump**, **power**.
No character is strictly better than another — every stat total is equal.
The roster exists so 2v2 teams can be built out of complementary bodies, not so
that a paying player wins.

- **R4.9** Two players in the same match cannot pick the same character.
- **R4.10** Every character's three stats sum to exactly 3.00 and none sits
  outside 0.80–1.20. A character that clearly wins is a bug, and a shop that
  sells one is worse than no shop.

## 5. Scoring

- **R5.1** Rally scoring: every rally ends in a point for someone.
- **R5.2** First to 7, win by 2, hard cap at 11. (Configurable to 5 or 11 in
  the settings; the host's choice is the one that counts online.)
- **R5.3** The ball touching the floor scores for the **other** side.
- **R5.4** After a point, the side that conceded serves. The ball hangs above
  the server's own head and drops after a short countdown, and **the first
  contact after a serve is multiplied by 1.45**.

  All three parts of that are load-bearing, and two of them were added after
  AI-vs-AI testing produced 7–0 sweeps four times out of four. A serve is the
  only shot in the game with no incoming speed to borrow, so it is the weakest
  one; combined with "the loser serves", that meant conceding a single point
  put a team into a spiral it could not escape. Dropping the ball on the
  server rather than at a fixed spot removed the scramble, and the bonus turned
  serving from a penalty into a small advantage — which makes the format
  self-correcting: lose a point, get the advantage back. Scores after the fix
  are 7–4, 3–7, 6–8, 7–4, including deuce games.
- **R5.5** At match point the game enters a brief slow-motion. It is pure
  drama and it costs nothing.
- **R5.6** Consecutive touches by the same player are allowed. This is not real
  volleyball; the three-touch rule makes a 1v1 game unplayable.

## 6. Power-ups

A power-up spawns near the top of the court every 12–20 seconds during a rally
and drifts down. **The ball collects it, not the player** — so the team that
last touched the ball earns it, which rewards keeping the ball alive rather
than camping under a spawn point.

| Power-up | Effect | Duration |
|---|---|---|
| **Rocket** | The next hit by the earning team is a guaranteed max-power spike. | Until used |
| **Feather** | Gravity on the ball is halved. Long floaty rallies. | 8 s |
| **Giant** | The earning team's players grow 40%. | 7 s |
| **Freeze** | The *opposing* team's movement is halved. | 4 s |

- **R6.1** Power-ups are off in the first rally of a match, so the opening point
  is always a clean test of skill.
- **R6.2** Every power-up is visible on the HUD with a countdown. A player must
  never be surprised by their own controls.
- **R6.3** Power-ups can be disabled entirely in the settings — some people just
  want volleyball.

## 7. Feel

None of this changes the outcome of a rally, and all of it is why the game is
worth playing.

- **R7.1** Ball trail, thickening with speed.
- **R7.2** Impact particles at every contact, coloured by the hitter's team.
- **R7.3** Screen shake on spikes, scaled by impact power.
- **R7.4** A rally counter that appears after 6 touches, and a shout
  ("NICE!", "SPIKE!", "ACE!") on notable events.
- **R7.5** The court is drawn **once into an offscreen canvas and blitted** —
  crowd, banners, sky gradient, net posts. The lesson from Fish Eat Fish is
  that a per-frame vector background is where the frame budget goes. Only the
  ball, players, particles and HUD are drawn live.
- **R7.6** Locked 60 Hz feel via a fixed-timestep accumulator, so physics is
  identical on a 60 Hz laptop and a 144 Hz monitor.

## 8. Controls

| | Move | Jump | Dash | Charge |
|---|---|---|---|---|
| P1 keyboard | A / D | W | Shift | Space |
| P2 keyboard | ← / → | ↑ | / | Enter |
| Touch | Drag anywhere left half | Tap right | — | Hold right |

- **R8.1** On a touchscreen the joystick appears under the thumb (the same
  dynamic-origin stick Fish Eat Fish uses) and the action buttons sit on the
  right. Jump is a tap, charge is a hold — the same button.
- **R8.2** Keyboard layout is remappable between the two sets in settings, for
  couch play where one person prefers arrows.
- **R8.3** Full-screen works on iOS Safari, which has no Fullscreen API on
  iPhone — the same pseudo-fullscreen fallback the other games use.

## 9. Netcode

The platform is a static site. There is no authority to run the ball on, and a
peer-to-peer game where both sides simulate the ball desynchronises within
about four seconds.

**The host simulates. Everyone else sends inputs and renders.**

- **R9.1** Transport is the existing `Mesh` — a WebRTC full mesh signalled
  through Realtime Database. It is copied, not shared, because each game is an
  independent Vite app; the copy is small and the alternative is a workspace
  package the build script would have to understand.
- **R9.2** Clients send a 1-byte input bitmask at 30 Hz. Nothing else.
- **R9.3** The host broadcasts a snapshot at 20 Hz: ball, every player, score,
  phase, active power-ups.
- **R9.4** Clients **predict their own character** from their own input
  immediately, then ease toward the host's position for that character. A
  player must never feel their own input lag.
- **R9.5** Remote characters and the ball are interpolated toward the last
  snapshot. No extrapolation — a mispredicted ball that snaps back is worse
  than a ball 50 ms behind.
- **R9.6** The host is the lobby host, read from the lobby document, never from
  a query parameter.
- **R9.7** If the host leaves, the match ends cleanly with a message. Host
  migration mid-rally is not worth the complexity for a 7-point match.

## 10. Platform contract

- **R10.1** The game lives entirely in `games/volley-clash/`. Adding it must
  require **zero** edits elsewhere: `scripts/build-games.mjs` discovers it from
  `game.json` and the catalog picks it up.
- **R10.2** It reads its session from the query string: `room`, `displayName`,
  `mode=single`. It writes only its own slot in the lobby document.
- **R10.3** It uses the platform's Firebase project and the player's existing
  sign-in. It never shows a login screen.
- **R10.4** `base: './'` in the Vite config, so the bundle works under the
  `/PlayBuddies/` prefix GitHub Pages serves from.
- **R10.5** The address bar is cleaned after the handoff is read, so a copied
  link is not a stale room join.

## 11. Out of scope

Stated so it is a decision and not an oversight:

- Three-touch volleyball rules, rotations, positions.
- Ranked play, matchmaking, persistent stats. The platform has no backend for
  it and the lobby is the matchmaking.
- Host migration.
- Spectators.
- More than four players. Beyond 2v2 the court would have to grow past the
  point where a single non-scrolling view works.
