import { expect, test, type Page, type Route } from '@playwright/test';
import type { MailMessage, MailSummary } from '../src/host/client';
import { openScreen } from './visual';

const summary = (subject: string, uid = 10): MailSummary => ({
  uid, messageId: `<${subject}@example.com>`, from: { name: 'Sender', address: 'sender@example.com' },
  to: [{ name: '', address: 'owner@example.com' }], subject, date: Date.UTC(2026, 10, 9),
  seen: false, flagged: false, answered: false, hasAttachments: false, size: 100,
});
const message = (subject: string, uid = 10): MailMessage => ({
  ...summary(subject, uid), uidValidity: 1, cc: [], replyTo: [], text: `${subject} body`, html: null, attachments: [],
});
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mailApi(page: Page) {
  const counts = new Map<string, number>();
  const updates: Record<string, unknown>[] = [];
  let hold: { matches: (url: URL) => boolean; resolve: (route: Route) => void } | null = null;
  await page.route('**/api/mail/**', async route => {
    const url = new URL(route.request().url());
    if (hold?.matches(url)) { const waiting = hold; hold = null; waiting.resolve(route); return; }
    if (url.pathname === '/api/mail/accounts') return json(route, { accounts: ['A', 'B'].map(id => ({ connectionId: id, name: `Account ${id}`, address: `${id}@example.com`, canSend: true })) });
    if (url.pathname.endsWith('/mailboxes')) return json(route, { mailboxes: [
      { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: 'inbox', total: 2, unseen: 1 },
      { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: 'archive', total: 0, unseen: 0 },
    ] });
    const account = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/messages')) {
      const key = `${account} ${url.searchParams.get('mailbox')} ${url.searchParams.get('q') ?? ''}`.trim();
      const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
      return json(route, { mailbox: url.searchParams.get('mailbox'), uidValidity: 1, messages: [summary(`${key} #${count}`, url.searchParams.has('before') ? 9 : 10)], nextBefore: url.searchParams.has('before') ? null : 10 });
    }
    if (url.pathname.endsWith('/message')) return json(route, message(`${account} read`, Number(url.searchParams.get('uid'))));
    return route.abort();
  });
  await page.route('**/api/commands', async route => {
    const { command } = route.request().postDataJSON();
    if (command.type !== 'mail.update') return route.continue();
    updates.push(command);
    return json(route, { ok: true, result: { updated: 1 } });
  });
  return {
    updates,
    holdNext(matches: (url: URL) => boolean) {
      const { promise, resolve } = Promise.withResolvers<Route>();
      hold = { matches, resolve };
      return promise;
    },
  };
}
async function openMail(page: Page) {
  await openScreen(page, { name: 'mail', route: () => '/mail', waits: () => [] }, 'light');
}
async function painted(page: Page) {
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    return promise;
  });
}
async function release(page: Page, route: Route, body: unknown, status = 200) {
  const response = page.waitForResponse(route.request().url());
  await json(route, body, status); await response; await painted(page);
}
const row = (page: Page, subject: string) => page.locator('.mail-row').filter({ hasText: subject });

test('late A list cannot replace B, or a newer A after A → B → A', async ({ page }) => {
  const api = await mailApi(page);
  const pending = api.holdNext(url => url.pathname.endsWith('/A/messages'));
  await openMail(page); const oldA = await pending;
  await page.getByRole('combobox', { name: '메일 계정' }).selectOption('B');
  await expect(row(page, 'B INBOX #1')).toBeVisible();
  await release(page, oldA, { messages: [summary('obsolete A')], nextBefore: null });
  await expect(row(page, 'B INBOX #1')).toBeVisible(); await expect(row(page, 'obsolete A')).toHaveCount(0);
  const next = api.holdNext(url => url.pathname.endsWith('/A/messages'));
  await page.getByRole('combobox', { name: '메일 계정' }).selectOption('A'); const firstA = await next;
  await page.getByRole('combobox', { name: '메일 계정' }).selectOption('B');
  await expect(row(page, 'B INBOX #2')).toBeVisible();
  await page.getByRole('combobox', { name: '메일 계정' }).selectOption('A');
  await expect(row(page, 'A INBOX #1')).toBeVisible();
  await release(page, firstA, { messages: [summary('obsolete returned A')], nextBefore: null });
  await expect(row(page, 'A INBOX #1')).toBeVisible(); await expect(row(page, 'obsolete returned A')).toHaveCount(0);
});

