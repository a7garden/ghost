import { expect, test, type Page } from '@playwright/test';
import type { CodingSetup, Effect, HerdrOutput, WorkDetail } from '@ghost/contract';
import { mockCodingApi, visualCodingIds } from './mocks';
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
const terminal = (page: Page) => page.locator('pre[aria-label="터미널 출력"]');
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
        const app = list.getByRole('region', { name: 'app', exact: true });
        const running = app.getByRole('link', { name: /결제 화면 테스트 추가/ });
        const finished = app.getByRole('link', { name: /로그인 실패 시 안내 문구 고치기/ });
        const blocked = list.getByRole('region', { name: 'ghost', exact: true }).getByRole('link', { name: /설정 화면 키보드 탐색 확인/ });
        const composer = page.getByRole('textbox', { name: '후속 지시' });
        const keys = page.getByRole('group', { name: '승인 응답 키' });
        await expect(app.getByRole('link')).toHaveCount(2);
        await expect(blocked).toContainText('입력 필요');
        await expect(list.getByText('에이전트 연동', { exact: true })).toBeVisible();
        await captureCoding(page, `list-${theme}-${name}.png`);

        await running.click();
        await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.running)}`);
        await expect(terminal(page)).toContainText('거절된 경우 결제 버튼이 다시 활성화되는지도 확인하겠습니다.');
        await expect(composer).toBeDisabled();
        await expect(keys).toHaveCount(0);
        if (touch) {
          await expect(list).toBeHidden();
          await expect(nav).toBeHidden();
        } else await expect(list).toBeVisible();
        await captureCoding(page, `running-${theme}-${name}.png`);
        if (touch) await back(page).click();

        await finished.click();
        await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.finished)}`);
        await expect(composer).toBeEnabled();
        await expect(terminal(page)).toContainText('<b>터미널 텍스트</b>');
        await expect(terminal(page).locator('*')).toHaveCount(0);
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

        await list.getByRole('link', { name: '새 코딩 세션' }).click();
        await expect(page.getByRole('combobox', { name: '코딩 에이전트' })).toHaveText('Claude Code');
        await expect(page.getByRole('switch', { name: '새 워크트리에서 작업' })).toBeChecked();
        await expect(page.getByRole('button', { name: '세션 시작' })).toBeEnabled();
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
      await page.getByRole('link', { name: '새 코딩 세션' }).click();
      const task = page.getByRole('textbox', { name: '첫 지시' });
      const start = page.getByRole('button', { name: '세션 시작' });
      const repo = page.getByRole('textbox', { name: '저장소' });
      await task.fill('엔터 입력 확인\n두 번째 줄');
      await repo.fill('/missing');
      await start.click();
      await expect(page.getByRole('alert')).toHaveText('저장소 경로를 찾을 수 없습니다.');
      await expect(task).toHaveValue('엔터 입력 확인\n두 번째 줄');
      await page.getByRole('button', { name: '저장소 선택' }).click();
      const project = page.getByRole('dialog', { name: '저장소 선택' }).getByRole('button', { name: /^비행 기록/ });
      const path = await project.locator('code').innerText();
      await project.click();
      await expect(repo).toHaveValue(path);
      await page.getByRole('switch', { name: '새 워크트리에서 작업' }).click();
      const { promise: hold, resolve: release } = Promise.withResolvers<void>();
      await page.route('**/api/herdr/start', async route => {
        await hold;
        await route.fallback();
      }, { times: 1 });
      const created = post(page, '/api/herdr/start');
      try {
        if (touch) await start.click(); else await task.press('Control+Enter');
        expect((await created).postDataJSON()).toEqual({
          agent: 'claude', repo: path, task: '엔터 입력 확인\n두 번째 줄', worktree: false,
        });
        await expect(page.getByRole('button', { name: '시작 중…' })).toBeDisabled();
      } finally { release(); }
      await expect(page).toHaveURL(url => url.hash === `#${paneRoute(visualCodingIds.started)}`);
      await expect(terminal(page)).toContainText('엔터 입력 확인 두 번째 줄');
      const interrupted = post(page, '/api/herdr/keys');
      await page.getByRole('button', { name: '중단 (Esc)' }).click();
      expect((await interrupted).postDataJSON()).toEqual({ pane: visualCodingIds.started, keys: ['esc'] });
      await expect(terminal(page)).toContainText('Interrupted (Esc)');
      if (touch) await back(page).click();

      await page.getByRole('link', { name: /로그인 실패 시 안내 문구 고치기/ }).click();
      const compose = page.getByRole('textbox', { name: '후속 지시' });
      const send = page.getByRole('button', { name: '보내기', exact: true });
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

    test('answers a blocked agent and hides input if the pane closes', async ({ page }) => {
      await openScreen(page, { ...coding, route: () => paneRoute(visualCodingIds.blocked), waits: () => ['입력 필요'] }, 'light');
      const keys = page.getByRole('group', { name: '승인 응답 키' });
      const pressed = post(page, '/api/herdr/keys');
      await keys.getByRole('button', { name: 'Enter', exact: true }).click();
      expect((await pressed).postDataJSON()).toEqual({ pane: visualCodingIds.blocked, keys: ['enter'] });
      await expect(keys).toHaveCount(0);
      await expect(terminal(page)).toContainText('Running tests');
      await page.route('**/api/herdr/output?*', route => route.fulfill({
        status: 404, json: { error: { code: 'not_found', message: 'pane not found' } },
      }));
      await expect(page.getByRole('alert')).toHaveText('이 패널은 더 이상 없습니다.');
      await expect(page.getByRole('textbox', { name: '후속 지시' })).toHaveCount(0);
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
    sessions: [], server: null, agents: [], prefs: { session: null, agent: null },
  };
  await openScreen(page, {
    ...coding, waits: () => ['config.toml: invalid key'], prepare: async page => {
      await mockCodingApi(page);
      await page.route('**/api/coding', route => setupOverride ? route.fulfill({ json: setupOverride }) : route.fallback());
      await page.route('**/api/herdr', route => setupOverride ? route.fulfill({ json: {
        available: Boolean(setupOverride.herdr.path), session: 'default', note: 'herdr 서버가 실행 중이 아닙니다.', panes: [],
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
    sessions: [{ name: 'default', running: false }], server: null, agents: [], prefs: { session: null, agent: null },
  };
  await expect(setup.getByText('Mac 터미널에서 herdr를 여세요.')).toBeVisible();
});

test('terminal output follows the bottom until the owner scrolls away', async ({ page }) => {
  let tail = 'first';
  const output: HerdrOutput = {
    pane: { id: visualCodingIds.finished, title: '긴 터미널', agent: 'omp', status: 'idle', workspace: 'app', cwd: null, tab: 'login' },
    text: Array.from({ length: 150 }, (_, index) => `line ${index}`).join('\n'),
  };
  await openScreen(page, {
    ...coding, route: () => paneRoute(output.pane.id), waits: () => ['긴 터미널'], prepare: async page => {
      await mockCodingApi(page);
      await page.route('**/api/herdr/output?*', route => route.fulfill({ json: { ...output, text: `${output.text}\n${tail}` } }));
    },
  }, 'light');
  const screen = terminal(page);
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
