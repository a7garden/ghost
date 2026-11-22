import { expect, test, type Page } from '@playwright/test';
import type { CodingSetup, Effect, HerdrChat, HerdrChatItem, HerdrControlCommand, HerdrOutput, WorkDetail } from '@ghost/contract';
import { fulfillHerdrFrame, mockCodingApi, visualCodingIds } from './mocks';
import { openScreen } from './visual';
import { readRunState } from './run-state';

const landing = { name: 'coding', route: () => '/', waits: () => ['최근 끝난 일'], prepare: mockCodingApi };
const coding = { ...landing, route: () => '/coding', waits: () => ['결제 화면 테스트 추가'] };
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
const fitToPhone = (page: Page) => page.getByRole('button', { name: '폰 크기에 맞추기', exact: true });
const restoreSize = (page: Page) => page.getByRole('button', { name: '원래 크기로', exact: true });
const controlRequest = (page: Page) => page.waitForRequest(request => new URL(request.url()).pathname === '/api/herdr/control');
const controlCommand = (page: Page, type: HerdrControlCommand['type']) => page.waitForRequest(request =>
  new URL(request.url()).pathname === '/api/herdr/control/send' && request.postDataJSON().type === type);
const back = (page: Page) => page.getByRole('navigation', { name: '위치' }).getByRole('button', { name: '뒤로', exact: true });
const codingNav = (page: Page, touch: boolean) => page.getByRole('navigation', { name: touch ? '주요 화면' : '작업실', exact: true });
const spaces = (page: Page) => page.getByRole('radio', { name: '스페이스', exact: true }).click();
const choice = async (page: Page, field: string, option: string) => {
  await page.getByRole('combobox', { name: field, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
};

for (const { name, width, height, touch } of sizes) {
  test.describe(name, () => {
    test.use({ viewport: { width, height }, isMobile: touch, hasTouch: touch });
    for (const theme of ['light', 'dark'] as const) {
      test(`coding screen in ${theme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await openScreen(page, { ...richCoding, route: landing.route, waits: landing.waits, prepare: async page => {
          const now = readRunState().fixedNow;
          await page.addInitScript(({ now, pane }) => {
            localStorage.setItem('ghost.coding.activity:default', JSON.stringify({ [pane]: { status: 'working', changedAt: now - 120_000, openedAt: -1 } }));
          }, { now, pane: visualCodingIds.running });
          await mockCodingApi(page, { rich: true, owned: [visualCodingIds.shell] });
        } }, theme);
        const nav = codingNav(page, touch);
        const codingLink = nav.getByRole('button', { name: /코딩/ });
        await expect(codingLink).toContainText('입력 필요');
        await expect(codingLink).toContainText('1');
        await codingLink.click();
        await expect(page).toHaveURL(/#\/coding$/);
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
        const composer = page.getByRole('textbox', { name: '후속 지시' });
        const keys = page.getByRole('group', { name: '터미널 키', exact: true });
        await expect(app.getByRole('region', { name: '탭 · checkout' }).getByRole('link')).toHaveCount(2);
        await expect(app.getByRole('region', { name: '탭 · login' }).getByRole('link')).toHaveCount(1);
        await expect(list.getByText('fix/settings-navigation')).toBeVisible();
        await expect(blocked).toContainText('입력 필요');
        await expect(list.getByText('에이전트 연동', { exact: true })).toBeVisible();
        await captureCoding(page, `spaces-${theme}-${name}.png`);

        await running.click();
        await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.running)}`);
        await expect(page.getByRole('radio', { name: '대화', exact: true })).toBeChecked();
        await expect(page.getByText('승인·거절 응답', { exact: true })).toBeVisible();
        if (!touch) await page.getByRole('radio', { name: '에이전트', exact: true }).click();
        await captureCoding(page, `chat-working-${theme}-${name}.png`);
        if (!touch) await spaces(page);
        await page.getByRole('radio', { name: '터미널', exact: true }).click();
        await expect(terminal(page)).toContainText('기존 결제 테스트');
        expect(await terminal(page).locator('.xterm-fg-6').count()).toBeGreaterThan(0);
        await expect(composer).toBeDisabled();
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
        const conversation = page.getByRole('region', { name: '에이전트 대화' });
        await expect(conversation.getByText('기본 안내 문구', { exact: true })).toBeVisible();
        const fold = conversation.getByText('3단계 · 3분', { exact: true });
        await expect(conversation.getByText('bun test src/auth/login.test.ts', { exact: true })).toBeHidden();
        await fold.click();
        await expect(conversation.getByText('bun test src/auth/login.test.ts', { exact: true })).toBeVisible();
        await fold.click();
        await captureCoding(page, `chat-done-${theme}-${name}.png`);
        await page.getByRole('radio', { name: '터미널', exact: true }).click();
        await expect(terminal(page)).toContainText('3 pass');
        await expect(terminal(page).locator('b')).toHaveCount(0);
        await captureCoding(page, `finished-${theme}-${name}.png`);

        await expect(page.getByRole('button', { name: '기록', exact: true })).toHaveCount(0);
        await liveScreen(page).hover();
        await page.mouse.wheel(0, -19);
        await expect(history(page).locator('.xterm-rows')).toContainText('3 pass');
        await expect(history(page).locator('.xterm-rows .xterm-fg-6').first()).toBeVisible();
        await expect(history(page).locator('.xterm-rows b')).toHaveCount(0);
        await captureCoding(page, `history-${theme}-${name}.png`);

        await page.getByRole('radio', { name: '변경' }).click();
        await expect(page.getByRole('region', { name: '작업 변경' }).getByText('fix/login-message', { exact: true })).toBeVisible();
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
        await captureCoding(page, `chat-blocked-${theme}-${name}.png`);
        await page.getByRole('radio', { name: '터미널', exact: true }).click();
        await expect(terminal(page)).toContainText('Do you want to proceed?');
        await expect(composer).toBeDisabled();
        await expect(keys.getByRole('button')).toHaveCount(21);
        if (touch) {
          const bounds = await keys.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
          expect(bounds.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
        }
        await captureCoding(page, `blocked-${theme}-${name}.png`);
        if (touch) await back(page).click();

        await shell.click();
        await expect(terminal(page)).toContainText('git status --short');
        await expect(composer).toHaveCount(0);
        await expect(page.getByRole('textbox', { name: '셸 명령' })).toBeEnabled();
        await expect(page.getByRole('radio', { name: '변경' })).toHaveCount(0);
        await captureCoding(page, `shell-${theme}-${name}.png`);
        if (touch) await back(page).click();

        await list.getByRole('link', { name: '새 스페이스' }).click();
        await expect(page.getByRole('combobox', { name: '에이전트' })).toHaveText('Claude Code');
        await expect(page.getByRole('switch', { name: '새 워크트리에서 작업' })).toBeChecked();
        await expect(page.getByRole('button', { name: '스페이스 만들기' })).toBeEnabled();
        await page.getByRole('textbox', { name: '디렉터리', exact: true }).fill('/Projects/app');
        await choice(page, '에이전트', 'omp');
        await page.getByText('옵션', { exact: true }).click();
        await expect(page.getByRole('checkbox', { name: /이어서 하기/ })).toBeDisabled();
        await choice(page, '대화 고르기', '로그인 실패 테스트');
        await page.getByRole('button', { name: '모델', exact: true }).click();
        await page.getByRole('textbox', { name: '모델 검색' }).fill('glm');
        await page.getByRole('button', { name: /GLM 5\.1/ }).click();
        await choice(page, '생각 수준', 'high');
        await choice(page, '승인 방식', '항상 묻기');
        await page.locator('.coding-new').evaluate((node, phone) => {
          node.scrollTop = phone ? node.querySelector('.herdr-agent-options')!.getBoundingClientRect().top + node.scrollTop - node.getBoundingClientRect().top - 110 : 0;
        }, touch);
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
      await openScreen(page, coding, 'light');
      await page.getByRole('link', { name: '새 스페이스' }).click();
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
      await page.getByRole('button', { name: '중단 (Esc)' }).click();
      expect((await interrupted).postDataJSON()).toMatchObject({ pane: visualCodingIds.started, type: 'input', text: '\x1b' });
      await expect(terminal(page)).toContainText('Interrupted');
      if (touch) await back(page).click();

      await page.getByRole('link', { name: /로그인 실패 시 안내 문구 고치기/ }).click();
      const replyPane = page.getByRole('region', { name: '로그인 실패 시 안내 문구 고치기', exact: true });
      const compose = replyPane.getByRole('textbox', { name: '후속 지시' });
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
      await expect(page.getByRole('alert')).toHaveText('승인에 먼저 답하세요.');
      await expect(compose).toHaveValue(text);
      const sent = post(page, '/api/herdr/prompt');
      if (touch) await send.click(); else await compose.press('Meta+Enter');
      expect((await sent).postDataJSON()).toEqual({ pane: visualCodingIds.finished, text });
      await expect(terminal(page)).toContainText('실패 응답도 확인하겠습니다.');
      await expect(compose).toBeDisabled();
      await expect(compose).toHaveValue('');
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
      await expect(page).toHaveURL(/#\/coding$/);
      await expect(page.getByText('이 패널은 더 이상 없습니다.')).toBeVisible();
      await expect(terminal(page)).toHaveCount(0);
    });

    test('uses an already running session and installs an optional integration', async ({ page }) => {
      await openScreen(page, stopped, 'light');
      const setup = page.getByRole('region', { name: 'herdr 연결' });
      await expect(setup.getByRole('button', { name: '실행 명령 복사' })).toBeVisible();
      const saved = post(page, '/api/commands');
      await setup.getByRole('button', { name: '이 세션 쓰기' }).click();
      expect((await saved).postDataJSON().command).toEqual({ type: 'coding.set', session: 'studio', agent: 'claude', notify: 'blocked' });
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
  await expect(page.getByRole('radio', { name: '터미널' })).toBeFocused();
  const initial = requests[0]!.searchParams;
  const refitted = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/herdr/terminal' && url.searchParams.get('pane') === visualCodingIds.shell &&
      Number(url.searchParams.get('cols')) < Number(initial.get('cols')) && url.searchParams.get('rows') === '120';
  });
  await page.setViewportSize({ width: 1120, height: 720 });
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
  await expect(restoreSize(page)).toBeVisible();
  await expect(terminal(page)).toContainText('3 pass');
  await expect(history(page)).toHaveCount(0);
  const tabRelease = post(page, '/api/herdr/control/release');
  await page.getByRole('radio', { name: '변경' }).click();
  expect((await tabRelease).postDataJSON().pane).toBe(visualCodingIds.finished);
  await page.getByRole('radio', { name: '터미널' }).click();
  await expect(restoreSize(page)).toBeVisible();
  const switched = controlRequest(page);
  await page.evaluate(pane => { location.hash = pane; }, paneRoute(visualCodingIds.shell));
  expect(new URL((await switched).url()).searchParams.get('client')).toBe(query.get('client'));
  await expect(terminal(page)).toContainText('git status');
  expect(order).toEqual([
    `open:${visualCodingIds.finished}`, `release:${visualCodingIds.finished}`, `open:${visualCodingIds.finished}`,
    `release:${visualCodingIds.finished}`, `open:${visualCodingIds.shell}`,
  ]);
});

test('asks before fitting an unowned pane, remembers consent, and releases with auth on pagehide', async ({ page }) => {
  const control: URL[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/herdr/control') control.push(url);
  });
  await openScreen(page, { ...coding, route: () => paneRoute(visualCodingIds.shell), waits: () => [] }, 'light');
  await expect(fitToPhone(page)).toBeVisible();
  await expect(terminal(page)).toContainText('git status');
  expect(control).toHaveLength(0);
  await fitToPhone(page).click();
  const consent = page.getByRole('dialog', { name: '폰 크기로 줄일까요?' });
  await expect(consent.getByText('나가면 원래대로 돌아옵니다.')).toBeVisible();
  await consent.getByRole('button', { name: '취소' }).click();
  await expect(consent).toBeHidden();
  expect(control).toHaveLength(0);
  await fitToPhone(page).click();
  await consent.getByRole('button', { name: '줄이기' }).click();
  await expect(restoreSize(page)).toBeVisible();
  expect(control[0]?.searchParams.get('fit')).toBe('1');
  const released = post(page, '/api/herdr/control/release');
  await restoreSize(page).click();
  expect((await released).postDataJSON()).toEqual({ pane: visualCodingIds.shell, leaseId: '00000000-0000-4000-8000-000000000001' });
  await expect(fitToPhone(page)).toBeVisible();
  await fitToPhone(page).click();
  await expect(restoreSize(page)).toBeVisible();
  await expect(consent).toBeHidden();
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
  await expect(fitToPhone(page)).toBeVisible();
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

test('manages workspaces, tabs, splits and shell agents through the roster', async ({ page }) => {
  await openScreen(page, coding, 'light');
  await spaces(page);
  async function choose(node: string, label: string) {
    const menu = `${node} 작업`;
    await page.getByRole('button', { name: menu, exact: true }).click();
    await page.getByRole('dialog', { name: menu }).getByRole('button', { name: label, exact: true }).click();
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

  await choose('새 앱', '새 탭');
  await page.getByRole('textbox', { name: '이름 (선택)' }).fill('실험');
  const tab = post(page, '/api/herdr/tabs');
  await page.getByRole('button', { name: '탭 만들기' }).click();
  expect((await tab).postDataJSON()).toEqual({ workspace: 'w79', label: '실험' });
  await expect(page).toHaveURL(url => url.hash === `#${paneRoute('w79:p81')}`);

  await choose('실험', '오른쪽으로 분할');
  const split = post(page, '/api/herdr/split');
  await page.getByRole('button', { name: '분할', exact: true }).click();
  expect((await split).postDataJSON()).toEqual({ pane: 'w79:p81', direction: 'right' });
  await expect(page).toHaveURL(url => url.hash === `#${paneRoute('w79:p82')}`);
  const shell = page.getByRole('region', { name: '탭 · 실험', exact: true }).locator('.herdr-pane-row[data-selected]');
  await shell.getByRole('button', { name: 'zsh 작업' }).click();
  await page.getByRole('dialog', { name: 'zsh 작업' }).getByRole('button', { name: '에이전트 시작' }).click();
  await page.getByRole('combobox', { name: '에이전트' }).click();
  await expect(page.getByRole('option', { name: 'Codex · 설치 안 됨' })).toBeDisabled();
  await page.getByRole('option', { name: 'Pi', exact: true }).click();
  await page.getByRole('textbox', { name: '첫 지시 (선택)' }).fill('변경을 읽어 주세요.');
  const agent = post(page, '/api/herdr/agents');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  expect((await agent).postDataJSON()).toEqual({ pane: 'w79:p82', agent: 'pi', task: '변경을 읽어 주세요.' });
  await expect(terminal(page)).toContainText('변경을 읽어 주세요.');
  await expect(page.getByRole('textbox', { name: '후속 지시' })).toBeDisabled();

  await choose('실험', '닫기');
  const closing = post(page, '/api/herdr/close');
  await page.getByRole('button', { name: '탭 닫기', exact: true }).click();
  expect((await closing).postDataJSON()).toEqual({ target: 'tab', id: 'w79:t81' });
  await expect(page).toHaveURL(/#\/coding$/);
  await expect(page.getByRole('region', { name: '탭 · 실험' })).toHaveCount(0);
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
  await page.mouse.wheel(0, -240);
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

test('starts omp with the chosen options, and never reuses approval bypass without confirmation', async ({ page }) => {
  await openScreen(page, { ...coding, route: () => '/coding?new=1', waits: () => [] }, 'light');
  const repo = page.getByRole('textbox', { name: '디렉터리', exact: true });
  await repo.fill('/Projects/app');
  await choice(page, '에이전트', 'omp');
  await page.getByText('옵션', { exact: true }).click();
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
  await page.getByRole('link', { name: '새 스페이스' }).click();
  await repo.fill('/Projects/app');
  await choice(page, '에이전트', 'omp');
  await expect(page.locator('.herdr-agent-options')).not.toHaveAttribute('open');
  await start.click();
  await expect(confirmed).toBeVisible();
  await expect(page.getByRole('combobox', { name: '대화 고르기' })).toHaveText('로그인 실패 테스트');
  await expect(page.getByRole('combobox', { name: '생각 수준' })).toHaveText('high');
});

test.describe('mobile pane controls', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('controlled terminal sends wheel, touch, page and composer input and defers keyboard resize during a gesture', async ({ page }) => {
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
    await page.mouse.wheel(0, -85);
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

    await page.getByRole('button', { name: '키보드 닫기' }).tap();
    await page.evaluate(() => {
      Reflect.deleteProperty(window.visualViewport!, 'height');
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    const field = page.getByRole('textbox', { name: '셸 명령' });
    await field.fill('echo hello');
    const sent = controlCommand(page, 'input');
    await page.getByRole('button', { name: '보내기' }).click();
    expect((await sent).postDataJSON()).toMatchObject({ pane, type: 'input', text: '\x1b[200~echo hello\x1b[201~\r' });
    await expect(field).toHaveValue('');
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
  test('sends sticky shortcuts, file bytes and an IME-safe shell command', async ({ page }) => {
    await openScreen(page, { ...coding, route: () => paneRoute(visualCodingIds.shell), waits: () => [] }, 'light');
    const bar = page.getByRole('group', { name: '터미널 키', exact: true });
    const ctrl = bar.getByRole('button', { name: 'Ctrl', exact: true });
    const alt = bar.getByRole('button', { name: 'Alt', exact: true });
    const composer = page.getByRole('textbox', { name: '셸 명령' });
    await expect(terminal(page)).toContainText('git status --short');
    await composer.fill('printf 안녕');
    await ctrl.click();
    await expect(ctrl).toHaveAttribute('aria-pressed', 'true');
    const ctrlInput = post(page, '/api/herdr/input');
    await composer.press('l');
    expect((await ctrlInput).postDataJSON()).toEqual({ pane: visualCodingIds.shell, text: '\x0c' });
    await expect(composer).toHaveValue('printf 안녕');
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false');
    await input(page).focus();
    await alt.click();
    const altInput = post(page, '/api/herdr/input');
    await input(page).press('b');
    expect((await altInput).postDataJSON()).toEqual({ pane: visualCodingIds.shell, text: '\x1bb' });
    expect(await bar.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    const extendedInput = post(page, '/api/herdr/input');
    await bar.getByRole('button', { name: 'Ctrl+D' }).click();
    expect((await extendedInput).postDataJSON()).toEqual({ pane: visualCodingIds.shell, text: '\x04' });

    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '파일 첨부' }).click();
    const file = post(page, '/api/herdr/upload');
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await (await chooser).setFiles({ name: '확인.png', mimeType: 'image/png', buffer: data });
    const request = await file;
    expect(new URL(request.url()).searchParams.get('name')).toBe('확인.png');
    expect(request.headers()['content-type']).toBe('image/png');
    expect(request.headers().authorization).toMatch(/^Bearer /);
    expect(request.postDataBuffer()).toEqual(data);
    await expect(composer).toHaveValue('printf 안녕 @/Ghost/uploads/a1b2c3d4-확인.png ');
    const sent = post(page, '/api/herdr/input');
    await page.getByRole('button', { name: '보내기' }).click();
    expect((await sent).postDataJSON()).toEqual({ pane: visualCodingIds.shell, text: 'printf 안녕 @/Ghost/uploads/a1b2c3d4-확인.png \r' });
    await expect(composer).toHaveValue('');
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
    await rail.getByRole('button', { name: 'Page Up', exact: true }).tap();
    await expect.poll(liveTop).toBe(0);
    await expect(history(page)).toHaveCount(0);
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

test('restores the last pane on re-entry and saves the complete notification preference', async ({ page }) => {
  await openScreen(page, { ...coding, route: () => paneRoute(visualCodingIds.finished), waits: () => [] }, 'light');
  await expect(page.getByRole('textbox', { name: '후속 지시' })).toBeFocused();
  await page.evaluate(() => { location.hash = '/'; });
  const nav = codingNav(page, false);
  await expect(nav.getByRole('button', { name: /코딩.*입력 필요.*1/ })).toBeVisible();
  await nav.getByRole('button', { name: /코딩/ }).click();
  await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.finished)}`);
  await page.evaluate(() => { location.hash = '/settings?tab=coding'; });
  const saved = post(page, '/api/commands');
  await choice(page, '에이전트 알림', '입력 필요·끝났을 때');
  expect((await saved).postDataJSON().command).toEqual({ type: 'coding.set', session: null, agent: 'claude', notify: 'all' });
  await expect(page.getByRole('combobox', { name: '에이전트 알림' })).toHaveText('입력 필요·끝났을 때');
});

test('attaches pasted images and dropped files from a desktop pane', async ({ page }) => {
  await openScreen(page, { ...coding, route: () => paneRoute(visualCodingIds.finished), waits: () => [] }, 'light');
  const composer = page.getByRole('textbox', { name: '후속 지시' });
  await composer.fill('이 파일도 확인해 주세요.');
  const { promise: hold, resolve: release } = Promise.withResolvers<void>();
  await page.route('**/api/herdr/upload?*', async route => { await hold; await route.fallback(); }, { times: 1 });
  const uploaded = post(page, '/api/herdr/upload');
  try {
    await input(page).evaluate(node => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'clipboard.png', { type: 'image/png' }));
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    expect((await uploaded).headers()['content-type']).toBe('image/png');
    await expect(page.getByText('첨부 중…', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '보내기' })).toBeDisabled();
  } finally { release(); }
  await expect(composer).toHaveValue('이 파일도 확인해 주세요. @/Ghost/uploads/a1b2c3d4-clipboard.png ');
  await terminal(page).evaluate(node => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([''], 'empty.txt', { type: 'text/plain' }));
    dataTransfer.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    node.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('alert')).toContainText('empty.txt: 빈 파일은 첨부할 수 없습니다.');
  await expect(composer).toHaveValue('이 파일도 확인해 주세요. @/Ghost/uploads/a1b2c3d4-clipboard.png @/Ghost/uploads/a1b2c3d4-notes.txt ');
});

test('opens the pane returned by code_run from the Work record, not a guessed id', async ({ page }) => {
  await openScreen(page, {
    ...coding, route: state => `/work/${state.workDoneId}`, waits: () => ['코딩 결과 확인'], prepare: async page => {
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
  await expect(page).toHaveURL(/#\/coding$/);
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
      return route.fulfill({ json: { pane: id, source: 'omp', title: null, reset: !after, cursor: update ? '1256' : '1024', items } satisfies HerdrChat });
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
  const draft = page.getByRole('textbox', { name: '후속 지시' });
  await draft.fill('고치기 전에 기록을 보여 주세요.');
  await page.reload();
  await expect(draft).toHaveValue('고치기 전에 기록을 보여 주세요.');
  await expect(page.getByRole('radio', { name: '대화' })).toBeChecked();
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
