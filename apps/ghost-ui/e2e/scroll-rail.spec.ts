import { expect, test } from '@playwright/test';
import { readRunState } from './run-state';

test('the rail follows owner scrolling and scrubbing, not automatic movement', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.goto(`${readRunState().baseUrl}/#/`);
  const sheet = page.locator('.shell-sheet');
  await expect.poll(() => sheet.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
  await sheet.hover();
  const rail = page.locator('.ghost-rail[data-floating][data-axis="y"]');
  await expect(rail).toBeVisible();
  await page.mouse.wheel(0, 100);
  await expect.poll(() => sheet.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(rail).toHaveAttribute('data-active', '');

  // Leave the scroller; an idle rail must neither draw nor intercept the page.
  await page.mouse.move(20, 400);
  await expect(rail).not.toHaveAttribute('data-active');
  await expect(rail).toHaveCSS('opacity', '0');
  await expect(rail).toHaveCSS('pointer-events', 'none');
  await sheet.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => sheet.evaluate(element => element.scrollTop)).toBe(0);
  await expect(rail).not.toHaveAttribute('data-active');

  // The same thumb remains a real scrollbar: dragging to the end reaches the end.
  await sheet.hover();
  const thumb = await rail.locator('.ghost-rail__thumb').boundingBox();
  const track = await rail.boundingBox();
  if (!thumb || !track) throw new Error('the scroll rail has no geometry');
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, track.y + track.height);
  await page.mouse.up();
  await expect.poll(() => sheet.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThan(2);
});

test('wheeling over the conversation rail stops following the latest turn', async ({ page }) => {
  const state = readRunState();
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.goto(`${state.baseUrl}/#/ghosts/${state.defaultGhostId}`);
  const transcript = page.locator('.ghost-conversation__transcript');
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await transcript.hover();
  const rail = page.locator('.ghost-conversation__transcript-frame > .ghost-rail');
  const track = await rail.boundingBox();
  if (!track) throw new Error('the conversation rail has no geometry');
  await page.mouse.move(track.x + track.width - 3, track.y + track.height / 2);
  // Let the transcript's 800 ms recent-input window expire: this wheel must renew it.
  await page.waitForTimeout(850);
  await page.mouse.wheel(0, -120);
  await expect(page.locator('.ghost-conversation__jump')).toBeVisible();
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(48);
});