test('late query and mailbox failures cannot replace the current list', async ({ page }) => {
  const api = await mailApi(page); await openMail(page); await expect(row(page, 'A INBOX #1')).toBeVisible();
  const pending = api.holdNext(url => url.searchParams.get('q') === 'older');
  const search = page.getByRole('searchbox', { name: '메일 검색' });
  await search.fill('older'); await search.press('Enter'); const old = await pending;
  await search.fill('newer'); await search.press('Enter');
  await expect(row(page, 'A INBOX newer #1')).toBeVisible();
  await release(page, old, { error: { code: 'unavailable', message: 'obsolete search error' } }, 503);
  await expect(row(page, 'A INBOX newer #1')).toBeVisible(); await expect(page.getByText('obsolete search error')).toHaveCount(0);
  const mailboxPending = api.holdNext(url => url.searchParams.get('mailbox') === 'Archive');
  await page.getByRole('button', { name: '보관함', exact: true }).click(); const archive = await mailboxPending;
  await page.getByRole('button', { name: /받은편지함/ }).click(); await expect(row(page, 'A INBOX #2')).toBeVisible();
  await release(page, archive, { messages: [summary('obsolete archive')], nextBefore: null });
  await expect(row(page, 'A INBOX #2')).toBeVisible(); await expect(row(page, 'obsolete archive')).toHaveCount(0);
});

for (const failure of [false, true]) test(`late pagination ${failure ? 'failure' : 'page'} cannot affect a different account or its loading state`, async ({ page }) => {
  const api = await mailApi(page); await openMail(page); await expect(row(page, 'A INBOX #1')).toBeVisible();
  const pending = api.holdNext(url => url.pathname.endsWith('/A/messages') && url.searchParams.has('before'));
  await page.getByRole('button', { name: '이전 메일 더 보기' }).click(); const old = await pending;
  await page.getByRole('combobox', { name: '메일 계정' }).selectOption('B'); await expect(row(page, 'B INBOX #1')).toBeVisible();
  const currentPending = api.holdNext(url => url.pathname.endsWith('/B/messages') && url.searchParams.has('before'));
  await page.getByRole('button', { name: '이전 메일 더 보기' }).click(); const current = await currentPending;
  await release(page, old, failure ? { error: { code: 'unavailable', message: 'obsolete page error' } } : { messages: [summary('obsolete page', 9)], nextBefore: null }, failure ? 503 : 200);
  await expect(row(page, 'B INBOX #1')).toBeVisible(); await expect(page.getByRole('button', { name: '불러오는 중…' })).toBeDisabled();
  await expect(page.getByText('obsolete page error')).toHaveCount(0); await expect(row(page, 'obsolete page')).toHaveCount(0);
  await release(page, current, { messages: [summary('B older', 9)], nextBefore: null }); await expect(row(page, 'B older')).toBeVisible();
});

test('late read cannot expose A or issue seen/reply/archive commands under B', async ({ page }) => {
  const api = await mailApi(page); await openMail(page); await expect(row(page, 'A INBOX #1')).toBeVisible();
  const pending = api.holdNext(url => url.pathname.endsWith('/A/message'));
  await row(page, 'A INBOX #1').click(); const old = await pending;
  await page.getByRole('combobox', { name: '메일 계정' }).selectOption('B'); await row(page, 'B INBOX #1').click();
  await expect(page.getByRole('article', { name: '메일 읽기: B read' })).toBeVisible();
  await expect(page.getByRole('button', { name: '안읽음으로 표시', exact: true })).toBeEnabled();
  await release(page, old, message('A obsolete read'));
  await expect(page.getByRole('article', { name: '메일 읽기: B read' })).toBeVisible(); await expect(page.getByText('A obsolete read body')).toHaveCount(0);
  expect(api.updates).toHaveLength(1); expect(api.updates[0]).toMatchObject({ connectionId: 'B', action: 'seen', uids: [10] });
  await page.getByRole('button', { name: '답장', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '제목', exact: true })).toHaveValue('Re: B read');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '보관함으로 이동', exact: true }).click();
  await expect(row(page, 'B INBOX #1')).toHaveCount(0); expect(api.updates[1]).toMatchObject({ connectionId: 'B', action: 'archive' });
});

