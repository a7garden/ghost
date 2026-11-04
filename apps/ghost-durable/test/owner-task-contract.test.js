import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGhostRuntime } from "../src/runtime.js";
import { createBrokerModelProvider, createLocalModelProvider } from "../src/models.js";
import { payloadDigest } from "../src/contract.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostToolTransport, callbackCommandId } from "../src/host-transport.js";
import { createRegisteredModelProvider } from "../src/registered-models.js";
import { openGhostIndex } from "../src/storage.js";
const taskRef=`ot-${"a".repeat(64)}`, templateRef=`dt-${"b".repeat(64)}`;

test("Owner task and target-free delegation forward opaque Host refs without producer acceptance authority",async()=>{
  const requests=[];
  const transport=createHostToolTransport({hostRoot:"/tmp/owner-task-fixture",callbackToken:"fixture",authorityEpoch:2,dispatch:async request=>{
    requests.push(request);const method=request.envelope.body.method;
    return {ok:true,result:{status:"success",summary:"Host fixture receipt",artifacts:[],next_actions:[],data:method==="work.inspect"?{work:{id:"parent",goal_id:"goal",goal_revision:3,owner:"ghost"}}:method==="goal.inspect"?{goal:{id:"goal",revision:3,accountable_ghost:"ghost",reply_conversation:"conversation",acceptance_spec:{}}}:{}}};
  }});
  const scope={ghost_id:"ghost",conversation_id:"conversation",turn_id:"actual-owner-turn",inference_scope:"public",conversation_disclosure:"public",invocation_id:"owner-task-create"};
  await transport({...scope,method:"goal.create",arguments:{task_contract_ref:taskRef}});
  assert.deepEqual(requests[0].envelope.body,{method:"goal.create",turn_id:scope.turn_id,ghost_id:"ghost",conversation_id:"conversation",task_contract_ref:taskRef});
  assert.equal(requests[0].envelope.actor_ref,"ghost");
  const args={parent_work_id:"parent",template_ref:templateRef,target_ghost_id:"model-selected-ready-bot"};
  await transport({...scope,method:"work.delegate",arguments:args});
  const delegated=requests.find(request=>request.envelope.body.method==="work.delegate");
  assert.deepEqual(delegated.envelope.body,{method:"work.delegate",...args});assert.equal(delegated.envelope.expected_revision,3);
  for(const extra of [{prompt:"replacement"},{acceptance_spec:{}},{input:{}},{verifier:"exit 0"},{turn_id:"other"},{actor_ref:"owner"}]) await assert.rejects(transport({...scope,method:"goal.create",arguments:{task_contract_ref:taskRef,...extra}}));
  for(const extra of [{summary:"replacement"},{acceptance_spec:{}},{artifact_refs:[]},{contract_ref:`dc-${"c".repeat(64)}`},{owner_approved:true}]) await assert.rejects(transport({...scope,method:"work.delegate",arguments:{...args,...extra}}));
  await assert.rejects(transport({...scope,turn_id:undefined,method:"goal.create",arguments:{task_contract_ref:taskRef}}));
  assert.equal(requests.filter(request=>request.envelope.body.method==="goal.create").length,1);assert.equal(requests.filter(request=>request.envelope.body.method==="work.delegate").length,1);
});

