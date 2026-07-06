/**
 * Vitest config for the admin console — jsdom environment + Testing Library
 * setup, with the Vite React + Tailwind plugins so components compile the
 * same way they do in dev.
 */

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
