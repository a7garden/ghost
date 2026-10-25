// Actual SDK/runtime; controlled Host metadata and provider only. The child
// stops after a genuine SDK submission and Host running receipt, before its ACK.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openGhostRuntime } from '../../src/runtime.js';
import { createBrokerModelProvider } from '../../src/models.js';
import { createHostToolTransport } from '../../src/host-transport.js';
import { payloadDigest } from '../../src/contract.js';
import { hostState, inspection, receipt, success, scope } from './selected-admission-fixture.mjs';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

export { scope };
export function envelope(id, body) {
  return { protocol_version: 'ghost-lifetime/1', command_id: id, payload_digest: payloadDigest(body), actor_ref: scope.ghost_id,
    authority_epoch: 1, expected_revision: null, correlation_id: id, body };
}
export const savedState = root => JSON.parse(readFileSync(join(root, 'controlled-host.json'), 'utf8'));
export const saveState = (root, state) => writeFileSync(join(root, 'controlled-host.json'), JSON.stringify(state), { mode: 0o600 });

export async function openStatusFixture(root, { holdRunning = false, queueExtra = false } = {}) {
  if (!existsSync(join(root, 'controlled-host.json'))) {
    saveState(root, { ...hostState(), receipts: {}, providerRequests: 0, run: null });
  }
  let runtime;
  const host = createHostToolTransport({ hostRoot: root, callbackToken: 'controlled-only', authorityEpoch: 1, dispatch: async request => {
    const body = request.envelope.body, state = savedState(root);
    let result;
    if (body.method === 'inference.inspect') result = success({ inference_scope: 'public' });
    else if (['memory.capabilities', 'documents.capabilities'].includes(body.method)) result = success({ available_tools: [] });
    else if (body.method === 'conversation.inspect') result = success({ ghost_id: scope.ghost_id, conversation_id: scope.conversation_id,
      turns: [{ id: scope.turn_id, kind: 'user' }], has_older: false });
    else if (body.method === 'conversation.turn.inspect') {
      result = inspection(state); if (state.run) result.data.run = state.run;
    } else if (body.method === 'goal.create') {
      state.calls.push({ command_id: request.envelope.command_id, payload_digest: request.envelope.payload_digest });
      if (!state.receipts[request.envelope.command_id]) {
        state.effects++; state.admitted = true; state.receipts[request.envelope.command_id] = receipt(request.envelope.command_id);
      }
      result = state.receipts[request.envelope.command_id];
      const drop = !state.dropped; state.dropped = true; saveState(root, state);
      if (drop) throw new Error('Controlled committed admission ACK loss');
    } else if (body.method === 'conversation.turn_status') {
      if (state.run?.submission_id && state.run.submission_id !== body.submission_id) throw new Error('Pinned Host SDK submission changed');
      state.run_state = body.status;
      state.run = { turn_id: scope.turn_id, ghost_id: scope.ghost_id, conversation_id: scope.conversation_id,
        state: body.status, cancel_requested: state.run?.cancel_requested ?? false, submission_id: body.submission_id,
        entry_id: body.entry_id, reason_code: body.reason_code, latest_status_command_id: request.envelope.command_id };
      // This dispatch receives the actual already-derived callback envelope.
      saveState(root, state); result = success({ run: state.run });
      if (holdRunning && body.status === 'running') {
        if (queueExtra) {
          const session = [...runtime.sessions.values()].find(session => session.ghostId === scope.ghost_id && session.conversationId === scope.conversation_id);
          const queued = await session.root.submit({ type: 'input', content: 'Unrelated controlled SDK input.', requestId: 'unrelated-sdk-input', whenBusy: 'followUp' }, BACKGROUND_CONTEXT);
          state.extra_submission_id = queued.id; saveState(root, state);
        }
        process.stdout.write(`${JSON.stringify({ stage: 'running_committed', submission_id: body.submission_id })}\n`);
        await new Promise(() => {});
      }
    } else if (body.method === 'conversation.reply') result = success({ turn_id: scope.turn_id });
    else throw new Error('Unexpected controlled status fixture callback');
    return { ok: true, result };
  } });
  const provider = createBrokerModelProvider({ modelRef: 'minimax-code/MiniMax-M2.7', invoke: async request => {
    const state = savedState(root); state.providerRequests++; saveState(root, state);
    return { id: request.id, status: 200, body: { id: request.id, object: 'chat.completion', model: 'minimax-code/MiniMax-M2.7', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Controlled selected responsibility acknowledgement.' }, finish_reason: 'stop' }] } };
  } });
  runtime = await openGhostRuntime({ root: join(root, 'runtime'), mode: 'broker', modelProvider: provider, hostToolTransport: host });
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2];
  const runtime = await openStatusFixture(root, { holdRunning: true, queueExtra: process.argv[3] === 'queued-input' });
  await runtime.handle(envelope(scope.turn_id, { method: 'conversation.input', ghost_id: scope.ghost_id, conversation_id: scope.conversation_id,
    turn_id: scope.turn_id, prompt: 'Perform the selected controlled task.', privacy: 'public', attachments: [] }));
  await runtime.waitForIdle(scope.ghost_id, scope.conversation_id);
  const observed = await runtime.handle(envelope('observe-original-admission', { method: 'conversation.inspect', ghost_id: scope.ghost_id,
    conversation_id: scope.conversation_id, selected_task_inspection: { turn_id: scope.turn_id } }));
  await runtime.handle(envelope('explicit-original-admission-recovery', { method: 'runtime.reconcile', ghost_id: scope.ghost_id,
    conversation_id: scope.conversation_id, selected_task_recovery: { turn_id: scope.turn_id, operation_id: observed.data.selected_task_inspection.operation_id } }));
  await new Promise(() => {});
}
