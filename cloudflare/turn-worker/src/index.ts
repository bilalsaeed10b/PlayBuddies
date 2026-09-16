/**
 * Mints short-lived Cloudflare TURN credentials for the two real-time games
 * (volley-clash, players-eat-fish). The one thing this whole worker exists
 * for: the account's TURN Key ID and API Token have to stay off the client,
 * or anyone reading the page's source could mint their own credentials and
 * spend the account's TURN bandwidth. This is the only place they're read.
 *
 * Deliberately stateless , no signing, no session lookup, nothing that could
 * go wrong offline. Any request from an allowed origin gets a fresh
 * credential; Cloudflare's own dashboard is where usage and abuse would show
 * up, and at this project's scale that is enough.
 */

export interface Env {
  TURN_KEY_ID: string;
  TURN_API_TOKEN: string;
}

/**
 * Exact origins the credential is handed to. A player's own browser is the
 * only caller this should ever have , not a script on someone else's site
 * quietly burning the free TURN allowance in this account's name.
 */
const ALLOWED_ORIGINS = [
  'https://bilalsaeed10b.github.io',
  // Add the production domain here once it's live, e.g. 'https://playbuddies.gg'.
];

/** One hour , comfortably longer than any single match, short enough that a leaked credential is worthless soon after. */
const TTL_SECONDS = 3600;

function allowOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Local dev servers only , never a wildcard on a real deploy.
  if (/^http:\/\/localhost:\d+$/.test(origin)) return origin;
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowOrigin(request.headers.get('Origin'));

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: origin
          ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' }
          : {},
      });
    }
    if (!origin) return new Response('Forbidden', { status: 403 });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

    const upstream = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      },
    );

    if (!upstream.ok) {
      console.error('cloudflare turn credential request failed', upstream.status, await upstream.text());
      return new Response('TURN credentials unavailable', {
        status: 502,
        headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' },
      });
    }

    const body = await upstream.text();
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
      },
    });
  },
};
