import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'control-api', environment: 'node', include: ['src/**/*.spec.ts'] },
});
