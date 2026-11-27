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

/** `view` is the remembered mail view the screen opens on; `null` leaves a first visit, which opens 전체 계정. */
async function mailApi(page: Page, view: string | null = 'A') {
  if (view) await page.addInitScript(value => localStorage.setItem('ghost-mail:view', value), view);
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

test('HTML mail stays readable without automatic remote requests or navigation', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  const remote = 'https://mail-navigation.invalid';
  const remoteRequests: string[] = [];
  const remoteNavigations: string[] = [];
  await page.context().route(`${remote}/**`, route => route.fulfill({
    contentType: 'text/html', body: '<p>Unexpected remote document</p>',
  }));
  page.on('request', request => {
    if (request.url().startsWith(remote)) remoteRequests.push(request.url());
  });
  page.on('framenavigated', frame => {
    if (frame.url().startsWith(remote)) remoteNavigations.push(frame.url());
  });
  const api = await mailApi(page);
  await openMail(page);
  const pending = api.holdNext(url => url.pathname.endsWith('/A/message'));
  await row(page, 'A INBOX #1').click();
  await release(page, await pending, {
    ...message('Hostile HTML'),
    cc: [{ name: 'Copied recipient', address: 'copy@example.com' }],
    text: 'Safe plain text',
    html: `<!doctype html><html><head>
      <mEtA HTTP-EQUIV="rEfReSh" content="0; URL=${remote}/refresh">
      <base href="${remote}/base/" target="_top">
      <link rel="stylesheet" href="${remote}/stylesheet">
      <link rel="preload" as="image" href="${remote}/preload">
      <link rel="preconnect" href="${remote}">
      <style>@import url("${remote}/import"); .safe-mail { color: rgb(12, 34, 56); } table { width: 240px; }</style>
      </head><body style="padding: 17px">
      <noscript><meta http-equiv="refresh" content="0; URL=${remote}/noscript"></noscript>
      <table><tr><td class="safe-mail">Safe HTML text</td></tr></table>
      <img src="${remote}/pixel" alt="">
      <iframe src="${remote}/child" title="Unexpected remote frame"></iframe>
      <a href="${remote}/manual">Explicit user link</a>
      </body></html>`,
  });
  await expect(page.locator('.mail-reader__text')).toHaveText('Safe plain text');
  await expect(page.locator('.mail-reader__frame')).toHaveCount(0);
  const copyRecipient = page.getByText('Copied recipient <copy@example.com>', { exact: true });
  await expect(copyRecipient).not.toBeVisible();
  await page.getByRole('button', { name: '주소 보기', exact: true }).click();
  await expect(copyRecipient).toBeVisible();
  await page.getByRole('button', { name: 'HTML 보기', exact: true }).click();
  const frame = page.locator('.mail-reader__frame');
  const body = frame.contentFrame();
  await expect(body.getByText('Safe HTML text', { exact: true })).toBeVisible();
  await expect(body.locator('.safe-mail')).toHaveCSS('color', 'rgb(12, 34, 56)');
  await expect(body.locator('table')).toHaveCSS('width', '240px');
  await expect(body.locator('body')).toHaveCSS('padding', '17px');
  await expect(body.getByRole('link', { name: 'Explicit user link' })).toHaveAttribute('href', `${remote}/manual`);
  // Readiness is established above; observe a window for zero-delay refresh and speculative loads.
  await page.waitForTimeout(1_000);
  expect(remoteRequests).toEqual([]);
  expect(remoteNavigations).toEqual([]);
  expect(page.frames().filter(candidate => candidate.parentFrame()).map(candidate => candidate.url())).toEqual(['about:srcdoc']);
  await expect(body.getByText('Safe HTML text', { exact: true })).toBeVisible();
});
const row = (page: Page, subject: string) => page.locator('.mail-row').filter({ hasText: subject });
const accountTab = (page: Page, id: string) => page.getByRole('navigation', { name: '메일 계정', exact: true })
  .getByRole('button', { name: `Account ${id}`, exact: true });
const folders = (page: Page) => page.getByRole('navigation', { name: '메일함', exact: true });
const unseen = (page: Page) => folders(page).locator('[aria-current="true"] .mail-tab__count');

