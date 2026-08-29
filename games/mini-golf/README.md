# Mini Golf

Top-down golf for PlayBuddies. A small green seen from directly above, a flag
somewhere across it, one ball each. Drag back and let go.

## Running it

```bash
npm install
npm run dev
```

Or from the repo root, which is what the platform does:

```bash
npm run build:games mini-golf
```

The build script discovers this directory from `game.json` and publishes the
bundle to `public/g/mini-golf/`. Nothing outside `games/mini-golf/` needed
editing to add it.

## Layout

| Path | What it is |
|---|---|
| `src/game/rules.ts` | Every tunable number, plus the words for a finished hole. |
| `src/game/course.ts` | Builds a hole from one integer — and proves the cup can be reached before handing it back. |
| `src/game/physics.ts` | A rolling ball and everything that can happen to it. The engine and the bot share it. |
| `src/game/balls.ts` | The eight balls, drawn in code. Pattern only; the ring is always the seat's colour. |
| `src/engine/GolfEngine.ts` | Turn order, scoring, the live roll, and the drawing of the green. |
| `src/engine/ai.ts` | The bot. Tries a couple of hundred putts with the real physics and the real route, and keeps the best. |
| `src/screens/MatchView.tsx` | Render loop, HUD, scorecard and the wire. |
| `src/components/AimPad.tsx` | The drag gesture, and only that. |
| `src/net/turnLink.ts` | Online play: one Firestore document each. |
| `src/App.tsx` | Menus, the shop, and the lobby handshake. |

## Courses that can actually be finished

Every green is a rectangle or a half-round, built from the round's seed, so
four clients lay out the identical hole without a byte of it crossing the
network. A half-round can face any of the four walls at their tight, minimal
box, or open at any other angle at all against the full circle's — so the flag
is never sitting behind the same-shaped cut twice in a row.

Scattering ponds and blocks over a green will eventually ring the flag in water
or wall it off, and a hole nobody can finish is not a hard hole — it is a
broken build. So `buildCourse` does not trust itself. It flood-fills a grid
from the tee, with water counted as solid (a rolling ball cannot cross a pond)
and blocks grown by a ball's radius (so a gap too tight to fit through is not
mistaken for a route), and refuses any layout whose cup it cannot reach. It
retries with progressively less scenery, and in the last resort clears the
green entirely — which is convex, so it always passes.

Verified rather than assumed: 1500 generated holes were re-checked by an
independent flood-fill at a finer grid — 0 unreachable, 0 obstacles overlapping
— and every bot rank holed out on 99%+ of them.

Tee and cup placement measures what the shape can actually do rather than
guessing from the bounding box. A half-round's box is `r × 2r` but the longest
line inside it is only about `2r`, so a rule written against the diagonal was
unsatisfiable on those greens — every retry failed and the leftover candidate,
often a couple of units from the tee, got used. Instead: draw a pool of legal
spots, measure the widest separation any pair achieves, and take a random pair
within reach of it.

## Getting there is the hard part

Scenery is laid out with respect to the line from the tee to the cup, not
scattered at random. Scattered, that line stayed open on a third of greens and
every hole was "point at the flag and judge the weight" — the shape of the
course never mattered.

Each barrier is sized from the room that actually exists where it stands: it
reaches the wall on one side, crosses the line, and stops short of the far
wall, so the straight shot is dead and a gap is left **by construction rather
than by luck**. Consecutive barriers take alternate sides, which turns a
corridor into an S-bend. The direct line is now clear on under 2% of holes.

Nothing overlaps. Obstacles are tested by sampling along their own surface
rather than as bounding circles — a barrier sixty units long has a bounding
radius of thirty, and testing it as a disc demanded it stay thirty units clear
of everything, which rejected almost every one of them.

Par comes from the length of the real path *round* the scenery, measured by the
same eight-connected search that proves the hole is finishable at all. Judging
it on the straight line stopped meaning anything once barriers were
deliberately laid across that line: every hole came back "blocked, add a
stroke" and nine in ten were par 4.

Water is stroke and distance — a penalty shot, and the ball is played again
from where it was struck. Dropping it on the near bank quietly rewarded going
in, because the far bank of a pond between you and the flag is *progress*, so
the safe way round was the slow way round and nobody ever took it.

