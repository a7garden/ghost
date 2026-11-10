import { test, expect, type Page } from '@playwright/test';
import { readRunState } from './run-state';
import { mockStateDecisions, mockVaultApi, validateVaultWrite, visualSecureDecisionId, visualHandoffDecisionId } from './mocks';

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
  const { baseUrl } = readRunState();
  const vaultAnswers: Record<string, unknown>[] = [];
  const commands: CommandBody['command'][] = [];
  await mockStateDecisions(page);
  await recordCommands(page, commands);
  await mockVaultRequest(page, vaultAnswers);
  await page.goto(`${baseUrl}/#/inbox?decision=${visualSecureDecisionId}`);
  await expect(page.getByRole('button', { name: '금고에 전달' })).toBeVisible();
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
  await expect(page.getByText('Chrome 창을 열어 두었습니다')).toBeVisible();
  await page.getByRole('button', { name: '다 했어요' }).click();
  await expect.poll(() => commands[0]).toMatchObject({ type: 'decision.resolve', outcome: 'answer', answer: '다 했어요' });
});

test('a live handoff without a native window keeps input available in Ghost', async ({ page }) => {
  const { baseUrl } = readRunState();
  await mockStateDecisions(page, true);
  await page.route('**/api/browser/handoffs/*/frame', route => route.fulfill({ json: {
    image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=',
    mediaType: 'image/jpeg', width: 1280, height: 720, url: 'https://example.com/', title: 'Example Domain', windowAvailable: false,
  } }));
  await page.goto(`${baseUrl}/#/inbox?decision=${visualHandoffDecisionId}`);
  await expect(page.getByRole('img', { name: '브라우저 화면: Example Domain' })).toBeVisible();
  await expect(page.getByLabel('브라우저에 입력할 글자')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Mac 앞이라면 Chrome 창으로 열기' })).toHaveCount(0);
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
  await page.getByRole('button', { name: '승인', exact: true }).dblclick();
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
  await expect(page.getByText('서비스 로그인')).toBeVisible();
  await page.getByRole('button', { name: '고치기' }).first().click();
  await expect(page.getByRole('heading', { name: '금고 항목 고치기' })).toBeVisible();
  // Stored secrets come back as words, never as values.
  await expect(page.getByLabel('비밀번호')).toHaveValue('');
  await expect(page.getByText('저장됨 · 새 값을 입력하면 바꿉니다.').first()).toBeVisible();
  await page.getByRole('button', { name: '자동 생성' }).click();
  const generated = await page.getByLabel('비밀번호').inputValue();
  expect(generated).toMatch(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%^&*_=+-]{20}$/);
  await page.getByRole('checkbox', { name: '기록가' }).check();
  await page.getByRole('button', { name: '저장', exact: true }).click();
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
    return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${baseUrl}/#/settings?tab=vault`);
  await page.getByRole('button', { name: '새 항목' }).click();
  await expect(page.getByRole('heading', { name: '새 금고 항목' })).toBeVisible();
  await page.getByRole('textbox', { name: '이름', exact: true }).fill('새 로그인');
  await page.getByLabel('주소', { exact: true }).fill('https://new.example.com');
  await page.getByLabel('사용자 이름').fill('new@example.com');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('사용자 이름과 비밀번호를 입력해 주세요.')).toBeVisible();
  await page.getByRole('button', { name: '자동 생성' }).click();
  const generated = await page.getByLabel('비밀번호').inputValue();
  expect(generated).toHaveLength(20);
  await page.getByRole('checkbox', { name: '연구원' }).check();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
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

test('CSV import posts the file text once and reports the counts', async ({ page }) => {
  const { baseUrl } = readRunState();
  const imports: Record<string, unknown>[] = [];
  await mockVaultApi(page);
  await page.route('**/api/vault/import', async route => {
    imports.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ imported: 2, skipped: 1, rejected: 0 }) });
  });
  await page.goto(`${baseUrl}/#/settings?tab=vault`);
  await page.getByRole('button', { name: 'CSV 가져오기' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '파일 고르기' }).click(),
  ]);
  await chooser.setFiles({ name: 'passwords.csv', mimeType: 'text/csv', buffer: Buffer.from('Title,URL,Username,Password\n사이트,https://a.com,user,pw') });
  await expect(page.getByText('가져옴 2 · 건너뜀 1 · 거부됨 0')).toBeVisible();
  await expect.poll(() => imports.length).toBe(1);
  expect(String(imports[0].csv)).toContain('사이트,https://a.com,user,pw');
});
