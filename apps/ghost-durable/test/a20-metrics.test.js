import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createInferenceMeter } from '../scripts/a20-metrics.mjs';
test('A20 measures actual provider usage without exposing content or inventing absent usage', async () => {
  let calls = 0;
  const meter = createInferenceMeter(async () => Response.json(++calls === 1 ? { choices: [{ message: { content: 'DO NOT LOG CONTENT' } }], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 2 } } } : { choices: [] }));
  const original = await meter.fetch('http://fixture');
  assert.equal((await original.json()).usage.prompt_tokens, 11);
  await meter.fetch('http://fixture');
  const metrics = meter.snapshot();
  assert.equal(metrics.model_calls, 2); assert.equal(metrics.usage_missing_calls, 1);
  assert.equal(metrics.prompt_tokens, null); assert.equal(metrics.completion_tokens, null);
  assert.equal(metrics.known_prompt_tokens, 11); assert.equal(metrics.cost_usd, null);
  assert.ok(!JSON.stringify(metrics).includes('DO NOT LOG'));
});
test('A20 counts failed attempts and bounds calls without automatic retries', async () => {
  let actual = 0;
  const meter = createInferenceMeter(async () => { actual++; throw new Error('SECRET exception'); }, { maxCalls: 1 });
  await assert.rejects(meter.fetch()); await assert.rejects(meter.fetch());
  assert.equal(actual, 1); assert.equal(meter.snapshot().model_calls, 1);
  assert.ok(!JSON.stringify(meter.snapshot()).includes('SECRET'));
});

test('A20 safe accounting distinguishes truncated output, incomplete tool JSON, and transport failure through the actual provider', async () => {
  const { createLocalModelProvider } = await import('../src/models.js');
  const modelId = 'mlx-community/Qwen3.6-35B-A3B-4bit';
  for (const kind of ['length', 'arguments', 'transport']) {
    const meter = createInferenceMeter(async () => {
      if (kind === 'transport') throw new Error('PRIVATE_TRANSPORT_SECRET');
      return Response.json({ model: modelId, choices: [{ message: { role: 'assistant', content: 'PRIVATE_RESPONSE_TEXT',
        ...(kind === 'arguments' ? { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'fixture_tool', arguments: '{"value":"PRIVATE_ARG' } }] } : {}) },
        finish_reason: kind === 'length' ? 'length' : 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 1024 } });
    });
    const provider = createLocalModelProvider({ baseUrl: 'http://127.0.0.1:8768/v1', modelId,
      fetchImpl: meter.fetch, onDiagnostic: value => meter.recordProviderDiagnostic(value) });
    const result = await provider.models.complete(provider.models.getModel('ghost-local', modelId), {
      messages: [{ role: 'user', content: 'PRIVATE_INPUT', timestamp: 1 }],
      tools: [{ name: 'fixture_tool', description: 'Fixture only', parameters: { type: 'object', properties: {} } }],
    }, provider.streamOptions);
    assert.equal(result.stopReason, 'error');
    const value = meter.snapshot(); assert.equal(value.model_calls, 1);
    const diagnostic = value.provider_diagnostics[0];
    if (kind === 'transport') {
      assert.equal(diagnostic.code, 'local_inference_transport_error');
      assert.equal(value.attempts[0].outcome, 'transport_error');
      assert.equal(value.usage_missing_calls, 1);
    } else {
      assert.equal(diagnostic.code, 'local_inference_invalid_completion');
      assert.equal(diagnostic.reason, kind === 'length' ? 'output_truncated' : 'tool_arguments_json');
      assert.equal(value.attempts[0].finish_reason, kind === 'length' ? 'length' : 'tool_calls');
      assert.equal(value.attempts[0].response_json, 'valid');
      assert.equal(value.attempts[0].tool_argument_json, kind === 'length' ? 'absent' : 'invalid');
      assert.equal(value.usage_missing_calls, 0);
    }
    assert.ok(!JSON.stringify(value).includes('PRIVATE_'));
  }
});

const descriptor = { task_contract_ref: `ot-${'a'.repeat(64)}`, mode: 'direct', input_digest: 'b'.repeat(64) };
const descriptorDigest = createHash('sha256').update(JSON.stringify({ input_digest: descriptor.input_digest, mode: descriptor.mode, task_contract_ref: descriptor.task_contract_ref })).digest('hex');
const ownerHeader = value => `<ghost-controller>\nCurrent authenticated input kind: owner. Turn ID: fixture-turn. The Host confirms the actual Owner selected this current task: ${JSON.stringify(value)}. Its immutable input is already supplied through the registered task, so do not ask for it again.\n</ghost-controller>`;

