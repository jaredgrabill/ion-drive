import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev proxy target — override with ION_API_URL to point the admin at a
// non-default core server (e.g. a smoke-test instance).
const apiTarget = process.env.ION_API_URL ?? 'http://localhost:3000';

export default defineConfig({
  // The console is served by core at /admin (Phase 14 framework mode); the
  // Vite dev server mirrors that path so dev and production share one base.
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3001,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/health': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
