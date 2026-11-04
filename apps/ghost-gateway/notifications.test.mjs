import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { request } from 'node:http';
import { createGateway, parseOrigin } from './server.mjs';
import { createNotificationOutbox, providerJWT, alertPayload, readApnsConfig } from './apns.mjs';
import { issueDevice, registerApnsToken } from './devices.mjs';

function scope({ ghostIDs, conversationIDs, capabilities = ['lifetime.read', 'lifetime.write'], targets } = {}) {
  return { kind: 'lifetime', ghost_ids: ghostIDs, conversation_ids: conversationIDs, capabilities, ...(targets ? { targets } : {}) };
}

const ghost = '11111111-1111-4111-8111-111111111111';
const conversation = '22222222-2222-4222-8222-222222222222';
const peerGhost = '33333333-3333-4333-8333-333333333333';
const peerConversation = '44444444-4444-4444-8444-444444444444';
function twoPairScope(crossed = false) {
  return scope({ ghostIDs: [ghost, peerGhost], conversationIDs: [conversation, peerConversation], targets: [
    { ghost_id: ghost, conversation_id: crossed ? peerConversation : conversation },
    { ghost_id: peerGhost, conversation_id: crossed ? conversation : peerConversation },
  ] });
}
const notification = {
  id: 'notification:abc123', conversation_id: conversation, work_id: 'work-1',
  goal_revision: 3, event_kind: 'result', state: 'pending',
};

function inboxResponse(items = [notification]) {
  return {
    status: 'success', summary: 'recipient notification inbox inspected',
    object_refs: items.map(item => item.id), artifacts: [], next_actions: [],
    error_code: null, retry_class: 'same_id', data: { notifications: items },
  };
}

