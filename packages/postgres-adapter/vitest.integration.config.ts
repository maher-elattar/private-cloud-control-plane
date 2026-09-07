import { defineConfig } from 'vitest/config';

/**
 * Integration suite for the PostgreSQL stores.
 *
 * Separate from `vite.config.ts` so `pnpm run test` stays fast and container-free. This config is
 * driven by the `test-integration` Nx target, which starts `deploy/local/compose.test.yaml` through
 * the global setup below.
 */
export default defineConfig({
  test: {
    name: 'postgres-adapter-integration',
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    globalSetup: ['../../tools/testing/integration-stack.mjs'],
    // Container start plus migrations dominates the first run; individual cases are fast.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // The suites share one database, so they must not race each other for the same rows.
    fileParallelism: false,
  },
});
