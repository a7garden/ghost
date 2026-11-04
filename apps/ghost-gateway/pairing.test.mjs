// Behavioral pairing tests: the real gateway handler against an isolated
// private device registry and a controlled host. No multicast, no child
// processes, no live gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createGateway } from './server.mjs';
import { issueDevice, readDevices, registerApnsToken, updateDevices } from './devices.mjs';
import {
  createPairingService, pairingRoute, normalizePairingCode, codeDigest, ticketDigest, generatePairingSecrets,
  verificationCode, PAIRING_CODE_ALPHABET,
  pairingAdvertisementRegistered,
} from './pairing.mjs';

test('real dns-sd callback accepts a space-padded morning hour but not its startup banner', () => {
  const banner = 'Registering Service ghost-runtime-probe._ghost-pair._tcp.local port 8788\nDATE: ---Sat 17 Oct 2026---\n 8:23:04.304  ...STARTING...\n';
  assert.equal(pairingAdvertisementRegistered(banner), false);
  const reply = ' 8:23:05.022  Got a reply for service ghost-runtime-probe._ghost-pair._tcp.local.: Name now registered and active\n';
  assert.equal(pairingAdvertisementRegistered(banner + reply), true);
  assert.equal(pairingAdvertisementRegistered(reply.replace(' 8:', '18:')), true);
  assert.equal(pairingAdvertisementRegistered(reply.replace('registered and active', 'registration failed')), false);
});

const GHOST_ID = randomUUID();
const CONVERSATION_ID = randomUUID();
const PRIMARY_ROW = { ghost_id: GHOST_ID, conversation_id: CONVERSATION_ID, kind: 'primary', mode: 'active', roles: ['owner'] };
const HOST_TOKEN = 'a'.repeat(64);
const EPOCH = 7;
const pairOf = ({ ghost_id, conversation_id }) => ({ ghost_id, conversation_id });
const peer = (mode = 'active') => ({ ghost_id: randomUUID(), conversation_id: randomUUID(), kind: 'specialist', mode, roles: ['research'] });

function clockAt(iso) {
  const state = { now: Date.parse(iso) };
  return { state, now: () => new Date(state.now) };
}

