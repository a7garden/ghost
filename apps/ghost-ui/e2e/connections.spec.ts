import { test, expect, type Page } from '@playwright/test';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Command, Connection, ConnectionConfig, State } from '@ghost/contract';
import { readRunState } from './run-state';

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const isUpsert = (post: Posted): post is Posted & { command: Extract<Command, { type: 'connection.upsert' }> } =>
  post.command.type === 'connection.upsert';

const isMailUpsert = (post: Posted): post is Posted & { command: Extract<Command, { type: 'connection.upsert' }> & { config: Extract<ConnectionConfig, { kind: 'mail' }> } } =>
  isUpsert(post) && post.command.config.kind === 'mail';

const isMessageSend = (post: Posted): post is Posted & { command: Extract<Command, { type: 'message.send' }> } =>
  post.command.type === 'message.send';

/**
 * Client journeys against an isolated real Host: catalog/mail drafts, secret-free
 * state, API grants, PR-source exclusion and validation retention. Gitea uses a
 * real local authentication endpoint; mail/Notion authentication is simulated.
 * The assist case verifies the outgoing request and route only, not Host admission
 * or a model turn. No external provider login is exercised.
 */

type Posted = { requestId: string; command: Command };

/** Connections this suite created; removed in afterAll so the shared host stays clean. */
const createdIds: string[] = [];
let ownerToken: string | undefined;
let apiServer: http.Server | undefined;

async function stateSnapshot(page: Page): Promise<State> {
  ownerToken ??= await page.evaluate(() => window.__GHOST_TOKEN__);
  return page.evaluate(async () => {
    const response = await fetch('/api/state', { headers: { authorization: `Bearer ${window.__GHOST_TOKEN__}` } });
    if (!response.ok) throw new Error(`/api/state failed: ${response.status}`);
    return response.json() as Promise<State>;
  });
}

async function ownerSend(page: Page, command: Command): Promise<void> {
  ownerToken ??= await page.evaluate(() => window.__GHOST_TOKEN__);
  await page.evaluate(async ({ token, command }) => {
    const response = await fetch('/api/commands', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), command }),
    });
    const body = await response.json() as { ok: boolean };
    if (!response.ok || !body.ok) throw new Error(`command ${command.type} failed`);
  }, { token: ownerToken, command });
}


/** Waits until the host stores the account; observed ids are deleted in afterAll. */
async function waitForConnection(page: Page, name: string): Promise<Connection> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const found = (await stateSnapshot(page)).connections?.find(connection => connection.name === name);
    if (found) {
      createdIds.push(found.id);
      return found;
    }
    if (Date.now() > deadline) throw new Error(`connection "${name}" was not stored`);
    await delay(200);
  }
}

/** Fulfills only the authentication-test command; upserts still reach the real host. */
function interceptAuthTests(page: Page): Posted[] {
  const posts: Posted[] = [];
  page.route('**/api/commands', async route => {
    const post = route.request().postDataJSON() as Posted;
    posts.push(post);
    if (post.command.type === 'connection.test') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: { summary: 'e2e-stub' } }) });
    }
    return route.continue();
  });
  return posts;
}

async function openService(page: Page, query: string, serviceName: string): Promise<void> {
  await page.getByRole('textbox', { name: '서비스 검색', exact: true }).fill(query);
  const choice = page.locator('.service-choice', { hasText: serviceName });
  await expect(choice).toHaveCount(1);
  await choice.click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

/**
 * The only network stand-in for real endpoint tests: one local API the host itself
 * probes. `token e2e-ok-token` is a valid account; anything else is rejected 401.
 */
const okToken = 'e2e-ok-token';
const badToken = 'e2e-bad-token';
const apiRequests: { path: string; authorization: string }[] = [];

async function startAuthEndpoint(): Promise<number> {
  apiRequests.length = 0;
  const server = http.createServer((request, response) => {
    const authorization = String(request.headers.authorization ?? '');
    apiRequests.push({ path: request.url ?? '', authorization });
    if (authorization === `token ${okToken}`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 1, login: 'e2e-account' }));
    } else {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'invalid token' }));
    }
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  apiServer = server;
  return (server.address() as AddressInfo).port;
}

async function closeAuthEndpoint(): Promise<void> {
  if (!apiServer) return;
  const server = apiServer;
  apiServer = undefined;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
}

