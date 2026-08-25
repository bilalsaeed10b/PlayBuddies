import { useCallback, useEffect, useRef, useState } from 'react';
import { CardId, elevRange } from '../game/rules';

/**
 * Aiming, which is the entire control scheme.
 *
 * Pull back and let go. The vector from where the finger went down to where it
 * is now, reversed, is the shot: its direction is the elevation and its length
 * is the powder. It is the one gesture everybody already knows from a
 * slingshot, it is identical with a mouse and with a thumb, and it needs no
 * buttons at all.
 *
 * The drag deliberately starts wherever the finger lands rather than on the
 * ship. Anchoring it to the hull means aiming with your thumb on top of the
 * thing you are trying to look at, on the smallest screens where that matters
 * most.
 */

/** Reserved at the top for the scoreboard, and at the bottom for the hand. */
const TOP_STRIP = 62;

export interface Aim {
  /** World radians, ready to hand to the engine. */
  angle: number;
  power: number;
}

interface Drag {
  ox: number;
  oy: number;
  x: number;
  y: number;
  angle: number;
  power: number;
  /** Radians above the horizon, kept so the readout does not have to re-derive it. */
  elev: number;
}

/**
 * Which way the shot leaves the barrel, drawn out of the pull.
 *
 * This is what replaced the trajectory arc on the water. That arc drew the
 * opening stretch of the ball's actual path, and it turned out to be the whole
 * game: you dragged until the dots lined up with the enemy and let go. An
 * arrow says direction and strength — the two things the gesture is setting —
 * and says nothing at all about where the ball comes down. Reading the range
 * is the player's job again.
 *
 * A free-floating flag rather than a shaft with a head on it: it sits just
 * past the guide circle's edge, pointing the way the shot leaves, and does
 * not stretch back to the knob. That keeps it reading as a heading, not as
 * a second rubber band next to the one the pull line already draws.
 *
 * Width is fixed. Only its reach -- the tip's distance from its base --
 * grows with power, so pulling harder makes the flag point further out
 * rather than swelling the whole shape. A triangle that gets both longer
 * and wider at once reads as "bigger", not as "more power in this specific
 * direction", which is the one thing this pad is actually trying to say.
 */
function Arrow({
  ox,
  oy,
  x,
  y,
  power,
  reach,
}: {
  ox: number;
  oy: number;
  x: number;
  y: number;
  power: number;
  reach: number;
}) {
  const dx = ox - x;
  const dy = oy - y;
  const len = Math.hypot(dx, dy);
  // Below this the direction is noise — the finger has barely moved, and an
  // arrow spinning wildly under a stationary thumb reads as a glitch.
  if (len < 12) return null;

  const ux = dx / len;
  const uy = dy / len;
  // A fixed gap past the ring, not past the knob: the arrow marks a heading on
  // the ring itself, so it holds still while only the knob behind it moves.
  const gap = 12;
  const wing = 8;
  const backLen = 10;
  const tipLen = 22 + power * 40;
  const baseX = ox + ux * (reach + gap);
  const baseY = oy + uy * (reach + gap);
  // Perpendicular, for the two back corners.
  const px = -uy;
  const py = ux;

  const tipX = baseX + ux * tipLen;
  const tipY = baseY + uy * tipLen;
  const backX = tipX - ux * backLen;
  const backY = tipY - uy * backLen;

  return (
    <polygon
      points={`${tipX},${tipY} ${backX + px * wing},${backY + py * wing} ${backX - px * wing},${backY - py * wing}`}
      fill="rgba(255, 232, 170, 0.95)"
    />
  );
}

