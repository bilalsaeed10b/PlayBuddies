/**
 * One outlaw, as a token.
 *
 * The same component draws the piece on the map and the portrait in the shop,
 * so a player picks a silhouette and then sees exactly that silhouette on the
 * board. Two near-copies of this is the standard way that stops being true.
 */
import { hatPath, outlawAt } from '../game/outlaws';

export default function OutlawToken({
  skin,
  size = 44,
  ring,
  dimmed,
  hidden,
}: {
  skin: number;
  size?: number;
  /** Seat colour, drawn as the band around the token. Omit in the shop. */
  ring?: string;
  /** Out of the running — drawn back so the live pieces read first. */
  dimmed?: boolean;
  /** Laying low: shown as a ghost, because that is exactly what the rules say they are. */
  hidden?: boolean;
}) {
  const outlaw = outlawAt(skin);
  const hat = hatPath(outlaw.hat);

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      style={{ opacity: dimmed ? 0.4 : hidden ? 0.55 : 1 }}
    >
      {ring && (
        <circle cx="12" cy="12" r="11.2" fill={ring} stroke="rgba(0,0,0,0.25)" strokeWidth="0.7" />
      )}
      {/* Shoulders, clipped to the token so a coat never spills past the ring. */}
      <clipPath id={`clip-${skin}-${ring ?? 'plain'}`}>
        <circle cx="12" cy="12" r={ring ? 10.4 : 11.6} />
      </clipPath>
      <g clipPath={`url(#clip-${skin}-${ring ?? 'plain'})`}>
        <circle cx="12" cy="12" r={ring ? 10.4 : 11.6} fill={ring ? 'rgba(0,0,0,0.18)' : 'rgba(15,23,42,0.08)'} />
        <path d="M2 24 Q2 16.4 12 16.4 Q22 16.4 22 24 Z" fill={outlaw.coat} />
        {/* Head, then the scarf over the lower half of it. */}
        <circle cx="12" cy="12.6" r="5.4" fill="#f0d3b4" />
        <path d="M6.8 13.4 Q12 12.2 17.2 13.4 Q17.2 18.4 12 18.4 Q6.8 18.4 6.8 13.4 Z" fill={outlaw.scarf} />
        {/* Eyes, the only detail that survives at token size. */}
        <circle cx="9.9" cy="11.4" r="0.85" fill="#1f2937" />
        <circle cx="14.1" cy="11.4" r="0.85" fill="#1f2937" />
        {hat && <path d={hat} fill={outlaw.trim} />}
      </g>
      {hidden && (
        /* A dashed outline rather than just lower opacity: "you cannot touch
           this one" has to survive being seen at 32px on a phone in daylight. */
        <circle
          cx="12"
          cy="12"
          r="11.2"
          fill="none"
          stroke="#fff"
          strokeWidth="1.4"
          strokeDasharray="2 2"
          opacity="0.9"
        />
      )}
    </svg>
  );
}
