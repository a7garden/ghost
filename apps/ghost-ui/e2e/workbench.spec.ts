import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { CodingSession } from '@ghost/contract';
import { mockCodingSessions, sampleSession } from './coding-session-mock';
import { readRunState } from './run-state';
import { openScreen } from './visual';
import { mockWorkbench } from './workbench-mock';

const DAY = 24 * 60 * 60 * 1000;
const agentPane = (page: Page, title: string) => page.getByRole('region', { name: `에이전트: ${title}`, exact: true });

for (const width of [1440, 390]) {
  test.describe(`${width}px 작업대`, () => {
    const phone = width === 390;
    test.use({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
    test('starts an agent from one instruction, lists it under the project and returns to it after a reload', async ({ page }) => {
      const { scopeId } = readRunState();
      const coding = await mockCodingSessions(page);
      const { service } = await mockWorkbench(page, coding.creates);
      service.addAgent({ version: 0, sessionId: sampleSession.id, scopeId });
      // The sample agents carry fixed 2026 times; the run's own clock would fold them away as days old.
      await openScreen(page, {
        name: 'workbench', route: () => '/coding', waits: () => [phone ? sampleSession.title : '새 에이전트'],
        prepare: page => page.clock.setFixedTime(new Date(sampleSession.updatedAt + 60_000)),
      }, 'light');
      const existing = agentPane(page, sampleSession.title);
      await expect(existing).toBeVisible();

      // The list lives in the rail on a desktop and in the project popover on a phone.
      const list = async () => {
        if (phone) await page.locator('.workbench-compact-head > button').first().click();
        return page.getByRole('navigation', { name: '프로젝트', exact: true });
      };
      await (await list()).getByRole('button', { name: '새 에이전트', exact: true }).click();
      const launch = page.getByRole('region', { name: '새 에이전트', exact: true });
      await launch.getByRole('textbox', { name: '코딩 지시' }).fill('로그인 버튼을 가운데로');
      const evidence = process.env.GHOST_WORKBENCH_EVIDENCE_DIR;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `launch-${width}.png`), animations: 'disabled', caret: 'hide' });
      }
      await launch.getByRole('button', { name: '지시 보내기' }).click();
      const created = agentPane(page, '새 작업 트리');
      await expect(created).toBeVisible();
      await expect(existing).toBeHidden();
      expect(coding.creates[0]).toMatchObject({ prompt: '로그인 버튼을 가운데로' });
      await expect.poll(() => service.read().agents).toEqual([{ sessionId: sampleSession.id, scopeId }, { sessionId: 'new-1', scopeId }]);

      await coding.showApproval();
      const rows = await list();
      const row = rows.getByRole('listitem').filter({ hasText: sampleSession.title });
      await expect(row.locator('.workbench-attention')).toHaveAttribute('data-signal', 'waiting');
      await expect(row.locator('.workbench-agent-question')).toHaveText('도구 실행 확인');
      await expect(rows.locator('.workbench-space-row .workbench-attention')).toHaveAttribute('data-signal', 'waiting');
      await coding.patch({ state: 'idle', pendingDialog: null, updatedAt: sampleSession.updatedAt + 1 });
      await expect(row.locator('.workbench-attention')).toHaveAttribute('data-signal', 'done');

      await row.getByTitle(sampleSession.title, { exact: true }).click();
      await expect(existing).toBeVisible();
      await expect(created).toBeHidden();
      await expect(row.locator('.workbench-attention')).toHaveCount(0);
      await expect.poll(() => service.read().focus).toEqual({ scopeId, sessionId: sampleSession.id });

      if (!phone) {
        // ⌘/Ctrl-click opens beside; the border resizes from the keyboard.
        await page.getByRole('navigation', { name: '프로젝트', exact: true }).getByTitle('새 작업 트리', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
        await expect(existing).toBeVisible();
        await expect(created).toBeVisible();
        const border = page.getByRole('separator', { name: '패널 너비' });
        await expect(border).toHaveAttribute('aria-valuenow', '50');
        await border.focus();
        await page.keyboard.press('ArrowRight');
        await expect(border).toHaveAttribute('aria-valuenow', '55');
        // The project list folds to a strip of state marks and back.
        await page.keyboard.press('ControlOrMeta+b');
        await expect(page.getByRole('navigation', { name: '프로젝트', exact: true })).toHaveCount(0);
        const strip = page.getByRole('complementary', { name: '작업대 탐색' });
        await expect(strip.getByRole('button', { name: sampleSession.title })).toBeVisible();
        if (evidence) await page.screenshot({ path: join(evidence, `folded-${width}.png`), animations: 'disabled', caret: 'hide' });
        await strip.getByRole('button', { name: '목록 펼치기' }).click();
        await expect(page.getByRole('navigation', { name: '프로젝트', exact: true })).toBeVisible();
      }

      await page.reload();
      await expect(existing).toBeVisible();
      if (!phone) await expect(created).toBeVisible();
      if (evidence) await page.screenshot({ path: join(evidence, `workbench-${width}.png`), animations: 'disabled', caret: 'hide' });
    });
  });
}

