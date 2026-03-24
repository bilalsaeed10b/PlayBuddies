
import { create } from 'zustand';
import { User } from 'firebase/auth';

interface AuthState {
  user: User | null;
  loading: boolean;
  stats: { friendsOnline: number; gamesPlayed: number; winRate: string } | null;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  setStats: (stats: { friendsOnline: number; gamesPlayed: number; winRate: string } | null) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  stats: null,
  setUser: (user) => set({ user }),
  setLoading: (loading) => set({ loading }),
  setStats: (stats) => set({ stats }),
}));

