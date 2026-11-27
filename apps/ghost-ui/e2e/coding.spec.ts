import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import type { CodingRun, WorkDetail } from '@ghost/contract';
import { mockCodingSessions, sampleSession } from './coding-session-mock';
import { openScreen } from './visual';
import { readRunState } from './run-state';
import { mockWorkbench } from './workbench-mock';

test('keeps old coding history readable and opens an embedded run in the workbench', async ({ page, hasTouch }) => {
  const coding = await mockCodingSessions(page);
  await coding.patch({ repo: tmpdir(), cwd: tmpdir() });
  await mockWorkbench(page, coding.creates);
  await openScreen(page, {
    name: 'work coding runs', route: state => `/work/${state.workDoneId}`, waits: () => [],
    prepare: async page => {
      const state = readRunState();
      await page.route(`**/api/works/${state.workDoneId}`, async route => {
        const response = await route.fetch();
        const detail: WorkDetail = await response.json();
        const old: CodingRun = {
          id: 'old-run', workId: state.workDoneId, session: 'default', pane: 'w79:pA', terminalId: 'term-1', agent: 'omp',
          checkout: '/test/repos/ghost', branch: 'fix/login', base: null, turn: 1, deliveredTurn: 1, state: 'settled',
          startedAt: state.fixedNow - 60_000, updatedAt: state.fixedNow, seenWorking: true, prompt: '로그인 확인', report: null, stopPending: false,
        };
        const current: CodingRun = {
          ...old, id: 'embedded-run', agent: 'ghost', session: `ghost:${sampleSession.id}`, pane: null, terminalId: null, state: 'working',
        };
        await route.fulfill({ response, json: { ...detail, codingRuns: [old, current] } });
      });
    },
  }, 'light');
  if (hasTouch) await page.locator('summary').filter({ has: page.getByRole('heading', { name: /^코딩/ }) }).click();
  const old = page.getByRole('listitem').filter({ has: page.getByText('omp · fix/login', { exact: true }) });
  await expect(old).toBeVisible();
  await expect(old).toContainText('완료');
  await expect(old.getByRole('link')).toHaveCount(0);
  await page.getByRole('link', { name: '코딩 세션 열기', exact: true }).click();
  await expect(page).toHaveURL(url => url.hash === `#/coding/-?session=${sampleSession.id}`);
  const agent = page.getByRole('region', { name: `에이전트: ${sampleSession.title}`, exact: true });
  await expect(agent).toBeVisible();
});

test('reviews staged and unstaged changes under the selected file without losing the file list', async ({ page }) => {
  const paths = ['src/header.ts', 'src/footer.ts'];
  await openScreen(page, { name: 'project changes', route: state => `/coding/${state.scopeId}`, waits: () => ['git 변경'], prepare: async page => {
    await page.route('**/api/workbench/changes?*', route => {
      const path = new URL(route.request().url()).searchParams.get('path');
      return route.fulfill({ json: path ? { path, staged: `+staged ${path}`, unstaged: `+local ${path}`, truncated: false } :
        { branch: 'main', files: paths.map(path => ({ path, status: 'modified', additions: 2, deletions: 0 })), truncated: false } });
    });
  } }, 'light');
  await page.getByRole('button', { name: 'git 변경' }).click();
  const sheet = page.getByRole('dialog', { name: 'git 변경' });
  for (const path of paths) {
    const row = sheet.getByRole('listitem').filter({ has: page.getByRole('button', { name: new RegExp(path) }) });
    await row.getByRole('button').click();
    await expect(row.getByRole('region', { name: '스테이징된 변경' })).toContainText(`+staged ${path}`);
    await expect(row.getByRole('region', { name: '작업 폴더 변경' })).toContainText(`+local ${path}`);
    await expect(sheet.getByRole('article')).toHaveCount(1);
  }
  const last = sheet.getByRole('button', { name: /src\/footer\.ts/ });
  await last.click();
  await expect(last).toBeFocused();
  await expect(sheet.getByRole('article')).toHaveCount(0);
});
