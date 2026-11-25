import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { mockCodingSessions, sampleSession } from './coding-session-mock';
import { openScreen } from './visual';

import { mockWorkbench } from './workbench-mock';

for (const width of [1440, 390]) {
  test.describe(`${width}px 작업대`, () => {
    const phone = width === 390;
    test.use({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
    test('lists agents in a space, keeps their state and focus, and closes one without closing its session', async ({ page }) => {
      const coding = await mockCodingSessions(page);
      const { service } = await mockWorkbench(page, coding.creates);
      await openScreen(page, { name: 'workbench', route: () => '/coding', waits: () => ['스페이스 만들기'] }, 'light');
      await page.getByRole('button', { name: '새 스페이스' }).click();
      await page.getByRole('textbox', { name: '이름' }).fill('Ghost 저장소');
      await page.route('**/api/folders**', route => route.fulfill({ json: { path: tmpdir(), parent: null, home: tmpdir(), shortcuts: [], truncated: false, entries: [] } }));
      await page.getByRole('button', { name: '작업 폴더 (선택): 선택 안 함' }).click();
      await page.getByRole('button', { name: '이 폴더 선택' }).click();
      await page.getByRole('button', { name: '저장', exact: true }).click();

      // The list lives in the rail on a desktop and in the space popover on a phone.
      const list = async () => {
        if (phone) await page.getByRole('button', { name: /^스페이스: Ghost 저장소/ }).click();
        return page.getByRole('navigation', { name: '스페이스', exact: true });
      };
      await page.locator('.workbench-main').getByRole('button', { name: '이전 세션 열기' }).click();
      await page.getByRole('dialog', { name: '이전 세션 열기' }).getByRole('button', { name: sampleSession.title, exact: true }).click();
      const existing = page.getByRole('region', { name: `에이전트: ${sampleSession.title}`, exact: true });
      await expect(existing).toHaveAttribute('data-focused', 'true');
      expect(service.read().agents).toHaveLength(1);

      if (phone) await page.locator('.workbench-compact-head').getByRole('button', { name: '새 에이전트' }).click();
      else await page.getByRole('button', { name: '새 에이전트', exact: true }).click();
      const start = page.getByRole('dialog', { name: '새 에이전트', exact: true });
      if (phone) await start.getByRole('checkbox', { name: '별도 worktree에서 작업' }).uncheck();
      await start.getByRole('button', { name: '시작', exact: true }).click();
      const created = page.getByRole('region', { name: '에이전트: 새 작업 트리', exact: true });
      await expect(created).toHaveAttribute('data-focused', 'true');
      await expect(existing).not.toBeVisible();
      expect(coding.creates[0]).toMatchObject(phone ? { cwd: tmpdir() } : { repo: tmpdir() });

      await coding.showApproval();
      const rows = await list();
      const row = rows.getByRole('listitem').filter({ hasText: sampleSession.title });
      await expect(row.locator('.workbench-attention')).toHaveAttribute('data-signal', 'waiting');
      await expect(rows.locator('.workbench-space-row .workbench-attention')).toHaveAttribute('data-signal', 'waiting');
      await coding.patch({ state: 'idle', pendingDialog: null, updatedAt: sampleSession.updatedAt + 1 });
      await expect(row.locator('.workbench-attention')).toHaveAttribute('data-signal', 'done');

      await row.getByTitle(sampleSession.title, { exact: true }).click();
      await expect(existing).toHaveAttribute('data-focused', 'true');
      await expect(created).not.toBeVisible();
      await expect(row.locator('.workbench-attention')).toHaveCount(0);
      const saved = service.read();
      expect(saved.agents.map(agent => agent.sessionId)).toEqual([sampleSession.id, 'new-1']);
      expect(saved.focus?.sessionId).toBe(sampleSession.id);
      await page.reload();
      await expect(existing).toHaveAttribute('data-focused', 'true');
      expect(service.read()).toEqual(saved);
      const evidence = process.env.GHOST_WORKBENCH_EVIDENCE_DIR;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `workbench-${width}.png`), animations: 'disabled', caret: 'hide' });
      }

      const closing = (await list()).getByRole('listitem').filter({ hasText: sampleSession.title });
      await closing.getByRole('button', { name: `${sampleSession.title} 닫기` }).click();
      await expect(existing).toHaveCount(0);
      expect(service.read().agents.map(agent => agent.sessionId)).toEqual(['new-1']);
      expect(service.read().focus?.sessionId).toBe('new-1');
    });
  });
}