test('a new project starts from one line and a chosen folder names it', async ({ page }) => {
  await mockWorkbench(page);
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/commands', async route => {
    const { command } = route.request().postDataJSON() as { command: Record<string, unknown> };
    if (command.type !== 'scope.create') return route.fallback();
    commands.push(command);
    await route.fulfill({ json: { ok: true, result: { scopeId: 'fresh-project' } } });
  });
  await page.route('**/api/folders**', route => route.fulfill({ json: { path: tmpdir(), parent: null, home: tmpdir(), shortcuts: [], truncated: false, entries: [] } }));
  await openScreen(page, { name: 'workbench project', route: () => '/coding', waits: () => ['새 에이전트'] }, 'light');
  await page.getByRole('complementary', { name: '작업대 탐색' }).getByRole('button', { name: '새 프로젝트', exact: true }).click();
  await page.getByRole('button', { name: '폴더 선택' }).click();
  await page.getByRole('button', { name: '이 폴더 선택' }).click();
  await page.getByRole('textbox', { name: '새 프로젝트 이름' }).press('Enter');
  await expect.poll(() => commands[0]).toMatchObject({ type: 'scope.create', name: tmpdir().split('/').pop(), paths: [tmpdir()] });
});

test('folds agents idle for days and lists them on request', async ({ page }) => {
  const { scopeId } = readRunState();
  const coding = await mockCodingSessions(page);
  const { service } = await mockWorkbench(page, [{ cwd: tmpdir() }]);
  service.addAgent({ version: 0, sessionId: sampleSession.id, scopeId });
  service.addAgent({ version: 1, sessionId: 'new-1', scopeId });
  await coding.patch({ state: 'idle', updatedAt: sampleSession.updatedAt + 1 });
  await openScreen(page, {
    name: 'workbench fold', route: () => '/coding', waits: () => ['이전 에이전트 1개'],
    prepare: page => page.clock.setFixedTime(new Date(sampleSession.updatedAt + 4 * DAY)),
  }, 'light');
  const agents = page.getByRole('list', { name: '에이전트' });
  await expect(agents.getByTitle(sampleSession.title, { exact: true })).toHaveCount(0);
  await agents.getByRole('button', { name: '이전 에이전트 1개' }).click();
  await agents.getByTitle(sampleSession.title, { exact: true }).click();
  await expect(agentPane(page, sampleSession.title)).toBeVisible();
});

test('right-click renames an agent in place or deletes it from the list', async ({ page }) => {
  const { scopeId } = readRunState();
  const coding = await mockCodingSessions(page);
  const { service } = await mockWorkbench(page);
  service.addAgent({ version: 0, sessionId: sampleSession.id, scopeId });
  await openScreen(page, { name: 'workbench menu', route: () => '/coding', waits: () => [sampleSession.title] }, 'light');
  const row = page.getByRole('list', { name: '에이전트' }).locator('.workbench-agent-row').first();
  await row.click({ button: 'right' });
  await page.getByRole('menu', { name: '에이전트 메뉴' }).getByRole('menuitem', { name: '이름 바꾸기' }).click();
  const field = row.getByRole('textbox', { name: '에이전트 이름' });
  await field.fill('새 이름');
  await field.press('Enter');
  await expect.poll(() => coding.patches.at(-1)).toEqual({ title: '새 이름' });
  await row.click({ button: 'right' });
  await page.getByRole('menu', { name: '에이전트 메뉴' }).getByRole('menuitem', { name: '목록에서 삭제' }).click();
  await page.getByRole('dialog', { name: '에이전트 삭제' }).getByRole('button', { name: '삭제', exact: true }).click();
  await expect.poll(() => service.read().agents).toEqual([]);
});

