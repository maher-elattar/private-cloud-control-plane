import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'provisioning-orchestrator',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
