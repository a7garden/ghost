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
    await expect(page.getByRole('list', { name: '설정할 Ghost' }).getByRole('button', { name: '검색 경계 검증 0', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '설정할 Ghost 찾기', exact: true })).toHaveCount(0);
  });
});

test('provider setup retains a rejected key draft and edits the saved account inline at 390px', async ({ page }) => {
  const run = readRunState();
  const providerId = 'e2e-provider-inline';
  const label = '검증용 모델 서버';
  const apiKey = 'synthetic-provider-key';
  const server = `http://127.0.0.1:${run.mockPort}/v1`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${run.baseUrl}/#/settings?tab=models`);
  try {
    await page.getByRole('button', { name: '제공자 추가', exact: true }).click();
    const picker = page.getByRole('region', { name: '제공자 추가', exact: true });
    const search = picker.getByRole('textbox', { name: '제공자 검색' });
    await search.fill('zz-no-provider');
    await expect(picker.getByText('일치하는 제공자가 없습니다.')).toBeVisible();
    await search.fill('호환');
    await picker.getByRole('button', { name: 'OpenAI 호환 서버', exact: true }).click();
    const setup = picker.getByRole('region', { name: 'OpenAI 호환 서버 연결', exact: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await setup.getByRole('textbox', { name: '서버 주소', exact: true }).fill(server);
    const key = setup.getByLabel('API 키', { exact: true });
    await expect(key).toHaveAttribute('type', 'password');
    await key.fill(apiKey);
    await setup.getByText('모델 ID 직접 추가', { exact: true }).click();
    await setup.getByRole('textbox', { name: '추가할 모델 ID' }).fill('mock-1');
    await setup.getByRole('textbox', { name: '추가할 모델 ID' }).press('Enter');
    await setup.getByText('고급 설정', { exact: true }).click();
    await setup.getByRole('textbox', { name: '이름', exact: true }).fill(label);
    await setup.getByRole('textbox', { name: '제공자 ID', exact: true }).fill(providerId);
    await expect.poll(() => setup.evaluate(row => row.scrollWidth <= row.clientWidth)).toBe(true);

    await page.route('**/api/commands', async route => {
      if (route.request().postDataJSON()?.command?.id !== providerId) return route.continue();
      await route.fulfill({ status: 503, json: { ok: false, error: { code: 'unavailable', message: '검증용 저장 실패' } } });
    });
    await setup.getByRole('button', { name: '저장', exact: true }).click();
    await expect(setup.getByRole('alert')).toContainText('검증용 저장 실패');
    await expect(key).toHaveValue(apiKey);
    await expect(setup.getByRole('textbox', { name: '서버 주소', exact: true })).toHaveValue(server);
    await page.unroute('**/api/commands');
    await setup.getByRole('button', { name: '저장', exact: true }).click();
    await expect(picker).toHaveCount(0);

    const record = page.locator('.provider-record').filter({ hasText: label });
    await expect(record.getByRole('status')).toBeVisible();
    await expect(record.getByRole('button', { name: `${label} 제공자 삭제`, exact: true })).toHaveCount(0);
    await record.getByRole('button', { name: `${label} 설정`, exact: true }).click();
    const edit = record.getByRole('region', { name: `${label} 설정`, exact: true });
    await expect(edit.getByLabel('새 API 키', { exact: true })).toHaveValue('');
    await expect(edit.getByRole('button', { name: `${label} 제공자 삭제`, exact: true })).toBeVisible();
    await edit.getByRole('button', { name: '취소', exact: true }).click();
    await expect(edit).toHaveCount(0);
  } finally {
    await page.unroute('**/api/commands');
    await send(page, { type: 'provider.delete', providerId }).catch(() => {});
  }
});

test('provider device login shows the code and completion under the provider, without a dialog', async ({ page }) => {
  const providerId = 'e2e-device-inline';
  const name = '검증용 ChatGPT';
  const code = 'TEST-1234';
  let signedIn = false;
  let polls = 0;
  await page.route(`**/api/providers/${providerId}/oauth`, async route => {
    if (route.request().method() === 'GET') polls++;
    await route.fulfill({ json: {
      state: route.request().method() === 'DELETE' ? 'cancelled' : signedIn ? 'done' : 'pending',
      userCode: signedIn ? null : code, verificationUri: 'https://auth.openai.com/codex/device',
      authUrl: null, expiresAt: Date.now() + 180_000, message: null,
    } });
  });
  await page.goto(`${readRunState().baseUrl}/#/settings?tab=models`);
  try {
    await send(page, { type: 'provider.upsert', id: providerId, kind: 'openai', name, models: [] });
    const provider = page.locator('.provider-record').filter({ hasText: name });
    await provider.getByRole('button', { name: `${name} ChatGPT로 로그인`, exact: true }).click();
    const login = provider.getByRole('region', { name: 'ChatGPT 로그인', exact: true });
    await expect(login.getByText(code, { exact: true })).toBeVisible();
    await expect(login.getByRole('link', { name: '인증 페이지 열기' })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    signedIn = true;
    await expect(login.getByRole('status').filter({ hasText: '로그인을 완료했습니다.' })).toBeVisible();
    expect(polls).toBeGreaterThan(0);
    await login.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(login).toHaveCount(0);
  } finally {
    await send(page, { type: 'provider.delete', providerId }).catch(() => {});
  }
});

test('paired device names are edited on their row and retained when a save fails', async ({ page, request }) => {
  const { baseUrl } = readRunState();
  const deviceName = `테스트 기기 ${crypto.randomUUID()}`;
  const nextName = `작업용 ${crypto.randomUUID()}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/settings?tab=devices`);
  const { code } = await send(page, { type: 'device.pairing_start' });
  const claim = await request.post(`${baseUrl}/api/pairing/claim`, { data: { code, deviceName } });
  expect(claim.ok()).toBe(true);
  const { deviceId } = await claim.json() as { deviceId: string };
  const writes: string[] = [];
  try {
    await page.route('**/api/commands', async route => {
      const command = route.request().postDataJSON()?.command as Command | undefined;
      if (command?.type !== 'device.update' || command.deviceId !== deviceId) return route.fallback();
      if (command.name !== undefined) writes.push(command.name);
      if (writes.length === 1) return route.fulfill({ status: 503, json: { ok: false, error: { code: 'unavailable', message: 'unavailable' } } });
      return route.fallback();
    });
    const devices = page.getByRole('region', { name: '등록된 기기', exact: true });
    const rename = devices.getByRole('button', { name: `${deviceName} 이름 변경`, exact: true });
    const form = devices.getByRole('form', { name: '기기 이름 변경', exact: true });
    const field = form.getByRole('textbox', { name: '기기 이름', exact: true });
    const row = devices.getByRole('listitem').filter({ has: page.getByRole('form', { name: '기기 이름 변경', exact: true }) });
    await rename.click();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(deviceName);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await field.fill('취소할 이름');
    await row.getByRole('button', { name: '취소', exact: true }).click();
    await expect(rename).toBeFocused();
    await rename.click();
    await field.fill('버릴 이름');
    await field.press('Escape');
    await expect(rename).toBeFocused();
    expect(writes).toHaveLength(0);
    await rename.click();
    await expect(field).toHaveValue(deviceName);
    await field.fill(nextName);
    await field.press('Enter');
    await expect(form.getByRole('alert')).toHaveText('기기 이름을 저장하지 못했습니다.');
    await expect(field).toHaveValue(nextName);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await field.press('Enter');
    await expect(devices.getByRole('button', { name: `${nextName} 이름 변경`, exact: true })).toBeFocused();
    await expect(form).toHaveCount(0);
    expect(writes).toEqual([nextName, nextName]);
    await devices.getByRole('button', { name: `${nextName} 연결 해제`, exact: true }).click();
    await expect(page.getByRole('dialog', { name: '기기 연결 해제' })).toBeVisible();
  } finally {
    await send(page, { type: 'device.revoke', deviceId });
  }
});
