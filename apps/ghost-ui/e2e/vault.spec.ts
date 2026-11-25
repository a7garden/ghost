import { test, expect, type Page } from '@playwright/test';
import type { VaultItem } from '@ghost/contract';
import { readRunState } from './run-state';
import { mockStateDecisions, mockVaultApi, validateVaultWrite, visualDecisions, visualSecureDecisionId, visualHandoffDecisionId } from './mocks';
import { mockBrowserLiveStream, releaseBrowserFrame } from './iphone-fixtures';

/**
 * Functional checks for the vault and secure-form surfaces. The host API they need
 * is mocked at the network layer with the real host's write validation, so contract
 * bugs fail these tests instead of hiding behind permissive mocks.
 */

interface CommandBody { command?: { type?: string; outcome?: string; decisionId?: string; answer?: string } }

async function recordCommands(page: Page, commands: (CommandBody['command'])[]): Promise<void> {
  await page.route('**/api/commands', async route => {
    commands.push((route.request().postDataJSON() as CommandBody).command);
    await route.continue();
  });
}

/** The secure-form answer route as the host reads it: kind required, boolean save, no foreign fields. */
async function mockVaultRequest(page: Page, answers: Record<string, unknown>[]): Promise<void> {
  await page.route('**/api/vault/requests/*', async route => {
    const answer = route.request().postDataJSON() as Record<string, unknown>;
    const broken = answer.kind !== 'login' || typeof answer.save !== 'boolean'
      || ['card', 'contact', 'value', 'title', 'hints', 'ghostIds'].some(key => key in answer);
    if (broken) {
      return route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'invalid', message: 'secure form answer breaks the host contract' } }) });
    }
    answers.push(answer);
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({}) });
  });
}

test('a secure form answers through the vault route and never through the answer API', async ({ page }) => {
  const { baseUrl, researchGhostId } = readRunState();
  const vaultAnswers: Record<string, unknown>[] = [];
  const commands: CommandBody['command'][] = [];
  await mockStateDecisions(page);
  await recordCommands(page, commands);
  await mockVaultRequest(page, vaultAnswers);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/ghosts/${researchGhostId}`);
  const fold = page.getByRole('button', { name: /^확인 필요 2건/ });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: /^서비스 로그인/ }).click();
  await expect(page.getByRole('button', { name: '금고에 전달' })).toBeInViewport({ ratio: 1 });
  // The chat answer path is not on the card.
  await expect(page.getByLabel('답변')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '금고에 저장' })).toBeChecked();
  await page.getByLabel('사용자 이름').fill('owner@example.com');
  await page.getByLabel('비밀번호').fill('비밀1234!@#');
  await page.getByRole('button', { name: '금고에 전달' }).click();
  await expect.poll(() => vaultAnswers).toEqual([{ kind: 'login', username: 'owner@example.com', password: '비밀1234!@#', save: true }]);
  expect(commands).toEqual([]);
});

test('unchecking 저장 sends save:false and declining takes the ordinary deny path', async ({ page }) => {
  const { baseUrl } = readRunState();
  const vaultAnswers: Record<string, unknown>[] = [];
  const commands: CommandBody['command'][] = [];
  await mockStateDecisions(page);
  await recordCommands(page, commands);
  await mockVaultRequest(page, vaultAnswers);
  await page.goto(`${baseUrl}/#/inbox?decision=${visualSecureDecisionId}`);
  // Decline first: it uses the ordinary deny command, never the vault route.
  await page.getByRole('button', { name: '거부' }).click();
  await expect.poll(() => commands[0]).toMatchObject({ type: 'decision.resolve', outcome: 'deny', decisionId: visualSecureDecisionId });
  // Reload refocuses the same pending decision and answers it with 저장 off.
  await page.reload();
  await page.getByLabel('사용자 이름').fill('owner@example.com');
  await page.getByLabel('비밀번호').fill('비밀1234!@#');
  await page.getByRole('checkbox', { name: '금고에 저장' }).uncheck();
  await page.getByRole('button', { name: '금고에 전달' }).click();
  await expect.poll(() => vaultAnswers).toEqual([{ kind: 'login', username: 'owner@example.com', password: '비밀1234!@#', save: false }]);
  expect(commands).toHaveLength(1);
});

test('the handoff completion button answers the question normally', async ({ page }) => {
  const { baseUrl } = readRunState();
  const commands: CommandBody['command'][] = [];
  await mockStateDecisions(page);
  await recordCommands(page, commands);
  await page.goto(`${baseUrl}/#/inbox?decision=${visualHandoffDecisionId}`);
  await expect(page.getByText('Mac의 Chrome 창에서 마무리해 주세요')).toBeVisible();
  await page.getByRole('button', { name: '다 했어요' }).click();
  await expect.poll(() => commands[0]).toMatchObject({ type: 'decision.resolve', outcome: 'answer', answer: '다 했어요' });
});

