# PlayBuddies

A web platform for playing browser games with friends. Google sign-in, shareable
room codes, real-time lobbies.

## Structure

```
playbuddies/
├─ src/                     # Next.js platform (landing, dashboard, lobby)
│  ├─ app/                  # routes
│  ├─ components/           # shared UI
│  ├─ hooks/                # useFriends, usePresence
│  ├─ lib/                  # firebase, games registry, room codes
│  └─ types/                # shared types
│
├─ games/                   # ONE folder per game — the source of truth
│  └─ fireboy-watergirl/
│     ├─ game.json          # metadata: name, players, category, thumbnail
│     ├─ thumb.webp         # card art
│     ├─ src/               # the game itself (Vite + React)
│     └─ package.json
│
├─ scripts/build-games.mjs  # builds games/* → public/g/*  (generated, gitignored)
├─ firestore.rules
└─ database.rules.json
```

### The one rule

**A game's code lives in exactly one place: `games/<id>/`.**

`public/g/` is build output and is gitignored. Never edit or commit it. The
catalog (`src/lib/games.generated.ts`) is also generated — edit `game.json`
instead.

This matters: the project previously carried six copies of the same game, and
level edits were being made to a copy that nothing compiled.

## Adding a game

1. Create `games/your-game/` containing a Vite app and a `game.json`:

```json
{
  "id": "your-game",
  "name": "Your Game",
  "description": "One line about it.",
  "category": "puzzle",
  "minPlayers": 2,
  "maxPlayers": 4,
  "thumbnail": "thumb.webp",
  "accent": { "from": "#f97316", "to": "#06b6d4" },
  "available": true
}
```

2. Run `npm run build:games`.

That's it — it appears on the landing page, the dashboard and the lobby picker.
No platform file needs editing. `id` must match the folder name; the build fails
loudly if the manifest is wrong.

### How a game talks to the platform

The platform mounts your game in an iframe at
`/g/<id>/index.html?room=CODE&displayName=…&photoURL=…` and shares the lobby
document at `lobbies/{roomCode}`:

| Path | Owner | Purpose |
|---|---|---|
| `lobbies/{code}` | platform | `hostId`, `status`, `players` map |
| `lobbies/{code}.matchStarted` | game | host's in-game go signal |
| `lobbies/{code}/messages` | shared | chat (subcollection, never an array field) |
| `lobbies/{code}/updates/{uid}` | game | per-player state, one doc each |
| RTDB `presence/lobbies/{code}` | platform | who is actually connected |
| RTDB `signaling/{code}/{uid}` | game | WebRTC offer/answer/ICE |

Read host status from `hostId` on the lobby document, never from a URL
parameter — query strings are user-editable.

## Commands

```bash
npm run dev          # platform dev server
npm run build        # build:games + next build → out/
npm run build:games  # rebuild games and regenerate the catalog
npm run typecheck    # platform types
npm run lint
```

Build a single game while iterating:

```bash
node scripts/build-games.mjs fireboy-watergirl
```

Work on a game standalone (with hot reload):

```bash
cd games/fireboy-watergirl && npm run dev
```

## Levels

`games/fireboy-watergirl/src/game/levels.ts` holds `DEFAULT_LEVELS`. The
in-game editor saves overrides to localStorage, namespaced by `LEVELS_VERSION`.

**Bump `LEVELS_VERSION` whenever you change the default levels** — that is what
stops a player's saved overrides from shadowing the levels you just shipped.

## Deployment

GitHub Actions builds and publishes to GitHub Pages on push to `main`
(`output: "export"`, so the whole site is static).

Being static means there is no server: no request-time auth checks, no rate
limiting, and no server-authoritative game state. Firestore security rules are
therefore the only thing standing between a client and your data — read
`firestore.rules` before changing how any collection is written.

## Environment

Firebase web config is public by design and is committed with sensible
defaults. To point a build at a different Firebase project, copy
`.env.example` to `.env.local` (platform) or `games/<id>/.env.local` (a game).
