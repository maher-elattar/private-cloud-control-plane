import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'proxmox-provider',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
