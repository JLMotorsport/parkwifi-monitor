import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is served by the monitor's own HTTP server (src/core/server.ts),
// so in dev Vite proxies /api to it.
export default defineConfig({
  root: 'src/ui',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/ui', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  test: { root: '.', include: ['tests/**/*.test.ts'] },
} as never);
