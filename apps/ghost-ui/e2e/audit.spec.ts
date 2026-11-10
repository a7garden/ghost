import { expect, test, type Page } from '@playwright/test';
import { openScreen, screenshot, type Theme } from './visual';
import { mockConversationActivity, mockIPhone, mockMessageNotification, mockRichConversation } from './iphone-fixtures';
import { mockStateDecisions, mockVaultApi, visualHandoffDecisionId, visualSecureDecisionId } from './mocks';
import type { Decision } from '@ghost/contract';

async function capture(page: Page, name: string, theme: Theme, device: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await screenshot(page, `${name}-${theme}-${device}.png`);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme });
    test('wide Tauri Mac frame', async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'Mac window chrome is desktop-only');
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
        Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { invoke: async (command: string) => command === 'companion_enabled' ? false : undefined } });
      });
      await openScreen(page, { name: 'tauri', route: () => '/', waits: () => ['진행 중', '최근 끝난 일'] }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-desktop-shell', '');
      expect(await page.locator('header[data-tauri-drag-region]').evaluate(element => getComputedStyle(element).getPropertyValue('--ghost-titlebar-macos-inset').trim())).toBe('80px');
      await capture(page, 'tauri-home', theme, info.project.name);
    });
    for (const tab of ['team', 'models', 'vault', 'devices', 'schedules', 'activities', 'connections', 'host', 'appearance']) {
      test(`settings ${tab}`, async ({ page }, info) => {
        await openScreen(page, { name: tab, route: () => `/settings?tab=${tab}`, waits: () => [], prepare: async page => {
          await mockIPhone(page);
          if (tab === 'vault') await mockVaultApi(page);
        } }, theme);
        await expect(page.locator('.ghost-settings__content-inner')).not.toBeEmpty();
        await capture(page, `settings-${tab}`, theme, info.project.name);
        if (tab === 'devices') {
          const conversation = page.getByRole('group', { name: '받을 알림' }).getByRole('button', { name: '대화', exact: true });
          await expect(conversation).toHaveAttribute('aria-pressed', 'true');
          const request = page.waitForRequest(request => request.url().endsWith('/api/commands') && request.postDataJSON()?.command?.type === 'device.alerts_update');
          await conversation.click();
          expect((await request).postDataJSON().command.alerts.mutedKinds).toContain('message');
          await expect(conversation).toHaveAttribute('aria-pressed', 'false');
          await conversation.click();
          await expect(conversation).toHaveAttribute('aria-pressed', 'true');
        }
        if (tab === 'models' && info.project.name === 'iphone') {
          const options = await page.getByRole('radiogroup', { name: '생각 수준' }).getByRole('radio').evaluateAll(elements =>
            elements.map(element => ({ width: element.clientWidth, height: element.clientHeight })));
          expect(options.every(option => option.width >= 44 && option.height >= 44)).toBe(true);
        }
        if (tab === 'appearance' && info.project.name === 'iphone') {
          const toggle = page.getByRole('switch');
          expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          expect((await toggle.boundingBox())!.width).toBeGreaterThanOrEqual(44);
          expect(await toggle.evaluate(element => getComputedStyle(element, '::before').height)).toBe('22px');
        }
        if (tab === 'team') {
          for (const name of ['역할 지시', '도구', '운영']) {
            const panel = page.locator('.ghost-panel').filter({ has: page.getByText(name, { exact: true }) });
            await panel.first().scrollIntoViewIfNeeded();
            await capture(page, `ghost-${name}`, theme, info.project.name);
          }
          await page.getByRole('button', { name: '도우미 꾸미기', exact: true }).click();
          await expect(page.getByRole('dialog', { name: '도우미 꾸미기' })).toBeVisible();
          if (info.project.name === 'iphone') {
            const swatches = await page.locator('.look-swatch').evaluateAll(elements => elements.map(element => ({ width: element.clientWidth, height: element.clientHeight })));
            expect(swatches.every(swatch => swatch.width >= 44 && swatch.width === swatch.height)).toBe(true);
          }
          await capture(page, 'ghost-design-dialog', theme, info.project.name);
          await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).last().click();
        }
        const trigger = { schedules: '반복 작업 예약', activities: '활동 만들기', connections: '연결 추가' }[tab];
        if (trigger) {
          if (tab === 'schedules') await page.clock.setFixedTime(new Date('2026-11-09T09:00:00.000Z'));
          await page.getByRole('button', { name: trigger, exact: true }).click();
          await expect(page.getByRole('dialog')).toBeVisible();
          await capture(page, `${tab}-dialog`, theme, info.project.name);
          if (tab === 'connections') {
            await page.getByRole('radio', { name: '메일', exact: true }).click();
            await capture(page, 'connection-mail-dialog', theme, info.project.name);
          }
          await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).last().click();
        }
      });
    }
    test('project editor and command palette', async ({ page }, info) => {
      await openScreen(page, { name: 'project', route: state => `/spaces/${state.spaceId}`, waits: () => ['비행 기록 노트'] }, theme);
      await capture(page, 'project', theme, info.project.name);
      await page.getByRole('button', { name: /비행 기록 노트/ }).click();
      await expect(page.getByRole('dialog').getByRole('textbox', { name: '제목', exact: true })).toHaveValue('비행 기록 노트');
      await expect(page.getByRole('dialog').locator('.cm-editor')).toBeVisible();
      await capture(page, 'document-editor', theme, info.project.name);
      await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).last().click();
      await page.getByRole('button', { name: '명령 검색', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await capture(page, 'command-palette', theme, info.project.name);
    });
    test('proactive conversation notifications', async ({ page }, info) => {
      const state = await openScreen(page, { name: 'message', route: () => '/', waits: () => ['새 대화'], prepare: mockMessageNotification }, theme);
      const news = page.getByRole('button', { name: /도우미 아침에 확인한 자료를 정리했어요/ });
      await expect(news.locator('.dot-avatar')).toBeVisible();
      await capture(page, 'message-home', theme, info.project.name);
      await news.click();
      await expect(page).toHaveURL(`${state.baseUrl}/#/ghosts/${state.defaultGhostId}?conversation=${state.conversationA}`);
      await page.goto(`${state.baseUrl}/#/inbox`);
      await expect(page.getByText('아침에 확인한 자료를 정리했어요.', { exact: false })).toBeVisible();
      await capture(page, 'message-inbox', theme, info.project.name);
      await page.getByRole('button', { name: /도우미 아침에 확인한 자료를 정리했어요/ }).click();
      await expect(page).toHaveURL(`${state.baseUrl}/#/ghosts/${state.defaultGhostId}?conversation=${state.conversationA}`);
    });
    test('live reply tool trail and thread', async ({ page }, info) => {
      const state = await openScreen(page, { name: 'live', route: state => `/ghosts/${state.defaultGhostId}`, waits: () => [], prepare: mockConversationActivity }, theme);
      await expect(page.getByText('자료를 비교하고 있어요.', { exact: false })).toBeVisible();
      await capture(page, 'conversation-live', theme, info.project.name);
      await page.locator('.trail:not([data-live]) > summary').click();
      await expect(page.getByText('세 가지 자료를 읽고 중요한 차이를 정리했습니다.')).toBeVisible();
      await capture(page, 'tool-trail', theme, info.project.name);
      await page.goto(`${state.baseUrl}/#/ghosts/${state.defaultGhostId}?thread=${state.workLiveId}`);
      await expect(page.locator('.thread-panel')).toBeVisible();
      await expect(page.locator('.thread-panel .chat-live__text')).toHaveText('자료를 비교하고 있어요. 확인이 필요한 차이부터 정리해서 전해드릴게요.');
      await page.locator('.thread-panel').evaluate(async panel => {
        await Promise.all([panel, ...panel.children].flatMap(element => element.getAnimations().map(animation => animation.finished)));
      });
      await capture(page, 'conversation-thread', theme, info.project.name);
    });
    test('decision kinds and detail', async ({ page }, info) => {
      const state = await openScreen(page, { name: 'decisions', route: () => '/inbox', waits: () => ['어떤 항목부터 조사할까요?'], prepare: mockStateDecisions }, theme);
      for (const [name, id] of [['question', state.questionDecisionId], ['secure', visualSecureDecisionId], ['handoff', visualHandoffDecisionId]]) {
        await page.goto(`${state.baseUrl}/#/inbox?decision=${id}`);
        await expect(page.locator('.decision')).toBeVisible();
        await capture(page, `decision-${name}`, theme, info.project.name);
      }
      await page.goto(`${state.baseUrl}/#/work/${state.workLiveId}`);
      await expect(page.locator('.decision')).toBeVisible();
      await capture(page, 'work-review', theme, info.project.name);
      await page.goto(`${state.baseUrl}/#/work/${state.workDoneId}`);
      await expect(page.getByRole('heading', { name: '주간 보고 초안', exact: true })).toBeVisible();
      await capture(page, 'work-done-detail', theme, info.project.name);
    });
    test('approval document and reconciliation decisions', async ({ page }, info) => {
      const ids = ['approve_effect', 'document_review', 'reconcile_effect'] as const;
      const state = await openScreen(page, { name: 'decision-kinds', route: () => '/inbox?decision=audit-approve_effect', waits: () => ['자료 발행 승인'], prepare: async page => {
        await page.route('**/api/state', async route => {
          const response = await route.fetch();
          const state = await response.json();
          const base = { ghostId: state.ghosts[0].id, conversationId: state.ghosts[0].directConversationId, workId: null, effectId: null, options: [], state: 'pending', answer: null, resolvedAt: null, createdAt: 1 };
          const decisions: Decision[] = [
            { ...base, id: 'audit-approve_effect', kind: 'approve_effect', title: '자료 발행 승인', detail: '검토한 내용을 공유합니다.', proposal: { command: 'publish report --visibility team', cwd: '/workspace/reports', reason: '검토한 내용을 팀에 공유합니다.' } },
            { ...base, id: 'audit-document_review', kind: 'document_review', title: '조사 기록 저장', detail: '프로젝트 문서에 정리한 내용을 저장합니다.', proposal: { title: '이번 주 조사 기록', body: '# 관찰\n\n처리 시간과 오류 기록을 비교했습니다.\n\n- 자료의 날짜 확인\n- 출처 비교\n- 다음 확인 항목 정리' } },
            { ...base, id: 'audit-reconcile_effect', kind: 'reconcile_effect', title: '중단된 알림 전송 확인', detail: '전송 중 연결이 끊겨 결과를 확인해야 합니다.', proposal: { recipient: 'team@example.com', subject: '조사 결과 안내', body: '이번 주 조사 결과를 공유합니다.' } },
          ];
          await route.fulfill({ response, json: { ...state, decisions } });
        });
      } }, theme);
      for (const kind of ids) {
        await page.goto(`${state.baseUrl}/#/inbox?decision=audit-${kind}`);
        await expect(page.locator(`[data-decision-kind="${kind}"]`)).toBeVisible();
        await capture(page, `decision-${kind}`, theme, info.project.name);
      }
    });
    test('vault loading and error remain distinct from empty', async ({ page }, info) => {
      const { promise: pending, resolve: release } = Promise.withResolvers<void>();
      await openScreen(page, { name: 'vault-loading', route: () => '/settings?tab=vault', waits: () => [], prepare: async page => {
        await page.route('**/api/vault/items', async route => {
          await pending;
          await route.fulfill({ status: 503, json: { ok: false, error: { code: 'internal', message: '금고를 읽지 못했습니다.' } } });
        });
      } }, theme);
      await expect(page.getByRole('status')).toHaveText('금고를 불러오는 중…');
      await capture(page, 'vault-loading', theme, info.project.name);
      release();
      await expect(page.getByRole('alert')).toContainText('금고를 읽지 못했습니다.');
      await expect(page.getByText('금고 항목 없음', { exact: true })).toHaveCount(0);
      await capture(page, 'vault-error', theme, info.project.name);
    });
    test('interactive presentation desktop and phone', async ({ page }, info) => {
      await openScreen(page, { name: 'interactive', route: state => `/ghosts/${state.defaultGhostId}`, waits: () => [], prepare: mockRichConversation }, theme);
      const transcript = page.locator('.ghost-conversation__transcript');
      await expect(page.getByRole('heading', { name: '주간 조사', exact: true })).toBeAttached();
      await transcript.dispatchEvent('touchmove');
      await transcript.evaluate(element => { element.scrollTop = 0; });
      await capture(page, 'interactive-chart', theme, info.project.name);
      for (const [name, title] of [['comparison', '접근 방식 비교'], ['choices', '다음 조사'], ['form', '조사 범위'], ['html', '보고서 미리보기']]) {
        await page.getByRole('heading', { name: title, exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
        await capture(page, `interactive-${name}`, theme, info.project.name);
      }
    });
  });
}
