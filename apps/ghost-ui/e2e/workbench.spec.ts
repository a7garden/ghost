import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { mockCodingSessions, sampleSession } from './coding-session-mock';
import { openScreen } from './visual';

import { mockWorkbench } from './workbench-mock';

for (const width of [1440, 390]) {
  test.describe(`${width}px 작업대`, () => {
    const phone = width === 390;
    test.use({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
    test('splits, moves and closes panes; reloads the saved layout', async ({ page }) => {
      const coding = await mockCodingSessions(page);
      const { service, closed } = await mockWorkbench(page, coding.creates);
      await openScreen(page, { name: 'workbench', route: () => '/coding', waits: () => ['스페이스 만들기'] }, 'light');
      await page.getByRole('button', { name: '새 스페이스' }).click();
      await page.getByRole('textbox', { name: '이름' }).fill('Ghost 저장소');
      await page.route('**/api/folders**', route => route.fulfill({ json: { path: tmpdir(), parent: null, home: tmpdir(), shortcuts: [], truncated: false, entries: [] } }));
      await page.getByRole('button', { name: '작업 폴더 (선택): 선택 안 함' }).click();
      await page.getByRole('button', { name: '이 폴더 선택' }).click();
      await page.getByRole('button', { name: '저장', exact: true }).click();
      const newTab = page.getByRole('button', { name: '새 탭' });
      if (phone) await newTab.click();
      else {
        await expect(newTab).toBeEnabled();
        await page.keyboard.press('ControlOrMeta+Alt+n');
      }
      await page.getByRole('textbox', { name: '이름' }).fill('작업 중');
      await page.getByRole('button', { name: '저장', exact: true }).click();
      await page.getByRole('button', { name: '새 패널' }).click();
      await page.getByRole('button', { name: '코딩 세션', exact: true }).click();
      await page.getByRole('button', { name: sampleSession.title, exact: true }).click();
      const session = page.getByRole('region', { name: `패널: ${sampleSession.title}`, exact: true });
      await expect(session).toBeVisible();
      if (phone) await session.getByRole('button', { name: '오른쪽으로 분할' }).click();
      else await page.keyboard.press('ControlOrMeta+Shift+ArrowRight');
      await page.getByRole('dialog', { name: '새 패널' }).getByRole('button', { name: '터미널', exact: true }).click();
      const terminal = page.getByRole('region', { name: '패널: 터미널', exact: true });
      await expect(terminal).toHaveAttribute('data-focused', 'true');
      await expect(terminal.getByText('Mock PTY ready')).toBeVisible();
      await terminal.getByRole('button', { name: '터미널 글자 크기' }).click();
      await page.getByRole('button', { name: '글자 크게' }).click();
      await expect(page.getByText('15px', { exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => localStorage.getItem('ghost.coding.terminal-font-size'))).toBe('15');
      await page.keyboard.press('Escape');
      if (phone) await expect(session).not.toBeVisible();
      else await expect(session).toBeVisible();

      await coding.showApproval();
      const tab = page.getByRole('navigation', { name: '탭', exact: true }).getByRole('button', { name: /^작업 중/ });
      await expect(tab.getByRole('img', { name: '입력 대기' })).toBeVisible();
      if (phone) {
        await page.getByRole('button', { name: '스페이스: Ghost 저장소' }).click();
        await expect(page.getByRole('navigation', { name: '스페이스', exact: true }).getByRole('img', { name: '입력 대기' })).toBeVisible();
        await page.keyboard.press('Escape');
      } else {
        await expect(page.getByRole('navigation', { name: '스페이스', exact: true }).getByRole('img', { name: '입력 대기' })).toBeVisible();
      }
      await coding.patch({ state: 'idle', pendingDialog: null, updatedAt: sampleSession.updatedAt + 1 });
      await expect(tab.getByRole('img', { name: '완료' })).toBeVisible();
      if (phone) await terminal.getByRole('button', { name: '아래로 분할' }).click();
      else {
        await terminal.getByRole('textbox', { name: '터미널 입력' }).focus();
        await expect(terminal).toHaveAttribute('data-focused', 'true');
        await expect(async () => {
          await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
          await expect(page.getByRole('dialog', { name: '새 패널' })).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 10_000 });
      }
      await page.getByRole('button', { name: '코딩 세션', exact: true }).click();
      await page.getByRole('button', { name: '새 세션', exact: true }).click();
      const start = page.getByRole('dialog', { name: '새 코딩 세션', exact: true });
      if (phone) await start.getByRole('checkbox', { name: '별도 worktree에서 작업' }).uncheck();
      await start.getByRole('button', { name: '세션 열기' }).click();
      const newSession = page.getByRole('region', { name: '패널: 새 작업 트리', exact: true });
      await expect(newSession).toHaveAttribute('data-focused', 'true');
      expect(coding.creates[0]).toMatchObject(phone ? { cwd: tmpdir() } : { repo: tmpdir() });

      if (phone) {
        await expect(page.getByRole('separator', { name: '패널 너비' })).toHaveCount(0);
        const switcher = page.getByRole('navigation', { name: '패널 전환' });
        await switcher.getByRole('button', { name: '2. 터미널' }).click();
        await expect(terminal).toHaveAttribute('data-focused', 'true');
        await expect(newSession).not.toBeVisible();
        await page.getByRole('button', { name: '패널 위치 바꾸기' }).click();
        await page.getByRole('dialog', { name: '패널 위치 바꾸기' }).getByRole('button', { name: `1. ${sampleSession.title}` }).click();
        await expect(switcher.getByRole('button', { name: '1. 터미널' })).toBeVisible();
      } else {
        await expect(page.getByRole('separator', { name: '패널 높이' })).toBeVisible();
        const separator = page.getByRole('separator', { name: '패널 너비' });
        const bounds = (await separator.boundingBox())!;
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width / 2 + 84, bounds.y + bounds.height / 2, { steps: 6 });
        await page.mouse.up();
        await expect.poll(() => {
          const layout = service.read().tabs[0]?.layout;
          return layout?.type === 'split' ? layout.ratio : 0;
        }).toBeGreaterThan(0.55);
        await terminal.getByTitle('패널을 끌어 서로 바꾸기').dragTo(session.locator('.workbench-pane-head'));
        await expect.poll(async () => (await terminal.boundingBox())?.x ?? Infinity).toBeLessThan((await session.boundingBox())!.x);
      }
      const saved = service.read();
      expect(saved.panes).toHaveLength(3);
      await page.reload();
      await expect(terminal).toHaveAttribute('data-focused', 'true');
      await expect(terminal.getByText('Mock PTY ready')).toBeVisible();
      await terminal.getByRole('button', { name: '터미널 글자 크기' }).click();
      await expect(page.getByText('15px', { exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => localStorage.getItem('ghost.coding.terminal-font-size'))).toBe('15');
      await page.keyboard.press('Escape');
      expect(service.read()).toEqual(saved);
      if (!phone) {
        const ratio = saved.tabs[0]!.layout;
        if (ratio?.type !== 'split') throw new Error('missing saved split');
        await expect(page.getByRole('separator', { name: '패널 너비' })).toHaveAttribute('aria-valuenow', String(Math.round(ratio.ratio * 100)));
      }
      const evidence = process.env.GHOST_WORKBENCH_EVIDENCE_DIR;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `workbench-${width}.png`), animations: 'disabled', caret: 'hide' });
      }
      if (phone) await terminal.getByRole('button', { name: '패널 닫기' }).click();
      else {
        await terminal.getByRole('textbox', { name: '터미널 입력' }).focus();
        await expect(terminal).toHaveAttribute('data-focused', 'true');
        // The shortcut is ignored while a focus mutation is in flight, so press until it takes effect.
        await expect(async () => {
          await page.keyboard.press('ControlOrMeta+Alt+.');
          await expect(session).toHaveAttribute('data-focused', 'true', { timeout: 1000 });
        }).toPass({ timeout: 10_000 });
        await expect(async () => {
          await page.keyboard.press('ControlOrMeta+Alt+,');
          await expect(terminal).toHaveAttribute('data-focused', 'true', { timeout: 1000 });
        }).toPass({ timeout: 10_000 });
        await expect(async () => {
          await page.keyboard.press('ControlOrMeta+Alt+x');
          await expect(page.getByRole('dialog', { name: '터미널 패널 닫기' })).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 10_000 });
      }
      await page.getByRole('dialog', { name: '터미널 패널 닫기' }).getByRole('button', { name: '터미널 닫기' }).click();
      await expect(terminal).toHaveCount(0);
      expect(closed).toEqual(['e2e-pty-1']);
      expect(service.read().panes.map(pane => pane.kind)).toEqual(['session', 'session']);
    });
  });
}