export default function AimPad({
  enabled,
  facing,
  selectedCard,
  bottomInset,
  onAim,
  onDragChange,
  onFire,
  onFirstTouch,
}: {
  enabled: boolean;
  /** 1 if the firing ship points right, -1 if it points left. */
  facing: 1 | -1;
  /** Mortar aims within a narrower elevation band than everything else -- see elevRange. */
  selectedCard: CardId;
  /** Height of the card hand, so the pad does not fight it for touches. */
  bottomInset: number;
  /** Called on every move. Cheap on purpose: it writes straight into the engine. */
  onAim: (aim: Aim) => void;
  /** True while a drag is live, so the engine knows to draw its guide. */
  onDragChange: (dragging: boolean) => void;
  onFire: (aim: Aim) => void;
  onFirstTouch?: () => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const pointer = useRef<number | null>(null);
  const latest = useRef<Drag | null>(null);
  const frame = useRef(0);
  const touched = useRef(false);

  /**
   * Full deflection, in CSS pixels. Scaled so a phone is not asking for a
   * longer pull than it has.
   *
   * This is also the guide circle's radius, not a separate visual choice — the
   * ring is a promise about how far a full pull is, and drawing it any other
   * size than the number `measure` actually fires on would make it a promise
   * the pad doesn't keep.
   */
  const reach = useRef(90);
  useEffect(() => {
    const measure = () => {
      const small = Math.min(window.innerWidth, window.innerHeight);
      // A coarse pointer -- a thumb, not a mouse tip -- needs a bigger target
      // to pull back against. The same radius a mouse can place precisely
      // just read as small and fiddly to drag on a phone.
      const touch = window.matchMedia('(pointer: coarse)').matches;
      reach.current = touch
        ? Math.max(76, Math.min(148, small * 0.24))
        : Math.max(52, Math.min(96, small * 0.15));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // A drag left live because the pointer was lost is worse than a dropped
  // input: the shot fires itself the next time anything is touched.
  const abort = useCallback(() => {
    pointer.current = null;
    latest.current = null;
    setDrag(null);
    onDragChange(false);
  }, [onDragChange]);

  useEffect(() => {
    window.addEventListener('blur', abort);
    document.addEventListener('visibilitychange', abort);
    return () => {
      window.removeEventListener('blur', abort);
      document.removeEventListener('visibilitychange', abort);
      cancelAnimationFrame(frame.current);
    };
  }, [abort]);

  useEffect(() => {
    if (!enabled) abort();
  }, [enabled, abort]);

  /** Pull vector to a shot, with the elevation clamped to something a cannon can do. */
  const measure = useCallback(
    (ox: number, oy: number, x: number, y: number): { angle: number; power: number; elev: number } => {
      // Pull back to shoot forward: the shot leaves along the vector from the
      // finger back to where the drag started, which is the way a slingshot
      // has always worked.
      const pullX = ox - x;
      const pullY = oy - y;
      const len = Math.hypot(pullX, pullY);
      const power = Math.max(0.06, Math.min(1, len / reach.current));

      // Elevation is measured in the ship's own frame, so the same gesture
      // means the same shot on both sides of the water. Screen y grows
      // downward, hence the negation. The band itself depends on the card in
      // hand -- mortar cannot be dragged flatter than 45 degrees.
      const forward = pullX * facing;
      const [loElev, hiElev] = elevRange(selectedCard);
      const elev = Math.min(hiElev, Math.max(loElev, Math.atan2(-pullY, forward)));
      const angle = facing > 0 ? -elev : -(Math.PI - elev);
      return { angle, power, elev };
    },
    [facing, selectedCard],
  );

  const publish = useCallback(() => {
    frame.current = 0;
    const d = latest.current;
    if (!d) return;
    setDrag(d);
    onAim({ angle: d.angle, power: d.power });
  }, [onAim]);

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled || pointer.current !== null) return;
    e.preventDefault();
    if (!touched.current) {
      touched.current = true;
      onFirstTouch?.();
    }
    pointer.current = e.pointerId;
    // Capture is what lets a pull continue past the pad's own edges, which is
    // most of the screen on a phone in landscape. It is also allowed to throw
    // -- a pointer that has already been released, a synthetic event -- and a
    // throw here would abort the handler halfway through setting the drag up,
    // leaving a pad that looks live and answers to nothing.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the drag still works, it just stops at the pad's edge */
    }
    const shot = measure(e.clientX, e.clientY, e.clientX, e.clientY);
    const d = { ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY, ...shot };
    latest.current = d;
    setDrag(d);
    onDragChange(true);
  };

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== e.pointerId) return;
    const base = latest.current;
    if (!base) return;
    const shot = measure(base.ox, base.oy, e.clientX, e.clientY);
    latest.current = { ...base, x: e.clientX, y: e.clientY, ...shot };
    // Coalesced to one update a frame. A pointermove can fire far faster than
    // the display refreshes, and re-rendering for each is pure heat.
    if (!frame.current) frame.current = requestAnimationFrame(publish);
  };

  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== e.pointerId) return;
    const d = latest.current;
    pointer.current = null;
    latest.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    setDrag(null);
    onDragChange(false);
    // A tap is not a shot. Below a tenth of full pull it was almost certainly
    // someone touching the screen to look at something.
    if (d && d.power > 0.1) onFire({ angle: d.angle, power: d.power });
  };

  if (!enabled) return null;

  return (
    <div
      className="absolute left-0 right-0 z-10 touch-none select-none"
      style={{ top: TOP_STRIP, bottom: bottomInset }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {drag && (
        <>
          {/* The band. One SVG, redrawn once a frame. */}
          <svg className="pointer-events-none fixed inset-0 h-full w-full" aria-hidden>
            <circle
              cx={drag.ox}
              cy={drag.oy}
              r={reach.current}
              fill="none"
              stroke="rgba(255,255,255,0.16)"
              strokeWidth={2}
              strokeDasharray="6 8"
            />
            <line
              x1={drag.ox}
              y1={drag.oy}
              x2={drag.x}
              y2={drag.y}
              stroke="rgba(255, 232, 170, 0.85)"
              strokeWidth={4}
              strokeLinecap="round"
            />
            <Arrow ox={drag.ox} oy={drag.oy} x={drag.x} y={drag.y} power={drag.power} reach={reach.current} />
            {/* Anchor and knob, both sized off the ring rather than fixed, so
                growing the reach grows the whole gesture instead of leaving a
                thumb-sized knob rattling around inside a much larger circle. */}
            <circle cx={drag.ox} cy={drag.oy} r={reach.current * 0.1} fill="rgba(255, 232, 170, 0.9)" />
            <circle
              cx={drag.x}
              cy={drag.y}
              r={Math.max(24, reach.current * 0.28)}
              fill="rgba(8, 20, 34, 0.55)"
              stroke="rgba(255, 232, 170, 0.9)"
              strokeWidth={3}
            />
          </svg>
        </>
      )}
    </div>
  );
}
