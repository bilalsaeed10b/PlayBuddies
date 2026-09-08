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
  /**
   * Written by the game, not the platform: Fish Eat Fish uses `fishIndex`.
   *
   * `role` was Neon Elements' fire/water pick. That game is gone, and
   * Battle of Pirates has since claimed the field for its hull class — a
   * number, not one of the two strings below. The platform never reads
   * either; both are here because firestore.rules names them as writable by
   * their owner, which is what makes this the only spare per-player slot a
   * game can take without a rules change.
   */
  role?: "fire" | "water" | number | null;
  fishIndex?: number;
  joinedAt?: number;
}

export interface Lobby {
  hostId: string;
  gameId: string | null;
  status: LobbyStatus;
  players: Record<string, LobbyPlayer>;
  matchStarted?: boolean;
  /** Set when the match starts; the game runs local co-op instead of waiting for a peer. */
  soloMode?: boolean;
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
