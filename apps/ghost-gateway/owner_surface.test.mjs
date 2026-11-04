import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerSurface } from './owner_surface.mjs';

const GHOST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EXECUTION = '44444444-4444-4444-8444-444444444444';
const ACTION = 'ba-33333333-3333-4333-8333-333333333333';
const EPOCH = 7;
const device = (changes = {}) => ({ id: 'fixture-device', scope: {
  kind: 'lifetime', ghost_ids: [GHOST], conversation_ids: [CONVERSATION],
  capabilities: ['lifetime.read', 'lifetime.write'], ...changes,
} });
const action = () => ({ action_id: ACTION, computer_id: 'fixture-computer',
  execution_id: `worker:${EXECUTION}`, arguments_digest: 'a'.repeat(64),
  requested_epoch: EPOCH, state: 'pending', approved_by: null,
  detail: { operation: 'click', url: 'https://example.test/private', snapshot_id: 3,
    target: { ref: 'e12', role: 'button', name: 'Continue' }, value: null,
    profile_scope: 'private', authority_epoch: EPOCH },
});
const decision = (changes = {}) => ({ ghost_id: GHOST, action_id: ACTION,
  decision: 'approve', execution_id: `worker:${EXECUTION}`,
  arguments_digest: 'a'.repeat(64), snapshot_id: 3, requested_epoch: EPOCH,
  url: 'https://example.test/private', ...changes,
});
function request(value) {
  return { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(value)); } };
}
function harness({ pairs = [{ ghost_id: GHOST, conversation_id: CONVERSATION, mode: 'active' }],
  work = { id: 'fixture-work', goal_id: 'fixture-goal', goal_revision: 2,
    owner: GHOST, execution_id: EXECUTION, cancellation: 'none' },
  revision = 2, actions = [action()], dispatch = true, failListing = false,
  lifetimeIdentity = { actor_ref: 'owner', authority_epoch: EPOCH },
} = {}) {
  let decisions = 0;
  const surface = createOwnerSurface({
    json: (_res, status, body) => ({ status, body }),
    bounded: async source => Buffer.concat(await Array.fromAsync(source)),
    isRecord: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    root: '/tmp/ghost-owner-fixture', discoverHost: async () => ({}),
    lifetimeIdentity,
    lifetimeHostAuthority: async () => ({ authority: { authority_epoch: EPOCH, dispatch_enabled: dispatch } }),
    lifetimeTargetPairs: async (_host, d) => ({ target_pairs: pairs.filter(pair =>
      d.scope.ghost_ids.includes(pair.ghost_id) && d.scope.conversation_ids.includes(pair.conversation_id)) }),
    lifetimeSnapshot: async () => ({ snapshot: { goals: [{ id: 'fixture-goal', revision }], work: work ? [work] : [] } }),
    hostRequest: async (_host, _path, _method, bytes) => {
      const command = JSON.parse(bytes).command.action;
      if (command.verb === 'pending_browser_actions') {
        if (failListing) throw new Error('private provider detail');
        return { upstream: { status: 200 }, data: { ok: true, result: actions } };
      }
      decisions++;
      return { upstream: { status: 200 }, data: { ok: true, result: { action: {}, wake: {} } } };
    },
  });
  return { surface, decisions: () => decisions };
}

test('a registered Ghost in another conversation grants neither questions nor decisions nor lifecycle', async () => {
  const h = harness({ pairs: [{ ghost_id: GHOST, conversation_id: 'ungranted', mode: 'active' }] });
  const questions = await h.surface.handle('questions', {}, null, device(), 'fixture');
  assert.deepEqual(questions.body.questions, []);
  for (const [kind, value] of [['decision', decision()], ['lifecycle', { ghost_id: GHOST, operation: 'stop' }]]) {
    const reply = await h.surface.handle(kind, request(value), null, device(), 'fixture');
    assert.equal(reply.status, 403);
  }
  assert.equal(h.decisions(), 0);
});

test('questions exclude executions outside the scoped snapshot and superseded Goal revisions', async () => {
  for (const options of [{ work: null }, { revision: 3 }, { work: {
    id: 'foreign', goal_id: 'fixture-goal', goal_revision: 2, owner: OTHER,
    execution_id: EXECUTION, cancellation: 'none',
  } }]) {
    const h = harness(options);
    const reply = await h.surface.handle('questions', {}, null, device(), 'fixture');
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.questions, []);
  }
});

test('question authority from an older generation is not disclosed', async () => {
  const older = action(); older.requested_epoch--;
  const h = harness({ actions: [older] });
  const reply = await h.surface.handle('questions', {}, null, device(), 'fixture');
  assert.deepEqual(reply.body.questions, []);
});

test('approval refuses changed displayed target facts without recording a decision', async () => {
  for (const change of [{ snapshot_id: 4 }, { arguments_digest: 'b'.repeat(64) },
    { url: 'https://example.test/changed' }, { requested_epoch: EPOCH + 1 }]) {
    const h = harness();
    const reply = await h.surface.handle('decision', request(decision(change)), null, device(), 'fixture');
    assert.equal(reply.status, 409);
    assert.equal(h.decisions(), 0);
  }
});

test('approval refuses absent, superseded, cancelled or differently owned work', async () => {
  for (const options of [{ work: null }, { revision: 3 }, { work: {
    id: 'cancelled', goal_id: 'fixture-goal', goal_revision: 2, owner: GHOST,
    execution_id: EXECUTION, cancellation: 'requested',
  } }, { work: {
    id: 'foreign', goal_id: 'fixture-goal', goal_revision: 2, owner: OTHER,
    execution_id: EXECUTION, cancellation: 'none',
  } }]) {
    const h = harness(options);
    const reply = await h.surface.handle('decision', request(decision()), null, device(), 'fixture');
    assert.equal(reply.status, 409);
    assert.equal(h.decisions(), 0);
  }
});

test('read-only authority and missing write capability prohibit effects', async () => {
  const h = harness({ dispatch: false });
  for (const [kind, value] of [['decision', decision()], ['lifecycle', { ghost_id: GHOST, operation: 'stop' }]]) {
    const reply = await h.surface.handle(kind, request(value), null, device(), 'fixture');
    assert.equal(reply.status, 409);
  }
  const noWrite = harness();
  const denied = await noWrite.surface.handle('decision', request(decision()), null,
    device({ capabilities: ['lifetime.read'] }), 'fixture');
  assert.equal(denied.status, 403);
  assert.equal(h.decisions() + noWrite.decisions(), 0);
});

test('malformed decisions and ungranted Ghosts fail closed', async () => {
  const h = harness();
  for (const [value, expected] of [[{}, 400], [decision({ ghost_id: OTHER }), 403],
    [decision({ unexpected: true }), 400]]) {
    const reply = await h.surface.handle('decision', request(value), null, device(), 'fixture');
    assert.equal(reply.status, expected);
  }
  assert.equal(h.decisions(), 0);
});

test('provider failure cannot disclose its private diagnostic text', async () => {
  const h = harness({ failListing: true });
  const reply = await h.surface.handle('questions', {}, null, device(), 'fixture');
  assert.equal(reply.status, 502);
  assert.equal(JSON.stringify(reply).includes('private provider detail'), false);
});

test('voice-only deployments do not grant owner control', async () => {
  const h = harness({ lifetimeIdentity: null });
  for (const kind of ['questions', 'decision', 'lifecycle']) {
    assert.equal((await h.surface.handle(kind, {}, null, device(), 'fixture')).status, 503);
  }
});
