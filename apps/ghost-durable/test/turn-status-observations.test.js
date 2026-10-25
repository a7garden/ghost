import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGhostIndex } from '../src/storage.js';
import { initializeWorkContexts } from '../src/work-context.js';
import { payloadDigest } from '../src/contract.js';
import { callbackCommandId } from '../src/host-transport.js';
import { sealStatusOrigin, sealStatusAnchor, appendStatusObservation, statusObservationTail,
  setObservationDelivery, validateOwnerStatusTransition, withStatusGate, hostConfirmsObservation } from '../src/turn-status-observations.js';

const scope = { ghostId: 'ghost', conversationId: 'conversation', turnId: 'owner-turn' };
const payload = (status, sid = null, entry = null) => ({ method: 'conversation.turn_status', ghost_id: scope.ghostId,
  conversation_id: scope.conversationId, turn_id: scope.turnId, status, submission_id: sid, entry_id: entry,
  reason_code: status === 'effect_unknown' ? 'effect_unconfirmed' : status === 'cancelled' ? 'owner_cancelled' : null });
async function fixture(t, fresh = true) {
  const root = await mkdtemp(join(tmpdir(), 'ghost-status-observation-'));
  let db = await openGhostIndex(root, scope.ghostId);
  await db.exec('CREATE TABLE IF NOT EXISTS ghost_canonical_assignments(turn_id TEXT,assignment_id TEXT)');
  await initializeWorkContexts(db);
  await db.run(`INSERT INTO ghost_canonical_turns(turn_id,conversation_id,request_id,privacy,prompt,attachments_json,state)
    VALUES (?,?,'original-input','public','private input must not enter observations','[]','queued')`, scope.turnId, scope.conversationId);
  await db.run(`INSERT INTO ghost_canonical_turn_runs(turn_id,conversation_id,status,cancel_requested,created_at_ms,updated_at_ms)
    VALUES (?,?,'queued',0,1,1)`, scope.turnId, scope.conversationId);
  if (fresh) await db.transaction(tx => sealStatusOrigin(tx, scope, 'original-input'));
  t.after(async () => { await db.close(); await rm(root, { recursive: true, force: true }); });
  return { get db() { return db; }, async reopen() { await db.close(); db = await openGhostIndex(root, scope.ghostId); } };
}
async function project(db, next) {
  return db.transaction(async tx => {
    const run = await tx.get('SELECT status,submission_id,entry_id,reason_code FROM ghost_canonical_turn_runs WHERE turn_id=?', scope.turnId);
    validateOwnerStatusTransition(run, next);
    const observation = await appendStatusObservation(tx, scope, next);
    await tx.run('UPDATE ghost_canonical_turn_runs SET status=?,submission_id=?,entry_id=?,reason_code=? WHERE turn_id=?',
      next.status, next.submission_id, next.entry_id, next.reason_code, scope.turnId);
    return observation;
  });
}
async function legacy(db, value, delivery = 'acknowledged') {
  const invocation = JSON.stringify(['ghost-canonical-controller-lifecycle/1', 'conversation.turn_status', scope.ghostId, scope.conversationId, scope.turnId, value.status]);
  await db.run(`INSERT INTO ghost_turn_status_reports(turn_id,status,invocation_id,payload_json,payload_digest,delivery_state,receipt_json,created_at_ms,updated_at_ms)
    VALUES (?,?,?,?,?,?,?,1,999)`, scope.turnId, value.status, invocation, JSON.stringify(value), payloadDigest(value), delivery,
    delivery === 'acknowledged' ? JSON.stringify({ status: 'success', data: { original: 'unchanged' } }) : null);
  return invocation;
}

