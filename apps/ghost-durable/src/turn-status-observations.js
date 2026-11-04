import { payloadDigest, ProtocolError } from './contract.js';
import { callbackCommandId } from './host-transport.js';

const fail = () => { throw new ProtocolError('canonical_turn_status_conflict', 'Owner status observation has no exact immutable predecessor.', 'never'); };
const scopeMatches = (payload, scope) => payload.ghost_id === scope.ghostId && payload.conversation_id === scope.conversationId && payload.turn_id === scope.turnId;
const sameProjection = (run, payload) => run.status === payload.status && run.submission_id === payload.submission_id
  && run.entry_id === payload.entry_id && run.reason_code === payload.reason_code;
const fields = ['method', 'ghost_id', 'conversation_id', 'turn_id', 'status', 'submission_id', 'entry_id', 'reason_code'];
function checkedPayload(row, scope) {
  let payload; try { payload = JSON.parse(row.payload_json); } catch { return fail(); }
  if (!payload || Object.keys(payload).length !== fields.length || fields.some(key => !Object.hasOwn(payload, key))
    || payload.method !== 'conversation.turn_status' || !scopeMatches(payload, scope)
    || payload.status !== row.status || payloadDigest(payload) !== row.payload_digest) return fail();
  return payload;
}
const reference = (scope, kind, identity, digest) => payloadDigest({ kind, ghost_id: scope.ghostId,
  conversation_id: scope.conversationId, turn_id: scope.turnId, identity, payload_digest: digest });
export function hostConfirmsObservation(scope, row, run) {
  const payload = checkedPayload(row, scope);
  return Boolean(run && scopeMatches(run, scope) && typeof run.cancel_requested === 'boolean'
    && run.state === payload.status && run.submission_id === payload.submission_id && run.entry_id === payload.entry_id
    && run.reason_code === payload.reason_code
    && run.latest_status_command_id === callbackCommandId(scope.ghostId, scope.conversationId, row.invocation_id, 'conversation.turn_status'));
}
function legacySettledProof(row, scope) {
  let proof;
  try { proof = JSON.parse(row.delivery_state === 'acknowledged' ? row.receipt_json : row.observed_json); } catch { return false; }
  if (proof?.status !== 'success') return false;
  if (row.delivery_state === 'acknowledged') return true;
  return row.delivery_state === 'observed' && hostConfirmsObservation(scope, row, proof.data?.run);
}

export async function initializeTurnStatusObservations(database) {
  await database.exec(`CREATE TABLE IF NOT EXISTS ghost_turn_status_observations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('origin','legacy','v2')),
    observation_id TEXT NOT NULL UNIQUE CHECK(length(observation_id)=64),
    status TEXT CHECK(status IN ('running','answered','failed','cancelled','effect_unknown')),
    predecessor_kind TEXT CHECK(predecessor_kind IN ('origin','legacy','v2')),
    predecessor_id TEXT, predecessor_digest TEXT,
    invocation_id TEXT UNIQUE, payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
    delivery_state TEXT CHECK(delivery_state IN ('pending','acknowledged','rejected','observed','conflict')),
    receipt_json TEXT, observed_json TEXT,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    CHECK ((kind='origin' AND status IS NULL AND invocation_id IS NULL)
      OR (kind IN ('legacy','v2') AND status IS NOT NULL AND invocation_id IS NOT NULL)),
    CHECK ((kind IN ('origin','legacy') AND predecessor_kind IS NULL AND predecessor_id IS NULL AND predecessor_digest IS NULL
        AND delivery_state IS NULL AND receipt_json IS NULL AND observed_json IS NULL)
      OR (kind='v2' AND predecessor_kind IS NOT NULL AND predecessor_id IS NOT NULL AND predecessor_digest IS NOT NULL
        AND length(predecessor_id)=64 AND length(predecessor_digest)=64 AND delivery_state IS NOT NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ghost_one_status_anchor ON ghost_turn_status_observations(turn_id) WHERE kind IN ('origin','legacy');
  CREATE UNIQUE INDEX IF NOT EXISTS ghost_one_status_successor ON ghost_turn_status_observations(turn_id,predecessor_kind,predecessor_id,predecessor_digest) WHERE kind='v2';
  CREATE INDEX IF NOT EXISTS ghost_status_observation_tail ON ghost_turn_status_observations(turn_id,sequence);`);
}

