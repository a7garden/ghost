import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createGateway } from './server.mjs';
import { issueDevice, updateDevices } from './devices.mjs';


function allowedScope(capabilities = ['lifetime.read', 'lifetime.write'], pairedTargets = false) {
  return {
    kind: 'lifetime',
    ghost_ids: pairedTargets
      ? ['22222222-2222-7222-8222-222222222222', '33333333-3333-7333-8333-333333333333']
      : ['22222222-2222-7222-8222-222222222222'],
    conversation_ids: pairedTargets
      ? ['11111111-1111-7111-8111-111111111111', '44444444-4444-7444-8444-444444444444']
      : ['11111111-1111-7111-8111-111111111111'],
    capabilities,
  };
}

function snapshotFor(scope) {
  const ghostId = scope.ghost_ids[0], conversationId = scope.conversation_ids[0];
  const secondGhost = scope.ghost_ids[1] ?? randomUUID();
  const secondConversation = scope.conversation_ids[1] ?? randomUUID();
  const goalId = randomUUID(), hiddenGoalId = randomUUID();
  const workId = randomUUID(), hiddenWorkId = randomUUID();
  const acceptedDigest = 'a'.repeat(64), hiddenDigest = 'b'.repeat(64);
  return {
    snapshot: {
      protocol_version: 'ghost-lifetime/1', contract_revision: 1, mode: 'enabled', internal_secret: 'must-not-cross-scope',
      goals: [
        { id: goalId, revision: 1, requirement_digest: 'c'.repeat(64), prompt: 'allowed', accountable_ghost: ghostId, reply_conversation: conversationId, privacy: 'private', state: 'active', acceptance_spec: {} },
        { id: hiddenGoalId, revision: 1, requirement_digest: 'd'.repeat(64), prompt: 'other conversation', accountable_ghost: ghostId, reply_conversation: randomUUID(), privacy: 'private', state: 'active', acceptance_spec: {} },
      ],
      work: [
        { id: workId, goal_id: goalId, goal_revision: 1, owner: ghostId, owner_revision: 1, state: 'queued', execution_id: 'exec-allowed', cancellation: 'none', blocker: null },
        { id: hiddenWorkId, goal_id: goalId, goal_revision: 1, owner: randomUUID(), owner_revision: 1, state: 'queued', execution_id: 'exec-hidden', cancellation: 'none', blocker: null },
        { id: randomUUID(), goal_id: hiddenGoalId, goal_revision: 1, owner: ghostId, owner_revision: 1, state: 'queued', execution_id: 'exec-other-goal', cancellation: 'none', blocker: null },
      ],
      bindings: [
        { conversation_id: conversationId, ghost_id: ghostId, runtime_kind: 'worker', runtime_release: 'stable', storage_ref: 'allowed' },
        ...(scope.ghost_ids[1] ? [{ conversation_id: secondConversation, ghost_id: secondGhost, runtime_kind: 'worker', runtime_release: 'stable', storage_ref: 'second-scope' }] : []),
        { conversation_id: randomUUID(), ghost_id: ghostId, runtime_kind: 'worker', runtime_release: 'stable', storage_ref: 'hidden' },
      ],
      artifacts: [
        { digest: acceptedDigest, locator: 'allowed', privacy: 'private', producing_attempt: 'exec-allowed' },
        { digest: hiddenDigest, locator: 'hidden', privacy: 'private', producing_attempt: 'exec-hidden' },
        { digest: acceptedDigest, locator: 'foreign-same-content', privacy: 'private', producing_attempt: 'exec-hidden' },
      ],
      acceptances: [
        { work_id: workId, goal_revision: 1, requirement_digest: 'c'.repeat(64), artifact_digest: acceptedDigest, verifier_revision: 'v1', policy_revision: 1, checks: [] },
        { work_id: hiddenWorkId, goal_revision: 1, requirement_digest: 'd'.repeat(64), artifact_digest: hiddenDigest, verifier_revision: 'v1', policy_revision: 1, checks: [] },
      ],
    },
    ids: { goalId, hiddenGoalId, workId, hiddenWorkId, acceptedDigest, hiddenDigest, secondGhost, secondConversation },
  };
}

function response(data = null, retryClass = 'never') {
  return { status: 'success', summary: 'accepted', object_refs: [], artifacts: [], next_actions: [], error_code: null, retry_class: retryClass, data };
}
function ownerConversationTurn(id = randomUUID(), sequence = 1) {
  return {
    id, sequence, sender_kind: 'owner', sender_ref: 'owner', text: 'private owner input',
    privacy: 'private', kind: 'user', source_turn_id: null, attachments: [], created_at_ms: 1,
  };
}

function sourcedConversationTurn(id, sourceTurnId, kind = 'assistant_advisory', sequence = 1) {
  return {
    id, sequence, sender_kind: kind, sender_ref: 'ghost-private-identity', text: 'unverified stored turn',
    privacy: 'private', kind, source_turn_id: sourceTurnId, attachments: [], created_at_ms: 2,
  };
}

function lifetimeRunFor(body, overrides = {}) {
  return {
    turn_id: body.turn_id ?? randomUUID(),
    ghost_id: body.ghost_id,
    conversation_id: body.conversation_id,
    state: 'running',
    cancel_requested: false,
    cancel_command_id: null,
    submission_id: 'opaque-submission',
    entry_id: null,
    reason_code: null,
    latest_status_command_id: null,
    created_at_ms: 1,
    updated_at_ms: 2,
    ...overrides,
  };
}


