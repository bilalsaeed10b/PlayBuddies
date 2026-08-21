/**
 * Telling PlayBuddies a level was finished.
 *
 * This game has no shop and no coins, so it needs none of the wallet the other
 * games carry. All it owes the platform is the one line the dashboard counts:
 * a level was attempted, and whether it was cleared without dying.
 *
 * Played on its own, outside the site, there is no account for it to count
 * towards and nothing is sent.
 */
const embedded = (() => {
  try {
    return window.parent !== window;
  } catch {
    return false;
  }
})();

export function reportResult(won: boolean) {
  if (!embedded) return;
  window.parent.postMessage({ source: 'playbuddies-game', type: 'result', won }, '*');
}
