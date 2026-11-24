import { test, expect, type Page } from '@playwright/test';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Command, Connection, ConnectionConfig, MailDiscovery, State } from '@ghost/contract';
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
 * Client journeys against an isolated real Host: the address-first mail dialog,
 * per-service connected state, one-click Mac sign-ins, API grants, PR-source
 * exclusion and validation retention. Gitea uses a real local authentication
 * endpoint; the Host's `/api/connect/*` routes are stubbed with `page.route`
 * because their real work (DNS, provider lookups, the gh CLI) is not under test.
 * The assist case verifies the outgoing request and route only, not Host
 * admission or a model turn. No external provider login is exercised.
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
  const tile = page.locator('.service-tile', { hasText: serviceName });
  await expect(tile).toHaveCount(1);
  await tile.getByRole('button', { name: new RegExp(`${serviceName} (연결|계정 추가)`) }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

/** The Host's mail discovery, stubbed per domain: known providers, and one domain it cannot resolve. */
const mailDiscovery = (email: string): MailDiscovery => {
  const domain = email.split('@')[1] ?? '';
  const known: Partial<Record<string, Partial<MailDiscovery>>> = {
    'gmail.com': { provider: { id: 'gmail', name: 'Gmail' }, imap: { host: 'imap.gmail.com', port: 993 }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, auth: 'app_password', setupUrl: 'https://myaccount.google.com/apppasswords', note: '2단계 인증을 먼저 켜야 합니다.', source: 'known' },
    'outlook.com': { provider: { id: 'outlook', name: 'Outlook' }, imap: { host: 'outlook.office365.com', port: 993 }, smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false }, auth: 'oauth', setupUrl: null, note: null, source: 'known' },
  };
  return { email, domain, provider: null, imap: null, smtp: null, auth: 'password', setupUrl: null, note: null, source: 'none', ...(known[domain] ?? {}) };
};

/** GET /api/connect/mail, stubbed; returns the addresses the dialog asked about. */
function interceptMailDiscovery(page: Page): string[] {
  const asked: string[] = [];
  void page.route('**/api/connect/mail*', async route => {
    const email = new URL(route.request().url()).searchParams.get('email') ?? '';
    asked.push(email);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mailDiscovery(email)) });
  });
  return asked;
}

/** GET/POST /api/connect/local, stubbed: one unconnected gh CLI account on this Mac. */
function interceptLocalAccounts(page: Page): { connect: { source: string; login: string }[] } {
  const connect: { source: string; login: string }[] = [];
  void page.route('**/api/connect/local', async route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accounts: [
        { source: 'gh', serviceId: 'github', login: 'e2e-gardener', scopes: ['repo', 'read:org'], connectionId: null },
      ] }) });
    }
    connect.push(route.request().postDataJSON() as { source: string; login: string });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connectionId: 'local-gh-stub' }) });
  });
  return { connect };
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

