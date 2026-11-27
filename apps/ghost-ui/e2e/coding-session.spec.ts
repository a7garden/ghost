import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { attachmentB64, editTool, loginDiff, mockCodingSessions, partialReply, sampleSession } from './coding-session-mock';
import { openScreen } from './visual';
import { mockWorkbench } from './workbench-mock';

/** Opens the launch pane of 프로젝트 없음, where sessions outside every project wait under 「이어서 하기」. A phone reaches it from the roster. */
async function openLaunch(page: Page, creates: unknown[]) {
  const { service } = await mockWorkbench(page, creates);
  service.focus({ version: 0, scopeId: null });
  await openScreen(page, { name: 'coding', route: () => '/coding', waits: () => ['새 에이전트'] }, 'light');
  if ((page.viewportSize()?.width ?? 1440) < 896) await page.getByRole('button', { name: '새 에이전트', exact: true }).click();
  return page.getByRole('region', { name: '새 에이전트', exact: true });
}

async function capture(page: Page, name: string) {
  const directory = process.env.GHOST_CODING_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const width of [1440, 390]) {
  test.describe(`${width}px coding session`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
    test('streams edits, attaches an image, answers both dialogs and recovers after a disconnect and abort', async ({ page }) => {
      const api = await mockCodingSessions(page);
      const remotePreviews: string[] = [];
      // Chromium reports attempted CSP-blocked loads as `request` events, but never routes them.
      await page.route('https://coding-preview-never.invalid/**', route => {
        remotePreviews.push(route.request().url());
        return route.abort();
      });
      const launch = await openLaunch(page, api.creates);
      await launch.getByRole('region', { name: '이전 세션' }).getByRole('button', { name: new RegExp(sampleSession.title) }).click();
      await expect(page).toHaveURL(width === 390 ? /#\/coding\/-\?session=/ : /#\/coding\/-$/);
      const agent = page.getByRole('region', { name: `에이전트: ${sampleSession.title}`, exact: true });
      await expect(agent).toBeVisible();
      const workspace = agent.getByRole('region', { name: '내장 코딩 세션' });
      const transcript = workspace.getByRole('region', { name: '코딩 기록' });
      const draft = page.getByRole('textbox', { name: '코딩 지시' });
      await expect(transcript.getByText(partialReply.text)).toBeVisible();
      await expect(transcript.getByText('현재 로그인 흐름과 회귀 가능성을 살핀다.')).toBeHidden();
      await api.item({ ...partialReply, streaming: false, text: '로그인 화면의 제목과 입력 순서를 정리했습니다.' });
      await api.item({ ...editTool, status: 'done', diff: loginDiff });
      await expect(transcript.getByRole('article', { name: '에이전트 응답' })).toHaveCount(1);
      await expect(transcript.getByText('로그인 화면의 제목과 입력 순서를 정리했습니다.')).toBeVisible();
      await expect(transcript.getByText('edit src/login.ts')).toBeHidden();
      await transcript.locator('.embedded-tool-run > summary').click();
      await transcript.getByText('edit src/login.ts').click();
      await expect(transcript.getByLabel('파일 차이').getByText('+const mode = "focused";')).toBeVisible();
      await capture(page, `${width}-transcript`);
      await transcript.getByText('다른 로그인 진입점 확인', { exact: true }).filter({ visible: true }).click();
      await expect(transcript.getByText('read src/routes.ts')).toBeVisible();
      await transcript.getByText('scout', { exact: true }).click();

      await page.getByRole('button', { name: '작업 변경' }).filter({ visible: true }).first().click();
      const changes = page.getByRole('dialog', { name: '작업 변경' });
      await expect(changes.getByRole('list', { name: '변경된 파일' })).toContainText('src/login.ts');
      const reads = api.changesReads;
      await api.updateChanges();
      await expect(changes.getByLabel('파일 차이')).toContainText('+const mode = "revised";');
      expect(api.changesReads).toBeGreaterThan(reads);
      await changes.getByRole('button', { name: '닫기' }).click();

      await api.patch({ state: 'idle' });
      await expect(workspace.getByRole('button', { name: '작업 중단' })).toHaveCount(0);
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        workspace.getByRole('button', { name: '이미지 첨부' }).click(),
      ]);
      await fileChooser.setFiles({ name: 'owner.png', mimeType: 'image/png', buffer: Buffer.from(attachmentB64, 'base64') });
      await expect(workspace.getByRole('button', { name: 'owner.png 빼기' })).toBeVisible();
      await draft.fill('이 이미지를 바탕으로 시안을 보여 주세요.');
      await workspace.getByRole('button', { name: '지시 보내기' }).click();
      await expect.poll(() => api.prompts.at(-1)).toEqual({ text: '이 이미지를 바탕으로 시안을 보여 주세요.', mode: 'prompt', images: [
        { name: 'owner.png', mimeType: 'image/png', data: attachmentB64 },
      ] });
      const choices = workspace.getByRole('region', { name: '로그인 목업 고르기' });
      await expect(choices.getByRole('img', { name: '집중형 이미지' })).toBeVisible();
      await expect(choices.getByRole('img', { name: '여백형 이미지' })).toBeVisible();
      const previewFrame = choices.locator('iframe');
      await expect(previewFrame).toHaveAttribute('sandbox', '');
      await expect(previewFrame).toHaveAttribute('src', /^blob:/);
      await expect(previewFrame.contentFrame().getByRole('heading', { name: '한 줄 로그인' })).toBeVisible();
      await expect(draft).toBeEnabled();
      await choices.getByRole('heading').scrollIntoViewIfNeeded();
      await capture(page, `${width}-choices`);
      await choices.getByRole('button', { name: '간결형 크게 보기' }).click();
      const expanded = page.getByRole('dialog', { name: '간결형' });
      await expect(expanded.locator('iframe').contentFrame().getByRole('heading', { name: '한 줄 로그인' })).toBeVisible();
      await expanded.getByRole('button', { name: '미리보기 닫기' }).click();
      expect(remotePreviews).toEqual([]);
      await choices.getByRole('radio', { name: '간결형' }).check();
      await choices.getByRole('button', { name: '선택 보내기' }).click();
      await expect(choices).toHaveCount(0);
      expect(api.answers[0]).toEqual({ id: 'mockups', input: { optionId: 'compact' } });

      await api.showApproval();
      const approval = workspace.getByRole('region', { name: '도구 실행 확인' });
      await expect(approval.getByText('bun run screenshot --output /tmp/login.png')).toBeVisible();
      await approval.getByRole('button', { name: '한 번 허용' }).click();
      await expect(approval).toHaveCount(0);
      expect(api.answers[1]).toEqual({ id: 'approval', input: { value: 'yes' } });
      await draft.fill('로그인 버튼 위치도 조정해 주세요.');
      await workspace.getByRole('button', { name: '방향 수정' }).click();
      await expect(draft).toHaveValue('');
      expect(api.prompts.at(-1)?.mode).toBe('steer');
      await draft.fill('끝나면 휴대전화 폭도 확인해 주세요.');
      await workspace.getByRole('button', { name: '후속 지시 예약' }).click();
      await expect(workspace.getByText('후속 지시를 예약했습니다.')).toBeVisible();
      expect(api.prompts.at(-1)?.mode).toBe('follow_up');
      await workspace.getByRole('button', { name: '작업 중단' }).click();
      await expect(transcript.getByText('요청으로 작업을 중단했습니다.')).toBeVisible();
      expect(api.aborts).toBe(1);

      await api.patch({ state: 'working' });
      const before = api.historyReads;
      await api.dropStream();
      await expect(workspace.getByRole('button', { name: '다시 연결' })).toBeVisible();
      await expect(transcript.getByText('Host가 다시 시작되어 턴이 중단되었습니다.')).toBeVisible();
      expect(api.historyReads).toBeGreaterThan(before);
      await draft.fill('이어서 로그인 테스트를 실행해 주세요.');
      await workspace.getByRole('button', { name: '지시 보내기' }).click();
      await expect(workspace.getByRole('button', { name: '작업 중단' })).toBeVisible();
      expect(api.prompts.at(-1)).toEqual({ text: '이어서 로그인 테스트를 실행해 주세요.', mode: 'prompt' });
      await expect(workspace.getByRole('button', { name: '최신 기록' })).toHaveCount(0);
      await expect.poll(() => workspace.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    });
  });
}

