import { expect, test } from '@playwright/test';
import { openScreen } from './visual';
import { mockIPhone } from './iphone-fixtures';
import { readRunState } from './run-state';

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900, isMobile: false, hasTouch: false },
  { name: 'iphone', width: 390, height: 844, isMobile: true, hasTouch: true },
]) {
  test.describe(`projects-${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.isMobile, hasTouch: viewport.hasTouch });
    const prepare = viewport.isMobile ? mockIPhone : undefined;

    test('a project document opens on its own sheet and keeps revisions after a refused save', async ({ page }) => {
      await openScreen(page, { name: 'projects', route: state => `/scopes/${state.scopeId}?view=documents`, waits: () => ['비행 기록 노트'], prepare }, 'light');
      const index = page.getByRole('region', { name: '저장된 문서', exact: true });
      const create = index.getByRole('button', { name: '새 문서', exact: true });
      await create.click();
      const editor = page.getByRole('region', { name: '새 문서', exact: true });
      const title = editor.getByRole('textbox', { name: '제목', exact: true });
      await expect(title).toBeFocused();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      if (viewport.isMobile) await expect(index).toBeHidden();
      else await expect(index).toBeVisible();
      await title.fill('새 문서의 제목');
      await editor.getByRole('combobox', { name: '형식' }).selectOption('pdc-html/1');
      const source = editor.getByRole('textbox', { name: '본문', exact: true });
      await source.fill('<h1>본문</h1>');
      await page.route('**/api/commands', route => route.request().postDataJSON().command.type === 'document.save'
        ? route.fulfill({ json: { ok: false, error: { code: 'invalid', message: '예시 저장 오류입니다.' } } })
        : route.fallback());
      await editor.getByRole('button', { name: '저장', exact: true }).click();
      await expect(editor.getByText('문서를 저장하지 못했습니다. 예시 저장 오류입니다.')).toBeVisible();
      await expect(title).toHaveValue('새 문서의 제목');
      await expect(source).toHaveValue('<h1>본문</h1>');
      await editor.getByRole('button', { name: '취소', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(create).toBeFocused();
    });

    test('project page opens on its conversation, switches tabs and hands off work', async ({ page }, info) => {
      const state = await openScreen(page, { name: 'projects', route: state => `/scopes/${state.scopeId}`, waits: () => ['세 가지 요청'], prepare }, 'light');
      await page.screenshot({ path: info.outputPath(`project-page-${viewport.name}.png`), animations: 'disabled' });
      const tabs = page.getByRole('navigation', { name: '프로젝트 내용' });
      await expect(tabs.getByRole('button', { name: '대화', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(tabs.getByRole('button', { name: '설정', exact: true })).toBeVisible();
      // The seeded Work and its decision belong to no project, so this room neither lists them nor shows a progress strip.
      await expect(page.getByRole('region', { name: '이 프로젝트의 진행 상황' })).toHaveCount(0);
      await expect(page.locator('.project__body').getByText('회의 메모 요약')).toHaveCount(0);
      await tabs.getByRole('button', { name: '문서', exact: true }).click();
      await expect(page).toHaveURL(`${state.baseUrl}/#/scopes/${state.scopeId}?view=documents`);
      await expect(page.getByText('비행 기록 노트', { exact: true })).toBeVisible();
      await tabs.getByRole('button', { name: '대화', exact: true }).click();
      await expect(page).toHaveURL(`${state.baseUrl}/#/scopes/${state.scopeId}?view=conversation`);
      const chat = page.getByRole('region', { name: '도우미와 대화', exact: true });
      await expect(chat.getByLabel('도우미에게 메시지', { exact: true })).toBeVisible();
      await expect(chat.getByRole('button', { name: '비행 기록 프로젝트 빼기' })).toBeVisible();
      const chatDraft = chat.getByLabel('도우미에게 메시지', { exact: true });
      await chatDraft.fill('이 대화의 초안');
      const assign = page.getByRole('button', { name: '일 맡기기', exact: true });
      await assign.click();
      const dispatch = page.getByRole('form', { name: '일 맡기기', exact: true });
      await expect(page.getByRole('dialog', { name: '일 맡기기', exact: true })).toHaveCount(0);
      const recipient = dispatch.getByRole('combobox', { name: '맡길 Ghost', exact: true });
      await expect(recipient).toHaveValue(state.defaultGhostId);
      await expect(dispatch.getByRole('button', { name: '비행 기록 프로젝트 빼기' })).toBeVisible();
      await dispatch.getByRole('button', { name: '취소', exact: true }).click();
      await expect(dispatch).toHaveCount(0);
      await expect(assign).toBeFocused();
      await expect(chatDraft).toHaveValue('이 대화의 초안');
      await expect(page).toHaveURL(`${state.baseUrl}/#/scopes/${state.scopeId}?view=conversation`);

      await assign.click();
      const [researcher] = await recipient.selectOption({ label: '연구원' });
      await dispatch.getByRole('textbox', { name: '제목', exact: true }).fill('비행 기록 검토');
      await dispatch.getByRole('combobox', { name: '할 일', exact: true }).fill('누락된 기록을 찾아 줘');
      let sent: Record<string, unknown> | undefined;
      await page.route('**/api/commands', async route => {
        const body = route.request().postDataJSON();
        if (body.command.type !== 'work.create') return route.continue();
        sent = body.command;
        await route.fulfill({ json: { ok: true, result: { workId: state.workDoneId } } });
      });
      await dispatch.getByRole('button', { name: '일 맡기기', exact: true }).click();
      await expect(page).toHaveURL(`${state.baseUrl}/#/work/${state.workDoneId}`);
      expect(sent).toMatchObject({ type: 'work.create', ghostId: researcher, scopeId: state.scopeId, title: '비행 기록 검토', brief: '누락된 기록을 찾아 줘' });
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
      await expect.poll(() => sent).toMatchObject({ type: 'message.send', text: '먼저  뒤에', scopeId: state.scopeId });
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
      expect(sent).toMatchObject({ type: 'work.create', brief: '계획을 세워줘', scopeId: state.scopeId });
      await page.goto(`${state.baseUrl}/#/work`);
      await page.getByRole('button', { name: '일 맡기기', exact: true }).click();
      const dispatch = page.getByRole('form', { name: '일 맡기기', exact: true });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const title = dispatch.getByRole('textbox', { name: '제목', exact: true });
      const brief = dispatch.getByRole('combobox', { name: '할 일', exact: true });
      await title.fill('비행 기록 검토');
      await title.press('Enter');
      await expect(brief).toBeFocused();
      await brief.fill('#');
      await brief.press('Enter');
      await expect(dispatch.getByRole('button', { name: '비행 기록 프로젝트 빼기' })).toBeVisible();
      await brief.fill('계획을 검토해 줘');
      await brief.press('Enter');
      const criteria = dispatch.getByRole('textbox', { name: '완료 기준', exact: true });
      await expect(criteria).toBeFocused();
      await criteria.fill('빠진 항목 목록');
      await criteria.press('Enter');
      await expect(dispatch.getByLabel('기한', { exact: true })).toBeFocused();
      await dispatch.getByRole('button', { name: '일 맡기기', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/work/${state.workDoneId}`));
      expect(sent).toMatchObject({ type: 'work.create', title: '비행 기록 검토', brief: '계획을 검토해 줘',
        ghostId: state.defaultGhostId, scopeId: state.scopeId, acceptance: { criteria: '빠진 항목 목록', checks: [], reviewer: null } });
    });

    test('Work edits stay in the brief and keep structured references and review settings', async ({ page }, info) => {
      const seed = readRunState();
      const reviewer = { kind: 'ghost', ghostId: seed.defaultGhostId };
      await openScreen(page, { name: 'project-work', route: () => `/work/${seed.workLiveId}`, waits: () => ['계획을 세워줘'],
        prepare: async page => {
          await prepare?.(page);
          await page.route(`**/api/works/${seed.workLiveId}`, async route => {
            const response = await route.fetch();
            const detail = await response.json();
            detail.work.brief = '계획을 세워줘';
            detail.work.scopeReferences = [{ id: seed.scopeId, name: '비행 기록' }];
            detail.work.acceptance = { criteria: '항목 세 가지', checks: [], reviewer };
            detail.work.deadlineAt = Date.UTC(2099, 0, 10, 10);
            await route.fulfill({ response, json: detail });
          });
        },
      }, 'light');
      await expect(page.locator('.work-brief')).toHaveText('계획을 세워줘');
      await expect(page.locator('.work-section').getByRole('link', { name: '비행 기록', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '수정', exact: true }).click();
      const editor = page.getByRole('form', { name: '맡긴 일 수정', exact: true });
      const title = page.locator('.work-head').getByRole('textbox', { name: '제목', exact: true });
      const criteria = page.locator('.work-bar').getByRole('textbox', { name: '완료 기준', exact: true });
      const brief = editor.getByRole('textbox', { name: '할 일', exact: true });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(title).toBeFocused();
      await expect(criteria).toHaveValue('항목 세 가지');
      await expect(brief).toHaveValue('계획을 세워줘');
      await expect(page.locator('.work-section').getByRole('link', { name: '비행 기록', exact: true })).toHaveAttribute('href', `#/scopes/${seed.scopeId}`);
      await page.screenshot({ path: info.outputPath(`work-brief-edit-${viewport.name}.png`), animations: 'disabled' });
      await title.fill('비행 계획 수정');
      await brief.fill('계획을 수정해줘');
      await criteria.fill('일정과 담당자 포함');
      await page.getByRole('button', { name: '기한 지우기', exact: true }).click();
      expect(await page.getByLabel('기한', { exact: true }).inputValue()).toBe('');
      let sent: Record<string, unknown> | undefined;
      let fail = true;
      await page.route('**/api/commands', async route => {
        const body = route.request().postDataJSON();
        if (body.command.type !== 'work.update') return route.continue();
        sent = body.command;
        await route.fulfill({ json: fail
          ? { ok: false, error: { code: 'conflict', message: '잠시 뒤 다시 시도해 주세요.' } }
          : { ok: true, result: {} } });
      });
      const save = editor.getByRole('button', { name: '저장', exact: true });
      await save.click();
      await expect(editor.getByRole('alert')).toContainText('맡긴 일을 저장하지 못했습니다.');
      await expect(brief).toHaveValue('계획을 수정해줘');
      await expect(criteria).toHaveValue('일정과 담당자 포함');
      fail = false;
      await brief.press('Control+Enter');
      await expect(editor).not.toBeVisible();
      expect(sent).toMatchObject({ type: 'work.update', workId: seed.workLiveId, title: '비행 계획 수정', brief: '계획을 수정해줘',
        deadlineAt: null, acceptance: { criteria: '일정과 담당자 포함', checks: [], reviewer } });
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
      expect(sent).toMatchObject({ type: 'message.send', text: '계획을 알려줘', scopeId: state.scopeId });
    });
  });
}
