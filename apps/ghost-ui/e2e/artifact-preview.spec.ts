import { expect, test, type Page } from '@playwright/test';
import { readRunState } from './run-state';

async function attach(page: Page, files: { name: string; type: string; body: string }[]) {
  const state = readRunState();
  await page.goto(state.baseUrl);
  const token: unknown = await page.evaluate(() => Reflect.get(window, '__GHOST_TOKEN__'));
  if (typeof token !== 'string') throw new Error('isolated Host token missing');
  const headers = { authorization: `Bearer ${token}` };
  const command = async (value: Record<string, unknown>) => {
    const response = await page.request.post(`${state.baseUrl}/api/commands`, { headers, data: { requestId: crypto.randomUUID(), command: value } });
    expect(response.ok()).toBe(true);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('result' in body) || !body.result || typeof body.result !== 'object') throw new Error('command result missing');
    return body.result;
  };
  const created = await command({ type: 'conversation.create', ghostId: state.scribeGhostId, title: '파일 뷰어 · 합성 검증' });
  if (!('conversationId' in created) || typeof created.conversationId !== 'string') throw new Error('conversation missing');
  const attachments: unknown[] = [];
  for (const file of files) {
    const response = await page.request.post(`${state.baseUrl}/api/artifacts`, { headers: { ...headers, 'content-type': file.type, 'X-Ghost-File-Name': encodeURIComponent(file.name) }, data: Buffer.from(file.body) });
    expect(response.ok()).toBe(true);
    attachments.push(await response.json());
  }
  await command({ type: 'message.send', conversationId: created.conversationId, text: '파일 뷰어 검증용 합성 자료입니다.', attachments });
  await page.goto(`${state.baseUrl}/#/ghosts/${state.scribeGhostId}?conversation=${created.conversationId}`);
  await expect(page.getByRole('button', { name: new RegExp(files[0]!.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first()).toBeVisible();
}

test('Markdown reads safely; source, clipboard and downloaded bytes stay exact', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const name = '검토를-위한-비행-기록과-관측-결과-2026-11-08.md';
  const source = '# 비행 기록\n\n결과를 **확인**합니다.[^note]\n\n- [x] 원문 보존\n\n![비공개 이미지](https://example.invalid/private.png)\n\n<script>window.__fileExecuted=true</script>\n\n' + '관측 내용\n\n'.repeat(80) + '[^note]: 합성 자료입니다.\n';
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('example.invalid')) requests.push(request.url()); });
  await attach(page, [{ name, type: 'text/markdown', body: source }]);
  const trigger = page.getByRole('button', { name: new RegExp(name) });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog.getByRole('heading', { name: '비행 기록', exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(dialog.getByRole('checkbox')).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(window, '__fileExecuted'))).toBeUndefined();
  expect(requests).toEqual([]);
  await dialog.getByRole('link', { name: '1', exact: true }).click();
  await expect(dialog.getByText('합성 자료입니다.', { exact: false }).last()).toBeInViewport();
  await dialog.getByRole('radio', { name: '원문', exact: true }).click();
  await expect(dialog.locator('.file-sheet__code')).toHaveText(source);
  await dialog.getByRole('button', { name: '파일 내용 복사' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('link', { name: '파일 다운로드' }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(name);
  const stream = await download.createReadStream();
  const pieces: Buffer[] = [];
  for await (const piece of stream) pieces.push(Buffer.from(piece));
  expect(Buffer.concat(pieces).toString('utf8')).toBe(source);
  await dialog.getByRole('radio', { name: '읽기', exact: true }).click();
  await dialog.locator('[data-file-scroll]').evaluate(element => { element.scrollTop = 0; });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: testInfo.outputPath(`reading-${theme}-${width}.png`) });
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await dialog.locator('[data-file-scroll]').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  }
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('SVG remains an image; empty files and unknown binary keep usable save actions', async ({ page }) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="40" fill="cornflowerblue"/></svg>';
  await attach(page, [{ name: 'diagram.svg', type: 'image/svg+xml', body: svg }, { name: 'empty.txt', type: 'text/plain', body: '' }, { name: 'unknown.bin', type: 'application/octet-stream', body: '\u0000\u0001' }]);
  await page.getByRole('button', { name: /diagram.svg/ }).click();
  await expect(page.getByRole('dialog').getByRole('img', { name: 'diagram.svg' })).toBeVisible();
  expect(await page.getByRole('dialog').getByRole('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(120);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /empty.txt/ }).click();
  await expect(page.getByRole('dialog').getByText('빈 파일', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('link', { name: '파일 다운로드' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /unknown.bin/ }).click();
  await expect(page.getByRole('dialog').getByRole('link', { name: '파일 저장' })).toBeVisible();
  await expect(page.getByRole('dialog').locator('iframe')).toHaveCount(0);
});

test('long lines wrap without losing source; newline-heavy files do not amplify the gutter', async ({ page }, testInfo) => {
  const source = 'const original = "' + 'long_line_'.repeat(200) + '";\n' + '\n'.repeat(10_001) + 'last_line';
  await attach(page, [{ name: 'large-source.ts', type: 'application/octet-stream', body: source }]);
  await page.getByRole('button', { name: /large-source.ts/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.file-sheet__code')).toHaveText(source);
  await expect(dialog.locator('.file-sheet__gutter')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('button', { name: '긴 줄 접기' }).click();
  expect(await dialog.locator('[data-file-scroll]').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await dialog.locator('.file-sheet__code').textContent()).toBe(source);
  await page.screenshot({ path: testInfo.outputPath('wrapped-source-mobile.png') });
});

test('closing a pending load cannot replace a reopened file or leak object URLs', async ({ page }) => {
  await attach(page, [{ name: 'pending.txt', type: 'text/plain', body: '원본 내용' }]);
  await page.evaluate(() => {
    const active = new Set<string>();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); active.add(url); return url; };
    URL.revokeObjectURL = url => { active.delete(url); revoke(url); };
    Reflect.set(window, '__activeFileUrls', active);
  });
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: firstRequest, resolve: started } = Promise.withResolvers<void>();
  const { promise: firstResponse, resolve: finished } = Promise.withResolvers<void>();
  let requests = 0;
  await page.route('**/api/artifacts/*', async route => {
    const first = ++requests === 1;
    const response = await route.fetch();
    if (first) { started(); await gate; }
    await route.fulfill({ response });
    if (first) finished();
  });
  const trigger = page.getByRole('button', { name: /pending.txt/ });
  await trigger.click();
  await firstRequest;
  await expect(page.getByRole('status')).toHaveText('파일을 읽는 중…');
  await page.keyboard.press('Escape');
  await trigger.click();
  await expect(page.getByRole('dialog').locator('.file-sheet__code')).toHaveText('원본 내용');
  release();
  await firstResponse;
  await expect.poll(() => page.evaluate(() => {
    const urls: unknown = Reflect.get(window, '__activeFileUrls');
    return urls instanceof Set ? urls.size : -1;
  })).toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => {
    const urls: unknown = Reflect.get(window, '__activeFileUrls');
    return urls instanceof Set ? urls.size : -1;
  })).toBe(0);
});
