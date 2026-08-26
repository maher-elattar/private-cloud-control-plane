import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'application', environment: 'node', include: ['src/**/*.spec.ts'] },
});
