// Runs only an isolated temporary root with the mock provider. No shared build,
// profile databases, credentials, or external tools are touched.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createBridge } from '../server/bridge.mjs';

const binary = process.env.GHOST_BIN || fileURLToPath(new URL('../../../target/debug/ghost', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'ghost-ui-live-check-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|GHOST_|OXI|MCP/i.test(k)));
const host = spawn(binary, ['--root', root, 'serve', '--headless', '--model', 'mock'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let errors = ''; host.stderr.on('data', chunk => { errors += chunk.toString(); });
let ui;
const results = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host startup timeout')), 10000);
    let output = '';
    host.once('error', e => { clearTimeout(timer); reject(e); });
    host.once('exit', code => { clearTimeout(timer); reject(new Error(`host exited ${code}: ${errors.slice(0,200)}`)); });
    host.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('\n')) { clearTimeout(timer); const ready = JSON.parse(output.split('\n')[0]); assert.equal(ready.mode, 'headless'); resolve(); } });
  });
  ui = createServer(createBridge({ root })); await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${ui.address().port}`;
  const bootstrap = await fetch(`${origin}/ghost-api/bootstrap`).then(r => r.json()); assert.equal(bootstrap.mode, 'live');
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': bootstrap.csrf };
  const read = async () => { const r = await fetch(`${origin}/ghost-api/snapshot`, { headers }); assert.equal(r.status, 200); return r.json(); };
  const send = async (command, request_id = randomUUID()) => { const r = await fetch(`${origin}/ghost-api/action`, { method: 'POST', headers, body: JSON.stringify({ request_id, command }) }); const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body)); assert.equal(body.ok, true, JSON.stringify(body)); return body.result; };
  const initial = await read(); assert.equal(initial.host_protocol_version, 1); assert.equal(initial.profiles.length, 0); results.push('authenticated empty snapshot');
  const { profile_id } = await send({ type: 'create_profile', name: 'UiCheck', persona: 'Isolated UI verification' });
  const { conversation_id } = await send({ type: 'create_conversation', profile_id, model: 'mock', tools: false });
  const request = randomUUID(), command = { type: 'submit', profile_id, conversation_id, prompt: 'UI bridge verification', kind: 'prompt' };
  const first = await send(command, request), duplicate = await send(command, request); assert.equal(first.task_id, duplicate.task_id); results.push('create profile and conversation; idempotent submit');
  let snapshot, task;
  for (let i = 0; i < 50; i++) { snapshot = await read(); task = snapshot.profiles[0]?.conversations[0]?.tasks.find(t => t.id === first.task_id); if (task?.phase === 'complete') break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(task?.phase, 'complete'); assert.ok(snapshot.profiles[0].conversations[0].messages.some(m => m.role === 'assistant')); results.push('completed mock task and durable conversation messages');
  const schedule = await send({ type: 'add_schedule', profile_id, conversation_id, prompt: 'later', interval_seconds: 604800 });
  const schedule_id = schedule.id ?? schedule.schedule_id;
  await send({ type: 'pause_schedule', schedule_id, paused: true }); assert.equal((await read()).schedules.find(s => s.id === schedule_id).paused, true); results.push('schedule create and pause');
  await send({ type: 'workspace', action: { type: 'persona', profile_id, persona: 'Updated in isolated UI test' } }); assert.equal((await read()).profiles[0].persona, 'Updated in isolated UI test'); results.push('workspace persona update');
  const report = { checkedAt: new Date().toISOString(), provider: 'mock', isolatedRoot: true, externalTools: false, results, status: 'passed' };
  await writeFile(new URL('../evidence/host-integration.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (ui) { await new Promise(resolve => { ui.close(resolve); ui.closeAllConnections(); }); }
  if (host.exitCode === null) { const exited = new Promise(resolve => host.once('exit', resolve)); host.kill('SIGTERM'); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]); if (host.exitCode === null) { host.kill('SIGKILL'); await exited; } }
  await rm(root, { recursive: true, force: true });
}
