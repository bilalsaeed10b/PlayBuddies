# Battle of Pirates

A turn-based artillery duel for PlayBuddies. Two ships, one stretch of open
water, one cannon each. Drag back and let go.

The full spec is in [REQUIREMENTS.md](./REQUIREMENTS.md); this is the map.

## Running it

```bash
npm install
npm run dev
```

Or from the repo root, which is what the platform does:

```bash
npm run build:games battle-of-pirates
```

The build script discovers this directory from `game.json` and publishes the
bundle to `public/g/battle-of-pirates/`. Nothing outside
`games/battle-of-pirates/` needed editing to add it.

## Layout

| Path | What it is |
|---|---|
| `src/game/rules.ts` | Every tunable number, plus the seven ammunition cards. |
| `src/game/ships.ts` | The eight hulls. Drawn in code, baked to a sprite on first use. |
| `src/game/sea.ts` | The background, baked once, plus the explosion sprites. |
| `src/game/quality.ts` | The render budget, guessed from the device and then corrected from real frame times. |
| `src/engine/BattleEngine.ts` | Ballistics, damage, the turn order and the drawing. |
| `src/engine/ai.ts` | The bot. Solves the shot, then misses on purpose. |
| `src/screens/BattleView.tsx` | Render loop, controls, HUD and the wire. |
| `src/components/AimPad.tsx` | The drag gesture, and only that. |
| `src/components/CardHand.tsx` | Three cards, dealt every turn. |
| `src/net/turnLink.ts` | Online play: one Firestore document each. |
| `src/App.tsx` | Menus, the shop, and the lobby handshake. |

## The four things worth knowing

**There is no mesh.** The other three games open a WebRTC connection because a
ball or a shoal of fish needs twenty updates a second. A turn is one write, so
this game exchanges turns through `lobbies/{room}/updates/{uid}` and never
negotiates a peer connection at all — no STUN, no NAT traversal, and nothing to
fail silently on a restrictive network.

**The seed is the whole handshake.** The host draws a number and a coin toss and
sends those two things once. Every hand, every wind shift, every drift and the
rocks themselves are pure functions of `(seed, turn)`, so both clients build the
identical match without another word about it. A shot on the wire is the angle,
the power, the card, and the state it left behind.

**The muzzle is inside the hull.** Every projectile starts life unarmed against
the ship that fired it and arms the moment it is clear. Without that, every shot
detonated on its own deck — and the same rule is what makes a mortar dropped
into your own rigging a real and deserved outcome.

**Quality is measured, not assumed.** `deviceMemory` and `hardwareConcurrency`
set an opening tier; real frame times move it. A downgrade thins the particles,
drops the trails, shrinks the backing store and halves the aim guide together,
so the game degrades in one step instead of getting gradually stranger.

## Balance

The bot ranks are measured rather than guessed. `TIERS` in `src/engine/ai.ts`
carries the method and the numbers: bot against bot, a Swab lands roughly two
shots in five, a Gunner three in four, and a Captain nine in ten, and a
Captain beats a Swab about thirty times out of thirty.

If you retune anything in `rules.ts`, re-run that measurement. In a dev build
the engine and the bot's decision function are on `window.__battle` and
`window.__decide`, and `update(dt, decide)` can be driven in a loop from the
console faster than real time.
