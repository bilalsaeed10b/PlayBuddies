import { useCallback, useRef, useState } from 'react';
import { Vector2D } from '../types/game';

/**
 * Dynamic joystick: touch anywhere in the play area and the stick appears under
 * your thumb.
 *
 * A fixed stick in a corner is the wrong shape for this game — you spend the
 * whole match steering, and where your thumb naturally rests depends on how
 * you're holding the phone. This also replaces nipplejs, which was a dependency
 * for about forty lines of pointer maths and did not handle pointer capture, so
 * dragging off the edge of the screen left the fish swimming forever.
 */

/** Distance in CSS pixels that counts as full deflection. */
const RADIUS = 64;
/** Below this the stick reads as centred, so a resting thumb doesn't drift. */
const DEAD_ZONE = 0.12;

export default function Joystick({
  onMove,
  onEnd,
}: {
  onMove: (v: Vector2D) => void;
  onEnd: () => void;
}) {
  const [origin, setOrigin] = useState<Vector2D | null>(null);
  const [knob, setKnob] = useState<Vector2D>({ x: 0, y: 0 });
  const pointerId = useRef<number | null>(null);
  // Viewport coordinates, for the drag delta. `origin` state holds the same
  // point relative to this element, because that is what positions the stick.
  const originRef = useRef<Vector2D>({ x: 0, y: 0 });

  const down = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // One stick at a time: a second finger is almost always a mis-tap, and
    // letting it take over makes the fish jerk.
    if (pointerId.current !== null) return;
    pointerId.current = e.pointerId;
    // Capture, so a drag that leaves the element still reports moves and,
    // crucially, still reports the release.
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    originRef.current = { x: e.clientX, y: e.clientY };
    setOrigin({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setKnob({ x: 0, y: 0 });
  }, []);

  const move = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (pointerId.current !== e.pointerId) return;
      const dx = e.clientX - originRef.current.x;
      const dy = e.clientY - originRef.current.y;
      const dist = Math.hypot(dx, dy);
      const clamped = Math.min(dist, RADIUS);
      const nx = dist ? (dx / dist) * clamped : 0;
      const ny = dist ? (dy / dist) * clamped : 0;
      setKnob({ x: nx, y: ny });

      const strength = clamped / RADIUS;
      if (strength < DEAD_ZONE) {
        onMove({ x: 0, y: 0 });
        return;
      }
      onMove({ x: (nx / RADIUS), y: (ny / RADIUS) });
    },
    [onMove],
  );

  const up = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (pointerId.current !== e.pointerId) return;
      pointerId.current = null;
      setOrigin(null);
      onEnd();
    },
    [onEnd],
  );

  return (
    <div
      className="absolute inset-0 z-10 touch-none select-none"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {origin && (
        <>
          <div
            className="pointer-events-none absolute rounded-full border-2 border-white/50 bg-white/10 backdrop-blur-sm"
            style={{
              width: RADIUS * 2,
              height: RADIUS * 2,
              left: origin.x - RADIUS,
              top: origin.y - RADIUS,
            }}
          />
          <div
            className="pointer-events-none absolute rounded-full bg-white/70 shadow-lg"
            style={{
              width: RADIUS,
              height: RADIUS,
              left: origin.x + knob.x - RADIUS / 2,
              top: origin.y + knob.y - RADIUS / 2,
            }}
          />
        </>
      )}
    </div>
  );
}
