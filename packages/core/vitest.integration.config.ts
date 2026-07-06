/**
 * Vitest configuration for integration tests.
 *
 * Integration tests (`src/**\/*.integration.test.ts`) exercise the platform
 * against a real PostgreSQL instance (see `docker/docker-compose.yml` for the
 * dev database, or the `integration` job in `.github/workflows/ci.yml` for CI).
 * They are excluded from the default unit-test run (`vitest.config.ts`) and
 * executed separately via `pnpm test:integration`.
 *
 * The `graphql` alias pins every vite-processed import of `graphql` to the
 * same CJS entry that Node hands externalized packages (graphql-yoga et al.).
 * Without it, vite-node loads the ESM build for our source while yoga gets
 * the CJS build — two module realms — and every GraphQL request fails with
 * "Cannot use GraphQLSchema from another module or realm".
 */
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: { graphql: require.resolve('graphql/index.js') },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30_000,
  },
});
