/**
 * A dev-only endpoint a running game can POST to, so a real playtest --
 * online, multiple tabs, whatever broke -- leaves a plain-text trail on disk
 * instead of living only in a browser console nobody can go back and read.
 *
 * One shared log file across every game and every tab pointed at it: two
 * browser tabs standing in for two players in the same online match both
 * write to the same file, so a sync bug shows up as one interleaved
 * timeline instead of two consoles that have to be compared by hand.
 *
 * Dev-only on both ends -- `apply: 'serve'` means this middleware, and the
 * file write behind it, never exist in a production build. See devlog.ts for
 * the client half.
 */
import type { Plugin } from 'vite';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function devLogPlugin(logFilePath: string): Plugin {
  let ready: Promise<void> | null = null;
  const ensureDir = () => (ready ??= mkdir(dirname(logFilePath), { recursive: true }).then(() => undefined));

  return {
    name: 'devlog',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__devlog', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          void ensureDir()
            .then(() => appendFile(logFilePath, `${body.trim()}\n`))
            .catch((err) => console.error('[devlog] could not write:', err))
            .finally(() => {
              res.statusCode = 204;
              res.end();
            });
        });
      });
    },
  };
}