async function fixture(t, { scoped = false, deviceScope, capabilities, hostNotifications, hostAck } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-notifications-'));
  const devices = join(dir, 'devices.json');
  const device = await issueDevice(devices, 'Test phone', deviceScope ?? (scoped ? scope({ ghostIDs: [ghost], conversationIDs: [conversation], capabilities }) : undefined));
  const dispatched = [];
  const server = createGateway({
    root: dir, devices, origin: 'https://ghost.example', lifetimeAuthorityEpoch: 1,
    discoverHost: async () => ({ origin: 'http://127.0.0.1:54321', token: 'host-private' }),
    fetchHost: async (url, options) => {
      const payload = JSON.parse(Buffer.from(options.body).toString('utf8'));
      dispatched.push({ url, options, payload });
      if (payload.command.envelope?.body?.method === 'registry.inspect') {
        return Response.json({ ok: true, result: { status: 'success', summary: 'ok', object_refs: [], artifacts: [], next_actions: [], error_code: null, retry_class: 'same_id', data: { registry: [{ ghost_id: ghost, kind: 'primary', conversation_id: conversation, roles: [], mode: 'active' }] } } });
      }
      if (payload.command.envelope?.body?.method === 'notification.inspect') {
        return Response.json({ ok: true, result: hostNotifications?.() ?? inboxResponse() });
      }
      return Response.json({ ok: true, result: hostAck?.(payload) ?? { status: 'success', summary: 'notification delivery state recorded', object_refs: [payload.command.envelope.body.notification_id], artifacts: [], next_actions: [], error_code: null, retry_class: 'same_id', data: { recipient_id: payload.command.envelope.body.recipient_id, notification_id: payload.command.envelope.body.notification_id, state: payload.command.envelope.body.state } } });
    },
    apns: { enabled: false, missing: [] },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  function call(path, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST',
        headers: { Host: 'ghost.example', Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json', ...headers } }, res => {
        let data = ''; res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  return { dir, devices, device, call, dispatched, server };
}

const jsonHeaders = { 'Content-Type': 'application/json' };

test('push registration stores only the token and never the credential', async t => {
  const f = await fixture(t);
  const token = 'a'.repeat(64);
  const result = await f.call('/mobile/v1/notifications/register', { body: JSON.stringify({ device_token: token, environment: 'sandbox' }) });
  assert.equal(result.status, 200);
  const registry = JSON.parse(await readFile(f.devices, 'utf8'));
  assert.equal(registry.devices[0].apns.token, token);
  assert.equal(registry.devices[0].apns.environment, 'sandbox');
  assert.ok(!(await readFile(f.devices, 'utf8')).includes(f.device.token));
  assert.equal((await f.call('/mobile/v1/notifications/register', { body: JSON.stringify({ device_token: 'xyz', environment: 'sandbox' }) })).status, 400);
  assert.equal((await f.call('/mobile/v1/notifications/register', { body: JSON.stringify({ device_token: token, environment: 'staging' }) })).status, 400);
  assert.equal(f.dispatched.length, 0);
});

test('re-registration replaces the previous token', async t => {
  const f = await fixture(t);
  await f.call('/mobile/v1/notifications/register', { body: JSON.stringify({ device_token: 'a'.repeat(64), environment: 'sandbox' }) });
  await f.call('/mobile/v1/notifications/register', { body: JSON.stringify({ device_token: 'b'.repeat(64), environment: 'production' }) });
  const registry = JSON.parse(await readFile(f.devices, 'utf8'));
  assert.equal(registry.devices.length, 1);
  assert.equal(registry.devices[0].apns.token, 'b'.repeat(64));
});

test('inbox inspection forwards the gateway identity and validates the contract', async t => {
  const f = await fixture(t);
  const result = await f.call('/mobile/v1/notifications/inspect', { body: JSON.stringify({ recipient_id: ghost }) });
  assert.equal(result.status, 200);
  const reply = JSON.parse(result.data);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result.data.notifications, [notification]);
  const envelope = f.dispatched[0].payload.command.envelope;
  assert.equal(envelope.actor_ref, 'owner');
  assert.equal(envelope.authority_epoch, 1);
  assert.deepEqual(envelope.body, { method: 'notification.inspect', recipient_id: ghost, limit: 100 });
  f.dispatched.length = 0;
  assert.equal((await f.call('/mobile/v1/notifications/inspect', { body: JSON.stringify({ recipient_id: 'not-a-uuid' }) })).status, 400);
  assert.equal((await f.call('/mobile/v1/notifications/inspect', { body: JSON.stringify({ recipient_id: ghost, extra: 1 }) })).status, 400);
  assert.equal(f.dispatched.length, 0);
});

test('invalid Host inbox payloads fail closed', async t => {
  const f = await fixture(t, {
    hostNotifications: () => ({ status: 'success', summary: 'ok', object_refs: [], artifacts: [], next_actions: [], error_code: null, retry_class: 'same_id', data: { notifications: [{ ...notification, event_kind: 'secret' }] } }),
  });
  const result = await f.call('/mobile/v1/notifications/inspect', { body: JSON.stringify({ recipient_id: ghost }) });
  assert.equal(result.status, 502);
});

test('scoped devices stay within their ghost and conversation scope', async t => {
  const f = await fixture(t, { scoped: true });
  assert.equal((await f.call('/mobile/v1/notifications/inspect', { body: JSON.stringify({ recipient_id: ghost }) })).status, 200);
  assert.equal((await f.call('/mobile/v1/notifications/inspect', { body: JSON.stringify({ recipient_id: '99999999-9999-4999-8999-999999999999' }) })).status, 403);
  const foreignConversation = await fixture(t, {
    scoped: true,
    hostNotifications: () => inboxResponse([{ ...notification, conversation_id: '88888888-8888-4888-8888-888888888888' }]),
  });
  const foreign = await foreignConversation.call('/mobile/v1/notifications/inspect', { body: JSON.stringify({ recipient_id: ghost }) });
  assert.equal(foreign.status, 502);
  assert.ok(!foreign.data.includes(conversation));
});

test('inspect and ack authorize the second exact recipient pair and deny crossed pairs', async t => {
  let observedConversation = peerConversation;
  const f = await fixture(t, {
    deviceScope: twoPairScope(), hostNotifications: () => inboxResponse([{ ...notification, conversation_id: observedConversation }]),
  });
  const inspect = { body: JSON.stringify({ recipient_id: peerGhost }) };
  const ack = { body: JSON.stringify({ recipient_id: peerGhost, notification_id: notification.id, state: 'client_seen' }) };
  assert.equal((await f.call('/mobile/v1/notifications/inspect', inspect)).status, 200);
  assert.equal((await f.call('/mobile/v1/notifications/ack', ack)).status, 200);
  observedConversation = conversation;
  const crossedInspect = await f.call('/mobile/v1/notifications/inspect', inspect);
  assert.equal(crossedInspect.status, 502);
  assert.ok(!crossedInspect.data.includes(notification.id));
  assert.equal((await f.call('/mobile/v1/notifications/ack', ack)).status, 403);
  assert.equal(f.dispatched.filter(entry => entry.payload.command.envelope?.body?.method === 'notification.ack').length, 1);
});

test('read-only devices can inspect but not acknowledge; write-only the reverse', async t => {
  const readOnly = await fixture(t, { scoped: true, capabilities: ['lifetime.read'] });
  assert.equal((await readOnly.call('/mobile/v1/notifications/inspect', { body: JSON.stringify({ recipient_id: ghost }) })).status, 200);
  assert.equal((await readOnly.call('/mobile/v1/notifications/ack', { body: JSON.stringify({ recipient_id: ghost, notification_id: notification.id, state: 'client_seen' }) })).status, 403);
  const writeOnly = await fixture(t, { scoped: true, capabilities: ['lifetime.write'] });
  assert.equal((await writeOnly.call('/mobile/v1/notifications/inspect', { body: JSON.stringify({ recipient_id: ghost }) })).status, 403);
  const ack = await writeOnly.call('/mobile/v1/notifications/ack', { body: JSON.stringify({ recipient_id: ghost, notification_id: notification.id, state: 'client_seen' }) });
  assert.equal(ack.status, 200);
  assert.equal(JSON.parse(ack.data).result.data.state, 'client_seen');
  assert.equal((await writeOnly.call('/mobile/v1/notifications/ack', { body: JSON.stringify({ recipient_id: ghost, notification_id: notification.id, state: 'read' }) })).status, 400);
});

test('acknowledgment resolves the notification and fences the exact conversation', async t => {
  // An id the recipient's current inbox does not expose is definitive not-found.
  const absent = await fixture(t, {
    hostNotifications: () => inboxResponse([{ ...notification, id: 'notification:other', conversation_id: conversation }]),
  });
  const missing = await absent.call('/mobile/v1/notifications/ack', { body: JSON.stringify({ recipient_id: ghost, notification_id: notification.id, state: 'client_seen' }) });
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.data), { ok: false, error: 'notification_not_found' });
  assert.ok(!absent.dispatched.some(entry => entry.payload.command.envelope?.body?.method === 'notification.ack'));
  // A resolvable id outside the device conversation scope is refused before forwarding.
  const foreignConversation = await fixture(t, {
    scoped: true,
    hostNotifications: () => inboxResponse([{ ...notification, conversation_id: '88888888-8888-4888-8888-888888888888' }]),
  });
  const foreign = await foreignConversation.call('/mobile/v1/notifications/ack', { body: JSON.stringify({ recipient_id: ghost, notification_id: notification.id, state: 'client_seen' }) });
  assert.equal(foreign.status, 403);
  assert.equal(JSON.parse(foreign.data).error, 'scope_denied');
  assert.ok(!foreignConversation.dispatched.some(entry => entry.payload.command.envelope?.body?.method === 'notification.ack'));
});

test('acknowledgment claims success only on a bound successful Host result', async t => {
  const rejected = await fixture(t, {
    hostAck: () => ({ status: 'error', summary: 'stale authority', object_refs: [], artifacts: [], next_actions: [], error_code: 'authority_revoked', retry_class: 'reconcile_first', data: null }),
  });
  const result = await rejected.call('/mobile/v1/notifications/ack', { body: JSON.stringify({ recipient_id: ghost, notification_id: notification.id, state: 'transport_accepted' }) });
  assert.equal(result.status, 502);
  assert.deepEqual(JSON.parse(result.data), { ok: false, error: 'host_acknowledgement_rejected' });
  // A success whose binding does not match the request is equally rejected.
  const misbound = await fixture(t, {
    hostAck: payload => ({ status: 'success', summary: 'ok', object_refs: [], artifacts: [], next_actions: [], error_code: null, retry_class: 'same_id', data: { recipient_id: ghost, notification_id: 'notification:other', state: payload.command.envelope.body.state } }),
  });
  const wrong = await misbound.call('/mobile/v1/notifications/ack', { body: JSON.stringify({ recipient_id: ghost, notification_id: notification.id, state: 'transport_accepted' }) });
  assert.equal(wrong.status, 502);
  assert.deepEqual(JSON.parse(wrong.data), { ok: false, error: 'host_acknowledgement_rejected' });
});

test('provider JWT is ES256 with raw-order signature and claims', async t => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'sec1', format: 'pem' });
  const keyId = 'ABCDEF1234', teamId = 'TEAM123456';
  const now = 1_760_000_000;
  const jwt = providerJWT({ key: pem, keyId, teamId }, now);
  const [header, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: keyId });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { iss: teamId, iat: now });
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
});


