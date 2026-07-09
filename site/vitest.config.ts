/**
 * Vitest config for the site — the admin console's rig pattern: jsdom +
 * Testing Library with the Vite React plugin so the island components compile
 * the same way they do in the Astro build. Script tests (docs curation,
 * schema emission) run in the same environment; they only touch node:fs.
 */

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
  },
});