test('late A list cannot replace B, or a newer A after A → B → A', async ({ page }) => {
  const api = await mailApi(page);
  const pending = api.holdNext(url => url.pathname.endsWith('/A/messages'));
  await openMail(page); const oldA = await pending;
  await accountTab(page, 'B').click();
  await expect(row(page, 'B INBOX #1')).toBeVisible();
  await release(page, oldA, { messages: [summary('obsolete A')], nextBefore: null });
  await expect(row(page, 'B INBOX #1')).toBeVisible(); await expect(row(page, 'obsolete A')).toHaveCount(0);
  const next = api.holdNext(url => url.pathname.endsWith('/A/messages'));
  await accountTab(page, 'A').click(); const firstA = await next;
  await accountTab(page, 'B').click();
  await expect(row(page, 'B INBOX #2')).toBeVisible();
  await accountTab(page, 'A').click();
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
  await accountTab(page, 'B').click(); await expect(row(page, 'B INBOX #1')).toBeVisible();
  const currentPending = api.holdNext(url => url.pathname.endsWith('/B/messages') && url.searchParams.has('before'));
  await page.getByRole('button', { name: '이전 메일 더 보기' }).click(); const current = await currentPending;
  await release(page, old, failure ? { error: { code: 'unavailable', message: 'obsolete page error' } } : { messages: [summary('obsolete page', 9)], nextBefore: null }, failure ? 503 : 200);
  await expect(row(page, 'B INBOX #1')).toBeVisible(); await expect(page.getByRole('button', { name: '불러오는 중…' })).toBeDisabled();
  await expect(page.getByText('obsolete page error')).toHaveCount(0); await expect(row(page, 'obsolete page')).toHaveCount(0);
  await release(page, current, { messages: [summary('B older', 9)], nextBefore: null }); await expect(row(page, 'B older')).toBeVisible();
});

test('late read cannot expose A or issue seen/reply/archive commands under B', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await mailApi(page);
  const pending = api.holdNext(url => url.pathname.endsWith('/A/message'));
  await openMail(page); const old = await pending;
  await row(page, 'A INBOX #1').click();
  await accountTab(page, 'B').click(); await row(page, 'B INBOX #1').click();
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

test('the wide preview stays unread; opening it marks seen once and unread restores the row and count', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await mailApi(page);
  await page.route('**/api/mail/A/messages?*', route => json(route, {
    mailbox: 'INBOX', uidValidity: 1, nextBefore: null,
    messages: [{ ...summary('Already seen', 11), seen: true }, summary('A INBOX #1')],
  }));
  await openMail(page);
  const mail = row(page, 'A INBOX #1');
  await expect(page.locator('.mail-row').first()).toContainText('Already seen');
  await expect(page.getByRole('article', { name: '메일 읽기: A read' })).toBeVisible();
  await expect(mail).toHaveAttribute('aria-current', 'true');
  await expect(mail).toHaveAttribute('data-unread');
  await expect(unseen(page)).toHaveText('1');
  expect(api.updates).toHaveLength(0);
  await mail.click();
  await expect(page.getByRole('button', { name: '안읽음으로 표시', exact: true })).toBeEnabled();
  await expect(row(page, 'A INBOX #1')).not.toHaveAttribute('data-unread');
  await expect(unseen(page)).toHaveCount(0);
  await page.getByRole('button', { name: '안읽음으로 표시', exact: true }).click();
  await expect(page.getByRole('button', { name: '읽음으로 표시', exact: true })).toBeEnabled();
  await expect(row(page, 'A INBOX #1')).toHaveAttribute('data-unread');
  await expect(unseen(page)).toHaveText('1');
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
  await accountTab(page, 'B').click(); await row(page, 'B INBOX #1').click();
  await expect(page.getByRole('button', { name: '안읽음으로 표시', exact: true })).toBeEnabled();
  await release(page, oldSeen, { ok: true, result: { updated: 1 } });
  await expect(page.getByRole('article', { name: '메일 읽기: B read' })).toBeVisible();
  await expect(unseen(page)).toHaveCount(0);
  // Serve the next A read as already seen, so the delayed operation is the owner's flag action.
  await page.route('**/api/mail/A/message?*', route => json(route, { ...message('A read'), seen: true }));
  await accountTab(page, 'A').click();
  await row(page, 'A INBOX #2').click(); await expect(page.getByRole('button', { name: '별표', exact: true })).toBeEnabled();
  pending = Promise.withResolvers<Route>();
  await page.getByRole('button', { name: '별표', exact: true }).click(); const oldFlag = await pending.promise;
  await accountTab(page, 'B').click(); await row(page, 'B INBOX #2').click();
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
  const letter = page.getByRole('form', { name: '메일 쓰기', exact: true });
  await expect(letter).toBeVisible();
  await expect(page.getByRole('dialog', { name: '메일 쓰기', exact: true })).toHaveCount(0);
  await letter.getByRole('textbox', { name: '받는 사람', exact: true }).fill('recipient@example.com');
  await letter.getByRole('textbox', { name: '제목', exact: true }).fill('Keep this subject');
  await letter.getByRole('textbox', { name: '본문', exact: true }).fill('Keep this body');
  await letter.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(letter.getByRole('textbox', { name: '제목', exact: true })).toHaveValue('Keep this subject');
  await expect(letter.getByRole('textbox', { name: '본문', exact: true })).toHaveValue('Keep this body');
  await expect(letter.getByRole('textbox', { name: '제목', exact: true })).toBeDisabled();
  await expect(letter.getByRole('textbox', { name: '본문', exact: true })).toBeDisabled();
  await letter.getByRole('button', { name: '전송 상태 확인', exact: true }).click();
  await expect(letter).toHaveCount(0);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(deliveries).toBe(1);
});

