import test from 'node:test';
import assert from 'node:assert/strict';

test('explicit Owner local output bound is validated and cannot be widened by model call options', async () => {
  const { createLocalModelProvider } = await import('../src/models.js');
  const { createModels } = await import('@earendil-works/pi-ai');
  const modelId = 'mlx-community/Qwen3.6-35B-A3B-4bit';
  const base = { baseUrl: 'http://127.0.0.1:8768/v1', modelId };
  for (const invalid of [0, -1, 4097, 16384, 1.5, '4096', NaN, Infinity]) {
    assert.throws(() => createLocalModelProvider({ ...base, maxOutputTokens: invalid }));
  }
  for (const bound of [undefined, 4096]) {
    let sent;
    const provider = createLocalModelProvider({ ...base, maxOutputTokens: bound, fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body); return Response.json({ model: modelId, choices: [{ message: { role: 'assistant', content: 'complete' }, finish_reason: 'stop' }] });
    } });
    const models = createModels(); models.setProvider(provider.forConversation(async () => {}));
    const model = models.getModel('ghost-local', modelId);
    assert.equal(model.maxTokens, bound ?? 1024);
    const result = await models.complete(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }, { maxTokens: 99999, maxRetries: 9 });
    assert.equal(result.stopReason, 'stop'); assert.equal(sent.max_tokens, bound ?? 1024);
    assert.equal(sent.reasoning_effort, 'none');
  }
});

test('production startup accepts the explicit local cap and refuses invalid or unconfigured cap without a ready handshake', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'ghost-local-cap-'));
  try {
    for (const [raw, configured, success] of [['4096', true, true], ['4097', true, false], ['0', true, false], ['x', true, false], ['4096', false, false], ['4096', 'empty', false]]) {
      const env = { PATH: process.env.PATH, HOME: root, GHOST_LIFETIME_HOST_ROOT: root,
        GHOST_PI_CALLBACK_TOKEN: 'fixture-only-callback', GHOST_PI_AUTHORITY_EPOCH: '1', GHOST_LIFETIME_LOCAL_MAX_OUTPUT_TOKENS: raw,
        ...(configured ? { GHOST_LIFETIME_LOCAL_MODEL_URL: configured === 'empty' ? '' : 'http://127.0.0.1:8768/v1', GHOST_LIFETIME_LOCAL_MODEL_ID: 'mlx-community/Qwen3.6-35B-A3B-4bit' } : {}) };
      const result = spawnSync(process.execPath, ['src/main.js', '--root', join(root, `${raw}-${configured}`), '--mode', 'broker'],
        { cwd: new URL('../', import.meta.url), env, input: '', encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, success ? 0 : 1, result.stderr);
      if (success) assert.equal(JSON.parse(result.stdout).mode, 'broker');
      else assert.equal(result.stdout, '');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
