import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { attachmentB64, editTool, loginDiff, mockCodingSessions, partialReply, sampleSession } from './coding-session-mock';
import { openScreen } from './visual';
import { mockWorkbench } from './workbench-mock';

async function openSessionPicker(page: Page, creates: { repo?: string; cwd?: string }[]) {
  const { service } = await mockWorkbench(page, creates);
  const { spaces: [space] } = service.createSpace({ title: '세션 테스트', root: null, version: 0 });
  service.createTab(space!.id, 1, '코딩 세션');
  await openScreen(page, { name: 'coding', route: () => '/coding', waits: () => ['새 패널'] }, 'light');
  await page.getByRole('button', { name: '새 패널' }).click();
  await page.getByRole('dialog', { name: '새 패널' }).getByRole('button', { name: '코딩 세션', exact: true }).click();
  return page.getByRole('dialog', { name: '코딩 세션 선택' });
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
      const picker = await openSessionPicker(page, api.creates);
      await picker.getByRole('button', { name: sampleSession.title, exact: true }).click();
      await expect(page).toHaveURL(/#\/coding$/);
      const pane = page.getByRole('region', { name: `패널: ${sampleSession.title}`, exact: true });
      await expect(pane).toHaveAttribute('data-focused', 'true');
      const workspace = pane.getByRole('region', { name: '내장 코딩 세션' });
      const transcript = workspace.getByRole('region', { name: '코딩 기록' });
      const draft = page.getByRole('textbox', { name: '코딩 지시' });
      await expect(transcript.getByText(partialReply.text)).toBeVisible();
      await expect(transcript.getByText('현재 로그인 흐름과 회귀 가능성을 살핀다.')).toBeHidden();
      await api.item({ ...partialReply, streaming: false, text: '로그인 화면의 제목과 입력 순서를 정리했습니다.' });
      await api.item({ ...editTool, status: 'done', diff: loginDiff });
      await expect(transcript.getByRole('article', { name: '에이전트 응답' })).toHaveCount(1);
      await expect(transcript.getByText('로그인 화면의 제목과 입력 순서를 정리했습니다.')).toBeVisible();
      await transcript.getByText('edit src/login.ts').click();
      await expect(transcript.getByLabel('파일 차이').getByText('+const mode = "focused";')).toBeVisible();
      await capture(page, `${width}-transcript`);
      await transcript.getByText('다른 로그인 진입점 확인', { exact: true }).filter({ visible: true }).click();
      await expect(transcript.getByText('read src/routes.ts')).toBeVisible();
      await transcript.getByText('scout', { exact: true }).click();

      await workspace.getByRole('button', { name: '변경', exact: true }).click();
      const changes = page.getByRole('dialog', { name: '작업 변경' });
      await expect(changes.getByRole('list', { name: '변경된 파일' })).toContainText('src/login.ts');
      const reads = api.changesReads;
      await api.updateChanges();
      await expect(changes.getByLabel('파일 차이')).toContainText('+const mode = "revised";');
      expect(api.changesReads).toBeGreaterThan(reads);
      await changes.getByRole('button', { name: '닫기' }).click();

      await api.patch({ state: 'idle' });
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
      const choices = transcript.getByRole('region', { name: '로그인 목업 고르기' });
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
      const approval = transcript.getByRole('region', { name: '도구 실행 확인' });
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

test('starts from a known repository, patches title and model, then preserves closed history read-only', async ({ page }) => {
  const api = await mockCodingSessions(page);
  const picker = await openSessionPicker(page, api.creates);
  await picker.getByRole('button', { name: '새 세션' }).click();
  const create = page.getByRole('dialog', { name: '새 코딩 세션' });
  const repo = create.getByRole('combobox', { name: '작업 폴더' });
  await expect(repo).toBeVisible();
  await expect(create.getByRole('checkbox', { name: '별도 worktree에서 작업' })).toBeChecked();
  const path = await repo.inputValue();
  expect(path).toMatch(/^\//);
  await create.getByRole('combobox', { name: '모델', exact: true }).selectOption({ label: 'Atlas · sample' });
  await create.getByRole('combobox', { name: '생각 수준' }).selectOption('high');
  await create.getByRole('button', { name: '세션 열기' }).click();
  expect(api.creates).toEqual([{ repo: path, model: { provider: 'sample', model: 'atlas' }, thinking: 'high' }]);
  const workspace = page.getByRole('region', { name: '내장 코딩 세션' });
  await expect(workspace.getByText('아직 지시가 없습니다.')).toBeVisible();
  await workspace.getByRole('button', { name: '세션 설정' }).click();
  await page.getByRole('textbox', { name: '세션 제목' }).fill('테스트 세션');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const renamed = page.getByRole('region', { name: '패널: 테스트 세션', exact: true });
  await expect(renamed.getByRole('heading', { name: '테스트 세션' })).toBeVisible();
  await page.getByRole('combobox', { name: '모델', exact: true }).selectOption({ label: 'Sparrow · sample' });
  await expect.poll(() => api.patches.at(-1)).toEqual({ model: { provider: 'sample', model: 'sparrow' }, thinking: 'off' });
  await page.keyboard.press('Escape');
  await workspace.getByRole('button', { name: '세션 닫기' }).click();
  await page.getByRole('dialog', { name: '코딩 세션 닫기' }).getByRole('button', { name: '세션 닫기' }).click();
  await expect(renamed.getByRole('img', { name: '닫힘', exact: true })).toBeVisible();
  await expect(workspace.getByRole('textbox', { name: '코딩 지시' })).toHaveCount(0);
  await expect(workspace.getByText('기록 없음')).toBeVisible();
});