test('Owner status occurrences bind their predecessor; only the exact current tail deduplicates across reopen', async t => {
  const f = await fixture(t), records = [];
  for (const next of [payload('effect_unknown'), payload('running', '11'), payload('effect_unknown', '11'), payload('running', '11'), payload('effect_unknown', '11')]) {
    const row = await project(f.db, next); records.push(row);
    assert.ok(row.invocation_id.length < 150, 'history does not recursively grow the wire identity');
    assert.equal(row.payload_digest, payloadDigest(next));
  }
  assert.equal(new Set(records.map(row => row.invocation_id)).size, records.length);
  assert.notEqual(records[2].invocation_id, records[4].invocation_id, 'equal unknown payloads separated by running are distinct observations');
  assert.equal(records[4].predecessor_id, records[3].observation_id);
  assert.equal(records[4].predecessor_digest, records[3].payload_digest);
  const original = await f.db.all('SELECT * FROM ghost_turn_status_observations ORDER BY sequence');
  assert.equal((await project(f.db, payload('effect_unknown', '11'))).observation_id, records[4].observation_id);
  await f.reopen();
  assert.equal((await project(f.db, payload('effect_unknown', '11'))).observation_id, records[4].observation_id);
  assert.deepEqual(await f.db.all('SELECT * FROM ghost_turn_status_observations ORDER BY sequence'), original);
  assert.equal(JSON.stringify(original).includes('private input'), false);
});

test('legacy provenance is sealed before continuation changes; immutable IDs payload and ACK bytes remain unchanged', async t => {
  const f = await fixture(t, false), unknown = payload('effect_unknown');
  await legacy(f.db, unknown);
  await f.db.run("UPDATE ghost_canonical_turn_runs SET status='effect_unknown',reason_code='effect_unconfirmed'");
  const original = await f.db.all('SELECT * FROM ghost_turn_status_reports');
  const anchor = await f.db.transaction(tx => sealStatusAnchor(tx, scope));
  assert.equal(anchor.kind, 'legacy'); assert.equal(anchor.invocation_id, original[0].invocation_id);
  await f.db.run("UPDATE ghost_canonical_turn_runs SET status='queued',reason_code=NULL");
  const running = await project(f.db, payload('running', '11'));
  assert.equal(running.predecessor_kind, 'legacy'); assert.equal(running.predecessor_id, anchor.observation_id);
  await project(f.db, payload('effect_unknown', '11'));
  await setObservationDelivery(f.db, scope, anchor, 'observed', null, { status: 'success' });
  assert.deepEqual(await f.db.all('SELECT * FROM ghost_turn_status_reports'), original, 'already committed legacy evidence is never rewritten');
  await f.reopen();
  assert.deepEqual(await f.db.all('SELECT * FROM ghost_turn_status_reports'), original);
});

test('missing or mismatched legacy anchors and unrelated pending history fail closed without a v2 successor', async t => {
  for (const variant of ['missing', 'mismatch', 'unreported-progress', 'other-pending', 'weak-observed', 'migrated-queued']) {
    await t.test(variant, async t => {
      const f = await fixture(t, false);
      if (variant !== 'migrated-queued') await f.db.run("UPDATE ghost_canonical_turn_runs SET status='effect_unknown',reason_code='effect_unconfirmed'");
      if (!['missing', 'migrated-queued'].includes(variant)) await legacy(f.db, payload('effect_unknown', variant === 'mismatch' ? 'different' : null));
      if (variant === 'other-pending') await legacy(f.db, payload('running', '11'), 'pending');
      if (variant === 'weak-observed') {
        await legacy(f.db, payload('running', '11'), 'observed');
        await f.db.run("UPDATE ghost_turn_status_reports SET observed_json=? WHERE status='running'",
          JSON.stringify({ status: 'success', data: { run: { ...payload('running', '11'), state: 'running', cancel_requested: false } } }));
      }
      if (variant === 'unreported-progress') await f.db.run("UPDATE ghost_canonical_turn_runs SET status='running',submission_id='11',reason_code=NULL");
      const before = await f.db.all('SELECT * FROM ghost_turn_status_reports');
      await assert.rejects(f.db.transaction(tx => sealStatusAnchor(tx, scope)), error => error.code === 'canonical_turn_status_conflict');
      assert.equal((await f.db.get('SELECT count(*) AS total FROM ghost_turn_status_observations')).total, 0);
      assert.deepEqual(await f.db.all('SELECT * FROM ghost_turn_status_reports'), before);
    });
  }
});

