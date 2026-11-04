import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packPackage, verifyPackage } from './package-format.mjs';
import { createPackageService } from './packages.mjs';

const key = generateKeyPairSync('ed25519');
const trusted = new Map([['test', key.publicKey.export({ type: 'spki', format: 'pem' })]]);
const change = { id: 'changes', label: 'Changes', route: '/changes' };
const checks = { id: 'checks', label: 'Checks', route: '/checks' };
function make(views, update = {}) {
  const files = new Map([
    ['agent/definition.json', Buffer.from('{"schema":"ghost-agent/1"}')],
    ['agent/instructions.md', Buffer.from('Role')],
  ]);
  if (views) {
    files.set('ui/workspace.json', Buffer.from(JSON.stringify({
      schema: 'ghost-workspace/1', sdk: 'ghost-ui-sdk/1', views,
      ...(views.length ? { entry: 'dist/index.html', defaultView: views[0].id } : {}), requests: [], ...update,
    })));
    if (views.length) files.set('ui/dist/index.html', Buffer.from('<h1>Custom workspace</h1>'));
  }
  return packPackage({ id: 'test/workspace', name: 'Workspace', version: '1.0.0' }, files, key.privateKey);
}

test('accepts zero, one and multiple views in manifest order', () => {
  assert.equal(verifyPackage(make(), trusted).metadata.ui, null);
  assert.deepEqual(verifyPackage(make([]), trusted).metadata.ui.views, []);
  assert.deepEqual(verifyPackage(make([checks]), trusted).metadata.ui.views, [checks]);
  assert.deepEqual(verifyPackage(make([checks, change]), trusted).metadata.ui.views, [checks, change]);
});

test('rejects tampering, untrusted publishers, malformed ZIP and undeclared authority', () => {
  const bytes = make([change, checks]);
  const tampered = Buffer.from(bytes);
  tampered[tampered.indexOf('Custom workspace')] ^= 1;
  assert.throws(() => verifyPackage(tampered, trusted));
  const mismatchedKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => verifyPackage(bytes, new Map([['test', mismatchedKey]])), /서명/);
  assert.throws(() => verifyPackage(bytes, new Map()), /배포자/);
  assert.throws(() => verifyPackage(Buffer.concat([bytes, Buffer.of(0)]), trusted), /ZIP/);
  assert.throws(() => verifyPackage(make([change, change]), trusted), /경로/);
  assert.throws(() => verifyPackage(make([change], { defaultView: 'unknown' }), trusted), /시작 화면/);
  assert.throws(() => verifyPackage(make([change], { requests: ['work.write/1'] }), trusted), /권한/);
  assert.throws(() => packPackage({ id: 'test/traversal', name: 'x', version: '1.0.0' },
    new Map([['ui/../outside', Buffer.from('x')]]), key.privateKey), /경로/);
});

test('inspection is read-only, install pins the digest, and app and assets enforce separate policies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-package-unit-'));
  const trustFile = join(root, 'trust.json');
  await writeFile(trustFile, JSON.stringify(Object.fromEntries(trusted)));
  const service = createPackageService({ root, trustFile });
  const server = createServer((req, res) => service(req, res, () => res.writeHead(404).end()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/octet-stream', 'X-Ghost-Package-Client': '1' };
  const post = (path, body, override = {}) => fetch(origin + '/ghost-packages/' + path, {
    method: 'POST', body, headers: { ...headers, ...override },
  });
  const list = (workspace, profile) => fetch(`${origin}/ghost-packages/list?workspace=${workspace}&profile=${profile}`, { headers }).then(r => r.json());
  const bytes = make([change, checks]);
  const info = await post('inspect', bytes).then(r => r.json());
  const asset = `${origin}/ghost-package-assets/${info.digest}/index.html`;
  assert.deepEqual(await list('owner', 'nova'), {});
  assert.equal((await fetch(asset)).status, 404);
  assert.equal((await post('install?workspace=owner&profile=nova&digest=wrong', bytes)).status, 409);
  assert.equal((await post('inspect', bytes, { Origin: 'null' })).status, 403);
  assert.equal((await post('inspect', bytes, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(`install?workspace=owner&profile=nova&digest=${info.digest}`, bytes)).status, 200);
  assert.deepEqual((await list('owner', 'nova')).nova, info);
  assert.deepEqual(await list('other', 'nova'), {});
  assert.deepEqual(await list('owner', 'sage'), {});
  const rendered = await fetch(asset);
  assert.equal(rendered.status, 200);
  assert.match(rendered.headers.get('content-security-policy'), /sandbox allow-scripts;.*connect-src 'none'/);
  assert.equal(await rendered.text(), '<h1>Custom workspace</h1>');
  assert.equal((await fetch(asset.replace('index.html', '../agent/instructions.md'))).status, 404);
  await writeFile(trustFile, '{}');
  assert.deepEqual(await list('owner', 'nova'), {});
  assert.equal((await fetch(asset)).status, 404);
});
