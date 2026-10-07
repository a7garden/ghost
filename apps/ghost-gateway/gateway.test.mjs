import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createGateway, parseOrigin } from './server.mjs';
import { issueDevice, updateDevices } from './devices.mjs';

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-gateway-'));
  const devices = join(dir, 'devices.json');
  const device = await issueDevice(devices, 'Test phone');
  const dispatched = [];
  const server = createGateway({ root: dir, devices, origin: 'https://ghost.example',
    discoverHost: async () => ({ origin: 'http://127.0.0.1:54321', token: 'host-private' }),
    fetchHost: async (url, options) => { dispatched.push({ url, options }); return Response.json({ ok: true, result: { saved: true } }); }, ...overrides });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  function call(path = '/mobile/v1/snapshot', { headers = {}, method = 'GET', body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method,
        headers: { Host: 'ghost.example', Authorization: `Bearer ${device.token}`, ...headers } }, res => {
        let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  return { dir, devices, device, call, dispatched };
}

test('TLS origin is mandatory and cannot select an upstream path', () => {
  for (const value of ['http://ghost.example', 'https://user:secret@ghost.example', 'https://ghost.example/path', 'https://ghost.example?q=1']) assert.throws(() => parseOrigin(value));
  assert.equal(parseOrigin('https://ghost.example:8443').host, 'ghost.example:8443');
});
test('device authentication and revocation prevent upstream calls', async t => {
  const f = await fixture(t);
  assert.equal((await f.call(undefined, { headers: { Authorization: '' } })).status, 401);
  assert.equal(f.dispatched.length, 0);
  assert.equal((await f.call()).status, 200);
  assert.ok(!(await readFile(f.devices, 'utf8')).includes(f.device.token));
  await updateDevices(f.devices, registry => registry.devices = []);
  assert.equal((await f.call()).status, 401);
  assert.equal(f.dispatched.length, 1);
});
test('rejects foreign origins, hosts, routes and malformed actions', async t => {
  const f = await fixture(t);
  assert.equal((await f.call(undefined, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call(undefined, { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await f.call('/mobile/v1/../../api/v1/snapshot')).status, 404);
  assert.equal((await f.call('/mobile/v1/snapshot?url=https://evil.example')).status, 404);
  assert.equal((await f.call('/mobile/v1/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal(f.dispatched.length, 0);
});
test('forwards the unchanged request ID with private host authentication', async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ request_id: 'b969a59e-6a27-4b7a-977f-dd457d7510e6', command: { type: 'submit', prompt: 'hello' } });
  const result = await f.call('/mobile/v1/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ghost-CSRF': 'attacker' }, body });
  assert.equal(result.status, 200);
  assert.equal(f.dispatched[0].options.body.toString(), body);
  assert.equal(f.dispatched[0].options.headers.Authorization, 'Bearer host-private');
  assert.equal(f.dispatched[0].options.headers['X-Ghost-CSRF'], 'host-private');
  assert.equal(f.dispatched[0].options.redirect, 'error');
  assert.ok(!result.data.includes('host-private'));
});
test('ambiguous failures do not retry or expose transport details', async t => {
  let count = 0;
  const f = await fixture(t, { fetchHost: async () => { count++; throw new Error('host-private secret body'); } });
  const result = await f.call();
  assert.equal(result.status, 502); assert.equal(count, 1);
  assert.ok(!result.data.includes('host-private'));
});
test('unsafe device file permissions fail closed', async t => {
  const f = await fixture(t);
  await chmod(f.devices, 0o644);
  assert.equal((await f.call()).status, 502);
  assert.equal(f.dispatched.length, 0);
});
test('revocation while discovering the host stops dispatch', async t => {
  let f;
  f = await fixture(t, { discoverHost: async () => { await updateDevices(f.devices, r => r.devices = []); return { origin: 'http://127.0.0.1:54321', token: 'private' }; } });
  assert.equal((await f.call()).status, 401); assert.equal(f.dispatched.length, 0);
});
