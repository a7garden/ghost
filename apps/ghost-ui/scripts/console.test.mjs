import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('external console authenticates its host and leaves it alive on exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-external-console-'));
  const token = randomBytes(32).toString('hex');
  let bootstrapCalls = 0;
  const host = createServer((req, res) => {
    const nonce = req.url.split('/').at(-1);
    bootstrapCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ protocol: 'ghost-control', version: 1,
      proof: createHmac('sha256', token).update('ghost-control-bootstrap-v1\0').update(nonce).digest('hex') }));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const reserved = createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  await writeFile(join(root, '.ghost-control.json'), JSON.stringify({ protocol: 'ghost-control', protocol_version: 1,
    host: '127.0.0.1', port: host.address().port, token }), { mode: 0o600 });
  await writeFile(join(root, 'console.json'), JSON.stringify({ root, port, host_mode: 'external' }));
  const child = spawn(process.execPath, [new URL('./console.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GHOST_CONSOLE_CONFIG: join(root, 'console.json'), GHOST_BIN: '/does-not-exist' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stderr.on('data', data => { output += data; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ghost-api/bootstrap`);
        const body = await response.json();
        ready = body.mode === 'live' && body.owner_pid === child.pid;
        if (ready) break;
      } catch {}
      if (child.exitCode !== null) break;
      await delay(20);
    }
    assert.equal(ready, true, output);
    assert.equal(bootstrapCalls, 1);
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    assert.equal(host.listening, true);
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await new Promise(resolve => host.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('external console rejects stale discovery without spawning a host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-external-stale-'));
  const config = join(root, 'console.json');
  await writeFile(config, JSON.stringify({ root, port: 62199, host_mode: 'external' }));
  const child = spawn(process.execPath, [new URL('./console.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GHOST_CONSOLE_CONFIG: config, GHOST_BIN: '/does-not-exist' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.equal(child.signalCode, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
