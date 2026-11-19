import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockProvider } from './mock-provider';
import { seed } from './seed';
import { writeCleanupState, writeRunState, type RunHost } from './run-state';

/** Each run seeds isolated Hosts; workers inherit only the unique run root. */

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

async function startSeededHost(tempRoot: string, name: RunHost, mockPort: number, hostPids: number[]) {
  const root = join(tempRoot, name);
  const hostRoot = join(root, 'host');
  const scopePath = join(root, 'projects');
  mkdirSync(hostRoot, { recursive: true });
  mkdirSync(scopePath);
  const host = spawn('bun', ['../ghost-host/src/main.ts', 'serve'], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, GHOST_ROOT: hostRoot, GHOST_PORT: '0', GHOST_UI_DIR: uiDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (host.pid) hostPids.push(host.pid);
  writeCleanupState({ hostPids, tempRoot });
  let hostErrors = '';
  host.stderr?.on('data', piece => { hostErrors += String(piece); });

  const hostFilePath = join(hostRoot, 'host.json');
  await waitForFile(hostFilePath, 120_000, () => `host stderr: ${hostErrors}`);
  const { port, token } = JSON.parse(readFileSync(hostFilePath, 'utf8')) as { port: number; token: string };
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  const seeded = await seed({ baseUrl, token, mockBaseUrl: `http://127.0.0.1:${mockPort}/v1`, scopePath });
  writeRunState(name, { ...seeded, baseUrl, mockPort, fixedNow: Date.now() + 60_000 });
}

export default async function globalSetup(): Promise<void> {
  if (!existsSync(join(uiDir, 'index.html'))) {
    throw new Error(`the UI is not built; run \`bun run build\` first (missing ${uiDir})`);
  }
  const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-visual-regression-'));
  process.env.GHOST_VISUAL_RUN_ROOT = tempRoot;
  const hostPids: number[] = [];
  writeCleanupState({ hostPids, tempRoot });
  const mock = await startMockProvider();
  // Activity edits install policy rules, which invalidate pending approvals on the primary Host.
  await Promise.all([
    startSeededHost(tempRoot, 'primary', mock.port, hostPids),
    startSeededHost(tempRoot, 'activities', mock.port, hostPids),
  ]);
}
