import { test, expect, type Page } from '@playwright/test';
import { readRunState } from './run-state';
import { mockStateDecisions, mockVaultApi, visualSecureDecisionId, visualHandoffDecisionId } from './mocks';

/**
 * Functional checks for the vault and secure-form surfaces. The host API they need
 * is mocked at the network layer, so these run against the seeded isolated host no
 * matter which side of the integration lands first.
 */

interface CommandBody { command?: { type?: string; outcome?: string; decisionId?: string; answer?: string } }

async function recordCommands(page: Page, commands: (CommandBody['command'])[]): Promise<void> {
  await page.route('**/api/commands', async route => {
    commands.push((route.request().postDataJSON() as CommandBody).command);
    await route.continue();
  });
}

test('a secure form answers through the vault route and never through the answer API', async ({ page }) => {
  const { baseUrl } = readRunState();
  const vaultAnswers: unknown[] = [];
  const commands: CommandBody['command'][] = [];
  await mockStateDecisions(page);
  await recordCommands(page, commands);
  await page.route('**/api/vault/requests/*', async route => {
    vaultAnswers.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${baseUrl}/#/inbox?decision=${visualSecureDecisionId}`);
  await expect(page.getByRole('button', { name: '금고에 전달' })).toBeVisible();
  // The chat answer path is not on the card.
  await expect(page.getByLabel('답변')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '금고에 저장' })).toBeChecked();
  await page.getByLabel('사용자 이름').fill('owner@example.com');
  await page.getByLabel('비밀번호', { exact: true }).fill('비밀1234!@#');
  await page.getByRole('button', { name: '금고에 전달' }).click();
  await expect.poll(() => vaultAnswers).toEqual([{ username: 'owner@example.com', password: '비밀1234!@#', save: true }]);
  expect(commands).toEqual([]);
});

test('unchecking 저장 sends save:false and declining takes the ordinary deny path', async ({ page }) => {
  const { baseUrl } = readRunState();
  const vaultAnswers: unknown[] = [];
  const commands: CommandBody['command'][] = [];
  await mockStateDecisions(page);
  await recordCommands(page, commands);
  await page.route('**/api/vault/requests/*', async route => {
    vaultAnswers.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${baseUrl}/#/inbox?decision=${visualSecureDecisionId}`);
  await page.getByLabel('사용자 이름').fill('owner@example.com');
  await page.getByLabel('비밀번호', { exact: true }).fill('비밀1234!@#');
  await page.getByRole('checkbox', { name: '금고에 저장' }).uncheck();
  await page.getByRole('button', { name: '금고에 전달' }).click();
  await expect.poll(() => vaultAnswers).toEqual([{ username: 'owner@example.com', password: '비밀1234!@#', save: false }]);
  expect(commands).toEqual([]);
  await page.getByRole('button', { name: '거부' }).click();
  await expect.poll(() => commands[0]).toMatchObject({ type: 'decision.resolve', outcome: 'deny', decisionId: visualSecureDecisionId });
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

test('editing an item keeps stored secrets out of the body and shows them as 저장됨', async ({ page }) => {
  const { baseUrl, researchGhostId, scribeGhostId } = readRunState();
  await mockVaultApi(page);
  const patches: Record<string, unknown>[] = [];
  await page.route('**/api/vault/items/v-login', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patches.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${baseUrl}/#/settings?tab=vault`);
  await expect(page.getByText('서비스 로그인')).toBeVisible();
  await page.getByRole('button', { name: '고치기' }).first().click();
  await expect(page.getByRole('heading', { name: '금고 항목 고치기' })).toBeVisible();
  // Stored secrets come back as words, never as values.
  await expect(page.getByLabel('비밀번호', { exact: true })).toHaveValue('');
  await expect(page.getByText('저장됨 · 새 값을 입력하면 바꿉니다.').first()).toBeVisible();
  await page.getByRole('button', { name: '자동 생성' }).click();
  const generated = await page.getByLabel('비밀번호', { exact: true }).inputValue();
  expect(generated).toMatch(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%^&*_=+-]{20}$/);
  await page.getByRole('checkbox', { name: '기록가' }).check();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({
    kind: 'login', title: '서비스 로그인', origin: 'https://app.example.com', username: 'owner@example.com',
    password: generated, totp: undefined, card: undefined, value: undefined, hints: '업무용 계정',
  });
  expect([...patches[0].ghostIds as string[]].sort()).toEqual([researchGhostId, scribeGhostId].sort());
  await expect(page.getByText('금고 항목을 저장했습니다.')).toBeVisible();
});

test('creating a login demands its primary fields and stores the generated password', async ({ page }) => {
  const { baseUrl, researchGhostId } = readRunState();
  const posts: Record<string, unknown>[] = [];
  await mockVaultApi(page);
  await page.route('**/api/vault/items', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${baseUrl}/#/settings?tab=vault`);
  await page.getByRole('button', { name: '새 항목' }).click();
  await expect(page.getByRole('heading', { name: '새 금고 항목' })).toBeVisible();
  await page.getByLabel('이름').fill('새 로그인');
  await page.getByLabel('주소').fill('https://new.example.com');
  await page.getByLabel('사용자 이름').fill('new@example.com');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('사용자 이름과 비밀번호를 입력해 주세요.')).toBeVisible();
  await page.getByRole('button', { name: '자동 생성' }).click();
  const generated = await page.getByLabel('비밀번호', { exact: true }).inputValue();
  expect(generated).toHaveLength(20);
  await page.getByRole('checkbox', { name: '연구원' }).check();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({
    kind: 'login', title: '새 로그인', origin: 'https://new.example.com', username: 'new@example.com',
    password: generated, totp: undefined, card: undefined, value: undefined,
  });
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