test('a Ghost’s agent shows with its face and can be opened without listing it', async ({ page }) => {
  const { researchGhostId } = readRunState();
  await mockCodingSessions(page);
  const ghostSession: CodingSession = { ...sampleSession, id: 'ghost-run', title: '경쟁사 조사 스크립트', ghostId: researchGhostId, cwd: '/nowhere', repo: null, state: 'working' };
  await page.route('**/api/coding/sessions', route => route.request().method() === 'GET'
    ? route.fulfill({ json: [sampleSession, ghostSession] }) : route.fallback());
  const { service } = await mockWorkbench(page);
  await openScreen(page, { name: 'workbench ghost', route: () => '/coding', waits: () => ['새 에이전트'] }, 'light');
  await page.getByRole('navigation', { name: '프로젝트', exact: true }).getByRole('button', { name: '프로젝트 없음' }).click();
  const row = page.getByRole('list', { name: '에이전트' }).getByRole('listitem').filter({ hasText: ghostSession.title });
  await expect(row.locator('.workbench-ghost')).toBeVisible();
  await row.getByTitle(ghostSession.title, { exact: true }).click();
  await expect(agentPane(page, ghostSession.title).locator('.workbench-ghost')).toBeVisible();
  expect(service.read().agents).toEqual([]);
});

for (const width of [1440, 390]) {
  test.describe(`${width}px 터미널`, () => {
    const phone = width === 390;
    test.use({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
    test('opens a shell only on request, keeps it when hidden and ends it on request', async ({ page }) => {
      const folder = mkdtempSync(join(tmpdir(), 'ghost-terminal-e2e-'));
      const coding = await mockCodingSessions(page);
      await page.route('**/api/coding/sessions', route => route.request().method() === 'GET'
        ? route.fulfill({ json: [{ ...sampleSession, cwd: folder, state: 'idle' }] }) : route.fallback());
      const { service } = await mockWorkbench(page, coding.creates);
      service.addAgent({ version: 0, sessionId: sampleSession.id, scopeId: null });
      await openScreen(page, { name: 'workbench terminal', route: () => '/coding', waits: () => [sampleSession.title] }, 'light');
      const terminal = page.locator('section.workbench-terminal');
      await expect(terminal).toHaveCount(0);
      const toggle = page.getByRole('button', { name: '터미널', exact: true }).filter({ visible: true }).first();
      await toggle.click();
      await expect(terminal.getByRole('textbox', { name: '터미널 입력' })).toBeVisible();
      // A login shell reads the owner's rc files first; keep typing until it answers.
      await expect(async () => {
        await terminal.getByRole('textbox', { name: '터미널 입력' }).focus();
        await page.keyboard.type('echo ghost-$((20+22))\n');
        await expect(terminal).toContainText('ghost-42', { timeout: 2500 });
      }).toPass({ timeout: 30_000 });
      const evidence = process.env.GHOST_WORKBENCH_EVIDENCE_DIR;
      if (evidence) await page.screenshot({ path: join(evidence, `terminal-${width}.png`), animations: 'disabled', caret: 'hide' });
      await terminal.getByRole('button', { name: '터미널 숨기기' }).click();
      await expect(terminal).toHaveCount(0);
      await toggle.click();
      await expect(terminal).toContainText('ghost-42');
      await terminal.getByRole('button', { name: '터미널 종료' }).click();
      await expect(terminal).toHaveCount(0);
      await toggle.click();
      await expect(terminal.getByRole('textbox', { name: '터미널 입력' })).toBeVisible();
      await expect(terminal).not.toContainText('ghost-42');
    });
  });
}
