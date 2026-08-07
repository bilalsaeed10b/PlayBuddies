/** Shape of every games/<id>/game.json. Validated at build time by scripts/build-games.mjs. */
export interface GameMetadata {
  id: string;
  name: string;
  subtitle?: string;
  description: string;
  category: "puzzle" | "action" | "strategy" | "trivia" | "party";
  minPlayers: number;
  maxPlayers: number;
  estimatedDuration?: string;
  controls?: string;
  /** Filename inside games/<id>/, published alongside the bundle. */
  thumbnail?: string;
  accent?: { from: string; to: string };
  featured?: boolean;
  available?: boolean;
  version?: string;
}

export type LobbyStatus = "waiting" | "playing" | "completed";

export interface LobbyPlayer {
  uid: string;
  displayName: string;
  photoURL: string;
  isReady: boolean;
  role?: "fire" | "water" | null;
  joinedAt?: number;
}

export interface Lobby {
  hostId: string;
  gameId: string | null;
  status: LobbyStatus;
  players: Record<string, LobbyPlayer>;
  matchStarted?: boolean;
  collectedGems?: Record<string, boolean>;
  level?: number;
  createdAt?: unknown;
  expiresAt?: unknown;
}

export interface LobbyMessage {
  id: string;
  uid: string;
  displayName: string;
  text: string;
  createdAt: number;
}
