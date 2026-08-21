import { create } from 'zustand';
import { User } from 'firebase/auth';

export interface UserStats {
  gamesPlayed: number;
  winRate: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  stats: UserStats | null;
  statsFetchedAt: number;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  setStats: (stats: UserStats) => void;
  /** Drop the cache so the next dashboard visit reads fresh counters. */
  clearStats: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  stats: null,
  statsFetchedAt: 0,
  setUser: (user) => set({ user }),
  setLoading: (loading) => set({ loading }),
  setStats: (stats) => set({ stats, statsFetchedAt: Date.now() }),
  clearStats: () => set({ stats: null, statsFetchedAt: 0 }),
}));

