import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestrationConfig } from '@ghost/contract';
import { readRunState } from './run-state';
import { mockCodingSessions } from './coding-session-mock';

for (const width of [1440, 390]) {
  test.describe(`${width}px orchestration`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
    test('edits the graph against the Host, persists positions, selectively imports a harness and shows session SSE activity', async ({ page, request }) => {
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
      // Fixture-only import: automated browser coverage never reads the developer's real harness files.
      const auditor = { name: 'omp-auditor', description: 'omp 검토', modelRole: 'code', instructions: 'OMP_AUDIT', tools: ['read' as const], readOnly: true, canDelegateTo: [] };
      const explorer = { name: 'codex-explorer', description: 'Codex 탐색', modelRole: 'code', instructions: 'CODEX_EXPLORE', tools: ['read' as const], readOnly: true, canDelegateTo: [] };
      const sources = { sources: [
        { source: 'omp', label: 'omp', available: true, agents: 2 },
        { source: 'claude', label: 'Claude Code', available: false, agents: 0 },
        { source: 'codex', label: 'Codex', available: true, agents: 1 },
      ] };
      const previewFor = (source: string) => source === 'codex'
        ? { config: { ...structuredClone(seeded), agents: [...structuredClone(seeded.agents), explorer] }, unmappable: [], issues: [] }
        : { config: { ...structuredClone(seeded), agents: [...structuredClone(seeded.agents), auditor],
            fallbackChains: { ...structuredClone(seeded.fallbackChains), code: [{ provider: 'faux', model: 'faux-tiny', thinking: null }] },
            limits: { maxConcurrency: 7, maxDepth: 5 } }, unmappable: ['retry.fallbackChains.legacy/*'], issues: [] };
      await page.route('**/api/orchestration/import', route => route.request().method() === 'GET'
        ? route.fulfill({ json: sources })
        : route.fulfill({ json: previewFor(route.request().postDataJSON().source as string) }));
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
        await page.getByRole('button', { name: '하네스 가져오기' }).click();
        const panel = page.getByRole('region', { name: '하네스 가져오기' });
        await expect(panel.getByRole('radio', { name: 'omp · 에이전트 2개' })).toBeChecked();
        await panel.getByRole('radio', { name: 'Codex · 에이전트 1개' }).check();
        await expect(panel.getByRole('checkbox', { name: '에이전트 codex-explorer' })).toBeVisible();
        await panel.getByRole('radio', { name: 'omp · 에이전트 2개' }).check();
        await panel.getByText('가져오기 확인 사항 (1)').click();
        await expect(panel).toContainText('retry.fallbackChains.legacy/*');
        await panel.getByRole('checkbox', { name: '실행 한도' }).uncheck();
        await panel.getByRole('checkbox', { name: '대체 모델 code' }).uncheck();
        await panel.getByRole('button', { name: '편집에 반영' }).click();
        await expect(panel).toBeHidden();
        await expect(page.locator('[data-agent="omp-auditor"]')).toBeVisible();
        expect((await read()).agents.find(agent => agent.name === 'omp-auditor')).toBeUndefined();
        await page.getByRole('button', { name: '저장', exact: true }).click();
        await expect(page.getByText('저장됨')).toBeVisible();
        const imported = await read();
        expect(imported.agents.find(agent => agent.name === 'omp-auditor')?.description).toBe('omp 검토');
        expect(imported.limits.maxDepth).toBe(3);
        // The unchecked chain keeps what the draft had before the import, including a reorder made above.
        expect(imported.fallbackChains.code).toEqual(persisted.fallbackChains.code);
        await page.getByRole('switch', { name: '위임 사용' }).uncheck();
        await page.getByRole('button', { name: '저장', exact: true }).click();
        await expect(page.getByText('저장됨')).toBeVisible();
        await page.reload();
        await expect(page.getByRole('switch', { name: '위임 사용' })).not.toBeChecked();
      } finally { await write(original); }
    });

    test('opens the import panel from the ?import=1 query and closes it in place', async ({ page }) => {
      const { baseUrl } = readRunState();
      const imported = { name: 'omp-auditor', description: 'omp 검토', modelRole: 'session', instructions: '', tools: ['read' as const], readOnly: true, canDelegateTo: [] };
      await page.route('**/api/orchestration/import', route => route.request().method() === 'GET'
        ? route.fulfill({ json: { sources: [{ source: 'omp', label: 'omp', available: true, agents: 2 }] } })
        : route.fulfill({ json: { config: {
            enabled: true, modelRoles: { session: { provider: null, model: null, thinking: null } }, fallbackChains: {},
            limits: { maxConcurrency: 4, maxDepth: 1 }, agents: [imported], positions: { agents: {}, roles: {} },
          }, unmappable: [], issues: [] } }));
      await page.goto(`${baseUrl}/#/coding/orchestration?import=1`);
      const panel = page.getByRole('region', { name: '하네스 가져오기' });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('radio', { name: 'omp · 에이전트 2개' })).toBeChecked();
      await panel.getByRole('button', { name: '닫기' }).click();
      await expect(panel).toBeHidden();
      await expect(page).toHaveURL(/#\/coding\/orchestration$/);
    });
  });
}