async function fixture(t, {
  scope, snapshotData, fetchHost, registryEntries, conversationInputNoEffect = false,
  conversationPageData, conversationTurnRun, conversationCancelRun, conversationTurnNotFound = false,
  lifetimeAuthorityEpoch = 1, hostAuthorityEpoch, dispatchEnabled = true,
  workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', inferenceData,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-lifetime-'));
  const devices = join(dir, 'devices.json');
  const device = await issueDevice(devices, 'Test phone', scope);
  const dispatched = [];
  const hostReceipts = new Map();
  const fixtureSnapshot = scope ? (snapshotData ?? snapshotFor(scope)).snapshot : null;
  const fixtureRegistry = registryEntries ?? (scope ? [{
    ghost_id: scope.ghost_ids[0],
    kind: 'primary',
    conversation_id: scope.conversation_ids[0],
    roles: ['coordination'],
    mode: 'active',
  }] : []);
  const configuredHostEpoch = hostAuthorityEpoch ?? lifetimeAuthorityEpoch ?? 1;
  const ownerSnapshot = { workspace_id: workspaceId, lifetime_authority: { authority_epoch: configuredHostEpoch, dispatch_enabled: dispatchEnabled } };
  const upstream = fetchHost ?? (async (url, options) => {
    const target = new URL(url).pathname;
    const payload = options.body ? JSON.parse(Buffer.from(options.body).toString('utf8')) : null;
    dispatched.push({ url, options, payload });
    if (target === '/api/v1/snapshot' && options.method === 'GET') return Response.json(ownerSnapshot);
    if (target === '/api/v1/inference/settings' && inferenceData) return Response.json(inferenceData);
    const envelope = payload?.command?.envelope;
    if (envelope?.body?.method === 'registry.inspect') return Response.json({ ok: true, result: response({ registry: fixtureRegistry }) });
    if (envelope?.body?.method === 'conversation.inspect') {
      const page = conversationPageData ?? (() => {
        const turn = ownerConversationTurn();
        return {
          ghost_id: envelope.body.ghost_id,
          conversation_id: envelope.body.conversation_id,
          privacy: 'private',
          turns: [turn],
          turn_runs: [lifetimeRunFor(envelope.body, { turn_id: turn.id })],
          has_older: false,
          oldest_sequence: turn.sequence,
          internal_message: 'HOST_PRIVATE_PAGE_DETAIL',
        };
      })();
      return Response.json({ ok: true, result: response(page) });
    }
    if (envelope?.body?.method === 'conversation.turn.inspect') {
      if (conversationTurnNotFound) return Response.json({ ok: true, result: {
        status: 'warning', summary: 'No lifecycle row.', object_refs: [], artifacts: [], next_actions: [],
        error_code: 'not_found', retry_class: 'never', data: { run: 'not_found', internal_message: 'HOST_PRIVATE_NOT_FOUND' },
      } });
      const run = conversationTurnRun ?? lifetimeRunFor(envelope.body);
      return Response.json({ ok: true, result: response({ run, internal_message: 'HOST_PRIVATE_TURN_DETAIL' }) });
    }
    if (envelope?.body?.method === 'conversation.cancel_turn') {
      const run = conversationCancelRun ?? lifetimeRunFor(envelope.body, { cancel_requested: true });
      const savedResponse = response({ run, internal_message: 'HOST_PRIVATE_TURN_DETAIL' });
      hostReceipts.set(envelope.command_id, { authority_epoch: envelope.authority_epoch, payload_digest: envelope.payload_digest, response: savedResponse });
      return Response.json({ ok: true, result: savedResponse });
    }
    if (envelope?.body?.method === 'conversation.input') {
      const savedResponse = conversationInputNoEffect
        ? {
          status: 'error', summary: 'Host rejected the input before effect.', object_refs: [], artifacts: [], next_actions: [],
          error_code: 'invalid_request', retry_class: 'never',
          data: { host_effect_class: 'no_effect', internal_message: 'HOST_PRIVATE_DIAGNOSTIC' },
        }
        : {
          ...response({
            turn_id: envelope.command_id,
            sequence: hostReceipts.size + 1,
            privacy: envelope.body.privacy,
            queued: true,
          }),
          object_refs: [envelope.command_id],
        };
      hostReceipts.set(envelope.command_id, { authority_epoch: envelope.authority_epoch, payload_digest: envelope.payload_digest, response: savedResponse });
      return Response.json({ ok: true, result: savedResponse });
    }
    if (envelope?.body?.method === 'snapshot') return Response.json({ ok: true, result: response(fixtureSnapshot) });
    if (envelope?.body?.method === 'command.inspect') {
      const saved = hostReceipts.get(envelope.body.command_id);
      if (!saved) return Response.json({ ok: true, result: {
        status: 'warning', summary: 'No receipt exists.', object_refs: [], artifacts: [], next_actions: [],
        error_code: 'not_found', retry_class: 'reconcile_first',
        data: { command_id: envelope.body.command_id, found: false, host_receipt_secret: 'must-not-cross' },
      } });
      return Response.json({ ok: true, result: response({
        command_id: envelope.body.command_id,
        found: true,
        authority_epoch: saved.authority_epoch,
        payload_digest: saved.payload_digest,
        response: saved.response,
      }) });
    }
    const savedResponse = response({ accepted: true });
    if (envelope) hostReceipts.set(envelope.command_id, { authority_epoch: envelope.authority_epoch, payload_digest: envelope.payload_digest, response: savedResponse });
    return Response.json({ ok: true, result: savedResponse });
  });
  const server = createGateway({
    root: dir, devices, origin: 'https://ghost.example', lifetimeAuthorityEpoch,
    discoverHost: async () => ({ origin: 'http://127.0.0.1:54321', token: 'host-private' }),
    fetchHost: upstream,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  function call(path, { headers = {}, method = 'GET', body, token = device.token } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method,
        headers: { Host: 'ghost.example', Authorization: `Bearer ${token}`, ...headers } }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  return { dir, devices, device, call, dispatched, hostReceipts, server };
}

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
}

