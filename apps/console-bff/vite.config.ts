import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'console-bff', environment: 'node', include: ['src/**/*.spec.ts'] },
});
