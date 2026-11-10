import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Command, Goal, Milestone, State, Work } from '@ghost/contract';
import { readRunState } from './run-state';

const at = Date.UTC(2026, 10, 11, 9);
const evidenceDir = process.env.GHOST_GOALS_EVIDENCE_DIR ?? resolve(import.meta.dirname, '../../../.build/goals');
const goal = (id: string, patch: Partial<Goal> = {}): Goal => ({
  id, title: '오래 쓸 수 있는 도구 만들기', why: '사람들이 자기 일을 차분히 이어 가도록 돕습니다.',
  boundaries: '허락 없이 메시지를 보내지 않습니다.', signal: '도구를 다시 찾는 사람의 이야기',
  state: 'active', proposedBy: null, createdAt: at, updatedAt: at, closedAt: null, ...patch,
});
const milestone = (id: string, patch: Partial<Milestone> = {}): Milestone => ({
  id, goalId: 'g1', title: id, hypothesis: '실제 사용 경험에서 다음 방향을 찾습니다.', exit: '사용자와 확인한 기록이 남습니다.',
  outcome: '', state: 'planned', workIds: [], createdBy: 'main', settledBy: null, createdAt: at,
  startedAt: null, endedAt: null, ...patch,
});
const work = (id: string, state: Work['state']): Work => ({
  id, title: state === 'done' ? '첫 사용 기록 정리' : '읽기 흐름 살펴보기', state, parentId: null, rootId: id,
  ghostId: 'main', originConversationId: 'c1', conversationId: null, brief: '사용 경험을 정리합니다.',
  acceptance: { criteria: '기록이 남습니다.', checks: [], reviewer: null }, revision: 1, revisionsUsed: 0,
  deadlineAt: null, result: null, verdict: null, reason: null, createdAt: at, updatedAt: at, startedAt: at, endedAt: state === 'done' ? at : null,
});

