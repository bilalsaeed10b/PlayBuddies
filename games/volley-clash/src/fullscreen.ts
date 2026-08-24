/**
 * Fullscreen that also works on a phone.
 *
 * `document.documentElement.requestFullscreen()` — what this used to rely on —
 * fails in three separate ways here:
 *
 *   - iOS Safari has no Element.requestFullscreen at all. Only <video> can go
 *     fullscreen, so the promise doesn't reject, the method simply isn't there.
 *   - Inside an iframe it needs allow="fullscreen" on the frame, and even then
 *     it expands the frame's own document while the host page's chrome stays
 *     wrapped around it.
 *   - Android Chrome grants it, but the page underneath keeps its layout, so a
 *     game that sizes itself to 65vh is still 65vh — just on a bigger canvas.
 *
 * So all three routes are taken at once, cheapest first: ask the host page to
 * stretch the frame (the only one that works on iOS), try the real API, and
 * fall back to fixed-position CSS. Whichever lands, the game fills the screen.
 */

export const IN_IFRAME: boolean = (() => {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin parent — reading window.top threw, so there is one.
    return true;
  }
})();

/** Message the host page understands. The value is a boolean and nothing else. */
export function askHostForFullscreen(on: boolean) {
  if (!IN_IFRAME) return;
  // targetOrigin '*' because a game bundle cannot know which origin embedded
  // it. Safe here: the payload carries no data, and the host verifies the
  // message came from its own iframe before acting on it.
  window.parent.postMessage({ source: 'playbuddies-game', type: 'fullscreen', value: on }, '*');
}

export function isNativeFullscreen(): boolean {
  return Boolean(document.fullscreenElement);
}

/**
 * Asks the host page to end the match for the whole room.
 *
 * A game can leave its own player's seat on its own — that is just this
 * device navigating away — but ending the match is a room-wide state change
 * that lives on the lobby document the platform owns, not this game. The host
 * page re-checks that the caller is actually the host before acting on it.
 */
export function askHostToEndGame() {
  if (!IN_IFRAME) return;
  window.parent.postMessage({ source: 'playbuddies-game', type: 'end-game' }, '*');
}

const IMMERSIVE = 'position:fixed;inset:0;width:100%;height:100%;z-index:2147483647;';

export function toggleFullscreen(el: HTMLElement, on: boolean) {
  askHostForFullscreen(on);
  lockPageScroll(on);

  if (!on) {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    el.style.cssText = el.style.cssText.replace(IMMERSIVE, '');
    unlockOrientation();
    return;
  }

  // Real fullscreen first. It's the only path most mobile browsers will
  // actually honour an orientation lock on — lockLandscape's own comment
  // notes that — and it resizes the visual viewport itself instead of us
  // guessing at CSS percentages while the address bar is mid-animation.
  // CSS immersive mode is the fallback: iOS has no Element.requestFullscreen
  // at all, and a permissions policy can deny the request outright.
  if (typeof el.requestFullscreen === 'function') {
    el.requestFullscreen()
      .then(lockLandscape)
      .catch(() => applyImmersive(el));
  } else {
    applyImmersive(el);
  }
}

function applyImmersive(el: HTMLElement) {
  if (!el.style.cssText.includes('z-index:2147483647')) {
    el.style.cssText += IMMERSIVE;
  }
}

/** Stops the page behind the game rubber-banding under a thumb drag. */
function lockPageScroll(on: boolean) {
  document.documentElement.style.overflow = on ? 'hidden' : '';
  document.body.style.overflow = on ? 'hidden' : '';
}

type LockableOrientation = ScreenOrientation & {
  lock?: (o: string) => Promise<void>;
  unlock?: () => void;
};

function lockLandscape() {
  // Phones are held upright; most browsers only honour this while genuinely
  // fullscreen, which is why it is attempted after the request resolves.
  (screen.orientation as LockableOrientation)?.lock?.('landscape').catch(() => {});
}

function unlockOrientation() {
  try {
    (screen.orientation as LockableOrientation)?.unlock?.();
  } catch {
    /* not supported */
  }
}

/** True for devices driven by a finger, so touch controls aren't shown on a desktop in a wide window. */
export function isTouchDevice(): boolean {
  return (
    typeof window !== 'undefined' &&
    (('ontouchstart' in window) || navigator.maxTouchPoints > 0)
  );
}