test('a live handoff without a native window keeps input available in Ghost', async ({ page }) => {
  const { baseUrl } = readRunState();
  await mockStateDecisions(page, true);
  const conversationId = visualDecisions().find(decision => decision.id === visualHandoffDecisionId)!.conversationId;
  const endpoint = `**/api/browser/sessions/${conversationId}`;
  await mockBrowserLiveStream(page, conversationId, { url: 'https://example.com/', title: 'Example Domain' });
  await page.route(`${endpoint}/window`, route => route.fulfill({ status: 409, json: {
    ok: false, error: { code: 'conflict', message: 'Mac 창을 열 수 없습니다.' },
  } }));
  await page.route(`${endpoint}/input`, async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
    if (input.type === 'viewport') await releaseBrowserFrame(page, input);
  });
  await page.goto(`${baseUrl}/#/inbox?decision=${visualHandoffDecisionId}`);
  await expect.poll(() => page.evaluate(() => '__releaseBrowserFrame' in window)).toBe(true);
  const live = page.locator('.browser-live');
  await releaseBrowserFrame(page, { width: 640, height: 480 });
  await expect(live.getByRole('img', { name: 'https://example.com — 클릭해 조작할 수 있습니다' })).toBeVisible();
  await expect(live.locator('.browser-live__placeholder')).toHaveCount(0);
  await live.getByRole('button', { name: 'Mac 창으로 열기', exact: true }).click();
  await expect(live.getByRole('alert')).toHaveText('Mac 창을 열 수 없습니다.');
  const field = live.getByRole('textbox', { name: '브라우저에 입력', exact: true });
  await expect(field).toBeEnabled();
  const input = page.waitForRequest(request => request.url().endsWith('/input') && request.postDataJSON()?.type === 'text');
  await field.fill('브라우저 입력 확인');
  expect((await input).postDataJSON()).toEqual({ type: 'text', text: '브라우저 입력 확인' });
});

test('a browser approval requires two deliberate presses', async ({ page }) => {
  const { baseUrl, defaultGhostId } = readRunState();
  const decisionId = 'test-browser-approval';
  const commands: CommandBody['command'][] = [];
  await page.clock.install();
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const state = await response.json();
    const ghost = state.ghosts.find((item: { id: string }) => item.id === defaultGhostId);
    await route.fulfill({ response, json: { ...state, decisions: [{
      id: decisionId, kind: 'approve_effect', ghostId: ghost.id, conversationId: ghost.directConversationId,
      workId: null, effectId: null, state: 'pending', title: '브라우저 동작 승인', detail: '', options: [],
      proposal: { url: 'https://example.test', element: { role: 'button', name: '제출' } },
      answer: null, createdAt: Date.now(), resolvedAt: null,
    }] } });
  });
  await page.route('**/api/commands', async route => {
    commands.push((route.request().postDataJSON() as CommandBody).command);
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${baseUrl}/#/inbox?decision=${decisionId}`);
  await page.getByRole('button', { name: '실행 승인', exact: true }).dblclick();
  const confirm = page.getByRole('button', { name: '한 번 더 눌러 실행 승인' });
  await expect(confirm).toBeVisible();
  expect(commands).toEqual([]);
  await page.clock.fastForward(450);
  await confirm.click();
  await expect.poll(() => commands).toEqual([{ type: 'decision.resolve', outcome: 'approve', decisionId }]);
});

test('editing an item keeps stored secrets out of the body and shows them as 저장됨', async ({ page }) => {
  const { baseUrl, researchGhostId, scribeGhostId } = readRunState();
  await mockVaultApi(page);
  const patches: Record<string, unknown>[] = [];
  await page.route('**/api/vault/items/v-login', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    patches.push(body);
    const invalid = validateVaultWrite(body);
    if (invalid) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'invalid', message: invalid } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${baseUrl}/#/settings?tab=vault`);
  const row = page.getByRole('article', { name: '서비스 로그인', exact: true });
  await row.getByRole('button', { name: '고치기' }).click();
  const editor = page.getByRole('form', { name: '금고 항목 고치기' });
  await expect(page.getByRole('list', { name: '금고 항목' }).getByRole('form')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The mask describes stored credentials; the editor never receives their value.
  const password = editor.getByLabel('비밀번호', { exact: true });
  await expect(password).toHaveValue('');
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveAccessibleDescription('저장됨 · 비워 두면 바뀌지 않습니다.');
  await editor.getByRole('button', { name: '자동 생성' }).click();
  const generated = await password.inputValue();
  expect(generated).toMatch(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%^&*_=+-]{20}$/);
  await editor.getByRole('checkbox', { name: '기록가' }).check();
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  const patch = patches[0];
  expect(patch).toMatchObject({
    kind: 'login', title: '서비스 로그인', origin: 'https://app.example.com', username: 'owner@example.com',
    password: generated, hints: '업무용 계정',
  });
  // Empty secret fields stay out of the body, so the stored values remain unchanged.
  expect(patch).not.toHaveProperty('totp');
  expect(patch).not.toHaveProperty('card');
  expect(patch).not.toHaveProperty('value');
  expect([...patch.ghostIds as string[]].sort()).toEqual([researchGhostId, scribeGhostId].sort());
  await expect(page.getByText('금고 항목을 저장했습니다.')).toBeVisible();
});