async function fixture(t, { rows = [PRIMARY_ROW], profiles = [], clock = clockAt('2026-10-12T10:00:00Z') } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-pairing-'));
  const devices = join(dir, 'devices.json');
  const legacy = await issueDevice(devices, 'Legacy owner phone');
  const phoneKey = randomBytes(32).toString('hex');
  const server = createGateway({
    root: dir, devices, origin: 'https://ghost.example', lifetimeAuthorityEpoch: EPOCH, clock: clock.now,
    discoverHost: async () => ({ origin: 'http://127.0.0.1:54321', token: HOST_TOKEN }),
    fetchHost: async (url, options) => {
      if (options.method === 'GET') {
        return Response.json({ workspace_id: GHOST_ID, profiles, lifetime_authority: { authority_epoch: EPOCH, dispatch_enabled: true } });
      }
      const body = JSON.parse(Buffer.from(options.body).toString('utf8'));
      if (body.command?.envelope?.body?.method === 'registry.inspect') {
        return Response.json({ ok: true, result: { status: 'success', data: { registry: structuredClone(rows) } } });
      }
      if (body.command?.envelope?.body?.method === 'snapshot') {
        return Response.json({ ok: true, result: { status: 'success', data: {
          protocol_version: 'ghost-lifetime/1', contract_revision: 1, mode: 'live',
          goals: [], work: [], acceptances: [], artifacts: [], bindings: rows.map(pairOf),
        } } });
      }
      return Response.json({ ok: true, result: { saved: true } });
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  function call(path, { headers = {}, method = 'GET', body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port: server.address().port, path, method,
        headers: { Host: 'ghost.example', ...headers },
      }, res => {
        let data = ''; res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const adminHeaders = { Authorization: `Bearer ${HOST_TOKEN}`, 'X-Ghost-CSRF': HOST_TOKEN };
  async function invite(body) {
    return call('/pairing/invitations', { method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function invitationRequest(targets) {
    const { code, ticket } = generatePairingSecrets();
    const timestamp = clock.state.now.toString(16).padStart(12, '0');
    const random = randomUUID().split('-');
    const request_id = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random[2].slice(1)}-${random[3]}-${random[4]}`;
    return { code, ticket, body: { request_id, code_digest: codeDigest(code), ticket_digest: ticketDigest(ticket), ...(targets === undefined ? {} : { targets }) } };
  }
  async function makeInvitation(targets) {
    const { code, ticket, body } = invitationRequest(targets);
    const response = await invite(body);
    assert.equal(response.status, 200);
    return { code, ticket, request_id: body.request_id, ...response.data };
  }
  async function claim(invitation, overrides = {}) {
    const response = await call('/pairing/claims', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: randomUUID(),
        device_name: 'Garden iPhone',
        device_token_digest: createHash('sha256').update(phoneKey).digest('hex'),
        code: invitation.code,
        ...overrides,
      }),
    });
    return response;
  }
  return { dir, devices, legacy, phoneKey, port: server.address().port, call, adminHeaders, invite, invitationRequest, makeInvitation, claim };
}

function approveBody(invitation, claim, code = claim.verification_code) {
  return JSON.stringify({ request_id: randomUUID(), claim_id: claim.claim_id, verification_code: code });
}

test('short code normalization is Crockford base32, exactly 8 characters', () => {
  assert.equal(normalizePairingCode(' abcd-efgh '), 'ABCDEFGH');
  assert.equal(normalizePairingCode('0O1L5I8B'), null);
  assert.equal(normalizePairingCode('1234567'), null);
  for (const char of 'OILU') assert.equal(PAIRING_CODE_ALPHABET.includes(char), false);
});

test('pairing routes are recognized before device auth; admin requires the exact root proof', async t => {
  const f = await fixture(t);
  // Unauthenticated bootstrap proof over the exact byte chain.
  const nonce = randomBytes(16).toString('hex');
  const bootstrap = await f.call(`/pairing/admin/bootstrap/${nonce}`);
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(bootstrap.data, {
    protocol: 'ghost-pairing', version: 1, origin: 'https://ghost.example',
    proof: createHmac('sha256', HOST_TOKEN)
      .update('ghost-pairing-bootstrap-v1\0').update(nonce).update('\0').update('https://ghost.example').digest('hex'),
  });
  // Admin routes fail closed without both the Bearer token and CSRF proof.
  const invitations = await f.call('/pairing/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(invitations.status, 401);
  const missingCsrf = await f.call('/pairing/invitations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HOST_TOKEN}` }, body: '{}',
  });
  assert.equal(missingCsrf.status, 401);
  // Unrelated pairing paths are not found; device auth behavior is unchanged.
  assert.equal((await f.call('/pairing/nope')).status, 401);
  assert.equal((await f.call('/mobile/v1/snapshot')).status, 401);
});

test('foreign host is denied on pairing routes before any pairing work', async t => {
  const f = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: f.port, path: '/pairing/claims', method: 'POST',
      headers: { Host: 'evil.example', 'Content-Type': 'application/json' },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(result.status, 403);
});

test('invitation scope is the actual active Primary row, read/write, current epoch', async t => {
  const f = await fixture(t);
  const invitation = await f.makeInvitation();
  assert.equal(invitation.invitation_id, invitation.request_id);
  assert.equal(invitation.origin, 'https://ghost.example');
  assert.equal(invitation.status, 'open');
  assert.equal(typeof invitation.expires_at, 'string');
  assert.deepEqual(invitation.scope, {
    kind: 'lifetime', ghost_ids: [GHOST_ID], conversation_ids: [CONVERSATION_ID],
    capabilities: ['lifetime.read', 'lifetime.write'],
  });
  // No caller-chosen UUIDs or legacy full-owner fallback in the scope.
  assert.equal(invitation.scope.ghost_ids.length, 1);
  assert.ok(!JSON.stringify(invitation).includes(f.phoneKey));
});

test('explicit default-only invitation remains compatible with the four-field phone validator', async t => {
  const f = await fixture(t, { rows: [PRIMARY_ROW, peer()] });
  const attempt = f.invitationRequest([pairOf(PRIMARY_ROW)]);
  const issued = await f.invite(attempt.body);
  assert.equal(issued.status, 200);
  const retry = await f.invite(attempt.body);
  assert.deepEqual(retry, issued);
  const { targets, ...implicit } = attempt.body;
  assert.deepEqual(await f.invite(implicit), { status: 409, data: { error: 'invitation_conflict' } });

  const claim = await f.claim(attempt);
  assert.equal(claim.status, 200);
  // The previous iOS parser requires exactly these four fields at claim and status.
  const assertLegacyScope = scope => assert.deepEqual(scope, {
    kind: 'lifetime', ghost_ids: [GHOST_ID], conversation_ids: [CONVERSATION_ID], capabilities: ['lifetime.read', 'lifetime.write'],
  });
  assertLegacyScope(claim.data.scope);
  const approval = await f.call(`/pairing/invitations/${issued.data.invitation_id}/approve`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' }, body: approveBody(issued.data, claim.data),
  });
  assert.equal(approval.status, 200);
  const status = await f.call(`/pairing/claims/${claim.data.claim_id}/status`, {
    method: 'POST', headers: { Authorization: `Bearer ${f.phoneKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: randomUUID() }),
  });
  assert.equal(status.data.status, 'approved');
  assertLegacyScope(status.data.scope);
});

test('owner can pair exact selected Ghosts and phone bootstrap only names those granted targets', async t => {
  const selected = peer(), hidden = peer(), draining = peer('draining');
  const rows = [PRIMARY_ROW, selected, hidden, draining];
  const f = await fixture(t, { rows, profiles: [
    { id: GHOST_ID, name: 'Default Ghost' }, { id: selected.ghost_id, name: 'Research Ghost' },
    { id: hidden.ghost_id, name: 'Another Ghost' }, { id: draining.ghost_id, name: 'Archived Ghost' },
  ] });
  assert.equal((await f.call('/pairing/targets', { headers: { Authorization: `Bearer ${f.phoneKey}` } })).status, 401);
  const catalog = await f.call('/pairing/targets', { headers: f.adminHeaders });
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data.targets.map(target => target.name), ['Default Ghost', 'Research Ghost', 'Another Ghost']);
  const targets = [pairOf(PRIMARY_ROW), pairOf(selected)];
  const invitation = await f.makeInvitation(targets);
  assert.deepEqual(new Set(invitation.scope.targets.map(target => target.ghost_id)), new Set([GHOST_ID, selected.ghost_id]));
  const claim = await f.claim(invitation);
  assert.deepEqual(claim.data.scope, invitation.scope);
  rows.push(peer()); // Registering another Ghost never broadens the pending invitation.
  const approval = await f.call(`/pairing/invitations/${invitation.invitation_id}/approve`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' }, body: approveBody(invitation, claim.data),
  });
  assert.equal(approval.status, 200);
  const device = (await readDevices(f.devices)).devices.find(device => device.id === approval.data.device_id);
  assert.deepEqual(device.scope, invitation.scope);
  const phone = { Authorization: `Bearer ${f.phoneKey}` };
  const bootstrap = await f.call('/mobile/v1/bootstrap', { headers: phone });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(bootstrap.data.target_pairs.map(target => target.name), ['Default Ghost', 'Research Ghost']);

  // Even if a registry/snapshot were to later advertise cross-pairs using
  // identifiers individually in scope, the issued device gains neither pair.
  rows.splice(0, 2, { ...PRIMARY_ROW, conversation_id: selected.conversation_id }, { ...selected, conversation_id: CONVERSATION_ID });
  const updated = await f.call('/mobile/v1/bootstrap', { headers: phone });
  assert.deepEqual(updated.data.target_pairs, []);
  const snapshot = await f.call('/mobile/v1/lifetime/snapshot', { headers: phone });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.data.bindings, []);
});

test('invitation rejects crossed, duplicate, inactive and empty selections without writing an invitation', async t => {
  const selected = peer(), draining = peer('draining');
  const f = await fixture(t, { rows: [PRIMARY_ROW, selected, draining] });
  for (const targets of [[], [pairOf(selected), pairOf(selected)], Array.from({ length: 17 }, () => pairOf(peer()))]) {
    const response = await f.invite(f.invitationRequest(targets).body);
    assert.deepEqual(response, { status: 400, data: { error: 'invalid_invitation_request' } });
  }
  for (const targets of [[pairOf(draining)], [{ ghost_id: GHOST_ID, conversation_id: selected.conversation_id }]]) {
    const response = await f.invite(f.invitationRequest(targets).body);
    assert.deepEqual(response, { status: 409, data: { error: 'invitation_stale_scope' } });
  }
  assert.deepEqual((await readDevices(f.devices)).pairing?.invitations ?? [], []);
});

test('a retry preserves its exact selection and approval fails if any selected pair is no longer active', async t => {
  const selected = peer(), rows = [PRIMARY_ROW, selected];
  const f = await fixture(t, { rows });
  const attempt = f.invitationRequest(rows.map(pairOf));
  const created = await f.invite(attempt.body);
  assert.equal(created.status, 200);
  const claim = await f.claim(attempt);
  assert.equal(claim.status, 200);
  rows[1] = { ...selected, mode: 'draining' };
  const retry = await f.invite({ ...attempt.body, targets: [...attempt.body.targets].reverse() });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.scope, created.data.scope);
  const changed = await f.invite({ ...attempt.body, targets: [pairOf(PRIMARY_ROW)] });
  assert.deepEqual(changed, { status: 409, data: { error: 'invitation_conflict' } });
  const approval = await f.call(`/pairing/invitations/${created.data.invitation_id}/approve`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' }, body: approveBody(created.data, claim.data),
  });
  assert.deepEqual(approval, { status: 409, data: { error: 'invitation_stale_scope' } });
  assert.deepEqual((await readDevices(f.devices)).devices.map(device => device.id), [f.legacy.id]);
});

test('an explicit non-default Ghost can pair, but an old-generation proposal cannot be approved', async t => {
  const selected = peer();
  const f = await fixture(t, { rows: [PRIMARY_ROW, selected] });
  const invitation = await f.makeInvitation([pairOf(selected)]);
  assert.deepEqual(invitation.scope.ghost_ids, [selected.ghost_id]);
  const claim = await f.claim(invitation);
  assert.equal(claim.status, 200);
  const nextAuthority = createPairingService({
    devices: f.devices, origin: 'https://ghost.example', epoch: EPOCH + 1,
    now: () => new Date('2026-10-12T10:00:00Z'), hostRegistry: async () => [PRIMARY_ROW, selected],
  });
  await assert.rejects(
    () => nextAuthority.approveInvitation(invitation.invitation_id, JSON.parse(approveBody(invitation, claim.data))),
    error => error.code === 'invitation_stale_scope',
  );
  assert.deepEqual((await readDevices(f.devices)).devices.map(device => device.id), [f.legacy.id]);
});

test('no device exists before owner approval; approval inserts exactly one scoped device', async t => {
  const f = await fixture(t);
  const invitation = await f.makeInvitation();
  const claim = await f.claim(invitation);
  assert.equal(claim.status, 200);
  assert.equal(claim.data.status, 'pending');
  assert.match(claim.data.verification_code, /^[0-9]{6}$/);
  assert.equal(claim.data.invitation_id, invitation.request_id);
  let registry = await readDevices(f.devices);
  assert.equal(registry.devices.length, 1); // only the legacy fixture device
  // Pending status must not have created a device grant.
  assert.equal(registry.devices.some(device => device.scope), false);

  // Wrong verification code is denied.
  const wrong = await f.call(`/pairing/invitations/${invitation.request_id}/approve`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: approveBody(invitation, claim.data, claim.data.verification_code === '000000' ? '000001' : '000000'),
  });
  assert.equal(wrong.status, 403);

  const approve = await f.call(`/pairing/invitations/${invitation.request_id}/approve`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: approveBody(invitation, claim.data),
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.status, 'approved');
  assert.ok(approve.data.device_id);
  assert.equal(approve.data.token, undefined);

  registry = await readDevices(f.devices);
  assert.equal(registry.devices.length, 2);
  const paired = registry.devices.find(device => device.id === approve.data.device_id);
  assert.deepEqual(paired.scope, invitation.scope);
  assert.equal(paired.digest, createHash('sha256').update(f.phoneKey).digest('hex'));
  assert.ok(!JSON.stringify(registry).includes(f.phoneKey));
  // The paired phone key now authenticates as the scoped device.
  const { authenticate } = await import('./devices.mjs');
  const device = await authenticate(f.devices, `Bearer ${f.phoneKey}`);
  assert.equal(device.id, approve.data.device_id);
});

test('duplicate owner approval is idempotent and never mints a second device', async t => {
  const f = await fixture(t);
  const invitation = await f.makeInvitation();
  const claim = await f.claim(invitation);
  const headers = { ...f.adminHeaders, 'Content-Type': 'application/json' };
  const body = approveBody(invitation, claim.data);
  const first = await f.call(`/pairing/invitations/${invitation.request_id}/approve`, { method: 'POST', headers, body });
  assert.equal(first.status, 200);
  const repeat = await f.call(`/pairing/invitations/${invitation.request_id}/approve`, { method: 'POST', headers, body });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.device_id, first.data.device_id);
  const differentRequest = await f.call(`/pairing/invitations/${invitation.request_id}/approve`, {
    method: 'POST', headers, body: approveBody(invitation, claim.data),
  });
  assert.equal(differentRequest.status, 409);
  const registry = await readDevices(f.devices);
  assert.equal(registry.devices.length, 2);
});

test('a racing second claim on the same invitation is denied; exactly one pending claim', async t => {
  const f = await fixture(t);
  const invitation = await f.makeInvitation();
  const first = await f.claim(invitation);
  assert.equal(first.status, 200);
  const second = await f.claim(invitation, { request_id: randomUUID(), device_name: 'Other phone' });
  assert.equal(second.status, 409);
  const receipt = await f.call('/pairing/invitations', {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: invitation.request_id, code_digest: codeDigest(invitation.code), ticket_digest: ticketDigest(invitation.ticket) }),
  });
  assert.equal(receipt.data.status, 'pending');
  assert.equal(receipt.data.claim.claim_id, first.data.claim_id);
  assert.equal(receipt.data.claim.verification_code, first.data.verification_code);
  assert.equal(receipt.data.claim.device_fingerprint.length, 16);
  assert.ok(!JSON.stringify(receipt.data).includes(createHash('sha256').update(f.phoneKey).digest('hex')));
});

test('claim attempts are bounded per invitation before credentials decide', async t => {
  const f = await fixture(t);
  const invitation = await f.makeInvitation();
  const claim = await f.claim(invitation);
  const headers = { ...f.adminHeaders, 'Content-Type': 'application/json' };
  const wrongCode = () => {
    let candidate;
    do {
      candidate = Array.from({ length: 6 }, () => PAIRING_CODE_ALPHABET[Math.floor(Math.random() * 10)]).join('');
    } while (candidate === claim.data.verification_code);
    return candidate;
  };
  for (let attempt = 0; attempt < 12; attempt++) {
    const wrong = await f.call(`/pairing/invitations/${invitation.request_id}/approve`, {
      method: 'POST', headers,
      body: approveBody(invitation, claim.data, wrongCode()),
    });
    // The successful claim already consumed one attempt; the cap may land
    // inside this loop. Once capped, further attempts never see credentials.
    assert.ok([403, 429].includes(wrong.status), `unexpected status ${wrong.status}`);
    if (wrong.status === 429) break;
  }
  const evenCorrect = await f.call(`/pairing/invitations/${invitation.request_id}/approve`, {
    method: 'POST', headers, body: approveBody(invitation, claim.data),
  });
  assert.equal(evenCorrect.status, 429);
  const registry = await readDevices(f.devices);
  assert.equal(registry.devices.length, 1);
});

test('expired invitation TTL survives a gateway restart and denies late claims and approval', async t => {
  const clock = clockAt('2026-10-12T10:00:00Z');
  const f = await fixture(t, { clock });
  const invitation = await f.makeInvitation();
  clock.state.now += 6 * 60 * 1000; // beyond the 5-minute TTL
  const meta = await f.call(`/pairing/invitations/${invitation.request_id}`, { headers: f.adminHeaders });
  assert.equal(meta.status, 200);
  assert.equal(meta.data.status, 'expired');
  const lateClaim = await f.claim(invitation);
  assert.equal(lateClaim.status, 409);
  const pendingElsewhere = await f.makeInvitation();
  const pendingClaim = await f.claim(pendingElsewhere);
  clock.state.now += 6 * 60 * 1000;
  const lateApprove = await f.call(`/pairing/invitations/${pendingElsewhere.request_id}/approve`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: approveBody(pendingElsewhere, pendingClaim.data),
  });
  assert.equal(lateApprove.status, 409);
  const registry = await readDevices(f.devices);
  assert.equal(registry.devices.length, 1);
});

test('claim and status retries are idempotent; changed bodies under the same request id are denied', async t => {
  const f = await fixture(t);
  const invitation = await f.makeInvitation();
  const request_id = randomUUID();
  const body = JSON.stringify({
    request_id, device_name: 'Garden iPhone',
    device_token_digest: createHash('sha256').update(f.phoneKey).digest('hex'),
    code: invitation.code,
  });
  const first = await f.call('/pairing/claims', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(first.status, 200);
  const retry = await f.call('/pairing/claims', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.deepEqual(retry.data, first.data);
  const changed = await f.call('/pairing/claims', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...JSON.parse(body), device_name: 'Renamed phone' }),
  });
  assert.equal(changed.status, 409);
  // Lost-ack status retry with the exact same phone key proof.
  const statusBody = JSON.stringify({ request_id: randomUUID() });
  const statusHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${f.phoneKey}` };
  const statusA = await f.call(`/pairing/claims/${first.data.claim_id}/status`, { method: 'POST', headers: statusHeaders, body: statusBody });
  const statusB = await f.call(`/pairing/claims/${first.data.claim_id}/status`, { method: 'POST', headers: statusHeaders, body: statusBody });
  assert.equal(statusA.status, 200);
  assert.deepEqual(statusB.data, statusA.data);
  assert.equal(statusA.data.status, 'pending');
  // A different key can never read the claim.
  const stranger = await f.call(`/pairing/claims/${first.data.claim_id}/status`, {
    method: 'POST', headers: { ...statusHeaders, Authorization: `Bearer ${randomBytes(32).toString('hex')}` }, body: statusBody,
  });
  assert.equal(stranger.status, 404);
});

test('claim body requires exactly one auth mode and no extra fields', async t => {
  const f = await fixture(t);
  const invitation = await f.makeInvitation();
  const base = {
    request_id: randomUUID(), device_name: 'Garden iPhone',
    device_token_digest: createHash('sha256').update(f.phoneKey).digest('hex'),
  };
  assert.equal((await f.claim(invitation, { ...base, code: invitation.code, invitation_id: invitation.request_id, ticket: invitation.ticket })).status, 400);
  assert.equal((await f.claim(invitation, { ...base, invitation_id: invitation.request_id })).status, 400);
  // Ticket mode works end to end.
  const ticketClaim = await f.claim(invitation, { ...base, code: undefined, invitation_id: invitation.request_id, ticket: invitation.ticket });
  assert.equal(ticketClaim.status, 200);
  assert.equal(ticketClaim.data.status, 'pending');
});

test('cancel denies late claims; approving then cancelling revokes only that invitation device', async t => {
  const f = await fixture(t);
  const invitation = await f.makeInvitation();
  const cancel = await f.call(`/pairing/invitations/${invitation.request_id}/cancel`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: randomUUID() }),
  });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.status, 'cancelled');
  assert.equal((await f.claim(invitation)).status, 409);
  const repeatCancel = await f.call(`/pairing/invitations/${invitation.request_id}/cancel`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: randomUUID() }),
  });
  assert.equal(repeatCancel.status, 200);

  const second = await f.makeInvitation();
  const claim = await f.claim(second);
  const approve = await f.call(`/pairing/invitations/${second.request_id}/approve`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: approveBody(second, claim.data),
  });
  assert.equal(approve.status, 200);
  const revoke = await f.call(`/pairing/invitations/${second.request_id}/cancel`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: randomUUID() }),
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.data.status, 'revoked');
  let registry = await readDevices(f.devices);
  assert.equal(registry.devices.length, 1); // only the legacy device remains
  assert.equal(registry.devices[0].id, f.legacy.id);
  // Status reports revoked and never re-adds the device.
  const status = await f.call(`/pairing/claims/${claim.data.claim_id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.phoneKey}` },
    body: JSON.stringify({ request_id: randomUUID() }),
  });
  assert.equal(status.data.status, 'revoked');
  registry = await readDevices(f.devices);
  assert.equal(registry.devices.length, 1);
  // Re-approval after revocation is denied with no regrant.
  const reapprove = await f.call(`/pairing/invitations/${second.request_id}/approve`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: approveBody(second, claim.data),
  });
  assert.equal(reapprove.status, 409);
});

