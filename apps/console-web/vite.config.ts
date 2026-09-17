/**
 * Vite configuration for the console web client.
 *
 * The dev server proxies `/v1` to the control API so the browser talks to a single origin and
 * no CORS configuration is needed on the backend. Override the target with `CONTROL_API_URL`.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const CONTROL_API_URL = process.env.CONTROL_API_URL ?? 'http://localhost:3000';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/console-web',
  plugins: [react(), tailwindcss()],
  server: {
    port: 4200,
    host: 'localhost',
    proxy: {
      '/v1': { target: CONTROL_API_URL, changeOrigin: true },
      '/health': { target: CONTROL_API_URL, changeOrigin: true },
    },
  },
  test: {
    name: 'console-web',
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
  },
});
