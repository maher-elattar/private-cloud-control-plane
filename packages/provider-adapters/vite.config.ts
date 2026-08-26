import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'provider-adapters', environment: 'node', include: ['src/**/*.spec.ts'] },
});
