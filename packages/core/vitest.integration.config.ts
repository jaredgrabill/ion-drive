/**
 * Vitest configuration for integration tests.
 *
 * Integration tests (`src/**\/*.integration.test.ts`) exercise the platform
 * against a real PostgreSQL instance (see `docker/docker-compose.yml` for the
 * dev database, or the `integration` job in `.github/workflows/ci.yml` for CI).
 * They are excluded from the default unit-test run (`vitest.config.ts`) and
 * executed separately via `pnpm test:integration`.
 *
 * `passWithNoTests` is set because no integration tests exist yet — Phase 11
 * (see `docs/roadmap.md`) will add them; until then the script must exit 0.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    passWithNoTests: true,
    testTimeout: 30_000,
  },
});