function lifetimeRequest(body, { commandId = randomUUID(), requestId = randomUUID(), authorityEpoch = 1 } = {}) {
  const envelope = {
    protocol_version: 'ghost-lifetime/1', command_id: commandId,
    payload_digest: createHash('sha256').update(canonicalJSON(body), 'utf8').digest('hex'),
    actor_ref: 'owner', authority_epoch: authorityEpoch, expected_revision: null,
    correlation_id: commandId, body,
  };
  return { requestId, body: JSON.stringify({ request_id: requestId, command: { type: 'lifetime', envelope } }), envelope };
}

async function callLifetime(f, body, options) {
  const wire = lifetimeRequest(body, options);
  const result = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: wire.body,
  });
  return { wire, result };
}

test('unscoped owner keys keep legacy behavior while malformed scopes fail closed', async t => {
  const f = await fixture(t);
  const bootstrap = JSON.parse((await f.call('/mobile/v1/bootstrap')).body);
  assert.equal(bootstrap.role, 'owner');
  assert.equal((await f.call('/mobile/v1/snapshot')).status, 200);
  assert.equal((await f.call('/mobile/v1/lifetime/snapshot')).status, 403);

  const malformed = { kind: 'lifetime', ghost_ids: [], conversation_ids: ['10663df5-c77e-49de-950e-e8bf2c0f99e0'], capabilities: ['lifetime.read'] };
  await assert.rejects(issueDevice(f.devices, 'Malformed', malformed), /Invalid lifetime device scope/);
  await updateDevices(f.devices, registry => { registry.devices[0].scope = malformed; });
  const before = f.dispatched.length;
  assert.equal((await f.call('/mobile/v1/bootstrap')).status, 502);
  assert.equal(f.dispatched.length, before);
});

test('lifetime routes stay unavailable until transport authority is configured', async t => {
  const f = await fixture(t, { scope: allowedScope(), lifetimeAuthorityEpoch: null });
  const result = await f.call('/mobile/v1/lifetime/snapshot');
  assert.equal(result.status, 503);
  assert.equal(JSON.parse(result.body).error, 'lifetime_transport_unconfigured');
  assert.equal(f.dispatched.length, 0);
});

test('scoped keys cannot use owner routes and snapshot/action targets stay within granted scope', async t => {
  const scope = allowedScope(['lifetime.read']);
  const snapshotData = snapshotFor(scope);
  const { ids } = snapshotData;
  const f = await fixture(t, { scope, snapshotData });
  const bootstrap = JSON.parse((await f.call('/mobile/v1/bootstrap')).body);
  assert.equal(bootstrap.role, 'lifetime');
  assert.deepEqual(bootstrap.scope, scope);
  assert.deepEqual(bootstrap.lifetime_identity, { actor_ref: 'owner', authority_epoch: 1 });
  assert.deepEqual(bootstrap.lifetime_host, {
    workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    authority_epoch: 1,
    dispatch_enabled: true,
  });
  assert.deepEqual(bootstrap.target_pairs, [{
    ghost_id: scope.ghost_ids[0],
    kind: 'primary',
    conversation_id: scope.conversation_ids[0],
    roles: ['coordination'],
    mode: 'active',
  }]);
  assert.equal((await f.call('/mobile/v1/snapshot')).status, 403);
  assert.equal((await f.call('/mobile/v1/action', { method: 'POST' })).status, 403);

  const snapshotResponse = await f.call('/mobile/v1/lifetime/snapshot');
  assert.equal(snapshotResponse.status, 200);
  const snapshot = JSON.parse(snapshotResponse.body);
  assert.deepEqual(snapshot.goals.map(goal => goal.id), [ids.goalId]);
  assert.deepEqual(snapshot.work.map(work => work.id), [ids.workId]);
  assert.deepEqual(snapshot.bindings.map(binding => binding.storage_ref), ['allowed']);
  assert.deepEqual(snapshot.artifacts.map(artifact => artifact.digest), [ids.acceptedDigest]);
  assert.deepEqual(snapshot.acceptances.map(acceptance => acceptance.work_id), [ids.workId]);
  assert.equal(snapshot.internal_secret, undefined);

  const callAction = async body => f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: lifetimeRequest(body).body,
  });
  const allowedGoal = await callAction({ goal_id: ids.goalId, method: 'goal.inspect' });
  assert.equal(allowedGoal.status, 200);
  const allowedWork = await callAction({ method: 'work.inspect', work_id: ids.workId });
  assert.equal(allowedWork.status, 200);
  const beforeDenied = f.dispatched.filter(item => item.options.method === 'POST' && item.payload?.command?.envelope?.body?.method !== 'snapshot').length;
  assert.equal((await callAction({ goal_id: ids.hiddenGoalId, method: 'goal.inspect' })).status, 404);
  assert.equal((await callAction({ method: 'work.inspect', work_id: ids.hiddenWorkId })).status, 404);
  assert.equal((await callAction({ conversation_id: scope.conversation_ids[0], ghost_id: scope.ghost_ids[0], method: 'goal.submit' })).status, 403);
  const afterDenied = f.dispatched.filter(item => item.options.method === 'POST' && item.payload?.command?.envelope?.body?.method !== 'snapshot').length;
  assert.equal(afterDenied, beforeDenied);
});


test('bootstrap rejects a Host authority epoch that differs from the configured pin', async t => {
  const scope = allowedScope();
  const mismatch = await fixture(t, { scope, lifetimeAuthorityEpoch: 1, hostAuthorityEpoch: 2 });
  const rejected = await mismatch.call('/mobile/v1/bootstrap');
  assert.equal(rejected.status, 502);
  assert.equal(JSON.parse(rejected.body).error, 'host_unavailable_or_outcome_unknown');
  assert.deepEqual(mismatch.dispatched.map(item => item.url.endsWith('/api/v1/snapshot')), [true]);

  const pinned = await fixture(t, { scope, lifetimeAuthorityEpoch: 2, hostAuthorityEpoch: 2 });
  const accepted = JSON.parse((await pinned.call('/mobile/v1/bootstrap')).body);
  assert.deepEqual(accepted.lifetime_identity, { actor_ref: 'owner', authority_epoch: 2 });
  assert.deepEqual(accepted.lifetime_host, {
    workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    authority_epoch: 2,
    dispatch_enabled: true,
  });
  assert.deepEqual(accepted.target_pairs, [{
    ghost_id: scope.ghost_ids[0],
    kind: 'primary',
    conversation_id: scope.conversation_ids[0],
    roles: ['coordination'],
    mode: 'active',
  }]);
});

