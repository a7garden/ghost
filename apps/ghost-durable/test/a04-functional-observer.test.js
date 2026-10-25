import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createFunctionalIdleObserver, createFunctionalProviderProgress, collectOpenRuntimeProgress,
  validateFunctionalObservationMode, FUNCTIONAL_OBSERVATION_MODE, IDLE_OBSERVATION_WINDOW_MS } from '../scripts/a04-functional-observer.mjs';
import { createInferenceMeter } from '../scripts/a20-metrics.mjs';
import { openGhostRuntime } from '../src/runtime.js';
import { createLocalModelProvider } from '../src/models.js';
import { callbackCommandId } from '../src/host-transport.js';
import { payloadDigest } from '../src/contract.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const scope = { ghost_id: 'observed-ghost', conversation_id: 'observed-conversation' };
const frame = (id = 'original-probe') => ({ type: 'idle', id, ...scope });
function fakeClock() {
  let time = 1000, next = 0; const timers = new Map();
  return { now: () => time, timers,
    setTimer(callback, delay) { const id = ++next; timers.set(id, { callback, at: time + delay, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    fire() { const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; timers.delete(id); time = timer.at; timer.callback(); },
  };
}
function fixture(overrides = {}) {
  const clock = fakeClock(), events = [], wait = deferred(); let waits = 0;
  const observer = createFunctionalIdleObserver({ waitForIdle: () => { waits++; return wait.promise; }, hasOpenScope: () => true,
    progress: async () => ({ state: 'observed', diagnostic_only: true }), metrics: () => ({ model_calls: 1 }),
    emit: value => events.push(value), setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...overrides });
  observer.admitted(scope, 7);
  return { observer, clock, events, wait, waits: () => waits };
}

test('functional mode is explicit and requires admission ACKs; missing mode remains legacy', () => {
  assert.equal(validateFunctionalObservationMode({ ack_on_admission: true }), false);
  assert.equal(validateFunctionalObservationMode({}), false);
  assert.equal(validateFunctionalObservationMode({ observation_mode: FUNCTIONAL_OBSERVATION_MODE, ack_on_admission: true }), true);
  for (const input of [{ observation_mode: FUNCTIONAL_OBSERVATION_MODE }, { observation_mode: 'other', ack_on_admission: true }]) {
    assert.throws(() => validateFunctionalObservationMode(input));
  }
});

test('soft windows and status requests observe one original promise, then preserve its exact late settlement', async () => {
  const f = fixture();
  assert.equal(f.observer.start(frame()), true); await flush();
  assert.equal(f.waits(), 1);
  assert.equal([...f.clock.timers.values()][0].delay, IDLE_OBSERVATION_WINDOW_MS);
  f.clock.fire(); await flush();
  assert.equal(f.events[0].type, 'observation_checkpoint');
  assert.equal(f.events[0].reason_code, 'observer_window_elapsed');
  assert.equal(f.events[0].observation, 'unconfirmed'); assert.equal(f.events[0].wait_pending, true);
  assert.equal(f.events[0].barrier_id, 7); assert.equal(f.events[0].observation_seq, 1);
  f.observer.start(frame()); await flush();
  assert.deepEqual(f.events[1], f.events[0], 'exact retransmission returns the cached observation');
  f.observer.status(frame()); await flush();
  assert.equal(f.events.at(-1).reason_code, 'status_requested');
  f.clock.fire(); await flush();
  assert.equal(f.events.at(-1).windows_elapsed, 2);
  assert.equal(f.waits(), 1); assert.equal(f.events.some(event => event.type === 'idle_result'), false);
  f.wait.resolve(); await flush(); await flush();
  const terminal = f.events.at(-1);
  assert.equal(terminal.type, 'idle_result'); assert.equal(terminal.id, frame().id);
  assert.equal(terminal.barrier_id, 7); assert.equal(terminal.observation, 'settled');
  assert.equal(terminal.wait_pending, false); assert.equal(f.clock.timers.size, 0);
  f.observer.status(frame()); await flush(); assert.deepEqual(f.events.at(-1), terminal);
  assert.equal(f.waits(), 1);
  f.observer.close();
});

test('changed scope, accidental renewed probes and stale barriers cannot replace or settle an original wait', async () => {
  const waits = [deferred(), deferred()]; let count = 0;
  const f = fixture({ waitForIdle: () => waits[count++].promise });
  f.observer.start(frame()); await flush();
  assert.equal(f.observer.start({ ...frame(), ghost_id: 'foreign' }), false);
  assert.equal(f.observer.start(frame('replacement-probe')), false);
  assert.equal(f.events.at(-1).reason_code, 'barrier_already_observed'); assert.equal(count, 1);
  f.observer.admitted(scope, 8);
  assert.equal(f.observer.start(frame()), false);
  assert.equal(f.observer.status(frame()), false);
  assert.equal(f.events.at(-1).reason_code, 'probe_identity_conflict');
  f.observer.start(frame('new-admitted-barrier')); await flush(); assert.equal(count, 2);
  waits[0].resolve(); await flush(); await flush();
  assert.equal(f.events.at(-1).id, frame().id); assert.equal(f.events.at(-1).stale, true);
  assert.equal(f.events.some(event => event.type === 'idle_result' && event.id === 'new-admitted-barrier'), false);
  waits[1].resolve(); await flush(); await flush();
  assert.equal(f.events.at(-1).id, 'new-admitted-barrier'); assert.equal(f.events.at(-1).stale, false);
  f.observer.close();
});

test('rejected waits remain handled and a late pending checkpoint cannot overtake terminal observation', async () => {
  const firstProgress = deferred(); let inspections = 0;
  const f = fixture({ progress: () => ++inspections === 1 ? firstProgress.promise : Promise.resolve({ state: 'observed' }) });
  f.observer.start(frame()); await flush(); f.clock.fire(); await flush();
  f.wait.reject(new Error('PRIVATE_RUNTIME_ERROR_SENTINEL')); await flush();
  firstProgress.resolve({ state: 'observed' }); await flush(); await flush();
  assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'idle_result');
  assert.equal(f.events[0].observation, 'runtime_rejected'); assert.equal(f.events[0].error_code, 'a04_idle_unconfirmed');
  assert.equal(JSON.stringify(f.events).includes('PRIVATE_RUNTIME_ERROR_SENTINEL'), false);
  assert.equal(f.waits(), 1); assert.equal(f.clock.timers.size, 0);
  f.observer.close();
});

test('explicit observer cleanup clears timers without cancelling or replacing its SDK promise', async () => {
  const f = fixture(); f.observer.start(frame()); await flush();
  f.observer.close(); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.observer.start(frame()), false); assert.equal(f.observer.status(frame()), false);
  f.wait.resolve(); await flush(); await flush();
  assert.equal(f.events.length, 0); assert.equal(f.waits(), 1);
});

test('an unopened scope cannot create a wait, timer or SDK session through observation', async () => {
  const f = fixture({ hasOpenScope: () => false });
  assert.equal(f.observer.start(frame()), false); await flush();
  assert.equal(f.waits(), 0); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.events[0].reason_code, 'probe_scope_unavailable'); f.observer.close();
});

