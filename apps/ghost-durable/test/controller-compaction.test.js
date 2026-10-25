import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { createControllerCompactionPolicy } from '../src/controller-compaction.js';
import { createLocalModelProvider } from '../src/models.js';
import { openGhostRuntime } from '../src/runtime.js';
import { payloadDigest } from '../src/contract.js';

const tuned = { enabled: true, reserveTokens: 6144, keepRecentTokens: 2048, backgroundTokens: 0 };
const configured = { provider: 'ghost-local', modelId: 'fixture/controlled-local' };
const route = { identity: 'a'.repeat(64), maxOutputTokens: 1024 };
const model = { provider: 'ghost-local', id: configured.modelId, contextWindow: 16384, maxTokens: 1024 };

test('controller compaction requires confirmed actual local model metadata and preserves every isolation guard', () => {
  const policy = createControllerCompactionPolicy();
  assert.equal(policy.policy(), undefined);
  const input = { configuredModel: configured, localRouteConfig: route, models: { getModel: () => model } };
  assert.equal(policy.capture(input), true); assert.deepEqual(policy.policy(), tuned);
  assert.deepEqual(policy.policy({ assignment: { assignment_id: 'producer-work' } }), tuned,
    'plain Work assignments compact like the controller once the route is confirmed');
  assert.deepEqual(policy.policy({ executionContext: { ref: 'wc-new' }, assignment: { assignment_id: 'producer-work' } }), tuned,
    'seal-identified Work contexts compact; only memory-derived histories never do');
  for (const guard of [{ contaminated: true }, { requiresWorkGate: true },
    { executionContext: { ref: 'wc-new' }, requiresWorkGate: true },
    { executionContext: { ref: 'wc-new' }, contaminated: true }]) {
    assert.deepEqual(policy.policy(guard), { enabled: false });
  }
  for (const invalid of [
    null, {}, { ...input, configuredModel: { ...configured, provider: 'external-private' } },
    { ...input, configuredModel: { ...configured, modelId: 'foreign-model' } },
    { ...input, localRouteConfig: null }, { ...input, localRouteConfig: { ...route, identity: 'unconfirmed' } },
    { ...input, localRouteConfig: { ...route, maxOutputTokens: 4096 } },
    { ...input, models: { getModel: () => ({ ...model, contextWindow: 32768 }) } },
    { ...input, models: { getModel: () => ({ ...model, provider: 'external-private' }) } },
    { ...input, models: { getModel: () => undefined } }, { ...input, models: { getModel: () => { throw new Error('Unknown model'); } } },
  ]) {
    policy.capture(input);
    assert.equal(policy.capture(invalid), false); assert.equal(policy.policy(), undefined, 'invalid metadata clears any prior local route');
    assert.deepEqual(policy.policy({ contaminated: true }), { enabled: false });
  }
  policy.capture(input); policy.clear(); assert.equal(policy.policy(), undefined);
});

test('request bound trims only oldest wire rounds on confirmed local routes and never guarded ones', () => {
  const policy = createControllerCompactionPolicy();
  const input = { configuredModel: configured, localRouteConfig: route, models: { getModel: () => model } };
  assert.equal(policy.capture(input), true);
  const giant = 'g'.repeat(200_000);
  const rounds = index => [
    { role: 'assistant', content: [{ type: 'text', text: `round ${index}` }], timestamp: index },
    { role: 'toolResult', content: 'r'.repeat(6_000), timestamp: index + 0.5 }];
  const messages = [{ role: 'system', content: 's'.repeat(3_000), timestamp: 0 },
    ...Array.from({ length: 9 }, (_, index) => rounds(index).flat()).flat(),
    { role: 'user', content: 'current exact input value 731', timestamp: 99 }];
  const guard = { assignment: { assignment_id: 'producer-work' } };
  const bounded = policy.bound(guard, { messages, toolsAdded: [] });
  assert.notEqual(bounded.messages, messages, 'an overflowing request must be bounded');
  assert.equal(bounded.messages[0], messages[0], 'the leading system header survives');
  assert.equal(bounded.messages.at(-1), messages.at(-1), 'the exact current input survives');
  assert.notEqual(bounded.messages[1]?.role, 'toolResult', 'a bounded suffix never starts with an orphaned tool result');
  assert.equal(bounded.messages.length < messages.length, true, 'oldest rounds are dropped');
  assert.deepEqual(policy.bound({ executionContext: { ref: 'wc-new' } }, { messages }).messages.length < messages.length, true,
    'Work-context assignments are bounded like plain assignments');
  assert.deepEqual(policy.bound({ contaminated: true }, { messages }).messages, messages,
    'memory-derived scope is never bounded');
  assert.deepEqual(policy.bound({ requiresWorkGate: true }, { messages }).messages, messages,
    'work-gated scope is never bounded');
  assert.deepEqual(policy.bound(guard, { messages: [messages[0], ...rounds(0), messages.at(-1)] }).messages.length, 4,
    'a fitting request is returned unchanged');
  const unsplittable = [{ role: 'system', content: 's'.repeat(100), timestamp: 0 }, { role: 'assistant', content: [{ type: 'text', text: giant }], timestamp: 1 }];
  assert.deepEqual(policy.bound(guard, { messages: unsplittable }).messages, unsplittable,
    'a single round larger than the window fails honestly instead of being mangled');
});

const frame = (id, body) => ({ protocol_version: 'ghost-lifetime/1', command_id: id, payload_digest: payloadDigest(body),
  actor_ref: 'owner', authority_epoch: 1, expected_revision: null, correlation_id: id, body });
