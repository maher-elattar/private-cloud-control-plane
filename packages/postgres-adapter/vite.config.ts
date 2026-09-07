import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'postgres-adapter',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Integration specs need the container stack from `vitest.integration.config.ts`; running
    // them here would fail on a missing DATABASE_URL and make `pnpm run test` require Docker.
    exclude: ['src/**/*.integration.spec.ts'],
  },
});
