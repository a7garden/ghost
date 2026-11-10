import { test, expect, type Page } from '@playwright/test';
import type { Command, Ghost, State } from '@ghost/contract';
import { readRunState } from './run-state';

async function send(page: Page, command: Command): Promise<Record<string, unknown>> {
  return page.evaluate(async command => {
    const response = await fetch('/api/commands', {
      method: 'POST', headers: { authorization: `Bearer ${window.__GHOST_TOKEN__}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), command }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(JSON.stringify(body));
    return body.result;
  }, command);
}

async function storedGhost(page: Page, id: string): Promise<Ghost> {
  return page.evaluate(async id => {
    const response = await fetch('/api/state', { headers: { authorization: `Bearer ${window.__GHOST_TOKEN__}` } });
    const state: State = await response.json();
    const ghost = state.ghosts.find(ghost => ghost.id === id);
    if (!ghost) throw new Error('test Ghost missing');
    return ghost;
  }, id);
}

test.describe('Ghost model route', () => {
  let ghostId: string;
  let extraGhostIds: string[] = [];
  const provider = 'settings_test';
  const ref = (model: string) => ({ provider, model });

  test.beforeEach(async ({ page }) => {
    extraGhostIds = [];
    await page.goto(`${readRunState().baseUrl}/#/settings?tab=team`);
    await expect(page.getByRole('button', { name: '새 Ghost', exact: true })).toBeVisible();
    await send(page, { type: 'provider.upsert', id: provider, kind: 'openai_compatible', name: 'Settings test',
      baseUrl: `http://127.0.0.1:${readRunState().mockPort}/v1`, apiKey: 'test-only',
      models: ['Alpha', 'Beta', 'Gamma', 'Delta'].map(id => ({ id, name: id, contextWindow: 32000 })),
    });
    const created = await send(page, { type: 'ghost.create', name: '모델 경로 검증용', persona: '합성 설정 검증 자료입니다.', model: ref('Alpha'), fallbacks: [ref('Beta'), ref('Gamma')] });
    ghostId = String(created.ghostId);
    await page.goto(`${readRunState().baseUrl}/#/settings?tab=team&ghost=${ghostId}`);
    await expect(page.getByRole('textbox', { name: '이름', exact: true })).toHaveValue('모델 경로 검증용');
  });

  test.afterEach(async ({ page }) => {
    for (const id of [ghostId, ...extraGhostIds]) {
      if (!id || (await storedGhost(page, id)).deletedAt !== null) continue;
      await send(page, { type: 'ghost.update', ghostId: id, state: 'retired' });
      await send(page, { type: 'ghost.delete', ghostId: id });
    }
  });

  test('excludes used alternatives and persists add, reorder, replacement and inheritance', async ({ page }) => {
    await page.getByRole('button', { name: '대체 모델 추가', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Alpha/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^Beta/ })).toBeDisabled();
    await page.getByRole('textbox', { name: '모델 검색', exact: true }).fill('delta');
    await page.getByRole('textbox', { name: '모델 검색', exact: true }).press('Enter');
    await expect(page.getByRole('textbox', { name: '모델 검색', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Delta', exact: true }).click();
    await expect.poll(async () => (await storedGhost(page, ghostId)).fallbacks.map(ref => ref.model)).toEqual(['Beta', 'Gamma', 'Delta']);
    await expect(page.getByRole('button', { name: '대체 모델 추가', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '3번 위로', exact: true }).click();
    await expect.poll(async () => (await storedGhost(page, ghostId)).fallbacks.map(ref => ref.model)).toEqual(['Beta', 'Delta', 'Gamma']);
    await page.getByRole('button', { name: '1번 대체 모델 지우기', exact: true }).click();
    await expect.poll(async () => (await storedGhost(page, ghostId)).fallbacks.map(ref => ref.model)).toEqual(['Delta', 'Gamma']);
    await page.getByRole('button', { name: /^1번 대체 모델 선택:/ }).click();
    await page.getByRole('button', { name: 'Beta', exact: true }).click();
    await expect.poll(async () => (await storedGhost(page, ghostId)).fallbacks.map(ref => ref.model)).toEqual(['Beta', 'Gamma']);
    await page.reload();
    await expect(page.getByRole('button', { name: /^1번 대체 모델 선택:/ })).toContainText('Beta');
    await expect(page.getByRole('button', { name: /^2번 대체 모델 선택:/ })).toContainText('Gamma');
    await page.getByRole('button', { name: /^기본 모델 선택:/ }).click();
    await expect(page.getByRole('button', { name: /^Beta/ })).toBeDisabled();
    await page.getByRole('button', { name: '기본 모델 따름', exact: true }).click();
    await expect.poll(async () => (await storedGhost(page, ghostId)).model).toBeNull();
  });

  test('keeps the saved route on failure and allows an explicit next edit without replay', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/commands', async route => {
      if (route.request().postDataJSON()?.command?.fallbacks) {
        attempts++;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'internal', message: '검증용 저장 실패' } }) });
      } else await route.continue();
    });
    await page.getByRole('button', { name: '1번 아래로', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Ghost 설정' }).getByRole('status')).toContainText('검증용 저장 실패');
    expect((await storedGhost(page, ghostId)).fallbacks.map(ref => ref.model)).toEqual(['Beta', 'Gamma']);
    await expect(page.getByRole('button', { name: /^1번 대체 모델 선택:/ })).toContainText('Beta');
    await expect(page.getByRole('button', { name: '1번 아래로', exact: true })).toBeEnabled();
    expect(attempts).toBe(1);
    await page.unroute('**/api/commands');
    await page.getByRole('button', { name: '1번 아래로', exact: true }).click();
    await expect.poll(async () => (await storedGhost(page, ghostId)).fallbacks.map(ref => ref.model)).toEqual(['Gamma', 'Beta']);
    await expect(page.getByText('검증용 저장 실패')).toHaveCount(0);
  });

  test('keeps the filter clearable when deleting a Ghost crosses the search threshold', async ({ page }) => {
    for (let index = 0; index < 4; index++) {
      const created = await send(page, { type: 'ghost.create', name: `검색 경계 검증 ${index}`, persona: '합성 검색 검증 자료입니다.' });
      extraGhostIds.push(String(created.ghostId));
    }
    await page.getByRole('textbox', { name: '설정할 Ghost 찾기', exact: true }).fill('모델 경로 검증용');
    await page.getByRole('textbox', { name: '설정할 Ghost 찾기', exact: true }).press('Enter');
    await expect(page.getByRole('textbox', { name: '설정할 Ghost 찾기', exact: true })).toBeFocused();
    await page.getByRole('radio', { name: '은퇴', exact: true }).click();
    await page.getByRole('button', { name: '삭제', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '삭제', exact: true }).click();
    await expect.poll(async () => (await storedGhost(page, ghostId)).deletedAt).not.toBeNull();
    await page.getByRole('button', { name: 'Ghost 검색 지우기', exact: true }).click({ timeout: 3000 });
    await expect(page.locator('.roster').getByRole('button', { name: '검색 경계 검증 0', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '설정할 Ghost 찾기', exact: true })).toHaveCount(0);
  });
});
