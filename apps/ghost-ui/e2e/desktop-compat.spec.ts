import { expect, test } from '@playwright/test';
import { openScreen } from './visual';
import { mockRichConversation } from './iphone-fixtures';

test('workspace route does not duplicate the desktop sidebar', async ({ page }) => {
  await openScreen(page, { name: 'workspace', route: () => '/workspace', waits: () => ['진행 중', '최근 끝난 일'] }, 'light');
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('.workspace-page')).toHaveCount(0);
  await expect(page.locator('.shell-sidebar')).toBeVisible();
});

test('a narrow Tauri Mac window retains desktop chrome and the original menu', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { invoke: async (command: string) => command === 'companion_enabled' ? false : undefined } });
  });
  await openScreen(page, { name: 'work', route: () => '/work', waits: () => ['회의 메모 요약'] }, 'light');
  await expect(page.locator('html')).toHaveAttribute('data-desktop-shell', '');
  await expect(page.getByRole('navigation', { name: '주요 화면' })).toHaveCount(0);
  const titleBar = page.locator('header[data-tauri-drag-region]');
  await expect(titleBar).toHaveCSS('height', '48px');
  expect(await titleBar.evaluate(element => getComputedStyle(element).getPropertyValue('--ghost-titlebar-macos-inset').trim())).toBe('80px');
  await expect(page.locator('.work-board__header h1')).toBeVisible();
  await page.getByRole('button', { name: '전체 메뉴', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '전체 메뉴' })).toBeVisible();
  await expect(page.locator('.ghost-sheet-handle')).toHaveCount(0);
  expect((await page.getByRole('dialog').boundingBox())!.width).toBeLessThan(400);
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();
  await page.evaluate(() => { location.hash = '/workspace'; });
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('.workspace-page')).toHaveCount(0);
});

test('Tauri titlebar descendants drag without stealing control clicks', async ({ page }) => {
  await page.addInitScript(() => {
    const bridge = { drags: 0, invoke: async (command: string) => {
      if (command === 'drag_window') bridge.drags++;
      return command === 'companion_enabled' ? false : undefined;
    } };
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: bridge });
  });
  await openScreen(page, { name: 'home', route: () => '/', waits: () => [] }, 'light');
  const drags = () => page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    return bridge && 'drags' in bridge ? bridge.drags : null;
  });
  await page.locator('.title-nav [aria-current="page"]').click();
  expect(await drags()).toBe(1);

  await page.getByRole('button', { name: '명령 검색', exact: true }).locator('svg').click();
  await expect(page.getByRole('dialog', { name: '명령', exact: true })).toBeVisible();
  expect(await drags()).toBe(1);
  await page.keyboard.press('Escape');
  await page.locator('.title-nav__step').first().locator('svg').dispatchEvent('mousedown', { button: 0, detail: 1, bubbles: true });
  expect(await drags()).toBe(1);
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(page).toHaveURL(/#\/settings/);
  expect(await drags()).toBe(1);
});

test('desktop message menus offer copy link only for the clicked link', async ({ page }) => {
  await openScreen(page, { name: 'rich', route: state => `/ghosts/${state.defaultGhostId}`, waits: () => [], prepare: mockRichConversation }, 'light');
  const transcript = page.locator('.ghost-conversation__transcript');
  await transcript.dispatchEvent('wheel');
  const heading = page.getByRole('heading', { name: '비교 메모', exact: true });
  await heading.scrollIntoViewIfNeeded();
  await heading.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '메시지 복사', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '링크 복사', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const link = page.getByRole('link', { name: '참고 자료', exact: true });
  await link.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '링크 복사', exact: true })).toBeVisible();
});
