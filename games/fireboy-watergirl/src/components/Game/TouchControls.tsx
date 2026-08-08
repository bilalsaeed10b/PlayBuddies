import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The whole screen is the controller.
 *
 * This replaces three clusters of floating circular buttons that sat *beside*
 * the canvas in a flex row. On a phone in landscape those pads ate roughly a
 * third of the width, the play area got what was left, and the result was a
 * postage stamp in the middle of a black screen — which is exactly what was
 * reported.
 *
 * Zones cost no layout. The left half is a joystick that appears under whatever
 * thumb touched it, the right half is jump, and the level fills everything.
 *
 * Design notes:
 *
 * - **Horizontal only.** This is a platformer with left, right and jump. A
 *   two-axis stick would imply a vertical control that does not exist.
 * - **Two pointers at once.** Moving and jumping are simultaneous, so each zone
 *   tracks its own pointerId. A single shared handler would drop the jump the
 *   moment the other thumb moved, which is the classic mobile-platformer bug.
 * - **The top strip is left alone** so the HUD buttons behind it — invite,
 *   fullscreen, settings — stay tappable.
 */

/** Thumb travel, in CSS pixels, that counts as full deflection. */
const RADIUS = 56;
/** Below this fraction the stick reads as centred, so a resting thumb doesn't creep. */
const DEAD_ZONE = 0.22;
/** Height reserved at the top for the HUD controls. */
const HUD_STRIP = 56;

export interface TouchKeys {
  left: string;
  right: string;
  jump: string;
}

export default function TouchControls({
  keys,
  bind,
  hintKey,
  onFirstTouch,
}: {
  /** The same key set the keyboard writes into, so the engine needs no changes. */
  keys: React.MutableRefObject<Set<string>>;
  bind: TouchKeys;
  /** Changing this replays the one-second hint — pass the level index. */
  hintKey: number | string;
  /** Fired on the very first touch of a session. Used to grab fullscreen. */
  onFirstTouch?: () => void;
}) {
  const [stick, setStick] = useState<{ x: number; y: number; dx: number } | null>(null);
  const [jumping, setJumping] = useState(false);
  const [hint, setHint] = useState(true);

  const movePointer = useRef<number | null>(null);
  const jumpPointer = useRef<number | null>(null);
  const originX = useRef(0);
  const touched = useRef(false);

  // One second, then it fades. Long enough to read, short enough that it is not
  // in the way of the first jump.
  useEffect(() => {
    setHint(true);
    const id = window.setTimeout(() => setHint(false), 1000);
    return () => window.clearTimeout(id);
  }, [hintKey]);

  const clearMove = useCallback(() => {
    keys.current.delete(bind.left);
    keys.current.delete(bind.right);
  }, [keys, bind]);

  // A key stuck down because a pointer was lost is worse than a missed input:
  // the character runs into a hazard on its own.
  useEffect(() => {
    const panic = () => {
      clearMove();
      keys.current.delete(bind.jump);
      movePointer.current = null;
      jumpPointer.current = null;
      setStick(null);
      setJumping(false);
    };
    window.addEventListener('blur', panic);
    document.addEventListener('visibilitychange', panic);
    return () => {
      panic();
      window.removeEventListener('blur', panic);
      document.removeEventListener('visibilitychange', panic);
    };
  }, [clearMove, keys, bind]);

  const first = () => {
    if (touched.current) return;
    touched.current = true;
    onFirstTouch?.();
  };

  // ── move ────────────────────────────────────────────────────────────────
  const moveDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (movePointer.current !== null) return;
    e.preventDefault();
    first();
    movePointer.current = e.pointerId;
    // Capture, so a thumb that slides into the jump half keeps steering rather
    // than silently detaching.
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    originX.current = e.clientX;
    setStick({ x: e.clientX - rect.left, y: e.clientY - rect.top, dx: 0 });
  };

  const moveMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (movePointer.current !== e.pointerId) return;
    const raw = e.clientX - originX.current;
    const dx = Math.max(-RADIUS, Math.min(RADIUS, raw));
    setStick((s) => (s ? { ...s, dx } : s));

    const t = dx / RADIUS;
    keys.current.delete(bind.left);
    keys.current.delete(bind.right);
    if (t <= -DEAD_ZONE) keys.current.add(bind.left);
    else if (t >= DEAD_ZONE) keys.current.add(bind.right);
  };

  const moveUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (movePointer.current !== e.pointerId) return;
    movePointer.current = null;
    clearMove();
    setStick(null);
  };

  // ── jump ────────────────────────────────────────────────────────────────
  const jumpDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (jumpPointer.current !== null) return;
    e.preventDefault();
    first();
    jumpPointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Held rather than pulsed: the engine reads the key every frame, so holding
    // gives the longer jump a player expects from holding the button.
    keys.current.add(bind.jump);
    setJumping(true);
  };

  const jumpUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (jumpPointer.current !== e.pointerId) return;
    jumpPointer.current = null;
    keys.current.delete(bind.jump);
    setJumping(false);
  };

  const zone = 'absolute bottom-0 w-1/2 touch-none select-none';

  return (
    <div className="pointer-events-none absolute inset-0 z-40" style={{ top: 0 }}>
      {/* ── left: steer ── */}
      <div
        className={`${zone} left-0 pointer-events-auto`}
        style={{ top: HUD_STRIP }}
        onPointerDown={moveDown}
        onPointerMove={moveMove}
        onPointerUp={moveUp}
        onPointerCancel={moveUp}
      >
        {stick && (
          <>
            <div
              className="pointer-events-none absolute rounded-full border-2 border-white/40 bg-white/5 backdrop-blur-sm"
              style={{
                width: RADIUS * 2,
                height: RADIUS * 2,
                left: stick.x - RADIUS,
                top: stick.y - RADIUS,
              }}
            />
            <div
              className="pointer-events-none absolute rounded-full bg-white/70 shadow-lg"
              style={{
                width: RADIUS,
                height: RADIUS,
                left: stick.x + stick.dx - RADIUS / 2,
                top: stick.y - RADIUS / 2,
              }}
            />
          </>
        )}
      </div>

      {/* ── right: jump ── */}
      <div
        className={`${zone} right-0 pointer-events-auto transition-colors ${
          jumping ? 'bg-white/10' : 'bg-transparent'
        }`}
        style={{ top: HUD_STRIP }}
        onPointerDown={jumpDown}
        onPointerUp={jumpUp}
        onPointerCancel={jumpUp}
      />

      {/* ── the one-second hint ── */}
      {/* Inline opacity rather than Tailwind's `opacity-0`: the utility was not
          being emitted for this file, so the hint applied the class and stayed
          fully visible for the rest of the level. A one-off fade does not need
          the framework anyway. */}
      <div
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
        style={{
          top: HUD_STRIP,
          opacity: hint ? 1 : 0,
          transition: 'opacity 500ms ease-out',
        }}
      >
        <div className="flex w-full items-center justify-around px-6 text-center">
          <div className="rounded-2xl border border-white/15 bg-black/55 px-4 py-3 backdrop-blur-sm">
            <div className="text-2xl leading-none">↔</div>
            <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-white/70">
              drag to move
            </div>
          </div>
          <div className="rounded-2xl border border-white/15 bg-black/55 px-4 py-3 backdrop-blur-sm">
            <div className="text-2xl leading-none">↑</div>
            <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-white/70">
              tap to jump
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
