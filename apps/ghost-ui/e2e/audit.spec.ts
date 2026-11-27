import { expect, test, type Page } from '@playwright/test';
import { openScreen, screenshot, type Theme } from './visual';
import { mockConversationActivity, mockIPhone, mockMessageNotification, mockRichConversation, showTranscriptElement } from './iphone-fixtures';
import { mockShadeApi, mockStateDecisions, mockVaultApi, visualHandoffDecisionId, visualSecureDecisionId } from './mocks';
import type { Decision, MemoryView, ProviderQuota, State } from '@ghost/contract';
import { readRunState } from './run-state';

async function capture(page: Page, name: string, theme: Theme, device: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await screenshot(page, `${name}-${theme}-${device}.png`);
}

test('Ghost chat drafts a suggested next message without sending it', async ({ page }) => {
  const { conversationA } = readRunState();
  const suggestions = ['보고서 초안을 보여 주세요.', '우선순위를 다시 정리해 주세요.'];
  const messages: unknown[] = [];
  await page.route('**/api/commands', async route => {
    const request = route.request();
    const command = request.postDataJSON()?.command;
    if (command?.type !== 'message.send') return route.fallback();
    messages.push(command);
    await route.abort();
  });
  const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/suggestions');
  await openScreen(page, { name: 'conversation', route: state => `/ghosts/${state.defaultGhostId}`, waits: () => ['맡긴 일에서 볼 수 있어요'], prepare: async page => {
    await page.route('**/api/suggestions?*', route => route.fulfill({ json: {
      suggestions: new URL(route.request().url()).searchParams.get('conversation') === conversationA ? suggestions : [],
    } }));
  } }, 'light');
  expect(new URL((await requested).url()).searchParams.get('conversation')).toBe(conversationA);
  const list = page.getByRole('list', { name: '다음 메시지 제안', exact: true });
  await expect(list.locator('[data-active]')).toHaveText(suggestions[0]!);
  const field = page.getByRole('combobox', { name: '도우미에게 메시지', exact: true });
  await expect(field).toHaveValue('');
  const more = page.getByRole('button', { name: '다른 제안', exact: true });
  await expect(more).toHaveText('1/2');
  await field.press('ArrowDown');
  await expect(list.locator('[data-active]')).toHaveText(suggestions[1]!);
  await expect(more).toHaveText('2/2');
  await more.click();
  await expect(list.locator('[data-active]')).toHaveText(suggestions[0]!);
  await field.press('ArrowDown');
  await field.press('Tab');
  await expect(field).toHaveValue(suggestions[1]!);
  await expect(field).toBeFocused();
  await expect(list).toHaveCount(0);
  expect(messages).toEqual([]);
});

test('model settings expose the next-message switch and model', async ({ page }) => {
  await openScreen(page, { name: 'models', route: () => '/settings?tab=models', waits: () => [], prepare: page =>
    page.route('**/api/providers/quota*', route => route.fulfill({ json: [] })) }, 'light');
  const enabled = page.getByRole('switch', { name: '다음 메시지 제안', exact: true });
  const model = page.getByRole('combobox', { name: '제안 모델', exact: true });
  await expect(enabled).toBeChecked();
  await expect(model).toBeEnabled();
  try {
    const saved = page.waitForResponse(response => response.url().endsWith('/api/commands') &&
      response.request().postDataJSON()?.command?.type === 'settings.update');
    await enabled.click();
    const response = await saved;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON().command).toEqual({ type: 'settings.update', nextMessageSuggestions: false });
    await expect(enabled).not.toBeChecked();
    await expect(model).toHaveCount(0);
  } finally {
    if (!await enabled.isChecked()) await enabled.click();
    await expect(enabled).toBeChecked();
    await expect(model).toBeEnabled();
  }
});

