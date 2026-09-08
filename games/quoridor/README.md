# Quoridor

A nine-by-nine race for PlayBuddies. Step one square a turn, or spend a wall
and make somebody else's crossing longer. Two players with ten walls each, or
four with five.

## Running it

```bash
npm install
npm run dev
```

Or from the repo root, which is what the platform does:

```bash
npm run build:games quoridor
```

The build script discovers this directory from `game.json` and publishes the
bundle to `public/g/quoridor/`. Nothing outside `games/quoridor/` needed
editing to add it.

## Layout

| Path | What it is |
|---|---|
| `src/game/rules.ts` | The whole game as rules: steps, jumps, wall legality, and the path check that stops a board being sealed. No pixels, no React. |
| `src/game/pawns.ts` | The eight pawns, drawn in code. Shape only — the colour is always the seat's. |
| `src/engine/QuoridorEngine.ts` | The position, the turn order, the hit-testing, and the drawing of all three. |
| `src/engine/ai.ts` | The bot. Runs when ahead; when behind, prices every wall on the leader's own route. |
| `src/screens/MatchView.tsx` | Render loop, HUD, turn clock and the wire. |
| `src/components/BoardPad.tsx` | The pointer gesture, and only that. |
| `src/net/turnLink.ts` | Online play: one Firestore document each. |
| `src/App.tsx` | Menus, the shop, and the lobby handshake. |

## The rules it plays

- **9×9 board.** A pawn moves one square up, down, left or right per turn.
  Never diagonally — except out of a jump.
- **Walls.** Two players get ten each, four players get five each. A wall
  covers two squares of groove and may not cross or overlap another.
- **Nobody can be sealed in.** A wall that leaves any pawn with no route at
  all to its goal is simply not a legal move, so every wall is a detour rather
  than a cage. This is checked with a breadth-first search per player before
  the wall is allowed down.
- **Jumping.** Face another pawn with no wall between you and you may jump
  straight over it to the square behind.
- **Diagonal jumps.** If a wall, the board's edge, or a third pawn is directly
  behind the pawn being jumped, the jump bends instead and lands to either
  side of it.

Two players start on the north and south edges and race to the opposite one.
Four players take all four edges, and play goes south, north, west, east — so
the two axes alternate rather than one pair racing unopposed.

## Multiplayer

Turn-based, so there is no mesh: this is the same architecture as Battle of
Pirates. Each client writes one Firestore document — `lobbies/{room}/updates/{uid}`
— and listens to everybody else's. No WebRTC, no STUN, no NAT traversal, and
nothing that can sit on "connecting…" forever behind a corporate proxy.

The one thing it does differently is what a packet carries. A move is a number
under 209, and a whole game is at most a couple of hundred of them, so **every
write carries the complete move list** rather than just the new move. That is
well under a kilobyte in a single field, and in exchange there is no resync
path to get wrong: a player who reloads, joins late, sleeps their phone or
misses a snapshot receives the entire game on the very next move and replays
it. See `syncHistory` in the engine — a list that extends ours is played out,
and one that disagrees with ours rebuilds the board from square one.

Bots are driven by exactly one device — the host online, this one offline —
because two clients each deciding a bot's move would write two different games
into two documents.

## Where the coins go

The purse is the account's, not the browser's: the game asks the PlayBuddies
page it is embedded in (`src/platform/wallet.ts`) and falls back to
localStorage when opened on its own. Coins are shared across every game on the
platform. Here they buy pawn shapes and nothing else — the seat colour is what
tells pawns apart, so a shop that touched it would take away the one thing the
board has to say.
