/**
 * One player's chalk head.
 *
 * Every stroke comes from game/faces.ts so this and the shop grid cannot
 * drift apart — a skin that looks like a different skin in two places is not
 * a skin.
 */
import { browPath, extraPath, faceAt, mouthPath } from '../game/faces';

export default function FaceToken({
  skin,
  size = 32,
  /** The seat colour, drawn as the ring. Distinct from the face's own ink. */
  ring,
  /** Locked out of the round: drawn dim and struck through. */
  out,
}: {
  skin: number;
  size?: number;
  ring?: string;
  out?: boolean;
}) {
  const face = faceAt(skin);
  const brow = browPath(face.brow);
  const extra = extraPath(face.extra);
  const filled = face.mouth === 'open';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={out ? 'opacity-50' : undefined}
      role="img"
      aria-label={face.name}
    >
      {ring && <circle cx="12" cy="12" r="11.2" fill="none" stroke={ring} strokeWidth="1.6" opacity="0.9" />}
      <circle cx="12" cy="12" r="8.5" fill="rgba(15,23,42,0.85)" stroke={face.ink} strokeWidth="1.4" />
      <g stroke={face.ink} strokeWidth="1.3" strokeLinecap="round" fill="none">
        {face.extra !== 'shades' && (
          <>
            <circle cx="9.6" cy="11.6" r="0.9" fill={face.ink} stroke="none" />
            <circle cx="14.4" cy="11.6" r="0.9" fill={face.ink} stroke="none" />
          </>
        )}
        {brow && <path d={brow} />}
        <path d={mouthPath(face.mouth)} fill={filled ? face.ink : 'none'} />
        {extra && <path d={extra} />}
      </g>
      {out && (
        <path d="M 4 4 L 20 20" stroke="#fb7185" strokeWidth="1.8" strokeLinecap="round" opacity="0.85" />
      )}
    </svg>
  );
}