test('starts from one instruction with folder, worktree and model chips, renames in place, then preserves closed history read-only', async ({ page }) => {
  const api = await mockCodingSessions(page);
  await page.route('**/api/folders**', route => route.fulfill({ json: { path: tmpdir(), parent: null, home: tmpdir(), shortcuts: [], truncated: false, entries: [] } }));
  const launch = await openLaunch(page, api.creates);
  // Outside a project the agent starts in the sandbox: no worktree choice until a folder is picked.
  await launch.getByRole('button', { name: '작업 폴더: 샌드박스' }).click();
  await page.getByRole('dialog', { name: '작업 폴더' }).getByRole('button', { name: '다른 폴더…' }).click();
  await page.getByRole('button', { name: '이 폴더 선택' }).click();
  await launch.getByRole('button', { name: '바로 작업' }).click();
  await launch.getByRole('button', { name: /^모델 Sparrow/ }).click();
  const models = page.getByRole('dialog', { name: '모델 선택' });
  await models.getByRole('button', { name: 'Atlas' }).click();
  await models.getByRole('radio', { name: '높음' }).click();
  await page.keyboard.press('Escape');
  await launch.getByRole('textbox', { name: '코딩 지시' }).fill('로그인 흐름 점검');
  await launch.getByRole('button', { name: '지시 보내기' }).click();
  await expect.poll(() => api.creates).toEqual([{ repo: tmpdir(), model: { provider: 'sample', model: 'atlas' }, thinking: 'high', prompt: '로그인 흐름 점검' }]);
  const agent = page.getByRole('region', { name: '에이전트: 새 작업 트리', exact: true });
  await expect(agent).toBeVisible();

  await agent.getByRole('button', { name: '에이전트 이름: 새 작업 트리' }).click();
  await agent.getByRole('textbox', { name: '에이전트 이름' }).fill('테스트 세션');
  await page.keyboard.press('Enter');
  await expect.poll(() => api.patches.at(-1)).toEqual({ title: '테스트 세션' });
  const renamed = page.getByRole('region', { name: '에이전트: 테스트 세션', exact: true });
  await renamed.getByRole('button', { name: /^모델 Atlas/ }).click();
  await page.getByRole('dialog', { name: '모델 선택' }).getByRole('button', { name: 'Sparrow' }).click();
  await expect.poll(() => api.patches.at(-1)).toEqual({ model: { provider: 'sample', model: 'sparrow' }, thinking: 'off' });
  await page.keyboard.press('Escape');
  await renamed.getByRole('button', { name: '에이전트 메뉴' }).click();
  await page.getByRole('dialog', { name: '에이전트 메뉴' }).getByRole('button', { name: '세션 닫기' }).click();
  await page.getByRole('dialog', { name: '세션 닫기' }).getByRole('button', { name: '세션 닫기' }).click();
  await expect(renamed.locator('.workbench-pane__head').getByRole('img', { name: '닫힘', exact: true })).toBeVisible();
  await expect(renamed.getByRole('textbox', { name: '코딩 지시' })).toHaveCount(0);
  await expect(renamed.getByText('기록 없음')).toBeVisible();
});
