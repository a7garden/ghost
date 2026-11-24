import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
let temp: string;
let fixture: string;
let ui: string;
let api: string;
let token: string;
const processes: ChildProcess[] = [];

function start(args: string[], cwd: string, env: NodeJS.ProcessEnv, ready?: (output: string) => string | undefined) {
  const process = spawn('bun', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(process);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let output = '';
  const log = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
    const value = ready?.(output);
    if (value) resolve(value);
  };
  process.stdout?.on('data', log);
  process.stderr?.on('data', log);
  process.once('error', reject);
  process.once('exit', code => reject(new Error(`Fixture process exited ${code}\n${output}`)));
  if (!ready) process.once('spawn', () => resolve(''));
  return promise;
}

test.beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'ghost-pi-browser-'));
  const root = join(temp, 'state');
  const home = join(temp, 'home');
  mkdirSync(root); mkdirSync(home);
  fixture = join(temp, 'visual-extension.ts');
  writeFileSync(fixture, `export default function(pi) {
    pi.registerCommand('visual-check', { description: 'Visual check', handler: async () => {} });
  }`);
  // HOME, PATH and XDG isolate user tools from the test Host.
  const originalHome = homedir();
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, XDG_RUNTIME_DIR: home, GHOST_ROOT: root, GHOST_PORT: '0',
    PATH: process.env.PATH?.split(delimiter).filter(path => !path.startsWith(join(originalHome, '.local'))).join(delimiter) };
  await start(['apps/ghost-host/src/main.ts', 'serve'], repo, env);
  await expect.poll(() => {
    try { return readFileSync(join(root, 'host.json'), 'utf8'); }
    catch { return ''; }
  }).not.toBe('');
  const descriptor = JSON.parse(readFileSync(join(root, 'host.json'), 'utf8')) as { port: number; token: string };
  api = `http://127.0.0.1:${descriptor.port}`;
  token = descriptor.token;
  ui = await start(['--bun', 'run', 'vite', '--port', '0'], join(repo, 'apps/ghost-ui'), env, output =>
    /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]);
});

test.afterAll(async () => {
  await Promise.all(processes.toReversed().map(async process => {
    if (process.exitCode !== null || process.signalCode !== null || !process.pid) return;
    const exit = once(process, 'exit');
    process.kill();
    await exit;
  }));
  if (temp) rmSync(temp, { recursive: true, force: true });
});

for (const width of [1440, 390]) {
  test(`owner edits Pi defaults and manages a local extension at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const settings = await request.get(`${api}/api/pi/settings`, { headers: { authorization: `Bearer ${token}` } });
    expect(settings.ok()).toBe(true);
    const { settings: before } = await settings.json();
    await page.goto(`${ui}/#/settings?tab=coding`);
    await expect(page.getByRole('heading', { name: '내장 코딩 기본값' })).toBeVisible();
    await page.getByText('맥락 압축', { exact: true }).click();
    const auto = page.getByRole('switch', { name: '자동 압축' });
    await expect(auto).toHaveAttribute('aria-checked', String(before.compaction.enabled));
    await auto.click();
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '저장했습니다.' })).toBeVisible();
    await page.reload();
    await page.getByText('맥락 압축', { exact: true }).click();
    await expect(auto).toHaveAttribute('aria-checked', String(!before.compaction.enabled));
    const evidence = process.env.GHOST_PI_SCREENSHOTS;
    if (evidence?.startsWith('/tmp/')) await page.screenshot({ path: `${evidence}-${width}-defaults.png` });

    await page.getByRole('button', { name: '패키지 설치' }).click();
    await page.getByLabel('로컬 경로, Git URL 또는 npm 패키지').fill(fixture);
    const install = page.getByRole('button', { name: '설치', exact: true });
    await expect(install).toBeDisabled();
    if (evidence?.startsWith('/tmp/')) await page.screenshot({ path: `${evidence}-${width}-install.png` });
    await page.getByRole('checkbox', { name: '설치 스크립트와 확장은 Host의 전체 권한으로 실행될 수 있습니다.' }).check();
    await install.click();
    const toggle = page.getByRole('combobox', { name: 'visual-extension.ts 확장' });
    await expect(toggle).toHaveValue('false');
    await toggle.selectOption('true');
    await expect.poll(async () => (await (await request.get(`${api}/api/pi/packages`, { headers: { authorization: `Bearer ${token}` } })).json())[0]?.enabled.extensions).toBe(true);
    const group = page.getByRole('region', { name: 'Pi 패키지' });
    await expect(group).toBeVisible();
    expect(await group.evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(Math.ceil((await group.boundingBox())!.width));
    if (evidence?.startsWith('/tmp/')) await page.screenshot({ path: `${evidence}-${width}.png` });
    await page.getByRole('button', { name: 'visual-extension.ts 제거' }).click();
    await page.getByRole('dialog', { name: 'visual-extension.ts 제거' }).getByRole('button', { name: '제거' }).click();
    await expect(page.getByText('설치된 Pi 패키지가 없습니다.')).toBeVisible();
  });
}