test('transport pending metadata is unattributed, preserves request/response bytes and cannot bypass meter call caps', async () => {
  let calls = 0, now = 1000; const gate = deferred(), started = deferred();
  const body = JSON.stringify({ messages: [{ content: 'PRIVATE_INPUT_SENTINEL' }] });
  const options = { body, method: 'POST', headers: { Authorization: 'PRIVATE_AUTH_SENTINEL' } };
  const response = Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [] });
  const tracker = createFunctionalProviderProgress(async (url, init) => {
    calls++; assert.equal(url, 'http://controlled'); assert.equal(init, options); started.resolve(); await gate.promise; return response;
  }, { now: () => now });
  tracker.configureTimeout(180000);
  const meter = createInferenceMeter(tracker.transportFetch, { maxCalls: 1 }), fetch = tracker.wrap(meter.fetch);
  const pending = fetch('http://controlled', options); await started.promise; now = 121000;
  const progress = tracker.snapshot(); assert.equal(progress.scope, 'process');
  assert.equal(progress.attribution, 'transport_only_unattributed'); assert.equal(progress.active.length, 1);
  assert.equal(progress.active[0].age_ms, 120000); assert.equal(progress.active[0].deadline_at_ms, 181000);
  assert.equal(JSON.stringify(progress).includes('PRIVATE_'), false);
  gate.resolve(); assert.equal(await pending, response); assert.equal(tracker.snapshot().active.length, 0);
  await assert.rejects(fetch('http://controlled', options));
  assert.equal(calls, 1); assert.equal(meter.snapshot().model_calls, 1); assert.equal(tracker.snapshot().active.length, 0);
});

