import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'messaging', environment: 'node', include: ['src/**/*.spec.ts'] },
});
