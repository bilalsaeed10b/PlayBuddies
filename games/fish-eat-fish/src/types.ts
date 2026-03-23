// Bilal Saeed xxxxx
export type GameMode = "casual" | "competitive";

export interface Fish {
  id: string;
  x: number;
  y: number;
  radius: number;
  angle: number;
  speed: number;
  color: string;
  type: "player" | "enemy";
  isDead: boolean;
  score: number;
  displayName?: string;
  photoURL?: string;
  isLocal?: boolean;
}

export interface GameState {
  players: Record<string, Fish>;
  enemies: Fish[];
  mode: GameMode;
  status: "waiting" | "playing" | "gameover";
  roomId: string;
  isHost: boolean;
}
// Bilal Saeed xxxxx
