import { expect, test, type Page } from '@playwright/test';
import type { CodingSetup, Effect, HerdrOutput, WorkDetail } from '@ghost/contract';
import { fulfillHerdrFrame, mockCodingApi, visualCodingIds } from './mocks';
import { openScreen } from './visual';
import { readRunState } from './run-state';

const landing = { name: 'coding', route: () => '/', waits: () => ['최근 끝난 일'], prepare: mockCodingApi };
const coding = { ...landing, route: () => '/coding', waits: () => ['결제 화면 테스트 추가'] };
const stopped = { ...coding, waits: () => ['Mac 터미널에서 herdr를 여세요.'], prepare: (page: Page) => mockCodingApi(page, { stopped: true }) };
const sizes = [
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'phone', width: 390, height: 844, touch: true },
];

async function captureCoding(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect.soft(page).toHaveScreenshot(name, { animations: 'disabled', caret: 'hide', threshold: 0.2 });
}

const post = (page: Page, path: string) => page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === path);
const paneRoute = (id: string) => `/coding?herdr=${encodeURIComponent(id)}`;
const terminal = (page: Page) => page.locator('.xterm-rows');
const input = (page: Page) => page.getByRole('textbox', { name: '터미널 입력' });
const history = (page: Page) => page.locator('pre[aria-label="터미널 기록"]');
const back = (page: Page) => page.getByRole('navigation', { name: '위치' }).getByRole('button', { name: '뒤로', exact: true });

for (const { name, width, height, touch } of sizes) {
  test.describe(name, () => {
    test.use({ viewport: { width, height }, isMobile: touch, hasTouch: touch });
    for (const theme of ['light', 'dark'] as const) {
      test(`coding screen in ${theme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await openScreen(page, landing, theme);
        const nav = page.getByRole('navigation', { name: touch ? '주요 화면' : '작업실', exact: true });
        await nav.getByRole('button', { name: '코딩', exact: true }).click();
        await expect(page).toHaveURL(/#\/coding$/);
        const list = page.getByRole('region', { name: '코딩 세션', exact: true });
        const app = list.getByRole('region', { name: '스페이스 · app', exact: true });
        const running = app.getByRole('link', { name: /결제 화면 테스트 추가/ });
        const finished = app.getByRole('link', { name: /로그인 실패 시 안내 문구 고치기/ });
        const blocked = list.getByRole('region', { name: '스페이스 · ghost', exact: true }).getByRole('link', { name: /설정 화면 키보드 탐색 확인/ });
        const shell = app.getByRole('link', { name: /^zsh/ });
        const composer = page.getByRole('textbox', { name: '후속 지시' });
        const keys = page.getByRole('group', { name: '터미널 키' });
        await expect(app.getByRole('region', { name: '탭 · checkout' }).getByRole('link')).toHaveCount(2);
        await expect(app.getByRole('region', { name: '탭 · login' }).getByRole('link')).toHaveCount(1);
        await expect(list.getByText('fix/settings-navigation')).toBeVisible();
        await expect(blocked).toContainText('입력 필요');
        await expect(list.getByText('에이전트 연동', { exact: true })).toBeVisible();
        await captureCoding(page, `list-${theme}-${name}.png`);

        await running.click();
        await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.running)}`);
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
        await expect(terminal(page)).toContainText('3 pass');
        await expect(terminal(page).locator('b')).toHaveCount(0);
        await captureCoding(page, `finished-${theme}-${name}.png`);
        if (touch) await back(page).click();

        await blocked.click();
        await expect(terminal(page)).toContainText('Do you want to proceed?');
        await expect(composer).toBeDisabled();
        await expect(keys.getByRole('button')).toHaveCount(8);
        if (touch) {
          const bounds = await keys.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
          expect(bounds.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
        }
        await captureCoding(page, `blocked-${theme}-${name}.png`);
        if (touch) await back(page).click();

        await shell.click();
        await expect(terminal(page)).toContainText('git status --short');
        await expect(composer).toHaveCount(0);
        await captureCoding(page, `shell-${theme}-${name}.png`);
        if (touch) await back(page).click();

        await list.getByRole('link', { name: '새 스페이스' }).click();
        await expect(page.getByRole('combobox', { name: '에이전트' })).toHaveText('Claude Code');
        await expect(page.getByRole('switch', { name: '새 워크트리에서 작업' })).toBeChecked();
        await expect(page.getByRole('button', { name: '스페이스 만들기' })).toBeEnabled();
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
      const interrupted = post(page, '/api/herdr/input');
      await page.getByRole('button', { name: '중단 (Esc)' }).click();
      expect((await interrupted).postDataJSON()).toEqual({ pane: visualCodingIds.started, keys: ['esc'] });
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
      const keys = page.getByRole('group', { name: '터미널 키' });
      if (touch) {
        await input(page).focus();
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 460 });
          window.visualViewport!.dispatchEvent(new Event('resize'));
        });
        await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open');
        const live = await page.locator('.herdr-xterm').boundingBox();
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
      expect((await saved).postDataJSON().command).toEqual({ type: 'coding.set', session: 'studio', agent: 'claude' });
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
    sessions: [], server: null, agents: [], kinds: [], prefs: { session: null, agent: null },
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
    sessions: [{ name: 'default', running: false }], server: null, agents: [], kinds: [], prefs: { session: null, agent: null },
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
      Number(url.searchParams.get('cols')) < Number(initial.get('cols')) && Number(url.searchParams.get('rows')) < Number(initial.get('rows'));
  });
  await page.setViewportSize({ width: 1120, height: 720 });
  const resized = await refitted;
  expect(resized.headers()['authorization']).toMatch(/^Bearer /);
  await expect(page).toHaveURL(`${baseUrl}/#${paneRoute(visualCodingIds.shell)}`);
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

test('plain text history follows the bottom until the owner scrolls away', async ({ page }) => {
  let tail = 'first';
  const output: HerdrOutput = {
    pane: { id: visualCodingIds.finished, workspaceId: 'w79', tabId: 'w79:tA', title: '긴 터미널', agent: 'omp', status: 'idle',
      workspace: 'app', cwd: null, tab: 'login', focused: true },
    text: Array.from({ length: 150 }, (_, index) => `line ${index}`).join('\n'),
  };
  await openScreen(page, {
    ...coding, route: () => paneRoute(output.pane.id), waits: () => [], prepare: async page => {
      await mockCodingApi(page);
      await page.route('**/api/herdr/output?*', route => route.fulfill({ json: { ...output, text: `${output.text}\n${tail}` } }));
    },
  }, 'light');
  await page.getByRole('radio', { name: '기록' }).click();
  const screen = history(page);
  const distance = () => screen.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
  await expect(screen).toContainText('first');
  await expect.poll(distance).toBeLessThanOrEqual(2);
  tail += '\nsecond';
  await expect(screen).toContainText('second');
  await expect.poll(distance).toBeLessThanOrEqual(2);
  await screen.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  tail += '\nthird';
  await expect(screen).toContainText('third');
  await expect.poll(() => screen.evaluate(node => node.scrollTop)).toBe(0);
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
