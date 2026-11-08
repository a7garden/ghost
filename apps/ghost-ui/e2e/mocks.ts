import type { Page, Route } from '@playwright/test';
import type { Decision, VaultItem } from '@ghost/contract';
import { readRunState } from './run-state';

/** The synthetic decision ids the decision-surface screens focus. */
export const visualSecureDecisionId = 'visual-secure';
export const visualHandoffDecisionId = 'visual-handoff';

function vaultItems(): VaultItem[] {
  const { fixedNow, defaultGhostId, researchGhostId, scribeGhostId } = readRunState();
  const stamped = fixedNow - 3600_000;
  // A fixed calendar point: the row renders the absolute deletion time as text, so it must not drift per run.
  const oneTimeExpiry = Date.UTC(2026, 10, 9, 10, 30);
  return [
    { id: 'v-login', kind: 'login', title: '서비스 로그인', origin: 'https://app.example.com', username: 'owner@example.com',
      cardLast4: null, cardExpiry: null, contact: null, hints: '업무용 계정', ghostIds: [researchGhostId],
      hasPassword: true, hasTotp: true, expiresAt: null, createdAt: stamped, updatedAt: stamped },
    { id: 'v-card', kind: 'card', title: '업무 카드', origin: null, username: null,
      cardLast4: '4242', cardExpiry: '12/28', contact: null, hints: '구독 결제', ghostIds: [defaultGhostId],
      hasPassword: false, hasTotp: false, expiresAt: null, createdAt: stamped, updatedAt: stamped },
    { id: 'v-contact', kind: 'contact', title: '거래처 연락처', origin: null, username: null,
      cardLast4: null, cardExpiry: null, contact: { name: '김민수', phone: '010-1234-5678', email: 'minsu@example.com' },
      hints: '견적 문의', ghostIds: [], hasPassword: false, hasTotp: false, expiresAt: null, createdAt: stamped, updatedAt: stamped },
    { id: 'v-secret', kind: 'secret', title: '배포 API 키', origin: 'https://api.example.com', username: null,
      cardLast4: null, cardExpiry: null, contact: null, hints: '일회용', ghostIds: [scribeGhostId],
      hasPassword: false, hasTotp: false, expiresAt: oneTimeExpiry, createdAt: stamped, updatedAt: stamped },
  ];
}

/** The pending question decisions the visual suite injects: one secure form, one browser handoff. */
export function visualDecisions(): Decision[] {
  const { fixedNow, researchGhostId, scribeGhostId } = readRunState();
  return [
    { id: visualSecureDecisionId, kind: 'question', ghostId: researchGhostId, conversationId: 'conv-visual', workId: null, effectId: null,
      title: '서비스 로그인', detail: '로그인에 필요한 사용자 이름과 비밀번호를 금고에 요청합니다.', options: [],
      proposal: { secureForm: { kind: 'login', origin: 'https://app.example.com', title: '서비스 로그인', reason: '예약을 넣으려면 서비스에 로그인해야 합니다.' } },
      state: 'pending', answer: null, createdAt: fixedNow - 60_000, resolvedAt: null },
    { id: visualHandoffDecisionId, kind: 'question', ghostId: scribeGhostId, conversationId: 'conv-visual', workId: null, effectId: null,
      title: '구독 신청 화면', detail: '결제 화면은 소유자가 직접 확인하는 것이 안전합니다.', options: [],
      proposal: { browserHandoff: { url: 'https://subscribe.example.com/join', reason: '카드 정보를 넣는 화면이라 직접 확인이 필요합니다.' } },
      state: 'pending', answer: null, createdAt: fixedNow - 30_000, resolvedAt: null },
  ];
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Serves the vault item list so the 금고 settings screen renders without the host's vault routes. */
export async function mockVaultApi(page: Page): Promise<void> {
  const items = vaultItems();
  await page.route('**/api/vault/items', route => {
    if (route.request().method() === 'GET') void fulfillJson(route, 200, { items });
    else void route.continue();
  });
}

/** Adds synthetic decisions to the state snapshot; everything else stays the real seeded host. */
export async function mockStateDecisions(page: Page): Promise<void> {
  const decisions = visualDecisions();
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const state = await response.json() as { decisions: Decision[] };
    await fulfillJson(route, response.status(), { ...state, decisions: [...state.decisions, ...decisions] });
  });
}
