/**
 * The stickman, drawn one line at a time.
 *
 * SVG rather than canvas: the whole animation budget here is "one more stroke
 * appears every twenty seconds", and a stroke-dash transition does that for
 * free at the display's own refresh rate, stays sharp on any phone, and needs
 * nobody to think about device pixel ratios.
 *
 * The frame — posts and beam — is always there, faint. Only the eight pieces
 * a wrong guess buys are drawn in full chalk, so the gap between "how bad is
 * it" and "how bad can it get" is visible at a glance from across a room.
 */
import { PIECES } from '../game/rules';

/**
 * The stroke that appears at each wrong guess, in order.
 *
 * The traditional six, and the rope is not among them — an empty noose is
 * part of the frame below, hanging there from the first turn. It costs
 * nothing to draw and it is the most ominous thing on the board, which is
 * exactly the wrong thing to hold back until somebody has already lost.
 */
const PARTS: { d: string; circle?: [number, number, number] }[] = [
  { d: '', circle: [100, 60, 14] }, //                 0 head
  { d: 'M 100 74 L 100 122' }, //                      1 body
  { d: 'M 100 86 L 74 108' }, //                       2 left arm
  { d: 'M 100 86 L 126 108' }, //                      3 right arm
  { d: 'M 100 122 L 78 158' }, //                      4 left leg
  { d: 'M 100 122 L 122 158' }, //                     5 right leg
];

export default function Gallows({
  pieces,
  /** Flashes the newest stroke. Passed the piece index that just landed. */
  latest,
  className = '',
}: {
  pieces: number;
  latest?: number;
  className?: string;
}) {
  const doomed = pieces >= PIECES;
  const chalk = doomed ? '#fb7185' : '#f8fafc';

  return (
    <svg
      viewBox="0 0 200 190"
      className={className}
      role="img"
      aria-label={
        doomed ? 'The stickman is finished.' : `Stickman: ${pieces} of ${PIECES} lines drawn.`
      }
    >
      {/* The frame. Always present, always faint — it is the stage, not the
          score, and drawing it piece by piece would waste the tension on
          scenery nobody is afraid of. */}
      <g stroke="#64748b" strokeWidth="4" strokeLinecap="round" opacity="0.45" fill="none">
        <path d="M 22 178 L 78 178" />
        <path d="M 50 178 L 50 18" />
        <path d="M 50 18 L 100 18" />
        <path d="M 50 40 L 72 18" />
        {/* The noose, empty and waiting. */}
        <path d="M 100 18 L 100 46" />
      </g>

      <g
        stroke={chalk}
        strokeWidth="4.5"
        strokeLinecap="round"
        fill="none"
        style={{ transition: 'stroke 400ms ease' }}
      >
        {PARTS.map((part, i) => {
          if (i >= pieces) return null;
          const isNew = latest === i;
          const style = {
            animation: isNew ? 'draw 420ms ease-out' : undefined,
          } as React.CSSProperties;
          if (part.circle) {
            const [cx, cy, r] = part.circle;
            return <circle key={i} cx={cx} cy={cy} r={r} style={style} />;
          }
          if (!part.d) return null;
          return <path key={i} d={part.d} style={style} />;
        })}

        {/* The face. Not a piece anybody pays for — it arrives on its own the
            moment the last limb lands, so the drawing that has been a diagram
            all round suddenly becomes a person. That is the beat this game is
            built to land, and charging a turn for it would spend it early. */}
        {doomed && (
          <g style={{ animation: 'draw 420ms ease-out' }} strokeWidth="3">
            <path d="M 92 55 L 98 61 M 98 55 L 92 61" />
            <path d="M 102 55 L 108 61 M 108 55 L 102 61" />
            <path d="M 92 69 Q 100 63 108 69" />
          </g>
        )}
      </g>
    </svg>
  );
}
