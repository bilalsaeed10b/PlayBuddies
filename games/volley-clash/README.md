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
| `src/net/link.ts` | The wire: mesh first, Firestore relay for whoever it can't reach. |
| `src/net/mesh.ts` | WebRTC mesh, signalled over Realtime Database. |

## The two things worth knowing

**The host owns the rules; you own your body.** PlayBuddies is a static site, so
one player runs the score, the serve and the ball. But every machine simulates
the entire match, and each player's own character is placed where *their* machine
says it is — the packets carry the body and the input together. Nothing on your
screen ever waits for the network: a packet that goes missing costs accuracy,
never response. Corrections are fed back as the offset a character owes, over
about a tenth of a second, and your own body is corrected at a third of that
rate and only when it has genuinely drifted.

There is no TURN server here, so peer-to-peer does not always connect. When it
doesn't, the same messages go through a Firestore relay instead — slower, and
the game says so in the corner, but it plays. And if the host goes quiet for six
seconds, a guest picks up the rules and hands them back when it returns, because
a court where nothing can happen is the worst outcome of the three.

**Contact, not buttons.** There is no "hit" key. The ball leaves along the
vector from your centre to the ball, so a ball above your head goes up, a ball
off your shoulder goes sideways, and a ball you have jumped above goes down.
On the ground the outgoing angle is clamped upward, which is what teaches the
one rule the whole game rests on: you can only spike in the air.
