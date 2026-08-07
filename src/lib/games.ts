import type { GameMetadata } from "@/types/game";
import { GENERATED_GAMES } from "./games.generated";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

/**
 * The game catalog. Generated from games/<id>/game.json at build time — to add
 * or change a game, edit its game.json and run `npm run build:games`.
 */
export const GAMES: GameMetadata[] = GENERATED_GAMES;

export const PLAYABLE_GAMES = GAMES.filter((g) => g.available !== false);

export function getGame(id: string | null | undefined): GameMetadata | undefined {
  if (!id) return undefined;
  return GAMES.find((g) => g.id === id);
}

/** Public URL of a game's thumbnail. */
export function gameThumbnail(game: GameMetadata): string {
  if (!game.thumbnail) return `${BASE}/placeholder-game.svg`;
  return `${BASE}/g/${game.id}/${game.thumbnail}`;
}

/** Entry point of a game's built bundle, with the platform handoff in the query. */
export function gameUrl(
  gameId: string,
  params: { room: string; displayName?: string; photoURL?: string },
): string {
  const q = new URLSearchParams({ room: params.room });
  if (params.displayName) q.set("displayName", params.displayName);
  if (params.photoURL) q.set("photoURL", params.photoURL);
  return `${BASE}/g/${gameId}/index.html?${q.toString()}`;
}

const DEFAULT_ACCENT = { from: "#8B5CF6", to: "#EC4899" };

/** Brand colours for a game card, falling back to the platform gradient. */
export function gameAccent(game: GameMetadata): { from: string; to: string } {
  return game.accent ?? DEFAULT_ACCENT;
}

/** "2" for fixed-size games, "2-4" for ranges. */
export function playerCountLabel(game: GameMetadata): string {
  return game.minPlayers === game.maxPlayers
    ? String(game.minPlayers)
    : `${game.minPlayers}-${game.maxPlayers}`;
}
