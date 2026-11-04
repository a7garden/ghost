import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SelectedTaskAdmissionDoc, selectedTaskIntent, selectedTaskAuthority, selectedTaskObservation } from '../src/selected-task-admission.js';
import { payloadDigest } from '../src/contract.js';
import { openAdmissionFixture, hostState, inspection, receipt, scope, task } from './fixtures/selected-admission-fixture.mjs';

const within = (promise, ms = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Controlled admission barrier expired')), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const snapshot = fixture => fixture.session.harness.snapshot(SelectedTaskAdmissionDoc, fixture.session.root.id, scope.turn_id, fixture.session.context);

test('explicit recovery never first-starts an unattempted SDK admission task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-selected-unattempted-')); let fixture;
  try {
    fixture = await openAdmissionFixture(root);
    const intent = selectedTaskIntent(scope, task);
    const id = await fixture.session.root.commit(async tx => {
      const doc = await tx.doc(SelectedTaskAdmissionDoc, fixture.session.root.id, scope.turn_id, intent);
      doc.task_id = await tx.createTask(fixture.admission.tasks[0], { intent }, { ownership: { kind: 'conversation' } });
      return doc.task_id;
    }, fixture.session.context);
    const before = JSON.stringify(await snapshot(fixture));
    const record = await fixture.database.get('SELECT record FROM tasks WHERE id=?', id);
    assert.equal((await snapshot(fixture)).dispatch_started, false);
    assert.equal((await fixture.session.harness.inspect(fixture.session.context)).scheduling, 'paused');
    await assert.rejects(fixture.admission.validateRecovery(fixture.session, scope.turn_id, intent.operation_id), /authority/);
    await assert.rejects(fixture.admission.reconcile(fixture.session, scope.turn_id, 'unattempted-recovery', intent.operation_id), /authority/);
    assert.equal(JSON.stringify(await snapshot(fixture)), before);
    assert.deepEqual(await fixture.database.get('SELECT record FROM tasks WHERE id=?', id), record);
    assert.equal((await fixture.session.harness.inspect(fixture.session.context)).scheduling, 'paused', 'target rejection cannot resume pending SDK work');
    assert.equal(fixture.state.calls.length, 0); assert.equal(fixture.state.effects, 0);
  } finally { await fixture?.close(); await rm(root, { recursive: true, force: true }); }
});

test('selected admission validates scope and uses one durable SDK operation with the exact callback identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-selected-once-')); let fixture;
  try {
    fixture = await openAdmissionFixture(root);
    const result = await within(fixture.admission.ensure(fixture.session, scope.turn_id));
    assert.equal(result.state, 'admitted'); assert.equal(result.provenance, 'runtime_created');
    const doc = await snapshot(fixture), original = JSON.stringify(doc);
    assert.equal(doc.dispatch_started, true); assert.equal(doc.outcome.state, 'admitted');
    const outbound = fixture.state.calls[0];
    assert.equal(outbound.envelope.command_id, doc.intent.command_id);
    assert.equal(outbound.envelope.payload_digest, doc.intent.body_digest);
    assert.deepEqual(outbound.envelope.body, doc.intent.body);
    assert.equal(payloadDigest(outbound.envelope.body), doc.intent.body_digest);
    await fixture.admission.ensure(fixture.session, scope.turn_id);
    assert.equal(fixture.state.calls.length, 1); assert.equal(fixture.state.effects, 1);
    const state = fixture.state; await fixture.close(); fixture = await openAdmissionFixture(root, state);
    await fixture.admission.ensure(fixture.session, scope.turn_id);
    assert.equal(state.calls.length, 1); assert.equal(JSON.stringify(await snapshot(fixture)), original);
    state.work_state = 'accepted';
    assert.equal((await fixture.admission.ensure(fixture.session, scope.turn_id)).work_state, 'accepted');
    assert.equal(JSON.stringify(await snapshot(fixture)), original, 'fresh display state does not rewrite original admission evidence');
    state.selected = false;
    await assert.rejects(fixture.admission.ensure(fixture.session, scope.turn_id), /authority/);
    assert.equal(state.calls.length, 1, 'a prior intent cannot fall back to ordinary chat after authority disappears');
  } finally { await fixture?.close(); await rm(root, { recursive: true, force: true }); }
});

