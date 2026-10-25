import { Harness, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openPiConversationStorage } from '../../src/storage.js';
import { createHostToolTransport } from '../../src/host-transport.js';
import { createSelectedTaskAdmission } from '../../src/selected-task-admission.js';
import { createFakeProvider } from '../fake-provider.js';

export const scope = { ghost_id: 'ghost', conversation_id: 'conversation', turn_id: 'selected-owner', inference_scope: 'public', conversation_disclosure: 'public' };
export const task = { task_contract_ref: `ot-${'a'.repeat(64)}`, mode: 'direct', input_digest: 'b'.repeat(64) };
export const success = data => ({ status: 'success', summary: 'Controlled Host receipt', object_refs: [], artifacts: [], next_actions: [], error_code: null, retry_class: 'same_id', data });
export function hostState() { return { selected: true, run_state: 'queued', cancelled: false, work_state: 'queued', admitted: false, calls: [], effects: 0, receipts: new Map() }; }
export function inspection(state, turn = scope.turn_id) {
  return success({ run: { turn_id: turn, ghost_id: scope.ghost_id, conversation_id: scope.conversation_id, state: state.run_state, cancel_requested: state.cancelled,
    submission_id: state.submission_id ?? null, entry_id: state.entry_id ?? null },
    task_contract: state.selected ? task : null,
    task_admission: state.selected ? { kind: 'owner-task-admission/1', ...scope, ...task, state: state.admitted ? 'admitted' : 'not_admitted',
      ...(state.admitted ? { goal_id: 'goal', goal_revision: 1, work_id: 'work', work_state: state.work_state } : {}) } : null });
}
export function receipt(commandId) {
  return success({ origin_turn_id: scope.turn_id,
    goal: { id: 'goal', revision: 1, accountable_ghost: scope.ghost_id, reply_conversation: scope.conversation_id,
      acceptance_spec: { verifier: { kind: 'owner-task-verifier/1', turn_id: scope.turn_id, task_contract_ref: task.task_contract_ref, input_digest: task.input_digest } } },
    work: { id: 'work', goal_id: 'goal', goal_revision: 1, owner: scope.ghost_id, owner_revision: 1, state: 'queued', cancellation: 'none' },
    automatic_admission: { engine: 'pi', work_id: 'work', assignment_id: 'assignment', source_command_id: commandId, delivery_state: 'queued', work_state: 'queued' } });
}
export async function openAdmissionFixture(root, state = hostState(), options = {}) {
  const transport = createHostToolTransport({ hostRoot: root, callbackToken: 'controlled', authorityEpoch: 1, dispatch: async request => {
    state.calls.push(request);
    const id = request.envelope.command_id;
    if (!state.receipts.has(id)) {
      state.effects++; state.admitted = true;
      state.receipts.set(id, options.response ? options.response(request) : receipt(id));
      if (options.committed) await options.committed(request, state);
    }
    if (options.dropAck && !state.dropped) { state.dropped = true; throw new Error('Controlled ACK loss after commit'); }
    return { ok: true, result: structuredClone(state.receipts.get(id)) };
  } });
  const admission = createSelectedTaskAdmission({ inspect: async turn => options.inspect ? options.inspect(inspection(state, turn), state) : inspection(state, turn),
    scope: async turn => ({ ...scope, turn_id: turn }), dispatch: transport });
  const opened = await openPiConversationStorage(root, scope.ghost_id, scope.conversation_id);
  const registry = createRegistry(), extension = defineExtension({ name: 'selected-admission-fixture', tasks: admission.tasks });
  registry.install(extension);
  const provider = createFakeProvider();
  const harness = await Harness.open(opened.storage, { registry, models: provider.models }, BACKGROUND_CONTEXT);
  const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: provider.modelRef, extensions: [extension] } });
  const session = { root: conversation, harness, context: BACKGROUND_CONTEXT };
  return { admission, session, state, database: opened.database, close: () => harness.close(BACKGROUND_CONTEXT) };
}
