# Tower Siege — Requirements

A tower defence for 1–4 players where everybody defends their own keep against
the *same* waves, and the interesting question is who holds out longest.

---

## 1. The shape of it

Every player gets an identical map and an identical stream of enemies. Nothing
about the terrain or the wave list is rolled per player — if you lose, you lost
to the same monsters your opponent just handled, which is the entire point.

Two modes, chosen by the host:

**Siege (versus)** — everyone defends alone. A leak costs you a life. Run out
and your keep falls; the last keep standing wins. If several keeps are still up
when the wave list runs dry, waves keep escalating until one falls.

**Alliance (co-op)** — one shared pool of lives across the whole party. Waves
are scaled up for the head-count, so four players is harder than one, not four
times easier. Everyone wins or nobody does.

Solo is Siege against nothing but the waves: survive all of them.

## 2. Requirements

### 2.1 Must

- **R1** 1–4 players. A room with empty berths fills them with bots so a
  two-player Siege is still a race and not a walkover.
- **R2** Identical map, identical waves, identical economy for every player in
  a match. No per-player rolls anywhere that affects the fight.
- **R3** Versus and co-op, set by the host before the match and obeyed by
  everyone.
- **R4** Spectate: left/right arrows step through every other player's keep
  while the match runs. A spectated keep is read-only and unmistakably marked
  as somebody else's.
- **R5** A build phase between waves, and building allowed *during* a wave too
  — a tower defence where you cannot react to what is walking at you is a
  puzzle, not a game.
- **R6** Runs on a phone at a steady frame rate. Same quality governor the rest
  of the platform uses.
- **R7** Reconnect: a player who drops has their keep run by a bot, and takes
  it back when they return.
- **R8** Never blocks on the network. A player whose peers go quiet finishes
  their own match.

### 2.2 Should

- **S1** Sending: in Siege, spend gold to push extra enemies into everyone
  else's next wave. This is what stops versus being two solo games side by side.
- **S2** Towers upgradeable rather than only placeable, so a small map still
  has decisions in it late.
- **S3** Readable at a glance: what a tower does, what an enemy is, and how
  close a keep is to falling, without reading any text.
- **S4** Coins paid out to the platform wallet on a finished match.

### 2.3 Won't (this version)

- Terrain the player shapes (maze-building). The path is fixed, which is what
  makes two players' runs comparable.
- Per-player tower unlocks or anything bought with coins that changes the
  fight. Same rule the rest of the platform follows: the shop sells looks.

## 3. The map

One map, fixed, hand-laid rather than generated — a generated map is a
different map, and R2 says everyone fights the same one.

- A grid. Enemies walk a fixed path from a breach in the outer wall to the
  keep at the far end.
- Buildable tiles are the ground either side of the path. A tile holds one
  tower.
- The path doubles back on itself so a tower placed in the crook covers two
  stretches of it — that is where the placement decisions live.
- Flyers ignore the path entirely and cross in a straight line, so a wall of
  ground-only towers down one side is not an answer to everything.

## 4. Towers

Five, each answering a different problem. Every one is available from the first
wave; what limits you is gold, not unlocks.

| Tower | Role | Hits air | Notes |
|---|---|---|---|
| Arrow | cheap, fast, single target | yes | the floor you fall back on |
| Cannon | slow, splash | no | the answer to a pack |
| Frost | slows, little damage | yes | force multiplier, not a killer |
| Tesla | chains between nearby enemies | yes | short range, punishes clumps |
| Ballista | very long range, heavy single hit | no | the answer to a brute |

Two upgrade levels each. An upgrade raises damage and range and visibly
changes the tower — a player must be able to see what is upgraded without
selecting it.

Selling refunds a fraction, so a bad placement is a setback and not a loss.

## 5. Enemies

| Enemy | Shape of the problem |
|---|---|
| Runner | fast, thin. Punishes slow single-target towers |
| Grunt | the baseline everything else is measured against |
| Brute | slow, heavy armour. Punishes chip damage |
| Flyer | ignores the path. Punishes a one-sided layout |
| Warden | armoured *and* fast, arrives late |
| Boss | every fifth wave, huge, visible from the moment it spawns |

Armour subtracts from every hit rather than scaling it, so a fast weak tower is
genuinely poor against a brute and the counter-play is real.

## 6. Economy

- Gold per kill, and a bonus for clearing a wave with no leaks.
- Every player earns from the same enemies, so income differences come from
  killing things rather than from luck.
- Interest is deliberately absent: it rewards not playing.

## 7. Netcode

The transport is the platform's per-player Firestore document — the same one
the turn-based games use. A tower defence looks real-time but almost nothing
about it needs sending:

- **Waves come from the match seed.** Every client generates the identical wave
  list from it. Nothing about enemy composition, count or timing is ever sent.
- **Every client runs a full engine for every player**, its own and one per
  peer, exactly as Battle of Pirates runs one per ship. A remote keep is
  simulated locally, which is what makes spectating cost nothing.
- **What is actually sent** is what a client cannot derive: a tower being
  built, upgraded or sold; a send being bought; and a short summary at the end
  of each wave — lives, gold, wave number.
- **The owner is authoritative for their own keep.** A remote engine is a
  picture, and the wave-end summary corrects it. This is the platform's
  established rule and it is what keeps two devices from having to agree on a
  float.

That comes to a few dozen small writes for a whole match.

### 7.1 Divergence, stated plainly

A tower built mid-wave reaches a peer a moment after it went up locally, so a
spectator can briefly see one fewer arrow in flight. That is accepted: the
owner's lives are what decides the match, they are authoritative, and they are
resynced every wave. The alternative — locking every client to the same tick —
buys a prettier spectator view at the price of a game that stalls whenever one
phone is slow, and it is not worth that.

## 8. Presentation

- Canvas 2D, one baked backdrop, sprites baked once per tower and enemy kind.
- Towers turn to track what they are shooting. Projectiles have travel time and
  can miss a dead target — a shot that visibly leads a runner is worth more
  than an instant hit.
- Damage numbers are off. A health bar and a hit flash say the same thing
  without turning the screen into a spreadsheet.
- The keep shows its damage: at full lives it is whole, at one life it is
  burning.
- The spectator view is unmistakable — a coloured frame, the owner's name, and
  no build controls at all.

## 9. Done when

- A four-player Siege runs to a winner with no client disagreeing about who won.
- A wave list generated from one seed is identical across independent engines,
  verified numerically rather than by eye.
- A bot holds out past wave 10 on the default map, so an empty berth is a real
  opponent.
- The whole thing holds 60fps with four keeps simulated at once.
