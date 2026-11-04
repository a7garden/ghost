import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createBridge } from './server/bridge.mjs';

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [react(), { name: 'ghost-local-client', configureServer(server) { server.middlewares.use(createBridge()); } }],
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        overlay: fileURLToPath(new URL('./overlay.html', import.meta.url)),
      },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
