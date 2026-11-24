import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ClaudeModels, CodingSetup, Effect, HerdrChat, HerdrChatItem, HerdrCommands, HerdrControlCommand, HerdrOutput, WorkDetail } from '@ghost/contract';
import { fulfillHerdrFrame, mockCodingApi, visualCodingIds } from './mocks';
import { openScreen, type Theme } from './visual';
import { readRunState } from './run-state';
import { mockWorkbench } from './workbench-mock';

const landing = { name: 'coding', route: () => '/', waits: () => ['최근 끝난 일'], prepare: mockCodingApi };
const herdrRoster = '/coding?view=herdr';
const coding = { ...landing, route: () => herdrRoster, waits: () => ['결제 화면 테스트 추가'] };
const richCoding = { ...coding, prepare: (page: Page) => mockCodingApi(page, { rich: true }) };
const stopped = { ...coding, waits: () => ['Mac 터미널에서 herdr를 여세요.'], prepare: (page: Page) => mockCodingApi(page, { stopped: true }) };
const sizes = [
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'phone', width: 390, height: 844, touch: true },
];

async function captureCoding(page: Page, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const entrances = document.getAnimations().filter(animation => animation.effect instanceof KeyframeEffect
      && animation.effect.target?.closest('.coding-page') && animation.effect.getTiming().iterations !== Infinity);
    await Promise.allSettled(entrances.map(animation => animation.finished));
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect.soft(page).toHaveScreenshot(name, { animations: 'disabled', caret: 'hide', threshold: 0.2 });
}

const post = (page: Page, path: string) => page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === path);
const paneRoute = (id: string) => `/coding?herdr=${encodeURIComponent(id)}`;
const terminal = (page: Page) => page.locator('.herdr-terminal-live .xterm-rows, .herdr-control .xterm-rows');
const liveScreen = (page: Page) => page.locator('.herdr-live-viewport');
const input = (page: Page) => page.getByRole('textbox', { name: '터미널 입력' });
const history = (page: Page) => page.getByRole('region', { name: '터미널 기록', exact: true });
const latest = (page: Page) => page.getByRole('button', { name: '실시간으로 돌아가기', exact: true });
const directControl = (page: Page) => page.getByRole('button', { name: '직접 조작', exact: true });
const controlRequest = (page: Page) => page.waitForRequest(request => new URL(request.url()).pathname === '/api/herdr/control');
const controlCommand = (page: Page, type: HerdrControlCommand['type']) => page.waitForRequest(request =>
  new URL(request.url()).pathname === '/api/herdr/control/send' && request.postDataJSON().type === type);