test("current Owner reads and uses only its Host task reference once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-bot-owner-")); const callbacks = [], requests = [], runs = new Map(); let runtime;
  const host = async input => {
    callbacks.push(input);
    if (input.method === "inference.inspect") return { status: "success", data: { inference_scope: "public" } };
    if (["memory.capabilities", "documents.capabilities"].includes(input.method)) return { status: "success", data: { available_tools: [] } };
    if (input.method === "conversation.turn.inspect") return { status: "success", data: { task_admission: {kind:"owner-task-admission/1",turn_id:input.turn_id,ghost_id:"ghost",conversation_id:"conversation",task_contract_ref:taskRef,input_digest:"c".repeat(64),state:callbacks.some(call=>call.method==="goal.create")?"admitted":"not_admitted",goal_id:"new-goal",goal_revision:1,work_id:"new-work",work_state:"queued"}, task_contract: {task_contract_ref:taskRef,mode:"delegate",input_digest:"c".repeat(64),input_contract:{type:"object"},output_contract:{type:"string"}}, run: runs.get(input.turn_id) ?? { turn_id: input.turn_id, ghost_id: "ghost", conversation_id: "conversation", state: "queued", cancel_requested: false, cancel_command_id: null, submission_id: null, entry_id: null, reason_code: null, latest_status_command_id: null, created_at_ms: 1, updated_at_ms: 1 } } };
    if (input.method === "conversation.turn_status") { const run = { turn_id: input.turn_id, ghost_id: "ghost", conversation_id: "conversation", state: input.arguments.status, cancel_requested: false, cancel_command_id: null, submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code, latest_status_command_id: input.invocation_id, created_at_ms: 1, updated_at_ms: 2 }; runs.set(input.turn_id, run); return { status: "success", data: { run } }; }
    if (input.method === "conversation.reply") return { status: "success", data: { turn_id: input.turn_id } };
    assert.equal(input.turn_id, "create-bot-turn");
    if (input.method === "goal.create") {
      assert.deepEqual(input.arguments,{task_contract_ref:taskRef});
      return {status:"success",data:{origin_turn_id:input.turn_id,
        goal:{id:"new-goal",revision:1,accountable_ghost:"ghost",reply_conversation:"conversation",acceptance_spec:{verifier:{kind:"owner-task-verifier/1",turn_id:input.turn_id,task_contract_ref:taskRef,input_digest:"c".repeat(64)}}},
        work:{id:"new-work",goal_id:"new-goal",goal_revision:1,owner:"ghost",owner_revision:1,state:"queued",cancellation:"none"},
        automatic_admission:{engine:"pi",work_id:"new-work",assignment_id:"new-assignment",source_command_id:callbackCommandId("ghost","conversation",input.invocation_id,"goal.create"),delivery_state:"queued",work_state:"queued"}}};
    }
    throw new Error(`Unexpected bot callback ${input.method}`);
  };
  const steps=[["task_contract_inspect",{}]];
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
    requests.push(request); const step = steps[requests.length - 1];
    const message = step ? { role: "assistant", content: null, tool_calls: [{ id: `bot-call-${requests.length}`, type: "function", function: { name: step[0], arguments: JSON.stringify(step[1]) } }] } : { role: "assistant", content: "The registered task is admitted; independent verification remains pending." };
    return { id: request.id, status: 200, body: { id: `completion-${requests.length}`, object: "chat.completion", model: "minimax-code/MiniMax-M2.7", created: 1, choices: [{ index: 0, message, finish_reason: step ? "tool_calls" : "stop" }] } };
  } });
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host });
    const body = { method: "conversation.input", ghost_id: "ghost", conversation_id: "conversation", turn_id: "create-bot-turn", prompt: "Compare the newly selected products for my commute.", privacy: "public", attachments: [] };
    const envelope = { protocol_version: "ghost-lifetime/1", command_id: "create-bot-turn", payload_digest: payloadDigest(body), actor_ref: "ghost", authority_epoch: 1, expected_revision: null, correlation_id: "create-bot-turn", body };
    assert.equal((await runtime.handle(envelope)).status, "success"); await runtime.waitForIdle("ghost", "conversation");
    assert.equal(requests.length,2); assert.equal(callbacks.filter(input=>input.method==="goal.create").length,1);
    for (const name of ["task_contract_inspect", "goal_create"]) assert.equal(requests[0].body.tools.some(tool => tool.function.name === name), true);
    const initialSystem = requests[0].body.messages.filter(message=>["system","developer"].includes(message.role)).map(message=>message.content).join("\n");
    assert.ok(initialSystem.includes(`"task_contract_ref":"${taskRef}"`));
    assert.ok(initialSystem.includes("immutable input is already supplied"));
    assert.ok(callbacks.filter(input=>input.method==="conversation.turn.inspect").every(input=>input.turn_id==="create-bot-turn"));
    assert.equal(callbacks.find(input => input.method === "conversation.reply").arguments.text.includes("pending"), true);
    await runtime.handle(envelope); await runtime.waitForIdle("ghost", "conversation"); assert.equal(requests.length, 2, "same turn replay cannot create another Goal");
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("targeted runtime recovery cannot wake a queued unattempted Owner admission", async () => {
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { SelectedTaskAdmissionDoc, selectedTaskIntent } = await import('../src/selected-task-admission.js');
  const { hostState, inspection, scope, task, success } = await import('./fixtures/selected-admission-fixture.mjs');
  const root = await mkdtemp(join(tmpdir(), 'ghost-selected-no-wake-'));
  const state = hostState(), calls = [], requests = []; let runtime;
  const provider = createBrokerModelProvider({ modelRef: 'minimax-code/MiniMax-M2.7', invoke: async request => {
    requests.push(request); throw new Error('Rejected recovery must not admit model generation');
  } });
  const host = async input => {
    calls.push(input);
    if (input.method === 'inference.inspect') return success({ inference_scope: 'public' });
    if (['memory.capabilities', 'documents.capabilities'].includes(input.method)) return success({ available_tools: [] });
    if (input.method === 'conversation.turn.inspect') return inspection(state);
    if (input.method === 'goal.create') throw new Error('Rejected recovery must not first-dispatch admission');
    if (input.method === 'conversation.turn_status') return success({ run: { ...inspection(state).data.run, state: input.arguments.status,
      submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code } });
    throw new Error(`Unexpected no-wake callback ${input.method}`);
  };
  const frame = (id, body) => ({ protocol_version: 'ghost-lifetime/1', command_id: id, payload_digest: payloadDigest(body), actor_ref: 'host-recovery',
    authority_epoch: 1, expected_revision: null, correlation_id: id, body });
  const sessionFor = () => [...runtime.sessions.values()].find(session => session.ghostId === scope.ghost_id && session.conversationId === scope.conversation_id);
  try {
    runtime = await openGhostRuntime({ root, mode: 'broker', modelProvider: provider, hostToolTransport: host });
    assert.equal((await runtime.handle(frame('prepare-owner', { method: 'conversation.ensure', ghost_id: scope.ghost_id, conversation_id: scope.conversation_id }))).status, 'success');
    const prepared = sessionFor();
    // Hold only volatile scheduling while the real input receiver commits its
    // accepted queue/receipt. Cold reopen removes this test preparation hold.
    prepared.canonicalScheduler = Promise.resolve();
    const input = frame(scope.turn_id, { method: 'conversation.input', ghost_id: scope.ghost_id, conversation_id: scope.conversation_id,
      turn_id: scope.turn_id, prompt: 'Perform the selected responsibility.', privacy: 'public', attachments: [] });
    assert.equal((await runtime.handle(input)).status, 'success');
    const intent = selectedTaskIntent(scope, task);
    const taskId = await prepared.root.commit(async tx => {
      const doc = await tx.doc(SelectedTaskAdmissionDoc, prepared.root.id, scope.turn_id, intent);
      doc.task_id = await tx.createTask(prepared.selectedAdmission.tasks[0], { intent }, { ownership: { kind: 'conversation' } });
      return doc.task_id;
    }, BACKGROUND_CONTEXT);
    const originalDoc = JSON.stringify(await prepared.harness.snapshot(SelectedTaskAdmissionDoc, prepared.root.id, scope.turn_id, BACKGROUND_CONTEXT));
    const originalTask = await prepared.database.get('SELECT record FROM tasks WHERE id=?', taskId);
    const originalReceipt = await prepared.index.get('SELECT response_json FROM ghost_command_receipts WHERE command_id=?', input.command_id);
    assert.equal(JSON.parse(originalDoc).dispatch_started, false); assert.equal(JSON.parse(originalTask.record).state.status, 'pending');
    assert.equal(JSON.parse(originalReceipt.response_json).status, 'success');
    await runtime.close();
    runtime = await openGhostRuntime({ root, mode: 'broker', modelProvider: provider, hostToolTransport: host });
    const inspectBody = { method: 'conversation.inspect', ghost_id: scope.ghost_id, conversation_id: scope.conversation_id,
      selected_task_inspection: { turn_id: scope.turn_id } };
    const evidence = await runtime.handle(frame('inspect-unattempted', inspectBody));
    assert.equal(evidence.status, 'success'); assert.equal(evidence.data.runtime_kind, 'pi-durable'); assert.equal(evidence.data.runtime_release, '1.1.0');
    assert.equal(evidence.data.ghost_id, scope.ghost_id); assert.equal(evidence.data.conversation_id, scope.conversation_id);
    assert.equal(typeof evidence.data.storage_ref, 'string'); assert.equal(evidence.data.selected_task_inspection.exists, true);
    assert.equal(evidence.data.selected_task_inspection.operation_id, intent.operation_id);
    assert.equal(evidence.data.selected_task_inspection.original_task_id, taskId);
    assert.equal(evidence.data.selected_task_inspection.dispatch_started, false); assert.equal(evidence.data.selected_task_inspection.outcome, null);
    assert.equal(Object.hasOwn(evidence.data, 'committed_view'), false); assert.equal(JSON.stringify(evidence).includes(task.task_contract_ref), false);
    const missing = await runtime.handle(frame('inspect-missing', { ...inspectBody, selected_task_inspection: { turn_id: 'no-persisted-task' } }));
    assert.deepEqual(missing.data.selected_task_inspection, { kind: 'ghost.selected-task-admission-observation/1', turn_id: 'no-persisted-task', exists: false });
    for (const [id, selector] of [['null', null], ['array', []], ['extra', { turn_id: scope.turn_id, operation_id: intent.operation_id }], ['utf8', { turn_id: '가'.repeat(134) }]]) {
      const invalid = await runtime.handle(frame(`inspect-invalid-${id}`, { ...inspectBody, selected_task_inspection: selector }));
      assert.equal(invalid.status, 'error'); assert.equal(invalid.error_code, 'invalid_envelope');
    }
    const inspectedSession = sessionFor();
    assert.equal(inspectedSession.canonicalScheduler, null); assert.equal(inspectedSession.schedulerRequested, false);
    assert.equal((await inspectedSession.harness.inspect(BACKGROUND_CONTEXT)).scheduling, 'paused');
    assert.equal(JSON.stringify(await inspectedSession.harness.snapshot(SelectedTaskAdmissionDoc, inspectedSession.root.id, scope.turn_id, BACKGROUND_CONTEXT)), originalDoc);
    assert.equal(await inspectedSession.harness.snapshot(SelectedTaskAdmissionDoc, inspectedSession.root.id, 'no-persisted-task', BACKGROUND_CONTEXT), undefined);
    assert.deepEqual(await inspectedSession.database.get('SELECT record FROM tasks WHERE id=?', taskId), originalTask);
    assert.equal((await inspectedSession.database.get('SELECT count(*) AS total FROM tasks')).total, 1, 'inspection creates no task');
    assert.equal(calls.length, 0, 'persisted evidence inspection never asks Host authority or starts tools');
    for (const [id, target] of [
      ['wrong-operation', { turn_id: scope.turn_id, operation_id: `selected-task:${'0'.repeat(64)}` }],
      ['wrong-turn', { turn_id: 'foreign-owner', operation_id: intent.operation_id }],
      ['unattempted-original', { turn_id: scope.turn_id, operation_id: intent.operation_id }],
    ]) {
      const result = await runtime.handle(frame(id, { method: 'runtime.reconcile', ghost_id: scope.ghost_id,
        conversation_id: scope.conversation_id, selected_task_recovery: target }));
      assert.equal(result.status, 'success'); assert.equal(result.data.selected_task_recoveries[0].state, 'blocked');
      const session = sessionFor();
      // Join only work already requested by the handler. waitForIdle would
      // itself enable the SDK scheduler and invalidate this no-wake proof.
      await Promise.all([...session.canonicalSettlements]);
      assert.equal(session.canonicalScheduler, null, id); assert.equal(session.schedulerRequested, false, id);
      assert.equal((await session.harness.inspect(BACKGROUND_CONTEXT)).scheduling, 'paused', id);
      assert.equal(JSON.stringify(await session.harness.snapshot(SelectedTaskAdmissionDoc, session.root.id, scope.turn_id, BACKGROUND_CONTEXT)), originalDoc, id);
      assert.deepEqual(await session.database.get('SELECT record FROM tasks WHERE id=?', taskId), originalTask, id);
      assert.deepEqual(await session.index.get('SELECT response_json FROM ghost_command_receipts WHERE command_id=?', input.command_id), originalReceipt, id);
      assert.equal((await session.index.get('SELECT status FROM ghost_canonical_turn_runs WHERE turn_id=?', scope.turn_id)).status, 'queued', id);
      assert.equal(calls.filter(call => call.method === 'goal.create').length, 0, id); assert.equal(requests.length, 0, id);
    }
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("canonical selected-task bootstrap recovers a lost ACK only through explicit reconciliation before its one Owner SDK acknowledgement", async () => {
  const { createHash } = await import('node:crypto');
  const { DatabaseSync } = await import('node:sqlite');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { hostState, inspection, receipt, scope, task, success } = await import('./fixtures/selected-admission-fixture.mjs');
  const root = await mkdtemp(join(tmpdir(), 'ghost-selected-runtime-'));
  const state = hostState(), callbacks = [], requests = [], diagnostics = [], replies = []; let runtime, run, markRunning, releaseRunning;
  let routeSelections = 0, routeDrift = false;
  const runningSeen = new Promise(resolve => { markRunning = resolve; });
  const runningAck = new Promise(resolve => { releaseRunning = resolve; });
  const boundedWait = promise => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Controlled runtime admission barrier expired')), 5000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  const host = createHostToolTransport({ hostRoot: root, callbackToken: 'controlled', authorityEpoch: 1, dispatch: async request => {
    const body = request.envelope.body; callbacks.push(request);
    if (body.method === 'inference.inspect') return { ok: true, result: success({ inference_scope: 'public' }) };
    if (['memory.capabilities', 'documents.capabilities'].includes(body.method)) return { ok: true, result: success({ available_tools: [] }) };
    if (body.method === 'conversation.inspect') return { ok: true, result: success({ ghost_id: scope.ghost_id, conversation_id: scope.conversation_id,
      turns: [{ id: scope.turn_id, kind: 'user' }, ...replies], has_older: false }) };
    if (body.method === 'conversation.turn.inspect') {
      const value = inspection(state); if (run) value.data.run = run;
      return { ok: true, result: value };
    }
    if (body.method === 'conversation.turn_status') {
      state.run_state = body.status;
      run = { turn_id: body.turn_id, ghost_id: scope.ghost_id, conversation_id: scope.conversation_id, state: body.status, cancel_requested: false,
        submission_id: body.submission_id, entry_id: body.entry_id, reason_code: body.reason_code };
      if (body.status === 'running') { markRunning(); await runningAck; }
      return { ok: true, result: success({ run }) };
    }
    if (body.method === 'goal.create') {
      state.calls.push(request);
      if (!state.receipts.has(request.envelope.command_id)) {
        state.effects++; state.admitted = true;
        state.receipts.set(request.envelope.command_id, receipt(request.envelope.command_id));
      }
      if (!state.dropped) { state.dropped = true; throw new Error('Controlled committed admission with lost ACK'); }
      return { ok: true, result: state.receipts.get(request.envelope.command_id) };
    }
    if (body.method === 'conversation.reply') {
      replies.push({ kind: 'assistant_advisory', source_turn_id: body.turn_id, text: body.text });
      return { ok: true, result: success({ turn_id: body.turn_id }) };
    }
    throw new Error(`Unexpected bootstrap callback ${body.method}`);
  } });
  const provider = createBrokerModelProvider({ modelRef: 'minimax-code/MiniMax-M2.7', invoke: async request => {
    assert.equal(state.run_state, 'running', 'the Host running receipt must precede selected-task model admission');
    requests.push(request);
    return { id: request.id, status: 200, body: { id: request.id, object: 'chat.completion', model: 'minimax-code/MiniMax-M2.7', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'The selected responsibility is queued; independent verification remains pending.' }, finish_reason: 'stop' }] } };
  } });
  const bindProvider = provider.forConversation.bind(provider);
  provider.forConversation = (...args) => {
    const bound = bindProvider(...args);
    bound.selectRegistered = async () => {
      routeSelections++;
      return routeDrift ? { scope: 'public', target: { provider: 'controlled-route-drift', modelId: 'changed-model' } } : null;
    };
    return bound;
  };
  const body = { method: 'conversation.input', ghost_id: scope.ghost_id, conversation_id: scope.conversation_id, turn_id: scope.turn_id, prompt: 'Perform my selected task.', privacy: 'public', attachments: [] };
  const envelope = { protocol_version: 'ghost-lifetime/1', command_id: body.turn_id, payload_digest: payloadDigest(body), actor_ref: scope.ghost_id, authority_epoch: 1, expected_revision: null, correlation_id: body.turn_id, body };
  const key = value => createHash('sha256').update(value).digest('hex');
  const databasePath = join(root, key(scope.ghost_id), key(scope.conversation_id), 'durable.sqlite');
  const originalTask = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try { return db.prepare('SELECT record FROM tasks WHERE kind=?').get(JSON.stringify('ghost.selected-task-admission')).record; }
    finally { db.close(); }
  };
  const unknownStatus = async () => {
    const db = await openGhostIndex(root, scope.ghost_id);
    try { return await db.get("SELECT payload_json,receipt_json,delivery_state FROM ghost_turn_status_observations WHERE turn_id=? AND kind='v2' AND status='effect_unknown' AND json_extract(payload_json,'$.submission_id') IS NULL ORDER BY sequence LIMIT 1", scope.turn_id); }
    finally { await db.close(); }
  };
  const recoveryTaskCount = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try { return db.prepare('SELECT count(*) AS total FROM tasks WHERE kind=?').get(JSON.stringify('ghost.selected-task-admission-recovery')).total; }
    finally { db.close(); }
  };
  const recoveryTask = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try { return db.prepare('SELECT record FROM tasks WHERE kind=?').get(JSON.stringify('ghost.selected-task-admission-recovery')).record; }
    finally { db.close(); }
  };
  const localReply = async () => {
    const db = await openGhostIndex(root, scope.ghost_id);
    try { return await db.get('SELECT state,reply_state,assistant_entry_id,reply_receipt_json FROM ghost_canonical_turns WHERE turn_id=?', scope.turn_id); }
    finally { await db.close(); }
  };
  try {
    runtime = await openGhostRuntime({ root, mode: 'broker', modelProvider: provider, hostToolTransport: host, onDiagnostic: value => diagnostics.push(value) });
    assert.equal((await runtime.handle(envelope)).status, 'success');
    await runtime.waitForIdle(scope.ghost_id, scope.conversation_id);
    assert.equal(state.run_state, 'effect_unknown'); assert.equal(state.calls.length, 1); assert.equal(state.effects, 1); assert.equal(requests.length, 0);
    const original = originalTask(), status = await unknownStatus();
    assert.equal(JSON.parse(original).state.outcome.result.state, 'unknown'); assert.ok(status);
    await runtime.close();
    runtime = await openGhostRuntime({ root, mode: 'broker', modelProvider: provider, hostToolTransport: host, onDiagnostic: value => diagnostics.push(value) });
    await runtime.handle(envelope); await runtime.waitForIdle(scope.ghost_id, scope.conversation_id);
    assert.equal(state.calls.length, 1); assert.equal(requests.length, 0, 'reopen/idle cannot implicitly retry a selected task admission');
    routeDrift = true;
    const selectionsBeforeInvalidRecovery = routeSelections;
    const ordinaryBody = { method: 'runtime.reconcile', ghost_id: scope.ghost_id, conversation_id: scope.conversation_id };
    const automatic = { ...envelope, command_id: 'host-observe-startup', actor_ref: 'host-recovery', correlation_id: 'host-observe-startup', payload_digest: payloadDigest(ordinaryBody), body: ordinaryBody };
    const automaticResult = await runtime.handle(automatic); await runtime.waitForIdle(scope.ghost_id, scope.conversation_id);
    assert.equal(automaticResult.status, 'success'); assert.deepEqual(automaticResult.data.selected_task_recoveries, []);
    const operationId = JSON.parse(original).input.intent.operation_id;
    for (const [name, target, malformed] of [
      ['wrong-operation', { turn_id: scope.turn_id, operation_id: `selected-task:${'0'.repeat(64)}` }, false],
      ['foreign-turn', { turn_id: 'foreign-owner-turn', operation_id: operationId }, false],
      ['extra-authority', { turn_id: scope.turn_id, operation_id: operationId, task_contract_ref: task.task_contract_ref }, true],
      ['malformed-operation', { turn_id: scope.turn_id, operation_id: 'not-an-operation' }, true],
      ['null-target', null, true],
    ]) {
      const invalidBody = { ...ordinaryBody, selected_task_recovery: target };
      const result = await runtime.handle({ ...envelope, command_id: name, correlation_id: name, payload_digest: payloadDigest(invalidBody), body: invalidBody });
      if (malformed) { assert.equal(result.status, 'error', name); assert.equal(result.error_code, 'invalid_envelope', name); }
      else { assert.equal(result.status, 'success', name); assert.equal(result.data.selected_task_recoveries[0].state, 'blocked', name); }
    }
    await runtime.waitForIdle(scope.ghost_id, scope.conversation_id);
    assert.equal(state.calls.length, 1); assert.equal(requests.length, 0, 'automatic and invalid targeted reconciliation cannot dispatch admission or model work');
    assert.equal(recoveryTaskCount(), 0, 'automatic and invalid targeted reconciliation cannot create recovery execution evidence');
    assert.equal(originalTask(), original); assert.deepEqual(await unknownStatus(), status); assert.equal(state.run_state, 'effect_unknown');
    assert.equal(routeSelections, selectionsBeforeInvalidRecovery, 'blocked startup and invalid targets cannot select a changed route or quiesce the original SDK task');
    routeDrift = false;
    const recoveryBody = { ...ordinaryBody, selected_task_recovery: { turn_id: scope.turn_id, operation_id: operationId } };
    const originalHostRun = run;
    for (const field of ['submission_id', 'entry_id']) {
      run = { ...originalHostRun, [field]: 41 };
      const frame = { ...envelope, command_id: `host-progressed-${field}`, correlation_id: `host-progressed-${field}`, payload_digest: payloadDigest(recoveryBody), body: recoveryBody };
      const blocked = await runtime.handle(frame);
      assert.equal(blocked.status, 'success'); assert.equal(blocked.data.selected_task_recoveries[0].state, 'blocked');
      assert.equal(recoveryTaskCount(), 0, 'fresh Host SDK progress cannot create recovery execution evidence');
      assert.equal(state.calls.length, 1); assert.equal(requests.length, 0); assert.equal(originalTask(), original);
    }
    run = originalHostRun;
    const recovery = { ...envelope, actor_ref: 'host-recovery', command_id: 'explicit-runtime-recovery', correlation_id: 'explicit-runtime-recovery', payload_digest: payloadDigest(recoveryBody), body: recoveryBody };
    const beforeInterruptedContinuation = await localReply();
    const faultIndex = await openGhostIndex(root, scope.ghost_id);
    try {
      await faultIndex.exec(`CREATE TRIGGER controlled_recovery_continuation_fault BEFORE UPDATE OF status ON ghost_canonical_turn_runs
        WHEN OLD.turn_id='selected-owner' AND OLD.status='effect_unknown' AND NEW.status='queued'
        BEGIN SELECT RAISE(FAIL, 'Controlled interruption after SDK recovery commit before local continuation'); END`);
    } finally { await faultIndex.close(); }
    const interrupted = await boundedWait(runtime.handle(recovery));
    assert.equal(interrupted.status, 'error'); assert.equal(interrupted.error_code, 'runtime_unavailable');
    assert.equal(recoveryTaskCount(), 1, 'the genuine recovery SDK task committed before the local continuation storage fault');
    const linkedRecovery = recoveryTask();
    assert.equal(JSON.parse(linkedRecovery).state.outcome.result.state, 'admitted');
    assert.equal(state.calls.length, 2); assert.equal(state.effects, 1); assert.equal(requests.length, 0);
    assert.deepEqual(await localReply(), beforeInterruptedContinuation, 'the failed local transaction cannot project a queued continuation');
    await runtime.close();
    const recoveredIndex = await openGhostIndex(root, scope.ghost_id);
    try {
      assert.equal((await recoveredIndex.get('SELECT response_json FROM ghost_command_receipts WHERE command_id=?', recovery.command_id)).response_json, null,
        'the receiver response was not cached before interruption');
      await recoveredIndex.exec('DROP TRIGGER controlled_recovery_continuation_fault');
    }
    finally { await recoveredIndex.close(); }
    runtime = await openGhostRuntime({ root, mode: 'broker', modelProvider: provider, hostToolTransport: host, onDiagnostic: value => diagnostics.push(value) });
    state.selected = false;
    const historical = await boundedWait(runtime.handle(recovery));
    assert.equal(historical.status, 'success');
    assert.deepEqual(historical.data.selected_task_recoveries[0], { turn_id: scope.turn_id, ...JSON.parse(linkedRecovery).state.outcome.result },
      'immutable linked evidence stays readable without current continuation authority');
    assert.equal(historical.data.ghost_id, scope.ghost_id); assert.equal(historical.data.conversation_id, scope.conversation_id);
    assert.equal(historical.data.runtime_kind, 'pi-durable'); assert.equal(historical.data.runtime_release, '1.1.0');
    assert.equal(typeof historical.data.storage_ref, 'string');
    const blockedSession = [...runtime.sessions.values()].find(session => session.ghostId === scope.ghost_id && session.conversationId === scope.conversation_id);
    assert.equal(blockedSession.canonicalScheduler, null, 'failed fresh corroboration cannot wake the canonical scheduler');
    assert.equal(blockedSession.schedulerRequested, false, 'failed fresh corroboration cannot request a later scheduler pass');
    assert.equal(blockedSession.canonicalSettlements.size, 0);
    assert.equal((await blockedSession.harness.inspect(BACKGROUND_CONTEXT)).scheduling, 'paused',
      'failed fresh corroboration cannot resume SDK scheduling');
    assert.equal(JSON.stringify(await runtime.handle(recovery)), JSON.stringify(historical));
    assert.equal(blockedSession.canonicalScheduler, null, 'cached historical receipt also requires fresh continuation authority before waking');
    assert.equal(blockedSession.schedulerRequested, false); assert.equal(blockedSession.canonicalSettlements.size, 0);
    assert.equal(state.calls.length, 2); assert.equal(requests.length, 0); assert.equal(state.run_state, 'effect_unknown');
    assert.deepEqual(await localReply(), beforeInterruptedContinuation, 'missing fresh authority cannot requeue from historical admission evidence');
    state.selected = true;
    const recovered = await boundedWait(runtime.handle(recovery));
    assert.equal(recovered.status, 'success');
    assert.equal(recovered.data.selected_task_recoveries[0].state, 'admitted');
    assert.equal(JSON.stringify(recovered), JSON.stringify(historical), 'fresh continuation corroboration does not rewrite the historical receiver receipt');
    assert.equal(state.calls.length, 2, 'replay observes the committed recovery outcome and corroborates the same continuation without another Goal callback');
    await boundedWait(runningSeen);
    assert.equal(requests.length, 0, 'a visible running state without its acknowledged receipt cannot admit inference');
    const pending = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.equal(pending.prepare('SELECT count(*) AS total FROM submissions').get().total, 1, 'the exact Owner SDK submission is committed before the withheld status ACK'); }
    finally { pending.close(); }
    releaseRunning();
    await boundedWait(runtime.waitForIdle(scope.ghost_id, scope.conversation_id));
    assert.equal(state.calls.length, 2); assert.equal(state.effects, 1); assert.deepEqual(state.calls[0], state.calls[1]);
    assert.equal(requests.length, 1); assert.equal(state.run_state, 'answered');
    assert.equal(callbacks.filter(item => item.envelope.body.method === 'conversation.reply').length, 1,
      JSON.stringify({ diagnostics, local: await localReply(), callback_methods: callbacks.map(item => item.envelope.body.method) }));
    assert.equal(originalTask(), original, 'the original unknown SDK task receipt is never relabelled');
    assert.equal(recoveryTask(), linkedRecovery, 'continuation and receiver caching do not rewrite linked recovery outcome evidence');
    assert.deepEqual(await unknownStatus(), status, 'the historical Host/local unknown status receipt stays immutable');
    assert.notEqual(run.submission_id, null); assert.notEqual(run.entry_id, null);
    const beforeEvidenceInspection = callbacks.length;
    const inspectionBody = { method: 'conversation.inspect', ghost_id: scope.ghost_id, conversation_id: scope.conversation_id,
      selected_task_inspection: { turn_id: scope.turn_id } };
    const terminalEvidence = await runtime.handle({ ...envelope, command_id: 'inspect-terminal-evidence', correlation_id: 'inspect-terminal-evidence',
      payload_digest: payloadDigest(inspectionBody), body: inspectionBody });
    assert.equal(terminalEvidence.status, 'success'); assert.equal(terminalEvidence.data.selected_task_inspection.outcome.state, 'unknown');
    assert.equal(terminalEvidence.data.selected_task_inspection.recoveries[0].outcome.state, 'admitted');
    assert.equal(callbacks.length, beforeEvidenceInspection, 'terminal evidence inspection performs no Host calls or fresh authority check');
    const header = JSON.stringify(requests[0].body.messages);
    assert.ok(header.includes('The existing Pi runtime has verified'));
    assert.ok(header.includes(task.task_contract_ref));
    assert.equal(header.includes('For a new responsibility use goal_create once'), false, 'this admitted responsibility must not be routed back to another Goal');
    assert.equal(JSON.stringify(await runtime.handle(recovery)), JSON.stringify(recovered), 'same-ID replay retains the exact explicit receiver response after Owner continuation');
    await runtime.waitForIdle(scope.ghost_id, scope.conversation_id);
    await runtime.close();
    runtime = await openGhostRuntime({ root, mode: 'broker', modelProvider: provider, hostToolTransport: host, onDiagnostic: value => diagnostics.push(value) });
    assert.equal(JSON.stringify(await runtime.handle(recovery)), JSON.stringify(recovered), 'reopen retains the exact explicit receiver response after a lost receiver ACK');
    await runtime.waitForIdle(scope.ghost_id, scope.conversation_id);
    assert.equal(state.calls.length, 2); assert.equal(requests.length, 1);
  } finally { releaseRunning(); await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("selected tasks whose admission is unavailable at final projection retain the SDK answer without an advisory", async () => {
  for (const variant of ["not_admitted", "unavailable", "foreign", "admitted", "unconfigured"]) {
    const root = await mkdtemp(join(tmpdir(), "ghost-task-reply-"));
    const turnId = `reply-${variant}`, calls = [], requests = [], runs = new Map();
    const task = { task_contract_ref: taskRef, mode: "direct", input_digest: "c".repeat(64) };
    let runtime, modelAnswered = false;
    const host = async input => {
      calls.push(input);
      if (input.method === "inference.inspect") return { status: "success", data: { inference_scope: "public" } };
      if (["memory.capabilities", "documents.capabilities"].includes(input.method)) return { status: "success", data: { available_tools: [] } };
      if (input.method === "conversation.turn.inspect") {
        const run = runs.get(input.turn_id) ?? { turn_id: input.turn_id, ghost_id: "ghost", conversation_id: "conversation", state: "queued", cancel_requested: false, submission_id: null, entry_id: null, reason_code: null };
        const admission = { kind: "owner-task-admission/1", turn_id: input.turn_id, ghost_id: "ghost", conversation_id: "conversation", task_contract_ref: variant === "foreign" && modelAnswered ? `ot-${"d".repeat(64)}` : taskRef, input_digest: task.input_digest,
          state: !modelAnswered || ["admitted", "foreign"].includes(variant) ? "admitted" : variant, goal_id: "queued-goal", goal_revision: 1, work_id: "queued-work", work_state: "queued" };
        return { status: "success", data: { run, task_contract: variant === "unconfigured" ? null : task, task_admission: variant === "unconfigured" ? null : admission } };
      }
      if (input.method === "conversation.turn_status") {
        const run = { turn_id: input.turn_id, ghost_id: "ghost", conversation_id: "conversation", state: input.arguments.status, cancel_requested: false, submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code };
        runs.set(input.turn_id, run);
        return { status: "success", data: { run } };
      }
      if (input.method === "conversation.reply") return { status: "success", data: { turn_id: input.turn_id } };
      throw new Error(`Unexpected reply-boundary callback ${input.method}`);
    };
    const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
      requests.push(request); modelAnswered = true;
      return { id: request.id, status: 200, body: { id: `reply-${requests.length}`, object: "chat.completion", model: "minimax-code/MiniMax-M2.7", created: 1,
        choices: [{ index: 0, message: { role: "assistant", content: "Retained controlled SDK answer." }, finish_reason: "stop" }] } };
    } });
    const body = { method: "conversation.input", ghost_id: "ghost", conversation_id: "conversation", turn_id: turnId, prompt: "Perform my selected task.", privacy: "public", attachments: [] };
    const envelope = { protocol_version: "ghost-lifetime/1", command_id: turnId, payload_digest: payloadDigest(body), actor_ref: "ghost", authority_epoch: 1, expected_revision: null, correlation_id: turnId, body };
    try {
      runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host });
      assert.equal((await runtime.handle(envelope)).status, "success");
      await runtime.waitForIdle("ghost", "conversation");
      const allowed = ["admitted", "unconfigured"].includes(variant);
      assert.equal(runs.get(turnId).state, allowed ? "answered" : "failed", variant);
      assert.equal(runs.get(turnId).reason_code, allowed ? null : "answer_unprojectable", variant);
      assert.equal(calls.filter(call => call.method === "conversation.reply").length, allowed ? 1 : 0, variant);
      assert.equal(calls.filter(call => call.method === "goal.create").length, 0, "reply enforcement cannot admit another Goal");
      assert.equal(requests.length, 1, "reply enforcement cannot retry inference");
      const index = await openGhostIndex(root, "ghost");
      let original;
      try { original = await index.get("SELECT status,submission_id,entry_id,reason_code FROM ghost_canonical_turn_runs WHERE turn_id=?", turnId); }
      finally { await index.close(); }
      assert.ok(original.submission_id && original.entry_id, "failed projection retains exact SDK identities");
      const inspected = await runtime.handle({ ...envelope, command_id: `inspect-${variant}`, correlation_id: `inspect-${variant}`, payload_digest: payloadDigest({ method: "conversation.inspect", ghost_id: "ghost", conversation_id: "conversation" }), body: { method: "conversation.inspect", ghost_id: "ghost", conversation_id: "conversation" } });
      const assistant = inspected.data.committed_view.entries.find(entry => entry.kind === "pi.assistant");
      assert.ok(JSON.stringify(assistant).includes("Retained controlled SDK answer."));
      await runtime.close();
      runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host });
      await runtime.handle(envelope);
      await runtime.waitForIdle("ghost", "conversation");
      assert.equal(requests.length, 1, "reopen/replay preserves the original SDK submission");
      const reopened = await openGhostIndex(root, "ghost");
      try { assert.deepEqual(await reopened.get("SELECT status,submission_id,entry_id,reason_code FROM ghost_canonical_turn_runs WHERE turn_id=?", turnId), original); }
      finally { await reopened.close(); }
    } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
  }
});


