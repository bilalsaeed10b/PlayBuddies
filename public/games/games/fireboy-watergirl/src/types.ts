export interface Vector {
  x: number;
  y: number;
}

export interface Entity {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'platform' | 'hazard' | 'box' | 'lever' | 'button' | 'door' | 'pressure-plate' | 'moving-platform' | 'gem' | 'cannon';
  shape?: 'rect' | 'circle' | 'triangle';
  color?: string;
  hazardType?: 'fire' | 'water' | 'acid';
  active?: boolean;
  targetId?: string; // For buttons/levers to trigger
  vx?: number;
  vy?: number;
  startPos?: Vector;
  endPos?: Vector;
  speed?: number;
  patrol?: boolean;
  collected?: boolean;
  locked?: boolean;
  hidden?: boolean;
  rotation?: number; // in degrees
  rotating?: boolean;
  rotationSpeed?: number;
  fireRate?: number; // For cannons (ms)
  projectileSpeed?: number; // For cannons
  cannonType?: 'fireball' | 'laser'; // For cannons
  laserEnd?: Vector; // For laser cannons
  plateType?: 'momentary' | 'toggle'; // For pressure plates
}

export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  role: 'fire' | 'water';
  isGrounded: boolean;
  isDead: boolean;
  atDoor: boolean;
  // Animation state
  animFrame: number;
  animState: 'idle' | 'run' | 'jump';
  facing: 'left' | 'right';
  score: number;
}

export interface LobbyPlayer {
  id: string;
  role: 'fire' | 'water' | null;
  ready: boolean;
  isHost: boolean;
}

export interface LobbyState {
  roomId: string;
  players: Record<string, LobbyPlayer>;
  levelIndex: number;
  status: 'lobby' | 'playing';
}

export interface Level {
  id: number;
  name: string;
  entities: Entity[];
  fireStart: Vector;
  waterStart: Vector;
  worldSettings?: {
    darkMode: boolean;
    lightRadius: number;
    gravityMultiplier?: number;
    speedMultiplier?: number;
    jumpMultiplier?: number;
    windX?: number;
    windY?: number;
    backgroundTheme?: 'default' | 'neon' | 'void' | 'matrix' | 'cyberpunk' | 'sunset' | 'nebula' | 'glitch' | 'underwater';
    timeScale?: number;
    bloomIntensity?: number;
    particleDensity?: number;
    screenShake?: number;
    mirrorWorld?: boolean;
    invertColors?: boolean;
    pixelate?: number;
    chaosMode?: boolean;
  };
}
