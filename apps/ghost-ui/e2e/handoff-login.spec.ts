import { test, expect, type Page } from '@playwright/test';
import type { BrowserLoginShelf } from '@ghost/contract';
import { readRunState } from './run-state';
import { mockShadeApi, mockStateDecisions, mockVaultApi, visualDecisions, visualHandoffDecisionId } from './mocks';
import { mockBrowserLiveStream, releaseBrowserFrame } from './iphone-fixtures';

/**
 * The live handoff card with the login shelf. The Host's shelf, fill and Shade-import routes are stubbed
 * at the network layer; what these tests pin is what the owner sees and which requests a tap sends.
 */

const conversationId = () => visualDecisions().find(decision => decision.id === visualHandoffDecisionId)!.conversationId;

const shelf = (over: Partial<BrowserLoginShelf> = {}): BrowserLoginShelf => ({
  origin: 'https://subscribe.example.com', saved: null,
  items: [{ id: 'v-login', title: '구독 서비스', username: 'owner@example.com', hasPassword: true, hasTotp: true }],
  shade: { status: { state: 'ready', writable: true, saveLogins: true }, items: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: '구독 서비스', username: 'work@example.com', origin: 'https://subscribe.example.com' }] },
  ...over,
});

async function openLiveHandoff(page: Page, current: () => BrowserLoginShelf) {
  const { baseUrl } = readRunState();
  await mockStateDecisions(page, true);
  await mockBrowserLiveStream(page, conversationId(), { url: 'https://subscribe.example.com/join', title: 'Join' });
  const endpoint = `**/api/browser/sessions/${conversationId()}`;
  await page.route(`${endpoint}/login`, route => route.fulfill({ json: current() }));
  await page.route(`${endpoint}/input`, route => route.fulfill({ json: { ok: true } }));
  await page.goto(`${baseUrl}/#/inbox?decision=${visualHandoffDecisionId}`);
  await expect.poll(() => page.evaluate(() => '__releaseBrowserFrame' in window)).toBe(true);
  await releaseBrowserFrame(page, { width: 640, height: 400 });
}

test('saved logins for this site fill the focused field one tap at a time', async ({ page }) => {
  const fills: unknown[] = [];
  await openLiveHandoff(page, () => shelf());
  await page.route(`**/api/browser/sessions/${conversationId()}/fill`, async route => {
    fills.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  const logins = page.getByRole('list', { name: '이 사이트의 저장된 로그인' });
  await expect(logins).toBeVisible();
  await expect(logins).toHaveScreenshot('handoff-login-shelf.png', { maxDiffPixelRatio: 0.02 });
  await logins.getByRole('button', { name: 'owner@example.com 아이디 입력' }).click();
  await expect(logins.getByRole('button', { name: 'owner@example.com 아이디 입력' })).toHaveText('입력함');
  await logins.getByRole('button', { name: 'owner@example.com 비밀번호 입력' }).click();
  await logins.getByRole('button', { name: 'owner@example.com 인증 코드 입력' }).click();
  expect(fills).toEqual([
    { itemId: 'v-login', field: 'username' }, { itemId: 'v-login', field: 'password' }, { itemId: 'v-login', field: 'totp' },
  ]);
});

test('a Shade login is brought along and then reads as an ordinary saved login', async ({ page }) => {
  let imported = false;
  await openLiveHandoff(page, () => imported
    ? shelf({ items: [...shelf().items, { id: 'v-shade', title: '구독 서비스', username: 'work@example.com', hasPassword: true, hasTotp: false }], shade: { status: { state: 'ready', writable: true, saveLogins: true }, items: [] } })
    : shelf());
  await page.route(`**/api/browser/sessions/${conversationId()}/login/shade`, async route => {
    expect(route.request().postDataJSON()).toEqual({ shadeItemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    imported = true;
    await route.fulfill({ status: 201, json: { id: 'v-shade', title: '구독 서비스', username: 'work@example.com', hasPassword: true, hasTotp: false } });
  });
  const logins = page.getByRole('list', { name: '이 사이트의 저장된 로그인' });
  await logins.getByRole('button', { name: 'work@example.com Shade에서 가져오기' }).click();
  await expect(logins.getByRole('button', { name: 'work@example.com 비밀번호 입력' })).toBeVisible();
  await expect(logins.getByRole('button', { name: /Shade에서 가져오기/ })).toHaveCount(0);
});

test('the card says when the Host saved the login the owner just completed', async ({ page }) => {
  let saved: BrowserLoginShelf['saved'] = null;
  await openLiveHandoff(page, () => shelf({ saved, items: [], shade: { status: { state: 'ready', writable: true, saveLogins: true }, items: [] } }));
  await expect(page.locator('.handoff__saved')).toHaveCount(0);
  saved = { itemId: 'v-new', username: 'owner@example.com', origin: 'https://subscribe.example.com', at: Date.now(), created: true, shade: true };
  await expect(page.locator('.handoff__saved')).toHaveText('로그인 정보를 금고에 저장했어요 · owner@example.com · Shade에도 저장', { timeout: 6000 });
  await expect(page.locator('.handoff__saved')).toHaveScreenshot('handoff-login-saved.png', { maxDiffPixelRatio: 0.02 });
});

test('a locked Shade explains why nothing is offered', async ({ page }) => {
  await openLiveHandoff(page, () => shelf({ items: [], shade: { status: { state: 'locked', writable: false, saveLogins: true }, items: [] } }));
  await expect(page.getByText('Shade 잠금을 풀면 저장된 로그인을 쓸 수 있어요')).toBeVisible();
  await expect(page.getByRole('list', { name: '이 사이트의 저장된 로그인' })).toHaveCount(0);
});

test('a failed fill shows the Host message', async ({ page }) => {
  await openLiveHandoff(page, () => shelf({ shade: { status: { state: 'unavailable', writable: false, saveLogins: false }, items: [] } }));
  await page.route(`**/api/browser/sessions/${conversationId()}/fill`, route => route.fulfill({ status: 403, json: { ok: false, error: { code: 'forbidden', message: '이 사이트의 로그인이 아니에요.' } } }));
  await page.getByRole('button', { name: 'owner@example.com 비밀번호 입력' }).click();
  await expect(page.getByRole('alert')).toHaveText('이 사이트의 로그인이 아니에요.');
});

test('the vault shows Shade and lets the owner stop mirroring new logins', async ({ page }) => {
  const { baseUrl } = readRunState();
  await mockVaultApi(page);
  const puts: unknown[] = [];
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/api/shade')) puts.push(request.postDataJSON()); });
  await page.goto(`${baseUrl}/#/settings?tab=vault`);
  const shade = page.getByRole('region', { name: 'Shade' });
  await expect(shade.getByText('연결됨')).toBeVisible();
  const mirror = shade.getByRole('switch', { name: '새 로그인을 Shade에도 저장' });
  await expect(mirror).toBeChecked();
  await mirror.click();
  await expect(mirror).not.toBeChecked();
  expect(puts).toEqual([{ saveLogins: false }]);
});

test('the vault says nothing about Shade when it is not installed', async ({ page }) => {
  const { baseUrl } = readRunState();
  await mockVaultApi(page);
  await mockShadeApi(page, 'unavailable');
  await page.goto(`${baseUrl}/#/settings?tab=vault`);
  await expect(page.getByText('서비스 로그인').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Shade' })).toHaveCount(0);
});
