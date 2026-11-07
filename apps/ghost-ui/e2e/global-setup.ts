import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockProvider } from './mock-provider';
import { seed, type HostHandle } from './seed';
import { writeCleanupState, writeRunState } from './run-state';

/**
 * Global setup: one isolated Ghost host from source plus the in-process mock
 * provider, then deterministic seed data through the owner API. The run facts
 * land in `e2e/.run/state.json`; teardown kills the processes and removes the
 * temporary state root.
 */

const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
/** A stable absolute path: the project space displays it verbatim, so it must not contain a random suffix. */
const tempRoot = join(tmpdir(), 'ghost-visual-regression');

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
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(join(tempRoot, 'projects'), { recursive: true });

  const mock = await startMockProvider();
  const host = spawn('bun', ['../ghost-host/src/main.ts', 'serve'], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, GHOST_ROOT: tempRoot, GHOST_PORT: '0', GHOST_UI_DIR: uiDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let hostErrors = '';
  host.stderr?.on('data', piece => { hostErrors += String(piece); });

  const hostFilePath = join(tempRoot, 'host.json');
  try {
    await waitForFile(hostFilePath, 120_000, () => `host stderr: ${hostErrors}`);
  } catch (error) {
    host.kill('SIGKILL');
    void mock.stop().catch(() => {});
    throw error;
  }
  const hostFile = JSON.parse(readFileSync(hostFilePath, 'utf8')) as { port: number; token: string; pid: number };
  writeCleanupState({ hostPid: hostFile.pid, tempRoot });
  const baseUrl = `http://127.0.0.1:${hostFile.port}`;
  await waitForHealth(baseUrl);

  const seeded = await seed({ baseUrl, token: hostFile.token, mockBaseUrl: `http://127.0.0.1:${mock.port}/v1`, spacePath: join(tempRoot, 'projects') });
  writeRunState({ ...seeded, baseUrl, mockPort: mock.port, fixedNow: Date.now() + 60_000 });
}
