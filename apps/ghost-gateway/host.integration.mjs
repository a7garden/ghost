import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { once } from 'node:events';
import { createGateway } from './server.mjs';
import { issueDevice } from './devices.mjs';

test('mobile gateway reaches a real Ghost: chat, receipts and restart', { skip: !process.env.GHOST_TEST_BINARY, timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-mobile-e2e-'));
  let host, server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (host && host.exitCode === null) { const exit = once(host, 'exit'); host.kill('SIGTERM'); await exit; }
    await rm(dir, { recursive: true, force: true });
  });
  const launch = async () => {
    host = spawn(process.env.GHOST_TEST_BINARY, ['--root', dir, 'serve', '--headless', '--model', 'mock', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await Promise.race([once(host.stdout, 'data'), once(host, 'exit').then(([code]) => { throw new Error(`host exited ${code}`); })]);
  };
  await launch();
  const devices = join(dir, 'devices.json'), device = await issueDevice(devices, 'Fixture iPhone');
  server = createGateway({ root: dir, devices, origin: 'https://ghost.example' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = (path, body) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method: body ? 'POST' : 'GET', headers: { Host: 'ghost.example', Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const action = (command, request_id = randomUUID()) => call('/mobile/v1/action', { request_id, command });
  assert.equal((await call('/mobile/v1/bootstrap')).protocol, 'ghost-mobile');
  const id = randomUUID(), create = { type: 'create_profile', name: 'mobile-fixture', persona: 'offline mobile test' };
  const first = await action(create, id), replay = await action(create, id);
  assert.equal(first.ok, true); assert.deepEqual(first, replay);
  const profile_id = first.result.profile_id;
  const conversation = await action({ type: 'create_conversation', profile_id, model: 'mock', tools: true });
  assert.equal(conversation.ok, true);
  const conversation_id = conversation.result.conversation_id;
  const submitted = await action({ type: 'submit', profile_id, conversation_id, kind: 'follow_up', prompt: 'Hello from the iPhone transport fixture.' });
  assert.equal(submitted.ok, true);
  const deadline = Date.now() + 15000;
  let state;
  do {
    state = await call('/mobile/v1/snapshot');
    if (state.profiles?.[0]?.conversations?.some(c => c.tasks.some(task => task.id === submitted.result.task_id && task.phase === 'complete'))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.ok(state.profiles[0].conversations.some(c => c.tasks.some(task => task.id === submitted.result.task_id && task.phase === 'complete')));
  const workspace = state.workspace_id;
  const stopped = once(host, 'exit'); host.kill('SIGTERM'); assert.equal((await stopped)[0], 0);
  await launch();
  const restored = await call('/mobile/v1/snapshot');
  assert.equal(restored.workspace_id, workspace);
  assert.deepEqual(await action(create, id), first);
});
