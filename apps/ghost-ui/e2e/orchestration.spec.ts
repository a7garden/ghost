import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestrationConfig } from '@ghost/contract';
import { readRunState } from './run-state';
import { mockCodingSessions } from './coding-session-mock';

for (const width of [1440, 390]) {
  test.describe(`${width}px orchestration`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
    test('edits the graph against the Host, persists positions, previews import and shows session SSE activity', async ({ page, request }) => {
      const { baseUrl } = readRunState();
      const endpoint = `${baseUrl}/api/orchestration/config`;
      const { token } = JSON.parse(readFileSync(join(process.env.GHOST_VISUAL_RUN_ROOT!, 'primary/host/host.json'), 'utf8')) as { token: string };
      const headers = { Authorization: `Bearer ${token}` };
      const read = async () => (await (await request.get(endpoint, { headers })).json()).config as OrchestrationConfig;
      const original = await read();
      const write = (config: OrchestrationConfig) => request.put(endpoint, { data: config, headers });
      const seeded = structuredClone(original);
      seeded.enabled = true;
      seeded.limits.maxDepth = 3;
      seeded.modelRoles.code = { provider: 'faux', model: 'faux-coder', thinking: 'high' };
      seeded.modelRoles.backup = { provider: 'faux', model: 'faux-small', thinking: 'low' };
      seeded.fallbackChains.code = [{ role: 'backup' }, { role: 'session' }];
      seeded.agents.find(agent => agent.name === 'reviewer')!.canDelegateTo = ['scout'];
      const sessions = await mockCodingSessions(page);
      const active = { id: 'visible-scout', at: Date.now() - 6000, kind: 'subagent', role: 'scout', task: '흐름 확인', status: 'running', summary: '' } as const;
      // Fixture-only import: automated browser coverage never reads the developer's real omp files.
      await page.route('**/api/orchestration/import-omp', route => route.fulfill({ json: { config: { ...seeded, enabled: false }, unmappable: ['retry.fallbackChains.legacy/*'], issues: [] } }));
      try {
        expect((await write(seeded)).ok()).toBe(true);
        await page.goto(`${baseUrl}/#/coding/orchestration`);
        await expect(page.getByRole('heading', { name: '오케스트레이션' })).toBeVisible();
        await sessions.patch({ state: 'working' });
        await sessions.item(active);
        const activeNode = page.locator('[data-agent="scout"]');
        await expect(activeNode).toContainText('실행 중');
        const captures = process.env.GHOST_ORCHESTRATION_EVIDENCE;
        if (captures) await page.screenshot({ path: join(captures, `orchestration-${width}.png`), animations: 'disabled' });
        await sessions.item({ ...active, status: 'done', summary: '흐름 확인 완료' });
        await expect(activeNode).toContainText('완료');
        await page.getByRole('button', { name: '에이전트', exact: true }).click();
        await page.getByRole('textbox', { name: '이름', exact: true }).fill('display-reader');
        await page.getByRole('textbox', { name: '이름', exact: true }).press('Enter');
        await page.getByRole('textbox', { name: '설명' }).fill('로그 읽기');
        const added = page.locator('[data-agent="display-reader"]');
        if (width === 1440) {
          const node = page.locator('[data-agent="scout"]');
          await node.scrollIntoViewIfNeeded();
          const at = await node.boundingBox();
          expect(at).not.toBeNull();
          await page.mouse.move(at!.x + 20, at!.y + 20); await page.mouse.down();
          await page.mouse.move(at!.x + 50, at!.y + 39, { steps: 4 }); await page.mouse.up();
          const port = page.getByRole('button', { name: 'scout에서 위임 연결' });
          await port.dragTo(page.locator('[data-agent="worker"]'));
          await expect(page.locator('[data-edge="delegate"]')).toHaveCount(2);
          await page.getByRole('button', { name: 'code faux-coder' }).click();
          const grip = page.locator('.orchestration-grip').first();
          await grip.dragTo(page.locator('.orchestration-chain li').nth(1));
          await expect(page.locator('.orchestration-chain li').first()).toContainText('@session');
          if (captures) await page.screenshot({ path: join(captures, 'orchestration-fallback-order.png'), animations: 'disabled' });
        } else {
          expect(await page.locator('.orchestration').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
          await added.focus(); await added.press('ArrowRight');
          expect(await page.locator('.orchestration').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        }
        await page.getByRole('button', { name: '저장', exact: true }).click();
        await expect(page.getByText('저장됨')).toBeVisible();
        const persisted = await read();
        expect(persisted.agents.find(agent => agent.name === 'display-reader')?.description).toBe('로그 읽기');
        if (width === 1440) {
          expect(persisted.positions.agents.scout).toBeDefined();
          expect(persisted.agents.find(agent => agent.name === 'scout')?.canDelegateTo).toContain('worker');
        } else expect(persisted.positions.agents['display-reader']).toBeDefined();
        await page.getByRole('button', { name: 'omp 가져오기' }).click();
        await expect(page.getByRole('region', { name: 'omp 가져오기 미리보기' })).toBeVisible();
        await expect(page.getByRole('switch', { name: '위임 사용' })).not.toBeChecked();
        expect((await read()).enabled).toBe(true);
        await page.getByRole('button', { name: '미리보기 닫기' }).click();
        await page.getByRole('switch', { name: '위임 사용' }).uncheck();
        await page.getByRole('button', { name: '저장', exact: true }).click();
        await expect(page.getByText('저장됨')).toBeVisible();
        await page.reload();
        await expect(page.getByRole('switch', { name: '위임 사용' })).not.toBeChecked();
      } finally { await write(original); }
    });
  });
}