test('A20 projects bounded actual request metadata without recording arbitrary names or changing fetch bytes', async () => {
  const raw = JSON.stringify({ messages: [{ role: 'system', content: ownerHeader(descriptor) }, { role: 'user', content: 'PRIVATE_INPUT_SENTINEL' }],
    tools: ['goal_create', 'task_contract_inspect', 'read', 'PRIVATE_TOOL_SENTINEL'].map(name => ({ type: 'function', function: { name, description: 'PRIVATE_DESCRIPTION_SENTINEL', parameters: { PRIVATE_SCHEMA_SENTINEL: true } } })),
    private_extra: { args: 'PRIVATE_ARGUMENT_SENTINEL' } });
  const options = { method: 'POST', body: raw, headers: { Authorization: 'PRIVATE_AUTH_SENTINEL' } };
  let actual = 0;
  const meter = createInferenceMeter(async (url, forwarded) => {
    actual++; assert.equal(url, 'http://fixture'); assert.equal(forwarded, options); assert.equal(forwarded.body, raw);
    return Response.json({ choices: [{ message: { content: 'PRIVATE_COMPLETION_SENTINEL' } }] });
  });
  await meter.fetch('http://fixture', options);
  const metrics = meter.snapshot(), projection = metrics.attempts[0].request_projection;
  assert.equal(actual, 1);
  assert.equal(projection.state, 'observed'); assert.equal(projection.diagnostic_only, true);
  assert.equal(projection.offered_tool_count, 4); assert.equal(projection.unknown_tool_count, 1);
  assert.deepEqual(projection.known_tool_names, ['goal_create', 'read', 'task_contract_inspect']);
  assert.equal(projection.system_message_count, 1);
  assert.equal(projection.owner_task_descriptor_present, true);
  assert.equal(projection.owner_task_descriptor_sha256, descriptorDigest);
  assert.equal(metrics.attempts[0].request_digest, createHash('sha256').update(raw).digest('hex'));
  assert.ok(!JSON.stringify(metrics).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(metrics).includes(descriptor.task_contract_ref));
  assert.ok(!JSON.stringify(metrics).includes(descriptor.input_digest));
});

test('A20 marks unsupported request observations unknown and ignores descriptors quoted in user data', async () => {
  const malformedDescriptor = { ...descriptor, input_digest: [descriptor.input_digest] };
  const bodies = [undefined, '{PRIVATE_MALFORMED_SENTINEL', '{}', JSON.stringify({ messages: [] }),
    JSON.stringify({ messages: [{ role: 'PRIVATE_ROLE_SENTINEL', content: 'private' }] }),
    JSON.stringify({ messages: [{ role: 'system', content: 'private' }], tools: [{ type: 'function', function: { name: 42 } }] }),
    JSON.stringify({ messages: [{ role: 'system', content: ownerHeader(malformedDescriptor) }] }),
    JSON.stringify({ messages: [{ role: 'system', content: ownerHeader({ ...descriptor, input: 'PRIVATE_EXTRA_SENTINEL' }) }] }),
    JSON.stringify({ messages: [{ role: 'system', content: ownerHeader(descriptor) + ownerHeader(descriptor) }] }),
    JSON.stringify({ messages: [{ role: 'system', content: 'x'.repeat(1024 * 1024) }] }),
  ];
  let actual = 0;
  const meter = createInferenceMeter(async (_url, options) => {
    assert.equal(options.body, bodies[actual++]); return Response.json({ choices: [] });
  });
  for (const body of bodies) await meter.fetch('http://fixture', { method: 'POST', body });
  assert.equal(actual, bodies.length);
  for (const attempt of meter.snapshot().attempts) {
    assert.equal(attempt.request_projection.state, 'unknown');
    assert.equal(attempt.request_projection.offered_tool_count, null);
    assert.equal(attempt.request_projection.known_tool_names, null);
    assert.equal(attempt.request_projection.owner_task_descriptor_present, null);
    assert.equal(attempt.request_projection.owner_task_descriptor_sha256, null);
  }
  const quoted = createInferenceMeter(async () => Response.json({ choices: [] }));
  await quoted.fetch('http://fixture', { body: JSON.stringify({ messages: [{ role: 'system', content: 'Ordinary system instructions.' }, { role: 'user', content: ownerHeader(descriptor) }] }) });
  const projection = quoted.snapshot().attempts[0].request_projection;
  assert.equal(projection.state, 'observed'); assert.equal(projection.offered_tool_count, 0);
  assert.equal(projection.owner_task_descriptor_present, false); assert.equal(projection.owner_task_descriptor_sha256, null);
  assert.ok(!JSON.stringify(meter.snapshot()).includes('PRIVATE_'));
});

