# Game logging

One logging system shared by every game, built for the case that actually
matters: four people on four devices, playing for real, and something goes
wrong that nobody can reproduce afterwards.

## Reading a playtest

```bash
npm run logs                      # latest session: devices, verdict, timeline
npm run logs -- --errors          # only what failed
npm run logs -- --room LU84W9     # one match, every device, merged in order
npm run logs -- --game wanted-board
npm run logs -- --grep wire       # anything matching, event or payload
npm run logs -- --tail 200        # a longer timeline
npm run logs -- --list            # what sessions exist
npm run logs -- --clear           # start fresh
```

The summary always leads with a **verdict** — errors and warnings, grouped and
counted, with which device each came from — because "did that game run fine?"
is the question this exists to answer.

## Where logs come from

Logs are written by whichever server the game is being served from:

| Serving from | Collector | Notes |
|---|---|---|
| `npm run serve` (LAN host) | yes | **The one phones connect to.** This is where a real playtest lands. |
| `npm run dev --prefix games/<id>` | yes | Single-game development. |
| GitHub Pages | no | Nothing is listening on `/__log`. See below. |

Everything appends to `dev-logs/session-<date>.ndjson` — one JSON object per
line, so it survives a crash mid-write and can be tailed live.

**To capture a real multi-device playtest, serve it yourself:**

```bash
npm run build && npm run serve
```

then point the phones at the `network:` URL it prints.

On GitHub Pages there is no collector, so the client gives up after three
failed sends and keeps buffering in memory instead. To retrieve a log from a
device there, open its console and run:

```js
__gamelog.text()
```

## Writing a log line

```ts
import { createLogger } from '@shared/log/logger';

const log = createLogger('my-game');

log.context({ room: 'LU84W9', who: 'Bilal' });   // once the lobby is known
log.info('wire:send', { type: 'shot', n: 4 });
log.warn('mesh:relayed', { unreachable: 2 });
log.error('wire:open-failed', { message });
```

`context()` is what makes four devices' lines merge into one readable match —
pass the room code as soon as the game has it.

### What is captured without asking

- uncaught errors (with a trimmed stack)
- unhandled promise rejections
- every `console.error` and `console.warn`

Most of the value is here: the interesting failure is usually the one nobody
predicted, so it has to land in the same timeline as the turns.

### What NOT to log

Not every function call, and never once a frame. A 60fps loop would bury the
signal in millions of lines and cost frames producing them. Log discrete,
meaningful events — a packet in or out, a turn changing hands, a round
resolving, a connection dropping. A log you cannot read is not a log.

## Ordering across devices

Four phones do not agree on wall-clock time to better than a few seconds, so
the client timestamp `t` is never trusted for ordering. Two other fields do
that job:

- `seq` — a per-client counter, which orders one device's own lines exactly.
- `ord` — stamped by the collector on arrival, which is the single ordering
  every device's lines can be merged by.

The reader sorts by `ord`.