test('auto seen updates the reader once; unread restores the row and count once', async ({ page }) => {
  const api = await mailApi(page); await openMail(page); await row(page, 'A INBOX #1').click();
  await expect(page.getByRole('button', { name: '안읽음으로 표시', exact: true })).toBeEnabled();
  await expect(row(page, 'A INBOX #1')).not.toHaveAttribute('data-unread');
  await expect(page.locator('.mail-folder[aria-current] .mail-folder__count')).toHaveCount(0);
  await page.getByRole('button', { name: '안읽음으로 표시', exact: true }).click();
  await expect(page.getByRole('button', { name: '읽음으로 표시', exact: true })).toBeEnabled();
  await expect(row(page, 'A INBOX #1')).toHaveAttribute('data-unread');
  await expect(page.locator('.mail-folder[aria-current] .mail-folder__count')).toHaveText('1');
  expect(api.updates.map(command => command.action)).toEqual(['seen', 'unseen']);
});

test('late seen and manual mutation completions cannot modify the next selection', async ({ page }) => {
  await mailApi(page);
  let pending = Promise.withResolvers<Route>();
  await page.route('**/api/commands', async route => {
    const { command } = route.request().postDataJSON();
    if (command.type === 'mail.update' && command.connectionId === 'A') { pending.resolve(route); return; }
    return route.fallback();
  });
  await openMail(page); await row(page, 'A INBOX #1').click(); const oldSeen = await pending.promise;
  await page.getByRole('combobox', { name: '메일 계정' }).selectOption('B'); await row(page, 'B INBOX #1').click();
  await expect(page.getByRole('button', { name: '안읽음으로 표시', exact: true })).toBeEnabled();
  await release(page, oldSeen, { ok: true, result: { updated: 1 } });
  await expect(page.getByRole('article', { name: '메일 읽기: B read' })).toBeVisible();
  await expect(page.locator('.mail-folder[aria-current] .mail-folder__count')).toHaveCount(0);
  await page.getByRole('combobox', { name: '메일 계정' }).selectOption('A');
  // Serve the next A read as already seen, so the delayed operation is the owner's flag action.
  await page.route('**/api/mail/A/message?*', route => json(route, { ...message('A read'), seen: true }));
  await row(page, 'A INBOX #2').click(); await expect(page.getByRole('button', { name: '별표', exact: true })).toBeEnabled();
  pending = Promise.withResolvers<Route>();
  await page.getByRole('button', { name: '별표', exact: true }).click(); const oldFlag = await pending.promise;
  await page.getByRole('combobox', { name: '메일 계정' }).selectOption('B'); await row(page, 'B INBOX #2').click();
  await expect(page.getByRole('button', { name: '안읽음으로 표시', exact: true })).toBeEnabled();
  await release(page, oldFlag, { ok: true, result: { updated: 1 } });
  await expect(page.getByRole('button', { name: '별표', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(row(page, 'B INBOX #2').getByLabel('별표 메일')).toHaveCount(0);
});

test('lost send response locks the preserved draft and retries the identical receipt, not a new send', async ({ page }) => {
  await mailApi(page);
  const requests: { requestId: string; command: unknown }[] = [];
  const receipts = new Map<string, { messageId: string }>(); let deliveries = 0;
  await page.route('**/api/commands', async route => {
    const request = route.request().postDataJSON();
    if (request.command.type !== 'mail.send') return route.fallback();
    requests.push(request);
    if (!receipts.has(request.requestId)) { deliveries++; receipts.set(request.requestId, { messageId: '<accepted@example.com>' }); }
    if (requests.length === 1) return route.abort('failed');
    return json(route, { ok: true, result: receipts.get(request.requestId) });
  });
  await openMail(page); await expect(row(page, 'A INBOX #1')).toBeVisible();
  await page.getByRole('button', { name: '메일 쓰기', exact: true }).click();
  await page.getByRole('textbox', { name: '받는 사람', exact: true }).fill('recipient@example.com');
  await page.getByRole('textbox', { name: '제목', exact: true }).fill('Keep this subject');
  await page.getByRole('textbox', { name: '본문', exact: true }).fill('Keep this body');
  await page.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(page.getByText(/전송 결과를 확인하지 못했습니다/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: '제목', exact: true })).toHaveValue('Keep this subject');
  await expect(page.getByRole('textbox', { name: '본문', exact: true })).toHaveValue('Keep this body');
  await expect(page.getByRole('textbox', { name: '제목', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '본문', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '전송 상태 확인', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '메일 쓰기', exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(deliveries).toBe(1);
});

test('known validation refusal preserves an editable draft without uncertain-delivery copy', async ({ page }) => {
  await mailApi(page);
  await page.route('**/api/commands', route => route.request().postDataJSON().command.type === 'mail.send'
    ? json(route, { ok: false, error: { code: 'invalid', message: '받는 주소를 확인해 주세요.' } }) : route.fallback());
  await openMail(page); await expect(row(page, 'A INBOX #1')).toBeVisible(); await page.getByRole('button', { name: '메일 쓰기', exact: true }).click();
  await page.getByRole('textbox', { name: '받는 사람', exact: true }).fill('recipient@example.com');
  await page.getByRole('textbox', { name: '제목', exact: true }).fill('Preserved'); await page.getByRole('textbox', { name: '본문', exact: true }).fill('Body');
  await page.getByRole('button', { name: '보내기', exact: true }).click(); await expect(page.getByText('보내지 않았습니다. 받는 주소를 확인해 주세요.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '제목', exact: true })).toBeEnabled(); await expect(page.getByRole('textbox', { name: '제목', exact: true })).toHaveValue('Preserved');
  await expect(page.getByRole('button', { name: '전송 상태 확인', exact: true })).toHaveCount(0);
});

test('a narrow native Mac window retains mailbox selection, compose, and reader back controls', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { invoke: async (command: string) => command === 'companion_enabled' ? false : undefined } });
  });
  await mailApi(page); await openMail(page); await expect(row(page, 'A INBOX #1')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-desktop-shell', '');
  await expect(page.getByRole('combobox', { name: '메일함', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '메일함', exact: true }).selectOption('Archive'); await expect(row(page, 'A Archive #1')).toBeVisible();
  await page.getByRole('button', { name: '메일 쓰기', exact: true }).filter({ visible: true }).click(); await expect(page.getByRole('dialog', { name: '메일 쓰기', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '취소', exact: true }).click(); await row(page, 'A Archive #1').click();
  await expect(page.getByRole('article', { name: '메일 읽기: A read' })).toBeVisible(); await page.getByRole('button', { name: '목록', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '메일함', exact: true })).toBeVisible();
});

test('closing a pending read invalidates it before the same UID is opened again', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  const api = await mailApi(page); await openMail(page); await expect(row(page, 'A INBOX #1')).toBeVisible();
  const pending = api.holdNext(url => url.pathname.endsWith('/A/message'));
  await row(page, 'A INBOX #1').click(); const old = await pending;
  await page.getByRole('button', { name: '목록으로', exact: true }).click();
  await row(page, 'A INBOX #1').click();
  await expect(page.getByRole('article', { name: '메일 읽기: A read' })).toBeVisible();
  await expect(page.getByRole('button', { name: '안읽음으로 표시', exact: true })).toBeEnabled();
  await release(page, old, message('obsolete closed read'));
  await expect(page.getByRole('article', { name: '메일 읽기: A read' })).toBeVisible();
  await expect(page.getByText('obsolete closed read body')).toHaveCount(0);
  expect(api.updates).toHaveLength(1);
});

test('mail empty-state opens the shared account setup with service-specific mail and custom server options', async ({ page }) => {
  await page.route('**/api/mail/accounts', route => json(route, { accounts: [] }));
  await openMail(page);
  await page.getByRole('button', { name: '메일 계정 연결', exact: true }).click();
  await expect(page).toHaveURL(/#\/settings\?tab=connections$/);
  await page.getByRole('button', { name: 'Gmail', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Gmail 연결', exact: true });
  await expect(dialog.getByRole('textbox', { name: '메일 주소', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '고급 설정', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'IMAP 서버', exact: true })).toHaveValue('imap.gmail.com');
  await expect(dialog.getByRole('textbox', { name: 'SMTP 서버', exact: true })).toHaveValue('smtp.gmail.com');
});
