import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dev talks to a real ghost host through `$GHOST_ROOT/host.json`; the production
 * root (`~/Library/Application Support/Ghost`) is never a dev root. Builds and
 * vitest never touch the host, so the check lives in the dev-server hook.
 */
function hostFromRoot() {
  const root = process.env.GHOST_ROOT;
  if (!root) {
    throw new Error('GHOST_ROOT가 필요합니다. 임시 상태 루트를 지정해 dev 서버를 여세요. 예: GHOST_ROOT=$(mktemp -d) bun run dev');
  }
  return JSON.parse(readFileSync(join(root, 'host.json'), 'utf8'));
}

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { '@ghost/contract': fileURLToPath(new URL('../../packages/ghost-contract/src/index.ts', import.meta.url)) },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      // The proxy owns the owner token: the browser never sees it in dev.
      // Vitest spins up its own dev server; tests never touch the host.
      name: 'ghost-host-proxy',
      configureServer(server) {
        if (process.env.VITEST || server.config.mode === 'test') return;
        const host = hostFromRoot();
        server.middlewares.use('/api', (req, res, next) => {
          req.headers.authorization = `Bearer ${host.token}`;
          next();
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    configureServer(server) {
      if (process.env.VITEST || server.config.mode === 'test') return;
      const host = hostFromRoot();
      server.config.server.proxy ??= {};
      server.config.server.proxy['/api'] = { target: `http://127.0.0.1:${host.port}`, changeOrigin: false };
    },
  },
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
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
