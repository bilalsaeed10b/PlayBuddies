/**
 * The pointer, and only the pointer.
 *
 * A transparent sheet over the canvas that turns clicks and drags into the two
 * things a Quoridor player can do: step onto a square, or drop a wall in a
 * groove. It owns no game state — it asks the engine what a point means and
 * hands the answer straight back to it.
 */
import { useCallback, useRef } from 'react';
import type { RefObject } from 'react';
import type { QuoridorEngine } from '../engine/QuoridorEngine';
import type { Orientation } from '../game/rules';

export default function BoardPad({
  engineRef,
  enabled,
  forced,
  onFirstTouch,
  onSettled,
}: {
  engineRef: RefObject<QuoridorEngine | null>;
  /** False while it is somebody else's turn, or the game is over. */
  enabled: boolean;
  /**
   * An orientation the player has pinned with the rotate button, overriding
   * the one the press position would have implied. Cleared by the caller when
   * a wall actually lands.
   */
  forced?: Orientation;
  onFirstTouch?: () => void;
  /** A move went in. The caller uses this to clear the turn clock and repaint. */
  onSettled?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  const touched = useRef(false);

  const at = useCallback((clientX: number, clientY: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return null;
    return { x: clientX - box.left, y: clientY - box.top };
  }, []);

  /** Keeps the ghost wall or the lit square under the pointer up to date. */
  const track = useCallback(
    (clientX: number, clientY: number) => {
      const engine = engineRef.current;
      const point = at(clientX, clientY);
      if (!engine || !point) return;
      if (engine.mode === 'wall') {
        engine.setHoverSlot(engine.pickSlot(point.x, point.y, forced));
        engine.setHoverCell(-1);
      } else {
        engine.setHoverCell(engine.pickCell(point.x, point.y));
        engine.setHoverSlot(null);
      }
    },
    [engineRef, at, forced],
  );

  const down = (e: React.PointerEvent) => {
    if (!touched.current) {
      touched.current = true;
      onFirstTouch?.();
    }
    if (!enabled) return;
    pressed.current = true;
    try {
      // Throws InvalidPointerId for a pointer the browser no longer considers
      // down. Capture is a nicety — it keeps a drag alive past the edge of the
      // sheet — and losing it must not cost us the move itself.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* not capturable; the drag still tracks */
    }
    track(e.clientX, e.clientY);
  };

  const move = (e: React.PointerEvent) => {
    // A mouse tracks with no button down, which is what gives a desktop
    // player a live preview of where a wall would land. A finger only tracks
    // while it is on the glass, because there is no hover to speak of.
    if (!enabled) return;
    if (!pressed.current && e.pointerType !== 'mouse') return;
    track(e.clientX, e.clientY);
  };

  const up = (e: React.PointerEvent) => {
    const engine = engineRef.current;
    if (!engine || !pressed.current) return;
    pressed.current = false;
    const point = at(e.clientX, e.clientY);
    if (!point || !enabled) return;

    if (engine.mode === 'wall') {
      const slot = engine.pickSlot(point.x, point.y, forced);
      if (slot && engine.playWall(slot.o, slot.r, slot.c)) {
        engine.setHoverSlot(null);
        onSettled?.();
      }
      return;
    }

    const target = engine.pickCell(point.x, point.y);
    if (target >= 0 && engine.playStep(target)) {
      engine.setHoverCell(-1);
      onSettled?.();
    }
  };

  const leave = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setHoverSlot(null);
    engine.setHoverCell(-1);
  };

  return (
    <div
      ref={ref}
      className="absolute inset-0 touch-none"
      style={{ cursor: enabled ? 'pointer' : 'default' }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        pressed.current = false;
        leave();
      }}
      onPointerLeave={leave}
    />
  );
}
