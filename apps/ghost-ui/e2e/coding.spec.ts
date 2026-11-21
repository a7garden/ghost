import { expect, test, type Page } from '@playwright/test';
import { mockCodingApi, visualCodingIds } from './mocks';
import { openScreen } from './visual';

const landing = { name: 'coding', route: () => '/', waits: () => ['최근 끝난 일'], prepare: mockCodingApi };
const coding = { ...landing, route: () => '/coding', waits: () => ['결제 화면 테스트 추가'] };

const sizes = [
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'phone', width: 390, height: 844, touch: true },
];

async function captureCoding(page: Page, name: string) {
  // The seeded clock is fixed, so the roster's relative times belong in these screenshots.
  await page.evaluate(() => document.fonts.ready);
  await expect.soft(page).toHaveScreenshot(name, { animations: 'disabled', caret: 'hide', threshold: 0.2 });
}

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
        const running = list.getByRole('link', { name: /결제 화면 테스트 추가/ });
        const finished = list.getByRole('link', { name: /로그인 실패 시 안내 문구 고치기/ });
        const back = page.getByRole('navigation', { name: '위치' }).getByRole('button', { name: '뒤로', exact: true });
        await expect(running).toBeVisible();
        await captureCoding(page, `list-${theme}-${name}.png`);

        await running.click();
        await expect(page).toHaveURL(new RegExp(`session=${visualCodingIds.running}$`));
        await expect(page.getByText(/거절된 경우 결제 버튼이 다시 활성화되는지/)).toBeVisible();
        await expect(page.getByRole('textbox', { name: '후속 메시지' })).toBeDisabled();
        if (touch) {
          await expect(list).toBeHidden();
          await expect(nav).toBeHidden();
        } else await expect(list).toBeVisible();
        await captureCoding(page, `running-${theme}-${name}.png`);
        if (touch) await back.click();

        await finished.click();
        await expect(page).toHaveURL(new RegExp(`session=${visualCodingIds.finished}$`));
        await expect(page.getByRole('textbox', { name: '후속 메시지' })).toBeEnabled();
        await expect(page.getByRole('button', { name: '이어받기 명령 복사' })).toBeVisible();
        await expect(page.getByText('const message = error.message || fallback;', { exact: true })).toBeVisible();
        await captureCoding(page, `finished-${theme}-${name}.png`);
        if (touch) await back.click();

        await list.getByRole('link', { name: '새 코딩 세션' }).click();
        const agent = page.getByRole('combobox', { name: '코딩 에이전트' });
        await expect(agent).toHaveText('omp');
        await expect(page.getByRole('switch', { name: '새 워크트리에서 작업' })).toBeChecked();
        await expect(page.getByRole('button', { name: '세션 시작' })).toBeEnabled();
        await captureCoding(page, `new-${theme}-${name}.png`);
      });
    }

    test('start, follow up and stop a coding session', async ({ page }) => {
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
      await page.getByRole('button', { name: /app-fix-login/ }).click();
      await expect(repo).toHaveValue('/Users/garden/Workspace/Projects/wt/app-fix-login');
      await page.getByRole('switch', { name: '새 워크트리에서 작업' }).click();
      const created = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/coding-sessions'));
      if (touch) await start.click(); else await task.press('Control+Enter');
      expect((await created).postDataJSON()).toEqual({
        agent: 'omp', repo: '/Users/garden/Workspace/Projects/wt/app-fix-login', task: '엔터 입력 확인\n두 번째 줄', worktree: false,
      });
      await expect(page).toHaveURL(new RegExp(`session=${visualCodingIds.started}$`));
      const transcript = page.getByRole('list', { name: '세션 기록' });
      await expect(transcript.getByText('엔터 입력 확인 두 번째 줄')).toBeVisible();
      await page.getByRole('button', { name: '중지', exact: true }).click();
      await expect(transcript.getByText('중지했습니다.')).toBeVisible();
      if (touch) await page.getByRole('navigation', { name: '위치' }).getByRole('button', { name: '뒤로', exact: true }).click();

      await page.getByRole('link', { name: /로그인 실패 시 안내 문구 고치기/ }).click();
      const result = transcript.locator('details');
      await expect(result).not.toHaveAttribute('open');
      await result.locator('summary').click();
      await expect(result).toHaveAttribute('open', '');
      const compose = page.getByRole('textbox', { name: '후속 메시지' });
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
        const sendBounds = (await page.getByRole('button', { name: '보내기', exact: true }).boundingBox())!;
        expect(sendBounds.y + sendBounds.height).toBeLessThanOrEqual(500);
      }
      const sendButton = page.getByRole('button', { name: '보내기', exact: true });
      const text = touch ? '실패 응답도 확인해 주세요.\n오류 문구를 확인해 주세요.' : '실패 응답도 확인해 주세요.';
      await page.route(`**/api/coding-sessions/${visualCodingIds.finished}/messages`, route => route.fulfill({
        status: 409, json: { error: { code: 'conflict', message: '실행 중인 세션이 너무 많습니다.' } },
      }), { times: 1 });
      await sendButton.click();
      await expect(page.getByRole('alert')).toHaveText('실행 중인 세션이 너무 많습니다.');
      await expect(compose).toHaveValue(text);
      const posted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/${visualCodingIds.finished}/messages`));
      const polled = page.waitForResponse(response => response.url().includes(`/${visualCodingIds.finished}?after=6`));
      if (touch) await sendButton.click(); else await compose.press('Meta+Enter');
      expect((await posted).postDataJSON()).toEqual({ text });
      await expect(transcript.locator('[data-kind="user"] p')).toHaveText(text.replace('\n', ' '));
      await expect(compose).toBeDisabled();
      expect(await (await polled).json()).toMatchObject({ steps: [{ kind: 'say', text: '실패 응답도 확인하겠습니다.' }], next: 7 });
      await expect(transcript.getByText('실패 응답도 확인하겠습니다.', { exact: true })).toBeVisible();
      await expect(transcript.getByText('테스트 3개 통과', { exact: true })).toHaveCount(1);
    });

    test('resume an existing agent session without a worktree', async ({ page }) => {
      await openScreen(page, coding, 'light');
      await page.getByRole('link', { name: '새 코딩 세션' }).click();
      await page.getByRole('textbox', { name: '기존 에이전트 세션 ID (선택)' }).fill('native-123');
      await expect(page.getByRole('switch', { name: '새 워크트리에서 작업' })).toHaveCount(0);
      await page.getByRole('textbox', { name: '작업 디렉터리' }).fill('/Projects/ghost');
      await page.getByRole('textbox', { name: '첫 지시' }).fill('작업을 이어 주세요.');
      const created = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/coding-sessions'));
      await page.getByRole('button', { name: '세션 시작' }).click();
      expect((await created).postDataJSON()).toEqual({ agent: 'omp', repo: '/Projects/ghost', task: '작업을 이어 주세요.', resume: 'native-123' });
      await expect(page).toHaveURL(new RegExp(`session=${visualCodingIds.started}$`));
    });
  });
}