A screamer can still ride straight over the cup rather than drop — that is the
whole point of `CAPTURE_SPEED`, and the shot everyone remembers. It has to
actually happen, though: the ball crosses the cup's ring over several physics
steps, not one, so judging the lip-out fresh on every one of those steps
re-damped the same ball again and again as it crossed — which bled off enough
speed that a putt hit well past the threshold still ended up captured a few
steps later anyway. The rim now gets one judgement, made once on the way in,
and the ball actually carries through for the rest of the crossing.

## Playing round the scenery, not into it

The bot's search used to score a landing spot on the ruler distance to the
flag, and a ruler does not know a barrier is in the way. A putt that rammed the
near face of one and stopped a few units from the cup, as the crow flies, out
scored a putt that had actually worked most of the way round it — so the
search kept picking the wall, every rank hit it again next turn for the same
reason, and a bot that cannot see a gap it is staring at reads as broken, not
as an easy difficulty.

`chooseShot` now floods a route field out from the cup once per putt — the
same eight-connected walk that already proves a hole is finishable and prices
its par — and scores every candidate against *that* instead. Distance round
the scenery, not distance through it. The wall stops looking like progress the
moment the field can see there is still a whole barrier between that spot and
the flag, and the search moves on to the shot that is actually shorter.

What still separates the ranks is the aim, not whether the bot can find the
gap — every rank sees it now. Checked across 1500 bot-played holes, 500 at
each rank: not one hole anywhere had the bot fire the same shot three turns
running, the signature of a putt stuck repeating a bad idea against a wall.
Finish rate is 99%+ at every rank, and strokes over par still climb
Rookie → Club → Pro exactly as they did before — Rookie just finds the gap
later and misses it by more, which is a difficulty setting rather than a wall.

## Controls

The AimPad is Battle of Pirates' pad with the artillery removed. There is no
elevation to clamp and no barrel to point — from directly above a heading is
just a heading, and since the camera only pans and scales, a direction on the
glass is the same direction on the green.

What it gained is dots. A power arc of 16 of them fills clockwise around the
guide ring, because the pull line says "this far back" without ever saying how
far back *full* is — and the number beneath the ring says it outright, as a
plain percentage of full pull.

There used to be a second set of dots out on the green itself, marching from
the ball toward wherever the pull was pointed and stopping at the first thing
in the way. It read too much like a route finder — it told you the shot was
clear (or wasn't) before you had committed to it — so the putt is aimed on the
pull alone now. Where the ball goes is the part worth being good at.

How it works is pinned to the green itself now, not just the lobby you left to
get there. It used to be one screen you read once before the first tee and
never again — which meant "bank off the blocks, stay out of the ponds" is
sitting in a menu nobody reopens the moment it would actually be useful, mid
round on an unfamiliar green.

## Multiplayer

Turn-based, so there is no mesh: this is the same architecture as Battle of
Pirates. Each client writes one Firestore document —
`lobbies/{room}/updates/{uid}` — and listens to everybody else's. No WebRTC, no
STUN, no NAT traversal, and nothing that can sit on "connecting…" forever
behind a corporate proxy.

Two packets per putt, for the same reason Battle of Pirates has two. A `fire`
goes out the instant the club meets the ball so every screen starts rolling
together; a `shot` follows once it has settled, carrying where every ball
finished. The shooter is authoritative — nobody re-derives a result and hopes
`Math.exp` agrees to the last bit. Receivers replay the putt because it looks
better than a teleport, then snap to the numbers.

`shot` also carries the running totals, so somebody who joined at hole three
has gaps in their card but a correct score — and the score is the part that
decides who won.

Bots are driven by exactly one device — the host online, this one offline —
because two clients each deciding a bot's putt would write two different greens
into two documents.

## Where the coins go

The purse is the account's, not the browser's: the game asks the PlayBuddies
page it is embedded in (`src/platform/wallet.ts`) and falls back to
localStorage when opened on its own. Coins are per game, the same as the ball
patterns they buy — what mini-golf pays out cannot be spent in Quoridor. Here
they buy ball patterns and nothing else — the coloured ring is what tells
balls apart, so a shop that touched it would take away the one thing the green
has to say.
