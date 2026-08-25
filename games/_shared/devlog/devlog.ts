/**
 * One line in the shared dev log.
 *
 * POSTed to the dev server's `/__devlog` endpoint (see vitePlugin.ts) and
 * mirrored to the console, so the same call is useful both live and after
 * the fact. Entirely inert in a production build: `import.meta.env.DEV` is
 * false there, so this never fires and the endpoint it would have hit
 * doesn't exist anyway.
 *
 * Call it at discrete, meaningful events -- a turn changing hands, a packet
 * going out or coming in, a connection dropping -- not once a frame. This is
 * a trail for a human (or an agent) to read back afterward, not telemetry.
 */
let clientId = '';
function id(): string {
  if (!clientId) clientId = Math.random().toString(36).slice(2, 8);
  return clientId;
}

export function devLog(game: string, event: string, data?: Record<string, unknown>) {
  if (!import.meta.env.DEV) return;
  const entry = { t: new Date().toISOString(), game, client: id(), event, ...data };
  // eslint-disable-next-line no-console
  console.log(`[devlog:${game}]`, event, data ?? '');
  // Fire-and-forget: a dropped log line is not worth ever blocking gameplay
  // for, or even worth surfacing as an error. keepalive lets a log written
  // right before the tab closes (a connection dying, a page unload) still
  // reach the server.
  fetch('/__devlog', { method: 'POST', body: JSON.stringify(entry), keepalive: true }).catch(() => {});
}
