
import { create } from 'zustand';
import { User } from 'firebase/auth';

// Bilal Saeed 123
interface AuthState {
  user: User | null;
  loading: boolean;
  stats: any;
  statsFetchedAt: number;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  setStats: (stats: any) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  stats: null,
  statsFetchedAt: 0,
  setUser: (user) => set({ user }),
  setLoading: (loading) => set({ loading }),
  setStats: (stats) => set({ stats, statsFetchedAt: Date.now() }),
}));
// Bilal Saeed 123

