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
for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme });
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
          hitHeight: button.getBoundingClientRect().height,
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
    });
  });
}
