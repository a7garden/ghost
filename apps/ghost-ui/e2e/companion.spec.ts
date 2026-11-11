import { expect, test, type Page } from '@playwright/test';
import type { State } from '@ghost/contract';
import { readRunState } from './run-state';

declare global {
  interface Window {
    petCommands: { command: string; args?: { route?: string } }[];
    finishPetDrag?: () => void;
  }
}

async function openPet(page: Page, count: number, decisions = false) {
  const run = readRunState();
  await page.setViewportSize({ width: 112, height: 142 });
  await page.addInitScript(({ ghostId }) => {
    localStorage.setItem('ghost-desktop:companion', JSON.stringify({ enabled: true, ghostId, size: 's', bubble: true }));
    const commands: { command: string; args?: Record<string, unknown> }[] = [];
    Object.assign(window, { petCommands: commands, __TAURI_INTERNALS__: { invoke: async (command: string, args?: Record<string, unknown>) => {
      commands.push({ command, args });
      if (command === 'companion_drag') {
        const { promise, resolve } = Promise.withResolvers<boolean>();
        window.finishPetDrag = () => resolve(true);
        return promise;
      }
      return command === 'companion_enabled' ? true : undefined;
    } } });
  }, { ghostId: run.defaultGhostId });
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const state: State = await response.json();
    const work = state.works.find(item => item.id === run.workLiveId)!;
    state.works = Array.from({ length: count }, (_, index) => ({ ...work, id: `pet-work-${index}`, ghostId: run.defaultGhostId,
      title: index === 0 ? '배포 전 실제 설치 화면과 아주 긴 한글 제목이 잘리지 않고 끝까지 읽히는지 확인하는 맡긴 일' : `자료 비교 ${index + 1}`,
      state: index === 0 ? 'blocked' : index % 2 ? 'running' : 'waiting' }));
    state.decisions = decisions ? [{ ...state.decisions[0], id: 'pet-decision', ghostId: run.defaultGhostId, state: 'pending' }] : [];
    state.conversations = state.conversations.map(item => ({ ...item, busy: false }));
    await route.fulfill({ response, json: state });
  });
  await page.goto(`${run.baseUrl}/companion.html`);
  await expect(page.getByRole('button', { name: '도우미 대화 열기' })).toBeVisible();
}

async function expandPet(page: Page) {
  await page.setViewportSize({ width: 320, height: 382 });
  await page.locator('.companion-summary').hover();
  await expect(page.locator('.companion-work')).toBeVisible();
  await page.locator('.companion-work').hover();
}

test('small pet keeps only a fitting count, expands all works and opens the chosen work', async ({ page }, testInfo) => {
  await openPet(page, 18);
  await expect(page.locator('.companion-summary')).toHaveText('맡긴 일 18');
  const box = (await page.locator('.companion-summary').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(112);
  expect(box.y).toBeGreaterThanOrEqual(0);
  await expandPet(page);
  await expect(page.locator('.companion-work-row')).toHaveCount(18);
  const longTitle = page.locator('.companion-work-row').first();
  await expect(longTitle).toContainText('막힘');
  expect(await longTitle.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const shelf = (await page.locator('.companion-work').boundingBox())!;
  expect(shelf.y).toBeGreaterThanOrEqual(0);
  expect(shelf.x + shelf.width).toBeLessThanOrEqual(320);
  expect(await page.locator('.companion-work-scroll').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: testInfo.outputPath('pet-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.screenshot({ path: testInfo.outputPath('pet-light.png') });
  const last = page.locator('.companion-work-row').last();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect.poll(() => page.evaluate(() => window.petCommands.filter(item => item.command === 'focus_main').map(item => item.args?.route))).toEqual(['/work/pet-work-17']);
});

test('work disclosure supports keyboard, Escape, hover departure and idle', async ({ page }) => {
  await openPet(page, 1);
  await page.setViewportSize({ width: 320, height: 382 });
  const trigger = page.locator('.companion-summary');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.locator('.companion-work-row')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await trigger.evaluate(element => { if (element instanceof HTMLElement) element.blur(); });
  await expandPet(page);
  await page.mouse.move(1, 1);
  await expect(page.locator('.companion-work')).toHaveCount(0);
  await openPet(page, 0);
  await expect(page.locator('.companion-summary')).toHaveCount(0);
});

test('owner decisions lead the roster and open their own destination', async ({ page }) => {
  await openPet(page, 2, true);
  await expect(page.locator('.companion-summary')).toHaveText(/확인할 일/);
  await expandPet(page);
  await expect(page.locator('.companion-work-group').first()).toContainText('확인할 일');
  await page.locator('.companion-work-group').first().getByRole('button').first().click();
  await expect.poll(() => page.evaluate(() => window.petCommands.find(item => item.command === 'focus_main')?.args?.route)).toMatch(/^\/inbox\?decision=/);
});

test('dragging before hover opens never resizes the pet mid-drag', async ({ page }) => {
  await openPet(page, 1);
  await page.clock.install();
  await page.locator('.companion-hit').hover();
  await page.locator('.companion-hit').dispatchEvent('mousedown', { button: 0 });
  await page.clock.runFor(500);
  await expect(page.locator('.companion-summary')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.companion-work')).toHaveCount(0);
  await page.evaluate(() => window.finishPetDrag?.());
  await page.clock.runFor(100);
  await expect(page.locator('.companion-work')).toHaveCount(0);
});
