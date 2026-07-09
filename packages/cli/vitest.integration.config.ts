/**
 * Vitest configuration for the CLI's integration tests (spec-06).
 *
 * These shell `ion-drive block test` (via tsx over `src/index.ts`) against a
 * real PostgreSQL — each run boots an ephemeral Ion Drive server on a scratch
 * database, so the timeouts are generous and files run serially (every test
 * file owns real ports/databases). Requirements match the core suite:
 * a reachable Postgres at `ION_DATABASE_URL` (default
 * `postgresql://ion:ion@localhost:5432/ion_drive`) and a built
 * `@ion-drive/core` (`pnpm --filter @ion-drive/core build`).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    exclude: ['src/**/__fixtures__/**', '**/node_modules/**', '**/dist/**'],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