test('creating a login demands its primary fields and stores the generated password', async ({ page }) => {
  const { baseUrl, researchGhostId } = readRunState();
  const posts: Record<string, unknown>[] = [];
  await mockVaultApi(page);
  await page.route('**/api/vault/items', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    const invalid = validateVaultWrite(body);
    if (invalid) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'invalid', message: invalid } }) });
    if (posts.length === 1) return route.fulfill({ status: 503, json: { error: { message: body.password } } });
    return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${baseUrl}/#/settings?tab=vault`);
  const add = page.getByRole('button', { name: '새 항목', exact: true });
  await add.click();
  const form = page.getByRole('form', { name: '새 금고 항목' });
  const title = form.getByRole('textbox', { name: '항목 이름', exact: true });
  await expect(title).toBeFocused();
  await title.fill('버릴 초안');
  await title.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  await expect(title).toHaveValue('');
  await title.fill('새 로그인');
  await title.press('Enter');
  const origin = form.getByLabel('주소', { exact: true });
  await expect(origin).toBeFocused();
  await origin.fill('https://new.example.com');
  await page.getByLabel('사용자 이름').fill('new@example.com');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('사용자 이름과 비밀번호를 입력해 주세요.')).toBeVisible();
  await page.getByRole('button', { name: '자동 생성' }).click();
  const generated = await page.getByLabel('비밀번호').inputValue();
  expect(generated).toHaveLength(20);
  await page.getByRole('checkbox', { name: '연구원' }).check();
  await form.getByRole('button', { name: '저장', exact: true }).click();
  await expect(form.getByRole('alert')).toHaveText('금고에 저장하지 못했습니다.');
  await expect(form).not.toContainText(generated);
  await expect(form.getByLabel('비밀번호')).toHaveValue(generated);
  await expect(title).toHaveValue('새 로그인');
  await origin.press('Control+Enter');
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[0]).toMatchObject({
    kind: 'login', title: '새 로그인', origin: 'https://new.example.com', username: 'new@example.com',
    password: generated,
  });
  expect(posts[0]).not.toHaveProperty('totp');
  expect(posts[0]).not.toHaveProperty('card');
  expect(posts[0]).not.toHaveProperty('value');
  expect(posts[0].ghostIds).toEqual([researchGhostId]);
  await expect(page.getByText('금고 항목을 저장했습니다.')).toBeVisible();
});