export async function statusObservationTail(transaction, scope) {
  const row = await transaction.get('SELECT * FROM ghost_turn_status_observations WHERE turn_id=? ORDER BY sequence DESC LIMIT 1', scope.turnId);
  if (!row) return null;
  if (row.conversation_id !== scope.conversationId) return fail();
  if (row.kind === 'origin') {
    let origin; try { origin = JSON.parse(row.payload_json); } catch { return fail(); }
    if (origin.kind !== 'ghost-owner-status-origin/1' || !scopeMatches(origin, scope)
      || payloadDigest(origin) !== row.payload_digest
      || row.observation_id !== reference(scope, 'origin', origin.request_id, row.payload_digest)) return fail();
  } else {
    checkedPayload(row, scope);
    if (row.observation_id !== reference(scope, row.kind, row.invocation_id, row.payload_digest)) return fail();
    if (row.kind === 'legacy') {
      const legacy = await transaction.get('SELECT * FROM ghost_turn_status_reports WHERE turn_id=? AND status=?', scope.turnId, row.status);
      if (!legacy || legacy.invocation_id !== row.invocation_id || legacy.payload_json !== row.payload_json || legacy.payload_digest !== row.payload_digest) return fail();
    } else {
      const predecessor = await transaction.get('SELECT * FROM ghost_turn_status_observations WHERE observation_id=? AND turn_id=?', row.predecessor_id, scope.turnId);
      if (!predecessor || predecessor.conversation_id !== scope.conversationId || predecessor.kind !== row.predecessor_kind
        || predecessor.payload_digest !== row.predecessor_digest || predecessor.sequence >= row.sequence) return fail();
      const expected = statusObservationInvocation(scope, predecessor, row.payload_digest);
      if (row.invocation_id !== expected) return fail();
    }
  }
  return row;
}

async function ownerRun(transaction, scope) {
  const row = await transaction.get(`SELECT r.status,r.submission_id,r.entry_id,r.reason_code,t.request_id
    FROM ghost_canonical_turn_runs r JOIN ghost_canonical_turns t ON t.turn_id=r.turn_id
    WHERE r.turn_id=? AND r.conversation_id=? AND t.conversation_id=? AND t.origin_kind='owner' AND t.context_ref='owner'
      AND NOT EXISTS(SELECT 1 FROM ghost_canonical_assignments a WHERE a.turn_id=t.turn_id)`, scope.turnId, scope.conversationId, scope.conversationId);
  if (!row) return fail();
  return row;
}

// Called only in the fresh intake transaction, never inferred from a migrated
// queued/unknown run with missing observation history.
export async function sealStatusOrigin(transaction, scope, requestId) {
  const run = await ownerRun(transaction, scope);
  if (run.request_id !== requestId || run.status !== 'queued' || run.submission_id !== null || run.entry_id !== null || run.reason_code !== null
    || await statusObservationTail(transaction, scope)
    || await transaction.get('SELECT turn_id FROM ghost_turn_status_reports WHERE turn_id=? LIMIT 1', scope.turnId)) return fail();
  const payload = { kind: 'ghost-owner-status-origin/1', ghost_id: scope.ghostId, conversation_id: scope.conversationId,
    turn_id: scope.turnId, request_id: requestId };
  const digest = payloadDigest(payload), now = Date.now();
  await transaction.run(`INSERT INTO ghost_turn_status_observations
    (turn_id,conversation_id,kind,observation_id,payload_json,payload_digest,created_at_ms,updated_at_ms)
    VALUES (?,?,'origin',?,?,?,?,?)`, scope.turnId, scope.conversationId, reference(scope, 'origin', requestId, digest), JSON.stringify(payload), digest, now, now);
}

// Seal legacy provenance before any unreported continuation/SID projection.
// Delivery timestamps cannot establish chronology and are never consulted.
export async function sealStatusAnchor(transaction, scope) {
  const tail = await statusObservationTail(transaction, scope);
  if (tail) return tail;
  const run = await ownerRun(transaction, scope);
  const rows = await transaction.all('SELECT * FROM ghost_turn_status_reports WHERE turn_id=?', scope.turnId);
  const matches = rows.filter(row => sameProjection(run, checkedPayload(row, scope)));
  if (matches.length !== 1) return fail();
  const legacy = matches[0], now = Date.now();
  if (rows.some(row => row !== legacy && !legacySettledProof(row, scope))
    || legacy.delivery_state !== 'pending' && !legacySettledProof(legacy, scope)) return fail();
  const originalId = JSON.stringify(['ghost-canonical-controller-lifecycle/1', 'conversation.turn_status', scope.ghostId, scope.conversationId, scope.turnId, legacy.status]);
  if (legacy.invocation_id !== originalId) return fail();
  await transaction.run(`INSERT INTO ghost_turn_status_observations
    (turn_id,conversation_id,kind,observation_id,status,invocation_id,payload_json,payload_digest,created_at_ms,updated_at_ms)
    VALUES (?,?,'legacy',?,?,?,?,?,?,?)`, scope.turnId, scope.conversationId,
    reference(scope, 'legacy', legacy.invocation_id, legacy.payload_digest), legacy.status, legacy.invocation_id, legacy.payload_json, legacy.payload_digest, now, now);
  return statusObservationTail(transaction, scope);
}

