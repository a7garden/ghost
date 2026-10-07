import { cp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ghost = resolve(app, '../..');
const destination = join(app, 'src-tauri/resources');
const runtime = process.env.GHOST_NODE_BINARY || process.execPath;
const host = process.env.GHOST_PACKAGE_BINARY || join(ghost, 'target/debug/ghost');
// This directory contains generated payload only; replace it to avoid stale assets.
await rm(destination, { recursive: true, force: true });
for (const dir of ['runtime','host','launcher','ui/scripts','ui/server','voice']) await mkdir(join(destination, dir), { recursive: true });
await cp(runtime, join(destination, 'runtime/node'));
await cp(host, join(destination, 'host/ghost'));
for (const executable of ['runtime/node','host/ghost']) await chmod(join(destination, executable), 0o755);
await cp(join(app, 'scripts/desktop-console.mjs'), join(destination, 'launcher/desktop-console.mjs'));
await cp(join(app, 'scripts/local-voice.mjs'), join(destination, 'launcher/local-voice.mjs'));
for (const name of ['server.py','requirements.lock']) await cp(join(ghost, 'apps/ghost-voice-server', name), join(destination, 'voice', name));
await cp(join(ghost, 'apps/ghost-ui/dist'), join(destination, 'ui/dist'), { recursive: true, force: true });
for (const name of ['console.mjs','serve.mjs']) await cp(join(ghost, 'apps/ghost-ui/scripts', name), join(destination, 'ui/scripts', name));
await cp(join(ghost, 'apps/ghost-ui/server/bridge.mjs'), join(destination, 'ui/server/bridge.mjs'));
await writeFile(join(destination,'ui/package.json'), '{"type":"module"}\n');
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
await writeFile(join(destination,'payload.json'), JSON.stringify({
  version: 'ghost-desktop-payload/1', ghost_features: 'workspace-ui', ghost_build: 'local-development',
  node_sha256: await sha(join(destination,'runtime/node')), ghost_sha256: await sha(join(destination,'host/ghost')),
  ui_index_sha256: await sha(join(destination,'ui/dist/index.html')), voice_server_sha256: await sha(join(destination,'voice/server.py')), voice_runtime_included: false, credentials_included: false,
}, null, 2)+'\n');
console.log('Ghost host, UI and Node runtime prepared; credentials and user data are excluded.');
