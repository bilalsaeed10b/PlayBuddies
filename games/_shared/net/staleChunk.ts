/**
 * "Could not reach the other players" that isn't actually a network problem.
 *
 * Every game code-splits its wire module (`import('../net/turnLink')`, or
 * `'../net/link'` for Volley Clash) so an offline match never pays for it.
 * That module is a build asset with a content hash in its filename, and this
 * site redeploys on every push -- so a tab that has been sitting in a lobby
 * since before the latest deploy is holding an `index.html` that still asks
 * for the *old* hash the moment a match starts, and the new deploy has
 * already deleted it. The dynamic `import()` 404s, and from here that is
 * indistinguishable from a real network failure -- except that reloading
 * fixes it every time, because the fresh `index.html` asks for the file that
 * actually exists.
 *
 * This was reported as Tower Siege refusing to connect right as a host
 * started a match; the deploy that finished a minute before the report is
 * timestamped is the actual cause, not anything in the turn protocol.
 */

/**
 * Browsers do not agree on wording for a failed dynamic import, so this
 * matches the phrases each of the three engines actually uses rather than
 * one exact string.
 */
const STALE_CHUNK_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
];

export function isStaleChunkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Reload once to pick up the deploy that already happened, rather than
 * leaving the player on a screen whose only button is "Back" to a lobby that
 * will fail the exact same way.
 *
 * Guarded per tab per path so a genuinely broken deploy (or a device that is
 * actually offline) fails once, visibly, instead of reload-looping forever.
 * `sessionStorage` rather than a module-level flag because the reload itself
 * throws every bit of JS state away -- only storage survives it.
 */
export function recoverFromStaleChunk(): boolean {
  const key = `pb:stale-reload:${location.pathname}`;
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, '1');
  } catch {
    // Private browsing or a full quota: fall through and reload anyway. One
    // extra reload attempt is a far smaller cost than staying stuck.
  }
  location.reload();
  return true;
}