const text = message => typeof message.content === 'string' ? message.content
  : Array.isArray(message.content) ? message.content.map(part => part.text ?? '').join('') : '';

test('actual SDK compacts public and private local-controller histories before output clamps while preserving current input and disclosure', async () => {
  for (const privacy of ['public', 'local_only']) {
    const root = await mkdtemp(join(tmpdir(), 'ghost-controller-compaction-'));
    const calls = [], hostCalls = [], runs = new Map(); let runtime, denied = false, ordinary = 0;
    const ghost = 'controlled-ghost', conversation = `controlled-${privacy}`;
    const local = createLocalModelProvider({ baseUrl: 'http://127.0.0.1:19222/v1', modelId: 'fixture/controlled-local', maxOutputTokens: 1024,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body), summary = body.messages.some(message => text(message).includes('context summarization assistant'));
        calls.push({ body, summary }); if (!summary) ordinary++;
        const tokens = summary ? 2200 : ordinary === 1 ? 9000 : ordinary === 2 ? 14618 : 2500;
        return new Response(JSON.stringify({ id: `controlled-${calls.length}`, object: 'chat.completion', created: 1, model: 'fixture/controlled-local',
          choices: [{ index: 0, message: { role: 'assistant', content: summary ? 'Earlier authorized questions were acknowledged. Preserve the current Owner input that follows.' : 'Controlled acknowledgement.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: tokens, completion_tokens: 10, total_tokens: tokens + 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      } });
    const provider = { ...local, forConversation(publicGuard, localGuard, resolveTools, onTools) {
      const guard = privacy === 'public' ? publicGuard : localGuard;
      const models = createModels(); models.setProvider(local.forConversation(guard, resolveTools, onTools));
      return { models, modelRef: local.modelRef, localModelRef: local.modelRef, localRouteConfig: local.localRouteConfig, streamOptions: local.streamOptions };
    } };
    const host = async input => {
      hostCalls.push(input);
      if (input.method === 'inference.inspect') return denied ? { status: 'error', error_code: 'authority_revoked', retry_class: 'never' }
        : { status: 'success', data: { inference_scope: input.inference_scope } };
      if (['memory.capabilities', 'documents.capabilities'].includes(input.method)) return { status: 'success', data: { available_tools: [] } };
      if (input.method === 'conversation.turn.inspect') return { status: 'success', data: { task_contract: null, task_admission: null,
        run: runs.get(input.turn_id) ?? { turn_id: input.turn_id, ghost_id: ghost, conversation_id: conversation, state: 'queued',
          cancel_requested: false, submission_id: null, entry_id: null, reason_code: null } } };
      if (input.method === 'conversation.turn_status') {
        const run = { turn_id: input.turn_id, ghost_id: ghost, conversation_id: conversation, state: input.arguments.status,
          cancel_requested: false, submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code };
        runs.set(input.turn_id, run); return { status: 'success', data: { run } };
      }
      if (input.method === 'conversation.reply') return { status: 'success', data: { turn_id: input.turn_id } };
      throw new Error(`Unexpected controlled callback ${input.method}`);
    };
    try {
      runtime = await openGhostRuntime({ root, mode: 'broker', modelProvider: provider, hostToolTransport: host });
      const current = `CURRENT_OWNER_INPUT_${privacy}: retain this exact input and its provided value 731.`;
      for (let index = 1; index <= 3; index++) {
        const prompt = index < 3 ? `Authorized historical question ${index}: ${'bounded history. '.repeat(620)}` : current;
        const body = { method: 'conversation.input', ghost_id: ghost, conversation_id: conversation, turn_id: `turn-${index}`, prompt, privacy, attachments: [] };
        assert.equal((await runtime.handle(frame(`input-${index}`, body))).status, 'success');
        await runtime.waitForIdle(ghost, conversation);
        assert.equal(runs.get(body.turn_id).state, 'answered');
      }
      const summaryIndex = calls.findIndex(call => call.summary);
      assert.ok(summaryIndex > 0, `${privacy}: actual SDK must summarize before the third ordinary request`);
      assert.equal(calls[summaryIndex].body.tools?.length ?? 0, 0, 'summary inference offers no effect tools');
      assert.ok(calls.at(-1).body.messages.some(message => message.role === 'user' && text(message) === current), 'current Owner input remains exact after compaction');
      assert.equal(calls.at(-1).body.max_tokens, 1024, 'the current answer retains the captured output cap rather than a one-token remainder');
      const inspected = await runtime.handle(frame('inspect-compacted', { method: 'conversation.inspect', ghost_id: ghost, conversation_id: conversation }));
      assert.ok(inspected.data.committed_view.entries.some(entry => entry.kind === 'pi.compaction'));
      assert.ok(hostCalls.filter(call => call.method === 'inference.inspect').every(call => call.inference_scope === (privacy === 'public' ? 'public' : 'local')));
      const before = calls.length; denied = true;
      const blocked = { method: 'conversation.input', ghost_id: ghost, conversation_id: conversation, turn_id: 'turn-revoked', prompt: 'Current authority was revoked.', privacy, attachments: [] };
      await runtime.handle(frame('input-revoked', blocked)); await runtime.waitForIdle(ghost, conversation);
      assert.equal(calls.length, before, 'compaction cannot bypass disclosure/inference authority or invoke another provider');
      assert.equal(runs.get(blocked.turn_id).state, 'failed');
    } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
  }
});
