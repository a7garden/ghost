import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
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
const rail = (page: Page) => page.getByRole('complementary', { name: '작업대 탐색' });
const sidebar = (page: Page) => page.getByRole('complementary', { name: '작업실 탐색' });

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
      const dock = page.getByRole('navigation', { name: '주요 화면' });
      const list = async () => {
        if (phone && !await rail(page).isVisible()) await page.getByRole('navigation', { name: '위치' }).getByRole('button', { name: '뒤로', exact: true }).click();
        return rail(page);
      };
      if (phone) {
        await expect(dock).toBeVisible();
        await expect(existing).toBeHidden();
        await expect(page.getByRole('textbox', { name: '코딩 지시' })).toHaveCount(0);
        await rail(page).getByTitle(sampleSession.title, { exact: true }).click();
        await expect(dock).toBeHidden();
      }
      await expect(existing).toBeVisible();

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
      const pending = page.getByRole('complementary', { name: '작업대 탐색' }).getByRole('button', { name: /^확인 필요 1$/ });
      await expect(row.locator('.workbench-state')).toHaveAttribute('data-state', 'attention');
      await expect(row.locator('.workbench-agent-question')).toBeVisible();
      await pending.click();
      await expect(existing).toBeVisible();
      await expect(page.locator('.workbench-pane__head[data-waiting]').filter({ visible: true })).toBeVisible();
      await (await list()).getByTitle('새 작업 트리', { exact: true }).click();
      await expect(created).toBeVisible();
      await list();
      await coding.patch({ state: 'idle', pendingDialog: null, updatedAt: sampleSession.updatedAt + 1 });
      await expect(row.locator('.workbench-state')).toHaveAttribute('data-state', 'done');
      await expect(pending).toHaveCount(0);

      await row.getByTitle(sampleSession.title, { exact: true }).click();
      await expect(existing).toBeVisible();
      await expect(created).toBeHidden();
      await expect(page.locator('.workbench-pane__head .workbench-state').filter({ visible: true })).toHaveAttribute('data-state', 'queued');
      await expect.poll(() => service.read().focus).toEqual({ scopeId, sessionId: sampleSession.id });

      if (!phone) {
        // ⌘/Ctrl-click opens beside; the border resizes from the keyboard.
        await rail(page).getByTitle('새 작업 트리', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
        await expect(existing).toBeVisible();
        await expect(created).toBeVisible();
        const border = page.getByRole('separator', { name: '패널 너비' });
        await expect(border).toHaveAttribute('aria-valuenow', '50');
        await border.focus();
        await page.keyboard.press('ArrowRight');
        await expect(border).toHaveAttribute('aria-valuenow', '55');
        // The agent list folds to a strip of state marks and back.
        await page.keyboard.press('ControlOrMeta+b');
        const strip = rail(page);
        await expect(strip.getByRole('list', { name: '에이전트' })).toHaveCount(0);
        await expect(strip.getByRole('button', { name: sampleSession.title })).toBeVisible();
        if (evidence) await page.screenshot({ path: join(evidence, `folded-${width}.png`), animations: 'disabled', caret: 'hide' });
        await strip.getByRole('button', { name: '목록 펼치기' }).click();
        await expect(rail(page).getByRole('list', { name: '에이전트' })).toBeVisible();
        await page.keyboard.press('ControlOrMeta+\\');
        await expect(sidebar(page)).toBeHidden();
        await expect(rail(page).getByRole('list', { name: '에이전트' })).toBeVisible();
        await page.keyboard.press('ControlOrMeta+\\');
        await expect(sidebar(page)).toBeVisible();
      }

      await page.reload();
      await expect(existing).toBeVisible();
      if (!phone) {
        await expect(created).toBeVisible();
        await expect(page.getByRole('separator', { name: '패널 너비' })).toHaveAttribute('aria-valuenow', '55');
      }
      if (evidence) await page.screenshot({ path: join(evidence, `workbench-${width}.png`), animations: 'disabled', caret: 'hide' });
    });
  });
}