test('mail connects by address; host-resolved servers stay hidden until they are missing', async ({ page }) => {
  const run = readRunState();
  await page.goto(`${run.baseUrl}/#/settings?tab=connections`);
  const posts = interceptAuthTests(page);
  const asked = interceptMailDiscovery(page);

  // The single address entry at the top of the page opens the same dialog a tile opens.
  const gmailAddress = 'owner@gmail.com';
  const gmailSecret = 'e2e-gmail-app-password-1';
  await page.getByRole('textbox', { name: '이메일 주소로 연결', exact: true }).fill(gmailAddress);
  await page.getByRole('button', { name: '계속', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '이메일 주소', exact: true })).toHaveValue(gmailAddress);

  // Debounced discovery resolves the provider quietly; servers are never asked up front.
  await expect(dialog.locator('.mail-provider')).toHaveText(/Gmail/);
  expect(asked).toContain(gmailAddress);
  await expect(dialog.getByRole('button', { name: '서버 설정', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('textbox', { name: 'IMAP 서버', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: /앱 비밀번호 발급/ })).toHaveAttribute('href', 'https://myaccount.google.com/apppasswords');
  await expect(dialog.getByText('2단계 인증을 먼저 켜야 합니다.')).toBeVisible();

  const secret = dialog.getByLabel('앱 비밀번호', { exact: true });
  await expect(secret).toHaveAttribute('type', 'password');
  await secret.fill(gmailSecret);
  await dialog.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The saved command carries the discovered servers verbatim plus the typed secret.
  const gmailUpserts = posts.filter(isMailUpsert).filter(post => post.command.config.username === gmailAddress);
  expect(gmailUpserts).toHaveLength(1);
  expect(gmailUpserts[0]!.command).toMatchObject({
    name: `Gmail · ${gmailAddress}`, serviceId: 'gmail', credential: gmailSecret,
    config: { kind: 'mail', host: 'imap.gmail.com', port: 993, username: gmailAddress, mailbox: 'INBOX', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  });
  const gmailAccount = page.locator('.connection-account', { hasText: gmailAddress });
  await expect(gmailAccount.locator('.connection-tile__status')).toHaveAttribute('data-phase', 'ok');
  await waitForConnection(page, `Gmail · ${gmailAddress}`);

  // The connected service reads as connected, keeps its account, and still admits another.
  const gmailTile = page.locator('.service-tile', { hasText: 'Gmail' });
  await expect(gmailTile.locator('.service-state')).toHaveText('연결됨');
  await expect(gmailTile.getByRole('button', { name: 'Gmail 계정 추가', exact: true })).toBeVisible();

  // A provider tile seeds the dialog: only the local part is left to type.
  await gmailTile.getByRole('button', { name: 'Gmail 계정 추가', exact: true }).click();
  const seeded = page.getByRole('dialog');
  const seededAddress = seeded.getByRole('textbox', { name: '이메일 주소', exact: true });
  await expect(seededAddress).toHaveAttribute('placeholder', '이름@gmail.com');
  await seededAddress.fill('second');
  await expect(seeded.locator('.mail-provider')).toHaveText(/second@gmail.com/);
  await seeded.getByLabel('앱 비밀번호', { exact: true }).fill('e2e-gmail-app-password-2');
  await seeded.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await waitForConnection(page, 'Gmail · second@gmail.com');
  await expect(gmailTile.locator('.service-state')).toHaveText('연결됨 2');

  // An address the Host cannot resolve opens the server disclosure by itself.
  await page.getByRole('textbox', { name: '이메일 주소로 연결', exact: true }).fill('me@selfhost.test');
  await page.getByRole('button', { name: '계속', exact: true }).click();
  const selfDialog = page.getByRole('dialog');
  await expect(selfDialog.getByRole('button', { name: '서버 설정', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(selfDialog.getByRole('textbox', { name: 'IMAP 서버', exact: true })).toHaveValue('');
  await selfDialog.getByRole('textbox', { name: 'IMAP 서버', exact: true }).fill('imap.selfhost.test');
  const selfSecret = selfDialog.getByLabel('비밀번호', { exact: true });
  await expect(selfSecret).toHaveAttribute('type', 'password');
  await selfSecret.fill('e2e-self-password-3');
  await selfDialog.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const selfUpserts = posts.filter(isMailUpsert).filter(post => post.command.config.username === 'me@selfhost.test');
  expect(selfUpserts).toHaveLength(1);
  expect(selfUpserts[0]!.command).toMatchObject({
    name: 'selfhost.test · me@selfhost.test', serviceId: 'custom-mail',
    config: { host: 'imap.selfhost.test', port: 993, smtpHost: null, smtpPort: 587, smtpSecure: false },
  });
  await waitForConnection(page, 'selfhost.test · me@selfhost.test');

  // The stored snapshot describes the accounts but never carries the secrets.
  const stateText = JSON.stringify(await stateSnapshot(page));
  expect(stateText).not.toContain(gmailSecret);
  expect(stateText).not.toContain('e2e-gmail-app-password-2');
  expect(stateText).not.toContain('e2e-self-password-3');

  // Accounts live under their service; the provider icon is said once, by the service row, and the name already carries the address.
  await expect(gmailTile.locator('img[src="/service-icons/gmail.svg"]')).toBeVisible();
  await expect(gmailAccount.locator('.connection-tile__identity h3')).toHaveText(`Gmail · ${gmailAddress}`);
  await expect(gmailAccount.locator('.connection-tile__identity p')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect.poll(() => gmailAccount.evaluate(row => row.scrollWidth <= row.clientWidth)).toBe(true);
});

test('an oauth mail domain offers login only, with the address as the username', async ({ page }) => {
  const run = readRunState();
  await page.goto(`${run.baseUrl}/#/settings?tab=connections`);
  interceptMailDiscovery(page);
  await page.route('**/api/connection-oauth/outlook', async route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ serviceId: 'outlook', configured: true, clientId: 'e2e-client', redirectUri: 'https://host.test/callback', state: 'idle', authorizationUrl: null, connectionId: null, message: null }),
  }));

  const outlookTile = page.locator('.service-tile', { hasText: 'Outlook' });
  await outlookTile.getByRole('button', { name: 'Outlook 연결', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '이메일 주소', exact: true }).fill('me@outlook.com');
  await expect(dialog.locator('.mail-provider')).toHaveText(/Outlook/);

  // Login only: no app-password field, no manual server form, no manual submit.
  await expect(dialog.getByLabel('앱 비밀번호', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '서버 설정', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '연결', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: '메일 주소', exact: true })).toHaveValue('me@outlook.com');
  await expect(dialog.getByRole('button', { name: 'Outlook 로그인', exact: true })).toBeVisible();
});

test('a github account already signed in on this mac connects with one click', async ({ page }) => {
  const run = readRunState();
  await page.goto(`${run.baseUrl}/#/settings?tab=connections`);
  interceptAuthTests(page);
  const { connect } = interceptLocalAccounts(page);

  const row = page.locator('.local-account', { hasText: 'e2e-gardener' });
  await expect(row).toBeVisible();
  await expect(row.getByText('repo · read:org')).toBeVisible();
  await expect(page.getByText('CLI에서 로그아웃하면 연결이 끊깁니다.')).toBeVisible();

  await row.getByRole('button', { name: '이 Mac의 계정 사용', exact: true }).click();
  await expect(row.locator('.connection-tile__status')).toHaveAttribute('data-phase', 'ok');
  await expect(row.locator('.service-state')).toHaveText('연결됨');
  expect(connect).toEqual([{ source: 'gh', login: 'e2e-gardener' }]);

  // The calm note leaves once every Mac account is connected.
  await expect(page.getByText('CLI에서 로그아웃하면 연결이 끊깁니다.')).toHaveCount(0);
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
    const okTile = page.locator('.connection-account', { hasText: 'CI 저장소 성공' });
    await expect(okTile.locator('.connection-tile__status')).toHaveAttribute('data-phase', 'ok');
    expect(apiRequests.some(request => request.path === '/api/v1/user' && request.authorization === `token ${okToken}`)).toBe(true);
    const storedOk = await waitForConnection(page, 'CI 저장소 성공');
    expect(storedOk.config).toMatchObject({ kind: 'gitea', baseUrl: `http://127.0.0.1:${port}/api/v1` });
    expect(storedOk.hasCredential).toBe(true);

    // A rejected token surfaces as a failed account test under its service.
    await openService(page, 'gitea', 'Gitea');
    const badDialog = page.getByRole('dialog');
    await badDialog.getByRole('textbox', { name: '이름', exact: true }).fill('CI 저장소 실패');
    await badDialog.getByRole('textbox', { name: '서버 주소', exact: true }).fill(`http://127.0.0.1:${port}`);
    await badDialog.getByLabel('접근 토큰', { exact: true }).fill(badToken);
    await badDialog.getByRole('button', { name: '연결', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const badTile = page.locator('.connection-account', { hasText: 'CI 저장소 실패' });
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
  await expect(page.locator('.connection-account', { hasText: 'Notion' }).locator('.connection-tile__status')).toHaveAttribute('data-phase', 'ok');

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
  await expect(page.getByRole('option', { name: /Gmail/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await activityDialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(activityDialog).toHaveCount(0);
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
  await expect(page.locator('.service-tile')).toHaveCount(0);
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