test('the roster shows the lone main Ghost without a pool or pin actions', async ({ page }, info) => {
  await openScreen(page, { name: 'single Ghost roster', route: () => info.project.name === 'iphone' ? '/workspace' : '/', waits: () => ['비행 기록'], prepare: async page => {
    await page.route('**/api/state', async route => {
      const response = await route.fetch();
      const state: State = await response.json();
      await route.fulfill({ response, json: { ...state, ghosts: state.ghosts.filter(ghost => ghost.isDefault) } });
    });
  } }, 'light');
  const phone = info.project.name === 'iphone';
  const roster = phone ? page.getByRole('region', { name: '대화', exact: true })
    : page.getByRole('navigation', { name: '작업실', exact: true }).filter({ visible: true });
  const main = roster.locator(phone ? 'button.roster-row' : '.presence-row__main').filter({ hasText: '도우미' });
  await expect(main).toBeVisible();
  if (!phone) await expect(main.locator('.presence-row__main-mark')).toHaveCount(0);
  await expect(roster.locator('.sidebar-pool-toggle')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('single-main-sidebar.png'), animations: 'disabled', caret: 'hide' });
  if (info.project.name === 'desktop') {
    await main.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '도우미 메뉴', exact: true });
    await expect(menu.getByRole('menuitem', { name: '대화 열기', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^고정/ })).toHaveCount(0);
  }
});

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
    for (const tab of ['team', 'models', 'vault', 'devices', 'schedules', 'activities', 'connections', 'host', 'coding', 'appearance']) {
      test(`settings ${tab}`, async ({ page }, info) => {
        await openScreen(page, { name: tab, route: () => `/settings?tab=${tab}`, waits: () => [], prepare: async page => {
          await mockIPhone(page);
          if (tab === 'vault') await mockVaultApi(page);
          if (tab === 'connections') {
            // Never turn this Mac's GitHub CLI sign-in into a visual baseline.
            await page.route('**/api/connect/local', route => route.fulfill({ json: { accounts: [
              { source: 'gh', serviceId: 'github', login: 'ghost-owner', scopes: ['gist', 'repo'], connectionId: null },
            ] } }));
          }
          if (tab === 'models') {
            // Never turn the Mac account's live quota into a visual baseline.
            const { fixedNow } = readRunState();
            const hour = 60 * 60 * 1000;
            const quota = { id: 'claude-code', name: 'Claude', plan: 'Max 5x', error: null, fetchedAt: fixedNow, windows: [
              { label: '5시간', usedPercent: 14, resetsAt: fixedNow + 3 * hour },
              { label: '주간', usedPercent: 60, resetsAt: fixedNow + 72 * hour },
            ] } satisfies ProviderQuota;
            const providerQuota = { ...quota, id: 'visual_mock', name: 'Visual Mock', plan: null,
              windows: [{ label: '월간', usedPercent: 92, resetsAt: fixedNow + 72 * hour }],
            } satisfies ProviderQuota;
            await page.route('**/api/providers/quota*', route => route.fulfill({ json: info.project.name === 'desktop' ? [quota, providerQuota] : [providerQuota] }));
          }
          if (tab === 'team') {
            const { defaultGhostId, fixedNow } = readRunState();
            await page.route(`**/api/memory/${defaultGhostId}`, route => route.fulfill({ json: {
              files: [{ path: '/me/MEMORY.md', content: '보고는 요약부터 시작합니다.', hash: 'visual-memory', revision: 1,
                updatedAt: fixedNow - 60_000, author: '도우미', trust: 'untrusted', reads: 0, lastReadAt: null, sources: [] }],
              runs: [],
            } satisfies MemoryView }));
          }
        } }, theme);
        await expect(page.locator('.ghost-settings__content-inner')).not.toBeEmpty();
        if (tab === 'models') {
          const provider = page.getByRole('listitem').filter({ hasText: 'Visual Mock' });
          await expect(provider.getByRole('meter', { name: '월간 사용량' })).toHaveAttribute('aria-valuenow', '92');
          if (info.project.name === 'desktop') {
            await expect(page.getByRole('meter', { name: '5시간 사용량' })).toHaveAttribute('aria-valuenow', '14');
            await expect(page.getByRole('meter', { name: '주간 사용량' })).toHaveAttribute('aria-valuenow', '60');
          }
        }
        if (tab === 'coding') await expect(page.getByRole('heading', { name: '내장 코딩 기본값' })).toBeVisible();
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
          const roster = page.getByRole('list', { name: '설정할 Ghost' });
          if (info.project.name === 'iphone') await roster.getByRole('button', { name: '도우미', exact: true }).tap();
          else await expect(roster.getByRole('button', { name: '도우미', exact: true })).toHaveAttribute('aria-pressed', 'true');
          for (const name of ['페르소나', '도구', '운영']) {
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
        const trigger = { schedules: '반복 작업 예약', activities: '활동 만들기' }[tab];
        if (trigger) {
          if (tab === 'schedules') await page.clock.setFixedTime(new Date('2026-11-09T09:00:00.000Z'));
          await page.getByRole('button', { name: trigger, exact: true }).click();
          const editor = page.getByRole('form', { name: trigger, exact: true });
          await expect(editor).toBeVisible();
          await expect(page.getByRole('dialog')).toHaveCount(0);
          if (tab === 'schedules') await editor.getByRole('combobox', { name: '실행 방식' }).selectOption('every');
          await capture(page, `${tab}-inline`, theme, info.project.name);
          await editor.getByRole('button', { name: '취소', exact: true }).click();
        }
        if (tab === 'connections') {
          await page.getByRole('textbox', { name: '서비스 추가', exact: true }).fill('iCloud');
          await page.getByRole('button', { name: 'iCloud 연결', exact: true }).click();
          const setup = page.getByRole('region', { name: '이메일 연결', exact: true });
          await expect(setup).toBeVisible();
          await capture(page, 'connection-mail-inline', theme, info.project.name);
          await setup.getByRole('button', { name: '취소', exact: true }).click();
        }
      });
    }
    test('project editor and command palette', async ({ page }, info) => {
      await openScreen(page, { name: 'project', route: state => `/scopes/${state.scopeId}?view=documents`, waits: () => ['비행 기록 노트', '회의 정리'] }, theme);
      await capture(page, 'project', theme, info.project.name);
      await page.getByRole('button', { name: /비행 기록 노트/ }).click();
      // The document opens on its own page beside the index on wide screens and in the list's place on narrow ones.
      const editor = page.getByRole('region', { name: '비행 기록 노트' });
      await expect(editor.getByRole('textbox', { name: '제목', exact: true })).toHaveValue('비행 기록 노트');
      await expect(editor.locator('.cm-editor')).toBeVisible();
      await capture(page, 'document-editor', theme, info.project.name);
      await editor.getByRole('button', { name: '문서 목록', exact: true }).click();
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
      const transcript = page.locator('.ghost-conversation__transcript');
      const head = page.locator('.chat-head');
      if (info.project.name === 'iphone') {
        await expect(head).toHaveCount(0);
        await expect(page.locator('.chat-title-tools .chat-tools')).toBeVisible();
      } else {
        await expect(head.getByRole('heading')).toBeVisible();
        const headBounds = (await head.boundingBox())!;
        expect(headBounds.y + headBounds.height).toBeLessThanOrEqual((await transcript.boundingBox())!.y);
      }
      await capture(page, 'conversation-live', theme, info.project.name);
      const trail = page.locator('.transcript-activity .trail').filter({ hasText: '세 가지 자료를 읽고 중요한 차이를 정리했습니다.' });
      await trail.locator('summary').click();
      await expect(trail.locator('pre').first()).toBeInViewport();
      await capture(page, 'tool-trail', theme, info.project.name);
      const jump = page.getByRole('button', { name: '최신 메시지', exact: true });
      await transcript.dispatchEvent('touchmove');
      await transcript.evaluate(element => { element.scrollTop = 0; });
      await expect(jump).toBeVisible();
      const transcriptBounds = (await transcript.boundingBox())!;
      expect((await jump.boundingBox())!.y).toBeGreaterThanOrEqual(transcriptBounds.y + transcriptBounds.height);
      await jump.click();
      await expect(jump).toBeHidden();
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
        await expect(page.locator('.queue__card .decision')).toBeInViewport({ ratio: 1 });
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
        await expect(page.locator(`.queue__card [data-decision-kind="${kind}"]`)).toBeInViewport({ ratio: 1 });
        await capture(page, `decision-${kind}`, theme, info.project.name);
      }
    });
    test('vault loading and error remain distinct from empty', async ({ page }, info) => {
      const { promise: pending, resolve: release } = Promise.withResolvers<void>();
      await openScreen(page, { name: 'vault-loading', route: () => '/settings?tab=vault', waits: () => [], prepare: async page => {
        await mockShadeApi(page, 'unavailable');
        await page.route('**/api/vault/items', async route => {
          await pending;
          await route.fulfill({ status: 503, json: { ok: false, error: { code: 'internal', message: '금고를 읽지 못했습니다.' } } });
        });
      } }, theme);
      await expect(page.locator('.ghost-settings__content-inner').getByRole('status')).toHaveText('금고를 불러오는 중…');
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
        await showTranscriptElement(page.getByRole('heading', { name: title, exact: true }));
        await capture(page, `interactive-${name}`, theme, info.project.name);
      }
    });
  });
}