test('bootstrap advertises only Host-registered pairs intersecting device scope', async t => {
  const scope = allowedScope(['lifetime.read', 'lifetime.write'], true);
  const [firstGhost, secondGhost] = scope.ghost_ids;
  const [firstConversation, secondConversation] = scope.conversation_ids;
  const registryEntries = [
    { ghost_id: firstGhost, kind: 'primary', conversation_id: secondConversation, roles: ['coordination'], mode: 'active' },
    { ghost_id: secondGhost, kind: 'specialist', conversation_id: firstConversation, roles: ['review'], mode: 'draining' },
    { ghost_id: randomUUID(), kind: 'specialist', conversation_id: randomUUID(), roles: ['hidden'], mode: 'active' },
  ];
  const f = await fixture(t, { scope, registryEntries });
  const bootstrap = JSON.parse((await f.call('/mobile/v1/bootstrap')).body);
  assert.deepEqual(bootstrap.target_pairs, registryEntries.slice(0, 2));
  assert.equal(bootstrap.target_pairs.some(target => target.ghost_id === firstGhost && target.conversation_id === firstConversation), false);
  assert.equal(bootstrap.target_pairs.some(target => target.ghost_id === secondGhost && target.conversation_id === secondConversation), false);
  const registryRequest = lifetimeRequest({ method: 'registry.inspect' });
  const scopedRegistry = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: registryRequest.body,
  });
  assert.equal(scopedRegistry.status, 200);
  assert.deepEqual(JSON.parse(scopedRegistry.body).result.data.registry, registryEntries.slice(0, 2));
});

test('conversation actions require the exact Host-registered target pair', async t => {
  const scope = allowedScope(['lifetime.read', 'lifetime.write'], true);
  const [firstGhost, secondGhost] = scope.ghost_ids;
  const [firstConversation, secondConversation] = scope.conversation_ids;
  const registryEntries = [
    { ghost_id: firstGhost, kind: 'primary', conversation_id: secondConversation, roles: ['coordination'], mode: 'active' },
    { ghost_id: secondGhost, kind: 'specialist', conversation_id: firstConversation, roles: ['review'], mode: 'active' },
  ];
  const f = await fixture(t, { scope, registryEntries });
  const wrongInput = lifetimeRequest({
    method: 'conversation.input',
    ghost_id: firstGhost,
    conversation_id: firstConversation,
    text: 'must not dispatch',
    privacy: 'private',
    attachments: [],
  });
  const deniedInput = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: wrongInput.body,
  });
  assert.equal(deniedInput.status, 403);
  assert.equal(JSON.parse(deniedInput.body).error, 'scope_denied');

  const wrongInspect = lifetimeRequest({
    method: 'conversation.inspect',
    ghost_id: firstGhost,
    conversation_id: firstConversation,
  });
  const deniedInspect = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: wrongInspect.body,
  });
  assert.equal(deniedInspect.status, 403);
  assert.equal(JSON.parse(deniedInspect.body).error, 'scope_denied');
  assert.equal(f.dispatched.some(item => ['conversation.input', 'conversation.inspect'].includes(item.payload?.command?.envelope?.body?.method)), false);

});

test('goal submission rejects independently permitted IDs that are not one binding pair', async t => {
  const scope = allowedScope(['lifetime.read', 'lifetime.write'], true);
  const f = await fixture(t, { scope });
  const wrongPair = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: lifetimeRequest({
      method: 'goal.submit',
      ghost_id: scope.ghost_ids[0],
      conversation_id: scope.conversation_ids[1],
      prompt: 'must not dispatch',
      privacy: 'private',
      acceptance_spec: {},
    }).body,
  });
  assert.equal(wrongPair.status, 403);
  assert.equal(JSON.parse(wrongPair.body).error, 'scope_denied');
  assert.equal(f.dispatched.some(item => item.payload?.command?.envelope?.body?.method === 'goal.submit'), false);
});

test('write-only devices receive metadata-only targets and submit without read or receipt calls', async t => {
  const scope = allowedScope(['lifetime.write']);
  const f = await fixture(t, { scope });
  const bootstrapResponse = await f.call('/mobile/v1/bootstrap');
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = JSON.parse(bootstrapResponse.body);
  assert.deepEqual(bootstrap.target_pairs, [{
    ghost_id: scope.ghost_ids[0],
    kind: 'primary',
    conversation_id: scope.conversation_ids[0],
    roles: ['coordination'],
    mode: 'active',
  }]);
  assert.equal(f.dispatched.some(item => item.payload?.command?.envelope?.body?.method === 'snapshot'), false);

  const submit = lifetimeRequest({
    method: 'goal.submit',
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    prompt: 'target must be verified without reading',
    privacy: 'private',
    acceptance_spec: {},
  });
  const deniedWrite = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: submit.body,
  });
  assert.equal(deniedWrite.status, 403);
  assert.equal(JSON.parse(deniedWrite.body).error, 'target_scope_unverifiable');

  const input = lifetimeRequest({
    method: 'conversation.input',
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    text: 'metadata-only write',
    privacy: 'private',
    attachments: [],
  });
  const acceptedWrite = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: input.body,
  });
  assert.equal(acceptedWrite.status, 200);
  assert.equal(JSON.parse(acceptedWrite.body).result.data.queued, true);

  const beforeDeniedRead = f.dispatched.length;
  const inspect = lifetimeRequest({ method: 'command.inspect', command_id: randomUUID() });
  const deniedRead = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: inspect.body,
  });
  assert.equal(deniedRead.status, 403);
  assert.equal(JSON.parse(deniedRead.body).error, 'capability_denied');
  assert.equal(f.dispatched.length, beforeDeniedRead);
  assert.equal(f.dispatched.some(item => item.payload?.command?.envelope?.body?.method === 'snapshot'), false);
  assert.equal(f.dispatched.some(item => item.payload?.command?.envelope?.body?.method === 'command.inspect'), false);
  assert.equal(f.dispatched.some(item => item.payload?.command?.envelope?.body?.method === 'conversation.input'), true);
});

