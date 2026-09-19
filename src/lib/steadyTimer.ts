/**
 * `setInterval`, except it keeps its rate in a background tab.
 *
 * Browsers slow a hidden tab's own timers to once a second, and after a few
 * minutes to once a minute, and stop `requestAnimationFrame` altogether. For a
 * real-time multiplayer game that is not a battery saving, it is a player
 * freezing on everyone else's screen: a host who switched tabs stopped the
 * whole reef for the room, and a guest who did became a statue that could eat
 * but never be eaten.
 *
 * Timers inside a dedicated worker are not throttled that way, and the
 * messages they post are delivered to the page promptly. So every interval
 * made here ticks inside one small shared worker and calls back on the main
 Where a worker cannot be made at all, it falls back to an ordinary
 * interval, which is exactly the behaviour there was before.
 */

const WORKER_SOURCE = `
const timers = new Map();
onmessage = (e) => {
  const d = e.data;
  if (d.op === 'start') timers.set(d.id, setInterval(() => postMessage(d.id), d.ms));
  else { clearInterval(timers.get(d.id)); timers.delete(d.id); }
};
`;

let worker: Worker | null | undefined;
const jobs = new Map<number, () => void>();
let nextId = 1;

function shared(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = (e: MessageEvent<number>) => jobs.get(e.data)?.();
  } catch {
    worker = null;
  }
  return worker;
}

/** Calls `fn` every `ms`, hidden tab or not. Returns the function that stops it. */
export function steadyInterval(fn: () => void, ms: number): () => void {
  const w = shared();
  if (!w) {
    const handle = window.setInterval(fn, ms);
    return () => window.clearInterval(handle);
  }
  const id = nextId++;
  jobs.set(id, fn);
  w.postMessage({ op: 'start', id, ms });
  return () => {
    if (!jobs.delete(id)) return;
    w.postMessage({ op: 'stop', id });
  };
}
