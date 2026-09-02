# Tower Siege

Everybody defends their own keep against the *same* waves. Hold out together
with one pool of lives, or race to see whose keep falls last.

See [REQUIREMENTS.md](./REQUIREMENTS.md) for what it is meant to do and why.

```bash
npm install
npm run dev
```

## Where things are

| Path | What lives there |
|---|---|
| `src/game/rules.ts` | Every balance number, the towers, the enemies, the wave generator |
| `src/game/map.ts` | The one hand-laid map: the route, the plots, the flyers' line |
| `src/game/art.ts` | The baked ground, the tower and enemy sprites, the burning keep |
| `src/engine/SiegeEngine.ts` | One keep, simulated. No React, no canvas, no Firestore |
| `src/engine/ai.ts` | The bot that holds an empty berth |
| `src/screens/MatchView.tsx` | The canvas, the render loop, the wire, the spectator view |
| `src/net/turnLink.ts` | One Firestore document each. No peer connection at all |

## The one idea worth knowing

Every client simulates **every** keep, not just its own. Waves come from the
match seed, so nothing about enemy composition or timing is ever sent — what
crosses the wire is only what a client cannot derive for itself: a tower being
built, a horde being sent, and a short summary at the end of each wave.

Spectating therefore costs nothing. The keep you press the arrow to watch is
already running; the arrow only changes which engine gets drawn.

The owner is authoritative for their own keep, and the wave-end summary is the
correction. Section 7.1 of REQUIREMENTS.md explains what that trade buys and
what it costs.

## Verifying it

The engine has no browser dependencies, so it can be driven headlessly:

```bash
npx esbuild __entry.ts --bundle --format=esm --platform=neutral --outfile=siege.mjs
```

where `__entry.ts` re-exports `game/rules`, `game/map`, `engine/SiegeEngine`
and `engine/ai`. Bundle them as *one* entry — four separate entries give each
its own copy of the rules module, and a balance tweak then silently fails to
reach the engine.

What was checked before this shipped:

- a wave list regenerates identically from one seed, and different seeds differ
- no point on the path lands on a buildable plot
- twelve seeds replay to identical outcomes on independent engines
- a fallen keep stays fallen
- a send lands exactly its own count on exactly the wave it was bought against
- the bot ladder: Squire holds to about wave 10, Captain 23, Warlord all 30
