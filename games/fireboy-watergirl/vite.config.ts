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
    // The editor is lazy-loaded, so raise the warning bar for the remaining
    // vendor chunks rather than muting a genuinely useful warning.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          // Split so a game-code change doesn't invalidate the cached vendor
          // bundles, and so the two load in parallel.
          react: ['react', 'react-dom'],
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/database'],
        },
      },
    },
  },
});