test('conversation input receipts remain bound to the original device command', async t => {
  const scope = allowedScope();
  const f = await fixture(t, { scope });
  const originalCommandId = randomUUID();
  const input = lifetimeRequest({
    method: 'conversation.input',
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    text: 'durable owner turn',
    privacy: 'private',
    attachments: [],
  }, { commandId: originalCommandId });
  const accepted = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: input.body,
  });
  assert.equal(accepted.status, 200);
  const submittedTurnId = JSON.parse(accepted.body).result.data.turn_id;

  const inspect = lifetimeRequest({ method: 'command.inspect', command_id: originalCommandId });
  const receipt = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: inspect.body,
  });
  const receiptBody = JSON.parse(receipt.body);
  assert.equal(receipt.status, 200);
  assert.equal(receiptBody.result.data.found, true);
  assert.equal(receiptBody.result.data.response.data.turn_id, submittedTurnId);
  assert.equal(receiptBody.result.data.payload_digest, input.envelope.payload_digest);
});

test('conversation input receipts preserve no-effect classification without leaking Host details', async t => {
  const scope = allowedScope();
  const f = await fixture(t, { scope, conversationInputNoEffect: true });
  const originalCommandId = randomUUID();
  const input = lifetimeRequest({
    method: 'conversation.input',
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    text: 'rejected input',
    privacy: 'private',
    attachments: [],
  }, { commandId: originalCommandId });
  const direct = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: input.body,
  });
  const directBody = JSON.parse(direct.body);
  assert.equal(direct.status, 200);
  assert.equal(directBody.result.status, 'error');
  assert.equal(directBody.result.error_code, 'invalid_request');
  assert.equal(directBody.result.retry_class, 'never');
  assert.deepEqual(directBody.result.data, { host_effect_class: 'no_effect' });
  assert.equal(JSON.stringify(directBody).includes('HOST_PRIVATE_DIAGNOSTIC'), false);

  const inspect = lifetimeRequest({ method: 'command.inspect', command_id: originalCommandId });
  const receipt = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: inspect.body,
  });
  const receiptBody = JSON.parse(receipt.body);
  assert.equal(receipt.status, 200);
  assert.equal(receiptBody.result.data.found, true);
  assert.deepEqual(receiptBody.result.data.response.data, { host_effect_class: 'no_effect' });
  assert.equal(receiptBody.result.data.response.error_code, 'invalid_request');
  assert.equal(receiptBody.result.data.payload_digest, input.envelope.payload_digest);
  assert.equal(JSON.stringify(receiptBody).includes('HOST_PRIVATE_DIAGNOSTIC'), false);
});

test('command receipts stay in the originating device namespace', async t => {
  const scope = allowedScope();
  const f = await fixture(t, { scope });
  const originalCommandId = randomUUID();
  const submit = lifetimeRequest({
    method: 'goal.submit',
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    prompt: 'scoped receipt',
    privacy: 'private',
    acceptance_spec: {},
  }, { commandId: originalCommandId });
  assert.equal((await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: submit.body,
  })).status, 200);
  const namespaced = deviceId => `${deviceId}:${createHash('sha256').update(originalCommandId, 'utf8').digest('hex')}`;
  const firstHostId = namespaced(f.device.id);
  assert.equal(f.hostReceipts.has(firstHostId), true);

  const inspect = lifetimeRequest({ method: 'command.inspect', command_id: originalCommandId });
  const found = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: inspect.body,
  });
  const foundBody = JSON.parse(found.body);
  assert.equal(found.status, 200);
  assert.equal(foundBody.result.data.command_id, originalCommandId);
  assert.equal(foundBody.result.data.found, true);
  assert.equal(foundBody.result.data.authority_epoch, 1);
  assert.deepEqual(foundBody.result.data.response, f.hostReceipts.get(firstHostId).response);

  const otherDevice = await issueDevice(f.devices, 'Other phone', scope);
  const foreignLookup = await f.call('/mobile/v1/lifetime/action', {
    token: otherDevice.token,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: inspect.body,
  });
  const absentBody = JSON.parse(foreignLookup.body);
  assert.equal(foreignLookup.status, 200);
  assert.deepEqual(absentBody.result.data, { command_id: originalCommandId, found: false });
  assert.equal(JSON.stringify(absentBody).includes('host_receipt_secret'), false);
  const mappedLookup = f.dispatched.filter(item => item.payload?.command?.envelope?.body?.method === 'command.inspect' && item.payload.request_id === inspect.requestId).slice(-1)[0];
  assert.equal(mappedLookup.payload.command.envelope.body.command_id, namespaced(otherDevice.id));
  assert.notEqual(namespaced(otherDevice.id), firstHostId);
});