test("Owner task context accepts only a fresh descriptor for the exact current turn and identity", async () => {
  const staleRef=`ot-${"d".repeat(64)}`;
  const descriptor={task_contract_ref:staleRef,mode:"direct",input_digest:"e".repeat(64),verifier:"must-not-enter-model-context",input:{private_data:"must-not-enter-model-context"}};
  for (const route of ["public","local","codex","zai-coding","minimax"]) for (const variant of ["absent","failed-inspection","thrown-inspection","foreign-turn","foreign-ghost","foreign-conversation","cancelled","completed","malformed-ref","malformed-digest","malformed-mode","changed-ref","changed-digest","changed-mode","replaced-turn","fresh"]) {
    const registered=["codex","zai-coding","minimax"].includes(route);
    const root=await mkdtemp(join(tmpdir(),"ghost-owner-task-context-"));let runtime, runningAcknowledged=false, generationInspections=0;const requests=[],inspectTurns=[];
    const host=async input=>{
      if(input.method==="inference.inspect") return {status:"success",data:{inference_scope:registered?"selected":route}};
      if(input.method==="inference.settings") return {status:"success",data:{selection:{provider:route,model:route==="codex"?"gpt-6-luna":route==="zai-coding"?"glm-5.3":"MiniMax-M3.1-Flash-Preview",effort:"high"},credentials_present:true,external_allowed:true}};
      if(["memory.capabilities","documents.capabilities"].includes(input.method)) return {status:"success",data:{available_tools:[]}};
      if(input.method==="conversation.turn.inspect") {
        inspectTurns.push(input.turn_id);
        if(runningAcknowledged) generationInspections++;
        const run={turn_id:input.turn_id,ghost_id:"ghost",conversation_id:"conversation",state:"running",cancel_requested:false,cancel_command_id:null,submission_id:null,entry_id:null,reason_code:null,latest_status_command_id:null,created_at_ms:1,updated_at_ms:1};
        let task={...descriptor};
        // Host preflight must remain valid. Only the fresh beforeRequest
        // observation is varied; a historical/foreign row cannot become context.
        if(inspectTurns.length>=2) {
          if(variant==="thrown-inspection") throw new Error("Synthetic unavailable inspection");
          if(variant==="failed-inspection") return {status:"error",error_code:"fixture_inspection_unconfirmed",data:{}};
          if(variant==="foreign-turn") run.turn_id="historical-turn";
          if(variant==="foreign-ghost") run.ghost_id="other";
          if(variant==="foreign-conversation") run.conversation_id="other";
          if(variant==="cancelled") run.cancel_requested=true;
          if(variant==="completed") run.state="completed";
          if(variant==="malformed-ref") task.task_contract_ref=123;
          if(variant==="malformed-digest") task.input_digest="bad";
          if(variant==="malformed-mode") task.mode="owner";
        }
        if(runningAcknowledged && generationInspections>=2) {
          if(variant==="changed-ref") task.task_contract_ref=`ot-${"f".repeat(64)}`;
          if(variant==="changed-digest") task.input_digest="f".repeat(64);
          if(variant==="changed-mode") task.mode="delegate";
          if(variant==="replaced-turn") run.turn_id="replacement-turn";
        }
        return {status:"success",data:{run,...(variant==="absent" || input.turn_id==="later-unconfigured"?{task_contract:null,task_admission:null}:{task_contract:task,task_admission:{kind:"owner-task-admission/1",turn_id:input.turn_id,ghost_id:run.ghost_id,conversation_id:run.conversation_id,task_contract_ref:task.task_contract_ref,input_digest:task.input_digest,state:"admitted",goal_id:"existing-goal",goal_revision:1,work_id:"existing-work",work_state:"queued"}})}};
      }
      if(input.method==="conversation.turn_status") {if(input.arguments.status==="running") {runningAcknowledged=true;generationInspections=0;} return {status:"success",data:{run:{turn_id:input.turn_id,ghost_id:"ghost",conversation_id:"conversation",state:input.arguments.status,cancel_requested:false,cancel_command_id:null,submission_id:input.arguments.submission_id,entry_id:input.arguments.entry_id,reason_code:input.arguments.reason_code,latest_status_command_id:input.invocation_id,created_at_ms:1,updated_at_ms:2}}};}
      if(input.method==="conversation.reply") return {status:"success",data:{turn_id:input.turn_id}};
      throw new Error(`Unexpected callback ${input.method}`);
    };
    if(registered && route!=="codex") {
      await mkdir(join(root,"inference-credentials"));
      await writeFile(join(root,"inference-credentials",`${route}.json`),JSON.stringify({api_key:"synthetic-owner-context-key"}),{mode:0o600});
    }
    const completion=model=>({id:`context-${variant}`,object:"chat.completion",model,created:1,choices:[{index:0,message:{role:"assistant",content:"A bounded advisory response."},finish_reason:"stop"}]});
    const local=createLocalModelProvider({baseUrl:"http://127.0.0.1:8768/v1",modelId:"fixture/synthetic-local",fetchImpl:async(_url,init)=>{
      requests.push({body:JSON.parse(init.body)});
      return new Response(JSON.stringify(completion("fixture/synthetic-local")),{status:200,headers:{"content-type":"application/json"}});
    }});
    const provider=registered?createRegisteredModelProvider({hostRoot:root,executable:"/usr/bin/false",complete:async request=>{requests.push(request);return completion(request.body.model);},fetchImpl:async(_url,options)=>{
      requests.push({body:JSON.parse(options.body)});
      const item={type:"message",id:"owner-context-message",role:"assistant",status:"completed",content:[{type:"output_text",text:"A bounded advisory response.",annotations:[]}]};
      const events=[{type:"response.created",response:{id:"owner-context-response"}},{type:"response.output_item.added",output_index:0,item},{type:"response.output_item.done",output_index:0,item},{type:"response.completed",response:{id:"owner-context-response",status:"completed",output:[item],usage:{input_tokens:4,output_tokens:3,total_tokens:7}}}];
      return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
    }}):createBrokerModelProvider({modelRef:"minimax-code/MiniMax-M2.7",localModelProvider:local,invoke:async request=>{
      requests.push(request);return {id:request.id,status:200,body:completion("minimax-code/MiniMax-M2.7")};
    }});
    try {
      runtime=await openGhostRuntime({root,mode:"broker",modelProvider:provider,hostToolTransport:host});
      const body={method:"conversation.input",ghost_id:"ghost",conversation_id:"conversation",turn_id:`current-${route}-${variant}`,prompt:"Compare the newly selected input.",privacy:route==="local"?"private":"public",attachments:[]};
      const envelope={protocol_version:"ghost-lifetime/1",command_id:body.turn_id,payload_digest:payloadDigest(body),actor_ref:"ghost",authority_epoch:1,expected_revision:null,correlation_id:body.turn_id,body};
      assert.equal((await runtime.handle(envelope)).status,"success");await runtime.waitForIdle("ghost","conversation");
      const allowed=["absent","fresh"].includes(variant);
      assert.equal(requests.length,allowed?1:0,variant);assert.ok(inspectTurns.length>=2,variant);
      if(!allowed) {assert.equal(requests.length,0,`${route}/${variant}: no model transport or fallback was admitted`);continue;}
      const system=JSON.stringify(requests[0].body);
      assert.equal(system.includes(staleRef),variant==="fresh",variant);
      assert.equal(system.includes("must-not-enter-model-context"),false,variant);
      assert.ok(inspectTurns.every(turn=>turn===body.turn_id),variant);
      if(variant==="fresh") {
        const later={...body,turn_id:"later-unconfigured",prompt:"Hello, how are you?"};
        assert.equal((await runtime.handle({...envelope,command_id:later.turn_id,correlation_id:later.turn_id,payload_digest:payloadDigest(later),body:later})).status,"success");
        await runtime.waitForIdle("ghost","conversation");assert.equal(requests.length,2);
        const laterSystem=JSON.stringify(requests[1].body);
        assert.equal(laterSystem.includes(staleRef),false,"selected descriptor did not persist into a later Owner turn");
        assert.ok(laterSystem.includes("No current Owner-selected task descriptor is available."));
      }
    } finally {await runtime?.close();await rm(root,{recursive:true,force:true});}
  }
});


