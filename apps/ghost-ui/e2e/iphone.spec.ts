import { expect, test } from '@playwright/test';
import type { Notification, State } from '@ghost/contract';
import { openScreen, screenshot, type Screen } from './visual';
import { mockBrowserLiveStream, mockIPhone, mockRichConversation, releaseBrowserFrame, showTranscriptElement } from './iphone-fixtures';
import { readRunState } from './run-state';
import { mockCodingApi, visualCodingIds } from './mocks';

const screens: Screen[] = [
  { name: 'home', route: () => '/', waits: () => ['진행 중', '최근 끝난 일'] },
  { name: 'inbox', route: () => '/inbox', waits: () => ['어떤 항목부터 조사할까요?'] },
  { name: 'work', route: () => '/work', waits: () => ['회의 메모 요약', '끝난 일'] },
  { name: 'workspace', route: () => '/workspace', waits: () => ['고정', '프로젝트'] },
  { name: 'settings', route: () => '/settings', waits: () => ['기기', '반복 작업'] },
  { name: 'devices', route: () => '/settings?tab=devices', waits: () => ['나의 iPhone', '확인 요청', '알림 허용'], prepare: mockIPhone },
];

test('opens the main Ghost from the mobile dock and another Ghost from the workspace', async ({ page }) => {
  const state = await openScreen(page, { name: 'mobile conversations', route: () => '/', waits: () => [], prepare: mockIPhone }, 'light');
  const dock = page.getByRole('navigation', { name: '주요 화면' });
  const tab = dock.getByRole('button', { name: '대화', exact: true });
  const back = page.getByRole('navigation', { name: '위치' }).getByRole('button', { name: '뒤로', exact: true });
  await expect(page.getByLabel('도우미에게 메시지', { exact: true })).toBeVisible();
  await tab.tap();
  await expect(page).toHaveURL(`${state.baseUrl}/#/ghosts/${state.defaultGhostId}`);
  await expect(tab).toBeHidden();
  await expect(page.getByText('이번 주에 들어온 요청을 정리해서 우선순위를 알려 줘.')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 690 });
  const header = page.locator('.ghost-titlebar');
  await header.getByRole('button', { name: '도우미 프로필 열기' }).tap();
  await expect(page.getByRole('button', { name: '프로필 닫기' })).toBeVisible();
  await page.getByRole('button', { name: '프로필 닫기' }).tap();
  await header.getByRole('button', { name: /^스레드/ }).tap();
  await expect(page.getByRole('button', { name: '맡긴 일 전체' })).toBeVisible();
  await page.keyboard.press('Escape');
  const transcript = page.locator('.ghost-conversation__transcript');
  const bounds = (await header.boundingBox())!;
  expect((await transcript.boundingBox())!.y).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  const tools = header.getByRole('button', { name: '작업실 메뉴', exact: true });
  await tools.tap();
  await page.getByRole('dialog', { name: '작업실 메뉴' }).getByRole('button', { name: '작업실', exact: true }).tap();
  await expect(page).toHaveURL(`${state.baseUrl}/#/workspace`);

  const workspace = page.locator('.workspace-page');
  await expect(workspace.getByRole('button', { name: /도우미 메인/ })).toBeVisible();
  await expect(workspace.getByRole('button', { name: '기록가', exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: /연구원/ }).tap();
  await expect(page.getByRole('navigation', { name: '위치' }).getByText('연구원', { exact: true })).toBeVisible();
  await expect(page.locator('#message-input')).toBeVisible();
  await expect(page.getByText('이번 주에 들어온 요청을 정리해서 우선순위를 알려 줘.')).toHaveCount(0);
  await back.tap();
  await expect(tab).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(`${state.baseUrl}/#/workspace`);
  await expect(workspace.getByRole('button', { name: '기록가', exact: true })).toBeVisible();

  const hitWidths = await dock.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().width));
  expect(hitWidths).toHaveLength(4);
  expect(hitWidths.every(width => width >= 44)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('opens an exited pane from a coding notification and falls back to the roster for a missing pane', async ({ page }) => {
  const session = 'default';
  const pane = visualCodingIds.finished;
  const present = `coding:${session}:${pane}:exit:1`;
  const missing = `coding:${session}:w99:p99:exit:2`;
  await openScreen(page, { name: 'coding exit notification', route: () => '/', waits: () => ['최근 끝난 일'], prepare: async page => {
    await mockIPhone(page);
    await mockCodingApi(page, { rich: true, finishedAgent: null });
    await page.route('**/api/state', async route => {
      const response = await route.fetch();
      const state: State = await response.json();
      const seed = readRunState();
      const notifications = [present, missing].map((id, index): Notification => ({
        id, kind: 'message', ghostId: seed.defaultGhostId, conversationId: seed.conversationA, workId: null, decisionId: null,
        title: '에이전트가 종료됐어요', body: index === 0 ? '로그인 실패 시 안내 문구 고치기' : '닫힌 패널',
        createdAt: seed.fixedNow - 30_000, readAt: null,
      }));
      await route.fulfill({ response, json: { ...state, notifications } });
    });
    await page.route('**/api/commands', route => {
      const command = route.request().postDataJSON()?.command;
      if (command?.type !== 'notification.read') return route.fallback();
      return route.fulfill({ json: { ok: true, result: {} } });
    });
  } }, 'light');
  async function tapNotification(notificationId: string) {
    const read = page.waitForRequest(request => new URL(request.url()).pathname === '/api/commands' &&
      request.postDataJSON()?.command?.type === 'notification.read');
    await page.evaluate(notificationId => {
      window.dispatchEvent(new CustomEvent('ghost-shell', { detail: { type: 'notification.open', notificationId } }));
    }, notificationId);
    expect((await read).postDataJSON().command.notificationIds).toEqual([notificationId]);
  }
  await tapNotification(present);
  await expect(page).toHaveURL(url => url.hash === `#/coding?herdr=${encodeURIComponent(pane)}&herdrSession=${session}`);
  await expect(page.getByRole('button', { name: '이어서 시작', exact: true })).toBeEnabled();
  await tapNotification(missing);
  await expect(page).toHaveURL(/#\/coding$/);
  await expect(page.getByRole('region', { name: '코딩 세션', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '이어서 시작', exact: true })).toHaveCount(0);
});

test('keeps the long chat draft and its actions within the keyboard viewport', async ({ page }) => {
  await openScreen(page, { name: 'conversation', route: state => `/ghosts/${state.defaultGhostId}`, waits: () => ['맡긴 일에서 볼 수 있어요'], prepare: mockIPhone }, 'light');
  const composer = page.locator('#message-input');
  const draft = '검토한 내용을 다시 읽습니다.\n'.repeat(30);
  await composer.fill(draft);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 500 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open');
  const dock = page.locator('.ghost-conversation__dock');
  await dock.getByRole('button', { name: '더하기', exact: true }).tap();
  const menu = dock.getByRole('menu', { name: '더하기' });
  await expect(menu).toBeVisible();
  const bounds = (await menu.boundingBox())!;
  const title = (await page.locator('.ghost-titlebar').boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(title.y + title.height);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(500);
  await page.keyboard.press('Escape');
  await dock.getByRole('button', { name: /확인 필요 1건/ }).tap();
  await expect(dock.locator('.decision')).toBeVisible();
  expect(await dock.getByRole('button', { name: '메시지 보내기', exact: true }).evaluate(button => button.getBoundingClientRect().bottom)).toBeLessThanOrEqual(500);
  await expect(composer).toHaveValue(draft);
});

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme });
    test('bookmarked conversation entry opens the main Ghost', async ({ page }) => {
      const state = await openScreen(page, { name: 'main conversation', route: () => '/conversations', waits: () => ['맡긴 일에서 볼 수 있어요'], prepare: mockIPhone }, theme);
      await expect(page).toHaveURL(`${state.baseUrl}/#/ghosts/${state.defaultGhostId}`);
      await expect(page.getByLabel('도우미에게 메시지', { exact: true })).toBeVisible();
      await screenshot(page, `conversations-${theme}-iphone.png`);
    });
    for (const screen of screens) test(screen.name, async ({ page }) => {
      await openScreen(page, screen, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      const back = page.getByRole('navigation', { name: '위치' }).getByRole('button', { name: '뒤로', exact: true });
      if (screen.name === 'devices' || screen.name === 'workspace') {
        await expect(back).toBeEnabled();
        await expect(page.getByRole('button', { name: '‹ 설정', exact: true })).toHaveCount(0);
      } else await expect(back).toHaveCount(0);
      if (screen.name === 'settings') await expect(page.locator('.compact-settings-list h1')).toHaveCount(0);
      if (screen.name === 'work') {
        await expect(page.locator('.work-board__header')).toHaveCount(0);
        const assign = page.getByRole('button', { name: '일 맡기기', exact: true });
        await expect(assign).toBeVisible();
        const segmentBounds = await page.getByRole('radiogroup', { name: '맡긴 일 상태' }).boundingBox();
        const assignBounds = await assign.boundingBox();
        expect(Math.abs(segmentBounds!.y + segmentBounds!.height / 2 - assignBounds!.y - assignBounds!.height / 2)).toBeLessThan(1);
        expect(assignBounds!.x).toBeGreaterThan(segmentBounds!.x + segmentBounds!.width);
        const assignee = page.getByRole('combobox', { name: '담당 Ghost', exact: true });
        await assignee.selectOption({ label: '연구원' });
        await expect(page).toHaveURL(/\/work\?ghost=/);
        await expect(page.getByText('진행 중인 일 없음')).toBeVisible();
        await assignee.selectOption('');
        await expect(page.locator('.work-board').getByText('회의 메모 요약', { exact: true })).toBeVisible();
      }
      await screenshot(page, `${screen.name}-${theme}-iphone.png`);
      if (screen.name === 'home') {
        await page.setViewportSize({ width: 320, height: 568 });
        const preview = page.locator('.waiting-line');
        await expect(page.locator('#handoff-message')).toBeInViewport();
        await preview.getByRole('button', { name: /나머지/ }).tap();
        await expect(page).toHaveURL(/#\/inbox$/);
        await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '홈', exact: true }).tap();
        await preview.getByRole('list').getByRole('button').tap();
        await expect(page).toHaveURL(/#\/inbox\?decision=/);
        await expect(page.locator('.queue__card .decision')).toBeVisible();
      }
      if (screen.name === 'settings') {
        await page.setViewportSize({ width: 320, height: 640 });
        await page.getByRole('searchbox', { name: '설정 찾기' }).fill('승인과');
        await expect(page.locator('.settings-index-row')).toHaveCount(1);
        await page.getByRole('button', { name: '승인과 언어' }).tap();
        await expect(page.getByRole('navigation', { name: '위치' })).toContainText('승인과 언어');
      }
      if (screen.name === 'workspace') {
        await page.locator('.workspace-shortcuts').getByRole('button', { name: '메일' }).tap();
        await expect(page).toHaveURL(/#\/mail$/);
        await back.tap();
        await expect(page.locator('.workspace-page')).toBeVisible();
      }
      if (screen.name === 'devices') {
        await back.click();
        await expect(page.getByRole('navigation', { name: '위치' }).getByRole('button', { name: '뒤로', exact: true })).toHaveCount(0);
        await expect(page.locator('.compact-settings-list')).toBeVisible();
      }
    });
    test('device alert sheet', async ({ page }) => {
      await openScreen(page, screens.find(screen => screen.name === 'devices')!, theme);
      await page.getByRole('button', { name: 'Ghost별 알림' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      const bounds = await page.getByRole('dialog').boundingBox();
      expect(bounds?.x).toBe(0);
      expect(bounds?.width).toBe(390);
      await expect(page.getByRole('textbox', { name: 'Ghost 검색' })).toBeVisible();
      const search = page.getByRole('textbox', { name: 'Ghost 검색' });
      await expect(search).toBeFocused();
      await expect(page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true })).toHaveCount(1);
      await expect(page.locator('.ghost-sheet-handle')).toHaveAttribute('aria-hidden', 'true');
      expect(await page.locator('.ghost-sheet-handle').evaluate(element => (element as HTMLElement).tabIndex)).toBe(-1);
      await search.press('Enter');
      await expect(search).not.toBeFocused();
      const mutedRow = page.locator('.device-ghost-list').getByRole('button', { name: '기록가', exact: true });
      await mutedRow.click();
      await expect(mutedRow).toHaveAttribute('aria-pressed', 'false');
      await expect(mutedRow.locator('.dot-avatar')).toHaveCSS('opacity', '0.4');
      await expect(mutedRow.locator('.lucide-bell-off')).toBeVisible();
      await screenshot(page, `ghost-alerts-sheet-${theme}-iphone.png`);
      await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).last().click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
    });
    test('conversation and touch composer', async ({ page }) => {
      await openScreen(page, { name: 'conversation', route: state => `/ghosts/${state.defaultGhostId}`, waits: () => ['맡긴 일에서 볼 수 있어요'], prepare: mockIPhone }, theme);
      await expect(page.getByRole('navigation', { name: '주요 화면' })).not.toBeVisible();
      const composer = page.locator('#message-input');
      await composer.fill('함께 확인할 내용');
      await composer.press('Enter');
      await expect(composer).toHaveValue('함께 확인할 내용\n');
      await expect(composer).toBeFocused();
      const decisionRow = page.getByRole('button', { name: /확인 필요 1건/ });
      const surface = page.locator('.ghost-conversation__dock .ghost-composer__surface');
      const decisionBounds = (await decisionRow.boundingBox())!;
      expect((await surface.boundingBox())!.y - decisionBounds.y - decisionBounds.height).toBeGreaterThanOrEqual(8);
      await screenshot(page, `composer-focused-${theme}-iphone.png`);
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 500 });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open');
      const composerBounds = (await composer.boundingBox())!;
      expect(composerBounds.y + composerBounds.height).toBeLessThanOrEqual(500);
      await screenshot(page, `composer-keyboard-${theme}-iphone.png`);
      expect(await surface.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(500);
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 844 });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await page.getByRole('button', { name: '모델 ', exact: false }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, `model-sheet-${theme}-iphone.png`);
    });
    test('rich conversation fits the phone without losing two-dimensional content', async ({ page }) => {
      await openScreen(page, { name: 'rich', route: state => `/ghosts/${state.defaultGhostId}`, waits: () => [], prepare: mockRichConversation }, theme);
      await expect(page.getByRole('heading', { name: '주간 조사', exact: true })).toBeAttached();
      const transcript = page.locator('.ghost-conversation__transcript');
      await transcript.dispatchEvent('touchmove');
      await transcript.evaluate(element => { element.scrollTop = 0; });
      const heading = page.getByRole('heading', { name: '주간 조사', exact: true });
      await expect(heading).toBeVisible();
      const agenda = (await page.getByRole('button', { name: '예약', exact: true }).boundingBox())!;
      expect((await heading.boundingBox())!.y).toBeGreaterThanOrEqual(agenda.y + agenda.height);
      const jump = page.getByRole('button', { name: '최신 메시지', exact: true });
      await expect(jump).toBeVisible();
      const transcriptBounds = (await transcript.boundingBox())!;
      expect((await jump.boundingBox())!.y).toBeGreaterThanOrEqual(transcriptBounds.y + transcriptBounds.height);
      await screenshot(page, `rich-chart-${theme}-iphone.png`);
      const chart = page.locator('.ghost-ui-block').filter({ has: page.getByRole('heading', { name: '처리량', exact: false }) });
      await chart.getByRole('radio', { name: '데이터', exact: true }).click();
      await expect(chart.getByRole('cell', { name: '23', exact: true })).toBeVisible();
      await screenshot(page, `chart-data-${theme}-iphone.png`);
      await chart.getByRole('radio', { name: '차트', exact: true }).click();
      expect(await chart.locator('.ghost-ui-scroll').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      for (const [name, title] of [['comparison', '접근 방식 비교'], ['choices', '다음 조사'], ['form', '조사 범위'], ['html', '보고서 미리보기'], ['markdown', '비교 메모']]) {
        await showTranscriptElement(page.getByRole('heading', { name: title, exact: true }));
        await screenshot(page, `rich-${name}-${theme}-iphone.png`);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(await transcript.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      await expect(page.locator('.touch-context').filter({ has: page.locator('.message-body') }).locator('.ghost-conversation-message__actions .touch-context__trigger')).toHaveCount(1);
      await page.locator('.touch-context').filter({ has: page.locator('.message-body') }).getByRole('button', { name: '더 보기', exact: true }).click();
      await expect(page.getByRole('button', { name: '인용해서 답장' })).toBeVisible();
      await expect(page.getByRole('button', { name: '링크 복사' })).toBeVisible();
      await screenshot(page, `message-actions-${theme}-iphone.png`);
      await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).last().click();
      for (const [name, file] of [['image', '자료.svg'], ['markdown', '기록.md'], ['pdf', '자료.pdf']]) {
        await page.getByRole('button', { name: file, exact: false }).click();
        const sheet = page.getByRole('dialog');
        await expect(sheet.getByText('파일을 읽는 중…')).not.toBeVisible();
        if (name === 'image') await expect(sheet.getByRole('img', { name: file })).toBeVisible();
        if (name === 'markdown') await expect(sheet.getByRole('heading', { name: '조사 기록' })).toBeVisible();
        if (name === 'pdf') {
          const viewer = sheet.getByTitle(file, { exact: true });
          await expect(viewer).toBeVisible();
          // Chrome may paint an empty PDF viewer before its document pixels arrive.
          await expect.poll(async () => {
            const bytes = await viewer.screenshot({ scale: 'css' });
            return page.evaluate(async encoded => {
              const png = Uint8Array.from(atob(encoded), byte => byte.charCodeAt(0));
              const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
              const context = new OffscreenCanvas(1, 1).getContext('2d')!;
              context.drawImage(bitmap, Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1, 0, 0, 1, 1);
              bitmap.close();
              return context.getImageData(0, 0, 1, 1).data.slice(0, 3).every(channel => channel >= 245);
            }, bytes.toString('base64'));
          }, { message: 'The white PDF page has painted' }).toBe(true);
        }
        await screenshot(page, `file-${name}-${theme}-iphone.png`);
        await sheet.getByRole('button', { name: '파일 닫기' }).click();
      }
      const comparison = page.locator('.ghost-ui-scroll[aria-label="접근 방식 비교"]');
      await comparison.scrollIntoViewIfNeeded();
      const row = comparison.locator('tbody th').first();
      const left = (await row.boundingBox())!.x;
      await comparison.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      expect(Math.abs((await row.boundingBox())!.x - left)).toBeLessThanOrEqual(1);
      await screenshot(page, `comparison-scrolled-${theme}-iphone.png`);
      const htmlBlock = page.locator('.ghost-ui-block').filter({ has: page.getByRole('heading', { name: '보고서 미리보기', exact: true }) });
      await htmlBlock.getByRole('button', { name: '보고서 미리보기 전체 화면' }).click();
      const full = page.getByRole('dialog', { name: '보고서 미리보기', exact: true });
      await expect(full).toBeVisible();
      expect((await full.boundingBox())!.height).toBe(844);
      await expect(full.locator('iframe')).toHaveAttribute('sandbox', '');
      await expect(full.locator('iframe')).toHaveCSS('resize', 'none');
      await screenshot(page, `html-fullscreen-${theme}-iphone.png`);
      await full.getByRole('button', { name: '닫기', exact: true }).click();
    });
    test('interactive inputs send ordinary owner messages and retain editing state', async ({ page }) => {
      const state = await openScreen(page, { name: 'submit', route: () => '/', waits: () => [], prepare: mockRichConversation }, theme);
      await expect(page.locator('.home')).toBeVisible();
      const send = (command: Record<string, unknown>) => page.evaluate(async command => {
        const response = await fetch('/api/commands', { method: 'POST', headers: { authorization: `Bearer ${window.__GHOST_TOKEN__}`, 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: crypto.randomUUID(), command }) });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(JSON.stringify(body));
        return body.result;
      }, command);
      const { ghostId } = await send({ type: 'ghost.create', name: '입력 확인', persona: '합성 UI 응답 검증용 Ghost입니다.',
        look: { avatarId: null, body: '#5b7fd4', face: 'bars', mark: 'halo' } });
      try {
        await page.goto(`${state.baseUrl}/#/ghosts/${ghostId}`);
        const choices = page.locator('.ghost-ui-block').filter({ has: page.getByRole('heading', { name: '다음 조사', exact: true }) });
        await choices.getByLabel('속도 지표', { exact: false }).check();
        const option = choices.locator('.ghost-ui-choice').first();
        expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect((await option.boundingBox())!.width).toBeGreaterThan(300);
        const posted = page.waitForRequest(request => request.url().endsWith('/api/commands') && request.postDataJSON()?.command?.type === 'message.send');
        await choices.getByRole('button', { name: '선택 보내기' }).click();
        expect((await posted).postDataJSON().command.text).toBe(['UI 응답 · 주간 조사', '다음 조사', '속도 지표', '주요 경로의 처리 시간을 살펴봅니다.'].join('\n'));
        await expect(choices.getByRole('status')).toHaveText('메시지로 보냈습니다.');
        await expect(page.locator('[data-role="user"]').getByText('UI 응답 · 주간 조사', { exact: false })).toBeVisible();
        await choices.scrollIntoViewIfNeeded();
        await screenshot(page, `choices-sent-${theme}-iphone.png`);
        await choices.getByRole('button', { name: '응답 수정' }).click();
        await expect(choices.getByLabel('속도 지표', { exact: false })).toBeChecked();
        await expect(choices.getByLabel('오류 패턴', { exact: true })).toBeEnabled();
        await screenshot(page, `choices-editing-${theme}-iphone.png`);
        const form = page.locator('.ghost-ui-block').filter({ has: page.getByRole('heading', { name: '조사 범위', exact: true }) });
        await form.getByRole('textbox', { name: '주제' }).fill('모바일 사용성');
        await expect(form.getByRole('spinbutton', { name: '자료 수' })).toHaveAttribute('inputmode', 'decimal');
        await form.getByRole('spinbutton', { name: '자료 수' }).fill('7');
        // WKWebView's layout viewport stays tall while the software keyboard reduces visualViewport.
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 500 });
          window.visualViewport!.dispatchEvent(new Event('resize'));
        });
        await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open');
        await showTranscriptElement(form.getByText('자료 수', { exact: true }));
        await form.getByRole('button', { name: '범위 보내기' }).scrollIntoViewIfNeeded();
        expect((await form.getByRole('button', { name: '범위 보내기' }).boundingBox())!.y + 44).toBeLessThanOrEqual(500);
        const numberBounds = (await form.getByRole('spinbutton', { name: '자료 수' }).boundingBox())!;
        const submitBounds = (await form.getByRole('button', { name: '범위 보내기' }).boundingBox())!;
        expect(numberBounds.y + numberBounds.height).toBeLessThanOrEqual(submitBounds.y);
        await screenshot(page, `form-keyboard-${theme}-iphone.png`);
        await form.getByRole('button', { name: '범위 보내기' }).click();
        await expect(form.getByRole('status')).toHaveText('메시지로 보냈습니다.');
        await expect(page.locator('[data-role="user"]').getByText('- 주제: "모바일 사용성"', { exact: false })).toBeVisible();
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 844 });
          window.visualViewport!.dispatchEvent(new Event('resize'));
        });
        await form.scrollIntoViewIfNeeded();
        await screenshot(page, `form-sent-${theme}-iphone.png`);
        await page.reload();
        await expect(form.getByRole('button', { name: '응답 수정' })).toBeAttached();
        await expect(form.getByRole('textbox', { name: '주제' })).toHaveValue('모바일 사용성');
      } finally {
        await send({ type: 'ghost.update', ghostId, state: 'retired' });
        await send({ type: 'ghost.delete', ghostId });
      }
    });
  });
}