test('ordinary and already admitted turns do not mutate; unavailable, foreign and terminal authority blocks', async () => {
  for (const kind of ['ordinary', 'existing', 'unavailable', 'foreign', 'malformed', 'cancelled', 'terminal']) {
    const root = await mkdtemp(join(tmpdir(), 'ghost-selected-authority-')); let fixture;
    const state = hostState();
    if (kind === 'ordinary') state.selected = false;
    if (kind === 'existing') state.admitted = true;
    if (kind === 'cancelled') state.cancelled = true;
    if (kind === 'terminal') state.run_state = 'answered';
    try {
      fixture = await openAdmissionFixture(root, state, { inspect: value => {
        if (kind === 'unavailable') value.data.task_admission.state = 'unavailable';
        if (kind === 'foreign') value.data.task_admission.turn_id = 'foreign';
        if (kind === 'malformed') value.data.task_contract = { ...task, task_contract_ref: [task.task_contract_ref] };
        return value;
      } });
      if (kind === 'ordinary') assert.equal(await fixture.admission.ensure(fixture.session, scope.turn_id), null);
      else if (kind === 'existing') assert.equal((await fixture.admission.ensure(fixture.session, scope.turn_id)).provenance, 'observed_existing');
      else await assert.rejects(fixture.admission.ensure(fixture.session, scope.turn_id));
      assert.equal(state.calls.length, 0); assert.equal(state.effects, 0);
      assert.equal(await snapshot(fixture), undefined);
    } finally { await fixture?.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('semantic dedup during goal.create preserves the prior Host source as observed existing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-selected-dedup-')); let fixture;
  const state = hostState(), intent = selectedTaskIntent(scope, task), source = 'prior-host-goal-command';
  const inspections = [], hostReceipt = receipt(source);
  try {
    fixture = await openAdmissionFixture(root, state, {
      inspect: value => { inspections.push(structuredClone(value.data.task_admission)); return value; },
      response: request => {
        assert.equal(inspections.at(-1).state, 'not_admitted', 'the admission raced after fresh pre-dispatch inspection');
        assert.equal(request.envelope.command_id, intent.command_id);
        return hostReceipt;
      },
    });
    const result = await within(fixture.admission.ensure(fixture.session, scope.turn_id));
    assert.equal(inspections[0].state, 'not_admitted');
    assert.equal(inspections.at(-1).state, 'admitted');
    assert.equal(result.state, 'admitted'); assert.equal(result.provenance, 'observed_existing');
    assert.notEqual(source, intent.operation_id); assert.notEqual(source, intent.command_id);
    assert.equal(result.source_command_id, source); assert.equal(result.operation_id, intent.operation_id);
    assert.equal(result.command_id, intent.command_id); assert.equal(result.body_digest, intent.body_digest);
    assert.equal(result.goal_id, 'goal'); assert.equal(result.goal_revision, 1); assert.equal(result.work_id, 'work');
    assert.equal(result.assignment_id, 'assignment'); assert.equal(result.response_digest, payloadDigest(hostReceipt));
    const doc = await snapshot(fixture), original = JSON.stringify(doc);
    assert.deepEqual(doc.intent, intent); assert.deepEqual(doc.outcome, result); assert.equal(doc.dispatch_started, true);
    assert.equal(state.calls.length, 1); assert.equal(state.effects, 1);
    assert.deepEqual(state.calls[0].envelope.body, intent.body);
    assert.equal(state.calls[0].envelope.payload_digest, intent.body_digest);
    await fixture.close(); fixture = await openAdmissionFixture(root, state);
    assert.deepEqual(await fixture.admission.ensure(fixture.session, scope.turn_id), result);
    assert.equal(JSON.stringify(await snapshot(fixture)), original, 'reopen retains the original request and prior-source provenance');
    assert.equal(state.calls.length, 1); assert.equal(state.effects, 1);
    assert.equal((await fixture.database.get("SELECT COUNT(*) AS count FROM tasks WHERE json_extract(record,'$.kind')='pi.generation'")).count, 0,
      'admission and replay never schedule model generation');
  } finally { await fixture?.close(); await rm(root, { recursive: true, force: true }); }
});

test('a different fresh Goal or Work cannot corroborate a semantic dedup receipt or resolve its original unknown', async () => {
  for (const changed of [{ goal_id: 'other-goal' }, { goal_revision: 2 }, { work_id: 'other-work' }]) {
    const root = await mkdtemp(join(tmpdir(), 'ghost-selected-dedup-mismatch-')); let fixture;
    const state = hostState(), intent = selectedTaskIntent(scope, task);
    let mismatch = true;
    try {
      fixture = await openAdmissionFixture(root, state, {
        response: () => receipt('prior-host-goal-command'),
        inspect: value => {
          if (state.admitted && mismatch) Object.assign(value.data.task_admission, changed);
          return value;
        },
      });
      const result = await within(fixture.admission.ensure(fixture.session, scope.turn_id));
      assert.deepEqual(result, { state: 'unknown', operation_id: intent.operation_id, command_id: intent.command_id, body_digest: intent.body_digest });
      const doc = await snapshot(fixture), original = JSON.stringify(doc);
      assert.deepEqual(doc.intent, intent); assert.deepEqual(doc.outcome, result); assert.equal(doc.dispatch_started, true);
      assert.deepEqual(await fixture.admission.ensure(fixture.session, scope.turn_id), result);
      mismatch = false;
      assert.deepEqual(await fixture.admission.ensure(fixture.session, scope.turn_id), result,
        'later matching admitted inspection cannot replace the unknown original response');
      assert.equal(JSON.stringify(await snapshot(fixture)), original);
      assert.equal(state.calls.length, 1); assert.equal(state.effects, 1);
      assert.equal((await fixture.database.get("SELECT COUNT(*) AS count FROM tasks WHERE json_extract(record,'$.kind')='pi.generation'")).count, 0);
    } finally { await fixture?.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('lost ACK remains unknown across idle/reopen until explicit same-command reconciliation appends evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-selected-ack-')); let fixture;
  try {
    const state = hostState(); fixture = await openAdmissionFixture(root, state, { dropAck: true });
    assert.equal((await fixture.admission.ensure(fixture.session, scope.turn_id)).state, 'unknown');
    const original = await snapshot(fixture), outcome = JSON.stringify(original.outcome), intent = JSON.stringify(original.intent);
    await fixture.session.root.waitForIdle(fixture.session.context);
    await fixture.admission.ensure(fixture.session, scope.turn_id);
    assert.equal(state.calls.length, 1, 'fresh admitted status cannot resolve an unknown original command');
    await fixture.close(); fixture = await openAdmissionFixture(root, state);
    await fixture.session.root.waitForIdle(fixture.session.context);
    assert.equal((await fixture.admission.ensure(fixture.session, scope.turn_id)).state, 'unknown');
    assert.equal(state.calls.length, 1);
    state.run_state = 'effect_unknown';
    const recovered = await fixture.admission.reconcile(fixture.session, scope.turn_id, 'explicit-one');
    assert.equal(recovered.state, 'admitted'); assert.equal(state.calls.length, 2); assert.equal(state.effects, 1);
    assert.deepEqual(state.calls[0], state.calls[1], 'recovery replays only the original command/body');
    const after = await snapshot(fixture);
    assert.equal(JSON.stringify(after.intent), intent); assert.equal(JSON.stringify(after.outcome), outcome);
    await fixture.admission.reconcile(fixture.session, scope.turn_id, 'explicit-one');
    assert.equal(state.calls.length, 2); assert.equal((await snapshot(fixture)).recoveries.length, 1);
    await fixture.admission.reconcile(fixture.session, scope.turn_id, 'explicit-two');
    assert.equal(state.calls.length, 3); assert.deepEqual(state.calls[0], state.calls[2]);
    assert.equal((await snapshot(fixture)).recoveries.length, 2);
    assert.equal((await fixture.admission.ensure(fixture.session, scope.turn_id)).state, 'admitted');
  } finally { await fixture?.close(); await rm(root, { recursive: true, force: true }); }
});

test('mismatched response cannot claim creation and cancellation prevents explicit recovery dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-selected-mismatch-')); let fixture;
  try {
    const state = hostState(); fixture = await openAdmissionFixture(root, state, { response: request => {
      const value = receipt(request.envelope.command_id); value.data.work.owner = 'foreign'; return value;
    } });
    assert.equal((await fixture.admission.ensure(fixture.session, scope.turn_id)).state, 'unknown');
    state.cancelled = true;
    await assert.rejects(fixture.admission.reconcile(fixture.session, scope.turn_id, 'cancelled-recovery'));
    assert.equal(state.calls.length, 1); assert.equal((await snapshot(fixture)).outcome.state, 'unknown');
  } finally { await fixture?.close(); await rm(root, { recursive: true, force: true }); }
});