test('progress projection inspects only already-open sessions and withholds task input and arbitrary checkpoint text', async () => {
  let inspected = 0;
  const session = { ghostId: scope.ghost_id, conversationId: scope.conversation_id, executionContext: null,
    root: { id: 4 }, controllerContext: { assignment: { id: 'assignment', work_id: 'work', goal_revision: 2 }, generationTaskId: async () => 9 },
    database: { get: async () => ({ id: 15 }) }, harness: { inspect: async () => { inspected++; return {
      scheduling: 'paused', tasks: [{ record: { id: 12, kind: 'pi.generation', input: { text: 'PRIVATE_TASK_INPUT' },
        startedAt: 1000, abortRequested: false, state: { status: 'running', checkpoint: { phase: 'request', attempt: 1, text: 'PRIVATE_CHECKPOINT' } } } }],
      submissions: [{ id: 10, status: 'placed', requestId: 'PRIVATE_REQUEST_ID' }] }; } } };
  const runtime = { sessions: new Map([['original', session]]) };
  const progress = await collectOpenRuntimeProgress(runtime, scope, null, { now: () => 121000 });
  assert.equal(progress.sessions[0].tasks[0].task_id, 12); assert.equal(progress.sessions[0].tasks[0].age_ms, 120000);
  assert.equal(progress.sessions[0].generation_task_id, 9); assert.equal(progress.sessions[0].scheduling, 'paused');
  assert.equal(JSON.stringify(progress).includes('PRIVATE_'), false);
  assert.equal(inspected, 1);
  const absent = await collectOpenRuntimeProgress(runtime, { ...scope, ghost_id: 'foreign' });
  assert.equal(absent.state, 'unavailable'); assert.equal(inspected, 1); assert.equal(runtime.sessions.size, 1);
});

test('Owner progress uses public SDK task records without invoking the assignment-only generation getter', async () => {
  let assignmentReads = 0;
  const session = { ghostId: scope.ghost_id, conversationId: scope.conversation_id, root: { id: 4 },
    controllerContext: { assignment: null, generationTaskId: async () => { assignmentReads++; throw new Error('Assignment document is absent'); } },
    database: { get: async () => ({ id: 10 }) }, harness: { inspect: async () => ({ scheduling: 'running', submissions: [],
      tasks: [{ record: { id: 12, kind: 'pi.generation', startedAt: 1000, abortRequested: false,
        state: { status: 'running', checkpoint: { phase: 'request', attempt: 1 } } }, state: { kind: 'running' } }] }) } };
  const runtime = { sessions: new Map([['original-owner', session]]) };
  const observed = await collectOpenRuntimeProgress(runtime, scope);
  assert.equal(observed.state, 'observed'); assert.equal(assignmentReads, 0);
  assert.equal(observed.sessions[0].assignment_id, null); assert.equal(observed.sessions[0].generation_task_id, null);
  assert.equal(observed.sessions[0].tasks[0].task_id, 12); assert.equal(observed.sessions[0].tasks[0].phase, 'request');
  session.harness.inspect = async () => { throw new Error('PRIVATE_INSPECTION_ERROR'); };
  const unavailable = await collectOpenRuntimeProgress(runtime, scope);
  assert.equal(unavailable.state, 'unavailable'); assert.equal(unavailable.reason_code, 'public_inspection_unavailable');
  assert.deepEqual(unavailable.sessions, []); assert.equal(JSON.stringify(unavailable).includes('PRIVATE_'), false);
});