const followUp = (scope: Page | Locator) => scope.getByRole('combobox', { name: '후속 지시', exact: true });
const paneMode = (page: Page, name: '대화' | '터미널' | '변경') => page.getByRole('radio', { name, exact: true });
const terminalTools = (page: Page) => page.getByRole('toolbar', { name: '터미널 도구' });
const stop = (page: Page) => page.getByRole('button', { name: '작업 중단', exact: true });
const attachments = (page: Page) => page.getByRole('button', { name: '파일 첨부', exact: true });
const nextMessages = (page: Page) => page.getByRole('list', { name: '다음 메시지 제안', exact: true });
const suggested = ['로그인이 잠겼을 때도 같은 문구가 나오나요?', '변경한 테스트를 보여 주세요.'];
const mockPaneSuggestions = (page: Page) => page.route('**/api/herdr/suggestions?*', route => {
  const { searchParams } = new URL(route.request().url());
  return route.fulfill({ json: { suggestions: searchParams.get('pane') === visualCodingIds.finished ? suggested : [] } });
});
const back = (page: Page) => page.getByRole('navigation', { name: '위치' }).getByRole('button', { name: '뒤로', exact: true });
const codingNav = (page: Page, touch: boolean) => page.getByRole('navigation', { name: touch ? '주요 화면' : '작업실', exact: true });
async function openHerdrFromWorkbench(page: Page, touch: boolean) {
  await expect(page).toHaveURL(/#\/coding$/);
  if (touch) await page.getByRole('button', { name: '스페이스', exact: true }).click();
  await page.getByRole('link', { name: 'herdr', exact: true }).click();
}
const quickAdd = (page: Page) => page.getByRole('button', { name: '새 스페이스', exact: true });
const quickAddMenu = (page: Page) => page.getByRole('dialog', { name: '새 스페이스', exact: true });
async function openNewSpace(page: Page) {
  await quickAdd(page).click();
  const create = quickAddMenu(page).getByRole('link', { name: '새 스페이스…', exact: true });
  await expect(create).toHaveAttribute('href', '#/coding?new=1');
  await create.click();
  await expect(page).toHaveURL(/#\/coding\?new=1$/);
}
const composerSurface = (page: Page) => page.locator('.coding-composer .ghost-composer__surface');
const attachmentTray = (page: Page) => composerSurface(page).getByRole('list', { name: '첨부', exact: true });
const previewPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF5kAAAAASUVORK5CYII=', 'base64');
const fullCodingNotifications = '끝났을 때·답이 필요할 때·종료됐을 때';
const spaces = (page: Page) => page.getByRole('radio', { name: '스페이스', exact: true }).click();
const choice = async (page: Page, field: string, option: string) => {
  await page.getByRole('combobox', { name: field, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
};

async function chooseRosterAction(page: Page, node: string, label: string) {
  const menu = `${node} 작업`;
  await page.getByRole('button', { name: menu, exact: true }).click();
  await page.getByRole('dialog', { name: menu, exact: true }).getByRole('button', { name: label, exact: true }).click();
}

// Footer lines captured from omp stay on screen after both inline commands and pickers.
const ompScreen = '\n π > ◒ Sonnet 4.6 > 🗑 work ▶─0.9%──────────┃──────────1M─\n╰─                         ⇧⇥ to change thinking effort';

async function openCommandPane(page: Page, theme: Theme, after: readonly string[]) {
  const pane = visualCodingIds.finished;
  const events: Array<'screen' | 'prompt'> = [];
  let sent = false;
  let polls = 0;
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/herdr/prompt' && request.method() === 'POST') {
      events.push('prompt');
      sent = true;
    } else if (url.pathname === '/api/herdr/output' && url.searchParams.get('format') === 'text') {
      events.push('screen');
      expect(request.method()).toBe('GET');
      expect(Object.fromEntries(url.searchParams)).toEqual({ pane, format: 'text', lines: '200' });
    }
  });
  const commands = [{ name: 'compact', description: 'Compact the conversation', hint: null, source: 'builtin' }] satisfies HerdrCommands['commands'];
  await openScreen(page, { ...richCoding, route: () => paneRoute(pane), waits: () => ['기본 안내 문구'], prepare: async page => {
    await mockCodingApi(page, { rich: true, finishedScreen: () => sent ? after[Math.min(polls++, after.length - 1)]! : ompScreen });
    await page.route('**/api/herdr/commands?*', route => route.fulfill({ json: { commands } }));
  } }, theme);
  await expect(paneMode(page, '대화')).toBeChecked();
  return events;
}

for (const { name, width, height, touch } of sizes) {
  test.describe(name, () => {
    test.use({ viewport: { width, height }, isMobile: touch, hasTouch: touch });
    if (!touch) test.beforeEach(async ({ page }) => {
      // This viewport uses the Mac shortcut chrome even under the iPhone project.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'userAgentData', { value: { platform: 'macOS' } });
      });
    });
    for (const theme of ['light', 'dark'] as const) {
      test(`coding screen in ${theme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await openScreen(page, { ...richCoding, route: landing.route, waits: landing.waits, prepare: async page => {
          const now = readRunState().fixedNow;
          await page.addInitScript(({ now, pane }) => {
            localStorage.setItem('ghost.coding.activity:default', JSON.stringify({ [pane]: { status: 'working', changedAt: now - 120_000, openedAt: -1 } }));
          }, { now, pane: visualCodingIds.running });
          await mockCodingApi(page, { rich: true, owned: [visualCodingIds.shell] });
          await mockPaneSuggestions(page);
        } }, theme);
        await mockWorkbench(page);
        const nav = codingNav(page, touch);
        const codingLink = nav.getByRole('button', { name: /코딩/ });
        await expect(codingLink).toContainText('입력 필요');
        await expect(codingLink).toContainText('1');
        await codingLink.click();
        await openHerdrFromWorkbench(page, touch);
        await expect(page).toHaveURL(url => url.hash === `#${herdrRoster}`);
        const list = page.getByRole('region', { name: '코딩 세션', exact: true });
        await expect(list.getByRole('region', { name: '입력 필요', exact: true }).getByRole('button', { name: '이번만 실행' })).toBeVisible();
        await expect(list.getByRole('region', { name: '작업 중', exact: true }).getByText('2분')).toBeVisible();
        await expect(list.getByRole('region', { name: '완료 (읽지 않음)', exact: true })).toBeVisible();
        await captureCoding(page, `list-${theme}-${name}.png`);
        await spaces(page);
        const app = list.getByRole('region', { name: '스페이스 · app', exact: true });
        const running = app.getByRole('link', { name: /결제 화면 테스트 추가/ });
        const finished = app.getByRole('link', { name: /로그인 실패 시 안내 문구 고치기/ });
        const blocked = list.getByRole('region', { name: '스페이스 · ghost', exact: true }).getByRole('link', { name: /설정 화면 키보드 탐색 확인/ });
        const shell = app.getByRole('link', { name: /^zsh/ });
        const composer = followUp(page);
        const keys = page.getByRole('group', { name: '터미널 키', exact: true });
        await expect(app.getByRole('region', { name: '탭 · checkout' }).getByRole('link')).toHaveCount(2);
        await expect(app.getByRole('region', { name: '탭 · login' }).getByRole('link')).toHaveCount(1);
        await expect(list.getByRole('region', { name: '스페이스 · ghost', exact: true }).locator(':scope > .herdr-node-head'))
          .toHaveAttribute('title', 'fix/settings-navigation');
        await expect(blocked).toHaveAccessibleName('입력 필요 설정 화면 키보드 탐색 확인');
        await expect(list.getByText('에이전트 연동', { exact: true })).toBeVisible();
        await captureCoding(page, `spaces-${theme}-${name}.png`);

        await running.click();
        await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.running)}`);
        await expect(page.getByRole('radio', { name: '대화', exact: true })).toBeChecked();
        await expect(page.getByText('승인·거절 응답', { exact: true })).toBeVisible();
        await expect(composer).toBeEnabled();
        await expect(stop(page)).toBeVisible();
        if (!touch) await page.getByRole('radio', { name: '에이전트', exact: true }).click();
        await captureCoding(page, `chat-working-${theme}-${name}.png`);
        if (!touch) await spaces(page);
        await page.getByRole('radio', { name: '터미널', exact: true }).click();
        await expect(terminal(page)).toContainText('기존 결제 테스트');
        expect(await terminal(page).locator('.xterm-fg-6').count()).toBeGreaterThan(0);
        await expect(composer).toBeEnabled();
        await expect(attachments(page)).toBeVisible();
        await expect(terminalTools(page).getByRole('button', { name: '작업 중단', exact: true })).toHaveCount(0);
        await expect(stop(page)).toBeVisible();
        await expect(keys).toHaveCount(touch ? 1 : 0);
        if (touch) {
          await expect(list).toBeHidden();
          await expect(nav).toBeHidden();
        } else await expect(list).toBeVisible();
        await captureCoding(page, `running-${theme}-${name}.png`);
        if (touch) await back(page).click();

        await finished.click();
        await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.finished)}`);
        await expect(composer).toBeEnabled();
        if (!touch) await expect(composer).toBeFocused();
        await expect(page.getByRole('radio', { name: '변경' })).toBeVisible();
        const modeGroup = page.getByRole('radiogroup', { name: '패널 보기' });
        await expect(modeGroup.getByRole('radio')).toHaveCount(3);
        for (const label of ['대화', '터미널', '변경'] as const) {
          const option = paneMode(page, label);
          await expect(option.locator('svg')).toBeVisible();
          await expect(option.getByText(label, { exact: true })).toHaveClass('sr-only');
        }
        const conversation = page.getByRole('region', { name: '에이전트 대화' });
        await expect(conversation.getByText('기본 안내 문구', { exact: true })).toBeVisible();
        const fold = conversation.getByText('3단계 · 3분', { exact: true });
        await expect(conversation.getByText('bun test src/auth/login.test.ts', { exact: true })).toBeHidden();
        await fold.click();
        await expect(conversation.getByText('bun test src/auth/login.test.ts', { exact: true })).toBeVisible();
        await fold.click();
        await expect(nextMessages(page).locator('[data-active]')).toHaveText(suggested[0]!);
        await captureCoding(page, `chat-done-${theme}-${name}.png`);
        await page.getByRole('radio', { name: '터미널', exact: true }).click();
        await expect(terminal(page)).toContainText('3 pass');
        await expect(composer).toBeEnabled();
        await expect(terminal(page).locator('b')).toHaveCount(0);
        await captureCoding(page, `finished-${theme}-${name}.png`);

        await expect(page.getByRole('button', { name: '기록', exact: true })).toHaveCount(0);
        await liveScreen(page).hover();
        await page.mouse.wheel(0, -19);
        await expect(history(page).locator('.xterm-rows')).toContainText('3 pass');
        await expect(history(page).locator('.xterm-rows .xterm-fg-6').first()).toBeVisible();
        await expect(history(page).locator('.xterm-rows b')).toHaveCount(0);
        await expect(nextMessages(page)).toHaveCount(0);
        await captureCoding(page, `history-${theme}-${name}.png`);

        await page.getByRole('radio', { name: '변경' }).click();
        await expect(page.getByRole('region', { name: '작업 변경' }).getByText('fix/login-message', { exact: true })).toBeVisible();
        await expect(composer).toHaveCount(0);
        await expect(attachments(page)).toHaveCount(0);
        await page.getByText('커밋 1', { exact: true }).click();
        await expect(page.getByText('Show a fallback on login errors')).toBeVisible();
        await page.getByRole('button', { name: /src\/auth\/login\.ts/ }).click();
        const diff = page.getByLabel('파일 차이');
        if (touch) expect((await diff.boundingBox())!.y).toBeLessThan(165);
        await expect(diff.locator('[data-kind="addition"]').first()).toContainText('로그인할 수 없습니다.');
        await expect(diff.locator('[data-kind="deletion"]').first()).toContainText('return showError');
        await page.getByRole('button', { name: '줄 바꿈' }).click();
        await expect(diff).toHaveAttribute('data-wrap', 'true');
        const refresh = page.waitForRequest(request => new URL(request.url()).pathname === '/api/herdr/changes');
        await page.getByRole('button', { name: '변경 새로고침' }).click();
        expect(new URL((await refresh).url()).searchParams.get('pane')).toBe(visualCodingIds.finished);
        await captureCoding(page, `diff-${theme}-${name}.png`);
        if (touch) {
          await page.getByRole('button', { name: '파일 목록' }).click();
          await expect(page.getByRole('list', { name: '변경한 파일' })).toBeVisible();
        }
        if (touch) await back(page).click();

        await blocked.click();
        const blockedPane = page.getByRole('region', { name: '설정 화면 키보드 탐색 확인', exact: true });
        await expect(blockedPane.getByRole('region', { name: '승인 요청' })).toBeVisible();
        // A blocked agent shows its approval card instead of the follow-up field.
        await expect(composer).toHaveCount(0);
        await captureCoding(page, `chat-blocked-${theme}-${name}.png`);
        await page.getByRole('radio', { name: '터미널', exact: true }).click();
        await expect(terminal(page)).toContainText('Do you want to proceed?');
        await expect(composer).toHaveCount(0);
        await expect(stop(page)).toHaveCount(0);
        await expect(keys.getByRole('button', { name: '추가 키' })).toBeVisible();
        if (touch) {
          const bounds = await keys.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
          expect(bounds.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
        }
        await captureCoding(page, `blocked-${theme}-${name}.png`);
        if (touch) await back(page).click();

        await shell.click();
        await expect(terminal(page)).toContainText('git status --short');
        await expect(composer).toHaveCount(0);
        await expect(attachments(page)).toHaveCount(0);
        await expect(page.getByRole('radio', { name: '대화' })).toHaveCount(0);
        await expect(page.getByRole('radio', { name: '변경' })).toHaveCount(0);
        await captureCoding(page, `shell-${theme}-${name}.png`);
        if (touch) await back(page).click();

        await openNewSpace(page);
        await expect(page.getByRole('combobox', { name: '에이전트' })).toHaveText('Claude Code');
        await expect(page.getByRole('button', { name: '스페이스 만들기' })).toBeEnabled();
        await page.getByRole('textbox', { name: '디렉터리', exact: true }).fill('/Projects/app');
        // The capture proves the common path with launch options still folded; the omp test exercises the options.
        await captureCoding(page, `new-${theme}-${name}.png`);
      });

      test(`herdr setup in ${theme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await openScreen(page, stopped, theme);
        await expect(page.getByRole('region', { name: 'herdr 연결' })).toBeVisible();
        await expect(page.getByRole('button', { name: '이 세션 쓰기' })).toHaveCount(1);
        await captureCoding(page, `setup-${theme}-${name}.png`);
      });
    }

    test('starts and interrupts an agent, preserves rejected prompts and sends a follow-up', async ({ page }) => {
      await openScreen(page, richCoding, 'light');
      await openNewSpace(page);
      const task = page.getByRole('textbox', { name: '첫 지시 (선택)' });
      const start = page.getByRole('button', { name: '스페이스 만들기' });
      const repo = page.getByRole('textbox', { name: '디렉터리', exact: true });
      await task.fill('엔터 입력 확인\n두 번째 줄');
      await repo.fill('/missing');
      await start.click();
      await expect(page.getByRole('alert')).toHaveText('디렉터리를 찾을 수 없습니다.');
      await expect(task).toHaveValue('엔터 입력 확인\n두 번째 줄');
      await page.getByRole('button', { name: '프로젝트 경로 선택' }).click();
      const project = page.getByRole('dialog', { name: '프로젝트 경로 선택' }).getByRole('button', { name: /^비행 기록/ });
      const path = await project.locator('code').innerText();
      await project.click();
      await expect(repo).toHaveValue(path);
      await page.getByText('옵션', { exact: true }).click();
      await page.getByRole('textbox', { name: '이름 (선택)', exact: true }).fill('새 작업');
      await page.getByRole('textbox', { name: '브랜치 이름 (선택)' }).fill('test/keyboard');
      const { promise: hold, resolve: release } = Promise.withResolvers<void>();
      await page.route('**/api/herdr/workspaces', async route => {
        await hold;
        await route.fallback();
      }, { times: 1 });
      const created = post(page, '/api/herdr/workspaces');
      try {
        if (touch) await start.click(); else await task.press('Control+Enter');
        expect((await created).postDataJSON()).toEqual({
          agent: 'claude', cwd: path, label: '새 작업', branch: 'test/keyboard', task: '엔터 입력 확인\n두 번째 줄', worktree: true,
        });
        await expect(page.getByRole('button', { name: '만드는 중…' })).toBeDisabled();
      } finally { release(); }
      await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.started)}`);
      await expect(terminal(page)).toContainText('두 번째 줄');
      const interrupted = controlCommand(page, 'input');
      if (touch) {
        await page.getByRole('group', { name: '터미널 키' }).getByRole('button', { name: '중단 (Esc)', exact: true }).tap();
      } else {
        const composerStop = page.locator('.coding-composer').getByRole('button', { name: '작업 중단', exact: true });
        await expect(composerStop).toHaveAttribute('title', '작업 중단 (Esc)');
        await composerStop.click();
      }
      expect((await interrupted).postDataJSON()).toMatchObject({ pane: visualCodingIds.started, type: 'input', text: '\x1b' });
      await expect(terminal(page)).toContainText('Interrupted');
      if (touch) await back(page).click();

      await page.getByRole('link', { name: /로그인 실패 시 안내 문구 고치기/ }).click();
      const replyPane = page.getByRole('region', { name: '로그인 실패 시 안내 문구 고치기', exact: true });
      await expect(replyPane.getByRole('radio', { name: '대화', exact: true })).toBeChecked();
      const compose = followUp(replyPane);
      const send = replyPane.getByRole('button', { name: '보내기', exact: true });
      await compose.fill('실패 응답도 확인해 주세요.');
      if (touch) {
        await compose.press('Enter');
        await expect(compose).toHaveValue('실패 응답도 확인해 주세요.\n');
        await compose.fill('실패 응답도 확인해 주세요.\n오류 문구를 확인해 주세요.');
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 500 });
          window.visualViewport!.dispatchEvent(new Event('resize'));
        });
        await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open');
        const sendBounds = (await send.boundingBox())!;
        expect(sendBounds.y + sendBounds.height).toBeLessThanOrEqual(500);
      }
      const text = await compose.inputValue();
      await page.route('**/api/herdr/prompt', route => route.fulfill({
        status: 409, json: { error: { code: 'conflict', message: '승인에 먼저 답하세요.' } },
      }), { times: 1 });
      await send.click();
      const conversation = replyPane.getByRole('region', { name: '에이전트 대화' });
      const rejected = conversation.locator('.herdr-chat-user[data-delivery="failed"]');
      await expect(rejected).toContainText(text);
      await expect(rejected.getByRole('status')).toHaveText('보내지 못했어요. 승인에 먼저 답하세요.');
      await expect(compose).toHaveValue('');
      await rejected.getByRole('button', { name: '입력창으로', exact: true }).click();
      await expect(rejected).toHaveCount(0);
      await expect(compose).toHaveValue(text);
      await page.route('**/api/herdr/prompt', route => route.fulfill({
        status: 409, json: { error: { code: 'conflict', message: '승인에 먼저 답하세요.' } },
      }), { times: 1 });
      if (touch) await send.click(); else await compose.press('Meta+Enter');
      await expect(rejected.getByRole('button', { name: '다시 보내기', exact: true })).toBeEnabled();
      const { promise: holdRetry, resolve: releaseRetry } = Promise.withResolvers<void>();
      await page.route('**/api/herdr/prompt', async route => { await holdRetry; await route.fallback(); }, { times: 1 });
      const sent = post(page, '/api/herdr/prompt');
      try {
        await rejected.getByRole('button', { name: '다시 보내기', exact: true }).click();
        expect((await sent).postDataJSON()).toEqual({ pane: visualCodingIds.finished, text });
        const pending = conversation.locator('.herdr-chat-user[data-delivery="pending"]');
        await expect(pending).toContainText(text);
        await expect(pending.getByRole('status')).toHaveText('보내는 중…');
      } finally { releaseRetry(); }
      await expect(compose).toHaveValue('');
      await expect(compose).toBeEnabled();
      await expect(conversation.getByText(text, { exact: true })).toHaveCount(1);
      await expect(conversation.locator('.herdr-chat-user[data-delivery]')).toHaveCount(0);
    });

    test('restores the open pane after going Home and returning through Coding navigation', async ({ page }) => {
      await openScreen(page, { ...landing, prepare: richCoding.prepare }, 'light');
      await mockWorkbench(page);
      const nav = codingNav(page, touch);
      const codingLink = nav.getByRole('button', { name: /코딩/ });
      await expect(codingLink).toContainText('입력 필요');
      await codingLink.click();
      await openHerdrFromWorkbench(page, touch);
      await expect(page).toHaveURL(url => url.hash === `#${herdrRoster}`);
      await page.getByRole('link', { name: /로그인 실패 시 안내 문구 고치기/ }).click();
      const hash = `#${paneRoute(visualCodingIds.finished)}`;
      await expect(page).toHaveURL(url => url.hash === hash);
      await expect(followUp(page)).toBeEnabled();
      if (touch) {
        // Compact detail has a back button instead of the dock, and approvals take priority over restore.
        await back(page).click();
        await expect(page).toHaveURL(url => url.hash === `#${herdrRoster}`);
      }
      await nav.getByRole('button', { name: '홈', exact: true }).click();
      await expect(page).toHaveURL(/#\/$/);
      await expect(page.getByText('최근 끝난 일', { exact: true })).toBeVisible();
      await codingLink.click();
      await openHerdrFromWorkbench(page, touch);
      if (touch) {
        await expect(page).toHaveURL(url => url.hash === `#${herdrRoster}`);
        const blocked = page.getByRole('region', { name: '입력 필요', exact: true });
        await expect(blocked).toBeVisible();
        await blocked.getByRole('button', { name: '이번만 실행', exact: true }).tap();
        await expect(blocked).toHaveCount(0);
        await nav.getByRole('button', { name: '홈', exact: true }).tap();
        await expect(page).toHaveURL(/#\/$/);
        await codingLink.tap();
        await openHerdrFromWorkbench(page, touch);
      }
      await expect(page).toHaveURL(url => url.hash === hash);
      await expect(followUp(page)).toBeEnabled();
    });

    test('keeps the composer enabled in an idle agent pane', async ({ page }) => {
      const pane = visualCodingIds.finished;
      await openScreen(page, { ...richCoding, route: () => paneRoute(pane), waits: () => ['기본 안내 문구'],
        prepare: page => mockCodingApi(page, { rich: true, finishedStatus: 'idle' }) }, 'light');
      await expect(paneMode(page, '대화')).toBeChecked();
      await expect(followUp(page)).toBeVisible();
      await expect(followUp(page)).toBeEnabled();
      await expect(followUp(page)).toHaveAttribute('placeholder', '메시지');
      await expect(stop(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: '이어서 시작', exact: true })).toHaveCount(0);
    });

    for (const [label, options] of [['이어서 시작', { args: ['--continue'] }], ['새로 시작', {}]] as const) {
      test(`starts an agent from an exited pane with ${label}`, async ({ page }) => {
        const pane = visualCodingIds.finished;
        await openScreen(page, { ...richCoding, route: () => paneRoute(pane), waits: () => [],
          prepare: page => mockCodingApi(page, { rich: true, finishedAgent: null }) }, 'light');
        await expect(terminal(page)).toContainText('3 pass');
        await expect(followUp(page)).toHaveCount(0);
        for (const name of ['이어서 시작', '새로 시작']) {
          await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
        }
        const started = post(page, '/api/herdr/agents');
        await page.getByRole('button', { name: label, exact: true }).click();
        expect((await started).postDataJSON()).toEqual({ pane, agent: 'claude', ...options });
        await expect(page).toHaveURL(url => url.hash === `#${paneRoute(pane)}`);
        await expect(followUp(page)).toBeEnabled();
        await expect(page.getByRole('button', { name: '이어서 시작', exact: true })).toHaveCount(0);
      });
    }

    test('quick-adds a recent directory without a worktree and opens the returned pane', async ({ page }, info) => {
      await openScreen(page, richCoding, 'light');
      await quickAdd(page).click();
      const menu = quickAddMenu(page);
      const cwd = '/Users/garden/Workspace/Projects/app';
      const directory = menu.getByRole('button', { name: `app ${cwd}`, exact: true });
      await expect(directory).toBeEnabled();
      await expect(menu.getByRole('link', { name: '새 스페이스…', exact: true })).toHaveAttribute('href', '#/coding?new=1');
      await page.screenshot({ path: info.outputPath('coding-quick-add.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
      const created = post(page, '/api/herdr/workspaces');
      await directory.click();
      const request = await created;
      expect(request.postDataJSON()).toEqual({ cwd, agent: 'claude', worktree: false });
      const response = await request.response();
      expect(response?.ok()).toBe(true);
      const { id } = await response!.json();
      await expect(page).toHaveURL(url => url.hash === `#${paneRoute(id)}`);
      await expect(menu).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: '디렉터리', exact: true })).toHaveCount(0);
      await expect(followUp(page)).toBeEnabled();
    });

    test('uploads an image into the tray and sends its path separately from prompt text', async ({ page }) => {
      const pane = visualCodingIds.finished;
      const filename = touch ? '확인.png' : 'checkout.png';
      await openScreen(page, { ...richCoding, route: () => paneRoute(pane), waits: () => ['기본 안내 문구'] }, 'light');
      const field = followUp(page);
      const text = '이 화면도 확인해 주세요.';
      await field.fill(text);
      const upload = post(page, '/api/herdr/upload');
      const picker = page.waitForEvent('filechooser');
      if (touch) await attachments(page).tap(); else await attachments(page).click();
      await (await picker).setFiles({ name: filename, mimeType: 'image/png', buffer: previewPng });
      const request = await upload;
      expect(new URL(request.url()).searchParams.get('name')).toBe(filename);
      expect(request.headers()['content-type']).toBe('image/png');
      expect(request.headers().authorization).toMatch(/^Bearer /);
      expect(request.postDataBuffer()).toEqual(previewPng);
      const uploadResponse = await request.response();
      expect(uploadResponse?.ok()).toBe(true);
      const { path } = await uploadResponse!.json();
      const tile = attachmentTray(page).getByRole('listitem');
      await expect(tile).toHaveAttribute('data-status', 'ready');
      const image = tile.locator('img');
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(1);
      expect((await image.boundingBox())!.y).toBeLessThan((await field.boundingBox())!.y);
      await expect(field).toHaveValue(text);
      const sent = post(page, '/api/herdr/prompt');
      const send = page.getByRole('button', { name: '보내기', exact: true });
      if (touch) await send.tap(); else await send.click();
      expect((await sent).postDataJSON()).toEqual({ pane, text, attachments: [path] });
      await expect(field).toHaveValue('');
      await expect(attachmentTray(page)).toHaveCount(0);
    });

    test('stops a working agent from the chat composer', async ({ page }) => {
      const pane = visualCodingIds.running;
      await openScreen(page, { ...richCoding, route: () => paneRoute(pane), waits: () => [] }, 'light');
      await expect(page.getByRole('radio', { name: '대화', exact: true })).toBeChecked();
      await expect(followUp(page)).toBeEnabled();
      await expect(page.locator('.coding-detail-head').getByRole('button', { name: '작업 중단', exact: true })).toHaveCount(0);
      const stopBox = (await stop(page).boundingBox())!;
      const sendBox = (await composerSurface(page).getByRole('button', { name: '보내기', exact: true }).boundingBox())!;
      expect(stopBox.width).toBeGreaterThanOrEqual(touch ? 44 : 34);
      expect(stopBox.height).toBe(sendBox.height);
      expect(Math.abs(stopBox.y - sendBox.y)).toBeLessThan(1);
      const interrupted = post(page, '/api/herdr/input');
      await stop(page).click();
      expect((await interrupted).postDataJSON()).toEqual({ pane, keys: ['esc'] });
      await expect(stop(page)).toHaveCount(0);
    });

    test('offers next messages after a finished pane and drafts one without sending', async ({ page }) => {
      const pane = visualCodingIds.finished;
      const prompts: unknown[] = [];
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/herdr/prompt' && request.method() === 'POST') prompts.push(request.postDataJSON());
      });
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/herdr/suggestions');
      await openScreen(page, { ...richCoding, route: () => paneRoute(pane), waits: () => ['기본 안내 문구'], prepare: async page => {
        await mockCodingApi(page, { rich: true });
        await mockPaneSuggestions(page);
      } }, 'light');
      expect(new URL((await requested).url()).searchParams.get('pane')).toBe(pane);
      const rows = nextMessages(page);
      await expect(rows.locator('[data-active]')).toHaveText(suggested[0]!);
      await expect(page.getByRole('button', { name: `제안 넣기: ${suggested[0]}`, exact: true })).toContainText('Tab');
      const field = followUp(page);
      await expect(field).toHaveValue('');
      await field.press('Tab');
      await expect(field).toHaveValue(suggested[0]!);
      await expect(field).toBeFocused();
      await expect(rows).toHaveCount(0);
      await field.fill('');
      await page.getByRole('button', { name: '다른 제안', exact: true }).click();
      await page.getByRole('button', { name: `제안 넣기: ${suggested[1]}`, exact: true }).click();
      await expect(field).toHaveValue(suggested[1]!);
      await expect(field).toBeFocused();
      expect(prompts).toEqual([]);
    });

    test('keeps the agent draft in chat and terminal, but hides the composer in changes, blocked and shell panes', async ({ page }) => {
      const pane = visualCodingIds.finished;
      await openScreen(page, { ...richCoding, route: () => paneRoute(pane), waits: () => ['기본 안내 문구'] }, 'light');
      const field = followUp(page);
      const draft = '터미널에서 이어서 쓸 초안';
      await expect(paneMode(page, '대화')).toBeChecked();
      await field.fill(draft);
      await paneMode(page, '터미널').click();
      await expect(terminal(page)).toContainText('3 pass');
      await expect(field).toBeEnabled();
      await expect(field).toHaveValue(draft);
      await expect(attachments(page)).toBeVisible();
      if (touch) await expect(page.getByRole('group', { name: '터미널 키' })).toBeVisible();
      await paneMode(page, '변경').click();
      await expect(page.getByRole('region', { name: '작업 변경' })).toBeVisible();
      await expect(field).toHaveCount(0);
      await paneMode(page, '대화').click();
      await expect(field).toHaveValue(draft);

      await page.evaluate(route => { location.hash = route; }, paneRoute(visualCodingIds.blocked));
      const blockedPane = page.getByRole('region', { name: '설정 화면 키보드 탐색 확인', exact: true });
      await expect(blockedPane.getByRole('region', { name: '승인 요청' })).toBeVisible();
      await expect(field).toHaveCount(0);
      await paneMode(page, '터미널').click();
      await expect(terminal(page)).toContainText('Do you want to proceed?');
      await expect(page.getByRole('group', { name: '터미널 키' })).toBeVisible();
      await expect(field).toHaveCount(0);

      await page.evaluate(route => { location.hash = route; }, paneRoute(visualCodingIds.shell));
      await expect(terminal(page)).toContainText('git status --short');
      await expect(paneMode(page, '대화')).toHaveCount(0);
      await expect(field).toHaveCount(0);
    });

    test('filters slash commands and completes them without sending', async ({ page }, info) => {
      const pane = visualCodingIds.finished;
      const commands = [
        { name: 'compact', description: 'Compact the conversation', hint: null, source: 'builtin' },
        { name: 'config', description: 'Open settings', hint: null, source: 'builtin' },
        { name: 'model', description: 'Change model', hint: 'provider/model', source: 'builtin' },
      ] satisfies HerdrCommands['commands'];
      const prompts: unknown[] = [];
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/herdr/prompt') prompts.push(request.postDataJSON());
      });
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/herdr/commands');
      await openScreen(page, { ...richCoding, route: () => paneRoute(pane), waits: () => ['기본 안내 문구'], prepare: async page => {
        await mockCodingApi(page, { rich: true });
        await page.route('**/api/herdr/commands?*', route => route.fulfill({ json: { commands } }));
      } }, 'light');
      expect(new URL((await requested).url()).searchParams.get('pane')).toBe(pane);
      const field = followUp(page);
      const list = page.getByRole('listbox', { name: '슬래시 명령' });
      const options = list.getByRole('option');
      await field.fill('한 줄에 /');
      await expect(list).toHaveCount(0);
      await field.fill('/');
      await expect(options).toHaveCount(3);
      await page.screenshot({ path: info.outputPath('slash-menu.png'), animations: 'disabled', caret: 'hide' });
      await field.fill('/co');
      await expect(options).toHaveCount(2);
      await expect(options.first()).toHaveAccessibleName(/^compact /);
      await field.press('ArrowDown');
      await expect(list.getByRole('option', { selected: true })).toHaveAccessibleName(/^config /);
      await field.press('Enter');
      await expect(field).toHaveValue('/config ');
      await expect(list).toHaveCount(0);
      expect(prompts).toEqual([]);

      await field.fill('/com');
      await expect(options).toHaveCount(1);
      await field.press('Tab');
      await expect(field).toHaveValue('/compact ');
      await expect(field).toBeFocused();
      await expect(list).toHaveCount(0);
      await field.fill('/compact');
      await expect(list).toBeVisible();
      await field.press('Escape');
      await expect(list).toHaveCount(0);
      await expect(field).toHaveValue('/compact');
      expect(prompts).toEqual([]);
    });

    for (const theme of ['light', 'dark'] as const) {
      test(`renders noninteractive slash output in chat in ${theme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        const command = '/compact';
        const warning = 'Warning: Nothing to compact (no messages yet)';
        const longLine = 'Session log: /Projects/app/.omp/sessions/2026-11-23T080000.000Z-session-with-a-long-directory-name.jsonl';
        const settled = `❯ ${command}\n ${warning}\n ${longLine}\n${ompScreen}`;
        const busy = `❯ ${command}\n⎋ Working… 1s\n${ompScreen}`;
        const events = await openCommandPane(page, theme, [busy, busy, settled]);
        const field = followUp(page);
        await field.fill(command);
        const sent = post(page, '/api/herdr/prompt');
        await page.getByRole('button', { name: '보내기', exact: true }).click();
        expect((await sent).postDataJSON()).toEqual({ pane: visualCodingIds.finished, text: command });
        await expect(field).toHaveValue('');

        const conversation = page.getByRole('region', { name: '에이전트 대화' });
        const result = conversation.getByRole('region', { name: `${command} 결과`, exact: true });
        await expect(result.locator('header code')).toHaveText(command);
        await expect(result.locator('pre')).toHaveJSProperty('textContent', `${warning}\n ${longLine}`);
        expect(events).toEqual(['screen', 'prompt', 'screen', 'screen', 'screen', 'screen']);
        await expect(paneMode(page, '대화')).toBeChecked();
        await expect(terminal(page)).toHaveCount(0);
        await captureCoding(page, `chat-command-result-${theme}-${name}.png`);

        await result.getByRole('button', { name: '터미널에서 보기', exact: true }).click();
        await expect(paneMode(page, '터미널')).toBeChecked();
        await expect(terminal(page)).toContainText(command);
      });
    }

    test('opens Terminal instead of rendering a chat block when a slash picker waits for keys', async ({ page }) => {
      const command = '/model';
      const hint = 'Enter to select · Esc to cancel';
      const picker = `Select model\n  1. Opus\n  2. Sonnet\n${hint}`;
      const events = await openCommandPane(page, 'light', [`${ompScreen}\n${picker}`]);
      await page.route('**/api/herdr/terminal?*', route => fulfillHerdrFrame(route, picker));
      await followUp(page).fill(command);
      const sent = post(page, '/api/herdr/prompt');
      await page.getByRole('button', { name: '보내기', exact: true }).click();
      expect((await sent).postDataJSON()).toEqual({ pane: visualCodingIds.finished, text: command });
      await expect(paneMode(page, '터미널')).toBeChecked();
      await expect(terminal(page)).toContainText(hint);
      expect(events).toEqual(['screen', 'prompt', 'screen', 'screen']);
      await paneMode(page, '대화').click();
      await expect(page.getByRole('region', { name: `${command} 결과`, exact: true })).toHaveCount(0);
    });

    test('shows the session model, changes it without leaving chat and locks the chip while working', async ({ page }, info) => {
      const pane = visualCodingIds.finished;
      await openScreen(page, { ...richCoding, route: () => paneRoute(pane), waits: () => ['기본 안내 문구'] }, 'dark');
      const chip = page.getByRole('button', { name: /^모델 · / });
      await expect(chip).toHaveAccessibleName('모델 · claude-sonnet-4-6');
      await expect(chip).toHaveAttribute('title', '모델 바꾸기');
      const loaded = page.waitForRequest(request => new URL(request.url()).pathname === '/api/coding/omp');
      await chip.click();
      expect(new URL((await loaded).url()).searchParams.get('cwd')).toBe('/Users/garden/Workspace/Projects/wt/app-fix-login');
      const models = page.getByRole('group', { name: '모델 목록' });
      await expect(models.getByRole('button', { name: /Claude Sonnet 4\.6/, pressed: true })).toBeVisible();
      const picked = post(page, '/api/herdr/prompt');
      await models.getByRole('button', { name: /GLM 5\.1/ }).click();
      expect((await picked).postDataJSON()).toEqual({ pane, text: '/model zai/glm-5.1' });
      await expect(paneMode(page, '대화')).toBeChecked();
      await expect(chip).toHaveAccessibleName('모델 · GLM 5.1');
      await expect(chip).toBeEnabled();

      await followUp(page).fill('실패 응답도 확인해 주세요.');
      await page.getByRole('button', { name: '보내기', exact: true }).click();
      await expect(page.getByRole('button', { name: '스티어링로 보내기', exact: true })).toBeVisible();
      await expect(composerSurface(page).getByText('스티어링', { exact: true })).toHaveCount(0);
      await expect(chip).toBeDisabled();
      await page.screenshot({ path: info.outputPath('omp-chat-working.png'), animations: 'disabled', caret: 'hide' });
      await paneMode(page, '터미널').click();
      await expect(terminal(page)).toContainText('3 pass');
      await expect(chip).toBeDisabled();
      await page.screenshot({ path: info.outputPath('omp-terminal-working.png'), animations: 'disabled', caret: 'hide' });
    });

    test('loads Claude model aliases and session IDs, then sends the chosen ID', async ({ page }) => {
      const pane = visualCodingIds.finished;
      const aliases = [
        { selector: 'default', name: '기본', provider: 'Claude' },
        { selector: 'opus', name: 'Opus', provider: 'Claude' },
        { selector: 'sonnet', name: 'Sonnet', provider: 'Claude' },
        { selector: 'haiku', name: 'Haiku', provider: 'Claude' },
      ] satisfies ClaudeModels['models'];
      const ids = [
        { selector: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', provider: 'Claude' },
        { selector: 'claude-opus-5-5', name: 'claude-opus-5-5', provider: 'Claude' },
      ] satisfies ClaudeModels['models'];
      await openScreen(page, { ...richCoding, route: () => paneRoute(pane), waits: () => ['기본 안내 문구'], prepare: async page => {
        await mockCodingApi(page, { rich: true, finishedAgent: 'claude' });
        await page.route('**/api/herdr/claude-models', route => route.fulfill({ json: { models: [...aliases, ...ids] } satisfies ClaudeModels }));
      } }, 'light');
      const chip = page.getByRole('button', { name: '모델 · claude-sonnet-4-6', exact: true });
      const loaded = page.waitForRequest(request => request.url().endsWith('/api/herdr/claude-models'));
      await chip.click();
      expect((await loaded).method()).toBe('GET');
      const choices = page.getByRole('group', { name: '모델 목록' }).getByRole('button');
      await expect(choices).toHaveText([...aliases, ...ids].map(model => `${model.name}Claude`));
      await expect(choices.filter({ hasText: 'claude-sonnet-4-6' })).toHaveAttribute('aria-pressed', 'true');
      const picked = post(page, '/api/herdr/prompt');
      await choices.filter({ hasText: 'claude-opus-5-5' }).click();
      expect((await picked).postDataJSON()).toEqual({ pane, text: '/model claude-opus-5-5' });
      await expect(paneMode(page, '대화')).toBeChecked();
    });

    test('moves the blocked choice with arrows, submits it and returns to the roster when the terminal ends', async ({ page }) => {
      await openScreen(page, { ...coding, route: () => paneRoute(visualCodingIds.blocked), waits: () => [] }, 'light');
      await expect(terminal(page)).toContainText('Do you want to proceed?');
      const keys = page.getByRole('group', { name: '터미널 키', exact: true });
      if (touch) {
        await input(page).focus();
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 460 });
          window.visualViewport!.dispatchEvent(new Event('resize'));
        });
        await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open');
        const live = await liveScreen(page).boundingBox();
        const bar = await keys.boundingBox();
        expect(live!.height).toBeGreaterThan(150);
        expect(bar!.y + bar!.height).toBeLessThanOrEqual(460);
      }
      const moved = post(page, '/api/herdr/input');
      if (touch) await keys.getByRole('button', { name: '아래쪽 화살표' }).click();
      else await input(page).press('ArrowDown');
      expect((await moved).postDataJSON()).toEqual(touch ? { pane: visualCodingIds.blocked, keys: ['down'] } : { pane: visualCodingIds.blocked, text: '\x1b[B' });
      await expect(terminal(page)).toContainText('❯ 2. Yes');
      const pressed = post(page, '/api/herdr/input');
      if (touch) await keys.getByRole('button', { name: 'Enter', exact: true }).click();
      else await input(page).press('2');
      expect((await pressed).postDataJSON()).toEqual(touch ? { pane: visualCodingIds.blocked, keys: ['enter'] } : { pane: visualCodingIds.blocked, text: '2' });
      await expect(terminal(page)).toContainText('Running tests');
      await page.route('**/api/herdr/terminal?*', route => touch
        ? route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'pane not found' } } })
        : fulfillHerdrFrame(route, 'panel closed', { end: true }));
      await expect(page).toHaveURL(url => url.hash === `#${herdrRoster}`);
      await expect(page.getByText('이 패널은 더 이상 없습니다.')).toBeVisible();
      await expect(terminal(page)).toHaveCount(0);
    });

    test('uses an already running session and installs an optional integration', async ({ page }) => {
      await openScreen(page, stopped, 'light');
      const setup = page.getByRole('region', { name: 'herdr 연결' });
      await expect(setup.getByRole('button', { name: '실행 명령 복사' })).toBeVisible();
      const saved = post(page, '/api/commands');
      await setup.getByRole('button', { name: '이 세션 쓰기' }).click();
      expect((await saved).postDataJSON().command).toEqual({ type: 'coding.set', session: 'studio', agent: 'claude', notify: 'all' });
      await expect(setup).toHaveCount(0);
      const disclosure = page.locator('details.coding-setup');
      await expect(disclosure).not.toHaveAttribute('open');
      await disclosure.getByText('에이전트 연동', { exact: true }).click();
      const installed = post(page, '/api/coding/integrations');
      await disclosure.getByRole('button', { name: '연동 설치' }).click();
      expect((await installed).postDataJSON()).toEqual({ agent: 'claude' });
      await expect(disclosure.getByText('Claude Code')).toHaveCount(0);
      await expect(disclosure.getByText('Mac에 설치하세요.')).toBeVisible();
    });
  });
}

