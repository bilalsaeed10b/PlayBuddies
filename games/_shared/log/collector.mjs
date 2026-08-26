/**
 * The server half: one place that accepts log batches and writes them down.
 *
 * Deliberately plain Node with no dependencies, and deliberately NOT a Vite
 * plugin, because the server four phones actually talk to during a playtest
 * is scripts/serve.mjs -- the LAN host -- and the old collector only existed
 * inside `vite dev`. Both mount this same handler now, so it does not matter
 * which one is running.
 *
 * Output is NDJSON: one JSON object per line, appended, never rewritten. That
 * survives a crash mid-write, can be tailed live while a game is in progress,
 * and is trivially greppable -- all three of which a single JSON array is bad
 * at.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Refuse a body larger than this, so a runaway client cannot fill the disk. */
const MAX_BODY = 512 * 1024;

/**
 * A global arrival counter.
 *
 * The one ordering every client agrees on. Devices disagree about wall clock
 * by seconds, so `ord` -- the order the collector actually received lines --
 * is what a merged four-device timeline is sorted by.
 */
let ord = 0;

export function createLogCollector(logFilePath) {
  let ready = null;
  const ensureDir = () => (ready ??= mkdir(path.dirname(logFilePath), { recursive: true }).then(() => undefined));

  /**
   * Handle one request. Returns true, SYNCHRONOUSLY, if it was ours -- so a
   * host can write `if (handleLog(req, res)) return;` and fall through to
   * serving files otherwise. Deliberately not an async function: one of those
   * returns a Promise, every Promise is truthy, and the caller above would
   * then swallow every request on the server including the game itself.
   */
  return function handleLog(req, res) {
    const url = (req.url || '').split('?')[0];
    if (url !== '/__log') return false;

    // The games run inside an iframe and, on a phone, from a different origin
    // than whatever tooling is reading this back. Logging is local-only
    // developer plumbing, so it answers everybody.
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return true;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, cors);
      res.end();
      return true;
    }

    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        body = '';
      }
    });

    req.on('end', () => {
      void (async () => {
        try {
          if (tooBig) {
            res.writeHead(413, cors);
            res.end();
            return;
          }
          const parsed = JSON.parse(body || '[]');
          const batch = Array.isArray(parsed) ? parsed : [parsed];
          const now = new Date().toISOString();
          const lines = batch
            .filter((e) => e && typeof e === 'object')
            // `rt` is the collector's own clock and `ord` its arrival order:
            // the two fields that make lines from different devices
            // comparable at all.
            .map((e) => JSON.stringify({ ...e, rt: now, ord: ++ord }))
            .join('\n');
          if (lines) {
            await ensureDir();
            await appendFile(logFilePath, lines + '\n');
          }
          res.writeHead(204, cors);
          res.end();
        } catch (err) {
          console.error('[log] could not write:', err.message);
          // Still a 204: a client must never retry or slow down because the
          // collector had a bad moment.
          res.writeHead(204, cors);
          res.end();
        }
      })();
    });

    return true;
  };
}
