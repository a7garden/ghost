import { defineDocFamily, defineTask } from '@earendil-works/pi-durable';
import { payloadDigest, ProtocolError } from './contract.js';
import { callbackCommandId, taskContractGoalBody } from './host-transport.js';

const bounded = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 400;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const unknown = intent => ({ state: 'unknown', operation_id: intent.operation_id, command_id: intent.command_id, body_digest: intent.body_digest });
const blocked = () => ({ state: 'blocked' });
const fail = () => { throw new ProtocolError('selected_task_admission_blocked', 'Fresh exact Owner task admission authority is unavailable.', 'never'); };

export const SelectedTaskAdmissionDoc = defineDocFamily({
  kind: 'ghost.selected-task-admission/1', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', family: true,
  initial: intent => ({ intent, task_id: null, dispatch_started: false, outcome: null, recoveries: [] }),
});

export function selectedTaskAuthority(inspection, scope, { recovery = false } = {}) {
  const run = inspection?.data?.run;
  if (inspection?.status !== 'success' || run?.turn_id !== scope.turn_id || run.ghost_id !== scope.ghost_id
    || run.conversation_id !== scope.conversation_id || run.cancel_requested !== false
    || !(recovery ? ['queued', 'running', 'effect_unknown'] : ['queued', 'running']).includes(run.state)) return fail();
  const task = inspection.data.task_contract, admission = inspection.data.task_admission;
  if (task == null && admission == null) return null;
  if (run.submission_id !== null || run.entry_id !== null) return fail();
  if (!task || !admission || typeof task.task_contract_ref !== 'string' || !/^ot-[a-f0-9]{64}$/u.test(task.task_contract_ref)
    || !['direct', 'delegate'].includes(task.mode) || !hex(task.input_digest)
    || admission.kind !== 'owner-task-admission/1' || admission.turn_id !== scope.turn_id
    || admission.ghost_id !== scope.ghost_id || admission.conversation_id !== scope.conversation_id
    || admission.task_contract_ref !== task.task_contract_ref || admission.input_digest !== task.input_digest
    || !['not_admitted', 'admitted'].includes(admission.state)) return fail();
  if (admission.state === 'admitted' && (!bounded(admission.goal_id) || !bounded(admission.work_id)
    || !Number.isSafeInteger(admission.goal_revision) || admission.goal_revision < 1)) return fail();
  return { task: { task_contract_ref: task.task_contract_ref, mode: task.mode, input_digest: task.input_digest }, admission };
}

export function selectedTaskIntent(scope, task) {
  const body = taskContractGoalBody({ ghostId: scope.ghost_id, conversationId: scope.conversation_id,
    turnId: scope.turn_id, taskContractRef: task.task_contract_ref });
  const operation_id = `selected-task:${payloadDigest({ ghost_id: scope.ghost_id, conversation_id: scope.conversation_id,
    turn_id: scope.turn_id, task_contract_ref: task.task_contract_ref, input_digest: task.input_digest })}`;
  const request = { ...scope, method: 'goal.create', invocation_id: operation_id, arguments: { task_contract_ref: task.task_contract_ref } };
  return { operation_id, command_id: callbackCommandId(scope.ghost_id, scope.conversation_id, operation_id, 'goal.create'),
    body_digest: payloadDigest(body), body, task, request };
}