async function mockGoals(page: Page, options: { cap?: boolean; closed?: boolean; fail?: boolean; empty?: boolean } = {}) {
  const commands: Command[] = [];
  const { baseUrl, defaultGhostId } = readRunState();
  let snapshot: State;
  let releaseEvent: ((body: string) => void) | undefined;
  const queuedEvents: string[] = [];
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const original: State = await response.json();
    snapshot = { ...original, seq: 100, works: [work('accepted-work', 'done'), work('running-work', 'running')],
      goals: options.empty ? [] : [goal('g1'), goal('g2', { title: '팀의 판단 기록 남기기', state: 'paused', why: '중요한 선택의 맥락을 잊지 않기 위해', boundaries: '', signal: '' }),
        ...(options.cap ? [goal('g3', { title: '작은 실험 이어 가기', boundaries: '', signal: '' })] : []),
        ...(options.closed ? [goal('closed', { title: '마친 방향', state: 'closed', closedAt: at })] : [])],
      milestones: options.empty ? [] : [
        milestone('done', { title: '첫 사용을 관찰하기', state: 'done', endedAt: at - 4000, outcome: '세 사람의 사용 기록을 확인했습니다.', workIds: ['accepted-work'], settledBy: 'owner' }),
        milestone('dropped', { title: '설문 범위 넓히기', state: 'dropped', endedAt: at - 3000, outcome: '대화 기록으로 먼저 살펴보기로 했습니다.', settledBy: 'owner' }),
        milestone('active-a', { title: '불편한 순간 모으기', state: 'active', startedAt: at - 2000, workIds: ['accepted-work', 'missing-work'] }),
        milestone('active-b', { title: '읽기 흐름 확인하기', state: 'active', startedAt: at - 1000, workIds: ['running-work'] }),
        milestone('next-a', { title: '작은 변경 실험하기', createdAt: at + 1 }),
        milestone('next-b', { title: '바뀐 경험 듣기', createdAt: at + 2 }),
        milestone('later', { title: '팀과 배운 점 나누기', createdAt: at + 3 }),
        ...(options.closed ? [milestone('closed-step', { goalId: 'closed', title: '접어 둔 실험', state: 'dropped', outcome: '방향을 종료했습니다.', endedAt: at })] : []),
      ].map(item => ({ ...item, createdBy: defaultGhostId })),
      decisions: options.empty ? [] : [{
        id: 'goal-proposal', ghostId: defaultGhostId, kind: 'question', conversationId: null, workId: null, effectId: null,
        state: 'pending', title: '이 방향을 목표로 등록할까요?', detail: '대체 상세 본문은 표시하지 않습니다.', options: ['등록', '거절'],
        proposal: { goal: { title: '팀이 배운 것을 다시 쓸 수 있게', why: '같은 조사를 되풀이하지 않기 위해', boundaries: '개인 정보는 남기지 않습니다.', signal: '이전 기록을 참고한 대화' } },
        answer: null, createdAt: at, resolvedAt: null,
      }],
    };
    await route.fulfill({ response, json: snapshot });
  });
  // Hold SSE until a mocked command produces its ledger update; subsequent subscriptions remain open.
  await page.route('**/api/events*', async route => {
    const event = Promise.withResolvers<string>();
    releaseEvent = event.resolve;
    page.once('close', () => event.resolve(''));
    if (queuedEvents.length) { releaseEvent(queuedEvents.shift()!); releaseEvent = undefined; }
    const body = await event.promise;
    if (!page.isClosed()) await route.fulfill({ contentType: 'text/event-stream', body });
  });
  await page.route('**/api/commands', async route => {
    const command: Command = route.request().postDataJSON().command;
    commands.push(command);
    if (options.fail) {
      await route.fulfill({ status: 409, json: { ok: false, error: { code: 'conflict', message: 'state changed' } } });
      return;
    }
    await route.fulfill({ json: { ok: true, result: {} } });
    let data: Record<string, unknown> | null = null;
    if (command.type === 'milestone.update') {
      const previous = snapshot.milestones!.find(item => item.id === command.milestoneId)!;
      const updated = { ...previous, state: command.state, outcome: command.outcome ?? '', endedAt: at, settledBy: 'owner' };
      snapshot.milestones = snapshot.milestones!.map(item => item.id === updated.id ? updated : item);
      data = { type: 'milestone', milestone: updated };
    } else if (command.type === 'goal.update') {
      const previous = snapshot.goals!.find(item => item.id === command.goalId)!;
      const updated = { ...previous, ...command, updatedAt: at, closedAt: command.state === 'closed' ? at : previous.closedAt };
      snapshot.goals = snapshot.goals!.map(item => item.id === updated.id ? updated : item);
      data = { type: 'goal', goal: updated };
    } else if (command.type === 'goal.create') {
      const created = goal('created', command);
      snapshot.goals!.push(created);
      data = { type: 'goal', goal: created };
    }
    if (data) {
      const body = `event: ledger\ndata: ${JSON.stringify({ seq: ++snapshot.seq, at, data })}\n\n`;
      if (releaseEvent) { releaseEvent(body); releaseEvent = undefined; }
      else queuedEvents.push(body);
    }
  });
  await page.addInitScript(() => localStorage.setItem('ghost-ui:preferences', JSON.stringify({ theme: 'light', animate: false, companion: false })));
  await page.goto(`${baseUrl}/#/goals`);
  await expect(page.locator('.goals-page')).toBeVisible();
  return { commands, baseUrl };
}

/** Expand only the outer scroll frame for review; keep the actual desktop/phone width. */
async function capture(page: Page, name: string) {
  mkdirSync(evidenceDir, { recursive: true });
  const settlePaint = () => page.evaluate(() => {
    const painted = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => painted.resolve()));
    return painted.promise;
  });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: resolve(evidenceDir, name.startsWith('iphone') ? 'iphone-full-light.png' : name), fullPage: true, scale: 'css', animations: 'disabled',
    style: 'html, body, #root, .ghost-root, .shell { height: auto !important; min-height: 100vh !important; } .ghost-root { transform: none !important; } #main-content { overflow: visible !important; }',
  });
  if (name.startsWith('iphone')) {
    await settlePaint();
    await page.screenshot({ path: resolve(evidenceDir, name), fullPage: false, scale: 'css', animations: 'disabled' });
    await page.getByRole('button', { name: '이정표 불편한 순간 모으기, 진행 중', exact: true }).scrollIntoViewIfNeeded();
    await settlePaint();
    await page.screenshot({ path: resolve(evidenceDir, 'iphone-line-light.png'), fullPage: false, scale: 'css', animations: 'disabled' });
    await page.getByRole('button', { name: '이정표 팀과 배운 점 나누기, 예정 · 나중', exact: true }).scrollIntoViewIfNeeded();
    await settlePaint();
    await page.screenshot({ path: resolve(evidenceDir, 'iphone-later-light.png'), fullPage: false, scale: 'css', animations: 'disabled' });
  }
}

