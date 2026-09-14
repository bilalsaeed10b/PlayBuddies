# Tower Siege — Shared Battlefield

Tower Siege is a one-screen tower defence game for one, two, or four players. Every participant sees and acts on the same map. There are no secondary keeps, camera arrows, or spectator boards.

## Modes

- **Single Player:** one commander defends the keep.
- **Shared Keep:** two commanders cooperate on one base and one life pool.
- **Head-to-Head:** two commanders share the danger but compete for tower kills.
- **Team Siege:** four commanders form alternating-seat teams (1 + 3 against 2 + 4). Team tower kills determine the winner after the final wave.

The mode is chosen in the room through visible mode cards. Match setup must not be hidden behind a generic Rules dialog. Live room size selects two seats for a duel-sized room and four seats once a third or fourth person joins.

## Economy and ownership

- The base, lives, enemies, wave clock, and battlefield are shared.
- Every player has a private gold balance.
- A machine records the seat that bought it.
- Only that owner may upgrade or sell the machine.
- A kill pays its bounty only to the owner of the machine that made the kill.
- Clear-wave and clean-wave rewards pay every active seat.
- Every machine carries its owner's color on the battlefield.

## Multiplayer state

- All clients derive the same seat order, seed, waves, and map.
- Human build packets include their owning seat.
- The host controls empty-seat bots and sends full board snapshots after bot or human changes, repairing missed packets without creating duplicate boards.
- A shared-wave start is sent to every peer.
- Host snapshots carry rules and seed so a returning client can reconstruct a session after the original start packet has been replaced.
- Background tabs continue stepping through the watchdog loop.

## Presentation

- The board fills the available landscape viewport and paints colorful terrain behind any letterboxed edge.
- Art uses bright grass, warm paths, clear silhouettes, and thick owner accents.
- Menus expose Single Player, Multiplayer, Shop, and Settings as primary choices.
- The game remains playable and scrollable on short landscape phone screens.
