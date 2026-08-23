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

  /** Full deflection, in CSS pixels. Scaled so a phone is not asking for a longer pull than it has. */
  const reach = useRef(180);
  useEffect(() => {
    const measure = () => {
      const small = Math.min(window.innerWidth, window.innerHeight);
      reach.current = Math.max(96, Math.min(210, small * 0.34));
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

  const degrees = drag ? Math.round((drag.elev * 180) / Math.PI) : 0;

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
          {/* The band. One SVG, two shapes, redrawn once a frame. */}
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
            <circle cx={drag.ox} cy={drag.oy} r={9} fill="rgba(255, 232, 170, 0.9)" />
            <circle
              cx={drag.x}
              cy={drag.y}
              r={26}
              fill="rgba(8, 20, 34, 0.55)"
              stroke="rgba(255, 232, 170, 0.9)"
              strokeWidth={3}
            />
          </svg>

          {/* Readout, pinned above the thumb so a hand does not cover it. */}
          <div
            className="pointer-events-none fixed z-20 -translate-x-1/2 rounded-xl border border-white/20 bg-slate-950/80 px-3 py-1.5 text-center backdrop-blur-sm"
            style={{ left: drag.x, top: Math.max(8, drag.y - 84) }}
          >
            <div className="text-lg font-black leading-none tabular-nums text-amber-200">
              {Math.round(drag.power * 100)}%
            </div>
            <div className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-white/60">
              {degrees} deg
            </div>
          </div>
        </>
      )}
    </div>
  );
}
