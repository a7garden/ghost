import { expect, test, type Page } from '@playwright/test';
import type { Decision, Scope, State, Work } from '@ghost/contract';
import { readRunState, type VisualRunState } from './run-state';

/**
 * The project directory names each project's own next step — oldest owner decision first, then newest live
 * Work, then the latest result — and both destinations route. Two projects share one receiving Ghost here,
 * so a row may only ever speak from its own scope.
 */

let run: VisualRunState;
test.beforeEach(() => { run = readRunState(); });

const equipmentScopeId = 'dir-equipment';
const emptyScopeId = 'dir-empty';
const pausedScopeId = 'dir-paused';
const liveWorkId = 'dir-live';
const settledWorkId = 'dir-settled';
const oldestDecisionId = 'dir-oldest';
const newerDecisionId = 'dir-newer';
const delegatedDecisionId = 'dir-delegated';

const scope = (over: Partial<Scope> & Pick<Scope, 'id' | 'name'>): Scope => ({
  ghostId: null, paths: [], vaultPath: null, state: 'active', attachments: [], limits: {},
  createdAt: run.fixedNow - 7_200_000, updatedAt: run.fixedNow - 3_600_000, ...over,
});

const work = (over: Partial<Work> & Pick<Work, 'id' | 'title' | 'scopeId' | 'state'>): Work => ({
  attachments: [], slot: null, retry: null, parentId: null, rootId: over.id, ghostId: run.defaultGhostId,
  originConversationId: run.conversationA, conversationId: null,
  brief: '프로젝트 디렉터리 시험용으로 넣은 가짜 일입니다.',
  acceptance: { criteria: '끝내면 완료', checks: [], reviewer: null },
  revision: 1, revisionsUsed: 0, deadlineAt: null, budgetMinutes: 30, budgetUsedMs: 0, budgetSince: null,
  budgetExtended: false, hold: null, result: null, verdict: null, reason: null,
  createdAt: run.fixedNow - 3_600_000, startedAt: run.fixedNow - 3_500_000, endedAt: null,
  updatedAt: run.fixedNow - 1_800_000, ...over,
});

const decision = (over: Partial<Decision> & Pick<Decision, 'id' | 'title'>): Decision => ({
  kind: 'question', ghostId: run.defaultGhostId, conversationId: run.conversationA, workId: null, effectId: null,
  detail: '프로젝트 디렉터리 시험용으로 넣은 가짜 질문입니다.', options: [],
  proposal: null, state: 'pending', answer: null, createdAt: run.fixedNow - 1_500_000, resolvedAt: null, ...over,
});

function withDirectoryRows(state: State): State {
  return {
    ...state,
    scopes: [...state.scopes,
      // Shares the seeded default Ghost with 비행 기록: same receiver, different scope.
      scope({ id: equipmentScopeId, name: '관측 장비', ghostId: run.defaultGhostId, updatedAt: run.fixedNow - 2_000_000 }),
      // No works, no decisions, and a receiver id no Ghost has: it must not borrow a state or fall back to the main.
      scope({ id: emptyScopeId, name: '기록 보관소', ghostId: 'ghost-missing', updatedAt: run.fixedNow - 1_900_000 }),
      scope({ id: pausedScopeId, name: '오래된 구상', state: 'paused', updatedAt: run.fixedNow - 2_100_000 }),
    ],
    works: [...state.works,
      work({ id: liveWorkId, title: '장비 재고 정리와 견적 비교', scopeId: equipmentScopeId, state: 'running', updatedAt: run.fixedNow - 1_000_000 }),
      work({ id: settledWorkId, title: '비행 기록 등록 마무리', scopeId: run.scopeId, state: 'done', endedAt: run.fixedNow - 2_400_000, updatedAt: run.fixedNow - 2_400_000 }),
    ],
    decisions: [...state.decisions,
      decision({ id: oldestDecisionId, title: '비행 기록 보존 기간 정하기', createdAt: run.fixedNow - 3_000_000, proposal: { scopeId: run.scopeId } }),
      decision({ id: newerDecisionId, title: '기록 공유 범위 정하기', createdAt: run.fixedNow - 1_400_000, proposal: { scopeId: run.scopeId } }),
      // Handed to the main Ghost: never the owner's next step, so the live Work speaks for that project instead.
      decision({ id: delegatedDecisionId, title: '장비 구매 방법 검토하기', createdAt: run.fixedNow - 2_900_000,
        proposal: { scopeId: equipmentScopeId, review: { recommend: 'answer', answer: '비용 비교', expiresAt: null, delegatedAt: run.fixedNow - 500_000 } } }),
    ],
  };
}

