/**
 * The same collector, mounted on a game's own dev server.
 *
 * `npm run dev` for a single game is the other place logs are worth having,
 * so it gets the identical endpoint writing the identical NDJSON to the
 * identical file the LAN host uses. Whichever server happens to be running,
 * `npm run logs` reads the same thing.
 *
 * Dev-only on this side (`apply: 'serve'`) because a Vite plugin has no
 * meaning in a built bundle -- but note that the *client* logger is not dev
 * only any more, which was the whole bug with the system this replaces.
 */
import type { Plugin } from 'vite';
import { createLogCollector } from './collector.mjs';

export function logPlugin(logFilePath: string): Plugin {
  const handleLog = createLogCollector(logFilePath);
  return {
    name: 'playbuddies-log',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // The collector answers /__log itself and returns true; anything else
        // carries on down the middleware chain untouched.
        if (!handleLog(req, res)) next();
      });
    },
  };
}
