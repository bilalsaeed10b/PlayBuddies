/**
 * Extra ICE servers from PlayWithBuddies' own TURN relay, for the pairs STUN
 * alone cannot connect , two NATs that both block unsolicited inbound
 * traffic, which a mobile carrier or a locked-down office network does
 * often enough that "multiplayer doesn't work" used to be a normal
 * experience rather than a rare one.
 *
 * The actual TURN account credentials never come near this file, or the
 * browser at all: they live on a small Cloudflare Worker
 * (cloudflare/turn-worker/) that mints a short-lived username/password pair
 * per request and hands back nothing else. If that request is slow, blocked,
 * or the endpoint below hasn't been deployed yet, this resolves to an empty
 * list and every game falls back to exactly the STUN-only behaviour it had
 * before TURN existed , this can never make a connection worse, only fail to
 * make one better.
 */

const TURN_ENDPOINT = 'https://playbuddies-turn.playwithbuddies.workers.dev';

export async function fetchTurnServers(timeoutMs = 4000): Promise<RTCIceServer[]> {
  if (!TURN_ENDPOINT) return [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(TURN_ENDPOINT, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as { iceServers?: RTCIceServer[] };
    return Array.isArray(data.iceServers) ? data.iceServers : [];
  } catch (err) {
    console.warn('[turn] credentials unavailable, falling back to STUN only:', err);
    return [];
  }
}