function sameSelection(authority, intent) {
  if (!authority || payloadDigest(authority.task) !== payloadDigest(intent.task)) return fail();
  return authority;
}
function observed(authority, intent = null) {
  return { state: 'admitted', provenance: 'observed_existing', ...(intent ? { operation_id: intent.operation_id } : {}),
    goal_id: authority.admission.goal_id, goal_revision: authority.admission.goal_revision,
    work_id: authority.admission.work_id, work_state: authority.admission.work_state };
}
function verifyReceipt(response, intent, authority) {
  const data = response?.data, goal = data?.goal, work = data?.work, automatic = data?.automatic_admission;
  const verifier = goal?.acceptance_spec?.verifier, fresh = sameSelection(authority, intent).admission;
  if (response?.status !== 'success' || data.origin_turn_id !== intent.request.turn_id
    || !bounded(goal?.id) || goal.accountable_ghost !== intent.request.ghost_id || goal.reply_conversation !== intent.request.conversation_id
    || !Number.isSafeInteger(goal.revision) || goal.revision < 1
    || verifier?.kind !== 'owner-task-verifier/1' || verifier.turn_id !== intent.request.turn_id
    || verifier.task_contract_ref !== intent.task.task_contract_ref || verifier.input_digest !== intent.task.input_digest
    || !bounded(work?.id) || work.goal_id !== goal.id || work.goal_revision !== goal.revision || work.owner !== intent.request.ghost_id
    || !Number.isSafeInteger(work.owner_revision) || work.owner_revision < 1 || work.cancellation !== 'none'
    || automatic?.engine !== 'pi' || automatic.work_id !== work.id || !bounded(automatic.assignment_id)
    || !bounded(automatic.source_command_id) || !['queued', 'acknowledged'].includes(automatic.delivery_state)
    || fresh.state !== 'admitted' || fresh.goal_id !== goal.id || fresh.goal_revision !== goal.revision || fresh.work_id !== work.id) return fail();
  return { state: 'admitted', provenance: automatic.source_command_id === intent.command_id ? 'runtime_created' : 'observed_existing',
    operation_id: intent.operation_id, command_id: intent.command_id, body_digest: intent.body_digest,
    source_command_id: automatic.source_command_id, assignment_id: automatic.assignment_id,
    goal_id: goal.id, goal_revision: goal.revision, work_id: work.id, work_state: fresh.work_state,
    response_digest: payloadDigest(response) };
}
function corroborate(result, authority) {
  if (result?.state !== 'admitted' || authority?.admission.state !== 'admitted'
    || result.goal_id !== authority.admission.goal_id || result.goal_revision !== authority.admission.goal_revision
    || result.work_id !== authority.admission.work_id) return fail();
  return { ...result, work_state: authority.admission.work_state };
}

const observationUnavailable = () => { throw new ProtocolError('selected_task_observation_unavailable', 'Persisted selected-task evidence cannot be safely projected.', 'never'); };
const operation = value => typeof value === 'string' && /^selected-task:[a-f0-9]{64}$/u.test(value);
const taskId = value => value === null || (Number.isSafeInteger(value) && value >= 1);
function projectedOutcome(value, intent) {
  if (value === null) return null;
  if (!value || !['blocked', 'unknown', 'admitted'].includes(value.state)) return observationUnavailable();
  if (value.state === 'blocked') return { state: 'blocked' };
  if (value.operation_id !== intent.operation_id) return observationUnavailable();
  const result = { state: value.state, operation_id: value.operation_id };
  for (const name of ['command_id', 'source_command_id', 'assignment_id', 'goal_id', 'work_id', 'work_state']) {
    if (!Object.hasOwn(value, name)) continue;
    if (!bounded(value[name]) || (name === 'command_id' && value[name] !== intent.command_id)) return observationUnavailable();
    result[name] = value[name];
  }
  for (const name of ['body_digest', 'response_digest']) {
    if (!Object.hasOwn(value, name)) continue;
    if (!hex(value[name]) || (name === 'body_digest' && value[name] !== intent.body_digest)) return observationUnavailable();
    result[name] = value[name];
  }
  if (value.state === 'unknown') {
    if (!result.command_id || !result.body_digest) return observationUnavailable();
    return { state: 'unknown', operation_id: result.operation_id, command_id: result.command_id, body_digest: result.body_digest };
  }
  if (!['runtime_created', 'observed_existing'].includes(value.provenance) || !result.goal_id || !result.work_id || !result.work_state
    || !Number.isSafeInteger(value.goal_revision) || value.goal_revision < 1) return observationUnavailable();
  if (value.provenance === 'runtime_created' && (!result.command_id || result.source_command_id !== result.command_id
    || !result.assignment_id || !result.body_digest || !result.response_digest)) return observationUnavailable();
  if (value.provenance === 'observed_existing' && result.command_id && result.source_command_id === result.command_id) return observationUnavailable();
  return { ...result, provenance: value.provenance, goal_revision: value.goal_revision };
}

export function selectedTaskObservation(doc, turn, expectedScope = null) {
  if (!bounded(turn)) return observationUnavailable();
  const base = { kind: 'ghost.selected-task-admission-observation/1', turn_id: turn, exists: doc !== undefined && doc !== null };
  if (!base.exists) return base;
  const intent = doc.intent;
  if (!intent || intent.request?.turn_id !== turn || !operation(intent.operation_id) || !bounded(intent.command_id) || !hex(intent.body_digest)
    || typeof doc.dispatch_started !== 'boolean' || !taskId(doc.task_id) || !Array.isArray(doc.recoveries) || doc.recoveries.length > 8) return observationUnavailable();
  if (expectedScope && (intent.request.ghost_id !== expectedScope.ghost_id || intent.request.conversation_id !== expectedScope.conversation_id)) return observationUnavailable();
  const ids = new Set();
  const recoveries = doc.recoveries.map(item => {
    if (!item || !bounded(item.request_id) || ids.has(item.request_id) || typeof item.started !== 'boolean' || !taskId(item.task_id)) return observationUnavailable();
    ids.add(item.request_id);
    return { request_id: item.request_id, started: item.started, task_id: item.task_id, outcome: projectedOutcome(item.outcome, intent) };
  });
  const result = { ...base, operation_id: intent.operation_id, command_id: intent.command_id, body_digest: intent.body_digest,
    dispatch_started: doc.dispatch_started, original_task_id: doc.task_id, outcome: projectedOutcome(doc.outcome, intent), recoveries };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 64 * 1024) return observationUnavailable();
  return result;
}