test('a chosen folder names the space when the name is left empty', async ({ page }) => {
  const { service } = await mockWorkbench(page);
  await openScreen(page, { name: 'workbench', route: () => '/coding', waits: () => ['스페이스 만들기'] }, 'light');
  await page.route('**/api/folders**', route => route.fulfill({ json: { path: tmpdir(), parent: null, home: tmpdir(), shortcuts: [], truncated: false, entries: [] } }));
  await page.getByRole('button', { name: '새 스페이스' }).click();
  const save = page.getByRole('button', { name: '저장', exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: '작업 폴더 (선택): 선택 안 함' }).click();
  await page.getByRole('button', { name: '이 폴더 선택' }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => service.read().spaces.map(space => space.title)).toEqual([tmpdir().split('/').pop()]);
});

test('folds agents idle for days and lists them on request', async ({ page }) => {
  const coding = await mockCodingSessions(page);
  const { service } = await mockWorkbench(page, [{ cwd: tmpdir() }]);
  const space = service.createSpace({ version: 0, title: '정리', root: null }).spaces[0]!;
  service.addAgent(space.id, { version: 1, sessionId: sampleSession.id });
  service.addAgent(space.id, { version: 2, sessionId: 'new-1' });
  await coding.patch({ state: 'idle', updatedAt: sampleSession.updatedAt + 1 });
  await openScreen(page, {
    name: 'workbench fold', route: () => '/coding', waits: () => ['이전 에이전트 1개'],
    prepare: page => page.clock.setFixedTime(new Date(sampleSession.updatedAt + 4 * 24 * 60 * 60 * 1000)),
  }, 'light');
  const agents = page.getByRole('list', { name: '에이전트' });
  await expect(agents.getByTitle(sampleSession.title, { exact: true })).toHaveCount(0);
  await agents.getByRole('button', { name: '이전 에이전트 1개' }).click();
  await expect(agents.getByTitle(sampleSession.title, { exact: true })).toBeVisible();
  await agents.getByTitle(sampleSession.title, { exact: true }).click();
  await expect(page.getByRole('region', { name: `에이전트: ${sampleSession.title}`, exact: true })).toHaveAttribute('data-focused', 'true');
});

test('right-click on an agent renames it or deletes it from the list', async ({ page }) => {
  const coding = await mockCodingSessions(page);
  const { service } = await mockWorkbench(page);
  const space = service.createSpace({ version: 0, title: '메뉴', root: null }).spaces[0]!;
  service.addAgent(space.id, { version: 1, sessionId: sampleSession.id });
  await openScreen(page, { name: 'workbench menu', route: () => '/coding', waits: () => [sampleSession.title] }, 'light');
  const row = page.getByRole('list', { name: '에이전트' }).locator('.workbench-agent-row').first();
  await row.click({ button: 'right' });
  await page.getByRole('menu', { name: '에이전트 메뉴' }).getByRole('menuitem', { name: '이름 바꾸기' }).click();
  await page.getByRole('textbox', { name: '이름' }).fill('새 이름');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => coding.patches.at(-1)).toEqual({ title: '새 이름' });
  await row.click({ button: 'right' });
  await page.getByRole('menu', { name: '에이전트 메뉴' }).getByRole('menuitem', { name: '삭제' }).click();
  await page.getByRole('dialog', { name: '에이전트 삭제' }).getByRole('button', { name: '삭제', exact: true }).click();
  await expect.poll(() => service.read().agents).toEqual([]);
});

for (const width of [1440, 390]) {
  test.describe(`${width}px 터미널`, () => {
    const phone = width === 390;
    test.use({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
    test('opens a shell only on request, keeps it when hidden and ends it on request', async ({ page }) => {
      const folder = mkdtempSync(join(tmpdir(), 'ghost-terminal-e2e-'));
      const { service } = await mockWorkbench(page);
      service.createSpace({ version: 0, title: '셸', root: folder });
      await openScreen(page, { name: 'workbench terminal', route: () => '/coding', waits: () => ['새 에이전트'] }, 'light');
      const terminal = page.locator('section.workbench-terminal');
      await expect(terminal).toHaveCount(0);
      const toggle = page.getByRole('button', { name: '터미널', exact: true });
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
