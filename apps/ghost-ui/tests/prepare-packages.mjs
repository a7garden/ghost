import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { packPackage } from '../server/package-format.mjs';

const [directory, origin] = process.argv.slice(2);
if (!directory) throw new Error('Pass a disposable output directory.');
const out = resolve(directory);
await mkdir(out, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
await writeFile(join(out, 'trust.json'), JSON.stringify({ fixtures: publicKey.export({ type: 'spki', format: 'pem' }) }));

const dist = join(out, 'workspace');
await build({
  configFile: false, plugins: [react()], base: './',
  root: fileURLToPath(new URL('./fixtures/package-workspace/', import.meta.url)),
  resolve: { alias: { '@ghost/ui-sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)) } },
  build: { outDir: dist, emptyOutDir: true, modulePreload: { polyfill: false } },
});
const assets = [];
for (const name of await readdir(join(dist, 'assets'))) assets.push([`ui/dist/assets/${name}`, await readFile(join(dist, 'assets', name))]);
const index = await readFile(join(dist, 'index.html'));
const changes = { id: 'changes', label: '변경 내역', route: '/changes' };
const checks = { id: 'checks', label: '검증', route: '/checks' };
for (const { id, name, views, portraitBackground } of [
  { id: 'sage', name: 'Sage 기본 대화', views: [] },
  { id: 'milo', name: 'Milo 변경 기록', views: [changes], portraitBackground: 'mint' },
  { id: 'nova', name: 'Nova 개발 작업실', views: [changes, checks], portraitBackground: 'lilac' },
]) {
  const payload = new Map([
    ['agent/definition.json', Buffer.from('{"schema":"ghost-agent/1"}')],
    ['agent/instructions.md', Buffer.from('# Disposable package fixture')],
  ]);
  if (views.length) {
    payload.set('ui/workspace.json', Buffer.from(JSON.stringify({
      schema: 'ghost-workspace/1', sdk: 'ghost-ui-sdk/1', entry: 'dist/index.html',
      defaultView: views[0].id, views, appearance: { portraitBackground }, requests: [],
    })));
    payload.set('ui/dist/index.html', index);
    for (const [path, content] of assets) payload.set(path, content);
  }
  const bytes = packPackage({ id: `fixtures/${id}`, name, version: '1.0.0' }, payload, privateKey);
  await writeFile(join(out, `${id}.ghost`), bytes);
  if (!origin) continue;
  const headers = { Origin: origin, 'X-Ghost-Package-Client': '1', 'Content-Type': 'application/octet-stream' };
  const inspect = await fetch(`${origin}/ghost-packages/inspect`, { method: 'POST', headers, body: bytes });
  const result = await inspect.json();
  if (!inspect.ok) throw new Error(JSON.stringify(result));
  const query = new URLSearchParams({ workspace: 'ghost-ui-demo-v1', profile: id, digest: result.digest });
  const installed = await fetch(`${origin}/ghost-packages/install?${query}`, { method: 'POST', headers, body: bytes });
  if (!installed.ok) throw new Error(await installed.text());
  console.log(`${id}: ${views.length} views · ${result.digest}`);
}
