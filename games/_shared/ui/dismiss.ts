/**
 * Closing a modal the two ways every modal is expected to close.
 *
 * Every game grew the same panel independently — a full-screen scrim with a
 * card centred in it and a back arrow in the corner — and every one of them
 * could only be closed by finding that arrow. Clicking the dimmed area outside
 * the card did nothing, and neither did Escape, which is not what either
 * gesture means anywhere else.
 *
 * One helper rather than fifteen copies, for the same reason ControlsTray
 * exists: the games had already drifted apart on this once.
 */
import { useEffect } from 'react';
import type { MouseEvent } from 'react';

/**
 * Props for the scrim element.
 *
 * The click is checked against the scrim *itself* rather than by stopping
 * propagation on the card: a click that begins on the card and drifts onto the
 * scrim before it is released — dragging a volume slider past the edge of the
 * panel, which is exactly what a slider invites — would otherwise close the
 * panel out from under the drag.
 */
export function scrimProps(onClose: () => void) {
  return {
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
  };
}

/** Escape closes the topmost panel. */
export function useEscape(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);
}

/** Both at once, for the common case: `<div {...dismissable(onClose)} …>`. */
export function dismissable(onClose: () => void) {
  return scrimProps(onClose);
}
