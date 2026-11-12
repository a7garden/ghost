import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, State } from '@ghost/contract';

/** No provider process, route interception, canned snapshot, or production root. */
const test = base.extend<{}, { host: { baseUrl: string; root: string; vault: string } }>({
  host: [async ({}, use) => {
    const ui = fileURLToPath(new URL('..', import.meta.url));
    if (!existsSync(join(ui, 'dist/index.html'))) throw new Error('Build the integrated UI first: cd apps/ghost-ui && bun run build');
    const root = mkdtempSync(join(tmpdir(), 'ghost-infrastructure-ui-'));
    const vault = join(root, 'documents'); mkdirSync(vault);
    const child = spawn('bun', ['../ghost-host/src/main.ts', 'serve'], { cwd: ui, env: { ...process.env, GHOST_ROOT: root, GHOST_PORT: '0', GHOST_UI_DIR: resolve(ui, 'dist') }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const exit = Promise.withResolvers<void>();
    child.once('exit', () => exit.resolve());
    try {
      await expect.poll(() => {
        if (child.exitCode !== null) throw new Error(`isolated Host exited: ${stderr}`);
        return existsSync(join(root, 'host.json'));
      }, { timeout: 120_000 }).toBe(true);
      const info = JSON.parse(readFileSync(join(root, 'host.json'), 'utf8')) as { port: number; pid: number };
      if (info.port === 62062 || info.pid !== child.pid) throw new Error('Refusing a Host not owned by this smoke run');
      await use({ baseUrl: `http://127.0.0.1:${info.port}`, root, vault });
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
      await exit.promise; clearTimeout(timer); rmSync(root, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
});

async function command(page: Page, input: Command): Promise<Record<string, unknown>> {
  return page.evaluate(async input => {
    const response = await fetch('/api/commands', { method: 'POST', headers: { authorization: `Bearer ${window.__GHOST_TOKEN__}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), command: input }) });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(JSON.stringify(body));
    return body.result;
  }, input);
}
async function snapshot(page: Page): Promise<State> {
  return page.evaluate(async () => {
    const response = await fetch('/api/state', { headers: { authorization: `Bearer ${window.__GHOST_TOKEN__}` } });
    if (!response.ok) throw new Error(`snapshot: ${response.status}`);
    return response.json();
  });
}

test('scope, document, slot, MCP, policy and conflict-aware history use the real Host', async ({ page, host }, info) => {
  const errors: string[] = [];
  let conflictExpected = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !(conflictExpected && message.text().includes('409'))) errors.push(message.text()); });
  await page.goto(`${host.baseUrl}/#/scopes?new=1`);
  await page.getByLabel('프로젝트 이름', { exact: true }).fill('UI 검증 프로젝트');
  await page.getByLabel('문서 금고 경로 (선택)').fill(host.vault);
  await page.getByRole('button', { name: '읽기 경로 추가', exact: true }).click();
  await page.getByLabel('읽기 경로 1', { exact: true }).fill(host.root);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '프로젝트 편집', exact: true })).toBeVisible();
  let state = await snapshot(page);
  const scope = state.scopes.find(item => item.name === 'UI 검증 프로젝트')!;
  expect(scope.paths).toEqual([host.root]);
  expect(scope.vaultPath).toBe(host.vault);
  await command(page, { type: 'document.save', scopeId: scope.id, pageId: null, expectedHash: null, title: '검증 문서', body: '# 검증\n\n소유자가 남긴 문서입니다.', profile: 'pdc-markdown/1' });
  await page.reload();
  await page.getByRole('button', { name: '검증 문서, pdc-markdown/1', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '프로젝트 편집', exact: true }).click();
  await page.getByLabel('프로젝트 이름', { exact: true }).fill('수정한 프로젝트');
  await page.getByLabel('상태', { exact: true }).selectOption('paused');
  await page.getByRole('button', { name: '붙임 추가', exact: true }).click();
  await page.getByLabel('붙임 1 프로젝트', { exact: true }).selectOption(scope.id);
  await page.getByLabel('붙임 1 문서', { exact: true }).selectOption({ label: '검증 문서' });
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scopes.find(item => item.id === scope.id)?.attachments.length).toBe(1);
  await command(page, { type: 'provider.upsert', id: 'ui-smoke-openai', kind: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4.1', name: 'GPT-4.1' }, { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini' }] });
  await page.goto(`${host.baseUrl}/#/settings?tab=slots`);
  await page.getByRole('button', { name: '자리 추가', exact: true }).click();
  await page.getByLabel('자리 이름', { exact: true }).fill('owner-chosen');
  await page.getByLabel('모델', { exact: true }).selectOption('ui-smoke-openai/gpt-4.1');
  await page.getByRole('button', { name: '대체 모델 추가', exact: true }).click();
  await page.getByLabel('대체 모델 1', { exact: true }).selectOption('ui-smoke-openai/gpt-4.1-mini');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByLabel('기본 모델 자리', { exact: true }).selectOption('owner-chosen');
  await expect.poll(async () => (await snapshot(page)).settings.defaultSlot).toBe('owner-chosen');
  await page.goto(`${host.baseUrl}/#/settings?tab=mcp`);
  await page.getByRole('button', { name: '서버 추가', exact: true }).click();
  await page.getByLabel('서버 이름', { exact: true }).fill('ui-smoke');
  await page.getByLabel('사용', { exact: true }).uncheck();
  await page.getByLabel('실행 파일', { exact: true }).fill('/usr/bin/true');
  await page.getByRole('button', { name: '환경 변수 이름 추가', exact: true }).click();
  await page.getByLabel('환경 변수 이름 1', { exact: true }).fill('SMOKE_TOKEN');
  await page.getByRole('button', { name: '읽기 도구 추가', exact: true }).click();
  await page.getByLabel('읽기 도구 1', { exact: true }).fill('list');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).mcpServers.some(server => server.name === 'ui-smoke' && !server.enabled)).toBe(true);
  await page.goto(`${host.baseUrl}/#/settings?tab=rules`);
  await page.getByRole('button', { name: '규칙 추가', exact: true }).click();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(scope.id);
  await page.getByLabel('도구 무늬', { exact: true }).fill('mcp.ui-smoke.*');
  await page.getByLabel('대상', { exact: true }).selectOption('mcp_server');
  await page.getByLabel('접근', { exact: true }).selectOption('write');
  await page.getByLabel('결정', { exact: true }).selectOption('deny');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).policyRules.some(rule => rule.tool === 'mcp.ui-smoke.*' && rule.decision === 'deny')).toBe(true);
  state = await snapshot(page);
  const revision = state.configRevisions.filter(revision => {
    const after = revision.after;
    return revision.entity === 'rule' && after !== null && typeof after === 'object' && 'tool' in after && after.tool === 'mcp.ui-smoke.*';
  }).sort((a, b) => b.at - a.at)[0]!;
  await page.goto(`${host.baseUrl}/#/settings?tab=history`);
  await page.getByLabel('구성 종류', { exact: true }).selectOption('rule');
  const history = page.locator('article').filter({ hasText: 'rule.create' }).filter({ hasText: revision.entityId! });
  await history.getByRole('button', { name: '되돌리기', exact: true }).click();
  await history.getByRole('button', { name: '변경 전으로 되돌리기', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).policyRules.some(rule => rule.id === revision.entityId)).toBe(false);
  await page.screenshot({ path: info.outputPath('infrastructure-desktop.png'), fullPage: true });
  await page.getByLabel('구성 종류', { exact: true }).selectOption('scope');
  const oldScope = page.locator('article').filter({ hasText: 'scope.create' }).filter({ hasText: 'UI 검증 프로젝트' });
  await oldScope.getByRole('button', { name: '되돌리기', exact: true }).click();
  conflictExpected = true;
  await oldScope.getByRole('button', { name: '변경 전으로 되돌리기', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  conflictExpected = false;
  expect((await snapshot(page)).scopes.find(item => item.id === scope.id)?.name).toBe('수정한 프로젝트');
  await page.screenshot({ path: info.outputPath('infrastructure-conflict.png'), fullPage: true });
  await page.goto(`${host.baseUrl}/#/settings?tab=slots`);
  await page.locator('article').filter({ hasText: 'owner-chosen' }).getByRole('button', { name: '편집', exact: true }).click();
  const slotEditor = page.getByRole('form', { name: '모델 자리 편집' });
  await slotEditor.getByRole('button', { name: '삭제', exact: true }).click();
  await slotEditor.getByLabel('모델', { exact: true }).selectOption('ui-smoke-openai/gpt-4.1-mini');
  await slotEditor.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).settings.slots?.['owner-chosen']?.model.model).toBe('gpt-4.1-mini');
  await page.getByLabel('기본 모델 자리', { exact: true }).selectOption('');
  await page.locator('article').filter({ hasText: 'owner-chosen' }).getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('button', { name: '자리 삭제', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).settings.slots?.['owner-chosen']).toBeUndefined();
  await page.goto(`${host.baseUrl}/#/settings?tab=mcp`);
  await page.locator('article').filter({ hasText: 'ui-smoke' }).getByRole('button', { name: '편집', exact: true }).click();
  await page.getByLabel('연결 방식', { exact: true }).selectOption('http');
  await page.getByLabel('서버 URL', { exact: true }).fill('https://example.com/mcp');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).mcpServers.find(server => server.name === 'ui-smoke')?.transport.kind).toBe('http');
  await page.locator('article').filter({ hasText: 'ui-smoke' }).getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('button', { name: '서버 삭제', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).mcpServers.some(server => server.name === 'ui-smoke')).toBe(false);
  await command(page, { type: 'rule.create', tool: 'conn.smoke', when: { access: 'write' }, decision: 'deny' });
  await page.goto(`${host.baseUrl}/#/settings?tab=rules`);
  await page.locator('article').filter({ hasText: 'conn.smoke' }).getByRole('button', { name: '편집', exact: true }).click();
  await page.getByLabel('결정', { exact: true }).selectOption('owner');
  await page.getByLabel('평가자', { exact: true }).selectOption('main');
  await page.getByLabel('하루 횟수 한도 (비우면 없음)', { exact: true }).fill('5');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).policyRules.find(rule => rule.tool === 'conn.smoke')?.maxPerDay).toBe(5);
  await page.locator('article').filter({ hasText: 'conn.smoke' }).getByRole('button', { name: '편집', exact: true }).click();
  await page.getByLabel('평가자', { exact: true }).selectOption('none');
  await page.getByLabel('하루 횟수 한도 (비우면 없음)', { exact: true }).fill('');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).policyRules.find(rule => rule.tool === 'conn.smoke')?.maxPerDay).toBeUndefined();
  await page.locator('article').filter({ hasText: 'conn.smoke' }).getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('button', { name: '규칙 삭제', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).policyRules.some(rule => rule.tool === 'conn.smoke')).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${host.baseUrl}/#/scopes/${scope.id}?view=metrics`);
  await expect(page.getByRole('heading', { name: '계측', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '계측을 불러오는 중' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath('infrastructure-phone.png'), fullPage: true });
  await page.goto(`${host.baseUrl}/#/scopes/${scope.id}`);
  await page.getByRole('button', { name: '프로젝트 삭제', exact: true }).click();
  await page.getByRole('button', { name: '삭제', exact: true }).dispatchEvent('click', { detail: 0 });
  await page.getByRole('button', { name: '한 번 더 눌러 삭제', exact: true }).dispatchEvent('click', { detail: 0 });
  await expect.poll(async () => (await snapshot(page)).scopes.some(item => item.id === scope.id)).toBe(false);
  expect(existsSync(host.vault)).toBe(true);
  expect(errors).toEqual([]);
});
