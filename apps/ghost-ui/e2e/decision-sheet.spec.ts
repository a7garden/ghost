import { expect, test } from '@playwright/test';
import type { Command, State } from '@ghost/contract';
import { readRunState } from './run-state';

// A response remains usable when the evidence is longer than the chat dock.
// The request under test is synthetic; no production decision is resolved.
test('docked decisions keep choices and direct answers reachable with long evidence', async ({ page }) => {
  const { baseUrl, defaultGhostId } = readRunState();
  const commands: Command[] = [];
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const state: State = await response.json();
    const ghost = state.ghosts.find(item => item.id === defaultGhostId)!;
    await route.fulfill({ response, json: { ...state, decisions: [{
      id: 'long-question', kind: 'question', ghostId: ghost.id, conversationId: ghost.directConversationId,
      workId: null, effectId: null, state: 'pending', title: '어느 방향으로 진행할까요?',
      detail: ('검토한 근거와 차이를 확인합니다.\n\n').repeat(30), options: ['안전하게 진행', '범위를 넓혀 진행', '일단 보류'],
      proposal: { review: { recommend: 'answer', answer: '안전하게 진행', expiresAt: Date.now() + 30 * 60_000 } },
      answer: null, createdAt: Date.now(), resolvedAt: null,
    }] } });
  });
  await page.route('**/api/commands', async route => {
    commands.push(route.request().postDataJSON().command);
    await route.fulfill({ json: { ok: true } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/ghosts/${defaultGhostId}`);
  // Compact folds the dock to one summary row; the deck unfolds on that single tap.
  const fold = page.locator('.chat-decisions__row');
  await expect(fold).toHaveText(/확인 필요 1건/);
  // The row's subject is the question itself; the count and deadline only qualify it.
  await expect(fold.locator('.chat-decisions__lead')).toHaveText('어느 방향으로 진행할까요?');
  expect(await fold.locator('.chat-decisions__lead').evaluate(el => parseFloat(getComputedStyle(el).fontSize)))
    .toBeGreaterThan(await fold.locator('.chat-decisions__count').evaluate(el => parseFloat(getComputedStyle(el).fontSize)));
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.decision')).toHaveCount(0);
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  const decision = page.locator('.decision');
  const first = decision.getByRole('button', { name: /안전하게 진행/ });
  await expect(first).toBeVisible();
  await expect(first).toBeInViewport();
  await first.click();
  await expect.poll(() => commands).toEqual([{ type: 'decision.resolve', decisionId: 'long-question', outcome: 'answer', answer: '안전하게 진행' }]);
  // A reload folds again: reviewing the deck is always one explicit tap away, never a state that approves.
  await page.reload();
  await expect(page.locator('.decision')).toHaveCount(0);
  await page.locator('.chat-decisions__row').click();
  await decision.locator('summary').filter({ hasText: '직접 답하기' }).click();
  await decision.getByLabel('답변', { exact: true }).fill('이번에는 범위를 줄여 주세요');
  await fold.click();
  await expect(decision.getByLabel('답변', { exact: true })).toBeHidden();
  await fold.click();
  await expect(decision.getByLabel('답변', { exact: true })).toHaveValue('이번에는 범위를 줄여 주세요');
  await decision.getByRole('button', { name: '답변 보내기' }).click();
  await expect.poll(() => commands.at(-1)).toEqual({ type: 'decision.resolve', decisionId: 'long-question', outcome: 'answer', answer: '이번에는 범위를 줄여 주세요' });
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.reload();
  // Desktop keeps the deck expanded, with no fold row at all.
  await expect(page.locator('.chat-decisions__row')).toHaveCount(0);
  await expect(first).toBeInViewport();
  const body = decision.locator('.decision__body');
  expect(await body.evaluate(element => element.clientHeight > 0 && element.scrollHeight > element.clientHeight)).toBe(true);
  const responseBounds = (await decision.locator('.decision__response').boundingBox())!;
  const cardBounds = (await decision.boundingBox())!;
  expect(cardBounds.height).toBeLessThanOrEqual(640 * .45 + 1);
  expect(responseBounds.y + responseBounds.height).toBeLessThanOrEqual(cardBounds.y + cardBounds.height);
  await expect(decision.locator('.decision__review-auto')).toBeInViewport();
  await expect(decision.locator('summary').filter({ hasText: '직접 답하기' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// The queue leaves the dock for the right editing margin only on a wide conversation; the deck is
// one DOM node that changes position, never multiplied, so the owner's open answer and its focus
// survive the wide → narrow → wide round trip. The request under test is synthetic.
test('wide chat stands the decision deck in the right margin without losing the draft', async ({ page }) => {
  const { baseUrl, defaultGhostId } = readRunState();
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const state: State = await response.json();
    const ghost = state.ghosts.find(item => item.id === defaultGhostId)!;
    await route.fulfill({ response, json: { ...state, decisions: [{
      id: 'long-question', kind: 'question', ghostId: ghost.id, conversationId: ghost.directConversationId,
      workId: null, effectId: null, state: 'pending', title: '어느 방향으로 진행할까요?',
      detail: ('검토한 근거와 차이를 확인합니다.\n\n').repeat(30), options: ['안전하게 진행', '범위를 넓혀 진행', '일단 보류'],
      proposal: { review: { recommend: 'answer', answer: '안전하게 진행', expiresAt: Date.now() + 30 * 60_000 } },
      answer: null, createdAt: Date.now(), resolvedAt: null,
    }] } });
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${baseUrl}/#/ghosts/${defaultGhostId}`);
  const deck = page.locator('.chat-decisions');
  const column = page.locator('.ghost-conversation__dock > .ghost-conversation__column');
  const transcriptColumn = page.locator('.ghost-conversation__transcript-content');
  const decision = page.locator('.decision');
  await expect(decision).toBeVisible();
  await expect(deck).toHaveCount(1);
  // The transcript and composer keep one left line; the deck stands clear of it, in the margin.
  await expect.poll(async () => {
    const dock = await column.boundingBox();
    const transcript = await transcriptColumn.boundingBox();
    return dock && transcript ? Math.round(dock.x - transcript.x) : Number.NaN;
  }).toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const card = await deck.boundingBox();
    const dock = await column.boundingBox();
    return card && dock ? Math.round(card.x - (dock.x + dock.width)) : Number.NaN;
  }).toBeGreaterThanOrEqual(-1);
  // The column keeps its clearance from the chat head and never widens the page.
  await expect.poll(async () => {
    const card = await deck.boundingBox();
    const bar = await page.locator('.chat-head').boundingBox();
    return card && bar ? Math.round(card.y - (bar.y + bar.height)) : Number.NaN;
  }).toBeGreaterThanOrEqual(-1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // An open answer keeps its text and focus through the resize round trip.
  await decision.locator('summary').filter({ hasText: '직접 답하기' }).click();
  const answer = decision.getByLabel('답변', { exact: true });
  const draft = '리사이즈한 뒤에도 이 답변이 그대로 남아 있어야 합니다';
  await answer.fill(draft);
  await expect(answer).toBeFocused();
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(deck).toHaveCount(1);
  await expect(answer).toHaveValue(draft);
  await expect(answer).toBeFocused();
  // Narrow docks the deck back above the composer, on the column's own line.
  await expect.poll(async () => {
    const card = await deck.boundingBox();
    const dock = await column.boundingBox();
    return card && dock ? Math.round(card.x - dock.x) : Number.NaN;
  }).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(answer).toHaveValue(draft);
  await expect(answer).toBeFocused();
  await expect.poll(async () => {
    const card = await deck.boundingBox();
    const dock = await column.boundingBox();
    return card && dock ? Math.round(card.x - (dock.x + dock.width)) : Number.NaN;
  }).toBeGreaterThanOrEqual(-1);
});
