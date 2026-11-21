import type { Page, Route } from '@playwright/test';
import type { CodingAgentsView, CodingSessionDetail, CodingSessionView, Decision, VaultItem } from '@ghost/contract';
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

/** The pending question decisions the visual suite injects, in the shape the real host writes. */
export function visualDecisions(): Decision[] {
  const { fixedNow, researchGhostId, scribeGhostId } = readRunState();
  return [
    { id: visualSecureDecisionId, kind: 'question', ghostId: researchGhostId, conversationId: 'conv-visual', workId: null, effectId: null,
      title: '서비스 로그인', detail: '예약을 넣으려면 서비스에 로그인해야 합니다.', options: [],
      proposal: { secureForm: { kind: 'login', origin: 'https://app.example.com', title: '서비스 로그인', reason: '예약을 넣으려면 서비스에 로그인해야 합니다.' } },
      state: 'pending', answer: null, createdAt: fixedNow - 60_000, resolvedAt: null },
    { id: visualHandoffDecisionId, kind: 'question', ghostId: scribeGhostId, conversationId: 'conv-visual', workId: null, effectId: null,
      title: 'Continue in the browser', detail: '카드 정보를 넣는 화면이라 직접 확인이 필요합니다.', options: ['Done'],
      proposal: { browserHandoff: { url: 'https://subscribe.example.com/join', reason: '카드 정보를 넣는 화면이라 직접 확인이 필요합니다.' } },
      state: 'pending', answer: null, createdAt: fixedNow - 30_000, resolvedAt: null },
  ];
}

const vaultKinds = ['login', 'card', 'contact', 'secret', 'api'] as const;

/**
 * The write-shape checks the real host applies before anything is stored. Returns the
 * rejection message or null; mock routes fulfill 400 with it so contract bugs fail tests.
 */
export function validateVaultWrite(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'invalid vault item fields';
  const write = input as Record<string, unknown>;
  if (!vaultKinds.includes(write.kind as typeof vaultKinds[number])) return 'invalid vault item kind';
  if (typeof write.title !== 'string' || !write.title.trim()) return 'invalid vault item metadata';
  if (write.save !== undefined && typeof write.save !== 'boolean') return 'secure form requires a save choice';
  if (typeof write.origin === 'string' && write.origin && !write.origin.startsWith('https://')) return 'invalid vault origin';
  if (write.card !== undefined) {
    const card = write.card as Record<string, unknown> | null;
    if (!card || typeof card !== 'object' || [card.number, card.expiry, card.cvc, card.name].some(part => typeof part !== 'string' || !part.length)) {
      return 'invalid vault card fields';
    }
  }
  return null;
}

/** Fulfills a vault write route the way the host would when the body breaks its contract. */
export async function fulfillValidatedVaultWrite(route: Route, ok: (input: Record<string, unknown>) => unknown): Promise<void> {
  const input = route.request().postDataJSON() as Record<string, unknown>;
  const invalid = validateVaultWrite(input);
  if (invalid) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'invalid', message: invalid } }) });
  return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(ok(input)) });
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

/** Serves a fixed set of coding agents and sessions so the 코딩 에이전트 screen does not depend on what the test Mac has installed or run. */
export async function mockCodingApi(page: Page): Promise<void> {
  const { fixedNow } = readRunState();
  const view: CodingAgentsView = {
    agents: [
      { id: 'omp', name: 'omp', path: '/Users/garden/.bun/bin/omp', version: 'omp/19.0.1', ready: true, note: null },
      { id: 'claude', name: 'Claude Code', path: '/Users/garden/.local/bin/claude', version: '2.1.319 (Claude Code)', ready: true, note: '로그인이 2026. 11. 24.까지 유효합니다.' },
      { id: 'codex', name: 'Codex', path: '/Users/garden/.local/bin/codex', version: 'codex-cli 0.167.0', ready: false, note: '로그인이 필요합니다(codex login).' },
    ],
    default: null,
    disabled: [],
  };
  const fixed: CodingSessionView = {
    id: 'a1'.repeat(16), agent: 'omp', workId: 'visual-work', callId: 'call-1', task: '로그인 실패 시 안내 문구 고치기\n오류 문구가 비어 있습니다.',
    cwd: '/Users/garden/Workspace/Projects/wt/app-fix-login', branch: 'ghost/fix-login', nativeId: '01a1fce5-08b9',
    resumeCommand: "cd '/Users/garden/Workspace/Projects/wt/app-fix-login' && omp --resume 01a1fce5-08b9",
    // The dialog prints the start as an absolute time, so it is a fixed calendar point; the list's relative times come from `endedAt`.
    startedAt: Date.UTC(2026, 10, 21, 6, 10), endedAt: fixedNow - 3_300_000, state: 'done', exitCode: 0,
  };
  const sessions: CodingSessionView[] = [
    { ...fixed, id: 'b2'.repeat(16), agent: 'claude', task: '결제 화면 테스트 추가', branch: 'ghost/checkout-tests', nativeId: null, resumeCommand: null, startedAt: fixedNow - 600_000, endedAt: null, state: 'running', exitCode: null },
    fixed,
  ];
  const detail: CodingSessionDetail = {
    session: fixed,
    steps: [
      { at: fixedNow - 3_590_000, kind: 'say', text: '로그인 화면의 오류 처리부터 읽어 보겠습니다.' },
      { at: fixedNow - 3_580_000, kind: 'tool', text: 'grep: 오류 문구' },
      { at: fixedNow - 3_570_000, kind: 'result', text: 'src/login.ts:41: const message = ""' },
      { at: fixedNow - 3_400_000, kind: 'say', text: '빈 문구를 기본 안내로 바꾸고 테스트를 통과시켰습니다.' },
    ],
    next: 4,
  };
  await page.route('**/api/coding-agents*', route => void fulfillJson(route, 200, view));
  await page.route(/\/api\/coding-sessions$/, route => void fulfillJson(route, 200, { sessions }));
  await page.route(/\/api\/coding-sessions\/[0-9a-f]{32}(\?.*)?$/, route => void fulfillJson(route, 200, detail));
}

/** Adds synthetic decisions to the state snapshot; everything else stays the real seeded host. */
export async function mockStateDecisions(page: Page, liveHandoff = false): Promise<void> {
  const decisions = visualDecisions().map(decision => decision.id === visualHandoffDecisionId && decision.proposal?.browserHandoff && liveHandoff
    ? { ...decision, proposal: { ...decision.proposal, browserHandoff: { ...decision.proposal.browserHandoff, live: true } } }
    : decision);
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const state = await response.json() as { decisions: Decision[] };
    await fulfillJson(route, response.status(), { ...state, decisions: [...state.decisions, ...decisions] });
  });
}