test("automatic Goal scheduling omits redundant model admission while explicit compatibility recovery and unknown callbacks remain scoped",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ghost-work-id-recovery-"));let runtime;const requests=[],admissions=[];let run;
  const receipt=(data={},error=null)=>({status:error?"error":"success",summary:error?"Unknown Work ID; no admission occurred":"Controlled Host receipt",object_refs:[],artifacts:[],next_actions:[],error_code:error,retry_class:error?"never":"same_id",data});
  const host=createHostToolTransport({hostRoot:root,callbackToken:"synthetic-callback",authorityEpoch:1,dispatch:async request=>{
    const body=request.envelope.body,method=body.method;
    if(method==="inference.inspect")return {ok:true,result:receipt({inference_scope:"public"})};
    if(["memory.capabilities","documents.capabilities"].includes(method))return {ok:true,result:receipt({available_tools:[]})};
    if(method==="conversation.turn.inspect")return {ok:true,result:receipt({run:run??{turn_id:body.turn_id,ghost_id:"ghost",conversation_id:"conversation",state:"queued",cancel_requested:false,cancel_command_id:null,submission_id:null,entry_id:null,reason_code:null,latest_status_command_id:null,created_at_ms:1,updated_at_ms:1}})};
    if(method==="conversation.turn_status") {run={turn_id:body.turn_id,ghost_id:"ghost",conversation_id:"conversation",state:body.status,cancel_requested:false,cancel_command_id:null,submission_id:body.submission_id,entry_id:body.entry_id,reason_code:body.reason_code,latest_status_command_id:request.envelope.command_id,created_at_ms:1,updated_at_ms:2};return {ok:true,result:receipt({run})};}
    if(method==="goal.create")return {ok:true,result:receipt({goal:{id:"actual-goal",revision:1},work:{id:"actual-work",goal_id:"actual-goal",state:"queued"},automatic_admission:{engine:"pi",work_id:"actual-work",assignment_id:"actual-assignment",source_command_id:request.envelope.command_id,delivery_state:"queued",work_state:"queued",next_action:"observe"}})};
    if(method==="work.pi.admit") {admissions.push(body.work_id);return {ok:true,result:body.work_id==="actual-work"?receipt({work:{id:"actual-work",state:"queued"}}):receipt({host_effect_class:"no_effect"},"not_found")};}
    if(method==="work.cancel")return {ok:false,error:"Synthetic unverified mutation outcome; must not be no_effect"};
    if(method==="conversation.reply")return {ok:true,result:receipt({turn_id:body.turn_id})};
    throw Error(`Unexpected controlled Host method ${method}`);
  }});
  const steps=[["goal_create",{prompt:"A controlled public task",acceptance_spec:{required_checks:["independent_review"]}}],["work_submit",{work_id:"actual-work"}],["work_cancel",{work_id:"actual-work"}]];
  const provider=createBrokerModelProvider({modelRef:"minimax-code/MiniMax-M2.7",invoke:async request=>{
    requests.push(request);const step=steps[requests.length-1];
    const message=step?{role:"assistant",content:null,tool_calls:[{id:`recovery-${requests.length}`,type:"function",function:{name:step[0],arguments:JSON.stringify(step[1])}}]}:{role:"assistant",content:"The admission used the original Work. Cancellation has an unconfirmed outcome; inspect its original receipt."};
    return {id:request.id,status:200,body:{id:`recovery-response-${requests.length}`,object:"chat.completion",model:"minimax-code/MiniMax-M2.7",created:1,choices:[{index:0,message,finish_reason:step?"tool_calls":"stop"}]}};
  }});
  try {
    runtime=await openGhostRuntime({root,mode:"broker",modelProvider:provider,hostToolTransport:host});
    const body={method:"conversation.input",ghost_id:"ghost",conversation_id:"conversation",turn_id:"work-id-owner",prompt:"Perform this controlled public task.",privacy:"public",attachments:[]};
    assert.equal((await runtime.handle({protocol_version:"ghost-lifetime/1",command_id:body.turn_id,payload_digest:payloadDigest(body),actor_ref:"ghost",authority_epoch:1,expected_revision:null,correlation_id:body.turn_id,body})).status,"success");
    await runtime.waitForIdle("ghost","conversation");
    assert.equal(requests.length,4);
    assert.deepEqual(admissions,[],"normal model scheduling does not call compatibility admission");
    assert.ok(requests.every(request=>!request.body.tools.some(tool=>tool.function.name==="work_submit")));
    const recoveryScope={ghost_id:"ghost",conversation_id:"conversation",turn_id:"work-id-owner",inference_scope:"public",conversation_disclosure:"public",method:"work.submit"};
    const wrong=await host({...recoveryScope,invocation_id:"explicit-wrong-id-recovery",arguments:{work_id:"actual-goal"}});
    assert.equal(wrong.error_code,"not_found");assert.equal(wrong.data.host_effect_class,"no_effect");
    const corrected=await host({...recoveryScope,invocation_id:"explicit-exact-id-recovery",arguments:{work_id:"actual-work"}});
    assert.equal(corrected.status,"success");assert.equal(corrected.data.work.id,"actual-work");
    assert.deepEqual(admissions,["actual-goal","actual-work"],"explicit recovery never silently substitutes a Work for a Goal ID");
    const toolReceipts=requests.flatMap(request=>request.body.messages.filter(message=>message.role==="tool").flatMap(message=>{try{return [JSON.parse(message.content)];}catch{return [];}}));
    const created=toolReceipts.find(result=>result.data?.automatic_admission);
    assert.equal(created.data.automatic_admission.work_id,"actual-work");
    assert.equal(created.data.automatic_admission.assignment_id,"actual-assignment");
    assert.equal(created.data.automatic_admission.delivery_state,"queued");
    assert.equal(created.data.automatic_admission.next_action,"observe");
    assert.ok(toolReceipts.some(result=>result.status==="error" && result.data?.host_effect_class==="unconfirmed"));
  } finally {await runtime?.close();await rm(root,{recursive:true,force:true});}
});
