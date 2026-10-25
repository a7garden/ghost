// Acceptance-only observations. These records never grant SDK execution,
// replace a wait, or turn a diagnostic window into a Work deadline.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

export const FUNCTIONAL_OBSERVATION_MODE = 'a04-functional-policy/1';
export const IDLE_OBSERVATION_WINDOW_MS = 120_000;
const PROJECTION_ROWS = 64; // Diagnostic clipping only; no execution/admission limit.
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 400 && !/[\u0000-\u001f\u007f]/u.test(value);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const hash = value => createHash('sha256').update(value).digest('hex');
const scopeKey = scope => JSON.stringify([scope.ghost_id, scope.conversation_id]);
const validScope = scope => identity(scope?.ghost_id) && identity(scope?.conversation_id);

export function validateFunctionalObservationMode(frame) {
  if (frame.observation_mode === undefined) return false;
  if (frame.observation_mode !== FUNCTIONAL_OBSERVATION_MODE || frame.ack_on_admission !== true) {
    throw new Error('Functional observations require their explicit mode and admission ACKs');
  }
  return true;
}

// The inner boundary records only actual network attempts AFTER the existing
// meter's call gate. The outer boundary retains them until that same meter has
// consumed its existing bounded response clone. No extra fetch/read is added.
export function createFunctionalProviderProgress(fetchImpl, { now = Date.now } = {}) {
  const context = new AsyncLocalStorage(), active = new Map(); let next = 0, timeoutMs = null;
  return {
    configureTimeout(value) {
      if (!positive(value)) throw new Error('Configured provider request timeout unavailable');
      timeoutMs = value;
    },
    transportFetch: (...args) => {
      const owner = context.getStore();
      if (!owner || owner.record) throw new Error('Functional provider attempt has no exact observation owner');
      const body = args[1]?.body;
      const record = { request_id: ++next, request_digest: typeof body === 'string' ? hash(body) : null,
        started_at_ms: now(), timeout_ms: timeoutMs };
      owner.record = record; active.set(record.request_id, record);
      return fetchImpl(...args);
    },
    wrap(measuredFetch) {
      return (...args) => context.run({ record: null }, async () => {
        const owner = context.getStore();
        try { return await measuredFetch(...args); }
        finally { if (owner.record) active.delete(owner.record.request_id); }
      });
    },
    snapshot() {
      const observed = now();
      return { scope: 'process', diagnostic_only: true, attribution: 'transport_only_unattributed',
        request_id_kind: 'transport_sequence', timeout_ms: timeoutMs,
        active: [...active.values()].slice(0, PROJECTION_ROWS).map(record => ({ ...record,
          age_ms: Math.max(0, observed - record.started_at_ms),
          deadline_at_ms: record.timeout_ms === null ? null : record.started_at_ms + record.timeout_ms })),
        truncated: active.size > PROJECTION_ROWS };
    },
  };
}

const taskKinds = new Set(['pi.generation', 'pi.tool', 'pi.compaction']);
const phases = new Set(['prepare', 'request', 'tools', 'execute', 'admit', 'select', 'summarize', 'wait']);
const statuses = new Set(['pending', 'running', 'waiting', 'completing', 'terminal']);