test('starts Claude Code in the native terminal with a manually entered model', async ({ page }) => {
  const cwd = tmpdir();
  const { service } = await mockWorkbench(page);
  const { spaces: [space] } = service.createSpace({ title: 'CLI 테스트', root: cwd, version: 0 });
  service.createTab(space!.id, 1, '터미널');
  await page.route('**/api/terminals/agents', route => route.fulfill({ json: ['claude'] }));
  await openScreen(page, { name: 'CLI launch', route: () => '/coding', waits: () => ['새 패널'] }, 'light');
  await page.getByRole('button', { name: '새 패널' }).click();
  await page.getByRole('dialog', { name: '새 패널' }).getByRole('button', { name: '에이전트', exact: true }).click();
  const form = page.getByRole('dialog', { name: '에이전트 실행' });
  await expect(form.getByRole('combobox', { name: '에이전트' })).toHaveText('Claude Code');
  await form.getByRole('textbox', { name: '모델' }).fill('opus');
  const request = page.waitForRequest(req => req.method() === 'POST' && /\/api\/workbench\/tabs\/[^/]+\/panes$/.test(new URL(req.url()).pathname));
  await form.getByRole('button', { name: '실행', exact: true }).click();
  expect((await request).postDataJSON().pane).toEqual({ kind: 'terminal', terminalSpec: { cwd, command: 'claude', args: ['--model=opus'] } });
  await expect(page.getByRole('region', { name: '패널: claude', exact: true }).getByText('Mock PTY ready')).toBeVisible();
});