test('working omp prompts use the configured delivery and Alt+Enter inverts it once', async ({ page }) => {
  const pane = visualCodingIds.finished;
  const hash = (value: string) => page.evaluate(next => { location.hash = next; }, value);
  await openScreen(page, { ...richCoding, route: () => paneRoute(pane), waits: () => ['기본 안내 문구'] }, 'light');
  const field = followUp(page);
  const send = async (text: string, button: string, delivery?: 'steer' | 'queue', key?: string) => {
    await expect(field).toBeEnabled();
    await field.fill(text);
    const request = post(page, '/api/herdr/prompt');
    if (key) await field.press(key);
    else await page.getByRole('button', { name: button, exact: true }).click();
    expect((await request).postDataJSON()).toEqual({ pane, text, ...(delivery ? { delivery } : {}) });
    await expect(field).toHaveValue('');
  };

  await send('작업을 이어서 해 주세요.', '보내기');
  await expect(page.getByRole('button', { name: '스티어링로 보내기', exact: true })).toBeVisible();
  await send('이 지시는 바로 적용해 주세요.', '스티어링로 보내기', 'steer');
  await send('이 지시는 끝난 뒤 적용해 주세요.', '스티어링로 보내기', 'queue', 'Alt+Enter');
  await expect(composerSurface(page).getByText('스티어링', { exact: true })).toHaveCount(0);

  const settings = '/settings?tab=coding';
  const group = page.getByRole('radiogroup', { name: '지시를 보내는 방식' });
  const steer = group.getByRole('radio', { name: '스티어링', exact: true });
  const queue = group.getByRole('radio', { name: '대기열', exact: true });
  await hash(settings);
  await expect(steer).toBeChecked();
  try {
    const saved = page.waitForResponse(response => response.url().endsWith('/api/commands') &&
      response.request().postDataJSON()?.command?.type === 'settings.update');
    await queue.click();
    const response = await saved;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON().command).toEqual({ type: 'settings.update', codingDelivery: 'queue' });
    await expect(queue).toBeChecked();
    await hash(paneRoute(pane));
    await expect(page.getByRole('button', { name: '대기열로 보내기', exact: true })).toBeVisible();
    await send('다음 차례에 테스트를 추가해 주세요.', '대기열로 보내기', 'queue');
    await send('이 지시만 바로 적용해 주세요.', '대기열로 보내기', 'steer', 'Alt+Enter');
    await expect(composerSurface(page).getByText('대기열', { exact: true })).toHaveCount(0);
  } finally {
    await hash(settings);
    await steer.click();
    await expect(steer).toBeChecked();
  }
});