test('command.inspect suppresses a found receipt with foreign scoped data', async t => {
  const scope = allowedScope();
  const snapshotData = snapshotFor(scope);
  const { ids } = snapshotData;
  const original = {
    ...response({ goal: {
      id: ids.hiddenGoalId,
      accountable_ghost: scope.ghost_ids[0],
      reply_conversation: randomUUID(),
      prompt: 'FOREIGN_RECEIPT_SECRET',
    } }),
    object_refs: [ids.hiddenGoalId],
  };
  const f = await fixture(t, {
    scope,
    snapshotData,
    fetchHost: async (url, options) => {
      if (new URL(url).pathname === '/api/v1/snapshot' && options.method === 'GET') return Response.json({
        workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        lifetime_authority: { authority_epoch: 1, dispatch_enabled: true },
      });
      const payload = JSON.parse(Buffer.from(options.body).toString('utf8'));
      const envelope = payload.command.envelope;
      if (envelope.body.method === 'snapshot') return Response.json({ ok: true, result: response(snapshotData.snapshot) });
      if (envelope.body.method === 'command.inspect') return Response.json({ ok: true, result: response({
        command_id: envelope.body.command_id,
        found: true,
        authority_epoch: 1,
        response: original,
      }) });
      return Response.json({ ok: true, result: response() });
    },
  });
  const requested = lifetimeRequest({ method: 'command.inspect', command_id: randomUUID() });
  const result = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requested.body,
  });
  const body = JSON.parse(result.body);
  assert.equal(result.status, 200);
  assert.equal(body.result.error_code, 'receipt_scope_denied');
  assert.equal(JSON.stringify(body).includes(ids.hiddenGoalId), false);
  assert.equal(JSON.stringify(body).includes('FOREIGN_RECEIPT_SECRET'), false);
});

test('dispatch-disabled Host metadata preserves reads and rejects mutations', async t => {
  const scope = allowedScope();
  const f = await fixture(t, { scope, dispatchEnabled: false });
  assert.equal((await f.call('/mobile/v1/lifetime/snapshot')).status, 200);
  const submitted = lifetimeRequest({
    method: 'goal.submit',
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    prompt: 'must remain read-only',
    privacy: 'private',
    acceptance_spec: {},
  });
  const result = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: submitted.body,
  });
  assert.equal(result.status, 409);
  assert.equal(JSON.parse(result.body).error, 'dispatch_disabled');
  assert.equal(f.dispatched.some(item => item.payload?.command?.envelope?.body?.method === 'goal.submit'), false);
  const conversationInput = lifetimeRequest({
    method: 'conversation.input',
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    text: 'must remain read-only',
    privacy: 'private',
    attachments: [],
  });
  const disabledInput = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: conversationInput.body,
  });
  assert.equal(disabledInput.status, 409);
  assert.equal(JSON.parse(disabledInput.body).error, 'dispatch_disabled');
  assert.equal(f.dispatched.some(item => item.payload?.command?.envelope?.body?.method === 'conversation.input'), false);
});