test('fresh Host SDK identities or missing identity evidence block new recovery before any task or callback', async () => {
  for (const [field, value] of [['submission_id', 7], ['entry_id', 9], ['submission_id', undefined], ['entry_id', undefined]]) {
    const root = await mkdtemp(join(tmpdir(), 'ghost-selected-host-progress-')); let fixture, progressed = false;
    try {
      fixture = await openAdmissionFixture(root, hostState(), { dropAck: true, inspect: observation => {
        if (progressed) {
          if (value === undefined) delete observation.data.run[field]; else observation.data.run[field] = value;
        }
        return observation;
      } });
      assert.equal((await fixture.admission.ensure(fixture.session, scope.turn_id)).state, 'unknown');
      const prior = await snapshot(fixture), original = JSON.stringify(prior);
      const tasks = await fixture.database.all('SELECT record FROM tasks ORDER BY id');
      progressed = true;
      await assert.rejects(fixture.admission.validateRecovery(fixture.session, scope.turn_id, prior.intent.operation_id));
      await assert.rejects(fixture.admission.reconcile(fixture.session, scope.turn_id, 'host-already-progressed', prior.intent.operation_id));
      assert.equal(JSON.stringify(await snapshot(fixture)), original);
      assert.deepEqual(await fixture.database.all('SELECT record FROM tasks ORDER BY id'), tasks);
      assert.equal(fixture.state.calls.length, 1); assert.equal(fixture.state.effects, 1);
      fixture.state.cancelled = true; fixture.state.run_state = 'cancelled';
      const historical = await fixture.admission.observation(fixture.session, scope.turn_id, scope);
      assert.equal(historical.exists, true); assert.equal(historical.outcome.state, 'unknown');
      assert.equal(JSON.stringify(await snapshot(fixture)), original); assert.equal(fixture.state.calls.length, 1);
    } finally { await fixture?.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('selected-task observation projects bounded evidence without intent text, arbitrary fields or unsafe identities', () => {
  const intent = selectedTaskIntent(scope, task), sentinel = 'SECRET_TASK_TEXT_SENTINEL';
  const result = { state: 'unknown', operation_id: intent.operation_id, command_id: intent.command_id, body_digest: intent.body_digest, raw_error: sentinel };
  const doc = { intent: { ...intent, prompt: sentinel, body: { arbitrary: sentinel }, request: { ...intent.request, arguments: { secret: sentinel } } },
    task_id: 3, dispatch_started: true, outcome: result, recoveries: [{ request_id: 'explicit-recovery', started: true, task_id: 4, outcome: result, raw_input: sentinel }] };
  const before = JSON.stringify(doc), observed = selectedTaskObservation(doc, scope.turn_id);
  assert.equal(observed.kind, 'ghost.selected-task-admission-observation/1'); assert.equal(observed.exists, true);
  assert.equal(observed.original_task_id, 3); assert.equal(observed.recoveries.length, 1);
  assert.equal(JSON.stringify(observed).includes(sentinel), false); assert.equal(JSON.stringify(doc), before);
  assert.deepEqual(selectedTaskObservation(undefined, scope.turn_id), { kind: observed.kind, turn_id: scope.turn_id, exists: false });
  assert.throws(() => selectedTaskObservation(doc, scope.turn_id, { ...scope, ghost_id: 'foreign-ghost' }), /safely projected/);
  for (const changed of [
    { ...doc, intent: { ...intent, command_id: '가'.repeat(134) } },
    { ...doc, intent: { ...intent, body_digest: 'not-hex' } },
    { ...doc, recoveries: Array.from({ length: 9 }, (_, index) => ({ ...doc.recoveries[0], request_id: `recovery-${index}` })) },
    { ...doc, recoveries: [doc.recoveries[0], doc.recoveries[0]] },
    { ...doc, outcome: { ...result, operation_id: `selected-task:${'0'.repeat(64)}` } },
  ]) assert.throws(() => selectedTaskObservation(changed, scope.turn_id), /safely projected/);
  assert.ok(Buffer.byteLength(JSON.stringify(observed), 'utf8') < 64 * 1024);
});

test('a genuine process interruption retains its dispatch marker and never implicitly redispatches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-selected-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/selected-admission-crash.mjs', import.meta.url)), root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  await within(new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', () => reject(new Error(`Admission fixture exited: ${stderr}`)));
    child.stdout.on('data', chunk => { if (String(chunk).includes('committed')) resolve(); });
  }));
  child.kill('SIGKILL'); await exited;
  const committed = JSON.parse(await readFile(join(root, 'committed.json'), 'utf8'));
  const state = hostState(); state.admitted = true; state.effects = committed.effects; state.receipts = new Map(committed.receipts);
  const fixture = await openAdmissionFixture(root, state); t.after(() => fixture.close());
  const before = await snapshot(fixture); assert.equal(before.dispatch_started, true); assert.equal(before.outcome, null);
  assert.equal((await fixture.admission.ensure(fixture.session, scope.turn_id)).state, 'unknown');
  assert.equal(state.calls.length, 0); assert.equal(state.effects, 1);
  const unknownOutcome = JSON.stringify((await snapshot(fixture)).outcome);
  assert.equal((await fixture.admission.reconcile(fixture.session, scope.turn_id, 'explicit-after-crash')).state, 'admitted');
  assert.deepEqual(state.calls[0], committed.request);
  assert.equal(JSON.stringify((await snapshot(fixture)).outcome), unknownOutcome);
});