test('rechecks setup, copies the install command, and reports when herdr stops later', async ({ page }) => {
  let setupOverride: CodingSetup | null = {
    herdr: { path: null, version: null }, config: { ok: false, note: 'config.toml: invalid key' }, session: 'default',
    sessions: [], server: null, agents: [], kinds: [], prefs: { session: null, agent: null, notify: 'off' },
  };
  await openScreen(page, {
    ...coding, waits: () => ['config.toml: invalid key'], prepare: async page => {
      await mockCodingApi(page);
      await page.route('**/api/coding', route => setupOverride ? route.fulfill({ json: setupOverride }) : route.fallback());
      await page.route('**/api/herdr', route => setupOverride ? route.fulfill({ json: {
        available: Boolean(setupOverride.herdr.path), session: 'default', note: 'herdr 서버가 실행 중이 아닙니다.', workspaces: [],
      } }) : route.fallback());
    },
  }, 'light');
  const setup = page.getByRole('region', { name: 'herdr 연결' });
  await expect(setup.getByText('curl -fsSL https://herdr.dev/install.sh | sh', { exact: true })).toBeVisible();
  await expect(setup.getByRole('link', { name: '설치 안내' })).toHaveAttribute('href', 'https://herdr.dev/tui/docs/install/');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await setup.getByRole('button', { name: '설치 명령 복사' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('curl -fsSL https://herdr.dev/install.sh | sh');
  setupOverride = null;
  await expect(setup).toHaveCount(0);
  await expect(page.getByRole('link', { name: /결제 화면 테스트 추가/ })).toBeVisible();
  setupOverride = {
    herdr: { path: '/bin/herdr', version: '1.4.0' }, config: { ok: true, note: null }, session: 'default',
    sessions: [{ name: 'default', running: false }], server: null, agents: [], kinds: [], prefs: { session: null, agent: null, notify: 'off' },
  };
  await expect(setup.getByText('Mac 터미널에서 herdr를 여세요.')).toBeVisible();
});

test('forwards native terminal input, including bracketed paste, and refits without changing the pane', async ({ page }) => {
  const requests: URL[] = [];
  const { baseUrl } = await openScreen(page, {
    ...coding, route: () => paneRoute(visualCodingIds.shell), waits: () => [], prepare: async page => {
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api/herdr/terminal') requests.push(url);
      });
      await mockCodingApi(page);
    },
  }, 'light');
  await expect(terminal(page)).toContainText('git status --short');
  expect(requests[0]?.searchParams.get('pane')).toBe(visualCodingIds.shell);
  expect(requests[0]?.searchParams.get('rows')).toBe('120');
  const enter = post(page, '/api/herdr/input');
  await input(page).press('Enter');
  expect((await enter).postDataJSON()).toEqual({ pane: visualCodingIds.shell, text: '\r' });
  const pasted = post(page, '/api/herdr/input');
  await input(page).evaluate(node => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'echo hello\npwd');
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
  });
  expect((await pasted).postDataJSON()).toEqual({ pane: visualCodingIds.shell, text: '\x1b[200~echo hello\rpwd\x1b[201~' });
  const interrupted = post(page, '/api/herdr/input');
  await input(page).press('Control+c');
  expect((await interrupted).postDataJSON()).toEqual({ pane: visualCodingIds.shell, text: '\x03' });
  await input(page).press('Shift+Escape');
  await expect(terminalTools(page).getByRole('button').first()).toBeFocused();
  const initial = requests[0]!.searchParams;
  const refitted = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/herdr/terminal' && url.searchParams.get('pane') === visualCodingIds.shell &&
      Number(url.searchParams.get('cols')) < Number(initial.get('cols')) && url.searchParams.get('rows') === '120';
  });
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width - 80, height: viewport.height - 80 });
  const resized = await refitted;
  expect(resized.headers()['authorization']).toMatch(/^Bearer /);
  await expect(page).toHaveURL(`${baseUrl}/#${paneRoute(visualCodingIds.shell)}`);
});

