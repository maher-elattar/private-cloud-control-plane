import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'provider-adapters',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // The integration spec needs a real `terraform` binary and a real `pg` backend from
    // `vitest.integration.config.ts`; running it here would make `pnpm run test` require Docker.
    exclude: ['src/**/*.integration.spec.ts'],
  },
});