function outboxResult(data) {
  return { status: 'success', summary: 'ok', object_refs: [], artifacts: [], next_actions: [], error_code: null, retry_class: 'same_id', data };
}

test('outbox sends pending notifications once and records transport acceptance', async t => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dir = await mkdtemp(join(tmpdir(), 'ghost-outbox-'));
  const devices = join(dir, 'devices.json');
  const device = await issueDevice(devices, 'Phone');
  await registerApnsToken(devices, device.id, 'a'.repeat(64), 'sandbox');
  await issueDevice(devices, 'Second');
  const deliveries = [];
  const hostCalls = [];
  let pendingState = 'pending';
  const outbox = createNotificationOutbox({
    config: { enabled: true, keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 'io.a7garden.ghost', environment: 'sandbox', host: 'api.sandbox.push.apple.com' },
    devicesPath: devices,
    readDevices: async (path) => JSON.parse(await readFile(path, 'utf8')),
    hostLifetimeAction: async body => {
      hostCalls.push(body);
      if (body.method === 'registry.inspect') return outboxResult({ registry: [{ ghost_id: ghost }, { ghost_id: ghost }] });
      if (body.method === 'notification.inspect') return outboxResult({ notifications: [{ ...notification, state: pendingState }, { ...notification, state: 'client_seen', id: 'notification:seen' }] });
      if (body.method === 'notification.ack') { pendingState = 'transport_accepted'; return outboxResult({ notification_id: body.notification_id, state: 'transport_accepted' }); }
      throw new Error('unexpected');
    },
    sendAlert: async request_ => {
      deliveries.push(request_);
      return { status: 200, reason: null };
    },
    providerKey: privateKey.export({ type: 'sec1', format: 'pem' }),
  });
  const outcome = await outbox.tick();
  assert.equal(outcome.sent, 1);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].token, 'a'.repeat(64));
  assert.equal(deliveries[0].payload.notification_id, notification.id);
  assert.equal(deliveries[0].topic, 'io.a7garden.ghost');
  const ack = hostCalls.find(call_ => call_.method === 'notification.ack');
  assert.deepEqual(ack, { method: 'notification.ack', recipient_id: ghost, notification_id: notification.id, state: 'transport_accepted' });
  const second = await outbox.tick();
  assert.equal(second.sent, 0);
  assert.equal(deliveries.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('partial multi-device fanout acks only from durable terminal outcomes', async t => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dir = await mkdtemp(join(tmpdir(), 'ghost-outbox-'));
  const devices = join(dir, 'devices.json');
  const first = await issueDevice(devices, 'Phone A');
  await registerApnsToken(devices, first.id, 'a'.repeat(64), 'sandbox');
  const second = await issueDevice(devices, 'Phone B');
  await registerApnsToken(devices, second.id, 'b'.repeat(64), 'sandbox');
  const deliveries = [];
  const hostCalls = [];
  const outbox = createNotificationOutbox({
    config: { enabled: true, keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 'io.a7garden.ghost', environment: 'sandbox', host: 'api.sandbox.push.apple.com' },
    devicesPath: devices,
    readDevices: async (path) => JSON.parse(await readFile(path, 'utf8')),
    hostLifetimeAction: async body => {
      hostCalls.push(body);
      if (body.method === 'registry.inspect') return outboxResult({ registry: [{ ghost_id: ghost }] });
      if (body.method === 'notification.inspect') return outboxResult({ notifications: [{ ...notification, state: 'pending' }] });
      return outboxResult({ notification_id: body.notification_id, state: 'transport_accepted' });
    },
    sendAlert: async request_ => {
      deliveries.push(request_);
      // A accepts; B is a dead token removed from the registry.
      return request_.token === 'a'.repeat(64)
        ? { status: 200, reason: null }
        : { status: 410, reason: 'Unregistered' };
    },
    providerKey: privateKey.export({ type: 'sec1', format: 'pem' }),
  });
  const outcome = await outbox.tick();
  assert.equal(outcome.sent, 1);
  assert.equal(deliveries.length, 2);
  // Both targets are terminal (accepted + rejected): the Host ack is sent once
  // and the failed target did not suppress the fanout record.
  assert.equal(hostCalls.filter(call_ => call_.method === 'notification.ack').length, 1);
  const journal = JSON.parse(await readFile(`${devices}.outbox-journal.json`, 'utf8'));
  const targets = journal.notifications[0].targets;
  assert.deepEqual(targets.map(target => target.outcome).sort(), ['accepted', 'rejected']);
  // The dead token was removed without touching the accepted registration.
  const registry = JSON.parse(await readFile(devices, 'utf8'));
  assert.equal(registry.devices.find(d => d.id === first.id).apns.token, 'a'.repeat(64));
  assert.equal(registry.devices.find(d => d.id === second.id).apns, undefined);
  await rm(dir, { recursive: true, force: true });
});