test('opens an owned pane in control and releases it before opening the next pane', async ({ page }) => {
  const order: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/herdr/control') order.push(`open:${url.searchParams.get('pane')}`);
    if (url.pathname === '/api/herdr/control/release') order.push(`release:${request.postDataJSON().pane}`);
    if (url.pathname === '/api/herdr/terminal') order.push('watch');
  });
  await openScreen(page, { ...richCoding, route: () => paneRoute(visualCodingIds.finished), waits: () => [], prepare: page =>
    mockCodingApi(page, { rich: true, owned: [visualCodingIds.finished, visualCodingIds.shell] }) }, 'light');
  await expect(page.getByRole('radio', { name: '대화' })).toBeChecked();
  expect(order).toEqual([]);
  const opened = controlRequest(page);
  await page.getByRole('radio', { name: '터미널' }).click();
  const query = new URL((await opened).url()).searchParams;
  expect(query.get('fit')).toBeNull();
  expect(query.get('client')).toMatch(/^[a-f0-9-]{36}$/);
  expect(Number(query.get('rows'))).toBeLessThan(120);
  await expect(directControl(page)).toHaveCount(0);
  await expect(terminal(page)).toContainText('3 pass');
  await expect(history(page)).toHaveCount(0);
  const tabRelease = post(page, '/api/herdr/control/release');
  await page.getByRole('radio', { name: '변경' }).click();
  expect((await tabRelease).postDataJSON().pane).toBe(visualCodingIds.finished);
  await page.getByRole('radio', { name: '터미널' }).click();
  await expect(directControl(page)).toHaveCount(0);
  await expect(page.locator('.herdr-control .xterm-rows')).toContainText('3 pass');
  const switched = controlRequest(page);
  await page.evaluate(pane => { location.hash = pane; }, paneRoute(visualCodingIds.shell));
  expect(new URL((await switched).url()).searchParams.get('client')).toBe(query.get('client'));
  await expect(terminal(page)).toContainText('git status');
  expect(order).toEqual([
    `open:${visualCodingIds.finished}`, `release:${visualCodingIds.finished}`, `open:${visualCodingIds.finished}`,
    `release:${visualCodingIds.finished}`, `open:${visualCodingIds.shell}`,
  ]);
});

test('observes a borrowed pane without resizing until 직접 조작, then releases it on leaving', async ({ page }) => {
  const control: URL[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/herdr/control') control.push(url);
  });
  await openScreen(page, { ...coding, route: () => paneRoute(visualCodingIds.shell), waits: () => [] }, 'light');
  await expect(terminal(page)).toContainText('git status');
  await expect(directControl(page)).toBeVisible();
  expect(control).toHaveLength(0); // Opening a shared pane never asks for a lease.
  const opened = controlRequest(page);
  await directControl(page).click(); // The press is the consent: no dialog, straight to a fitted lease.
  expect(new URL((await opened).url()).searchParams.get('fit')).toBe('1');
  await expect(terminal(page)).toContainText('git status');
  const released = post(page, '/api/herdr/control/release');
  await page.evaluate(next => { location.hash = next; }, paneRoute(visualCodingIds.finished));
  expect((await released).postDataJSON()).toEqual({ pane: visualCodingIds.shell, leaseId: '00000000-0000-4000-8000-000000000001' });
  await page.evaluate(back => { location.hash = back; }, paneRoute(visualCodingIds.shell));
  await expect(terminal(page)).toContainText('git status');
  expect(control).toHaveLength(1); // The explicit ask never carries over to the next visit.
  await directControl(page).click();
  await expect(page.locator('.herdr-control .xterm-rows')).toContainText('git status');
  expect(control[1]?.searchParams.get('fit')).toBe('1');
  const hideRelease = post(page, '/api/herdr/control/release');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const leaving = await hideRelease;
  expect(leaving.headers()['authorization']).toMatch(/^Bearer /);
  expect(leaving.postDataJSON().leaseId).not.toBe((await released).postDataJSON().leaseId);
  const resume = controlRequest(page);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(new URL((await resume).url()).searchParams.get('client')).toBe(control[0]?.searchParams.get('client'));
});

test('requires an explicit takeover when held and falls back to watch when taken', async ({ page }) => {
  const pane = visualCodingIds.shell;
  await openScreen(page, { ...coding, route: () => paneRoute(pane), waits: () => [], prepare: async page => {
    await mockCodingApi(page, { owned: [pane], held: [pane] });
    await page.route('**/api/herdr/control?*', async route => {
      const query = new URL(route.request().url()).searchParams;
      if (!query.has('takeover')) return route.fallback();
      return fulfillHerdrFrame(route, 'original controller', {
        lease: { pane, leaseId: '00000000-0000-4000-8000-000000000001', owned: true, baseline: { cols: 100, rows: 40 } },
        reason: 'taken',
      });
    });
  } }, 'dark');
  const dialog = page.getByRole('dialog', { name: '다른 곳에서 쓰는 중이에요. 가져올까요?' });
  await expect(dialog).toBeVisible();
  const takeover = controlRequest(page);
  await dialog.getByRole('button', { name: '가져오기' }).click();
  expect(new URL((await takeover).url()).searchParams.get('takeover')).toBe('1');
  await expect(page.getByText('다른 곳에서 이 패널을 가져갔어요.', { exact: true })).toBeVisible();
  await expect(directControl(page)).toBeVisible();
  await expect(liveScreen(page)).toBeVisible();
});

test('reopens a dropped control stream with the same client and never replays the takeover', async ({ page }) => {
  const pane = visualCodingIds.shell;
  const requests: URLSearchParams[] = [];
  const releases: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/herdr/control/release') releases.push(request.postDataJSON().pane);
  });
  await openScreen(page, { ...coding, route: () => paneRoute(pane), waits: () => [], prepare: async page => {
    await mockCodingApi(page, { owned: [pane], held: [pane] });
    await page.route('**/api/herdr/control?*', route => {
      const query = new URL(route.request().url()).searchParams;
      requests.push(query);
      if (requests.length === 1) return route.fallback();
      const first = requests.length === 2;
      return fulfillHerdrFrame(route, first ? 'original frame' : 'first full frame after reconnect', {
        drop: first,
        lease: { pane, leaseId: crypto.randomUUID(), owned: true, baseline: { cols: 100, rows: 40 } },
      });
    });
  } }, 'light');
  await page.getByRole('button', { name: '가져오기', exact: true }).click();
  await expect(terminal(page)).toContainText('first full frame after reconnect');
  expect(requests).toHaveLength(3);
  expect(requests[1]?.get('takeover')).toBe('1');
  expect(requests[2]?.get('takeover')).toBeNull();
  expect(new Set(requests.map(query => query.get('client'))).size).toBe(1);
  expect(releases).toEqual([]);
});

test('retains the last picture during loss and reconnects after the quiet interval', async ({ page }) => {
  let available = true;
  let text = 'previous terminal';
  await openScreen(page, {
    ...coding, route: () => paneRoute(visualCodingIds.shell), waits: () => [], prepare: async page => {
      await mockCodingApi(page);
      await page.route('**/api/herdr/terminal?*', route => available ? fulfillHerdrFrame(route, text)
        : route.fulfill({ contentType: 'text/event-stream', body: 'event: error\ndata: {"message":"stream unavailable"}\n\n' }));
    },
  }, 'light');
  await expect(terminal(page)).toContainText(text);
  available = false;
  const reconnecting = page.getByText('터미널에 다시 연결하는 중…', { exact: false });
  await expect(reconnecting).toHaveCount(0);
  await expect(reconnecting).toBeVisible();
  await expect(terminal(page)).toContainText(text);
  text = 'recovered terminal';
  available = true;
  await expect(terminal(page)).toContainText(text);
  await expect(reconnecting).toHaveCount(0);
});

