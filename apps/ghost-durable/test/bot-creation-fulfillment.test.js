import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGhostRuntime } from '../src/runtime.js';
import { createBrokerModelProvider } from '../src/models.js';
import { payloadDigest } from '../src/contract.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
const childClaim = process.argv.includes('--creation-claim-child');
const test = childClaim ? () => {} : nodeTest;

const candidate = 'candidate-exact', digest = 'a'.repeat(64), reference = `bsc-${'b'.repeat(64)}`;
const selected = { candidate_id: candidate, candidate_digest: digest };
const source = { display_name: 'Reusable labels', purpose: 'Apply the accepted procedure to fresh data', source_contract_ref: reference };
const requirements = { display_name: 'Custom labels', purpose: 'Process new labels', input_contract: { type: 'object' },
  output_contract: { type: 'string' }, instructions: 'Return the label in uppercase.', required_capabilities: ['read', 'write', 'publish_artifact'], source_work_ids: [] };
const frame = (command, body) => ({ protocol_version: 'ghost-lifetime/1', command_id: command, payload_digest: payloadDigest(body), actor_ref: 'ghost', authority_epoch: 1, expected_revision: null, correlation_id: command, body });

async function scenario(t, { mode = 'create', variant = 'complete', onReady, root: rootOverride } = {}) {
  const root = rootOverride ?? await mkdtemp(join(tmpdir(), 'ghost-creation-fulfillment-')); t.after(() => rm(root, { recursive: true, force: true }));
  const callbacks = [], requests = [], diagnostics = [], runs = new Map(); let runtime, state = 'unprepared', cancelled = false, armed = false, terminalUnavailable = false;
  const descriptor = turn => ({ kind: 'ghost-bot-creation-descriptor/1', state: 'available', mode,
    turn_id: turn, ghost_id: 'ghost', conversation_id: 'conversation', source_contracts: mode === 'requirements' ? [] : [{ source_contract_ref: reference, source_work_id: 'source-work' }],
    fulfillment: { kind: 'ghost-bot-creation-fulfillment/1', state, candidate_id: state === 'unprepared' ? null : candidate,
      candidate_digest: state === 'unprepared' ? null : digest, activation_requested: armed,
      evaluation_goal_id: state === 'evaluating' ? 'evaluation-goal' : null, evaluation_work_id: state === 'evaluating' ? 'evaluation-work' : null,
      next_action: state === 'unprepared' ? 'prepare' : state === 'draft' ? 'evaluate' : null } });
  const host = async input => {
    callbacks.push(input);
    if (input.method === 'inference.inspect') return { status: 'success', data: { inference_scope: 'public' } };
    if (['memory.capabilities', 'documents.capabilities'].includes(input.method)) return { status: 'success', data: { available_tools: [] } };
    if (input.method === 'conversation.turn.inspect') {
      if (terminalUnavailable || variant === 'inspection-lost' && state === 'draft') throw Error('Controlled inspection loss');
      return { status: 'success', data: { task_contract: null, bot_creation: variant === 'draft-only' ? null : descriptor(input.turn_id), run: {
        ...(runs.get(input.turn_id) ?? { turn_id: input.turn_id, ghost_id: 'ghost', conversation_id: 'conversation', state: 'queued', cancel_requested: false,
          cancel_command_id: null, submission_id: null, entry_id: null, reason_code: null, latest_status_command_id: null, created_at_ms: 1, updated_at_ms: 1 }),
        cancel_requested: cancelled, cancel_command_id: cancelled ? 'cancel-exact' : null } } };
    }
    if (input.method === 'conversation.turn_status') {
      const run = { turn_id: input.turn_id, ghost_id: 'ghost', conversation_id: 'conversation', state: input.arguments.status,
        cancel_requested: cancelled, cancel_command_id: cancelled ? 'cancel-exact' : null, submission_id: input.arguments.submission_id,
        entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code, latest_status_command_id: input.invocation_id, created_at_ms: 1, updated_at_ms: 2 };
      runs.set(input.turn_id, run); return { status: 'success', data: { run } };
    }
    if (input.method === 'bot.prepare') {
      assert.deepEqual(input.arguments, mode === 'requirements' ? requirements : source); state = 'draft';
      if (variant === 'lost-ack') throw Error('Host committed but its receipt was lost');
      return { status: 'success', data: { ...selected, state } };
    }
    if (input.method === 'bot.evaluate') {
      assert.deepEqual(input.arguments, selected);
      if (variant === 'denied') return { status: 'error', error_code: 'evaluation_denied', retry_class: 'never', data: { host_effect_class: 'no_effect' } };
      state = 'evaluating'; armed = true;
      return { status: 'success', data: { ...selected, state, activation_requested: true, evaluation_goal_id: 'evaluation-goal', evaluation_work_id: 'evaluation-work' } };
    }
    if (input.method === 'bot.activate') { assert.deepEqual(input.arguments, selected); return { status: 'success', data: { ...selected, state, activation_requested: true } }; }
    if (input.method === 'conversation.reply') return { status: 'success', data: { turn_id: input.turn_id } };
    throw Error(`Unexpected callback ${input.method}`);
  };
  const provider = createBrokerModelProvider({ modelRef: 'minimax-code/MiniMax-M2.7', invoke: async request => {
    requests.push(request);
    const number = requests.length;
    let action = number === 1 && variant !== 'draft-only' ? ['bot_prepare', mode === 'requirements' ? requirements : source] : null;
    if (number === 2 && variant === 'cancelled') cancelled = true;
    if (number === 3 && ['complete', 'denied', 'automatic-activation', 'terminal-inspection-lost'].includes(variant)) action = ['bot_evaluate', selected];
    if (number === 4 && ['complete', 'terminal-inspection-lost'].includes(variant)) action = ['bot_activate', selected];
    if (number === 5 && variant === 'terminal-inspection-lost') terminalUnavailable = true;
    // These deliberate premature/factually wrong answers must not define state.
    const message = action ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${number}`, type: 'function', function: { name: action[0], arguments: JSON.stringify(action[1]) } }] }
      : { role: 'assistant', content: number === 2 ? 'The draft is ready. May I evaluate it?' : state === 'evaluating' ? 'Independent evaluation is pending.' : 'The bot is fully ready.' };
    return { id: request.id, status: 200, body: { id: `completion-${number}`, object: 'chat.completion', model: 'minimax-code/MiniMax-M2.7', created: 1,
      choices: [{ index: 0, message, finish_reason: action ? 'tool_calls' : 'stop' }] } };
  } });
  runtime = await openGhostRuntime({ root, mode: 'broker', modelProvider: provider, hostToolTransport: host, onDiagnostic: item => diagnostics.push(item) });
  t.after(() => runtime?.close());
  if (onReady) {
    await runtime.handle(frame('preinspect', { method: 'conversation.inspect', ghost_id: 'ghost', conversation_id: 'conversation' }));
    await onReady(runtime, [...runtime.sessions.values()][0]);
  }
  const input = frame('create-turn', { method: 'conversation.input', ghost_id: 'ghost', conversation_id: 'conversation', turn_id: 'create-turn',
    prompt: variant === 'draft-only' ? 'Prepare only a draft; do not evaluate or activate.' : mode === 'requirements' ? 'Create a bot from these requirements.' : 'Turn this into a bot.', privacy: 'public', attachments: [] });
  assert.equal((await runtime.handle(input)).status, 'success'); await runtime.waitForIdle('ghost', 'conversation');
  const session = [...runtime.sessions.values()][0];
  const observation = (await session.controllerContext.creationFulfillment.observations('conversation'))[0];
  return { runtime, session, callbacks, requests, diagnostics, runs, observation, input, root, provider, host,
    restoreInspection: () => { terminalUnavailable = false; } };
}

test('actual SDK completes source-ref and requirements creation after one premature yield, preserving original entries and replay', async t => {
  for (const mode of ['create', 'requirements']) await t.test(mode, async t => {
    const s = await scenario(t, { mode });
    assert.deepEqual(s.callbacks.filter(item => item.method.startsWith('bot.')).map(item => item.method), ['bot.prepare', 'bot.evaluate', 'bot.activate']);
    assert.equal(s.requests.length, 5);
    assert.equal(s.runs.get('create-turn').state, 'answered');
    assert.equal(s.observation.terminal.state, 'pending'); assert.equal(s.observation.terminal.actual_state, 'evaluating');
    assert.equal(s.observation.receipts.length, 3); assert.ok(s.observation.continuation_generation > 0);
    assert.equal(s.callbacks.filter(item => item.method === 'conversation.reply').length, 1);
    assert.ok(s.callbacks.find(item => item.method === 'conversation.reply').arguments.text.includes('pending'));
    const raw = await s.session.database.all('SELECT id,record FROM entries ORDER BY id');
    assert.ok(raw.some(row => row.record.includes('The draft is ready. May I evaluate it?')), 'the original premature answer is immutable evidence');
    await s.runtime.handle(s.input); await s.runtime.waitForIdle('ghost', 'conversation'); assert.equal(s.requests.length, 5);
    await s.runtime.close();
    const reopened = await openGhostRuntime({ root: s.root, mode: 'broker', modelProvider: s.provider, hostToolTransport: s.host }); t.after(() => reopened.close());
    await reopened.handle(frame('inspect-reopen', { method: 'conversation.inspect', ghost_id: 'ghost', conversation_id: 'conversation' }));
    const after = [...reopened.sessions.values()][0];
    for (const row of raw) assert.equal((await after.database.get('SELECT record FROM entries WHERE id=?', row.id)).record, row.record);
    await reopened.handle(s.input); await reopened.waitForIdle('ghost', 'conversation'); assert.equal(s.requests.length, 5);
  });
});

test('Host-armed evaluation needs no extra activation call or polling', async t => {
  const s = await scenario(t, { variant: 'automatic-activation' });
  assert.deepEqual(s.callbacks.filter(item => item.method.startsWith('bot.')).map(item => item.method), ['bot.prepare', 'bot.evaluate']);
  assert.equal(s.requests.length, 4); assert.equal(s.observation.terminal.state, 'pending');
  assert.equal(s.runs.get('create-turn').state, 'answered');
});

test('transient terminal inspection loss reconciles the original settled submission without inference or new mutation', async t => {
  const s = await scenario(t, { variant: 'terminal-inspection-lost' });
  const before = await s.session.index.get('SELECT status,submission_id,entry_id FROM ghost_canonical_turn_runs WHERE turn_id=?', 'create-turn');
  assert.equal(before.status, 'effect_unknown'); assert.equal(s.observation.terminal.state, 'unknown');
  const raw = await s.session.database.all('SELECT id,record FROM entries ORDER BY id');
  const mutations = s.callbacks.filter(item => item.method.startsWith('bot.')).map(item => item.invocation_id);
  s.restoreInspection();
  await s.runtime.handle(frame('reconcile-original', { method: 'runtime.reconcile', ghost_id: 'ghost', conversation_id: 'conversation' }));
  await s.runtime.waitForIdle('ghost', 'conversation');
  const after = await s.session.index.get('SELECT status,submission_id,entry_id FROM ghost_canonical_turn_runs WHERE turn_id=?', 'create-turn');
  assert.equal(after.status, 'answered'); assert.equal(after.submission_id, before.submission_id); assert.equal(after.entry_id, before.entry_id);
  assert.equal(s.requests.length, 5);
  assert.deepEqual(s.callbacks.filter(item => item.method.startsWith('bot.')).map(item => item.invocation_id), mutations);
  for (const row of raw) assert.equal((await s.session.database.get('SELECT record FROM entries WHERE id=?', row.id)).record, row.record);
  assert.equal((await s.session.controllerContext.creationFulfillment.observations('conversation'))[0].terminal.state, 'pending');
});

test('ignored continuation is bounded across successor generations and cannot project a draft as fulfilled', async t => {
  const s = await scenario(t, { variant: 'ignored' });
  assert.equal(s.requests.length, 3); assert.equal(s.callbacks.filter(item => item.method === 'bot.prepare').length, 1);
  assert.equal(s.callbacks.filter(item => item.method === 'bot.evaluate').length, 0);
  assert.equal(s.runs.get('create-turn').state, 'failed'); assert.equal(s.runs.get('create-turn').reason_code, 'runtime_failure');
  assert.equal(s.observation.terminal.state, 'incomplete'); assert.equal(s.observation.terminal.actual_state, 'draft');
  assert.ok(s.diagnostics.some(item => item.code === 'bot_creation_incomplete'));
  assert.equal(s.callbacks.filter(item => item.method === 'conversation.reply').length, 0);
});

test('a queued SDK user boundary may suppress the continuation but cannot settle the original draft as answered', async t => {
  let queued = false;
  const s = await scenario(t, { variant: 'ignored', onReady: async (_runtime, session) => {
    const helper = session.controllerContext.creationFulfillment, original = helper.onYield.bind(helper);
    helper.onYield = async (...args) => {
      const continuation = await original(...args);
      if (continuation && !queued) {
        queued = true;
        await session.root.submit({ type: 'input', content: 'A separate queued SDK input.', whenBusy: 'followUp', requestId: 'queued-fixture-boundary' }, BACKGROUND_CONTEXT);
      }
      return continuation;
    };
  } });
  assert.equal(queued, true);
  const run = await s.session.index.get('SELECT status,reason_code FROM ghost_canonical_turn_runs WHERE turn_id=?', 'create-turn');
  assert.equal(run.status, 'failed'); assert.equal(run.reason_code, 'runtime_failure');
  assert.equal(s.callbacks.filter(item => ['bot.evaluate', 'bot.activate', 'conversation.reply'].includes(item.method)).length, 0);
  assert.equal(s.observation.terminal.state, 'incomplete');
  assert.equal((await s.session.database.all('SELECT id FROM entries WHERE record LIKE ?', '%Host fulfillment check for the SAME%')).length, 0,
    'the SDK selected the queued user instead of appending the proposed continuation');
});

test('lost mutation ACK and deterministic denial prohibit a new invocation or misleading final reply', async t => {
  for (const variant of ['lost-ack', 'denied', 'inspection-lost']) await t.test(variant, async t => {
    const s = await scenario(t, { variant });
    assert.equal(s.callbacks.filter(item => item.method === 'bot.prepare').length, 1);
    assert.equal(s.callbacks.filter(item => item.method === 'bot.evaluate').length, variant === 'denied' ? 1 : 0);
    assert.equal(s.requests.length, variant === 'denied' ? 4 : variant === 'inspection-lost' ? 1 : 2);
    assert.equal(s.callbacks.filter(item => item.method === 'conversation.reply').length, 0);
    const local = await s.session.index.get('SELECT status FROM ghost_canonical_turn_runs WHERE turn_id=?', 'create-turn');
    assert.equal(local.status, variant === 'denied' ? 'failed' : 'effect_unknown');
    assert.equal(s.observation.terminal.state, variant === 'denied' ? 'incomplete' : 'unknown');
    assert.equal(s.observation.receipts.at(-1).effect, variant === 'denied' ? 'denied' : variant === 'inspection-lost' ? 'success' : 'unknown');
  });
});

test('draft-only input and cancelled creation never receive a continuation', async t => {
  for (const variant of ['draft-only', 'cancelled']) await t.test(variant, async t => {
    const s = await scenario(t, { variant });
    assert.equal(s.requests.length, variant === 'draft-only' ? 1 : 2);
    assert.equal(s.callbacks.filter(item => ['bot.evaluate', 'bot.activate'].includes(item.method)).length, 0);
    assert.equal(s.observation?.continuation_generation ?? null, null);
  });
});

test('crash before the SDK yield boundary preserves one durable claimant and same-generation memo replay', { timeout: 30000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createInterface } = await import('node:readline');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'ghost-creation-claim-crash-')); t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--creation-claim-child', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stderr = '';
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-4096); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  const lines = createInterface({ input: child.stdout }); t.after(() => lines.close());
  const barrier = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Claim barrier timed out: ${stderr}`)), 15000);
    lines.on('line', line => { try { const value = JSON.parse(line); if (value.stage === 'claim_before_sdk_commit') { clearTimeout(timer); resolve(value); } } catch {} });
    child.once('exit', () => { clearTimeout(timer); reject(Error(`Claim child exited: ${stderr}`)); });
  });
  child.kill('SIGKILL'); await exited;
  const requests = [], callbacks = []; let savedRun;
  const host = async input => {
    callbacks.push(input);
    if (input.method === 'inference.inspect') return { status: 'success', data: { inference_scope: 'public' } };
    if (['memory.capabilities', 'documents.capabilities'].includes(input.method)) return { status: 'success', data: { available_tools: [] } };
    if (input.method === 'conversation.turn.inspect') return { status: 'success', data: { run: savedRun, task_contract: null,
      bot_creation: { kind: 'ghost-bot-creation-descriptor/1', state: 'available', mode: 'create', turn_id: 'create-turn', ghost_id: 'ghost', conversation_id: 'conversation',
        source_contracts: [{ source_contract_ref: reference, source_work_id: 'source-work' }], fulfillment: { kind: 'ghost-bot-creation-fulfillment/1', ...selected,
          state: 'draft', activation_requested: false, evaluation_goal_id: null, evaluation_work_id: null, next_action: 'evaluate' } } } };
    if (input.method === 'conversation.turn_status') { savedRun = { ...savedRun, state: input.arguments.status, reason_code: input.arguments.reason_code,
      entry_id: input.arguments.entry_id, latest_status_command_id: input.invocation_id }; return { status: 'success', data: { run: savedRun } }; }
    throw Error(`No mutation is permitted in this controlled cold receiver: ${input.method}`);
  };
  const provider = createBrokerModelProvider({ modelRef: 'minimax-code/MiniMax-M2.7', invoke: async request => {
    requests.push(request); return { id: request.id, status: 200, body: { id: 'cold-yield', object: 'chat.completion', model: 'minimax-code/MiniMax-M2.7', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Draft remains incomplete.' }, finish_reason: 'stop' }] } };
  } });
  const runtime = await openGhostRuntime({ root, mode: 'broker', modelProvider: provider, hostToolTransport: host }); t.after(() => runtime.close());
  await runtime.handle(frame('cold-inspect', { method: 'conversation.inspect', ghost_id: 'ghost', conversation_id: 'conversation' }));
  const session = [...runtime.sessions.values()][0];
  const run = await session.index.get('SELECT * FROM ghost_canonical_turn_runs WHERE turn_id=?', 'create-turn');
  savedRun = { ...run, state: run.status, ghost_id: 'ghost', cancel_requested: false };
  const original = await session.database.all('SELECT id,record FROM entries ORDER BY id');
  assert.equal(requests.length, 0, 'read-only open does not recover the uncertain cold Owner run');
  const claim = await session.index.get('SELECT continuation_generation,continuation_json FROM ghost_bot_creation_fulfillment WHERE turn_id=?', 'create-turn');
  assert.equal(claim.continuation_generation, barrier.generation_id);
  // Explicit test-owned same-task recovery proves the SDK hook/memo ABI only.
  // Production generic reconcile does not grant this recovery authority.
  session.inferencePolicy.scope = 'public';
  await session.harness.waitForTask(barrier.generation_id, BACKGROUND_CONTEXT);
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  assert.equal(requests.length, 2, 'one original request replay and one successor, no continuation loop');
  assert.equal(callbacks.filter(value => value.method.startsWith('bot.')).length, 0);
  const continuations = await session.database.all('SELECT record FROM entries WHERE record LIKE ?', '%Host fulfillment check for the SAME%');
  assert.equal(continuations.filter(row => JSON.parse(row.record).kind === 'pi.user').length, 1);
  assert.equal((await session.index.get('SELECT continuation_generation,continuation_json FROM ghost_bot_creation_fulfillment WHERE turn_id=?', 'create-turn')).continuation_json, claim.continuation_json);
  for (const row of original) assert.equal((await session.database.get('SELECT record FROM entries WHERE id=?', row.id)).record, row.record);
});

if (childClaim) {
  await scenario({ after() {} }, { root: process.argv.at(-1), variant: 'ignored', onReady: async (runtime, session) => {
    const helper = session.controllerContext.creationFulfillment, original = helper.onYield.bind(helper);
    helper.onYield = async (...args) => {
      const result = await original(...args);
      if (result) {
        process.stdout.write(`${JSON.stringify({ stage: 'claim_before_sdk_commit', generation_id: args[1].taskId })}\n`);
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
      return result;
    };
  } });
}