test('external registry revocation of an approved device reports revoked without regrant', async t => {
  const f = await fixture(t);
  const invitation = await f.makeInvitation();
  const claim = await f.claim(invitation);
  const approve = await f.call(`/pairing/invitations/${invitation.request_id}/approve`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: approveBody(invitation, claim.data),
  });
  assert.equal(approve.status, 200);
  await updateDevices(f.devices, registry => {
    registry.devices = registry.devices.filter(device => device.id !== approve.data.device_id);
  });
  const status = await f.call(`/pairing/claims/${claim.data.claim_id}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.phoneKey}` },
    body: JSON.stringify({ request_id: randomUUID() }),
  });
  assert.equal(status.data.status, 'revoked');
  assert.equal(status.data.device_id, undefined);
  assert.equal((await readDevices(f.devices)).devices.length, 1);
});

test('existing APNs and media records of other devices are untouched by pairing writes', async t => {
  const f = await fixture(t);
  await registerApnsToken(f.devices, f.legacy.id, 'a'.repeat(64), 'sandbox');
  await updateDevices(f.devices, registry => {
    const device = registry.devices.find(entry => entry.id === f.legacy.id);
    device.media = [{ start_id: randomUUID(), pc_id: null, since: new Date().toISOString(), fence: 'c'.repeat(64) }];
  });
  const before = JSON.stringify((await readDevices(f.devices)).devices.find(entry => entry.id === f.legacy.id));
  const invitation = await f.makeInvitation();
  const claim = await f.claim(invitation);
  await f.call(`/pairing/invitations/${invitation.request_id}/approve`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: approveBody(invitation, claim.data),
  });
  const after = JSON.stringify((await readDevices(f.devices)).devices.find(entry => entry.id === f.legacy.id));
  assert.equal(after, before);
  // Registry stays a private owner-only file.
  const { stat } = await import('node:fs/promises');
  const mode = (await stat(f.devices)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('stale scope: approval fails closed when the Primary row moved to another conversation', async t => {
  const f = await fixture(t);
  const invitation = await f.makeInvitation();
  const claim = await f.claim(invitation);
  const moved = [{ ...PRIMARY_ROW, conversation_id: randomUUID() }];
  // Drive the service directly with a moved Primary row: approval must
  // re-prove the exact recorded scope and current epoch before any grant.
  const service = createPairingService({
    devices: f.devices, origin: 'https://ghost.example', epoch: EPOCH,
    now: () => new Date('2026-10-12T10:00:00Z'),
    hostRegistry: async () => moved,
  });
  await assert.rejects(
    () => service.approveInvitation(invitation.request_id, JSON.parse(approveBody(invitation, claim.data))),
    error => error.code === 'invitation_stale_scope',
  );
  assert.equal((await readDevices(f.devices)).devices.length, 1);
});

test('operator invitation list restores open/pending receipts without secrets', async t => {
  const f = await fixture(t);
  const open = await f.makeInvitation();
  const pending = await f.makeInvitation();
  const claim = await f.claim(pending);
  const list = await f.call('/pairing/invitations', { headers: f.adminHeaders });
  assert.equal(list.status, 200);
  assert.equal(list.data.invitations.length, 2);
  const restored = list.data.invitations.find(entry => entry.invitation_id === pending.request_id);
  assert.equal(restored.status, 'pending');
  assert.equal(restored.claim.claim_id, claim.data.claim_id);
  assert.equal(restored.claim.verification_code, claim.data.verification_code);
  assert.equal(typeof restored.claim.device_name, 'string');
  assert.equal(restored.claim.device_fingerprint.length, 16);
  const serialized = JSON.stringify(list.data);
  assert.ok(!serialized.includes('code_digest'));
  assert.ok(!serialized.includes('ticket_digest'));
  assert.ok(!serialized.includes('device_token_digest'));
  assert.ok(!serialized.includes(f.phoneKey));
  // Expired receipts show up expired after TTL, never renewable.
  const cancelled = await f.makeInvitation();
  await f.call(`/pairing/invitations/${cancelled.request_id}/cancel`, {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: randomUUID() }),
  });
  const after = await f.call('/pairing/invitations', { headers: f.adminHeaders });
  assert.equal(after.data.invitations.length, 3);
  assert.equal(after.data.invitations.find(entry => entry.invitation_id === cancelled.request_id).status, 'cancelled');
  // Unauthenticated list is denied like every other admin path.
  assert.equal((await f.call('/pairing/invitations')).status, 401);
});

