# Fish Eat Fish

An underwater arena for up to eight players. Start as a minnow, eat anything
smaller, avoid anything bigger.

This is a PlayBuddies game, not a standalone app. The platform launches it in an
iframe with the room in the query string:

```
/g/players-eat-fish/index.html?room=ABC123&displayName=Sam
```

Opened without a `room`, it drops straight into solo play (one to three people
on one keyboard) so you can develop it without a lobby.

## How the multiplayer works

There is no game server — PlayBuddies is a static site. Instead:

- **Firestore** holds the lobby (`lobbies/{room}`). This game only ever writes
  `players.{uid}.fishIndex`, plus `matchStarted` if it is the host.
- **Realtime Database** carries WebRTC signalling at
  `signaling/{room}/{sender}/{recipient}`.
- **Everything else is peer-to-peer** over a WebRTC mesh: positions at 15Hz,
  and the AI fish at 6Hz from whoever the lobby says is host. None of that
  traffic touches a server, so the running cost of a match is zero.

Two rules keep the clients agreeing with each other:

- Only the host's AI snapshot counts. Anyone else claiming to run the ocean is
  ignored.
- Only the fish being eaten decides that it died, and tells the eater. Both
  clients run the same overlap test on their own player, so the victim is the
  only one who can be certain — this is why two players can never both claim
  the same kill.

## Layout

```
src/
  engine/GameEngine.ts   simulation and rendering; BALANCE at the top is the tuning dial
  game/fish.ts           the fish catalogue, growth lines and asset paths
  net/mesh.ts            WebRTC mesh + RTDB signalling
  screens/GameView.tsx   canvas, HUD and the netcode wiring
  components/Joystick.tsx  dynamic on-screen stick
  App.tsx                menus, fish picker, shop, lobby handoff
public/asset/            WebP art (0.6 MB; the PNG originals were 11.6 MB)
```

## Running it

```bash
npm install
npm run dev
```

Building is done from the repository root — `npm run build:games` compiles every
game into `public/g/`.
