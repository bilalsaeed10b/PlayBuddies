# Volley Clash

Arcade beach volleyball for PlayBuddies. Solo against the bot, two on one
keyboard, or online — 1v1, or 2v2 on a wider court.

The full spec is in [REQUIREMENTS.md](./REQUIREMENTS.md); this is the map.

## Running it

```bash
npm install
npm run dev
```

Or from the repo root, which is what the platform does:

```bash
npm run build:games volley-clash
```

The build script discovers this directory from `game.json` and publishes the
bundle to `public/g/volley-clash/`. Nothing outside `games/volley-clash/` needed
editing to add it.

## Layout

| Path | What it is |
|---|---|
| `src/game/rules.ts` | Every tunable number, and the two court sizes. |
| `src/game/characters.ts` | The roster. Drawn in code — no sprite sheets. |
| `src/game/court.ts` | The background, baked once to an offscreen canvas. |
| `src/engine/MatchEngine.ts` | Physics, rules, power-ups and rendering. |
| `src/engine/ai.ts` | The bot. Predicts where the ball lands rather than chasing it. |
| `src/screens/MatchView.tsx` | Render loop, controls, and the netcode. |
| `src/App.tsx` | Menus, character select, and the lobby handshake. |
| `src/net/mesh.ts` | WebRTC mesh, signalled over Realtime Database. |

## The two things worth knowing

**The host is the server.** PlayBuddies is a static site, so one player runs the
simulation and everyone else sends a one-byte input bitmask and renders what
they are told. Clients predict their own character so their own input never
feels laggy, and ease toward the host's snapshots for everything else.

**Contact, not buttons.** There is no "hit" key. The ball leaves along the
vector from your centre to the ball, so a ball above your head goes up, a ball
off your shoulder goes sideways, and a ball you have jumped above goes down.
On the ground the outgoing angle is clamped upward, which is what teaches the
one rule the whole game rests on: you can only spike in the air.
