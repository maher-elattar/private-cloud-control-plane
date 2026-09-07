import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'reconciler', environment: 'node', include: ['src/**/*.spec.ts'] },
});
