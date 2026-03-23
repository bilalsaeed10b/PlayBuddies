// Bilal Saeed xxxxx
import { create } from "zustand";
import type { GameState, Fish, GameMode } from "../types";

interface GameStore extends GameState {
  setRoomId: (id: string) => void;
  setIsHost: (isHost: boolean) => void;
  setMode: (mode: GameMode) => void;
  updatePlayer: (id: string, data: Partial<Fish>) => void;
  setPlayers: (players: Record<string, Fish>) => void;
  setEnemies: (enemies: Fish[]) => void;
  setStatus: (status: "waiting" | "playing" | "gameover") => void;
}

export const useGameStore = create<GameStore>((set) => ({
  players: {},
  enemies: [],
  mode: "casual",
  status: "waiting",
  roomId: "",
  isHost: false,

  setRoomId: (roomId) => set({ roomId }),
  setIsHost: (isHost) => set({ isHost }),
  setMode: (mode) => set({ mode }),
  updatePlayer: (id, data) => 
    set((state) => ({
      players: {
        ...state.players,
        [id]: { ...state.players[id], ...data }
      }
    })),
  setPlayers: (players) => set({ players }),
  setEnemies: (enemies) => set({ enemies }),
  setStatus: (status) => set({ status }),
}));
// Bilal Saeed xxxxx