test('manages workspaces, tabs, splits and shell agents through the roster', async ({ page, hasTouch }) => {
  await openScreen(page, coding, 'light');
  await spaces(page);
  const choose = (node: string, label: string) => chooseRosterAction(page, node, label);
  async function returnToRoster(text: string) {
    if (!hasTouch) return;
    // Let the new pane establish its lease before leaving, then wait for its release.
    await expect(terminal(page)).toContainText(text);
    const released = page.waitForResponse(response => response.url().endsWith('/api/herdr/control/release') && response.ok());
    await back(page).tap();
    await released;
  }
  await choose('app', '닫기');
  const close = page.getByRole('dialog', { name: '스페이스 닫기' });
  await expect(close.getByText('에서 실행 중인 프로세스가 종료됩니다.', { exact: false })).toBeVisible();
  await close.getByRole('button', { name: '스페이스 닫기', exact: true }).click();
  await expect(close.getByRole('alert')).toHaveText('워크트리 스페이스를 먼저 닫으세요.');
  await page.keyboard.press('Escape');
  await expect(close).toHaveCount(0);

  await choose('app', '이름 바꾸기');
  await page.getByRole('textbox', { name: '이름' }).fill('새 앱');
  const renamed = post(page, '/api/herdr/rename');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  expect((await renamed).postDataJSON()).toEqual({ target: 'workspace', id: 'w79', label: '새 앱' });
  await expect(page.getByRole('region', { name: '스페이스 · 새 앱' })).toBeVisible();

  await choose('새 앱', '새 탭 옵션…');
  await expect(page.getByRole('dialog', { name: '새 탭', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '이름 (선택)' }).fill('실험');
  const tab = post(page, '/api/herdr/tabs');
  await page.getByRole('button', { name: '탭 만들기' }).click();
  expect((await tab).postDataJSON()).toEqual({ workspace: 'w79', label: '실험' });
  await expect(page).toHaveURL(url => url.hash === `#${paneRoute('w79:p81')}`);
  await returnToRoster('zsh %');

  await choose('실험', '분할 옵션…');
  await expect(page.getByRole('dialog', { name: '오른쪽으로 분할', exact: true })).toBeVisible();
  const split = post(page, '/api/herdr/split');
  await page.getByRole('button', { name: '분할', exact: true }).click();
  expect((await split).postDataJSON()).toEqual({ pane: 'w79:p81', direction: 'right' });
  await expect(page).toHaveURL(url => url.hash === `#${paneRoute('w79:p82')}`);
  await returnToRoster('zsh %');
  const shell = page.getByRole('region', { name: '탭 · 실험', exact: true }).locator('.herdr-pane-row')
    .filter({ has: page.locator(`a[href="#${paneRoute('w79:p82')}"]`) });
  await shell.getByRole('button', { name: 'zsh 작업' }).click();
  await page.getByRole('dialog', { name: 'zsh 작업' }).getByRole('button', { name: '에이전트 옵션…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '에이전트 시작', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '에이전트' }).click();
  await expect(page.getByRole('option', { name: /설치 안 됨/ })).toHaveCount(0);
  await page.getByRole('option', { name: 'Pi', exact: true }).click();
  await page.getByRole('textbox', { name: '첫 지시 (선택)' }).fill('변경을 읽어 주세요.');
  const agent = post(page, '/api/herdr/agents');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  expect((await agent).postDataJSON()).toEqual({ pane: 'w79:p82', agent: 'pi', task: '변경을 읽어 주세요.' });
  await expect(terminal(page)).toContainText('변경을 읽어 주세요.');
  // An agent without a conversation view keeps its follow-up field beside the terminal.
  await expect(followUp(page)).toBeVisible();
  await returnToRoster('변경을 읽어 주세요.');

  await choose('실험', '닫기');
  const closing = post(page, '/api/herdr/close');
  await page.getByRole('button', { name: '탭 닫기', exact: true }).click();
  expect((await closing).postDataJSON()).toEqual({ target: 'tab', id: 'w79:t81' });
  await expect(page).toHaveURL(url => url.hash === `#${herdrRoster}`);
  await expect(page.getByRole('region', { name: '탭 · 실험' })).toHaveCount(0);
});

test('quick roster actions post immediately with the preferred agent and no options dialog', async ({ page }) => {
  await openScreen(page, coding, 'light');
  await spaces(page);
  async function quick(node: string, label: string, path: string, expected: object, openedPane: string) {
    const { promise: hold, resolve: release } = Promise.withResolvers<void>();
    await page.route(`**${path}`, async route => {
      await hold;
      await route.fallback();
    }, { times: 1 });
    const sent = post(page, path);
    try {
      await chooseRosterAction(page, node, label);
      expect((await sent).postDataJSON()).toEqual({ ...expected, agent: 'claude' });
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally { release(); }
    await expect(page).toHaveURL(url => url.hash === `#${paneRoute(openedPane)}`);
  }
  await quick('checkout', '오른쪽으로 분할', '/api/herdr/split', { pane: visualCodingIds.running, direction: 'right' }, 'w79:p81');
  await quick('checkout', '아래로 분할', '/api/herdr/split', { pane: 'w79:p81', direction: 'down' }, 'w79:p82');
  await quick('app', '새 탭', '/api/herdr/tabs', { workspace: 'w79' }, 'w79:p83');
  await quick('zsh', '에이전트 시작', '/api/herdr/agents', { pane: visualCodingIds.shell }, visualCodingIds.shell);
});

test('prefills a new space with the last directory successfully used', async ({ page }) => {
  await openScreen(page, { ...coding, route: () => '/coding?new=1', waits: () => [] }, 'light');
  const repo = page.getByRole('textbox', { name: '디렉터리', exact: true });
  const start = page.getByRole('button', { name: '스페이스 만들기' });
  await expect(repo).toHaveValue('');
  await repo.fill('/Projects/last-used');
  const created = post(page, '/api/herdr/workspaces');
  await start.click();
  expect((await created).postDataJSON()).toMatchObject({ cwd: '/Projects/last-used' });
  await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.started)}`);
  await openNewSpace(page);
  await expect(repo).toHaveValue('/Projects/last-used');
  await repo.fill('/missing');
  await start.click();
  await expect(page.getByRole('alert')).toHaveText('디렉터리를 찾을 수 없습니다.');
  await page.reload();
  await expect(repo).toHaveValue('/Projects/last-used');
});

test('preloads colour history, applies the original wheel delta, and keeps the anchor as output rolls', async ({ page }) => {
  let first = 0;
  let tail = 'first';
  const makeText = () => `${Array.from({ length: 150 - first }, (_, index) => `line ${index + first}`).join('\n')}\n\x1b[32m${tail}\x1b[0m`;
  const requests: URL[] = [];
  const output: HerdrOutput = {
    pane: { id: visualCodingIds.finished, workspaceId: 'w79', tabId: 'w79:tA', title: '긴 터미널', agent: 'omp', status: 'idle',
      workspace: 'app', cwd: null, tab: 'login', focused: true, owned: false },
    text: '',
  };
  await openScreen(page, {
    ...coding, route: () => paneRoute(output.pane.id), waits: () => [], prepare: async page => {
      await mockCodingApi(page);
      await page.route('**/api/herdr/output?*', route => {
        requests.push(new URL(route.request().url()));
        return route.fulfill({ json: { ...output, text: makeText() } });
      });
    },
  }, 'light');
  await page.getByRole('radio', { name: '터미널' }).click();
  const screen = history(page);
  const preloaded = page.locator('.herdr-terminal-history .xterm-rows');
  const rows = screen.locator('.xterm-rows');
  const scroller = screen.locator('.herdr-history-scroll');
  await expect(preloaded.locator('.xterm-fg-2')).toHaveText('first');
  expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({ pane: output.pane.id, format: 'ansi', lines: '2000' });
  await expect(latest(page)).toBeHidden();
  const end = await page.locator('.herdr-history-scroll').evaluate(node => node.scrollTop);
  const count = requests.length;
  await liveScreen(page).hover();
  await liveScreen(page).dispatchEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true });
  await expect(latest(page)).toBeVisible();
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(end - 240);
  await expect.poll(() => requests.length).toBeGreaterThan(count);
  const top = await rows.locator('> div').first().textContent();
  expect(top).toMatch(/line \d+/);
  first = 5;
  tail += '\nthird';
  await expect(preloaded).not.toContainText('third');
  await expect.poll(() => requests.length).toBeGreaterThan(count + 1);
  await expect(rows.locator('> div').first()).toHaveText(top!);
  await page.mouse.wheel(0, 2000);
  await expect(latest(page)).toBeHidden();
  await expect(input(page)).toBeFocused();
  await expect(terminal(page)).toContainText('3 pass');
});

test('keeps the live frame visible while the first history capture is pending', async ({ page }) => {
  const response = Promise.withResolvers<void>();
  await openScreen(page, { ...richCoding, route: () => paneRoute(visualCodingIds.finished), waits: () => [], prepare: async page => {
    await mockCodingApi(page, { rich: true });
    await page.route('**/api/herdr/output?*', async route => { await response.promise; await route.fallback(); });
  } }, 'light');
  try {
    await page.getByRole('radio', { name: '터미널' }).click();
    await expect(terminal(page)).toContainText('3 pass');
    await liveScreen(page).hover();
    await page.mouse.wheel(0, -140);
    await expect(terminal(page)).toBeVisible();
    await expect(latest(page)).toBeHidden();
  } finally { response.resolve(); }
  await expect(history(page).locator('.xterm-rows')).toContainText('실행 로그');
  await expect(latest(page)).toBeVisible();
});

test('Shift+PageUp scrolls locally and the first typed key returns to live', async ({ page }) => {
  await openScreen(page, { ...richCoding, route: () => paneRoute(visualCodingIds.finished), waits: () => [] }, 'light');
  await page.getByRole('radio', { name: '터미널' }).click();
  await expect(terminal(page)).toContainText('3 pass');
  await input(page).focus();
  await page.keyboard.press('Shift+PageUp');
  await expect(history(page).locator('.xterm-rows')).toContainText('실행 로그');
  const typed = post(page, '/api/herdr/input');
  await page.keyboard.press('x');
  expect((await typed).postDataJSON()).toEqual({ pane: visualCodingIds.finished, text: 'x' });
  await expect(latest(page)).toBeHidden();
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Shift+PageUp');
  await latest(page).click();
  await expect(input(page)).toBeFocused();
});

test('live wheel events still reach applications that track the mouse', async ({ page }) => {
  await openScreen(page, { ...richCoding, route: () => paneRoute(visualCodingIds.finished), waits: () => [], prepare: async page => {
    await mockCodingApi(page, { rich: true });
    await page.route('**/api/herdr/terminal?*', route => fulfillHerdrFrame(route, 'mouse mode', { tracksMouse: true }));
  } }, 'light');
  await page.getByRole('radio', { name: '터미널' }).click();
  await expect(terminal(page)).toContainText('mouse mode');
  await liveScreen(page).hover({ position: { x: 40, y: 8 } });
  const wheel = post(page, '/api/herdr/input');
  await page.mouse.wheel(0, -160);
  expect((await wheel).postDataJSON().text).toMatch(/\x1b\[<64;/);
  await expect(latest(page)).toBeHidden();
});

test('starts omp with the chosen options, and never reuses approval bypass without confirmation', async ({ page, hasTouch }) => {
  await openScreen(page, { ...coding, route: () => '/coding?new=1', waits: () => [] }, 'light');
  const repo = page.getByRole('textbox', { name: '디렉터리', exact: true });
  await repo.fill('/Projects/app');
  await choice(page, '에이전트', 'omp');
  await page.getByText('옵션', { exact: true }).click();
  await expect(page.getByRole('switch', { name: '새 워크트리에서 작업' })).toBeChecked();
  await page.getByRole('switch', { name: '새 워크트리에서 작업' }).click();
  await expect(page.locator('.herdr-agent-options > summary')).toContainText('직접 쓰기');
  await page.getByRole('switch', { name: '새 워크트리에서 작업' }).click();
  await expect(page.getByRole('checkbox', { name: /이어서 하기/ })).toBeDisabled();
  await choice(page, '대화 고르기', '로그인 실패 테스트');
  await page.getByRole('button', { name: '모델', exact: true }).click();
  await page.getByRole('textbox', { name: '모델 검색' }).fill('GLM');
  await page.getByRole('button', { name: /GLM 5\.1/ }).click();
  await choice(page, '생각 수준', 'high');
  await choice(page, '승인 방식', '승인 없이 실행 (위험)');
  const confirmed = page.getByRole('button', { name: '이번 실행은 승인 없이 진행' });
  const start = page.getByRole('button', { name: '스페이스 만들기' });
  await page.getByRole('textbox', { name: '첫 지시 (선택)' }).fill('이어서 수정해 주세요.');
  await start.click();
  await expect(page).toHaveURL(/new=1/);
  await confirmed.click();
  const started = post(page, '/api/herdr/workspaces');
  await start.click();
  expect((await started).postDataJSON()).toEqual({
    cwd: '/Projects/app', worktree: true, agent: 'omp', task: '이어서 수정해 주세요.',
    args: ['--resume', 'omp-login-session', '--model', 'zai/glm-5.1', '--thinking', 'high', '--approval-mode', 'yolo'],
  });
  await expect(terminal(page)).toContainText('이어서 수정해 주세요.');
  if (hasTouch) await back(page).click();
  await openNewSpace(page);
  await expect(repo).toHaveValue('/Projects/app');
  await choice(page, '에이전트', 'omp');
  await expect(page.locator('.herdr-agent-options')).not.toHaveAttribute('open');
  await expect(page.locator('.herdr-agent-options > summary')).toContainText('승인 없이 실행');
  await start.click();
  await expect(confirmed).toBeVisible();
  await expect(page.getByRole('combobox', { name: '대화 고르기' })).toHaveText('로그인 실패 테스트');
  await expect(page.getByRole('combobox', { name: '생각 수준' })).toHaveText('high');
});

test.describe('mobile pane controls', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('controlled terminal sends wheel, touch, page and xterm input and defers keyboard resize during a gesture', async ({ page }) => {
    const pane = visualCodingIds.shell;
    const commands: HerdrControlCommand[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/herdr/control/send') commands.push(request.postDataJSON());
    });
    const opened = controlRequest(page);
    await openScreen(page, { ...coding, route: () => paneRoute(pane), waits: () => [], prepare: page =>
      mockCodingApi(page, { owned: [pane] }) }, 'light');
    const originalRows = Number(new URL((await opened).url()).searchParams.get('rows'));
    await expect(terminal(page)).toContainText('git status');
    const grid = page.locator('.herdr-control .xterm-screen');
    await grid.hover();
    const wheel = controlCommand(page, 'scroll');
    await grid.dispatchEvent('wheel', { deltaY: -85, bubbles: true, cancelable: true });
    expect((await wheel).postDataJSON()).toMatchObject({ pane, type: 'scroll', direction: 'up', source: 'wheel', lines: 4 });
    await expect(latest(page)).toBeVisible();
    const reset = controlCommand(page, 'scroll');
    await latest(page).tap();
    expect((await reset).postDataJSON()).toMatchObject({ direction: 'down', lines: 500 });
    await expect(input(page)).toBeFocused();
    const pageKey = controlCommand(page, 'scroll');
    await input(page).press('Shift+PageUp');
    expect((await pageKey).postDataJSON()).toMatchObject({ direction: 'up', source: 'page_key', lines: originalRows - 1 });
    const typed = controlCommand(page, 'input');
    await input(page).press('x');
    expect((await typed).postDataJSON()).toMatchObject({ text: 'x', pane });
    expect(commands.slice(-2)).toMatchObject([{ direction: 'down', lines: 500 }, { type: 'input', text: 'x' }]);
    await expect(latest(page)).toBeHidden();
    await expect(history(page)).toHaveCount(0);

    const rect = (await grid.boundingBox())!;
    const x = rect.x + 50, y = rect.y + 40;
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      const scroll = controlCommand(page, 'scroll');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 60 }] });
      expect((await scroll).postDataJSON()).toMatchObject({ type: 'scroll', direction: 'up', source: 'wheel', lines: 2 });
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 460 });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open');
      await page.waitForTimeout(350); // The 250 ms resize would fire here without the gesture guard.
      expect(commands.filter(command => command.type === 'resize')).toEqual([]);
      const resized = controlCommand(page, 'resize');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      expect((await resized).postDataJSON().rows).toBeLessThan(originalRows);
    } finally { await cdp.detach(); }

    await page.getByRole('button', { name: '추가 키' }).tap();
    await page.getByRole('button', { name: '키보드 닫기' }).tap();
    await expect(input(page)).not.toBeFocused();
    await page.evaluate(() => {
      Reflect.deleteProperty(window.visualViewport!, 'height');
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(followUp(page)).toHaveCount(0);
    const typedAfterResize = controlCommand(page, 'input');
    await input(page).press('e');
    expect((await typedAfterResize).postDataJSON()).toMatchObject({ pane, type: 'input', text: 'e' });
    const entered = controlCommand(page, 'input');
    await page.getByRole('group', { name: '터미널 키' }).getByRole('button', { name: 'Enter', exact: true }).tap();
    expect((await entered).postDataJSON()).toMatchObject({ pane, type: 'input', text: '\r' });
  });

  test('controlled mouse mode sends touch taps as cell down/up and still sends wheel scroll', async ({ page }) => {
    const pane = visualCodingIds.shell;
    const mouse: HerdrControlCommand[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname !== '/api/herdr/control/send') return;
      const command = request.postDataJSON() as HerdrControlCommand;
      if (command.type === 'mouse') mouse.push(command);
    });
    await openScreen(page, { ...coding, route: () => paneRoute(pane), waits: () => [], prepare: page =>
      mockCodingApi(page, { owned: [pane], mouse: [pane] }) }, 'dark');
    const grid = page.locator('.herdr-control .xterm-screen');
    await expect(terminal(page)).toContainText('git status');
    await grid.tap({ position: { x: 26, y: 30 } });
    await expect.poll(() => mouse).toMatchObject([
      { pane, type: 'mouse', action: 'down', button: 'left', row: 1 },
      { pane, type: 'mouse', action: 'up', button: 'left', row: 1 },
    ]);
    await grid.hover();
    const wheel = controlCommand(page, 'scroll');
    await page.mouse.wheel(0, -64);
    expect((await wheel).postDataJSON()).toMatchObject({ pane, source: 'wheel', direction: 'up', row: expect.any(Number), column: expect.any(Number) });
    await expect(latest(page)).toBeHidden();
  });
  test('sends sticky shortcuts and Korean shell input through xterm', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openScreen(page, { ...coding, route: () => paneRoute(visualCodingIds.shell), waits: () => [] }, 'light');
    const bar = page.getByRole('group', { name: '터미널 키', exact: true });
    const more = bar.getByRole('button', { name: '추가 키' });
    const ctrl = bar.getByRole('button', { name: 'Ctrl', exact: true });
    const alt = bar.getByRole('button', { name: 'Alt', exact: true });
    await expect(terminal(page)).toContainText('git status --short');
    await expect(attachments(page)).toHaveCount(0);
    await input(page).focus();
    await expect(ctrl).toBeHidden();
    const row = await bar.getByRole('button').evaluateAll(keys => keys.map(k => k.getBoundingClientRect().toJSON()));
    expect(row.every(k => k.y === row[0].y && k.width >= 44 && k.x >= 0 && k.right <= 320)).toBe(true);
    const viewport = await liveScreen(page).boundingBox();
    await more.tap();
    await expect(input(page)).toBeFocused();
    expect(await liveScreen(page).boundingBox()).toEqual(viewport);
    await captureCoding(page, 'extra-keys-light-320.png');
    await page.keyboard.press('Escape');
    await expect(ctrl).toBeHidden();
    await expect(input(page)).toBeFocused();
    await more.tap();
    await ctrl.click();
    await expect(ctrl).toBeHidden();
    await expect(more).toHaveText('Ctrl');
    await expect(input(page)).toBeFocused();
    const ctrlInput = post(page, '/api/herdr/input');
    await input(page).press('l');
    expect((await ctrlInput).postDataJSON()).toEqual({ pane: visualCodingIds.shell, text: '\x0c' });
    await expect(more).not.toHaveText('Ctrl');
    await input(page).focus();
    await more.tap();
    await alt.click();
    const altInput = post(page, '/api/herdr/input');
    await input(page).press('b');
    expect((await altInput).postDataJSON()).toEqual({ pane: visualCodingIds.shell, text: '\x1bb' });
    await more.tap();
    const extendedInput = post(page, '/api/herdr/input');
    await bar.getByRole('button', { name: 'Ctrl+D' }).click();
    expect((await extendedInput).postDataJSON()).toEqual({ pane: visualCodingIds.shell, text: '\x04' });

    await input(page).focus();
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.imeSetComposition', { text: '안', selectionStart: 1, selectionEnd: 1 });
      await expect(liveScreen(page).locator('.composition-view')).toHaveText('안');
      const committed = post(page, '/api/herdr/input');
      await cdp.send('Input.insertText', { text: '안녕' });
      expect((await committed).postDataJSON()).toEqual({ pane: visualCodingIds.shell, text: '안녕' });
    } finally { await cdp.detach(); }
    const entered = post(page, '/api/herdr/input');
    await bar.getByRole('button', { name: 'Enter', exact: true }).tap();
    expect((await entered).postDataJSON()).toEqual({ pane: visualCodingIds.shell, keys: ['enter'] });
  });

  test('clips the observer padding, follows the prompt through keyboard resize, and preserves a paused position', async ({ page }) => {
    let output = Array.from({ length: 40 }, (_, index) => `canonical line ${index + 1}`).join('\n') + '\nshell prompt';
    await openScreen(page, { ...coding, route: () => paneRoute(visualCodingIds.shell), waits: () => [], prepare: async page => {
      await mockCodingApi(page);
      await page.route('**/api/herdr/terminal?*', route => fulfillHerdrFrame(route, output));
    } }, 'light');
    const state = () => liveScreen(page).evaluate(port => {
      const clip = port.querySelector<HTMLElement>('.herdr-live-clip')!;
      const grid = port.querySelector<HTMLElement>('.xterm-screen')!;
      const rows = Array.from(grid.querySelector('.xterm-rows')!.children);
      const tail = rows.findLast(row => row.textContent?.trim())!;
      const rect = port.getBoundingClientRect();
      return {
        rows: rows.length, used: Math.round(clip.clientHeight * rows.length / grid.clientHeight),
        tailVisible: tail.getBoundingClientRect().bottom <= rect.bottom + 1 && tail.getBoundingClientRect().top >= rect.top - 1,
        top: port.scrollTop, end: port.scrollHeight - port.clientHeight,
      };
    });
    await expect(terminal(page)).toContainText('shell prompt');
    await expect.poll(state).toMatchObject({ rows: 120, used: 41, tailVisible: true });
    const before = await state();
    expect(before.top).toBe(before.end);
    expect(before.end).toBeGreaterThan(0);
    await expect(latest(page)).toBeHidden();
    await input(page).focus();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 460 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect.poll(async () => {
      const next = await state();
      return next.end > before.end && next.top === next.end && next.tailVisible;
    }).toBe(true);
    await liveScreen(page).hover();
    await page.mouse.wheel(0, -80);
    await expect(latest(page)).toBeVisible();
    await expect(history(page)).toHaveCount(0);
    const paused = (await state()).top;
    output += '\nmore output\nnew prompt';
    await expect(terminal(page)).toContainText('new prompt');
    await expect.poll(state).toMatchObject({ top: paused, used: 43, tailVisible: false });
    await page.mouse.wheel(0, 1200);
    await expect(latest(page)).toBeHidden();
    expect(await state()).toMatchObject({ used: 43, tailVisible: true });
  });

  test('continues a touch drag from live through history and keeps Page Up local', async ({ page }) => {
    let writes = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/herdr/input') writes++; });
    await openScreen(page, {
      ...coding, route: () => paneRoute(visualCodingIds.finished), waits: () => [], prepare: async page => {
        await mockCodingApi(page);
        await page.route('**/api/herdr/terminal?*', route => fulfillHerdrFrame(route,
          `${Array.from({ length: 34 }, (_, index) => `line ${index + 116}`).join('\n')}\nshell prompt`, { padded: true }));
        await page.route('**/api/herdr/output?*', route => route.fulfill({ json: {
          text: `${Array.from({ length: 150 }, (_, index) => `line ${index}`).join('\n')}\n\x1b[32m최근 출력\x1b[0m`,
        } }));
      },
    }, 'dark');
    await page.getByRole('radio', { name: '터미널' }).click();
    const screen = history(page);
    const scroller = page.locator('.herdr-history-scroll');
    await expect(scroller.locator('.xterm-rows')).toContainText('최근 출력');
    const liveTop = () => liveScreen(page).evaluate(node => node.scrollTop);
    await expect(terminal(page)).toContainText('shell prompt');
    await expect.poll(liveTop).toBeGreaterThan(0);
    const liveEnd = await liveTop();
    const scrollport = await liveScreen(page).boundingBox();
    const x = scrollport!.x + 60;
    const y = scrollport!.y + 125;
    const cdp = await page.context().newCDPSession(page);
    try {
      const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', at?: number) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at === undefined ? [] : [{ x, y: at }] });
      await touch('touchStart', y);
      for (let step = 1; step <= 6; step++) await touch('touchMove', y + 48 * step);
      await touch('touchEnd');
      await expect.poll(liveTop).toBe(0);
      // Finish Chrome's native fling at the top before beginning the independent edge gesture.
      await page.evaluate(() => new Promise<void>(resolve => {
        let remaining = 12;
        const frame = () => { if (--remaining) requestAnimationFrame(frame); else resolve(); };
        requestAnimationFrame(frame);
      }));
      await expect(history(page)).toHaveCount(0);
      await touch('touchStart', y);
      await touch('touchMove', y + 40);
      await expect(screen).toBeVisible();
      const historyEnd = await scroller.evaluate(node => node.scrollHeight - node.clientHeight);
      await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(historyEnd - 40);
      await expect(screen.locator('.xterm-rows > div').first()).toHaveText('line 114');
      for (let step = 2; step <= 5; step++) await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x, y: y + 40 * step }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach(); }
    await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBe(200);
    await expect(screen.locator('.xterm-rows')).not.toContainText('최근 출력');
    await latest(page).tap();
    await expect(input(page)).toBeFocused();
    await expect(latest(page)).toBeHidden();
    await expect.poll(liveTop).toBe(liveEnd);
    const rail = page.getByRole('group', { name: '터미널 키', exact: true });
    await rail.getByRole('button', { name: '추가 키' }).tap();
    await rail.getByRole('button', { name: 'Page Up', exact: true }).tap();
    await expect.poll(liveTop).toBe(0);
    await expect(history(page)).toHaveCount(0);
    await rail.getByRole('button', { name: '추가 키' }).tap();
    await rail.getByRole('button', { name: 'Page Up', exact: true }).tap();
    await expect(screen).toBeVisible();
    await expect(latest(page)).toBeVisible();
    expect(writes).toBe(0);
    const enter = post(page, '/api/herdr/input');
    await rail.getByRole('button', { name: 'Enter', exact: true }).tap();
    expect((await enter).postDataJSON()).toEqual({ pane: visualCodingIds.finished, keys: ['enter'] });
    await expect(input(page)).toBeFocused();
    await expect(latest(page)).toBeHidden();
  });
});

test('saves each of the renamed coding notification preferences', async ({ page }) => {
  await openScreen(page, { ...richCoding, route: () => '/settings?tab=coding', waits: () => [] }, 'light');
  const label = '에이전트 알림';
  const setting = page.getByRole('combobox', { name: label, exact: true });
  await expect(setting).toHaveText(fullCodingNotifications);
  for (const [text, notify] of [['답이 필요할 때만', 'blocked'], ['끔', 'off'], [fullCodingNotifications, 'all']]) {
    const saved = post(page, '/api/commands');
    await choice(page, label, text);
    expect((await saved).postDataJSON().command).toEqual({ type: 'coding.set', session: null, agent: 'claude', notify });
    await expect(setting).toHaveText(text);
  }
});

test('attaches pasted images and dropped files on the desktop chat composer', async ({ page }) => {
  await openScreen(page, { ...richCoding, route: () => paneRoute(visualCodingIds.finished), waits: () => [] }, 'light');
  const composer = followUp(page);
  await composer.fill('이 파일도 확인해 주세요.');
  const { promise: hold, resolve: release } = Promise.withResolvers<void>();
  await page.route('**/api/herdr/upload?*', async route => { await hold; await route.fallback(); }, { times: 1 });
  const uploaded = post(page, '/api/herdr/upload');
  try {
    await composer.evaluate(node => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'clipboard.png', { type: 'image/png' }));
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    expect((await uploaded).headers()['content-type']).toBe('image/png');
    await expect(attachmentTray(page).getByRole('listitem')).toHaveAttribute('data-status', 'uploading');
    await expect(page.getByRole('button', { name: '보내기' })).toBeDisabled();
  } finally { release(); }
  const tray = attachmentTray(page);
  const image = tray.getByRole('listitem').filter({ hasText: 'clipboard.png' });
  await expect(image).toHaveAttribute('data-status', 'ready');
  await expect(composer).toHaveValue('이 파일도 확인해 주세요.');
  await page.locator('.coding-composer .ghost-composer__surface').evaluate(node => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([''], 'empty.txt', { type: 'text/plain' }));
    dataTransfer.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    node.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
  });
  const empty = tray.getByRole('listitem').filter({ hasText: 'empty.txt' });
  await expect(empty).toHaveAttribute('data-status', 'failed');
  await expect(empty).toContainText('빈 파일은 첨부할 수 없습니다.');
  await expect(tray.getByRole('listitem').filter({ hasText: 'notes.txt' })).toHaveAttribute('data-status', 'ready');
  await expect(page.getByRole('button', { name: '보내기' })).toBeDisabled();
  await empty.getByRole('button', { name: 'empty.txt 빼기', exact: true }).click();
  await expect(page.getByRole('button', { name: '보내기' })).toBeEnabled();
  await expect(composer).toHaveValue('이 파일도 확인해 주세요.');
});

test('opens the pane returned by code_run from the Work record, not a guessed id', async ({ page, hasTouch }) => {
  await openScreen(page, {
    ...coding, route: state => `/work/${state.workDoneId}`, waits: () => [], prepare: async page => {
      await mockCodingApi(page);
      const { workDoneId, fixedNow, conversationA } = readRunState();
      await page.route(`**/api/works/${workDoneId}`, async route => {
        const response = await route.fetch();
        const detail: WorkDetail = await response.json();
        const effect: Effect = {
          id: 'visual-code-run', workId: workDoneId, callId: 'call-one', conversationId: conversationA, tool: 'code_run',
          summary: '코딩 결과 확인', inputDigest: 'a'.repeat(64), state: 'done', createdAt: fixedNow, endedAt: fixedNow,
          result: JSON.stringify({ pane: visualCodingIds.finished, status: 'done' }),
        };
        await route.fulfill({ response, json: {
          ...detail, effects: [...detail.effects, effect, { ...effect, id: 'visual-code-run-missing', callId: 'call-two', result: null }],
        } });
      });
    },
  }, 'light');
  if (hasTouch) {
    await page.locator('summary').filter({ has: page.getByRole('heading', { name: /^실행 기록/ }) }).click();
  }
  await expect(page.getByText('코딩 결과 확인', { exact: true }).first()).toBeVisible();
  const link = page.getByRole('link', { name: 'herdr에서 보기' });
  await expect(link).toHaveCount(1);
  await link.click();
  await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.finished)}`);
  await expect(terminal(page)).toContainText('3 pass');
});

test('rotates working arcs and switches to a live opacity pulse with Reduce Motion', async ({ page }) => {
  await openScreen(page, richCoding, 'light');
  const glyph = page.getByRole('region', { name: '작업 중', exact: true }).locator('.state-glyph__spin');
  const style = () => glyph.evaluate(element => {
    const css = getComputedStyle(element);
    return { name: css.animationName, count: css.animationIterationCount, duration: css.animationDuration, transform: css.transform };
  });
  await expect.poll(style).toMatchObject({ name: 'ghost-spin', count: 'infinite', duration: '1s' });
  await expect.poll(async () => (await style()).transform).not.toBe('none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(style).toEqual({ name: 'ghost-state-pulse', count: 'infinite', duration: '1.45s', transform: 'none' });
});

test('answers from the inbox without reopening a stale approval', async ({ page }) => {
  let unavailable = false;
  const { promise: hold, resolve: release } = Promise.withResolvers<void>();
  await openScreen(page, { ...richCoding, prepare: async page => {
    await mockCodingApi(page, { rich: true });
    await page.route('**/api/herdr/ask?*', route => unavailable ? route.fulfill({ contentType: 'application/json', body: 'null' }) : route.fallback());
    await page.route('**/api/herdr/answer', async route => {
      await hold;
      unavailable = true;
      await route.fulfill({ status: 409, json: { error: { code: 'conflict', message: '질문이 바뀌었습니다.' } } });
    }, { times: 1 });
  } }, 'light');
  const inbox = page.getByRole('region', { name: '입력 필요', exact: true });
  const approve = inbox.getByRole('button', { name: /이번만 실행/ });
  try {
    const request = post(page, '/api/herdr/answer');
    await approve.click();
    expect((await request).postDataJSON()).toEqual({ pane: visualCodingIds.blocked, index: 0, title: '설정 테스트를 실행할까요?' });
    await expect(approve).toBeDisabled();
    await expect(approve.locator('.state-glyph__spin')).toBeVisible();
  } finally { release(); }
  await expect(inbox.getByRole('link', { name: /열기/ })).toBeVisible();
  await expect(approve).toHaveCount(0);
  unavailable = false;
  await approve.click();
  await expect(inbox).toHaveCount(0);
  await expect(page).toHaveURL(url => url.hash === `#${herdrRoster}`);
});

test('merges tool completion by id and preserves scroll and the unsent draft', async ({ page }) => {
  const id = visualCodingIds.finished;
  const transcript = Array.from({ length: 32 }, (_, index): HerdrChatItem => ({
    id: `message-${index}`, kind: index % 2 ? 'agent' : 'user', at: 100 + index, text: `기록 ${index + 1}`,
  }));
  const tool = { kind: 'tool', id: 'exec', name: 'bash', summary: 'bun run test', ok: null, at: 133 } as const;
  const cursors: string[] = [];
  let update = false;
  await openScreen(page, { ...richCoding, route: () => paneRoute(id), waits: () => [], prepare: async page => {
    await mockCodingApi(page, { rich: true });
    await page.route('**/api/herdr/chat?*', route => {
      const after = new URL(route.request().url()).searchParams.get('after');
      if (after) cursors.push(after);
      const items: HerdrChatItem[] = !after ? [...transcript, tool] : update && after === '1024' ? [
        { ...tool, ok: false }, { id: 'latest', kind: 'agent', text: '테스트가 실패했습니다.', at: 160 },
      ] : [];
      return route.fulfill({ json: { pane: id, source: 'omp', title: null, model: null, reset: !after, cursor: update ? '1256' : '1024', items } satisfies HerdrChat });
    });
  } }, 'light');
  const feed = page.getByRole('region', { name: '에이전트 대화' });
  await expect(feed.getByText('기록 32', { exact: true })).toBeVisible();
  await feed.locator('.herdr-chat-steps summary').last().click();
  await expect(feed.getByText('bun run test', { exact: true })).toHaveCount(1);
  const scroll = feed.locator('.herdr-chat-scroll');
  await scroll.evaluate(node => { node.scrollTop = 120; });
  const jump = feed.getByRole('button', { name: '최신으로' });
  await expect(jump).toBeVisible();
  const prior = await scroll.evaluate(node => node.scrollTop);
  update = true;
  await expect(feed.getByText('테스트가 실패했습니다.')).toHaveCount(1);
  expect(cursors).toContain('1024');
  await expect(feed.locator('[data-failed]').filter({ hasText: 'bun run test' })).toHaveCount(1);
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(prior);
  await jump.click();
  await expect(jump).toHaveCount(0);
  const draft = followUp(page);
  await draft.fill('고치기 전에 기록을 보여 주세요.');
  await page.getByRole('radio', { name: '터미널', exact: true }).click();
  await expect(terminal(page)).toContainText('3 pass');
  await expect(draft).toHaveValue('고치기 전에 기록을 보여 주세요.');
  await expect(attachments(page)).toBeVisible();
  await page.getByRole('radio', { name: '변경', exact: true }).click();
  await expect(page.getByRole('region', { name: '작업 변경' })).toBeVisible();
  await expect(draft).toHaveCount(0);
  await expect(attachments(page)).toHaveCount(0);
  await page.getByRole('radio', { name: '대화', exact: true }).click();
  await expect(draft).toHaveValue('고치기 전에 기록을 보여 주세요.');
  await page.reload();
  await expect(draft).toHaveValue('고치기 전에 기록을 보여 주세요.');
  await expect(page.getByRole('radio', { name: '대화' })).toBeChecked();
});

test('reads a dense run: counted repeats, failures named in the fold, markdown replies', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const id = visualCodingIds.running;
  await openScreen(page, { ...richCoding, route: () => paneRoute(id), waits: () => [], prepare: async page => {
    await mockCodingApi(page, { rich: true });
    await page.route('**/api/herdr/chat?*', route => {
      const after = new URL(route.request().url()).searchParams.get('after');
      const items: HerdrChatItem[] = after ? [] : [
        { id: 'dense-u1', kind: 'user', at: 100_000, text: '결제 화면에 승인·거절 테스트를 추가해 주세요.' },
        { id: 'dense-t1', kind: 'thinking', at: 101_000 },
        { id: 'dense-t2', kind: 'thinking', at: 102_000 },
        { id: 'dense-x1', kind: 'tool', at: 130_000, name: 'bash', summary: 'bun test src/checkout', ok: true },
        { id: 'dense-x2', kind: 'tool', at: 140_000, name: 'bash', summary: 'bun test src/checkout', ok: true },
        { id: 'dense-x3', kind: 'tool', at: 150_000, name: 'bash', summary: 'bun test src/checkout', ok: false },
        { id: 'dense-x4', kind: 'tool', at: 160_000, name: 'edit', summary: 'src/checkout/payment.test.ts', ok: null },
        { id: 'dense-a1', kind: 'agent', at: 165_000, text: '실패한 케이스를 고쳤습니다.\n\n- `payment.test.ts` 승인 분기\n- 거절 뒤 버튼 다시 활성화\n\n```ts\nawait approve()\n```' },
      ];
      return route.fulfill({ json: { pane: id, source: 'omp', title: null, model: null, items, cursor: '8', reset: !after } satisfies HerdrChat });
    });
  } }, 'light');
  const feed = page.getByRole('region', { name: '에이전트 대화' });
  await expect(feed.locator('.herdr-chat-user')).toHaveText('결제 화면에 승인·거절 테스트를 추가해 주세요.');
  const summary = feed.locator('.herdr-chat-steps > summary');
  await expect(summary).toContainText('6단계 · 1분 · 실패 1');
  await summary.click();
  const lines = feed.locator('.herdr-chat-steps li');
  await expect(lines).toHaveCount(4);
  await expect(lines.nth(0)).toContainText('생각 2번');
  await expect(lines.nth(1)).toContainText('bun test src/checkout 2번');
  await expect(lines.nth(1)).not.toHaveAttribute('data-failed');
  await expect(lines.nth(2)).toContainText('bun test src/checkout');
  await expect(lines.nth(2)).not.toContainText('2번');
  await expect(lines.nth(2)).toHaveAttribute('data-failed');
  await expect(lines.nth(3)).toContainText('src/checkout/payment.test.ts');
  const reply = feed.locator('.herdr-chat-agent');
  await expect(reply.getByRole('listitem')).toHaveCount(2);
  await expect(reply.locator('.message-body__code pre')).toContainText('await approve()');
  await expect(reply.getByRole('button', { name: '코드 복사' })).toBeVisible();
  expect(await feed.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test.describe('mobile pane navigation', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('swipes only to siblings and keeps terminal size across panes', async ({ page }) => {
    await openScreen(page, { ...richCoding, route: () => paneRoute(visualCodingIds.running), waits: () => [] }, 'light');
    await expect(page.getByRole('radio', { name: '대화' })).toBeChecked();
    const picker = page.getByRole('button', { name: /^패널 정보 · / });
    expect((await page.getByRole('region', { name: '에이전트 대화' }).boundingBox())!.y).toBeLessThan(110);
    await picker.tap();
    const siblings = page.getByRole('navigation', { name: '탭의 패널' });
    await expect(siblings.getByRole('button')).toHaveCount(2);
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    const header = (await picker.boundingBox())!;
    const x = header.x + header.width * .8, y = header.y + header.height / 2;
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 4; step++) await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: x - 22 * step, y }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach(); }
    await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.shell)}`);
    await expect(page.getByRole('radio', { name: '대화' })).toHaveCount(0);
    await expect(terminal(page)).toContainText('git status --short');
    await input(page).focus();
    await page.getByRole('button', { name: '추가 키' }).click();
    await page.getByRole('button', { name: '키보드 닫기' }).click();
    await expect(input(page)).not.toBeFocused();
    await page.getByRole('button', { name: '터미널 글자 크기' }).click();
    await page.getByRole('button', { name: '글자 크게' }).click();
    await expect(page.getByRole('dialog', { name: '터미널 글자 크기' }).locator('output')).toHaveText('15px');
    await page.keyboard.press('Escape');
    await picker.tap();
    await siblings.getByRole('button', { name: /결제 화면 테스트 추가/ }).click();
    await page.getByRole('radio', { name: '터미널' }).click();
    await page.getByRole('button', { name: '터미널 글자 크기' }).click();
    await expect(page.getByRole('dialog', { name: '터미널 글자 크기' }).locator('output')).toHaveText('15px');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 320, height: 568 });
    await page.getByRole('button', { name: '작업실 메뉴' }).tap();
    await page.getByRole('button', { name: '명령 검색' }).tap();
    await expect(page.getByRole('dialog', { name: '명령', exact: true })).toBeVisible();
  });
});