test('scoped requests enforce origin and payload bounds before Host dispatch', async t => {
  const f = await fixture(t, { scope: allowedScope() });
  assert.equal((await f.call('/mobile/v1/lifetime/snapshot', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const oversized = await f.call('/mobile/v1/lifetime/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(1_048_577),
  });
  assert.equal(oversized.status, 413);
  assert.equal(f.dispatched.length, 0);
});

test('lifetime snapshot reads are rate limited per scoped device', async t => {
  const f = await fixture(t, { scope: allowedScope() });
  for (let index = 0; index < 60; index++) {
    assert.equal((await f.call('/mobile/v1/lifetime/snapshot')).status, 200);
  }
  const limited = await f.call('/mobile/v1/lifetime/snapshot');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal(f.dispatched.length, 120);
});

test('revocation aborts a long in-flight lifetime response', async t => {
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let streamController, signalAborted = false;
  const f = await fixture(t, {
    scope: allowedScope(),
    fetchHost: async (_url, options) => {
      if (options.method === 'GET') return Response.json({
        workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        lifetime_authority: { authority_epoch: 1, dispatch_enabled: true },
      });
      const stream = new ReadableStream({
        start(controller) {
          streamController = controller;
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          markStarted();
        },
      });
      options.signal.addEventListener('abort', () => {
        signalAborted = true;
        try { streamController.error(new Error('revoked')); } catch {}
      }, { once: true });
      return new Response(stream, { headers: { 'Content-Type': 'application/json' } });
    },
  });

  const inFlight = f.call('/mobile/v1/lifetime/snapshot');
  await started;
  await updateDevices(f.devices, registry => { registry.devices = []; });
  let timeout;
  const result = await Promise.race([
    inFlight,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('revocation did not abort the stream')), 3000); }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(result.status, 401);
  assert.equal(signalAborted, true);
});

test('canonical conversation page preserves only exact referenced controller runs', async t => {
  const scope = allowedScope();
  const turnID = randomUUID();
  const sourceTurnID = randomUUID();
  const run = lifetimeRunFor({
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    turn_id: turnID,
  }, { state: 'answered', entry_id: 'opaque-entry' });
  const sourceRun = lifetimeRunFor({
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    turn_id: sourceTurnID,
  }, { state: 'queued' });
  const page = {
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    privacy: 'private',
    turns: [
      ownerConversationTurn(turnID),
      sourcedConversationTurn(randomUUID(), sourceTurnID, 'host_fact', 2),
    ],
    turn_runs: [run, sourceRun],
    has_older: false,
    oldest_sequence: 1,
    internal_message: 'HOST_PRIVATE_PAGE_DETAIL',
  };
  const f = await fixture(t, { scope, conversationPageData: page });
  const { result } = await callLifetime(f, {
    method: 'conversation.inspect',
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    limit: 100,
  });
  assert.equal(result.status, 200);
  const sanitized = JSON.parse(result.body).result;
  assert.deepEqual(sanitized.data.turn_runs, [run, sourceRun]);
  assert.equal(sanitized.data.internal_message, undefined);
  assert.equal(result.body.includes('HOST_PRIVATE_PAGE_DETAIL'), false);
});

test('canonical conversation page rejects foreign, malformed, unreferenced, and extra-field runs', async t => {
  const scope = allowedScope();
  const cases = [
    ['foreign conversation', run => ({ ...run, conversation_id: randomUUID() })],
    ['unreferenced turn', (run) => ({ ...run, turn_id: randomUUID() })],
    ['unknown state', run => ({ ...run, state: 'completed' })],
    ['unknown failure reason', run => ({ ...run, state: 'failed', reason_code: 'HOST_PRIVATE_REASON' })],
    ['non-boolean cancel request', run => ({ ...run, cancel_requested: 'true' })],
    ['extra private field', run => ({ ...run, model_prompt: 'HOST_PRIVATE_RUN_DETAIL' })],
    ['negative timestamp', run => ({ ...run, updated_at_ms: -1 })],
    ['duplicate run', run => [run, { ...run }]],
    ['missing run list', run => null],
  ];
  for (const [label, modify] of cases) {
    const turnID = randomUUID();
    const body = {
      ghost_id: scope.ghost_ids[0],
      conversation_id: scope.conversation_ids[0],
      turn_id: turnID,
    };
    const run = modify(lifetimeRunFor(body), body);
    const page = {
      ghost_id: body.ghost_id,
      conversation_id: body.conversation_id,
      privacy: 'private',
      turns: [ownerConversationTurn(turnID)],
      turn_runs: Array.isArray(run) ? run : run ? [run] : undefined,
      has_older: false,
      oldest_sequence: 1,
    };
    const f = await fixture(t, { scope, conversationPageData: page });
    const { result } = await callLifetime(f, {
      method: 'conversation.inspect',
      ghost_id: body.ghost_id,
      conversation_id: body.conversation_id,
      limit: 100,
    });
    assert.equal(result.status, 502, label);
    assert.equal(result.body.includes('HOST_PRIVATE'), false, label);
  }
});

test('turn requests require one exact target and internal status remains denied', async t => {
  const scope = allowedScope();
  const f = await fixture(t, { scope });
  const target = {
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
  };
  for (const method of ['conversation.turn.inspect', 'conversation.cancel_turn']) {
    for (const body of [
      { method, ...target },
      { method, ...target, turn_id: randomUUID(), unexpected: 'must-not-dispatch' },
    ]) {
      const { result } = await callLifetime(f, body);
      assert.equal(result.status, 400);
    }
  }
  const base = { method: 'conversation.turn.inspect', ...target };
  const { result: internalStatus } = await callLifetime(f, {
    ...base,
    method: 'conversation.turn_status',
    turn_id: randomUUID(),
  });
  assert.equal(internalStatus.status, 403);
  assert.equal(f.dispatched.length, 0);
});

test('turn inspection remains readable dispatch-off while exact cancellation is denied', async t => {
  const scope = allowedScope();
  const target = {
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    turn_id: randomUUID(),
  };
  const run = lifetimeRunFor(target);
  const f = await fixture(t, {
    scope,
    dispatchEnabled: false,
    conversationTurnRun: run,
  });
  const { result: inspected } = await callLifetime(f, {
    method: 'conversation.turn.inspect',
    ...target,
  });
  assert.equal(inspected.status, 200);
  assert.deepEqual(JSON.parse(inspected.body).result.data.run, run);
  const { result: cancelled } = await callLifetime(f, {
    method: 'conversation.cancel_turn',
    ...target,
  });
  assert.equal(cancelled.status, 409);
  const hostMethods = f.dispatched
    .map(item => item.payload?.command?.envelope?.body?.method)
    .filter(Boolean);
  assert.ok(hostMethods.includes('conversation.turn.inspect'));
  assert.equal(hostMethods.includes('conversation.cancel_turn'), false);
  assert.equal(cancelled.body.includes('HOST_PRIVATE'), false);
});

test('turn cancellation keeps request separate from terminal state and recovers the original receipt', async t => {
  const scope = allowedScope();
  const target = {
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    turn_id: randomUUID(),
  };
  const inspectedRun = lifetimeRunFor(target);
  const cancellationRun = lifetimeRunFor(target, {
    cancel_requested: true,
    cancel_command_id: 'opaque-cancel-command',
  });
  const f = await fixture(t, {
    scope,
    conversationTurnRun: inspectedRun,
    conversationCancelRun: cancellationRun,
  });
  const { result: inspected } = await callLifetime(f, {
    method: 'conversation.turn.inspect',
    ...target,
  });
  assert.equal(inspected.status, 200);
  assert.deepEqual(JSON.parse(inspected.body).result.data.run, inspectedRun);

  const commandId = randomUUID();
  const { wire: cancelWire, result: cancelled } = await callLifetime(f, {
    method: 'conversation.cancel_turn',
    ...target,
  }, { commandId });
  assert.equal(cancelled.status, 200);
  const cancelResult = JSON.parse(cancelled.body).result;
  assert.deepEqual(cancelResult.data.run, cancellationRun);
  assert.equal(cancelResult.data.run.state, 'running');
  assert.equal(cancelResult.data.run.cancel_requested, true);
  assert.equal(cancelResult.data.internal_message, undefined);
  const forwarded = f.dispatched.find(item =>
    item.payload?.command?.envelope?.body?.method === 'conversation.cancel_turn');
  assert.ok(forwarded);
  assert.equal(forwarded.payload.request_id, cancelWire.requestId);
  assert.notEqual(forwarded.payload.command.envelope.command_id, cancelWire.envelope.command_id);
  assert.equal(forwarded.payload.command.envelope.payload_digest, cancelWire.envelope.payload_digest);
  assert.deepEqual(forwarded.payload.command.envelope.body, {
    method: 'conversation.cancel_turn',
    ...target,
  });

  const { result: receipt } = await callLifetime(f, {
    method: 'command.inspect',
    command_id: cancelWire.envelope.command_id,
  });
  assert.equal(receipt.status, 200);
  const receiptData = JSON.parse(receipt.body).result.data;
  assert.equal(receiptData.command_id, cancelWire.envelope.command_id);
  assert.equal(receiptData.payload_digest, cancelWire.envelope.payload_digest);
  assert.equal(receiptData.authority_epoch, cancelWire.envelope.authority_epoch);
  const receiptRun = receiptData.response.data.run;
  assert.deepEqual(receiptRun, cancellationRun);
  assert.equal(receipt.body.includes('HOST_PRIVATE'), false);
});

test('target pairs reject cross-pair controller requests without Cartesian scope widening', async t => {
  const scope = allowedScope(['lifetime.read', 'lifetime.write'], true);
  const entries = [
    { ghost_id: scope.ghost_ids[0], kind: 'primary', conversation_id: scope.conversation_ids[0], roles: ['coordination'], mode: 'active' },
    { ghost_id: scope.ghost_ids[1], kind: 'primary', conversation_id: scope.conversation_ids[1], roles: ['coordination'], mode: 'active' },
  ];
  const f = await fixture(t, { scope, registryEntries: entries });
  const crossedTarget = {
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[1],
    turn_id: randomUUID(),
  };
  for (const method of ['conversation.turn.inspect', 'conversation.cancel_turn']) {
    const { result } = await callLifetime(f, { method, ...crossedTarget });
    assert.equal(result.status, 403);
  }
  const hostMethods = f.dispatched
    .map(item => item.payload?.command?.envelope?.body?.method)
    .filter(Boolean);
  assert.equal(hostMethods.includes('conversation.turn.inspect'), false);
  assert.equal(hostMethods.includes('conversation.cancel_turn'), false);
});

test('canonical conversation runs cannot identify an assistant turn as the Owner intent', async t => {
  const scope = allowedScope();
  const ownerTurnID = randomUUID();
  const assistantTurnID = randomUUID();
  const body = {
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    turn_id: assistantTurnID,
  };
  const page = {
    ghost_id: body.ghost_id,
    conversation_id: body.conversation_id,
    privacy: 'private',
    turns: [
      ownerConversationTurn(ownerTurnID, 1),
      sourcedConversationTurn(assistantTurnID, ownerTurnID, 'assistant_advisory', 2),
    ],
    turn_runs: [lifetimeRunFor(body)],
    has_older: false,
    oldest_sequence: 1,
  };
  const f = await fixture(t, { scope, conversationPageData: page });
  const { result } = await callLifetime(f, {
    method: 'conversation.inspect',
    ghost_id: body.ghost_id,
    conversation_id: body.conversation_id,
    limit: 100,
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.includes(assistantTurnID), false);
});

test('controller methods reject Host ok-false envelopes without leaking upstream diagnostics', async t => {
  const scope = allowedScope();
  const hostMethods = [];
  const registry = [{
    ghost_id: scope.ghost_ids[0],
    kind: 'primary',
    conversation_id: scope.conversation_ids[0],
    roles: ['coordination'],
    mode: 'active',
  }];
  const f = await fixture(t, {
    scope,
    fetchHost: async (url, options) => {
      const target = new URL(url).pathname;
      const payload = options.body ? JSON.parse(Buffer.from(options.body).toString('utf8')) : null;
      const method = payload?.command?.envelope?.body?.method;
      if (options.method === 'GET' && target === '/api/v1/snapshot') {
        return Response.json({
          workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          lifetime_authority: { authority_epoch: 1, dispatch_enabled: true },
        });
      }
      hostMethods.push(method);
      if (method === 'registry.inspect') {
        return Response.json({ ok: true, result: response({ registry }) });
      }
      return Response.json({ ok: false, error: 'HOST_PRIVATE_DIAGNOSTIC' });
    },
  });
  const target = {
    ghost_id: scope.ghost_ids[0],
    conversation_id: scope.conversation_ids[0],
    turn_id: randomUUID(),
  };
  for (const method of ['conversation.turn.inspect', 'conversation.cancel_turn']) {
    const { result } = await callLifetime(f, { method, ...target });
    assert.equal(result.status, 502);
    assert.equal(result.body.includes('HOST_PRIVATE_DIAGNOSTIC'), false);
  }
  assert.ok(hostMethods.includes('conversation.turn.inspect'));
  assert.ok(hostMethods.includes('conversation.cancel_turn'));
});

test('provider settings use the direct Host contract and withhold other conversation grants',async t=>{
 const scope=allowedScope();const key=`${scope.ghost_ids[0]}/${scope.conversation_ids[0]}`;
 const inferenceData={ok:true,settings:{version:2,default:{provider:'codex',model:'gpt-6-luna',effort:'high'},conversations:{[key]:{provider:'codex',model:'gpt-6-luna',effort:'high'},'FOREIGN/PAIR':{provider:'minimax'}},external_grants:{[key]:['codex'],'FOREIGN/PAIR':['minimax']},credentials:{minimax:true},image_provider:'codex'},providers:[{id:'codex'}]};
 const f=await fixture(t,{scope,inferenceData});const response=await f.call('/mobile/v1/inference/settings');
 assert.equal(response.status,200);const value=JSON.parse(response.body);assert.equal(value.settings.version,2);assert.deepEqual(Object.keys(value.settings.conversations),[key]);assert.deepEqual(Object.keys(value.settings.external_grants),[key]);assert.equal(response.body.includes('FOREIGN'),false);
 for(const operation of [{operation:'set_api_key',version:2,provider:'minimax',api_key:'TEST_SECRET'},{operation:'set_default',version:2,selection:inferenceData.settings.default},{operation:'select',version:2,ghost_id:scope.ghost_ids[0],conversation_id:randomUUID(),selection:inferenceData.settings.default}]){
  const result=await f.call('/mobile/v1/inference/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(operation)});assert.equal(result.status,403);
 }
 assert.equal(f.dispatched.some(r=>r.url.endsWith('/inference/settings')&&r.options.method==='POST'),false);
});
test('read-only phone cannot change providers or start image generation',async t=>{
 const f=await fixture(t,{scope:allowedScope(['lifetime.read'])});
 for(const path of ['/mobile/v1/inference/settings','/mobile/v1/inference/images']){assert.equal((await f.call(path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);}
 assert.equal(f.dispatched.length,0);
});
