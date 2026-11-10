import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockProvider } from './mock-provider';
import { seed } from './seed';
import { writeCleanupState, writeRunState } from './run-state';

/**
 * Global setup: one isolated Ghost host from source plus the in-process mock
 * provider, then deterministic seed data through the owner API. The run facts
 * land in this run's unique temporary root; workers inherit its path through the
 * environment. Concurrent worktrees/runs never share metadata or host state.
 */

const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

async function waitForFile(path: string, timeoutMs: number, detail: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}; ${detail()}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The listener may not be up yet; keep polling.
    }
    if (Date.now() > deadline) throw new Error(`the host did not become healthy at ${baseUrl}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export default async function globalSetup(): Promise<void> {
  if (!existsSync(join(uiDir, 'index.html'))) {
    throw new Error(`the UI is not built; run \`bun run build\` first (missing ${uiDir})`);
  }
  const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-visual-regression-'));
  process.env.GHOST_VISUAL_RUN_ROOT = tempRoot;
  const hostRoot = join(tempRoot, 'host');
  mkdirSync(hostRoot);
  mkdirSync(join(tempRoot, 'projects'));

  const mock = await startMockProvider();
  const host = spawn('bun', ['../ghost-host/src/main.ts', 'serve'], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, GHOST_ROOT: hostRoot, GHOST_PORT: '0', GHOST_UI_DIR: uiDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  writeCleanupState({ hostPid: host.pid, tempRoot });
  let hostErrors = '';
  host.stderr?.on('data', piece => { hostErrors += String(piece); });

  const hostFilePath = join(hostRoot, 'host.json');
  try {
    await waitForFile(hostFilePath, 120_000, () => `host stderr: ${hostErrors}`);
  } catch (error) {
    host.kill('SIGKILL');
    void mock.stop().catch(() => {});
    throw error;
  }
  const hostFile = JSON.parse(readFileSync(hostFilePath, 'utf8')) as { port: number; token: string; pid: number };
  const baseUrl = `http://127.0.0.1:${hostFile.port}`;
  await waitForHealth(baseUrl);

  const seeded = await seed({ baseUrl, token: hostFile.token, mockBaseUrl: `http://127.0.0.1:${mock.port}/v1`, spacePath: join(tempRoot, 'projects') });
  writeRunState({ ...seeded, baseUrl, mockPort: mock.port, fixedNow: Date.now() + 60_000 });
}