test('known validation refusal preserves an editable draft', async ({ page }) => {
  await mailApi(page);
  await page.route('**/api/commands', route => route.request().postDataJSON().command.type === 'mail.send'
    ? json(route, { ok: false, error: { code: 'invalid', message: '받는 주소를 확인해 주세요.' } }) : route.fallback());
  await openMail(page); await expect(row(page, 'A INBOX #1')).toBeVisible(); await page.getByRole('button', { name: '메일 쓰기', exact: true }).click();
  await page.getByRole('textbox', { name: '받는 사람', exact: true }).fill('recipient@example.com');
  await page.getByRole('textbox', { name: '제목', exact: true }).fill('Preserved'); await page.getByRole('textbox', { name: '본문', exact: true }).fill('Body');
  const refused = page.waitForResponse(response => response.url().endsWith('/api/commands')
    && response.request().postDataJSON().command.type === 'mail.send');
  await page.getByRole('button', { name: '보내기', exact: true }).click();
  await refused; await painted(page);
  await expect(page.getByRole('form', { name: '메일 쓰기', exact: true }).getByText('보내지 않았습니다. 받는 주소를 확인해 주세요.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '제목', exact: true })).toBeEnabled(); await expect(page.getByRole('textbox', { name: '제목', exact: true })).toHaveValue('Preserved');
  await expect(page.getByRole('button', { name: '전송 상태 확인', exact: true })).toHaveCount(0);
});

test('phone stacks account and mailbox tabs in two rows and restores the scrolled list on Back', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mailApi(page);
  await page.route('**/api/mail/B/messages?mailbox=Archive**', route => json(route, {
    mailbox: 'Archive', uidValidity: 1, nextBefore: null,
    messages: [...Array.from({ length: 12 }, (_, index) => summary(`Earlier mail ${index}`, 30 - index)), summary('B Archive #1')],
  }));
  await openMail(page);
  const account = page.getByRole('navigation', { name: '메일 계정', exact: true });
  const folder = folders(page);
  const archive = folder.getByRole('button', { name: '보관함', exact: true });
  await accountTab(page, 'B').click();
  await archive.click();
  const mail = row(page, 'B Archive #1');
  const a = (await account.boundingBox())!, b = (await folder.boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
  expect(Math.abs(b.x - a.x)).toBeLessThan(2);
  await expect(page.getByRole('article', { name: /메일 읽기/ })).toHaveCount(0);
  const scroll = page.locator('.mail-list__scroll');
  await mail.scrollIntoViewIfNeeded();
  const top = await scroll.evaluate(element => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await mail.click();
  await expect(page.getByRole('article', { name: '메일 읽기: B read' })).toBeVisible();
  await page.getByRole('button', { name: '목록', exact: true }).click();
  await expect(scroll).toHaveJSProperty('scrollTop', top);
  await expect(mail).toBeFocused();
  await expect(archive).toHaveAttribute('aria-current', 'true');
});

test('메일함 이동 opens under the message actions and can be dismissed or chosen by keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await mailApi(page);
  let refused = false;
  await page.route('**/api/commands', async route => {
    const { command } = route.request().postDataJSON();
    if (command.type !== 'mail.update' || command.action !== 'move' || refused) return route.fallback();
    refused = true;
    return json(route, { ok: false, error: { code: 'invalid', message: '메일을 옮기지 못했습니다.' } });
  });
  await openMail(page); await row(page, 'A INBOX #1').click();
  const reader = page.getByRole('article', { name: '메일 읽기: A read' });
  const move = reader.getByRole('button', { name: '메일함 이동', exact: true });
  const destinations = reader.getByRole('group', { name: '이동할 메일함', exact: true });
  const archive = destinations.getByRole('button', { name: '보관함', exact: true });
  await expect(move).toBeEnabled();
  await move.press('Enter');
  await expect(move).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog', { name: '메일함 이동' })).toHaveCount(0);
  await expect(destinations.getByRole('button', { name: '받은편지함', exact: true })).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(archive).toBeFocused();
  await archive.press('Escape');
  await expect(destinations).toHaveCount(0);
  await expect(move).toBeFocused();
  await move.click();
  await destinations.getByRole('button', { name: '취소', exact: true }).click();
  await expect(move).toHaveAttribute('aria-expanded', 'false');
  await move.press('Enter');
  await archive.press('Enter');
  await expect(reader.getByText('메일을 옮기지 못했습니다.')).toBeVisible();
  await expect(archive).toBeEnabled();
  await archive.press('Enter');
  await expect(reader).toHaveCount(0);
  expect(api.updates.at(-1)).toMatchObject({ connectionId: 'A', mailbox: 'INBOX', uids: [10], action: 'move', target: 'Archive' });
});

test('a narrow native Mac window retains mailbox selection, compose, and reader back controls', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { invoke: async (command: string) => command === 'companion_enabled' ? false : undefined } });
  });
  await mailApi(page);
  await page.route('**/api/mail/accounts', route => json(route, { accounts: ['A', 'B', 'C', 'D', 'E'].map(id => ({
    connectionId: id, name: `Account ${id}`, address: `${id}@example.com`, canSend: true,
  })) }));
  await page.route('**/api/mail/A/mailboxes', route => json(route, { mailboxes: [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: 'inbox', total: 2, unseen: 1 },
    { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: 'archive', total: 0, unseen: 0 },
    { path: 'Drafts', name: 'Drafts', delimiter: '/', specialUse: 'drafts', total: null, unseen: null },
  ] }));
  await openMail(page); await expect(row(page, 'A INBOX #1')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-desktop-shell', '');
  await accountTab(page, 'A').click();
  const picker = page.getByRole('dialog', { name: '메일 계정 선택' });
  const search = picker.getByRole('searchbox');
  await expect(search).toBeFocused();
  await search.fill('E@example.com');
  await expect(picker.getByRole('button', { name: /^Account/ })).toHaveCount(1);
  await search.press('Escape');
  await expect(accountTab(page, 'A')).toBeFocused();
  await folders(page).getByRole('button', { name: '더보기', exact: true }).click();
  await page.getByRole('dialog', { name: '다른 메일함' }).getByRole('button', { name: '임시보관함', exact: true }).click();
  await expect(row(page, 'A Drafts #1')).toBeVisible();
  await expect(folders(page).getByRole('button', { name: '임시보관함', exact: true })).toHaveAttribute('aria-current', 'true');
  await folders(page).getByRole('button', { name: '보관함', exact: true }).click(); await expect(row(page, 'A Archive #1')).toBeVisible();
  const write = page.getByRole('button', { name: '메일 쓰기', exact: true });
  await write.click();
  const letter = page.getByRole('form', { name: '메일 쓰기', exact: true });
  const recipient = letter.getByRole('textbox', { name: '받는 사람', exact: true });
  await expect(recipient).toBeFocused();
  await recipient.press('Enter');
  const subject = letter.getByRole('textbox', { name: '제목', exact: true });
  await expect(subject).toBeFocused();
  await subject.press('Enter');
  await expect(letter.getByRole('textbox', { name: '본문', exact: true })).toBeFocused();
  await letter.getByRole('button', { name: '취소', exact: true }).click();
  await expect(write).toBeFocused();
  await row(page, 'A Archive #1').click();
  await expect(page.getByRole('article', { name: '메일 읽기: A read' })).toBeVisible(); await page.getByRole('button', { name: '목록', exact: true }).click();
  await expect(folders(page).getByRole('button', { name: '보관함', exact: true })).toHaveAttribute('aria-current', 'true');
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

test('mail empty-state opens the shared account setup, where an address brings its servers and a seeded provider asks only for the name', async ({ page }) => {
  await page.route('**/api/mail/accounts', route => json(route, { accounts: [] }));
  await openMail(page);
  await page.getByRole('button', { name: '메일 계정 연결', exact: true }).click();
  await expect(page).toHaveURL(/#\/settings\?tab=connections$/);
  await page.getByRole('textbox', { name: '서비스 추가', exact: true }).fill('Gmail');
  await page.getByRole('button', { name: 'Gmail 연결', exact: true }).click();
  const setup = page.getByRole('region', { name: '이메일 연결', exact: true });
  await expect(page.getByRole('dialog', { name: '이메일 연결', exact: true })).toHaveCount(0);
  const address = setup.getByRole('textbox', { name: '이메일 주소', exact: true });
  await expect(address).toHaveAttribute('placeholder', '이름@gmail.com');
  await address.fill('owner');
  await expect(setup.locator('.mail-provider')).toContainText('owner@gmail.com');
  await setup.getByRole('button', { name: '서버 설정', exact: true }).click();
  await expect(setup.getByRole('textbox', { name: 'IMAP 서버', exact: true })).toHaveValue('imap.gmail.com');
  await expect(setup.getByRole('textbox', { name: 'SMTP 서버', exact: true })).toHaveValue('smtp.gmail.com');
});

test('first visit with two accounts opens the merged inbox; reading one account\'s message marks only that account\'s row', async ({ page }) => {
  const api = await mailApi(page, null); await openMail(page);
  await expect(row(page, 'A INBOX #1')).toBeVisible(); await expect(row(page, 'B INBOX #1')).toBeVisible();
  await expect(row(page, 'A INBOX #1').locator('.mail-row__account')).toHaveText('Account A');
  await expect(row(page, 'B INBOX #1').locator('.mail-row__account')).toHaveText('Account B');
  await row(page, 'A INBOX #1').press('j');
  await expect(page.getByRole('article', { name: '메일 읽기: B read' })).toBeVisible();
  await expect(page.getByRole('button', { name: '안읽음으로 표시', exact: true })).toBeEnabled();
  expect(api.updates).toHaveLength(1); expect(api.updates[0]).toMatchObject({ connectionId: 'B', mailbox: 'INBOX', action: 'seen', uids: [10] });
  await expect(row(page, 'B INBOX #1')).not.toHaveAttribute('data-unread'); await expect(row(page, 'A INBOX #1')).toHaveAttribute('data-unread');
  await page.getByRole('button', { name: '보관함으로 이동', exact: true }).click();
  await expect(row(page, 'B INBOX #1')).toHaveCount(0); await expect(row(page, 'A INBOX #1')).toBeVisible();
  expect(api.updates[1]).toMatchObject({ connectionId: 'B', action: 'archive', uids: [10] });
});

test('a merged-view reply stays on the receiving account, a new mail can pick the sender, and the chosen view is remembered', async ({ page }) => {
  const sent: { connectionId: string; replyTo?: unknown }[] = [];
  await mailApi(page, null);
  await page.route('**/api/commands', route => {
    const { command } = route.request().postDataJSON();
    if (command.type !== 'mail.send') return route.fallback();
    sent.push(command); return json(route, { ok: true, result: { messageId: '<sent@example.com>' } });
  });
  await openMail(page); await row(page, 'B INBOX #1').click();
  const reader = page.getByRole('article', { name: '메일 읽기: B read' });
  const replyButton = reader.getByRole('button', { name: '답장', exact: true });
  await replyButton.click();
  const reply = reader.getByRole('form', { name: '답장 쓰기', exact: true });
  await expect(reply).toBeVisible();
  await expect(reply.getByRole('combobox', { name: '보내는 계정' })).toHaveCount(0);
  const body = reply.getByRole('textbox', { name: '본문', exact: true });
  await expect(body).toBeFocused();
  await expect(body).toHaveValue(/> B read body/);
  await reply.getByRole('textbox', { name: '받는 사람', exact: true }).fill('recipient@example.com');
  await body.fill('Reply body');
  await reply.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(reply).toHaveCount(0);
  await expect(replyButton).toBeFocused();
  expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ connectionId: 'B', replyTo: { mailbox: 'INBOX', uid: 10 } });
  await page.getByRole('button', { name: '메일 쓰기', exact: true }).click();
  const letter = page.getByRole('form', { name: '메일 쓰기', exact: true });
  const sender = letter.getByRole('combobox', { name: '보내는 계정' });
  await expect(sender).toHaveValue('A'); await sender.selectOption('B');
  await letter.getByRole('textbox', { name: '받는 사람', exact: true }).fill('recipient@example.com');
  await letter.getByRole('textbox', { name: '제목', exact: true }).fill('From B');
  await letter.getByRole('textbox', { name: '본문', exact: true }).fill('New body');
  await letter.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(letter).toHaveCount(0);
  expect(sent).toHaveLength(2); expect(sent[1]).toMatchObject({ connectionId: 'B' }); expect(sent[1]!.replyTo).toBeUndefined();
  await accountTab(page, 'B').click();
  await page.reload(); await expect(accountTab(page, 'B')).toHaveAttribute('aria-current', 'true');
});

