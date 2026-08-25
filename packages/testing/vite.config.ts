import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'provider-conformance',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
  },
});
