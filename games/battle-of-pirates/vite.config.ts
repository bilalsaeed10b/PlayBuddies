import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative base so the bundle works under any deploy prefix, including the
  // /PlayBuddies/ path GitHub Pages serves from.
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  build: {
    // A cheap phone parses every byte of this on the critical path, so the
    // vendor code is split off and the Firebase SDK is only ever reached
    // through a dynamic import (see App.tsx) — an offline match never fetches
    // it at all.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/database'],
        },
      },
    },
  },
});