export async function collectOpenRuntimeProgress(runtime, scope, providerRequests = null, { now = Date.now } = {}) {
  const observed = now(), sessions = [];
  // Never call runtime.#session/handle/root/wait here: inspect only stores that
  // the original admitted commands have already opened in this process.
  const open = [...(runtime?.sessions?.values() ?? [])].filter(session => session.ghostId === scope.ghost_id
    && session.conversationId === scope.conversation_id);
  let unavailable = open.length === 0, unavailableReason = null, tasksTruncated = false, submissionsTruncated = false;
  for (const session of open.slice(0, PROJECTION_ROWS)) {
    let stage = 'public_inspection';
    try {
      const inspection = await session.harness.inspect(BACKGROUND_CONTEXT);
      stage = 'entry_inspection';
      const latest = await session.database.get('SELECT MAX(id) AS id FROM entries WHERE conversation_id=?', session.root.id);
      const assignment = session.controllerContext?.assignment;
      // This getter belongs to a current assignment. In an Owner session the
      // assignment document need not exist; inspect its real SDK task instead.
      stage = 'assignment_generation_inspection';
      const generation = assignment ? await session.controllerContext?.generationTaskId?.() : null;
      stage = 'task_projection';
      const tasks = inspection.tasks.slice(0, PROJECTION_ROWS).map(item => {
        const record = item.record, state = record.state, checkpoint = state.checkpoint ?? {};
        const started = number(record.startedAt);
        return { task_id: positive(record.id), kind: taskKinds.has(record.kind) ? record.kind : 'other',
          status: statuses.has(state.status) ? state.status : 'unknown', phase: phases.has(checkpoint.phase) ? checkpoint.phase : 'other',
          attempt: positive(checkpoint.attempt), started_at_ms: started,
          age_ms: started === null ? null : Math.max(0, observed - started), abort_requested: record.abortRequested === true };
      });
      stage = 'submission_projection';
      const submissions = inspection.submissions.slice(0, PROJECTION_ROWS).map(record => ({ submission_id: positive(record.id),
        status: ['queued', 'placed'].includes(record.status) ? record.status : 'unknown',
        request_id_digest: record.requestId === undefined ? null : hash(JSON.stringify(record.requestId)) }));
      tasksTruncated ||= inspection.tasks.length > PROJECTION_ROWS;
      submissionsTruncated ||= inspection.submissions.length > PROJECTION_ROWS;
      sessions.push({ context_ref: /^wc-[a-f0-9]{64}$/u.test(session.executionContext?.ref ?? '') ? session.executionContext.ref : null,
        pi_conversation_id: positive(session.root.id), assignment_id: identity(assignment?.id) ? assignment.id : null,
        work_id: identity(assignment?.work_id) ? assignment.work_id : null, goal_revision: positive(assignment?.goal_revision),
        generation_task_id: positive(generation), scheduling: ['running', 'paused', 'closing'].includes(inspection.scheduling) ? inspection.scheduling : 'unknown',
        latest_entry_id: positive(latest?.id), tasks, submissions });
    } catch { unavailable = true; unavailableReason ??= `${stage}_unavailable`; }
  }
  return { kind: 'ghost-functional-progress/1', diagnostic_only: true, observed_at_ms: observed,
    state: unavailable ? 'unavailable' : 'observed',
    ...(unavailable ? { reason_code: open.length === 0 ? 'no_open_matching_session' : unavailableReason } : {}),
    sessions, sessions_truncated: open.length > PROJECTION_ROWS, tasks_truncated: tasksTruncated,
    submissions_truncated: submissionsTruncated, provider_requests: providerRequests };
}

