import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Host on all interfaces so phones/tablets on the same LAN can open the
    // workbench; Vite prints the network URL at startup. The engine service
    // keeps scoring authority — WebSocket traffic is proxied so the page
    // always talks to `ws://<host>/ws` regardless of which address opened it.
    host: true,
    port: 5173,
    // The local engine service owns scoring via the Rust core; WebSocket
    // traffic is proxied so the page always talks to `ws://<host>/ws`.
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8788', ws: true },
      '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});