test('on a 390px screen forwarding continues the message, with copy recipients folded into its letterhead', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mailApi(page); await openMail(page); await row(page, 'A INBOX #1').click();
  const reader = page.getByRole('article', { name: '메일 읽기: A read' });
  const forwardButton = reader.getByRole('button', { name: '전달', exact: true });
  await forwardButton.click();
  const forward = reader.getByRole('form', { name: '전달 쓰기', exact: true });
  await expect(forward.getByRole('textbox', { name: '받는 사람', exact: true })).toBeFocused();
  await expect(forward.getByRole('textbox', { name: '제목', exact: true })).toHaveValue('Fwd: A read');
  await expect(forward.getByRole('textbox', { name: '본문', exact: true })).toHaveValue(/전달하는 메일:[\s\S]*A read body/);
  const disclosure = forward.getByRole('button', { name: /^참조/ });
  const bcc = forward.getByRole('textbox', { name: '숨은참조', exact: true });
  await expect(bcc).toHaveCount(0);
  await disclosure.click(); await bcc.fill('copy@example.com');
  await disclosure.click(); await expect(bcc).toHaveCount(0);
  await expect(disclosure).toHaveAccessibleName('참조 있음');
  await disclosure.click(); await expect(bcc).toHaveValue('copy@example.com');
  await forward.getByRole('button', { name: '취소', exact: true }).click();
  await expect(forward).toHaveCount(0);
  await expect(forwardButton).toBeFocused();
});

test('a quiet refresh puts new mail on top without a click', async ({ page }) => {
  await page.clock.install();
  await mailApi(page);
  let arrived = false;
  await page.route('**/api/mail/A/messages**', route => arrived
    ? json(route, { mailbox: 'INBOX', uidValidity: 1, messages: [summary('Fresh arrival', 11), summary('A INBOX #1', 10)], nextBefore: null })
    : route.fallback());
  await openMail(page); await expect(row(page, 'A INBOX #1')).toBeVisible();
  await expect(row(page, 'Fresh arrival')).toHaveCount(0);
  arrived = true;
  await page.clock.fastForward(95_000);
  await expect(row(page, 'Fresh arrival')).toBeVisible();
  await expect(page.locator('.mail-row').first()).toContainText('Fresh arrival');
});