test('pairing route table rejects malformed identifiers', () => {
  assert.equal(pairingRoute('GET', '/pairing/admin/bootstrap/short'), null);
  assert.equal(pairingRoute('GET', `/pairing/invitations/${'z'.repeat(36)}`), null);
  assert.equal(pairingRoute('DELETE', '/pairing/invitations'), null);
  assert.equal(pairingRoute('POST', `/pairing/claims/${randomUUID()}/status`).kind, 'claim_status');
});

test('generated secrets are format-exact for QR and code rendering', () => {
  const { code, ticket } = generatePairingSecrets();
  assert.equal(code.length, 8);
  assert.equal(ticket, /^[a-f0-9]{64}$/.test(ticket) ? ticket : null);
  assert.equal(codeDigest(code), createHash('sha256').update(code).digest('hex'));
  assert.deepEqual([...code].map(char => PAIRING_CODE_ALPHABET.includes(char)), Array(8).fill(true));
});

test('pairing rejects a claim at the exact invitation expiry', async t => {
  const clock = clockAt('2026-10-12T10:00:00Z');
  const f = await fixture(t, { clock });
  const invitation = await f.makeInvitation();
  clock.state.now = Date.parse(invitation.expires_at);
  assert.equal((await f.claim(invitation)).status, 409);
  assert.equal((await readDevices(f.devices)).devices.some(device => device.digest === createHash('sha256').update(f.phoneKey).digest('hex')), false);
});

