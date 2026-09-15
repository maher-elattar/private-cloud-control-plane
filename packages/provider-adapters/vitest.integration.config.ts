import { defineConfig } from 'vitest/config';

/**
 * Integration suite for the Terraform runner.
 *
 * Separate from `vite.config.ts` for the same reason the PostgreSQL one is: `pnpm run test` stays
 * fast and container-free. What lives here needs a **real** `terraform` binary and a **real** `pg`
 * state backend, because the property under test is what happens to a state lock when the process
 * holding it is killed — and a stub cannot lose a lock it never took.
 */
export default defineConfig({
  test: {
    name: 'provider-adapters-integration',
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    globalSetup: ['../../tools/testing/integration-stack.mjs'],
    // A real apply plus a deliberate kill and a recovery plan; the container start dominates.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
