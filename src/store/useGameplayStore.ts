import { create } from 'zustand';

/**
 * Whether a game is actually on screen right now, not just "in the lobby".
 *
 * `FriendsSidebar` is mounted globally and only knows its own pathname, which
 * never changes when a lobby goes from "picking a game" to "playing one" --
 * both are `/lobby`. On a phone the game's own iframe already fills almost
 * the whole screen at that point, and the floating Friends pill plus the
 * lobby's own chat/roster toggle stacked in the same corner were two more
 * large tap targets competing with the game's own UI for the same handful of
 * pixels at the bottom of the screen. The lobby page is the only thing that
 * knows when that's true, so it sets this and everything else just reads it.
 */
interface GameplayState {
  isPlaying: boolean;
  setIsPlaying: (isPlaying: boolean) => void;
}

export const useGameplayStore = create<GameplayState>((set) => ({
  isPlaying: false,
  setIsPlaying: (isPlaying) => set({ isPlaying }),
}));