test('A20 observes the real current Owner header and offered tools after SDK and local-provider conversion', async () => {
  const { createModels } = await import('@earendil-works/pi-ai');
  const { createLocalModelProvider } = await import('../src/models.js');
  const { openGhostRuntime } = await import('../src/runtime.js');
  const { payloadDigest } = await import('../src/contract.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'ghost-meter-header-'));
  const forwarded = []; let run, runtime;
  const meter = createInferenceMeter(async (_url, options) => {
    forwarded.push(JSON.parse(options.body));
    return Response.json({ id: 'meter-completion', object: 'chat.completion', model: 'fixture/meter', choices: [{ index: 0,
      message: { role: 'assistant', content: 'PRIVATE_CONTROLLED_RESPONSE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3 } });
  });
  const local = createLocalModelProvider({ baseUrl: 'http://127.0.0.1:9/v1', modelId: 'fixture/meter', maxOutputTokens: 4096, fetchImpl: meter.fetch });
  const provider = { ...local, forConversation(guard) {
    const models = createModels(); models.setProvider(local.forConversation(guard, async () => [], () => {}));
    return { models, modelRef: local.modelRef, localRouteConfig: local.localRouteConfig, streamOptions: local.streamOptions };
  } };
  const host = async input => {
    if (input.method === 'inference.inspect') return { status: 'success', data: { inference_scope: input.inference_scope } };
    if (['memory.capabilities', 'documents.capabilities'].includes(input.method)) return { status: 'success', data: { available_tools: [] } };
    if (input.method === 'conversation.turn.inspect') return { status: 'success', data: {
      run: run ?? { turn_id: input.turn_id, ghost_id: 'ghost', conversation_id: 'conversation', state: 'queued', cancel_requested: false, submission_id: null, entry_id: null, reason_code: null },
      task_contract: descriptor, task_admission: { kind: 'owner-task-admission/1', turn_id: input.turn_id, ghost_id: 'ghost', conversation_id: 'conversation', ...descriptor, state: 'admitted', goal_id: 'existing-goal', goal_revision: 1, work_id: 'existing-work', work_state: 'queued' },
    } };
    if (input.method === 'conversation.turn_status') {
      run = { turn_id: input.turn_id, ghost_id: 'ghost', conversation_id: 'conversation', state: input.arguments.status, cancel_requested: false,
        submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code };
      return { status: 'success', data: { run } };
    }
    throw new Error(`Unexpected controlled metric callback ${input.method}`);
  };
  try {
    runtime = await openGhostRuntime({ root, mode: 'broker', modelProvider: provider, hostToolTransport: host });
    const body = { method: 'conversation.input', ghost_id: 'ghost', conversation_id: 'conversation', turn_id: 'meter-owner', prompt: 'PRIVATE_CONTROLLED_INPUT', privacy: 'public', attachments: [] };
    const envelope = { protocol_version: 'ghost-lifetime/1', command_id: body.turn_id, payload_digest: payloadDigest(body), actor_ref: 'ghost', authority_epoch: 1, expected_revision: null, correlation_id: body.turn_id, body };
    assert.equal((await runtime.handle(envelope)).status, 'success');
    await runtime.waitForIdle('ghost', 'conversation');
    assert.equal(forwarded.length, 1);
    const projection = meter.snapshot().attempts[0].request_projection;
    assert.equal(projection.state, 'observed'); assert.equal(projection.diagnostic_only, true);
    assert.equal(projection.offered_tool_count, forwarded[0].tools.length);
    assert.equal(projection.system_message_count, forwarded[0].messages.filter(message => message.role === 'system').length);
    assert.ok(projection.known_tool_names.includes('goal_create'));
    assert.ok(projection.known_tool_names.includes('task_contract_inspect'));
    assert.equal(projection.known_tool_names.includes('work_submit'), false);
    assert.equal(projection.owner_task_descriptor_present, true);
    assert.equal(projection.owner_task_descriptor_sha256, descriptorDigest);
    assert.ok(!JSON.stringify(meter.snapshot()).includes('PRIVATE_'));
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