test('goals show chronology, proposals, inline evidence and owner settlement', async ({ page }, testInfo) => {
  const { commands } = await mockGoals(page);
  await expect(page.getByRole('heading', { name: '오래 쓸 수 있는 도구 만들기' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '팀의 판단 기록 남기기' })).toBeVisible();
  await expect(page.getByText('이정표 없음', { exact: true })).toBeVisible();
  await expect(page.getByText('목표 제안', { exact: true })).toBeVisible();
  await expect(page.locator('.decision__goal')).toContainText('팀이 배운 것을 다시 쓸 수 있게');
  await expect(page.locator('.decision__goal')).toContainText('지키는 선');
  await expect(page.getByText('대체 상세 본문은 표시하지 않습니다.')).toHaveCount(0);
  await expect(page.locator('.goal-node[data-phase="next"]')).toHaveCount(2);
  await expect(page.locator('.goal-node[data-phase="later"]')).toHaveCount(1);
  await expect(page.locator('.goal-line__column[data-fork]')).toHaveCount(1);
  await expect(page.locator('.goal-node__mark[data-working]')).toHaveCount(1);
  expect(await page.locator('.goal-line').first().getAttribute('data-compact')).toBe(testInfo.project.name === 'iphone' ? 'true' : null);
  if (testInfo.project.name === 'iphone') {
    const dock = page.getByRole('navigation', { name: '주요 화면' });
    await expect(dock.getByRole('button')).toHaveCount(6);
    await dock.getByRole('button', { name: '작업실', exact: true }).click();
    await page.locator('.workspace-page').getByRole('button', { name: '목표', exact: true }).click();
    await expect(page.locator('.goals-page')).toBeVisible();
  }
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth === document.scrollingElement!.clientWidth)).toBe(true);
  await capture(page, `${testInfo.project.name}-light.png`);
  if (testInfo.project.name === 'iphone') {
    const centers = await page.locator('.goal-line__column[data-fork] .goal-node__mark').evaluateAll(marks => marks.map(mark => {
      const bounds = mark.getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    }));
    expect(Math.abs(centers[0].y - centers[1].y)).toBeLessThan(1);
    expect(centers[1].x - centers[0].x).toBeGreaterThan(100);
    const spine = await page.locator('.goal-node[data-state="done"] .goal-node__mark').evaluate(mark => {
      const bounds = mark.getBoundingClientRect();
      return bounds.x + bounds.width / 2;
    });
    expect(Math.abs(centers[0].x - spine)).toBeLessThan(1);
  }
  if (testInfo.project.name === 'desktop') {
    await page.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.theme = 'dark'; });
    await capture(page, 'desktop-dark.png');
  }
  const node = page.getByRole('button', { name: '이정표 불편한 순간 모으기, 진행 중', exact: true });
  await node.click();
  const detail = page.getByRole('region', { name: '이정표 상세 불편한 순간 모으기' });
  await expect(detail.getByText('실제 사용 경험에서 다음 방향을 찾습니다.')).toBeVisible();
  await expect(detail.getByRole('link', { name: '연결된 맡긴 일', exact: true })).toHaveAttribute('href', '#/work/missing-work');
  await detail.getByRole('button', { name: '완료로 표시', exact: true }).click();
  await detail.getByLabel('완료 근거').fill('사용 기록을 확인했습니다.');
  await detail.getByRole('button', { name: '완료로 표시', exact: true }).click();
  await expect.poll(() => commands.at(-1)).toEqual({ type: 'milestone.update', milestoneId: 'active-a', state: 'done', outcome: '사용 기록을 확인했습니다.' });
  await expect(page.getByRole('button', { name: '이정표 불편한 순간 모으기, 완료', exact: true })).toBeVisible();
  await expect(detail.getByText('사용 기록을 확인했습니다.')).toBeVisible();
});

test('open goal cap is explained and closed goal lines are read-only', async ({ page }) => {
  await mockGoals(page, { cap: true, closed: true });
  await expect(page.getByRole('button', { name: '목표 추가', exact: true })).toBeDisabled();
  await expect(page.getByText('진행 중이거나 일시정지한 목표는 3개까지 둘 수 있습니다.')).toBeVisible();
  await page.locator('.goals-closed > summary').click();
  await page.locator('.goals-closed__goal > summary').click();
  await page.getByRole('button', { name: '이정표 접어 둔 실험, 접음', exact: true }).click();
  const closed = page.locator('.goals-closed__goal');
  await expect(closed.getByText('방향을 종료했습니다.')).toBeVisible();
  await expect(closed.getByRole('button', { name: '완료로 표시' })).toHaveCount(0);
});