export function createSelectedTaskAdmission({ inspect, scope, dispatch }) {
  const authority = async (intent, recovery = false) => {
    const current = await scope(intent.request.turn_id, recovery);
    if (current.ghost_id !== intent.request.ghost_id || current.conversation_id !== intent.request.conversation_id
      || current.turn_id !== intent.request.turn_id || current.inference_scope !== intent.request.inference_scope
      || current.conversation_disclosure !== intent.request.conversation_disclosure) return fail();
    return sameSelection(selectedTaskAuthority(await inspect(current.turn_id), current, { recovery }), intent);
  };
  const run = async (task, runtime, context, recovery) => {
    const intent = task.input.intent;
    const finish = async result => runtime.commit(async tx => {
      const doc = await tx.doc(SelectedTaskAdmissionDoc, runtime.conversationId, intent.request.turn_id, intent);
      if (payloadDigest(doc.intent) !== payloadDigest(intent)) return fail();
      if (recovery) {
        const evidence = doc.recoveries.find(item => item.request_id === task.input.reconcile_id);
        if (!evidence) return fail();
        evidence.outcome ??= result;
      } else doc.outcome ??= result;
      return { status: 'terminal', outcome: { status: 'completed', result } };
    }, context);
    if (task.state.checkpoint.started) { await finish(unknown(intent)); return; }
    let fresh;
    try { fresh = await authority(intent, recovery); }
    catch { await finish(blocked()); return; }
    if (!recovery && fresh.admission.state === 'admitted') { await finish(observed(fresh, intent)); return; }
    await runtime.commit(async tx => {
      const doc = await tx.doc(SelectedTaskAdmissionDoc, runtime.conversationId, intent.request.turn_id, intent);
      if (payloadDigest(doc.intent) !== payloadDigest(intent)) return fail();
      if (recovery) {
        const evidence = doc.recoveries.find(item => item.request_id === task.input.reconcile_id);
        if (!evidence || evidence.started) return fail();
        evidence.started = true;
      } else {
        if (doc.dispatch_started) return fail();
        doc.dispatch_started = true;
      }
      return { status: 'running', checkpoint: { phase: 'dispatch', started: true } };
    }, context);
    let result;
    try {
      // Recheck cancellation/scope after the durable marker and before I/O.
      await authority(intent, recovery);
      const response = await dispatch(intent.request, context);
      result = verifyReceipt(response, intent, await authority(intent, recovery));
    } catch { result = unknown(intent); }
    await finish(result);
  };
  const task = defineTask({ name: 'ghost.selected-task-admission', version: 1,
    initial: () => ({ phase: 'dispatch', started: false }), phases: { dispatch: (task, runtime, context) => run(task, runtime, context, false) },
    abort: async (task, runtime, context) => runtime.commit(async tx => {
      const doc = await tx.doc(SelectedTaskAdmissionDoc, runtime.conversationId, task.input.intent.request.turn_id, task.input.intent);
      const result = doc.dispatch_started ? unknown(task.input.intent) : blocked(); doc.outcome ??= result;
      return { status: 'terminal', outcome: { status: 'completed', result } };
    }, context),
  });
  const recoveryTask = defineTask({ name: 'ghost.selected-task-admission-recovery', version: 1,
    initial: () => ({ phase: 'dispatch', started: false }), phases: { dispatch: (task, runtime, context) => run(task, runtime, context, true) },
    abort: async (task, runtime, context) => runtime.commit(async tx => {
      const doc = await tx.doc(SelectedTaskAdmissionDoc, runtime.conversationId, task.input.intent.request.turn_id, task.input.intent);
      const evidence = doc.recoveries.find(item => item.request_id === task.input.reconcile_id);
      const result = unknown(task.input.intent); if (evidence) evidence.outcome ??= result;
      return { status: 'terminal', outcome: { status: 'completed', result } };
    }, context),
  });
  const read = (session, turn) => session.harness.snapshot(SelectedTaskAdmissionDoc, session.root.id, turn, session.context);
  const wait = async (session, id) => {
    const settled = await session.harness.waitForTask(id, session.context);
    return settled.state.outcome.status === 'completed' ? settled.state.outcome.result : { state: 'unknown' };
  };
  const recoveryIntent = async (session, turn, expectedOperationId) => {
    const prior = await read(session, turn);
    if (expectedOperationId !== undefined && prior?.intent.operation_id !== expectedOperationId) return fail();
    if (!prior) return null;
    if (prior.intent.request.turn_id !== turn || prior.dispatch_started !== true || prior.task_id === null
      || (prior.outcome !== null && prior.outcome.state !== 'unknown')) return fail();
    return prior;
  };
  return {
    tasks: [task, recoveryTask],
    async observation(session, turn, expectedScope = null) { return selectedTaskObservation(await read(session, turn), turn, expectedScope); },
    async recoveryReceipt(session, turn, expectedOperationId, reconcileId) {
      const prior = await read(session, turn);
      if (!prior || prior.intent.operation_id !== expectedOperationId || prior.intent.request.turn_id !== turn) return null;
      return prior.recoveries.find(item => item.request_id === reconcileId)?.outcome ?? null;
    },
    async corroborateRecovery(session, turn, expectedOperationId, reconcileId) {
      const prior = await read(session, turn);
      if (!prior || prior.intent.operation_id !== expectedOperationId || prior.intent.request.turn_id !== turn) return fail();
      const outcome = prior.recoveries.find(item => item.request_id === reconcileId)?.outcome;
      return corroborate(outcome, await authority(prior.intent, true));
    },
    async validateRecovery(session, turn, expectedOperationId) {
      const prior = await recoveryIntent(session, turn, expectedOperationId);
      if (!prior) return fail();
      await authority(prior.intent, true);
    },
    async ensure(session, turn) {
      const prior = await read(session, turn);
      const recovered = prior ? [...prior.recoveries].reverse().find(item => item.outcome?.state === 'admitted') : null;
      const current = await scope(turn, Boolean(recovered)), fresh = selectedTaskAuthority(await inspect(turn), current, { recovery: Boolean(recovered) });
      if (!fresh) { if (prior) return fail(); return null; }
      const intent = selectedTaskIntent(current, fresh.task);
      if (prior) {
        if (payloadDigest(prior.intent) !== payloadDigest(intent)) return fail();
        if (recovered) return { ...corroborate(recovered.outcome, fresh), recovery_request_id: recovered.request_id };
        if (prior.outcome) return prior.outcome.state === 'admitted' ? corroborate(prior.outcome, fresh) : prior.outcome;
      } else if (fresh.admission.state === 'admitted') return observed(fresh);
      const id = await session.root.commit(async tx => {
        const doc = await tx.doc(SelectedTaskAdmissionDoc, session.root.id, turn, intent);
        if (payloadDigest(doc.intent) !== payloadDigest(intent)) return fail();
        doc.task_id ??= await tx.createTask(task, { intent }, { ownership: { kind: 'conversation' } });
        return doc.task_id;
      }, session.context);
      return wait(session, id);
    },
    async reconcile(session, turn, reconcileId, expectedOperationId) {
      // Validate the attempted original operation before waiting can resume
      // any SDK task. Recovery must never first-start an unattempted intent.
      let prior = await recoveryIntent(session, turn, expectedOperationId);
      if (!prior) return null;
      await authority(prior.intent, true);
      if (!prior.outcome && prior.task_id !== null) { await wait(session, prior.task_id); prior = await read(session, turn); }
      if (prior.outcome?.state !== 'unknown') return null;
      await authority(prior.intent, true);
      const id = await session.root.commit(async tx => {
        const doc = await tx.doc(SelectedTaskAdmissionDoc, session.root.id, turn, prior.intent);
        let evidence = doc.recoveries.find(item => item.request_id === reconcileId);
        if (!evidence) {
          if (doc.recoveries.length >= 8) return fail();
          evidence = { request_id: reconcileId, started: false, task_id: null, outcome: null };
          doc.recoveries.push(evidence);
        }
        evidence.task_id ??= await tx.createTask(recoveryTask, { intent: doc.intent, reconcile_id: reconcileId }, { ownership: { kind: 'conversation' } });
        return evidence.task_id;
      }, session.context);
      return wait(session, id);
    },
  };
}