export function statusObservationInvocation(scope, predecessor, digest) {
  return JSON.stringify(['ghost-conversation-turn-status-v2', payloadDigest({ ghost_id: scope.ghostId,
    conversation_id: scope.conversationId, turn_id: scope.turnId, predecessor_kind: predecessor.kind,
    predecessor_id: predecessor.observation_id, predecessor_digest: predecessor.payload_digest, payload_digest: digest })]);
}

// Must share the caller's projection transaction. Deduplication is against
// only the current tail, never an older equal status or payload.
export async function appendStatusObservation(transaction, scope, payload) {
  const tail = await sealStatusAnchor(transaction, scope);
  const digest = payloadDigest(payload);
  checkedPayload({ payload_json: JSON.stringify(payload), payload_digest: digest, status: payload.status }, scope);
  if (tail.kind !== 'origin' && tail.payload_digest === digest) { checkedPayload(tail, scope); return tail; }
  const invocation = statusObservationInvocation(scope, tail, digest), now = Date.now();
  await transaction.run(`INSERT INTO ghost_turn_status_observations
    (turn_id,conversation_id,kind,observation_id,status,predecessor_kind,predecessor_id,predecessor_digest,
      invocation_id,payload_json,payload_digest,delivery_state,created_at_ms,updated_at_ms)
    VALUES (?,?,'v2',?,?,?,?,?,?,?,?,'pending',?,?)`, scope.turnId, scope.conversationId,
    reference(scope, 'v2', invocation, digest), payload.status, tail.kind, tail.observation_id, tail.payload_digest,
    invocation, JSON.stringify(payload), digest, now, now);
  return statusObservationTail(transaction, scope);
}

export function validateOwnerStatusTransition(run, payload) {
  if ((run.submission_id !== null && payload.submission_id !== run.submission_id)
    || (run.entry_id !== null && payload.entry_id !== run.entry_id)
    || (run.status === payload.status && run.reason_code !== null && payload.reason_code !== run.reason_code)
    || (['answered', 'failed', 'cancelled'].includes(run.status) && run.status !== payload.status)) return fail();
}

export async function observationReport(index, scope, observation) {
  if (observation.kind === 'origin') return null;
  const row = observation.kind === 'legacy'
    ? await index.get('SELECT * FROM ghost_turn_status_reports WHERE turn_id=? AND invocation_id=?', scope.turnId, observation.invocation_id)
    : await index.get("SELECT * FROM ghost_turn_status_observations WHERE observation_id=? AND turn_id=? AND kind='v2'", observation.observation_id, scope.turnId);
  if (!row || row.payload_json !== observation.payload_json || row.payload_digest !== observation.payload_digest || row.invocation_id !== observation.invocation_id) return fail();
  checkedPayload(row, scope);
  if (observation.kind === 'legacy' && ['acknowledged', 'observed'].includes(row.delivery_state) && !legacySettledProof(row, scope)) return fail();
  return row;
}

export async function setObservationDelivery(index, scope, observation, deliveryState, response, observed) {
  await observationReport(index, scope, observation);
  const table = observation.kind === 'legacy' ? 'ghost_turn_status_reports' : 'ghost_turn_status_observations';
  await index.run(`UPDATE ${table} SET delivery_state=?,receipt_json=COALESCE(receipt_json,?),observed_json=COALESCE(observed_json,?),updated_at_ms=?
    WHERE turn_id=? AND invocation_id=? AND delivery_state NOT IN ('acknowledged','observed','rejected','conflict')`, deliveryState,
    response === null ? null : JSON.stringify(response), observed === null ? null : JSON.stringify(observed), Date.now(), scope.turnId, observation.invocation_id);
}

export async function currentObservation(index, scope, observation) {
  const tail = await statusObservationTail(index, scope);
  const run = await ownerRun(index, scope);
  return tail?.observation_id === observation.observation_id && sameProjection(run, checkedPayload(observation, scope));
}

export async function withStatusGate(session, turnId, operation) {
  session.statusObservationGates ??= new Map();
  const previous = session.statusObservationGates.get(turnId) ?? Promise.resolve();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  session.statusObservationGates.set(turnId, queued);
  await previous.catch(() => {});
  try { return await operation(); } finally { release(); if (session.statusObservationGates.get(turnId) === queued) session.statusObservationGates.delete(turnId); }
}