test('failed goal and milestone changes retain drafts and show Korean errors', async ({ page }) => {
  const { commands } = await mockGoals(page, { fail: true });
  const proposal = page.locator('.decision');
  await proposal.getByRole('button', { name: /등록/ }).click();
  await expect(proposal.getByText('현재 상태에서는 변경할 수 없습니다. 목표와 이정표 상태를 확인해 주세요.')).toBeVisible();
  await expect.poll(() => commands.at(-1)).toEqual({ type: 'decision.resolve', decisionId: 'goal-proposal', outcome: 'answer', answer: '등록' });
  await page.getByRole('button', { name: '목표 추가', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '방향', exact: true }).fill('실패해도 남을 방향');
  await dialog.getByLabel('이유', { exact: true }).fill('지워지지 않을 이유');
  await dialog.getByRole('button', { name: '목표 추가', exact: true }).click();
  await expect(dialog.getByText('현재 상태에서는 변경할 수 없습니다. 목표와 이정표 상태를 확인해 주세요.')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '방향', exact: true })).toHaveValue('실패해도 남을 방향');
  await expect(dialog.getByLabel('이유', { exact: true })).toHaveValue('지워지지 않을 이유');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '이정표 작은 변경 실험하기, 예정 · 다음', exact: true }).click();
  const detail = page.getByRole('region', { name: '이정표 상세 작은 변경 실험하기' });
  await detail.getByRole('button', { name: '접기', exact: true }).click();
  await detail.getByLabel('접은 이유').fill('먼저 진행 중인 실험을 살펴봅니다.');
  await detail.getByRole('button', { name: '접기', exact: true }).click();
  await expect(detail.getByText('현재 상태에서는 변경할 수 없습니다. 목표와 이정표 상태를 확인해 주세요.')).toBeVisible();
  await expect(detail.getByLabel('접은 이유')).toHaveValue('먼저 진행 중인 실험을 살펴봅니다.');
  await expect.poll(() => commands.at(-1)).toEqual({ type: 'milestone.update', milestoneId: 'next-a', state: 'dropped', outcome: '먼저 진행 중인 실험을 살펴봅니다.' });
});

test('empty goals offer creation and editing sends the same fields', async ({ page }) => {
  const { commands } = await mockGoals(page, { empty: true });
  await expect(page.getByText('목표 없음', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '목표 추가', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '방향', exact: true }).fill('  오래 이어 갈 방향  ');
  await dialog.getByLabel('이유', { exact: true }).fill('차분한 이유');
  await dialog.getByLabel('지키는 선', { exact: true }).fill('보내기 전 확인');
  await dialog.getByLabel('참고 신호', { exact: true }).fill('사람의 이야기');
  await dialog.getByRole('button', { name: '목표 추가', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => commands.at(-1)).toEqual({ type: 'goal.create', title: '오래 이어 갈 방향', why: '차분한 이유', boundaries: '보내기 전 확인', signal: '사람의 이야기' });
  await expect(page.getByRole('heading', { name: '오래 이어 갈 방향', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '수정', exact: true }).click();
  await expect(dialog.getByLabel('지키는 선', { exact: true })).toHaveValue('보내기 전 확인');
  await dialog.getByRole('textbox', { name: '방향', exact: true }).fill('더 오래 이어 갈 방향');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => commands.at(-1)).toEqual({ type: 'goal.update', goalId: 'created', title: '더 오래 이어 갈 방향', why: '차분한 이유', boundaries: '보내기 전 확인', signal: '사람의 이야기' });
  await expect(page.getByRole('heading', { name: '더 오래 이어 갈 방향', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '일시정지', exact: true }).click();
  await expect.poll(() => commands.at(-1)).toEqual({ type: 'goal.update', goalId: 'created', state: 'paused' });
  await page.getByRole('button', { name: '재개', exact: true }).click();
  await expect.poll(() => commands.at(-1)).toEqual({ type: 'goal.update', goalId: 'created', state: 'active' });
  await page.getByRole('button', { name: '종료', exact: true }).click();
  await expect(dialog.getByText('종료한 목표는 다시 열 수 없습니다.')).toBeVisible();
  await expect(dialog.getByText(/진행 중이거나 예정인 이정표는 모두 접힙니다/)).toBeVisible();
  await dialog.getByRole('button', { name: '목표 종료', exact: true }).click();
  await expect.poll(() => commands.at(-1)).toEqual({ type: 'goal.update', goalId: 'created', state: 'closed' });
  await expect(page.locator('.goals-closed > summary')).toBeVisible();
});
