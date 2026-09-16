/**
 * A message over a player's head, pawn, ship or paddle , wanted-board's own
 * taunt bubble, generalized once so every game gets the same one instead of
 * each hand-rolling its own animation and tail.
 *
 * This only draws itself at the `style` it's given (typically `left`/`top`,
 * in px or in %); it has no opinion on coordinate systems. That's what lets
 * the identical component sit above a DOM token positioned in percent and a
 * canvas ship positioned in camera-projected pixels , the caller already did
 * the one part that's different in every game.
 */
import { useEffect } from 'react';
import type { CSSProperties } from 'react';

const LIFETIME_MS = 4500;
export { LIFETIME_MS as SPEECH_BUBBLE_LIFETIME_MS };

let styleInjected = false;
function ensureStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
@keyframes pb-bubble-pop {
  0% { transform: scale(0.85); opacity: 0; }
  10% { transform: scale(1); opacity: 1; }
  82% { transform: scale(1); opacity: 1; }
  100% { transform: scale(0.94) translateY(-6px); opacity: 0; }
}
.pb-speech-bubble-box {
  background-color: #ffffff !important;
  color: #000000 !important;
  border: 1px solid rgba(0, 0, 0, 0.18) !important;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28), 0 1px 3px rgba(0, 0, 0, 0.15) !important;
}
.pb-speech-bubble-tail {
  background-color: #ffffff !important;
  border-right: 1px solid rgba(0, 0, 0, 0.18) !important;
  border-bottom: 1px solid rgba(0, 0, 0, 0.18) !important;
}
`;
  document.head.appendChild(style);
}

export function SpeechBubble({
  text,
  style,
  className = '',
}: {
  text: string;
  /** Anchors the bubble's tail to the speaker , usually `{ left, top }`. */
  style: CSSProperties;
  className?: string;
}) {
  useEffect(ensureStyle, []);
  return (
    <div
      className="pointer-events-none absolute z-40 -translate-x-1/2 -translate-y-full"
      style={style}
    >
      <span
        // Keyed so React replaces rather than reuses the node when the text
        // changes , a second message while the first is still fading must
        // restart the pop-in, not jump-cut mid-fade-out.
        key={text}
        className={`pb-speech-bubble-box relative block w-max max-w-[50vw] rounded-2xl px-3 py-1.5 text-[11px] font-bold leading-tight shadow-lg sm:max-w-[220px] sm:text-xs ${className}`}
        style={{
          backgroundColor: '#ffffff',
          color: '#000000',
          border: '1px solid rgba(0, 0, 0, 0.18)',
          boxShadow: '0 4px 14px rgba(0, 0, 0, 0.28), 0 1px 3px rgba(0, 0, 0, 0.15)',
          animation: `pb-bubble-pop ${LIFETIME_MS}ms ease-out forwards`,
          transformOrigin: 'bottom center',
        }}
      >
        {text}
        <span
          className="pb-speech-bubble-tail absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45"
          style={{
            backgroundColor: '#ffffff',
            borderRight: '1px solid rgba(0, 0, 0, 0.18)',
            borderBottom: '1px solid rgba(0, 0, 0, 0.18)',
          }}
        />
      </span>
    </div>
  );
}