test('opens an agent that needs attention even from another project', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { scopeId } = readRunState();
  const coding = await mockCodingSessions(page);
  const { service } = await mockWorkbench(page);
  service.addAgent({ version: 0, sessionId: sampleSession.id, scopeId });
  service.focus({ version: 1, scopeId: null });
  await coding.patch({ state: 'failed' });
  await openScreen(page, { name: 'workbench attention', route: () => '/coding', waits: () => ['새 에이전트'] }, 'light');
  await page.getByRole('complementary', { name: '작업대 탐색' }).getByRole('button', { name: /^확인 필요 1$/ }).click();
  await expect(agentPane(page, sampleSession.title)).toBeVisible();
  await expect(page).toHaveURL(url => url.hash === `#/coding/${scopeId}?session=${sampleSession.id}`);
  await expect.poll(() => service.read().focus).toEqual({ scopeId, sessionId: sampleSession.id });
});

test('switches projects from the sidebar and lists a newly created project without another setup', async ({ page, request }) => {
  const coding = await mockCodingSessions(page);
  const { service } = await mockWorkbench(page, coding.creates);
  const { baseUrl, scopeId } = readRunState();
  const { token } = JSON.parse(readFileSync(join(process.env.GHOST_VISUAL_RUN_ROOT!, 'primary/host/host.json'), 'utf8')) as { token: string };
  service.addAgent({ version: 0, sessionId: sampleSession.id, scopeId });
  await openScreen(page, { name: 'workbench project', route: () => '/coding', waits: () => [sampleSession.title] }, 'light');
  const projects = sidebar(page);
  await expect(projects.getByRole('button', { name: '비행 기록', exact: true })).toHaveCount(1);
  await expect(rail(page).getByRole('link', { name: '비행 기록' })).toHaveAttribute('href', `#/scopes/${scopeId}`);
  await expect(rail(page).getByRole('link', { name: '프로젝트 설정' })).toHaveAttribute('href', `#/scopes/${scopeId}?view=settings`);
  await expect(rail(page).getByRole('button', { name: 'git 변경' })).toBeVisible();
  for (const name of ['오케스트레이션', '하네스 가져오기', '새 프로젝트', '프로젝트 목록']) {
    await expect(rail(page).getByText(name, { exact: true })).toHaveCount(0);
  }
  await projects.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  await expect(page).toHaveURL(/#\/scopes\?new=1$/);
  await page.getByRole('textbox', { name: '프로젝트 이름' }).fill('새 작업대 프로젝트');
  const created = page.waitForResponse(response => response.url().endsWith('/api/commands') && response.request().postDataJSON()?.command?.type === 'scope.create');
  await page.getByRole('form', { name: '새 프로젝트' }).getByRole('button', { name: '저장', exact: true }).click();
  const result = await (await created).json();
  expect(result.ok).toBe(true);
  const newId = result.result.scopeId as string;
  try {
    await expect(page).toHaveURL(url => url.hash === `#/scopes/${newId}`);
    await projects.getByRole('button', { name: '코딩', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === `#/coding/${scopeId}`);
    await projects.getByRole('button', { name: '새 작업대 프로젝트', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === `#/coding/${newId}`);
    await expect(rail(page).getByRole('link', { name: '새 작업대 프로젝트' })).toBeVisible();
    await expect(rail(page).getByTitle(sampleSession.title, { exact: true })).toHaveCount(0);
    await expect.poll(() => service.read().focus?.scopeId).toBe(newId);
    await projects.getByRole('button', { name: '비행 기록', exact: true }).click();
    await expect(agentPane(page, sampleSession.title)).toBeVisible();
  } finally {
    const cleanup = await request.post(`${baseUrl}/api/commands`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { requestId: randomUUID(), command: { type: 'scope.delete', scopeId: newId } },
    });
    expect(cleanup.ok()).toBe(true);
  }
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
  await sidebar(page).getByRole('button', { name: '프로젝트 없음', exact: true }).click();
  await expect(page).toHaveURL(/#\/coding\/-$/);
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
      if (phone) await rail(page).getByTitle(sampleSession.title, { exact: true }).click();
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