export function createFunctionalIdleObserver({ waitForIdle, hasOpenScope, progress, metrics, emit,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const records = new Map(), barriers = new Map(); let closed = false;
  const rejected = (frame, reason) => {
    emit({ type: 'observer_rejected', id: identity(frame?.id) ? frame.id : null,
      mode: FUNCTIONAL_OBSERVATION_MODE, reason_code: reason });
    return false;
  };
  const publish = (record, frame) => {
    record.latest = structuredClone(frame);
    emit(structuredClone(record.latest));
  };
  const readProgress = async record => {
    try { return await progress(record.scope); }
    catch { return { kind: 'ghost-functional-progress/1', diagnostic_only: true, state: 'unavailable', reason_code: 'runtime_inspection_unavailable' }; }
  };
  const base = record => ({ id: record.id, ghost_id: record.scope.ghost_id, conversation_id: record.scope.conversation_id,
    mode: FUNCTIONAL_OBSERVATION_MODE, barrier_id: record.barrier, stale: record.stale,
    observation_seq: ++record.sequence });
  const enqueue = (record, action) => {
    record.queue = record.queue.then(action).catch(() => {
      // Observation emission cannot alter the original SDK wait or close it.
      // A later explicit status request can still inspect the retained record.
    });
    return record.queue;
  };
  const checkpoint = (record, reason) => {
    if (closed || record.outcome) return;
    if (reason === 'observer_window_elapsed' || !record.reason) record.reason = reason;
    if (record.checkpointPending) return;
    record.checkpointPending = true;
    enqueue(record, async () => {
      try {
        if (closed || record.outcome) return;
        const observed = await readProgress(record);
        if (closed || record.outcome) return;
        const reasonCode = record.reason; record.reason = null;
        publish(record, { type: 'observation_checkpoint', ...base(record), observation: 'unconfirmed',
          reason_code: reasonCode, wait_pending: true, windows_elapsed: record.windows,
          progress: observed, metrics: metrics() });
      } finally { record.checkpointPending = false; }
    });
  };
  const arm = record => {
    if (closed || record.outcome) return;
    record.timer = setTimer(() => {
      record.timer = null;
      if (closed || record.outcome) return;
      record.windows++;
      checkpoint(record, 'observer_window_elapsed'); arm(record);
    }, IDLE_OBSERVATION_WINDOW_MS);
  };
  const settle = (record, outcome) => {
    record.outcome = outcome;
    if (record.timer !== null) clearTimer(record.timer);
    record.timer = null;
    enqueue(record, async () => {
      if (closed) return;
      const observed = await readProgress(record);
      if (closed) return;
      const result = { type: 'idle_result', ...base(record), observation: outcome, wait_pending: false,
        ...(outcome === 'runtime_rejected' ? { error_code: 'a04_idle_unconfirmed' } : {}),
        progress: observed, metrics: metrics() };
      record.terminal = structuredClone(result); publish(record, result);
    });
  };
  const exact = (record, frame) => validScope(frame) && record.scope.ghost_id === frame.ghost_id
    && record.scope.conversation_id === frame.conversation_id && !record.stale
    && record.barrier === barriers.get(scopeKey(frame));
  return {
    admitted(scope, barrier) {
      if (!validScope(scope) || !['string', 'number'].includes(typeof barrier)) return;
      const key = scopeKey(scope); barriers.set(key, barrier);
      for (const record of records.values()) if (scopeKey(record.scope) === key && record.barrier !== barrier) record.stale = true;
    },
    start(frame) {
      if (closed) return false;
      if (!validScope(frame) || !identity(frame.id)) return rejected(frame, 'invalid_probe');
      const prior = records.get(frame.id);
      if (prior) {
        if (!exact(prior, frame)) return rejected(frame, 'probe_identity_conflict');
        enqueue(prior, () => { if (!closed && prior.latest) emit(structuredClone(prior.latest)); });
        return true;
      }
      const barrier = barriers.get(scopeKey(frame));
      if (barrier === undefined || !hasOpenScope(frame)) return rejected(frame, 'probe_scope_unavailable');
      if ([...records.values()].some(record => !record.outcome && !record.stale && scopeKey(record.scope) === scopeKey(frame) && record.barrier === barrier)) {
        return rejected(frame, 'barrier_already_observed');
      }
      const record = { id: frame.id, scope: { ghost_id: frame.ghost_id, conversation_id: frame.conversation_id }, barrier,
        sequence: 0, windows: 0, stale: false, outcome: null, latest: null, terminal: null,
        queue: Promise.resolve(), checkpointPending: false, reason: null, timer: null, wait: null };
      records.set(record.id, record); arm(record);
      // Capture this one promise forever; neither observation timer nor status
      // request calls the SDK wait factory again (it can enable scheduling).
      record.wait = Promise.resolve().then(() => waitForIdle(record.scope));
      record.wait.then(() => settle(record, 'settled'), () => settle(record, 'runtime_rejected'));
      return true;
    },
    status(frame) {
      if (closed) return false;
      const record = records.get(frame?.id);
      if (!record || !exact(record, frame)) return rejected(frame, 'probe_identity_conflict');
      if (record.outcome) enqueue(record, () => { if (!closed && record.terminal) emit(structuredClone(record.terminal)); });
      else checkpoint(record, 'status_requested');
      return true;
    },
    close() {
      closed = true;
      for (const record of records.values()) if (record.timer !== null) clearTimer(record.timer);
      // No SDK cancel/abort/close/resume. The caller's existing explicit stop
      // owns runtime lifecycle and the original promise remains handled.
    },
  };
}
