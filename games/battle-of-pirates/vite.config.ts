import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { logPlugin } from '../_shared/log/vitePlugin';

export default defineConfig({
  // One combined log file for every game's dev server -- see
  // games/_shared/log. Dev-only: logPlugin's middleware never exists
  // in a production build.
  plugins: [
    react(),
    tailwindcss(),
    // Collects log batches while running this one game's dev server. The LAN
    // host (scripts/serve.mjs) mounts the same collector, so a playtest on
    // real phones lands in the same place -- see games/_shared/log/.
    logPlugin(path.resolve(__dirname, `../../dev-logs/session-${new Date().toISOString().slice(0, 10)}.ndjson`)),
  ],
  // Relative base so the bundle works under any deploy prefix, including the
  // /PlayBuddies/ path GitHub Pages serves from.
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // games/_shared/ — code every game imports rather than keeps its own
      // copy of. Pinning react/react-dom here too: without it, a bare import
      // from inside _shared (which has no node_modules of its own) would
      // resolve up to the repo root's copy instead of this game's own,
      // landing two different React instances in one bundle.
      '@shared': path.resolve(__dirname, '../_shared'),
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
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