test.afterAll(async () => {
  const { baseUrl } = readRunState();
  for (const connectionId of createdIds.splice(0)) {
    await fetch(`${baseUrl}/api/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken ?? ''}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), command: { type: 'connection.delete', connectionId } }),
    }).catch(() => {});
  }
  await closeAuthEndpoint();
});

test('mail presets hide protocol fields and keep secrets out of state with simulated authentication', async ({ page }) => {
  const run = readRunState();
  await page.goto(`${run.baseUrl}/#/settings?tab=connections`);
  const posts = interceptAuthTests(page);

  // Catalog search narrows to the picked mail service.
  await page.getByRole('textbox', { name: '서비스 검색', exact: true }).fill('icloud');
  const choice = page.locator('.service-choice', { hasText: 'iCloud' });
  await expect(choice).toHaveCount(1);
  await choice.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Mail presets have no login route: the key form is the whole form.
  await expect(dialog.getByRole('button', { name: '키로 직접 연결', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: '이름', exact: true })).toHaveValue('iCloud');

  const icloudAddress = 'owner.icloud@example.test';
  const icloudSecret = 'e2e-icloud-app-password-1';
  const address = dialog.getByRole('textbox', { name: '메일 주소', exact: true });
  const secret = dialog.getByLabel('앱 암호', { exact: true });
  await expect(address).toHaveValue('');
  await expect(secret).toHaveValue('');
  await expect(secret).toHaveAttribute('type', 'password');
  await expect(dialog.getByRole('textbox', { name: 'IMAP 서버', exact: true })).toHaveCount(0);
  const advanced = dialog.getByRole('button', { name: '고급 설정', exact: true });
  await expect(advanced).toHaveAttribute('aria-expanded', 'false');
  await advanced.click();
  await expect(dialog.getByRole('textbox', { name: 'IMAP 서버', exact: true })).toHaveValue('imap.mail.me.com');
  await expect(dialog.getByRole('spinbutton', { name: 'IMAP 포트', exact: true })).toHaveValue('993');
  await expect(dialog.getByRole('textbox', { name: '메일함', exact: true })).toHaveValue('INBOX');
  await expect(dialog.getByRole('textbox', { name: 'SMTP 서버', exact: true })).toHaveValue('smtp.mail.me.com');
  await expect(dialog.getByRole('spinbutton', { name: 'SMTP 포트', exact: true })).toHaveValue('587');
  await expect(dialog.getByRole('switch', { name: 'SMTP 암시적 TLS', exact: true })).toHaveAttribute('aria-checked', 'false');

  await address.fill(icloudAddress);
  await expect(dialog.getByRole('textbox', { name: '이름', exact: true })).toHaveValue(`iCloud · ${icloudAddress}`);
  await secret.fill(icloudSecret);
  await dialog.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The saved command carries the preset verbatim plus the typed secret.
  const icloudUpserts = posts.filter(isMailUpsert).filter(post => post.command.config.username === icloudAddress);
  expect(icloudUpserts).toHaveLength(1);
  expect(icloudUpserts[0]!.command).toMatchObject({
    serviceId: 'icloud',
    credential: icloudSecret,
    config: { kind: 'mail', host: 'imap.mail.me.com', port: 993, username: icloudAddress, mailbox: 'INBOX', smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false },
  });
  await expect(page.locator('.connection-tile', { hasText: icloudAddress }).locator('.connection-tile__status')).toHaveAttribute('data-phase', 'ok');
  await waitForConnection(page, `iCloud · ${icloudAddress}`);

  // The Gmail preset differs where the services actually differ.
  await page.getByRole('textbox', { name: '서비스 검색', exact: true }).fill('gmail');
  const gmailChoice = page.locator('.service-choice', { hasText: 'Gmail' });
  await expect(gmailChoice).toHaveCount(1);
  await gmailChoice.click();
  const gmailDialog = page.getByRole('dialog');
  await expect(gmailDialog).toBeVisible();
  await gmailDialog.getByRole('button', { name: '고급 설정', exact: true }).click();
  await expect(gmailDialog.getByRole('textbox', { name: 'IMAP 서버', exact: true })).toHaveValue('imap.gmail.com');
  await expect(gmailDialog.getByRole('spinbutton', { name: 'IMAP 포트', exact: true })).toHaveValue('993');
  await expect(gmailDialog.getByRole('textbox', { name: 'SMTP 서버', exact: true })).toHaveValue('smtp.gmail.com');
  await expect(gmailDialog.getByRole('spinbutton', { name: 'SMTP 포트', exact: true })).toHaveValue('465');
  await expect(gmailDialog.getByRole('switch', { name: 'SMTP 암시적 TLS', exact: true })).toHaveAttribute('aria-checked', 'true');

  const gmailAddress = 'mail-grid-overflow-probe.long.account.local.part@gmail.example.test';
  const gmailSecret = 'e2e-gmail-app-password-2';
  await gmailDialog.getByRole('textbox', { name: '메일 주소', exact: true }).fill(gmailAddress);
  await gmailDialog.getByLabel('앱 비밀번호', { exact: true }).fill(gmailSecret);
  await gmailDialog.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const gmailUpserts = posts.filter(isMailUpsert).filter(post => post.command.config.username === gmailAddress);
  expect(gmailUpserts).toHaveLength(1);
  expect(gmailUpserts[0]!.command).toMatchObject({
    serviceId: 'gmail',
    credential: gmailSecret,
    config: { kind: 'mail', host: 'imap.gmail.com', port: 993, smtpPort: 465, smtpSecure: true },
  });
  const gmailTile = page.locator('.connection-tile', { hasText: gmailAddress });
  await expect(gmailTile.locator('.connection-tile__status')).toHaveAttribute('data-phase', 'ok');
  await waitForConnection(page, `Gmail · ${gmailAddress}`);

  // The stored snapshot describes the accounts but never carries the secrets.
  const state = await stateSnapshot(page);
  const stateText = JSON.stringify(state);
  expect(stateText).not.toContain(icloudSecret);
  expect(stateText).not.toContain(gmailSecret);
  expect(state.connections?.find(connection => connection.serviceId === 'icloud')).toMatchObject({ hasCredential: true, config: { username: icloudAddress } });
  expect(state.connections?.find(connection => connection.serviceId === 'gmail')).toMatchObject({ hasCredential: true, config: { username: gmailAddress } });

  // Desktop grid: service icons and the full account identity per tile.
  const icloudTile = page.locator('.connection-tile', { hasText: icloudAddress });
  await expect(icloudTile.locator('img[src="/service-icons/icloud.svg"]')).toBeVisible();
  await expect(gmailTile.locator('img[src="/service-icons/gmail.svg"]')).toBeVisible();
  await expect(gmailTile.locator('.connection-tile__identity p')).toHaveText(gmailAddress);

  // 390px: the grid with the long account identity stays inside the viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect.poll(() => page.locator('.connection-grid').evaluate(grid => grid.scrollWidth <= grid.clientWidth)).toBe(true);
});

test('gitea authentication test succeeds and fails against the real endpoint', async ({ page }) => {
  const run = readRunState();
  const port = await startAuthEndpoint();
  try {
    await page.goto(`${run.baseUrl}/#/settings?tab=connections`);
    await openService(page, 'gitea', 'Gitea');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: '서버 주소', exact: true })).toBeVisible();
    await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('CI 저장소 성공');
    await dialog.getByRole('textbox', { name: '서버 주소', exact: true }).fill(`http://127.0.0.1:${port}`);
    await dialog.getByLabel('접근 토큰', { exact: true }).fill(okToken);
    await dialog.getByRole('button', { name: '연결', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The host itself probed the endpoint with the gitea token prefix preset.
    const okTile = page.locator('.connection-tile', { hasText: 'CI 저장소 성공' });
    await expect(okTile.locator('.connection-tile__status')).toHaveAttribute('data-phase', 'ok');
    expect(apiRequests.some(request => request.path === '/api/v1/user' && request.authorization === `token ${okToken}`)).toBe(true);
    const storedOk = await waitForConnection(page, 'CI 저장소 성공');
    expect(storedOk.config).toMatchObject({ kind: 'gitea', baseUrl: `http://127.0.0.1:${port}/api/v1` });
    expect(storedOk.hasCredential).toBe(true);

    // A rejected token surfaces as a failed account test on the tile.
    await openService(page, 'gitea', 'Gitea');
    const badDialog = page.getByRole('dialog');
    await badDialog.getByRole('textbox', { name: '이름', exact: true }).fill('CI 저장소 실패');
    await badDialog.getByRole('textbox', { name: '서버 주소', exact: true }).fill(`http://127.0.0.1:${port}`);
    await badDialog.getByLabel('접근 토큰', { exact: true }).fill(badToken);
    await badDialog.getByRole('button', { name: '연결', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const badTile = page.locator('.connection-tile', { hasText: 'CI 저장소 실패' });
    await expect(badTile.locator('.connection-tile__status')).toHaveAttribute('data-phase', 'error');
    expect(apiRequests.some(request => request.authorization === `token ${badToken}`)).toBe(true);
    await waitForConnection(page, 'CI 저장소 실패');

    // Editing again never refills the stored secret.
    await okTile.getByRole('button', { name: 'CI 저장소 성공 편집', exact: true }).click();
    const editDialog = page.getByRole('dialog');
    await expect(editDialog.getByLabel('접근 토큰', { exact: true })).toHaveValue('');
    await expect(editDialog.getByRole('textbox', { name: '서버 주소', exact: true })).toHaveValue(`http://127.0.0.1:${port}/api/v1`);
    await expect(editDialog.getByRole('checkbox', { name: '저장된 인증 정보 삭제', exact: true })).toBeVisible();
    await editDialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const state = await stateSnapshot(page);
    expect(JSON.stringify(state)).not.toContain(okToken);
    expect(JSON.stringify(state)).not.toContain(badToken);
  } finally {
    await closeAuthEndpoint();
  }
});

test('notion api defaults, explicit ghost grants, and pull-request activity exclusion', async ({ page }) => {
  const run = readRunState();
  const posts = interceptAuthTests(page);
  await page.goto(`${run.baseUrl}/#/settings?tab=connections`);
  await openService(page, 'notion', 'Notion');
  const dialog = page.getByRole('dialog');
  // Login is offered first; switch to the token form without exercising the login panel.
  await expect(dialog.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '키로 직접 연결', exact: true }).click();

  const notionSecret = 'e2e-notion-integration-token-3';
  await dialog.getByLabel('개인 접근 토큰 또는 통합 토큰', { exact: true }).fill(notionSecret);
  await dialog.getByRole('checkbox', { name: '기록가', exact: true }).check();
  const advanced = dialog.getByRole('button', { name: '고급 설정', exact: true });
  await expect(advanced).toHaveAttribute('aria-expanded', 'false');
  await advanced.click();
  await expect(dialog.getByRole('textbox', { name: 'API 주소', exact: true })).toHaveValue('https://api.notion.com/v1/');
  await expect(dialog.getByRole('textbox', { name: '계정 확인 API 경로', exact: true })).toHaveValue('users/me');
  await expect(dialog.getByRole('textbox', { name: '인증 헤더', exact: true })).toHaveValue('Authorization');
  await expect(dialog.getByRole('textbox', { name: '인증 접두어', exact: true })).toHaveValue('Bearer');
  await expect(dialog.getByRole('textbox', { name: '추가 헤더 (JSON)', exact: true })).toHaveValue(/"Notion-Version"/);

  await dialog.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.connection-tile', { hasText: 'Notion' }).locator('.connection-tile__status')).toHaveAttribute('data-phase', 'ok');

  const notionUpserts = posts.filter(isUpsert);
  expect(notionUpserts).toHaveLength(1);
  expect(notionUpserts[0]!.command).toMatchObject({
    name: 'Notion',
    serviceId: 'notion',
    credential: notionSecret,
    config: { kind: 'api', ghostIds: [run.scribeGhostId] },
  });
  await waitForConnection(page, 'Notion');
  expect(JSON.stringify(await stateSnapshot(page))).not.toContain(notionSecret);
  await ownerSend(page, { type: 'connection.upsert', name: 'PR 후보', config: { kind: 'gitea', baseUrl: 'https://git.example.test/api/v1' } });
  await waitForConnection(page, 'PR 후보');

  // An api-kind account is not a pull-request activity account; mail is neither.
  await page.getByRole('tab', { name: '자동 활동', exact: true }).click();
  await page.getByRole('button', { name: '활동 만들기', exact: true }).click();
  const activityDialog = page.getByRole('dialog');
  await expect(activityDialog).toBeVisible();
  await activityDialog.getByRole('radio', { name: 'PR', exact: true }).click();
  await activityDialog.getByRole('combobox', { name: '연결 계정', exact: true }).click();
  const options = page.getByRole('option');
  await expect(options.filter({ hasText: 'PR 후보' })).toHaveCount(1);
  await expect(page.getByRole('option', { name: 'Notion', exact: true })).toHaveCount(0);
  await expect(page.getByRole('option', { name: /iCloud|Gmail/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await activityDialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('server validation failure keeps typed values and a fresh form starts without the secret', async ({ page }) => {
  const run = readRunState();
  const upsertStatuses: number[] = [];
  page.on('response', response => {
    if (response.request().method() === 'POST' && (response.request().postData() ?? '').includes('"connection.upsert"')) {
      upsertStatuses.push(response.status());
    }
  });
  await page.goto(`${run.baseUrl}/#/settings?tab=connections`);

  // Catalog search without a match offers the custom service escape hatch.
  await page.getByRole('textbox', { name: '서비스 검색', exact: true }).fill('존재하지 않는 서비스 zzz');
  await expect(page.locator('.service-choice')).toHaveCount(0);
  await page.getByRole('button', { name: '다른 서비스 연결', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The custom service form starts with its advanced protocol section open.
  await expect(dialog.getByRole('button', { name: '고급 설정', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('textbox', { name: '계정 확인 API 경로', exact: true })).toBeVisible();

  const badUrl = 'https://wiki.example.com/api?probe=1';
  const customSecret = 'e2e-custom-api-key-4';
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('팀 위키');
  await dialog.getByRole('textbox', { name: 'API 주소', exact: true }).fill(badUrl);
  await dialog.getByRole('textbox', { name: '계정 확인 API 경로', exact: true }).fill('me');
  await dialog.getByLabel('API 키', { exact: true }).fill(customSecret);

  // The host rejects the URL shape the form alone accepts.
  await dialog.getByRole('button', { name: '연결', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(upsertStatuses).toContain(400);
  await expect(dialog.getByRole('textbox', { name: '이름', exact: true })).toHaveValue('팀 위키');
  await expect(dialog.getByRole('textbox', { name: 'API 주소', exact: true })).toHaveValue(badUrl);
  await expect(dialog.getByRole('textbox', { name: '계정 확인 API 경로', exact: true })).toHaveValue('me');
  await expect(dialog.getByLabel('API 키', { exact: true })).toHaveValue(customSecret);

  // Retrying without an edit must neither duplicate nor silently succeed.
  await dialog.getByRole('button', { name: '연결', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect.poll(() => upsertStatuses.length).toBe(2);
  expect(upsertStatuses.every(status => status >= 400)).toBe(true);
  expect(JSON.stringify(await stateSnapshot(page))).not.toContain(customSecret);

  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // A reopened form starts fresh; the secret is never refilled.
  await page.getByRole('button', { name: 'Ghost에게 연결 맡기기', exact: true }).click();
  const reopened = page.getByRole('dialog');
  await expect(reopened.getByRole('textbox', { name: '이름', exact: true })).toHaveValue('다른 서비스');
  await expect(reopened.getByLabel('API 키', { exact: true })).toHaveValue('');
  await reopened.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('ghost assist targets the main direct conversation and navigates to it at the client boundary', async ({ page }) => {
  const run = readRunState();
  const admitted: Posted[] = [];
  await page.route('**/api/commands', async route => {
    const post = route.request().postDataJSON() as Posted;
    if (post.command.type === 'message.send') {
      admitted.push(post);
      // Deliberately stops before Host admission; only the client request is under test.
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: {} }) });
    }
    return route.continue();
  });
  await page.goto(`${run.baseUrl}/#/settings?tab=connections`);
  await page.getByRole('button', { name: 'Ghost에게 연결 맡기기', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const ownerName = '팀 위키 도구';
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill(ownerName);
  await dialog.getByRole('button', { name: 'Ghost에게 연결 맡기기', exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`#/ghosts/${run.defaultGhostId}`));
  const main = (await stateSnapshot(page)).ghosts.find(ghost => ghost.isDefault);
  const admissions = admitted.filter(isMessageSend);
  expect(admissions).toHaveLength(1);
  expect(admissions[0]!.command).toMatchObject({ type: 'message.send', conversationId: main?.directConversationId });
  expect(admissions[0]!.command.text).toContain(ownerName);
});
