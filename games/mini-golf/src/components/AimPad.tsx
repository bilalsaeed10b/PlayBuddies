import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Aiming, which is the entire control scheme.
 *
 * Pull back and let go. The vector from where the finger went down to where it
 * is now, reversed, is the putt: its direction is the line and its length is
 * the weight. It is the one gesture everybody already knows from a slingshot,
 * it is identical with a mouse and with a thumb, and it needs no buttons.
 *
 * This is Battle of Pirates' pad with the artillery taken out of it. There is
 * no elevation to clamp and no barrel to point, because from directly above a
 * heading is just a heading: the camera only ever pans and scales, never
 * rotates, so a direction on the glass is the same direction on the green and
 * the conversion is nothing at all.
 *
 * The drag deliberately starts wherever the finger lands rather than on the
 * ball. Anchoring it to the ball means aiming with your thumb on top of the
 * thing you are trying to look at, on the smallest screens where that matters
 * most.
 */

/** Reserved at the top for the scoreboard. */
const TOP_STRIP = 66;

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
}

/**
 * How hard the putt is, read around the ring rather than along the pull.
 *
 * The pull line already says "this far back". What it does not say is how far
 * back full is, and a player who has never seen the ring at full stretch has
 * no reference for it. Dots filling clockwise do: an eighth of the way round
 * is a tap, all the way round is everything you have.
 */
function PowerArc({ ox, oy, reach, power }: { ox: number; oy: number; reach: number; power: number }) {
  const total = 36;
  const lit = Math.round(power * total);
  const dots = [];
  for (let i = 0; i < total; i++) {
    const a = -Math.PI / 2 + (i / total) * Math.PI * 2;
    const on = i < lit;
    dots.push(
      <circle
        key={i}
        cx={ox + Math.cos(a) * reach}
        cy={oy + Math.sin(a) * reach}
        r={on ? 2.6 : 1.5}
        fill={on ? (power > 0.86 ? 'rgba(252,165,165,0.95)' : 'rgba(255,255,255,0.9)') : 'rgba(255,255,255,0.22)'}
      />,
    );
  }
  return <g>{dots}</g>;
}

/**
 * Which way the ball leaves, drawn out of the pull.
 *
 * A free-floating flag rather than a shaft with a head on it: it sits just
 * past the ring's edge, points the way the putt goes, and does not stretch
 * back to the knob. That keeps it reading as a heading rather than as a second
 * rubber band beside the one the pull line already draws.
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
  const gap = 14;
  const wing = 8;
  const backLen = 10;
  const tipLen = 20 + power * 38;
  const baseX = ox + ux * (reach + gap);
  const baseY = oy + uy * (reach + gap);
  const px = -uy;
  const py = ux;

  const tipX = baseX + ux * tipLen;
  const tipY = baseY + uy * tipLen;
  const backX = tipX - ux * backLen;
  const backY = tipY - uy * backLen;

  return (
    <polygon
      points={`${tipX},${tipY} ${backX + px * wing},${backY + py * wing} ${backX - px * wing},${backY - py * wing}`}
      fill="rgba(255,255,255,0.95)"
    />
  );
}

export default function AimPad({
  enabled,
  onAim,
  onDragChange,
  onFire,
  onFirstTouch,
}: {
  enabled: boolean;
  /** Called on every move. Cheap on purpose: it writes straight into the engine. */
  onAim: (aim: Aim) => void;
  /** True while a drag is live, so the engine knows to brighten its aim line. */
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
   * This is also the ring's radius, not a separate visual choice — the ring is
   * a promise about how far a full pull is, and drawing it any other size than
   * the number `measure` actually fires on would make it a promise the pad
   * does not keep.
   */
  const reach = useRef(90);
  useEffect(() => {
    const measure = () => {
      const small = Math.min(window.innerWidth, window.innerHeight);
      reach.current = Math.max(44, Math.min(84, small * 0.13));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // A drag left live because the pointer was lost is worse than a dropped
  // input: the putt fires itself the next time anything is touched.
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

  /** Pull vector to a putt. Screen direction is world direction, so this is the whole conversion. */
  const measure = useCallback((ox: number, oy: number, x: number, y: number): { angle: number; power: number } => {
    const pullX = ox - x;
    const pullY = oy - y;
    const len = Math.hypot(pullX, pullY);
    const power = Math.max(0.06, Math.min(1, len / reach.current));
    // A pull of nothing has no direction; hold the last one rather than
    // snapping to due east the instant the finger lands.
    const angle = len < 4 ? (latest.current?.angle ?? 0) : Math.atan2(pullY, pullX);
    return { angle, power };
  }, []);

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
    // most of the screen on a phone. It is also allowed to throw — a pointer
    // already released, a synthetic event — and a throw here would abort the
    // handler halfway through setting the drag up, leaving a pad that looks
    // live and answers to nothing.
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
    // A tap is not a putt. Below a tenth of full pull it was almost certainly
    // somebody touching the screen to look at something.
    if (d && d.power > 0.1) onFire({ angle: d.angle, power: d.power });
  };

  if (!enabled) return null;

  return (
    <div
      className="absolute left-0 right-0 z-10 touch-none select-none"
      style={{ top: TOP_STRIP, bottom: 0 }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {drag && (
        <svg className="pointer-events-none fixed inset-0 h-full w-full" aria-hidden>
          <circle
            cx={drag.ox}
            cy={drag.oy}
            r={reach.current}
            fill="none"
            stroke="rgba(255,255,255,0.14)"
            strokeWidth={2}
            strokeDasharray="3 5"
          />
          <PowerArc ox={drag.ox} oy={drag.oy} reach={reach.current} power={drag.power} />
          <line
            x1={drag.ox}
            y1={drag.oy}
            x2={drag.x}
            y2={drag.y}
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={4}
            strokeLinecap="round"
          />
          <Arrow ox={drag.ox} oy={drag.oy} x={drag.x} y={drag.y} power={drag.power} reach={reach.current} />
          <circle cx={drag.ox} cy={drag.oy} r={9} fill="rgba(255,255,255,0.9)" />
          <circle
            cx={drag.x}
            cy={drag.y}
            r={26}
            fill="rgba(8,32,18,0.55)"
            stroke="rgba(255,255,255,0.9)"
            strokeWidth={3}
          />
        </svg>
      )}
    </div>
  );
}