test('API credential type transition and metadata edits stay write-only against the real Host', async ({ page, request }) => {
  const { baseUrl } = readRunState();
  const title = `API edit ${crypto.randomUUID()}`;
  const secret = `isolated-api-secret-${crypto.randomUUID()}`;
  let createdId: string | null = null;
  await page.goto(`${baseUrl}/#/settings?tab=vault`);
  const token = await page.evaluate(() => window.__GHOST_TOKEN__);
  const headers = { authorization: `Bearer ${token}` };
  try {
    await page.getByRole('button', { name: '새 항목', exact: true }).click();
    const create = page.getByRole('form', { name: '새 금고 항목', exact: true });
    await create.getByRole('textbox', { name: '항목 이름', exact: true }).fill(title);
    await create.getByRole('textbox', { name: '사용자 이름', exact: true }).fill('discarded-login-user');
    await create.getByLabel('비밀번호', { exact: true }).fill('discarded-login-password');
    await create.getByRole('combobox', { name: '항목 종류', exact: true }).selectOption('api');
    await create.getByRole('textbox', { name: '주소', exact: true }).fill('https://openapi.example.com');
    await create.getByRole('textbox', { name: '클라이언트 ID', exact: true }).fill('client-before');
    await create.getByLabel('비밀 키', { exact: true }).fill(secret);
    const creation = page.waitForResponse(response => new URL(response.url()).pathname === '/api/vault/items' && response.request().method() === 'POST');
    await create.getByRole('button', { name: '저장', exact: true }).click();
    const createdResponse = await creation;
    expect(createdResponse.status()).toBe(201);
    const created = await createdResponse.json() as VaultItem;
    createdId = created.id;
    expect(created).toMatchObject({ kind: 'api', title, origin: 'https://openapi.example.com', username: 'client-before' });
    expect(createdResponse.request().postDataJSON()).not.toHaveProperty('password');
    expect(JSON.stringify(created)).not.toContain(secret);

    const row = page.getByRole('article', { name: title, exact: true });
    await row.getByRole('button', { name: '고치기', exact: true }).click();
    const edit = page.getByRole('form', { name: '금고 항목 고치기', exact: true });
    await expect(edit.getByRole('textbox', { name: '클라이언트 ID', exact: true })).toHaveValue('client-before');
    await expect(edit.getByLabel('비밀 키', { exact: true })).toHaveValue('');
    await edit.getByRole('textbox', { name: '클라이언트 ID', exact: true }).fill('');
    await edit.getByRole('textbox', { name: '메모', exact: true }).fill('metadata-only edit');
    const update = page.waitForResponse(response => new URL(response.url()).pathname === `/api/vault/items/${createdId}` && response.request().method() === 'PATCH');
    await edit.getByRole('button', { name: '저장', exact: true }).click();
    const updatedResponse = await update;
    expect(updatedResponse.ok()).toBe(true);
    expect(updatedResponse.request().postDataJSON()).not.toHaveProperty('value');
    expect(updatedResponse.request().postDataJSON()).not.toHaveProperty('password');
    await page.reload();
    await row.getByRole('button', { name: '고치기', exact: true }).click();
    await expect(edit.getByRole('textbox', { name: '클라이언트 ID', exact: true })).toHaveValue('');
    await expect(edit.getByLabel('비밀 키', { exact: true })).toHaveValue('');
    await expect(edit.getByRole('textbox', { name: '메모', exact: true })).toHaveValue('metadata-only edit');
    const storedResponse = await request.get(`${baseUrl}/api/vault/items`, { headers });
    expect(storedResponse.ok()).toBe(true);
    const stored = await storedResponse.json() as { items: VaultItem[] };
    expect(stored.items.find(item => item.id === createdId)).toMatchObject({ kind: 'api', username: '', hints: 'metadata-only edit' });
    expect(JSON.stringify(stored)).not.toContain(secret);
  } finally {
    if (createdId) {
      const removed = await request.delete(`${baseUrl}/api/vault/items/${encodeURIComponent(createdId)}`, { headers });
      expect(removed.ok()).toBe(true);
    }
  }
});

test('CSV selection and drop preview metadata locally, then send the original file on confirmation', async ({ page }) => {
  const { baseUrl } = readRunState();
  const imports: Record<string, unknown>[] = [];
  await mockVaultApi(page);
  await page.route('**/api/vault/import', async route => {
    imports.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ imported: 1, skipped: 0, rejected: 0 }) });
  });
  await page.goto(`${baseUrl}/#/settings?tab=vault`);
  await page.getByRole('button', { name: 'CSV 가져오기' }).click();
  const preview = page.getByRole('region', { name: 'CSV 가져오기 미리보기' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    preview.getByRole('button', { name: '파일 고르기' }).click(),
  ]);
  await chooser.setFiles({ name: 'first.csv', mimeType: 'text/csv', buffer: Buffer.from('name,url,username,password\n첫 사이트,https://a.com,user,first-password') });
  await expect(preview.getByText('첫 사이트', { exact: true })).toBeVisible();
  await expect(preview).not.toContainText('first-password');
  const dropped = 'Title,URL,Username,Password,OTPAuth\n둘째 사이트,https://b.com/login?token=url-token,user,second-password,JBSWY3DPEHPK3PXP';
  const transfer = await page.evaluateHandle(csv => {
    const data = new DataTransfer();
    data.items.add(new File([csv], 'second.csv', { type: 'text/csv' }));
    return data;
  }, dropped);
  await preview.dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect(preview.getByText('둘째 사이트', { exact: true })).toBeVisible();
  await expect(preview.getByText('https://b.com · user', { exact: true })).toBeVisible();
  await expect(preview).not.toContainText(/첫 사이트|second-password|JBSWY3DPEHPK3PXP|url-token/);
  expect(imports).toHaveLength(0);
  await preview.getByRole('button', { name: '가져오기', exact: true }).click();
  await expect(page.getByText('가져옴 1 · 건너뜀 0 · 거부됨 0')).toBeVisible();
  await expect(preview).toHaveCount(0);
  expect(imports).toEqual([{ csv: dropped }]);
});
