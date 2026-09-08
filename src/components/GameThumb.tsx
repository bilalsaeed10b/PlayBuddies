import type { GameMetadata } from "@/types/game";
import { gameThumbnail } from "@/lib/games";

/**
 * A game's artwork. Plain <img> because next/image is unavailable under
 * output:"export" with unoptimized images — the thumbnails are pre-sized by
 * scripts/build-games.mjs instead.
 */
export default function GameThumb({
  game,
  className = "",
  size = 96,
}: {
  game: GameMetadata;
  className?: string;
  size?: number;
}) {
  return (
    <img
      src={gameThumbnail(game)}
      alt={game.name}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`object-cover ${className}`}
    />
  );
}
