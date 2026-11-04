import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, join, sep } from 'node:path';
import { createBridge, readHostSnapshot } from '../server/bridge.mjs';
import { createPackageService } from '../server/packages.mjs';

const base = process.env.GHOST_UI_DIST ? resolve(process.env.GHOST_UI_DIST) : fileURLToPath(new URL('../dist/', import.meta.url));
const bridge = createBridge();
const hostRoot = process.env.GHOST_ROOT;
const packages = createPackageService({
  root: process.env.GHOST_PACKAGE_ROOT || (hostRoot && join(hostRoot, 'ui-packages')),
  validateTarget: hostRoot ? async (workspace, profile) => {
    const snapshot = await readHostSnapshot(hostRoot);
    return snapshot.workspace_id === workspace && snapshot.profiles.some(item => item.id === profile);
  } : undefined,
});
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.map': 'application/json' };
const server = createServer((req, res) => packages(req, res, () => bridge(req, res, async () => {
  const host = `127.0.0.1:${req.socket.localPort}`;
  if (req.headers.host !== host || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(403); res.end(); return; }
  try {
    const path = decodeURIComponent(new URL(req.url, `http://${host}`).pathname);
    const file = path === '/' ? resolve(base, 'index.html') : resolve(base, `.${path}`);
    if (!file.startsWith(resolve(base) + sep)) throw new Error('invalid path');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src http://${host}/ghost-package-assets/ about:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`, 'Cache-Control': extname(file) === '.html' ? 'no-store' : 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found'); }
})));
server.requestTimeout = 40000; server.headersTimeout = 10000;
server.listen(Number(process.env.PORT || 5178), '127.0.0.1', () => console.log(`Ghost UI: http://127.0.0.1:${server.address().port} (${process.env.GHOST_ROOT ? 'live' : 'example'})`));
