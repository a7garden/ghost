import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineTask } from '@earendil-works/pi-durable';
import { openGhostIndex } from '../src/storage.js';
import { openStatusFixture, savedState, saveState, envelope, scope } from './fixtures/owner-status-crash.mjs';

const within = (promise, ms = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Controlled Owner status barrier expired')), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) { await within((async () => { while (!await check()) await tick(); })()); }
async function inboxBytes(session) {
  const view = await session.root.viewState(BACKGROUND_CONTEXT);
  try { return JSON.stringify(view.value.docs['pi.inbox']); } finally { view.dispose(); }
}

for (const inventory of ['sole-target', 'background', 'queued-input']) test(inventory === 'sole-target'
  ? 'cold original SDK submission projects a new unknown observation and cancels without replacement or inference'
  : `cold original cancellation preserves unrelated ${inventory} inventory without enabling scheduling`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-owner-status-crash-'));
  let runtime, releaseLookup; t.after(async () => { releaseLookup?.(); await runtime?.close(); await rm(root, { recursive: true, force: true }); });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/owner-status-crash.mjs', import.meta.url)), root, inventory],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  await within(new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', () => reject(new Error(`Controlled SDK child exited before running: ${stderr}`)));
    child.stdout.on('data', bytes => { if (String(bytes).includes('running_committed')) resolve(); });
  }));
  child.kill('SIGKILL'); await exited;
  const sdkRoot = join(root, 'runtime');
  const originalHost = savedState(root), sid = originalHost.run.submission_id;
  assert.notEqual(sid, null); assert.equal(originalHost.providerRequests, 0);
  const index = await openGhostIndex(sdkRoot, scope.ghost_id);
  const originalUnknown = await index.get(`SELECT * FROM ghost_turn_status_observations
    WHERE turn_id=? AND kind='v2' AND status='effect_unknown' AND json_extract(payload_json,'$.submission_id') IS NULL`, scope.turn_id);
  assert.equal(originalUnknown.delivery_state, 'acknowledged');
  await index.close();
  runtime = await openStatusFixture(root);
  const diagnostics = []; runtime.onDiagnostic = value => diagnostics.push(value);
  const ordinary = { method: 'runtime.reconcile', ghost_id: scope.ghost_id, conversation_id: scope.conversation_id };
  assert.equal((await runtime.handle(envelope('cold-observe', ordinary))).status, 'success');
  await runtime.waitForIdle(scope.ghost_id, scope.conversation_id);
  const session = [...runtime.sessions.values()].find(value => value.ghostId === scope.ghost_id && value.conversationId === scope.conversation_id);
  const canonical = () => session.index.get('SELECT status,submission_id,entry_id FROM ghost_canonical_turn_runs WHERE turn_id=?', scope.turn_id);
  assert.deepEqual({ ...await canonical() }, { status: 'effect_unknown', submission_id: sid, entry_id: null });
  assert.equal(savedState(root).run.state, 'effect_unknown'); assert.equal(savedState(root).run.submission_id, sid);
  assert.equal(savedState(root).providerRequests, 0); assert.equal(savedState(root).calls.length, 2);
  const rows = await session.index.all("SELECT * FROM ghost_turn_status_observations WHERE turn_id=? ORDER BY sequence", scope.turn_id);
  const progressed = rows.at(-1), previous = rows.at(-2);
  assert.equal(progressed.status, 'effect_unknown'); assert.equal(JSON.parse(progressed.payload_json).submission_id, sid);
  assert.equal(progressed.predecessor_id, previous.observation_id); assert.equal(previous.status, 'running');
  assert.equal(previous.delivery_state, 'observed', 'the exact running receipt lost before crash is corroborated by its Host command ID');
  assert.deepEqual(await session.index.get('SELECT * FROM ghost_turn_status_observations WHERE observation_id=?', originalUnknown.observation_id), originalUnknown);
  const submissions = await session.database.all('SELECT id,record FROM submissions ORDER BY id');
  const generations = await session.database.all("SELECT id,record FROM tasks WHERE json_extract(kind,'$')='pi.generation' ORDER BY id");
  assert.equal(submissions.length, inventory === 'queued-input' ? 2 : 1); assert.equal(String(submissions[0].id), sid); assert.equal(generations.length, 1);
  const generationId = generations[0].id;
  assert.equal((await session.harness.inspect(BACKGROUND_CONTEXT)).scheduling, 'paused');
  await runtime.handle(envelope('repeat-cold-observe', ordinary)); await runtime.waitForIdle(scope.ghost_id, scope.conversation_id);
  assert.deepEqual(await session.index.all('SELECT * FROM ghost_turn_status_observations WHERE turn_id=? ORDER BY sequence', scope.turn_id), rows);
  assert.deepEqual(await session.database.all('SELECT id,record FROM submissions ORDER BY id'), submissions);
  assert.deepEqual(await session.database.all("SELECT id,record FROM tasks WHERE json_extract(kind,'$')='pi.generation' ORDER BY id"), generations);
  let extra;
  if (inventory === 'background') {
    // A separate public-SDK background record is intentionally not a member of
    // the cancelled input's generation. A missing definition must also count
    // as live inventory; future registry changes could make it runnable.
    const task = defineTask({ name: 'controlled.unrelated-background', version: 1,
      initial: () => ({ phase: 'hold' }), phases: { hold: async () => { throw new Error('Unrelated task must never run'); } } });
    extra = await session.root.commit(tx => tx.createTask(task, {}, { background: true, ownership: { kind: 'conversation' } }), BACKGROUND_CONTEXT);
  }
  let lookupBlocked;
  if (inventory === 'sole-target') {
    let markLookup;
    lookupBlocked = new Promise(resolve => { markLookup = resolve; });
    const heldLookup = new Promise(resolve => { releaseLookup = resolve; });
    const actualLookup = session.harness.submission.bind(session.harness); let holdOnce = true;
    session.harness.submission = async (...args) => {
      const actual = await actualLookup(...args);
      if (holdOnce && args[0] === Number(sid)) { holdOnce = false; markLookup(); await heldLookup; }
      return actual;
    };
    await runtime.handle(envelope('stale-canonical-observer', ordinary));
    await within(lookupBlocked);
  }
  const inboxBefore = await inboxBytes(session);
  const host = savedState(root); host.run.cancel_requested = true; saveState(root, host);
  const cancel = envelope('explicit-original-owner-cancel', { method: 'conversation.cancel_turn', ghost_id: scope.ghost_id,
    conversation_id: scope.conversation_id, turn_id: scope.turn_id });
  const cancelAck = await runtime.handle(cancel);
  assert.equal(cancelAck.status, 'success');
  if (inventory !== 'sole-target') {
    await until(async () => (await session.harness.getTask(generationId, BACKGROUND_CONTEXT)).abortRequested === true);
    await runtime.waitForIdle(scope.ghost_id, scope.conversation_id);
    assert.equal((await session.harness.inspect(BACKGROUND_CONTEXT)).scheduling, 'paused');
    if (extra !== undefined) assert.equal((await session.harness.getTask(extra, BACKGROUND_CONTEXT)).abortRequested, false);
    assert.equal((await session.harness.getTask(generationId, BACKGROUND_CONTEXT)).state.status, 'pending');
    assert.equal((await canonical()).status, 'effect_unknown');
    assert.equal(JSON.parse((await session.database.get('SELECT record FROM submissions WHERE id=?', Number(sid))).record).status, 'placed');
    if (inventory === 'queued-input') {
      const originalExtra = submissions.find(row => row.id === originalHost.extra_submission_id);
      assert.ok(originalExtra); assert.equal(JSON.parse(originalExtra.record).status, 'queued');
      assert.equal((await session.database.get('SELECT record FROM submissions WHERE id=?', originalExtra.id)).record, originalExtra.record);
      assert.equal(await inboxBytes(session), inboxBefore);
    }
  } else {
    await until(async () => (await canonical()).status === 'cancelled');
    const task = await session.harness.getTask(generationId, BACKGROUND_CONTEXT);
    assert.equal(task.state.status, 'terminal'); assert.equal(task.state.outcome.status, 'aborted');
    const submission = JSON.parse((await session.database.get('SELECT record FROM submissions WHERE id=?', Number(sid))).record);
    assert.equal(submission.status, 'unanswered'); assert.equal(submission.reason, 'aborted');
    assert.equal(savedState(root).run.state, 'cancelled');
    const terminalRun = await session.index.get('SELECT * FROM ghost_canonical_turn_runs WHERE turn_id=?', scope.turn_id);
    const terminalObservations = await session.index.all('SELECT * FROM ghost_turn_status_observations WHERE turn_id=? ORDER BY sequence', scope.turn_id);
    releaseLookup(); await runtime.waitForIdle(scope.ghost_id, scope.conversation_id);
    assert.equal(diagnostics.some(value => value.cause_code === 'canonical_submission_conflict'), false,
      'a stale exact original SDK lookup observes cancellation without attempting a terminal running projection');
    assert.deepEqual(await session.index.get('SELECT * FROM ghost_canonical_turn_runs WHERE turn_id=?', scope.turn_id), terminalRun);
    assert.deepEqual(await session.index.all('SELECT * FROM ghost_turn_status_observations WHERE turn_id=? ORDER BY sequence', scope.turn_id), terminalObservations);
    assert.deepEqual(await runtime.handle(cancel), cancelAck, 'original cancellation ACK stays immutable after terminal settlement');
    const terminalCancel = envelope('read-already-terminal-cancel', cancel.body);
    const terminalAck = await runtime.handle(terminalCancel);
    assert.deepEqual(await runtime.handle(terminalCancel), terminalAck);
    for (const result of [cancelAck, terminalAck]) {
      assert.equal(result.data.ghost_id, scope.ghost_id); assert.equal(result.data.conversation_id, scope.conversation_id);
      assert.equal(result.data.runtime_kind, 'pi-durable'); assert.equal(result.data.runtime_release, '1.1.0');
      assert.equal(result.data.storage_ref, session.storageRef); assert.equal(typeof result.data.command_id, 'string');
      assert.equal(Object.hasOwn(result.data, 'committed_view'), false); assert.equal(Object.hasOwn(result.data, 'runtime_state'), false);
    }
  }
  assert.deepEqual((await session.database.all('SELECT id FROM submissions ORDER BY id')).map(row => ({ ...row })), submissions.map(({ id }) => ({ id })));
  assert.deepEqual((await session.database.all("SELECT id FROM tasks WHERE json_extract(kind,'$')='pi.generation' ORDER BY id")).map(row => ({ ...row })), [{ id: generationId }]);
  assert.equal(savedState(root).providerRequests, 0, 'cold open and exact cancellation never resubmit inference');
  assert.equal(savedState(root).effects, 1); assert.equal(savedState(root).calls.length, 2);
  assert.deepEqual(await session.index.get('SELECT * FROM ghost_turn_status_observations WHERE observation_id=?', originalUnknown.observation_id), originalUnknown);
});
