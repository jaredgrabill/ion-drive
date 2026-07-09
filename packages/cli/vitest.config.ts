/**
 * Vitest configuration for the CLI's unit tests.
 *
 * Integration tests (`src/**\/*.integration.test.ts`, spec-06) shell the CLI
 * against a real Postgres and are excluded here — run them separately with
 * `pnpm --filter @ion-drive/cli test:integration`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // __fixtures__ carries whole fixture *blocks* whose test/ files run under
    // node:test inside `block test` itself — never as vitest suites.
    exclude: [
      'src/**/*.integration.test.ts',
      'src/**/__fixtures__/**',
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
});
