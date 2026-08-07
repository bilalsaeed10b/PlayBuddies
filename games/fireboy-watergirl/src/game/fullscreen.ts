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
 * So the order is: ask the host page (it can stretch the iframe to the viewport
 * with no Fullscreen API involved, which is the only thing that works on iOS),
 * then the real API, then a local CSS-only immersive mode as a last resort.
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
 * Returns true when the caller should also apply its own immersive styling,
 * i.e. when no native fullscreen was available.
 */
export function toggleFullscreen(el: HTMLElement, on: boolean): boolean {
  askHostForFullscreen(on);

  const canNative = typeof el.requestFullscreen === 'function';
  if (!canNative) return true;

  if (on) {
    el.requestFullscreen().catch(() => {
      /* denied (no user gesture, or a permissions policy) — CSS mode covers it */
    });
    // Phones are held upright; a 4:3 platformer is unplayable that way.
    lockLandscape();
  } else if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
  return true;
}

function lockLandscape() {
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (o: string) => Promise<void>;
  };
  orientation?.lock?.('landscape').catch(() => {
    /* not supported, or not in fullscreen — the layout handles portrait anyway */
  });
}

/** True for devices driven by a finger, so touch controls aren't shown on a desktop in a wide window. */
export function isTouchDevice(): boolean {
  return (
    typeof window !== 'undefined' &&
    (('ontouchstart' in window) || navigator.maxTouchPoints > 0)
  );
}
