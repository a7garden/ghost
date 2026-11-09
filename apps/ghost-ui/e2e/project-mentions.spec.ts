import { expect, test } from '@playwright/test';
import { openScreen } from './visual';
import { mockIPhone } from './iphone-fixtures';
import { projectContext } from '@ghost/contract';
import { readRunState } from './run-state';

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900, isMobile: false, hasTouch: false },
  { name: 'iphone', width: 390, height: 844, isMobile: true, hasTouch: true },
]) {
  test.describe(`projects-${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.isMobile, hasTouch: viewport.hasTouch });
    const prepare = viewport.isMobile ? mockIPhone : undefined;

    test('project page starts an addressed conversation and hand-off', async ({ page }, info) => {
      const state = await openScreen(page, { name: 'projects', route: state => `/spaces/${state.spaceId}`, waits: () => ['비행 기록 노트', '회의 정리'], prepare }, 'light');
      await expect(page.getByText('Ghost 접근', { exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`project-page-${viewport.name}.png`), animations: 'disabled' });
      await page.getByRole('button', { name: '대화하기', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/ghosts/${state.defaultGhostId}\\?space=${state.spaceId}`));
      await expect(page.getByRole('button', { name: '비행 기록 프로젝트 빼기' })).toBeVisible();
      await page.goto(`${state.baseUrl}/#/spaces/${state.spaceId}`);
      await page.getByRole('button', { name: '맡기기', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: '비행 기록 프로젝트 빼기' })).toBeVisible();
      await expect(dialog.getByRole('radio', { name: '맡기기', exact: true })).toHaveAttribute('aria-checked', 'true');
      await dialog.getByRole('button', { name: '받는 Ghost:', exact: false }).click();
      await expect(page.getByRole('button', { name: '연구원', exact: true })).toBeVisible();
    });

    test('hash suggestions insert chips mid-draft and send ids without changing visible text', async ({ page }, info) => {
      const state = await openScreen(page, { name: 'conversation', route: state => `/ghosts/${state.defaultGhostId}`, waits: () => ['맡긴 일에서 볼 수 있어요'], prepare }, 'light');
      const input = page.locator('#message-input');
      await input.fill('먼저  뒤에');
      await input.press('ArrowLeft');
      await input.press('ArrowLeft');
      await input.press('ArrowLeft');
      await input.pressSequentially('#비행');
      const option = page.getByRole('option', { name: '비행 기록', exact: true });
      await expect(option).toBeVisible();
      await page.screenshot({ path: info.outputPath(`project-suggestion-${viewport.name}.png`), animations: 'disabled' });
      await option.click();
      await expect(input).toHaveValue('먼저  뒤에');
      const chip = page.getByRole('button', { name: '비행 기록 프로젝트 빼기' });
      await expect(chip).toBeVisible();
      expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: info.outputPath(`project-chip-${viewport.name}.png`), animations: 'disabled' });
      let sent: Record<string, unknown> | undefined;
      await page.route('**/api/commands', async route => {
        const body = route.request().postDataJSON();
        if (body.command.type !== 'message.send') return route.continue();
        sent = body.command;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: {} }) });
      });
      await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
      await expect(input).toHaveValue('');
      expect(sent).toMatchObject({ type: 'message.send', text: '먼저  뒤에', spaceIds: [state.spaceId] });
      await expect(chip).toHaveCount(0);
    });

    test('home and Work composers share project suggestions', async ({ page }) => {
      const state = await openScreen(page, { name: 'home', route: () => '/', waits: () => ['진행 중'], prepare }, 'light');
      const input = page.locator('#handoff-message');
      await input.fill('#');
      await page.getByRole('option', { name: '비행 기록', exact: true }).click();
      await expect(page.getByRole('button', { name: '비행 기록 프로젝트 빼기' })).toBeVisible();
      await page.getByRole('radio', { name: '맡기기', exact: true }).click();
      await input.fill('계획을 세워줘');
      let sent: Record<string, unknown> | undefined;
      await page.route('**/api/commands', async route => {
        const body = route.request().postDataJSON();
        if (body.command.type !== 'work.create') return route.continue();
        sent = body.command;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: { workId: state.workDoneId } }) });
      });
      await page.getByRole('button', { name: '일 맡기기', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/work/${state.workDoneId}`));
      expect(sent).toMatchObject({ type: 'work.create', brief: '계획을 세워줘', spaceIds: [state.spaceId] });
      await page.goto(`${state.baseUrl}/#/work`);
      await page.getByRole('button', { name: '일 맡기기', exact: true }).click();
      const brief = page.getByRole('dialog').getByRole('combobox', { name: '할 일', exact: false });
      await brief.fill('#');
      await page.getByRole('option', { name: '비행 기록', exact: true }).click();
      await expect(page.getByRole('dialog').getByRole('button', { name: '비행 기록 프로젝트 빼기' })).toBeVisible();
    });

    test('Work briefs show project chips and preserve hidden context on edit', async ({ page }) => {
      const seed = readRunState();
      const context = projectContext([{ id: seed.spaceId, name: '비행 기록' }]);
      await openScreen(page, { name: 'project-work', route: () => `/work/${seed.workLiveId}`, waits: () => ['계획을 세워줘'],
        prepare: async page => {
          await prepare?.(page);
          await page.route(`**/api/works/${seed.workLiveId}`, async route => {
            const response = await route.fetch();
            const detail = await response.json();
            detail.work.brief = context + '계획을 세워줘';
            await route.fulfill({ response, json: detail });
          });
        },
      }, 'light');
      await expect(page.locator('.work-brief')).toHaveText('계획을 세워줘');
      await expect(page.locator('.work-section').getByRole('link', { name: '비행 기록', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '수정', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '맡긴 일 수정', exact: true });
      const brief = dialog.getByRole('textbox', { name: '할 일', exact: true });
      await expect(brief).toHaveValue('계획을 세워줘');
      await brief.fill('계획을 수정해줘');
      let sent: Record<string, unknown> | undefined;
      await page.route('**/api/commands', async route => {
        const body = route.request().postDataJSON();
        if (body.command.type !== 'work.update') return route.continue();
        sent = body.command;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: {} }) });
      });
      await dialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(sent?.brief).toBe('계획을 수정해줘');
    });

    test('the companion conversation uses the same project chips', async ({ page }) => {
      const state = await openScreen(page, { name: 'home', route: () => '/', waits: () => ['진행 중'], prepare }, 'light');
      await page.goto(`${state.baseUrl}/overlay.html`);
      const input = page.locator('#input');
      await expect(input).toBeEnabled();
      await input.fill('#');
      await page.getByRole('option', { name: '비행 기록', exact: true }).click();
      await expect(page.getByRole('button', { name: '비행 기록 프로젝트 빼기' })).toBeVisible();
      await input.fill('계획을 알려줘');
      let sent: Record<string, unknown> | undefined;
      await page.route('**/api/commands', async route => {
        const body = route.request().postDataJSON();
        if (body.command.type !== 'message.send') return route.continue();
        sent = body.command;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: {} }) });
      });
      await page.locator('#send').click();
      await expect(input).toHaveValue('');
      expect(sent).toMatchObject({ type: 'message.send', text: '계획을 알려줘', spaceIds: [state.spaceId] });
    });
  });
}