test('same Host state cannot acknowledge a later equal-payload occurrence without its exact command identity', async t => {
  const f = await fixture(t);
  const first = await project(f.db, payload('running', '11'));
  await project(f.db, payload('effect_unknown', '11'));
  const repeated = await project(f.db, payload('running', '11'));
  const run = { ...payload('running', '11'), state: 'running', cancel_requested: false,
    latest_status_command_id: callbackCommandId(scope.ghostId, scope.conversationId, first.invocation_id, 'conversation.turn_status') };
  assert.equal(hostConfirmsObservation(scope, repeated, run), false);
  run.latest_status_command_id = callbackCommandId(scope.ghostId, scope.conversationId, repeated.invocation_id, 'conversation.turn_status');
  assert.equal(hostConfirmsObservation(scope, repeated, run), true);
  assert.equal(hostConfirmsObservation(scope, repeated, { ...run, conversation_id: 'other' }), false);
});

test('Owner status pins cannot regress or change, and append plus current projection rolls back atomically', async t => {
  const f = await fixture(t);
  await project(f.db, payload('running', '11'));
  const before = await f.db.all('SELECT * FROM ghost_turn_status_observations');
  for (const next of [payload('effect_unknown'), payload('effect_unknown', '12')]) {
    await assert.rejects(project(f.db, next), error => error.code === 'canonical_turn_status_conflict');
  }
  await f.db.exec(`CREATE TRIGGER status_projection_fault BEFORE UPDATE ON ghost_canonical_turn_runs
    BEGIN SELECT RAISE(FAIL, 'Controlled projection fault'); END`);
  await assert.rejects(project(f.db, payload('effect_unknown', '11')));
  assert.deepEqual(await f.db.all('SELECT * FROM ghost_turn_status_observations'), before);
  await f.db.exec('DROP TRIGGER status_projection_fault');
  await project(f.db, payload('answered', '11', '19'));
  await assert.rejects(project(f.db, payload('effect_unknown', '11', '19')));
  await assert.rejects(project(f.db, payload('answered', '11', '20')));
  await assert.rejects(project(f.db, payload('answered', '11', null)));
});

test('schema prevents a second successor; a changed predecessor cannot become a trusted tail', async t => {
  const f = await fixture(t);
  const unknown = await project(f.db, payload('effect_unknown'));
  await assert.rejects(f.db.run(`INSERT INTO ghost_turn_status_observations(turn_id,conversation_id,kind,observation_id,status,
    predecessor_kind,predecessor_id,predecessor_digest,invocation_id,payload_json,payload_digest,delivery_state,created_at_ms,updated_at_ms)
    SELECT turn_id,conversation_id,kind,?,status,predecessor_kind,predecessor_id,predecessor_digest,?,payload_json,payload_digest,delivery_state,created_at_ms,updated_at_ms
    FROM ghost_turn_status_observations WHERE observation_id=?`, 'f'.repeat(64), 'forged-successor', unknown.observation_id));
  await f.db.run('UPDATE ghost_turn_status_observations SET predecessor_digest=? WHERE observation_id=?', '0'.repeat(64), unknown.observation_id);
  await assert.rejects(statusObservationTail(f.db, scope), error => error.code === 'canonical_turn_status_conflict');
});

test('the per-turn gate serializes append and outbound delivery, including a rejected predecessor operation', async () => {
  const session = {}, events = []; let release;
  const held = new Promise(resolve => { release = resolve; });
  const first = withStatusGate(session, 'turn', async () => { events.push('first-start'); await held; events.push('first-end'); throw new Error('Controlled failure'); });
  const firstFailure = assert.rejects(first);
  const second = withStatusGate(session, 'turn', async () => { events.push('second-start'); });
  await Promise.resolve(); await Promise.resolve(); assert.deepEqual(events, ['first-start']);
  release(); await firstFailure; await second;
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start']);
  assert.equal(session.statusObservationGates.size, 0);
});