async function openDirectory(page: Page, route: string) {
  await page.route('**/api/state', async routeHandler => {
    const response = await routeHandler.fetch();
    const state = await response.json() as State;
    await routeHandler.fulfill({ response, json: withDirectoryRows(state) });
  });
  await page.goto(`${run.baseUrl}/#${route}`);
  await expect(page.getByRole('main').getByRole('button', { name: '새 프로젝트', exact: true })).toBeVisible();
}

const rowOf = (page: Page, name: string) => page.locator('.project-directory > li').filter({ hasText: name });

test('directory offers each project its own next step and routes both destinations', async ({ page }) => {
  await openDirectory(page, '/scopes');

  // 비행 기록: oldest owner decision, not the newer one, and nothing from the scope it does not own.
  const flight = rowOf(page, '비행 기록');
  await expect(flight).toContainText('비행 기록 보존 기간 정하기');
  await expect(flight).not.toContainText('기록 공유 범위 정하기');
  await expect(flight).not.toContainText('장비 재고 정리와 견적 비교');
  await expect(flight).not.toContainText('회의 메모 요약');
  await expect(flight.locator('.project-directory__link')).toHaveAttribute('href', `#/inbox?decision=${oldestDecisionId}`);

  // 관측 장비: its delegated decision is not the owner's turn, so the live Work is the subject.
  const equipment = rowOf(page, '관측 장비');
  await expect(equipment).toContainText('장비 재고 정리와 견적 비교');
  await expect(equipment).not.toContainText('장비 구매 방법 검토하기');
  await expect(equipment.locator('.project-directory__link')).toHaveAttribute('href', `#/work/${liveWorkId}`);
  await expect(page.locator('.project-directory')).not.toContainText('기록 공유 범위 정하기');

  // An empty project invents no state; a missing explicit receiver is said, not swapped for the main.
  const empty = rowOf(page, '기록 보관소');
  await expect(empty.locator('.project-directory__next')).toHaveCount(0);
  await expect(empty.locator('.project-item__mark')).toHaveAttribute('data-idle', 'true');
  await expect(empty).toContainText('받을 Ghost 없음');
  await expect(rowOf(page, '오래된 구상')).toContainText('멈춤');

  // The subject is a link of its own, beside the project navigation, never inside it.
  await flight.locator('.project-directory__link').click();
  await expect(page).toHaveURL(`${run.baseUrl}/#/inbox?decision=${oldestDecisionId}`);
  await expect(page.getByText('비행 기록 보존 기간 정하기').first()).toBeVisible();
  await page.goto(`${run.baseUrl}/#/scopes`);

  await equipment.getByRole('button').click();
  await expect(page).toHaveURL(`${run.baseUrl}/#/scopes/${equipmentScopeId}`);
  const pulse = page.getByRole('region', { name: '이 프로젝트의 진행 상황' });
  await expect(pulse).toContainText('장비 재고 정리와 견적 비교');
  await pulse.getByRole('button', { name: /장비 재고 정리/ }).click();
  await expect(page).toHaveURL(`${run.baseUrl}/#/work/${liveWorkId}`);
  await expect(page.getByText('장비 재고 정리와 견적 비교').first()).toBeVisible();

  // The ledger inside the project stays its own: the other project's result never leaks in.
  await page.goto(`${run.baseUrl}/#/scopes/${equipmentScopeId}?view=work`);
  const workPage = page.locator('.project__page');
  await expect(workPage).toContainText('장비 재고 정리와 견적 비교');
  await expect(workPage).not.toContainText('비행 기록 등록 마무리');
});

test('the next step flows under the project name on a phone and nothing overflows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDirectory(page, '/scopes');

  const flight = rowOf(page, '비행 기록');
  const link = flight.locator('.project-directory__link');
  await expect(link).toBeVisible();
  const linkBox = (await link.boundingBox())!;
  const titleBox = (await flight.locator('.project-item__title').boundingBox())!;
  expect(linkBox.y).toBeGreaterThan(titleBox.y);
  await expect(link).toContainText('비행 기록 보존 기간 정하기');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