test('expired invitations release admission slots without individual polling', async t => {
  const clock = clockAt('2026-10-12T10:00:00Z');
  const f = await fixture(t, { clock });
  for (let i = 0; i < 8; i++) await f.makeInvitation();
  clock.state.now += 300000;
  const replacement = await f.makeInvitation();
  assert.equal(replacement.status, 'open');
});

test('retired onboarding history cannot disable existing credentials or renew an old QR', async t => {
  const clock = clockAt('2026-10-12T10:00:00Z');
  const f = await fixture(t, { clock });
  const first = await f.makeInvitation();
  const retire = async invitation => {
    assert.equal((await f.call(`/pairing/invitations/${invitation.invitation_id}/cancel`, {
      method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: randomUUID() }),
    })).status, 200);
    clock.state.now += 300001;
  };
  await retire(first);
  for (let i = 0; i < 100; i++) await retire(await f.makeInvitation());
  assert.equal((await f.call('/mobile/v1/bootstrap', { headers: { Authorization: `Bearer ${f.legacy.token}` } })).status, 200);
  const replay = await f.call('/pairing/invitations', {
    method: 'POST', headers: { ...f.adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: first.invitation_id, code_digest: codeDigest(first.code), ticket_digest: ticketDigest(first.ticket) }),
  });
  assert.notEqual(replay.status, 200);
});
