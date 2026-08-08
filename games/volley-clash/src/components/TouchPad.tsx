import { useEffect, useRef, useState } from 'react';

/**
 * The whole screen is the controller — the same scheme Neon Elements uses, so
 * one PlayBuddies game teaches you how to hold the next one.
 *
 * Left half: touch anywhere and drag; the stick appears under your thumb and
 * steers left/right. Right half: tap to jump, hold for a slightly bigger one.
 *
 * This replaced a joystick pinned to the left half plus a jump button in the
 * corner, where the button was a fixed target you had to find. Zones cost no
 * layout and no aiming.
 */

/** Thumb travel, in CSS pixels, that counts as full deflection. */
const RADIUS = 56;
/** Below this fraction the stick reads as centred, so a resting thumb doesn't creep. */
const DEAD_ZONE = 0.22;
/** Reserved at the top so the scoreboard and the HUD buttons stay tappable. */
const HUD_STRIP = 64;

export interface PadState {
  left: boolean;
  right: boolean;
  jump: boolean;
}

export default function TouchPad({
  state,
  hintKey,
  onFirstTouch,
}: {
  /** Written every pointer event and read by the render loop. Never re-renders. */
  state: React.MutableRefObject<PadState>;
  /** Changing this replays the one-second hint. */
  hintKey: number | string;
  onFirstTouch?: () => void;
}) {
  const [stick, setStick] = useState<{ x: number; y: number; dx: number } | null>(null);
  const [jumping, setJumping] = useState(false);
  const [hint, setHint] = useState(true);

  const movePointer = useRef<number | null>(null);
  const jumpPointer = useRef<number | null>(null);
  const originX = useRef(0);
  const touched = useRef(false);

  useEffect(() => {
    setHint(true);
    const id = window.setTimeout(() => setHint(false), 1000);
    return () => window.clearTimeout(id);
  }, [hintKey]);

  // A direction stuck on because a pointer was lost is worse than a dropped
  // input: the character walks into the net on its own.
  useEffect(() => {
    const panic = () => {
      state.current = { left: false, right: false, jump: false };
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
  }, [state]);

  const first = () => {
    if (touched.current) return;
    touched.current = true;
    onFirstTouch?.();
  };

  const moveDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (movePointer.current !== null) return;
    e.preventDefault();
    first();
    movePointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    originX.current = e.clientX;
    setStick({ x: e.clientX - rect.left, y: e.clientY - rect.top, dx: 0 });
  };

  const moveMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (movePointer.current !== e.pointerId) return;
    const dx = Math.max(-RADIUS, Math.min(RADIUS, e.clientX - originX.current));
    setStick((s) => (s ? { ...s, dx } : s));
    const t = dx / RADIUS;
    state.current.left = t <= -DEAD_ZONE;
    state.current.right = t >= DEAD_ZONE;
  };

  const moveUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (movePointer.current !== e.pointerId) return;
    movePointer.current = null;
    state.current.left = false;
    state.current.right = false;
    setStick(null);
  };

  const jumpDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (jumpPointer.current !== null) return;
    e.preventDefault();
    first();
    jumpPointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Held, not pulsed: the engine reads it every frame, so holding gives the
    // taller jump that a held key gives on a keyboard.
    state.current.jump = true;
    setJumping(true);
  };

  const jumpUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (jumpPointer.current !== e.pointerId) return;
    jumpPointer.current = null;
    state.current.jump = false;
    setJumping(false);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <div
        className="pointer-events-auto absolute bottom-0 left-0 w-1/2 touch-none select-none"
        style={{ top: HUD_STRIP }}
        onPointerDown={moveDown}
        onPointerMove={moveMove}
        onPointerUp={moveUp}
        onPointerCancel={moveUp}
      >
        {stick && (
          <>
            <div
              className="pointer-events-none absolute rounded-full border-2 border-white/40 bg-white/5"
              style={{ width: RADIUS * 2, height: RADIUS * 2, left: stick.x - RADIUS, top: stick.y - RADIUS }}
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

      <div
        className="pointer-events-auto absolute bottom-0 right-0 w-1/2 touch-none select-none"
        style={{ top: HUD_STRIP, background: jumping ? 'rgba(255,255,255,0.08)' : 'transparent' }}
        onPointerDown={jumpDown}
        onPointerUp={jumpUp}
        onPointerCancel={jumpUp}
      />

      {/* One second, then it fades. Inline opacity rather than a utility class,
          because the class was not always emitted and the hint then sat there
          for the whole match. */}
      <div
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
        style={{ top: HUD_STRIP, opacity: hint ? 1 : 0, transition: 'opacity 500ms ease-out' }}
      >
        <div className="flex w-full items-center justify-around px-6 text-center">
          <div className="rounded-2xl border border-white/15 bg-black/55 px-4 py-3">
            <div className="text-2xl leading-none">↔</div>
            <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-white/70">
              drag to move
            </div>
          </div>
          <div className="rounded-2xl border border-white/15 bg-black/55 px-4 py-3">
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
