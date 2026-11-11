import { expect, test } from '@playwright/test';
import { openScreen, screenshot, type Screen } from './visual';
import { mockIPhone, mockRichConversation } from './iphone-fixtures';

const screens: Screen[] = [
  { name: 'home', route: () => '/', waits: () => ['진행 중', '최근 끝난 일'] },
  { name: 'inbox', route: () => '/inbox', waits: () => ['어떤 항목부터 조사할까요?'] },
  { name: 'work', route: () => '/work', waits: () => ['회의 메모 요약', '끝난 일'] },
  { name: 'workspace', route: () => '/workspace', waits: () => ['고정', '프로젝트'] },
  { name: 'settings', route: () => '/settings', waits: () => ['기기', '반복 작업'] },
  { name: 'devices', route: () => '/settings?tab=devices', waits: () => ['나의 iPhone', '확인 요청', '알림 허용'], prepare: mockIPhone },
];

test('open and switch Ghost conversations from the mobile dock', async ({ page }) => {
  await openScreen(page, { name: 'mobile conversations', route: () => '/', waits: () => [], prepare: mockIPhone }, 'light');
  const dock = page.getByRole('navigation', { name: '주요 화면' });
  const tab = dock.getByRole('button', { name: '대화', exact: true });
  const back = page.getByRole('navigation', { name: '위치' }).getByRole('button', { name: '뒤로', exact: true });
  await expect(page.getByLabel('도우미에게 메시지', { exact: true })).toBeVisible();
  await tab.tap();
  await expect(tab).toHaveAttribute('aria-current', 'page');
  const list = page.getByRole('region', { name: '대화', exact: true });
  await expect(list.getByRole('button').first()).toHaveAccessibleName('도우미 메인');
  await list.getByRole('button', { name: '도우미 메인' }).tap();
  await expect(page.getByText('이번 주에 들어온 요청을 정리해서 우선순위를 알려 줘.')).toBeVisible();
  await back.tap();

  const search = list.getByRole('searchbox', { name: 'Ghost 찾기' });
  await search.fill('연구');
  await expect(list.getByRole('button')).toHaveCount(1);
  await list.getByRole('button', { name: '연구원', exact: true }).tap();
  await expect(page.getByRole('navigation', { name: '위치' }).getByText('연구원', { exact: true })).toBeVisible();
  await expect(page.locator('#message-input')).toBeVisible();
  await expect(page.getByText('이번 주에 들어온 요청을 정리해서 우선순위를 알려 줘.')).toHaveCount(0);
  await back.tap();
  await expect(tab).toHaveAttribute('aria-current', 'page');
  await expect(list.getByRole('button', { name: '기록가', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 690 });
  const hitWidths = await dock.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().width));
  expect(hitWidths).toHaveLength(6);
  expect(hitWidths.every(width => width >= 44)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme });
    test('conversation list', async ({ page }) => {
      await openScreen(page, { name: 'conversations', route: () => '/conversations', waits: () => ['기록가'], prepare: mockIPhone }, theme);
      await screenshot(page, `conversations-${theme}-iphone.png`);
    });
    for (const screen of screens) test(screen.name, async ({ page }) => {
      await openScreen(page, screen, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      const back = page.getByRole('navigation', { name: '위치' }).getByRole('button', { name: '뒤로', exact: true });
      if (screen.name === 'devices') {
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
        const chips = await page.locator('.ghost-filter > button').evaluateAll(buttons => buttons.map(button => ({
          hitHeight: button.clientHeight,
          pillHeight: parseFloat(getComputedStyle(button, '::before').height),
        })));
        expect(chips.every(chip => chip.hitHeight >= 44 && chip.pillHeight === 28)).toBe(true);
      }
      await screenshot(page, `${screen.name}-${theme}-iphone.png`);
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
      await screenshot(page, `composer-focused-${theme}-iphone.png`);
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 500 });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open');
      const composerBounds = (await composer.boundingBox())!;
      expect(composerBounds.y + composerBounds.height).toBeLessThanOrEqual(500);
      await screenshot(page, `composer-keyboard-${theme}-iphone.png`);
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
      await expect(page.getByRole('heading', { name: '주간 조사', exact: true })).toBeVisible();
      await screenshot(page, `rich-chart-${theme}-iphone.png`);
      const chart = page.locator('.ghost-ui-block').filter({ has: page.getByRole('heading', { name: '처리량', exact: false }) });
      await chart.getByRole('radio', { name: '데이터', exact: true }).click();
      await expect(chart.getByRole('cell', { name: '23', exact: true })).toBeVisible();
      await screenshot(page, `chart-data-${theme}-iphone.png`);
      await chart.getByRole('radio', { name: '차트', exact: true }).click();
      expect(await chart.locator('.ghost-ui-scroll').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      for (const [name, title] of [['comparison', '접근 방식 비교'], ['choices', '다음 조사'], ['form', '조사 범위'], ['html', '보고서 미리보기'], ['markdown', '비교 메모']]) {
        await page.getByRole('heading', { name: title, exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
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
        if (name === 'pdf') await expect(sheet.locator('iframe')).toBeVisible();
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