test('unknown delivery outcomes are journaled and never acked or blindly resent', async t => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dir = await mkdtemp(join(tmpdir(), 'ghost-outbox-'));
  const devices = join(dir, 'devices.json');
  const device = await issueDevice(devices, 'Phone');
  await registerApnsToken(devices, device.id, 'a'.repeat(64), 'sandbox');
  let attempts = 0;
  const hostCalls = [];
  const build = () => createNotificationOutbox({
    config: { enabled: true, keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 'io.a7garden.ghost', environment: 'sandbox', host: 'api.sandbox.push.apple.com' },
    devicesPath: devices,
    readDevices: async (path) => JSON.parse(await readFile(path, 'utf8')),
    hostLifetimeAction: async body => {
      hostCalls.push(body);
      if (body.method === 'registry.inspect') return outboxResult({ registry: [{ ghost_id: ghost }] });
      return outboxResult({ notifications: [{ ...notification, state: 'pending' }] });
    },
    sendAlert: async () => {
      attempts += 1;
      throw new Error('apns_timeout');
    },
    providerKey: privateKey.export({ type: 'sec1', format: 'pem' }),
  });
  const firstTick = await build().tick();
  assert.equal(firstTick.sent, 0);
  assert.equal(firstTick.unknown, 1);
  assert.equal(hostCalls.filter(call_ => call_.method === 'notification.ack').length, 0);
  const journal = JSON.parse(await readFile(`${devices}.outbox-journal.json`, 'utf8'));
  assert.equal(journal.notifications[0].targets[0].outcome, null);
  assert.equal(journal.notifications[0].targets[0].unknown_attempts, 1);
  // A fresh outbox instance (simulated restart) honors the durable fence:
  // an indeterminate send is never automatically resent, only re-observed.
  const secondTick = await build().tick();
  assert.equal(secondTick.unknown, 1);
  assert.equal(attempts, 1);
  assert.equal(hostCalls.filter(call_ => call_.method === 'notification.ack').length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('a known acceptance survives restart and retries only the Host ack', async t => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dir = await mkdtemp(join(tmpdir(), 'ghost-outbox-'));
  const devices = join(dir, 'devices.json');
  const device = await issueDevice(devices, 'Phone');
  await registerApnsToken(devices, device.id, 'a'.repeat(64), 'sandbox');
  const deliveries = [];
  const hostCalls = [];
  let ackFails = true;
  const build = () => createNotificationOutbox({
    config: { enabled: true, keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 'io.a7garden.ghost', environment: 'sandbox', host: 'api.sandbox.push.apple.com' },
    devicesPath: devices,
    readDevices: async (path) => JSON.parse(await readFile(path, 'utf8')),
    hostLifetimeAction: async body => {
      hostCalls.push(body);
      if (body.method === 'registry.inspect') return outboxResult({ registry: [{ ghost_id: ghost }] });
      if (body.method === 'notification.ack') {
        if (ackFails) throw new Error('host_unavailable_or_outcome_unknown');
        return outboxResult({ recipient_id: body.recipient_id, notification_id: body.notification_id, state: 'transport_accepted' });
      }
      return outboxResult({ notifications: [{ ...notification, state: 'pending' }] });
    },
    sendAlert: async request_ => {
      deliveries.push(request_);
      return { status: 200, reason: null };
    },
    providerKey: privateKey.export({ type: 'sec1', format: 'pem' }),
  });
  await build().tick();
  assert.equal(deliveries.length, 1);
  // Restart: acceptance is durable, so the provider is NOT resent; only the
  // Host ack is retried and, once it succeeds, the entry retires.
  ackFails = false;
  const outcome = await build().tick();
  assert.equal(outcome.sent, 0);
  assert.equal(deliveries.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('a rejected old token never deletes its re-registered replacement', async t => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dir = await mkdtemp(join(tmpdir(), 'ghost-outbox-'));
  const devices = join(dir, 'devices.json');
  const device = await issueDevice(devices, 'Phone');
  await registerApnsToken(devices, device.id, 'a'.repeat(64), 'sandbox');
  let entered, release;
  const deliveryEntered = new Promise(resolve => { entered = resolve; });
  const deliveryReleased = new Promise(resolve => { release = resolve; });
  const outbox = createNotificationOutbox({
    config: { enabled: true, keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 'io.a7garden.ghost', environment: 'sandbox', host: 'api.sandbox.push.apple.com' },
    devicesPath: devices,
    readDevices: async (path) => JSON.parse(await readFile(path, 'utf8')),
    hostLifetimeAction: async body => body.method === 'registry.inspect'
      ? outboxResult({ registry: [{ ghost_id: ghost }] })
      : outboxResult({ notifications: [{ ...notification, state: 'pending' }] }),
    sendAlert: async () => {
      // Hold the old-token send in flight while the token is replaced.
      entered();
      await deliveryReleased;
      return { status: 410, reason: 'Unregistered' };
    },
    providerKey: privateKey.export({ type: 'sec1', format: 'pem' }),
  });
  const tick = outbox.tick();
  await deliveryEntered;
  await registerApnsToken(devices, device.id, 'b'.repeat(64), 'sandbox');
  release();
  await tick;
  // The 410 applies to the old token snapshot; the newer registration survives.
  const registry = JSON.parse(await readFile(devices, 'utf8'));
  assert.equal(registry.devices[0].apns.token, 'b'.repeat(64));
  await rm(dir, { recursive: true, force: true });
});

test('fanout authorizes each target against current scope, conversation, and read capability', async t => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dir = await mkdtemp(join(tmpdir(), 'ghost-outbox-'));
  const devices = join(dir, 'devices.json');
  const elsewhere = await issueDevice(devices, 'Scoped elsewhere', scope({ ghostIDs: [ghost], conversationIDs: [peerConversation], capabilities: ['lifetime.read', 'lifetime.write'] }));
  await registerApnsToken(devices, elsewhere.id, 'c'.repeat(64), 'sandbox');
  const readOnly = await issueDevice(devices, 'Wrong conversation', scope({ ghostIDs: [peerGhost], conversationIDs: [conversation], capabilities: ['lifetime.read'] }));
  await registerApnsToken(devices, readOnly.id, 'd'.repeat(64), 'sandbox');
  const noRead = await issueDevice(devices, 'No read capability', scope({ ghostIDs: [peerGhost], conversationIDs: [peerConversation], capabilities: ['lifetime.write'] }));
  await registerApnsToken(devices, noRead.id, 'e'.repeat(64), 'sandbox');
  const exact = await issueDevice(devices, 'Second exact pair', twoPairScope());
  await registerApnsToken(devices, exact.id, 'a'.repeat(64), 'sandbox');
  const crossed = await issueDevice(devices, 'Crossed pairs', twoPairScope(true));
  await registerApnsToken(devices, crossed.id, 'b'.repeat(64), 'sandbox');
  const deliveries = [];
  const outbox = createNotificationOutbox({
    config: { enabled: true, keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 'io.a7garden.ghost', environment: 'sandbox', host: 'api.sandbox.push.apple.com' },
    devicesPath: devices,
    readDevices: async (path) => JSON.parse(await readFile(path, 'utf8')),
    hostLifetimeAction: async body => body.method === 'registry.inspect'
      ? outboxResult({ registry: [{ ghost_id: peerGhost }] })
      : outboxResult({ notifications: [{ ...notification, conversation_id: peerConversation, state: 'pending' }] }),
    sendAlert: async request_ => {
      deliveries.push(request_);
      return { status: 200, reason: null };
    },
    providerKey: privateKey.export({ type: 'sec1', format: 'pem' }),
  });
  const outcome = await outbox.tick();
  assert.equal(outcome.sent, 1);
  assert.deepEqual(deliveries.map(delivery => delivery.token), ['a'.repeat(64)]);
  await rm(dir, { recursive: true, force: true });
});

test('missing provider configuration disables sending but keeps routes intact', async t => {
  const config = readApnsConfig({});
  assert.equal(config.enabled, false);
  assert.ok(config.missing.includes('GHOST_APNS_KEY_PATH'));
  const outbox = createNotificationOutbox({
    config: { enabled: false, missing: ['GHOST_APNS_KEY_PATH'] },
    devicesPath: '/unused', readDevices: async () => ({ devices: [] }),
    hostLifetimeAction: async () => { throw new Error('must not poll'); },
  });
  assert.deepEqual(await outbox.tick(), { sent: 0, reason: 'disabled' });
});

test('gateway without lifetime transport still answers push registration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-push-'));
  const devices = join(dir, 'devices.json');
  const device = await issueDevice(devices, 'Phone');
  const server = createGateway({
    root: dir, devices, origin: 'https://ghost.example',
    fetchHost: async () => { throw new Error('must not call host'); },
    apns: { enabled: false, missing: [] },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const result = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: '/mobile/v1/notifications/register', method: 'POST',
      headers: { Host: 'ghost.example', Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject); req.end(JSON.stringify({ device_token: 'c'.repeat(64), environment: 'sandbox' }));
  });
  assert.equal(result.status, 200);
  const registry = JSON.parse(await readFile(devices, 'utf8'));
  assert.equal(registry.devices[0].apns.token, 'c'.repeat(64));
});

test('parseOrigin keeps rejecting non-TLS origins', () => {
  assert.throws(() => parseOrigin('http://ghost.example'));
});