test('live browser preserves the focused touch draft until matching viewport pixels decode and recovers after rejected input', async ({ page }) => {
  const { conversationA, defaultGhostId } = readRunState();
  const inputs: { type: string; width?: number; height?: number; text?: string }[] = [];
  let rejectNavigation = true;
  await openScreen(page, {
    name: 'live browser touch readiness', route: () => `/ghosts/${defaultGhostId}`, waits: () => [],
    prepare: async page => {
      await page.route('**/api/state', async route => {
        const response = await route.fetch();
        const state = await response.json();
        state.ghosts = state.ghosts.map((ghost: { id: string; tools: string[] }) => ghost.id === defaultGhostId
          ? { ...ghost, tools: [...ghost.tools, 'browser_snapshot'] } : ghost);
        await route.fulfill({ response, json: state });
      });
      await page.route('**/api/browser/sessions', route => route.fulfill({ json: { ok: true, sessions: [{
        conversationId: conversationA, ghostId: defaultGhostId, engine: 'chrome', headed: false, handoffDecisionId: null,
      }] } }));
      await page.route('**/api/browser/sessions/*/input', async route => {
        const input = route.request().postDataJSON();
        inputs.push(input);
        if (input.type === 'navigate' && rejectNavigation) {
          rejectNavigation = false;
          await route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'The browser runtime changed.' } } });
        } else await route.fulfill({ json: { ok: true } });
      });
      await mockBrowserLiveStream(page, conversationA);
    },
  }, 'light');
  await page.getByRole('button', { name: '브라우저 화면', exact: true }).tap();
  const live = page.locator('.browser-live');
  const screen = live.locator('.browser-live__screen');
  const field = live.getByRole('textbox', { name: '브라우저에 입력할 내용', exact: true });
  const send = live.getByRole('button', { name: '글자 보내기', exact: true });
  const macWindow = live.getByRole('button', { name: 'Mac 창으로 열기', exact: true });
  await expect.poll(() => page.evaluate(() => '__releaseBrowserFrame' in window)).toBe(true);
  const initial = await screen.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
  await releaseBrowserFrame(page, initial);
  await expect(send).toBeEnabled();
  const draft = '계속 입력한 초안';
  await field.fill(draft);
  await expect(field).toBeFocused();

  // The app sizes its phone shell from visualViewport, just as an iPhone keyboard does.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 500 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => inputs.some(input => input.type === 'viewport' && input.height !== initial.height)).toBe(true);
  const pending = inputs.findLast(input => input.type === 'viewport' && input.height !== initial.height)!;
  await expect(field).toBeEnabled();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(draft);
  await expect(send).toBeDisabled();
  await expect(live.getByRole('button', { name: 'Enter', exact: true })).toBeDisabled();
  await expect(macWindow).toBeEnabled();
  await field.press('Enter');
  await send.dispatchEvent('click');
  // Also exercise implicit form submission rather than relying only on disabled-button behavior.
  await live.locator('form').evaluate(form => (form as HTMLFormElement).requestSubmit());
  await expect(field).toHaveValue(draft);
  await expect(field).toBeFocused();
  expect(inputs.filter(input => input.type === 'text')).toEqual([]);

  await releaseBrowserFrame(page, { width: pending.width!, height: pending.height! });
  await expect(live.locator('.browser-live__placeholder')).toHaveCount(0);
  await expect(send).toBeEnabled();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(draft);
  expect(await live.locator('canvas').evaluate(canvas => {
    const pixels = canvas.getContext('2d')!;
    return { width: canvas.width, height: canvas.height,
      left: pixels.getImageData(1, 1, 1, 1).data[0],
      right: pixels.getImageData(canvas.width - 2, 1, 1, 1).data[0] };
  })).toMatchObject({ width: pending.width, height: pending.height, right: 255 });
  // A late promotion/input rejection revokes readiness even if this stream already painted.
  // No new damage is forthcoming: only a fresh subscription can recover the invalidated frame.
  await live.getByRole('button', { name: '뒤로', exact: true }).dispatchEvent('click');
  await expect.poll(() => page.evaluate(() =>
    '__browserStreamCount' in window ? window.__browserStreamCount : 0)).toBe(2);
  await expect(field).toBeEnabled();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(draft);
  await expect(send).toBeDisabled();
  await expect(macWindow).toBeEnabled();
  await expect(live.locator('.browser-live__placeholder')).toBeVisible();
  expect(inputs.filter(input => input.type === 'navigate')).toHaveLength(1);
  expect(inputs.filter(input => input.type === 'text')).toEqual([]);
  const recovered = await screen.evaluate(element => ({
    width: Math.max(320, Math.min(2560, element.clientWidth)),
    height: Math.max(240, Math.min(1600, element.clientHeight)),
  }));
  await releaseBrowserFrame(page, recovered);
  await expect(live.locator('.browser-live__placeholder')).toHaveCount(0);
  await expect(send).toBeEnabled();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(draft);
  expect(inputs.filter(input => input.type === 'navigate')).toHaveLength(1);
  await send.tap();
  await expect.poll(() => inputs.filter(input => input.type === 'text')).toEqual([{ type: 'text', text: draft }]);
  await expect(field).toHaveValue('');
});
