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
  const decision = page.locator('.decision');
  const first = decision.getByRole('button', { name: /안전하게 진행/ });
  await expect(first).toBeVisible();
  await expect(first).toBeInViewport();
  await first.click();
  await expect.poll(() => commands).toEqual([{ type: 'decision.resolve', decisionId: 'long-question', outcome: 'answer', answer: '안전하게 진행' }]);
  await page.reload();
  await decision.locator('summary').filter({ hasText: '직접 답하기' }).click();
  await decision.getByLabel('답변', { exact: true }).fill('이번에는 범위를 줄여 주세요');
  await decision.getByRole('button', { name: '답변 보내기' }).click();
  await expect.poll(() => commands.at(-1)).toEqual({ type: 'decision.resolve', decisionId: 'long-question', outcome: 'answer', answer: '이번에는 범위를 줄여 주세요' });
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.reload();
  await expect(first).toBeInViewport();
  const body = decision.locator('.decision__body');
  expect(await body.evaluate(element => element.clientHeight > 0 && element.scrollHeight > element.clientHeight)).toBe(true);
  const responseBounds = (await decision.locator('.decision__response').boundingBox())!;
  const cardBounds = (await decision.boundingBox())!;
  expect(responseBounds.y + responseBounds.height).toBeLessThanOrEqual(cardBounds.y + cardBounds.height);
  await expect(decision.locator('.decision__review-auto')).toBeInViewport();
  await expect(decision.locator('summary').filter({ hasText: '직접 답하기' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
