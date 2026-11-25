import { mkdirSync } from 'node:fs';
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
        if (phone) await page.getByRole('button', { name: '스페이스: Ghost 저장소' }).click();
        return page.getByRole('navigation', { name: '스페이스', exact: true });
      };
      await page.locator('.workbench-main').getByRole('button', { name: '에이전트 추가' }).click();
      await page.getByRole('dialog', { name: '에이전트 추가' }).getByRole('button', { name: sampleSession.title, exact: true }).click();
      const existing = page.getByRole('region', { name: `에이전트: ${sampleSession.title}`, exact: true });
      await expect(existing).toHaveAttribute('data-focused', 'true');
      expect(service.read().agents).toHaveLength(1);

      await list();
      await page.getByRole('button', { name: '에이전트 추가' }).click();
      await page.getByRole('dialog', { name: '에이전트 추가' }).getByRole('button', { name: '새 에이전트', exact: true }).click();
      const start = page.getByRole('dialog', { name: '새 에이전트', exact: true });
      if (phone) await start.getByRole('checkbox', { name: '별도 worktree에서 작업' }).uncheck();
      await start.getByRole('button', { name: '시작', exact: true }).click();
      const created = page.getByRole('region', { name: '에이전트: 새 작업 트리', exact: true });
      await expect(created).toHaveAttribute('data-focused', 'true');
      await expect(existing).not.toBeVisible();
      expect(coding.creates[0]).toMatchObject(phone ? { cwd: tmpdir() } : { repo: tmpdir() });
      await expect(page.getByRole('button', { name: /터미널|패널|탭/ })).toHaveCount(0);

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