test('actual held SDK request survives observation expiry with no submission or resume deltas and settles its original IDs', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-functional-idle-')), release = deferred(), requested = deferred();
  const events = [], runs = new Map(), clock = fakeClock(), completed = deferred(); let actualFetches = 0, runtime, observer;
  const tracker = createFunctionalProviderProgress(async (_url, init) => {
    actualFetches++; requested.resolve(); await release.promise;
    return Response.json({ id: 'controlled-completion', object: 'chat.completion', created: 1, model: 'fixture/functional',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Original request completed.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4 } });
  });
  const meter = createInferenceMeter(tracker.transportFetch, { maxCalls: 40 });
  const local = createLocalModelProvider({ baseUrl: 'http://127.0.0.1:19222/v1', modelId: 'fixture/functional', fetchImpl: tracker.wrap(meter.fetch) });
  tracker.configureTimeout(local.streamOptions.timeoutMs);
  const provider = { ...local, forConversation(publicGuard, _localGuard, resolveTools, onTools, diagnosticContext) {
    const models = createModels(); models.setProvider(local.forConversation(publicGuard, resolveTools, onTools, diagnosticContext));
    return { models, modelRef: local.modelRef, localModelRef: local.modelRef, localRouteConfig: local.localRouteConfig, streamOptions: local.streamOptions };
  } };
  const host = async input => {
    if (input.method === 'inference.inspect') return { status: 'success', data: { inference_scope: 'public' } };
    if (['memory.capabilities', 'documents.capabilities'].includes(input.method)) return { status: 'success', data: { available_tools: [] } };
    if (input.method === 'conversation.turn.inspect') return { status: 'success', data: { run: runs.get(input.turn_id) ?? {
      turn_id: input.turn_id, ...scope, state: 'queued', cancel_requested: false, cancel_command_id: null,
      submission_id: null, entry_id: null, reason_code: null, latest_status_command_id: null, created_at_ms: 1, updated_at_ms: 1 } } };
    if (input.method === 'conversation.turn_status') {
      const run = { turn_id: input.turn_id, ...scope, state: input.arguments.status, cancel_requested: false, cancel_command_id: null,
        submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code,
        latest_status_command_id: callbackCommandId(scope.ghost_id, scope.conversation_id, input.invocation_id, input.method), created_at_ms: 1, updated_at_ms: 2 };
      runs.set(input.turn_id, run); return { status: 'success', data: { run } };
    }
    if (input.method === 'conversation.reply') return { status: 'success', data: { turn_id: input.turn_id } };
    throw new Error(`Unexpected functional fixture method ${input.method}`);
  };
  try {
    runtime = await openGhostRuntime({ root, mode: 'broker', modelProvider: provider, hostToolTransport: host });
    const body = { method: 'conversation.input', ...scope, turn_id: 'original-owner-turn', prompt: 'PRIVATE_ORIGINAL_INPUT_SENTINEL', privacy: 'public', attachments: [] };
    const command = { protocol_version: 'ghost-lifetime/1', command_id: 'original-owner-command', payload_digest: payloadDigest(body), actor_ref: scope.ghost_id,
      authority_epoch: 1, expected_revision: null, correlation_id: 'original-owner-command', body };
    assert.equal((await runtime.handle(command)).status, 'success'); await requested.promise;
    const session = [...runtime.sessions.values()][0], resumed = deferred(), calls = {};
    const sdkInspection = await session.harness.inspect(BACKGROUND_CONTEXT);
    assert.equal(session.controllerContext.assignment, null, 'this is the real Owner session, not an assignment fixture');
    assert.equal(sdkInspection.tasks.some(item => item.record.kind === 'pi.generation'
      && item.record.state.checkpoint?.phase === 'request' && item.state.kind === 'running'), true, 'pinned public SDK inspect exposes record.state and its separate display state');
    const originalProgress = await collectOpenRuntimeProgress(runtime, scope, tracker.snapshot());
    assert.equal(originalProgress.state, 'observed', originalProgress.reason_code);
    assert.equal(originalProgress.sessions[0].tasks.some(task => task.kind === 'pi.generation' && task.phase === 'request'), true);
    for (const [owner, name] of [[session.root, 'submit'], [session.root, 'waitForIdle'], [session.root, 'abort'],
      [session.root, 'compact'], [session.root, 'reset'], [session.harness, 'resume'], [session.harness, 'waitForTask'], [session.harness, 'waitForIdle']]) {
      const actual = owner[name].bind(owner), key = `${owner === session.root ? 'root' : 'harness'}.${name}`;
      calls[key] = 0; owner[name] = (...args) => { calls[key]++; if (key === 'root.waitForIdle') resumed.resolve(); return actual(...args); };
    }
    let waits = 0;
    observer = createFunctionalIdleObserver({ waitForIdle: value => { waits++; return runtime.waitForIdle(value.ghost_id, value.conversation_id); },
      hasOpenScope: () => true, progress: value => collectOpenRuntimeProgress(runtime, value, tracker.snapshot()), metrics: () => meter.snapshot(),
      emit: event => { events.push(event); if (event.type === 'idle_result') completed.resolve(event); }, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    observer.admitted(scope, 1); observer.start(frame()); await resumed.promise;
    const submissions = await session.database.all('SELECT id,record FROM submissions ORDER BY id');
    const generations = await session.database.all("SELECT id,record FROM tasks WHERE json_extract(kind,'$')='pi.generation' ORDER BY id");
    assert.equal(submissions.length, 1); assert.equal(generations.length, 1);
    const before = { ...calls }, openSessions = runtime.sessions.size;
    const scheduling = (await session.harness.inspect(BACKGROUND_CONTEXT)).scheduling;
    clock.fire(); await flush(); await flush(); observer.status(frame()); await flush(); await flush();
    const checkpoint = events.find(event => event.type === 'observation_checkpoint'); assert.ok(checkpoint);
    assert.equal(checkpoint.wait_pending, true); assert.equal(checkpoint.progress.sessions[0].tasks.some(task => task.task_id === generations[0].id && task.phase === 'request'), true);
    assert.equal(checkpoint.progress.provider_requests.active.length, 1);
    assert.equal(JSON.stringify(events).includes('PRIVATE_ORIGINAL_INPUT_SENTINEL'), false);
    assert.deepEqual(calls, before, 'expiry/status cannot call any public SDK submission or scheduling entry point');
    assert.deepEqual(await session.database.all('SELECT id,record FROM submissions ORDER BY id'), submissions);
    assert.deepEqual(await session.database.all("SELECT id,record FROM tasks WHERE json_extract(kind,'$')='pi.generation' ORDER BY id"), generations);
    assert.equal((await session.harness.inspect(BACKGROUND_CONTEXT)).scheduling, scheduling);
    assert.equal(runtime.sessions.size, openSessions); assert.equal(waits, 1); assert.equal(actualFetches, 1);
    // Observe the real existing promise's eventual event without another SDK wait.
    release.resolve(); const terminal = await completed.promise; assert.equal(terminal.observation, 'settled');
    assert.equal(terminal.id, frame().id); assert.equal(terminal.barrier_id, 1); assert.equal(actualFetches, 1); assert.equal(waits, 1);
    assert.deepEqual((await session.database.all('SELECT id FROM submissions ORDER BY id')).map(row => row.id), submissions.map(row => row.id));
    assert.deepEqual((await session.database.all("SELECT id FROM tasks WHERE json_extract(kind,'$')='pi.generation' ORDER BY id")).map(row => row.id), generations.map(row => row.id));
    assert.equal(runs.get(body.turn_id).state, 'answered');
  } finally { observer?.close(); release.resolve(); await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
