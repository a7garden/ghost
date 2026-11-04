import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, discover } from './bridge.mjs';
import { createGateway } from '../../ghost-gateway/server.mjs';

const token = 'a'.repeat(64);
async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}
const stop = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function fixture(t, { validProof = true, registryRows } = {}) {
  const requests = [], root = await mkdtemp(join(tmpdir(), 'ghost-ui-bridge-'));
  const native = await listen(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    requests.push({ path: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/v1/bootstrap/')) {
      const nonce = req.url.split('/').at(-1);
      const proof = createHmac('sha256', token).update('ghost-control-bootstrap-v1\0').update(validProof ? nonce : 'stale-nonce').digest('hex');
      res.end(JSON.stringify({ protocol: 'ghost-control', version: 1, proof }));
    } else if (req.url.endsWith('/snapshot')) res.end(JSON.stringify({ workspace_id: 'test-workspace', host_protocol_version: 1, profiles: [] }));
    else if (registryRows && req.url.endsWith('/action') && JSON.parse(body).command?.envelope?.body?.method === 'registry.inspect') {
      res.end(JSON.stringify({ ok: true, result: { status: 'success', data: { registry: registryRows } } }));
    }
    else res.end(JSON.stringify({ ok: true, result: { profile_id: 'new-dot' } }));
  });
  const file = join(root, '.ghost-control.json');
  await writeFile(file, JSON.stringify({ protocol: 'ghost-control', protocol_version: 1, host: '127.0.0.1', port: native.port, token }), { mode: 0o600 });
  const ui = await listen(createBridge({ root }));
  t.after(async () => { await stop(ui.server); await stop(native.server); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await fetch(`${ui.origin}/ghost-api/bootstrap`).then(r => r.json());
  return { root, file, requests, ui, bootstrap };
}

test('default preview mode exposes no host secret', async t => {
  const ui = await listen(createBridge({ root: '' })); t.after(() => stop(ui.server));
  const response = await fetch(`${ui.origin}/ghost-api/bootstrap`), body = await response.json();
  assert.equal(body.mode, 'demo'); assert.equal(body.token, undefined);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('authenticates the host before forwarding snapshot credentials', async t => {
  const { ui, bootstrap, requests } = await fixture(t);
  const response = await fetch(`${ui.origin}/ghost-api/snapshot`, { headers: { 'X-Ghost-UI-CSRF': bootstrap.csrf } });
  assert.equal(response.status, 200); assert.equal((await response.json()).workspace_id, 'test-workspace');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].headers['x-ghost-csrf'], undefined);
  assert.equal(requests[1].headers.authorization, `Bearer ${token}`);
  assert.equal(requests[1].headers.origin, `http://127.0.0.1:${requests[1].headers.host.split(':')[1]}`);
  assert.notEqual(bootstrap.csrf, token);
});
test('a stale or forged proof never receives the host token', async t => {
  const { ui, bootstrap, requests } = await fixture(t, { validProof: false });
  const r = await fetch(`${ui.origin}/ghost-api/snapshot`, { headers: { 'X-Ghost-UI-CSRF': bootstrap.csrf } });
  assert.equal(r.status, 502); assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, undefined); assert.ok(!(await r.text()).includes(token));
});
test('forwards the exact request ID and command after same-origin validation', async t => {
  const { ui, bootstrap, requests } = await fixture(t);
  const envelope = { request_id: randomUUID(), command: { type: 'create_profile', name: 'Scout', persona: 'research' } };
  const r = await fetch(`${ui.origin}/ghost-api/action`, { method: 'POST', headers: { Origin: ui.origin, 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': bootstrap.csrf }, body: JSON.stringify(envelope) });
  assert.equal(r.status, 200); assert.equal((await r.json()).result.profile_id, 'new-dot');
  assert.deepEqual(JSON.parse(requests.at(-1).body), envelope);
});
test('rejects cross-origin, missing-CSRF and missing-Origin requests before contacting a host', async t => {
  const { ui, bootstrap, requests } = await fixture(t);
  const cross = await fetch(`${ui.origin}/ghost-api/bootstrap`, { headers: { Origin: 'https://elsewhere.example' } });
  const noCsrf = await fetch(`${ui.origin}/ghost-api/snapshot`);
  const noOrigin = await fetch(`${ui.origin}/ghost-api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': bootstrap.csrf }, body: '{}' });
  const crossSite = await fetch(`${ui.origin}/ghost-api/snapshot`, { headers: { 'Sec-Fetch-Site': 'cross-site', 'X-Ghost-UI-CSRF': bootstrap.csrf } });
  for (const r of [cross, noCsrf, noOrigin, crossSite]) assert.equal(r.status, 403);
  assert.equal(requests.length, 0);
});
test('refuses world-readable and symlink discovery files', async t => {
  const { file, root, requests } = await fixture(t);
  await chmod(file, 0o644); await assert.rejects(discover(root));
  await chmod(file, 0o600);
  const copy = join(root, 'metadata.json'); await writeFile(copy, await (await import('node:fs/promises')).readFile(file), { mode: 0o600 });
  await rm(file); await symlink(copy, file); await assert.rejects(discover(root));
  assert.equal(requests.length, 0);
});
test('refuses malformed and oversized command bodies before host access', async t => {
  const { ui, bootstrap, requests } = await fixture(t);
  const headers = { Origin: ui.origin, 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': bootstrap.csrf };
  for (const body of ['{}', JSON.stringify({ request_id: randomUUID(), command: { type: 'submit', prompt: 'a'.repeat(8 * 1_048_576) } })]) {
    const r = await fetch(`${ui.origin}/ghost-api/action`, { method: 'POST', headers, body });
    assert.equal(r.status, 502);
  }
  assert.equal(requests.length, 0);
});

test('allows larger avatar uploads while preserving the ordinary command limit', async t => {
  const { ui, bootstrap, requests } = await fixture(t);
  const headers = { Origin: ui.origin, 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': bootstrap.csrf };
  const command = { type: 'workspace', action: { type: 'create_avatar', avatar: { data_url: 'a'.repeat(6 * 1024 * 1024) } } };
  const r = await fetch(`${ui.origin}/ghost-api/action`, { method: 'POST', headers, body: JSON.stringify({ request_id: randomUUID(), command }) });
  assert.equal(r.status, 200);
  assert.equal(requests.length, 2);
  const oversized = { ...command, action: { ...command.action, avatar: { data_url: 'a'.repeat(8 * 1_048_576) } } };
  const rejected = await fetch(`${ui.origin}/ghost-api/action`, { method: 'POST', headers, body: JSON.stringify({ request_id: randomUUID(), command: oversized }) });
  assert.equal(rejected.status, 502);
  assert.equal(requests.length, 2);
});

test('voice stays ephemeral and uses the authenticated same-origin bridge', async t => {
  const { ui, bootstrap, requests } = await fixture(t);
  const headers = { Origin: ui.origin, 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': bootstrap.csrf };
  const selection = { profile_id: 'profile', conversation_id: 'conversation' };
  for (const operation of ['config', 'transcribe', 'synthesize']) {
    const body = { ...selection, ...(operation === 'config' ? {} : { settings_version: 1 }), ...(operation === 'transcribe' ? { mime: 'audio/wav', audio_base64: 'AAAA' } : operation === 'synthesize' ? { task_id: 'actual-task' } : {}) };
    const r = await fetch(`${ui.origin}/ghost-api/voice/${operation}`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(r.status, 200);
    const forwarded = requests.at(-1);
    assert.equal(forwarded.path, `/api/v1/voice/${operation}`);
    assert.deepEqual(JSON.parse(forwarded.body), body);
    assert.equal(JSON.parse(forwarded.body).request_id, undefined);
    assert.equal(forwarded.headers.authorization, `Bearer ${token}`);
    assert.ok(!(await r.text()).includes(token));
  }
});
test('voice rejects missing auth, foreign origin, oversized audio and arbitrary routes before host access', async t => {
  const { ui, bootstrap, requests } = await fixture(t);
  const headers = { Origin: ui.origin, 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': bootstrap.csrf };
  const body = JSON.stringify({ profile_id: 'p', conversation_id: 'c' });
  assert.equal((await fetch(`${ui.origin}/ghost-api/voice/config`, { method: 'POST', headers: { ...headers, 'X-Ghost-UI-CSRF': '' }, body })).status, 403);
  assert.equal((await fetch(`${ui.origin}/ghost-api/voice/config`, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body })).status, 403);
  assert.equal((await fetch(`${ui.origin}/ghost-api/voice/anything`, { method: 'POST', headers, body })).status, 404);
  assert.equal((await fetch(`${ui.origin}/ghost-api/voice/transcribe`, { method: 'POST', headers, body: JSON.stringify({ profile_id: 'p', conversation_id: 'c', audio_base64: 'a'.repeat(6 * 1024 * 1024) }) })).status, 502);
  assert.equal(requests.length, 0);
});
test('events proxy forwards the cursor path and wait hint, rejects malformed cursors', async t => {
  const { ui, bootstrap, requests } = await fixture(t);
  const headers = { 'X-Ghost-UI-CSRF': bootstrap.csrf, 'X-Ghost-Events-Wait-Ms': '25000' };
  const profile = '11111111-2222-3333-4444-555555555555';
  const response = await fetch(`${ui.origin}/ghost-api/events/${profile}/7`, { headers });
  assert.equal(response.status, 200);
  const forwarded = requests.find(r => r.path.startsWith('/api/v1/events/'));
  assert.equal(forwarded.path, `/api/v1/events/${profile}/7`);
  assert.equal(forwarded.headers['x-ghost-events-wait-ms'], '25000');
  assert.equal((await fetch(`${ui.origin}/ghost-api/events/not-a-uuid/7`, { headers })).status, 404);
  assert.equal((await fetch(`${ui.origin}/ghost-api/events/${profile}/abc`, { headers })).status, 404);
  assert.equal(requests.length, 2); // bootstrap probe + the one valid events call; rejected cursors never reach the host
  const noWait = await fetch(`${ui.origin}/ghost-api/events/${profile}/7`, { headers: { 'X-Ghost-UI-CSRF': bootstrap.csrf } });
  assert.equal(noWait.status, 200);
  const eventsCalls = requests.filter(r => r.path.startsWith('/api/v1/events/'));
  assert.equal(eventsCalls.at(-1).headers['x-ghost-events-wait-ms'], undefined); // absent hint must not be forwarded
});

test('a forged pairing gateway never receives the authenticated Host authority', async t => {
  const existing = await fixture(t);
  const observed = [];
  const foreign = await listen((req, res) => {
    observed.push({ path: req.url, authorization: req.headers.authorization, csrf: req.headers['x-ghost-csrf'] });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ protocol: 'ghost-pairing', version: 1, origin: 'https://ghost.example', proof: 'b'.repeat(64) }));
  });
  const ui = await listen(createBridge({
    root: existing.root, gatewayOrigin: 'https://ghost.example', gatewayPort: foreign.port,
  }));
  t.after(async () => { await stop(ui.server); await stop(foreign.server); });
  const bootstrap = await fetch(`${ui.origin}/ghost-api/bootstrap`).then(response => response.json());
  const response = await fetch(`${ui.origin}/ghost-api/mobile/invitations`, {
    method: 'POST',
    headers: { Origin: ui.origin, 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': bootstrap.csrf },
    body: JSON.stringify({ request_id: randomUUID(), code_digest: 'c'.repeat(64), ticket_digest: 'd'.repeat(64) }),
  });
  assert.equal(response.status, 502);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].authorization, undefined);
  assert.equal(observed[0].csrf, undefined);
  assert.equal((await response.text()).includes(token), false);
});

test('phone pairing refuses foreign origins, missing CSRF and arbitrary route targets before discovery', async t => {
  const { ui, bootstrap, requests } = await fixture(t);
  const headers = { Origin: ui.origin, 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': bootstrap.csrf };
  const body = JSON.stringify({ request_id: randomUUID(), code_digest: 'c'.repeat(64), ticket_digest: 'd'.repeat(64) });
  const unauthorized = await fetch(`${ui.origin}/ghost-api/mobile/invitations`, {
    method: 'POST', headers: { ...headers, 'X-Ghost-UI-CSRF': '' }, body,
  });
  const foreign = await fetch(`${ui.origin}/ghost-api/mobile/invitations`, {
    method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body,
  });
  const arbitrary = await fetch(`${ui.origin}/ghost-api/mobile/invitations?target=https://foreign.example`, {
    method: 'POST', headers, body,
  });
  assert.equal(unauthorized.status, 403);
  assert.equal(foreign.status, 403);
  assert.equal(arbitrary.status, 404);
  assert.equal((await fetch(`${ui.origin}/ghost-api/mobile/targets`)).status, 403);
  assert.equal((await fetch(`${ui.origin}/ghost-api/mobile/targets?path=/pairing/invitations`, { headers })).status, 404);
  assert.equal((await fetch(`${ui.origin}/ghost-api/mobile/targets`, { method: 'POST', headers, body })).status, 404);
  assert.equal(requests.length, 0);
});

test('authenticated pairing reads active targets and admits exact pairs through the strict proxy Host guard', async t => {
  const primary = { ghost_id: randomUUID(), conversation_id: randomUUID(), kind: 'primary', mode: 'active', roles: ['coordination'] };
  const specialist = { ghost_id: randomUUID(), conversation_id: randomUUID(), kind: 'specialist', mode: 'active', roles: ['research'] };
  const draining = { ghost_id: randomUUID(), conversation_id: randomUUID(), kind: 'specialist', mode: 'draining', roles: ['research'] };
  const existing = await fixture(t, { registryRows: [primary, specialist, draining] });
  const devices = join(existing.root, 'devices.json');
  const gateway = createGateway({
    root: existing.root, devices, origin: 'https://ghost.example', lifetimeAuthorityEpoch: 1,
    apns: { enabled: false, missing: [] },
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const ui = await listen(createBridge({
    root: existing.root, gatewayOrigin: 'https://ghost.example', gatewayPort: gateway.address().port,
  }));
  t.after(async () => { await stop(ui.server); await stop(gateway); });
  const bootstrap = await fetch(`${ui.origin}/ghost-api/bootstrap`).then(response => response.json());
  const headers = { Origin: ui.origin, 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': bootstrap.csrf };
  const catalog = await fetch(`${ui.origin}/ghost-api/mobile/targets`, { headers });
  assert.equal(catalog.status, 200);
  const { targets: available } = await catalog.json();
  assert.deepEqual(new Set(available.map(row => row.ghost_id)), new Set([primary.ghost_id, specialist.ghost_id]));
  const targets = [primary, specialist].map(({ ghost_id, conversation_id }) => ({ ghost_id, conversation_id }));
  const timestamp = Date.now().toString(16).padStart(12, '0'), random = randomUUID().split('-');
  const request_id = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random[2].slice(1)}-${random[3]}-${random[4]}`;
  const response = await fetch(`${ui.origin}/ghost-api/mobile/invitations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ request_id, code_digest: 'c'.repeat(64), ticket_digest: 'd'.repeat(64), targets }),
  });
  assert.equal(response.status, 200);
  const invitation = await response.json();
  assert.equal(invitation.status, 'open');
  assert.equal(invitation.scope.kind, 'lifetime');
  assert.deepEqual(new Set(invitation.scope.ghost_ids), new Set(targets.map(pair => pair.ghost_id)));
  assert.deepEqual(new Set(invitation.scope.conversation_ids), new Set(targets.map(pair => pair.conversation_id)));
  assert.deepEqual(new Set(invitation.scope.targets.map(pair => JSON.stringify(pair))), new Set(targets.map(pair => JSON.stringify(pair))));
  assert.deepEqual(invitation.scope.capabilities, ['lifetime.read', 'lifetime.write']);
  const durable = JSON.parse(await readFile(devices, 'utf8'));
  assert.equal(durable.devices.length, 0);
  assert.equal(durable.pairing.invitations.find(row => row.invitation_id === request_id)?.status, 'open');
});
