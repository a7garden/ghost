import type { Page, Route } from '@playwright/test';
import type { CodingPrefs, CodingSetup, CodingStart, Decision, HerdrIntegrationInstall, HerdrKeys, HerdrOutput, HerdrPrompt, HerdrView, VaultItem } from '@ghost/contract';
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

export const visualCodingIds = { finished: 'w79:pA', running: 'w79:pB', blocked: 'w80:pA', started: 'w81:pA' };

/** Coding requests use a page-local herdr session; other API calls go to the seeded Host. */
export async function mockCodingApi(page: Page, { stopped = false }: { stopped?: boolean } = {}): Promise<void> {
  const server = { version: '1.4.0', compatible: true, restartNeeded: false };
  const setup: CodingSetup = {
    herdr: { path: '/Users/garden/.local/bin/herdr', version: '1.4.0' },
    config: { ok: true, note: null },
    session: 'default',
    sessions: [{ name: 'default', running: !stopped }, { name: 'studio', running: true }, { name: 'archive', running: false }],
    server: stopped ? null : server,
    agents: [
      { id: 'omp', name: 'omp', path: '/Users/garden/.bun/bin/omp', integration: 'current' },
      { id: 'claude', name: 'Claude Code', path: '/Users/garden/.local/bin/claude', integration: 'outdated' },
      { id: 'codex', name: 'Codex', path: null, integration: 'missing' },
    ],
    prefs: { session: null, agent: 'claude' },
  };
  const entries = new Map<string, HerdrOutput>();
  for (const output of [
    {
      pane: { id: visualCodingIds.running, workspace: 'app', tab: 'checkout', agent: 'Claude Code', status: 'working',
        cwd: '/Users/garden/Workspace/Projects/wt/app-checkout-tests', title: '결제 화면 테스트 추가' },
      text: [
        '❯ 결제 화면 테스트를 추가해 주세요.',
        '',
        '● 기존 결제 테스트와 모의 응답을 확인하겠습니다.',
        '  $ rg --files src/checkout',
        '  src/checkout/payment.ts',
        '  src/checkout/payment.test.ts',
        '  src/checkout/fixtures.ts',
        '',
        '● 카드 승인과 거절에 쓰는 응답을 찾았습니다.',
        '  거절된 경우 결제 버튼이 다시 활성화되는지도 확인하겠습니다.',
      ].join('\n'),
    },
    {
      pane: { id: visualCodingIds.finished, workspace: 'app', tab: 'login', agent: 'omp', status: 'done',
        cwd: '/Users/garden/Workspace/Projects/wt/app-fix-login', title: '로그인 실패 시 안내 문구 고치기' },
      text: [
        '❯ 로그인 실패 시 안내 문구를 고쳐 주세요.',
        '',
        '● 오류 문구가 비어 있으면 기본 안내를 표시하도록 바꿨습니다.',
        '  const message = error.message || fallback;',
        '',
        '  $ bun test src/login.test.ts',
        '  3 pass · 0 fail',
        '',
        '<b>터미널 텍스트</b>',
        '❯',
      ].join('\n'),
    },
    {
      pane: { id: visualCodingIds.blocked, workspace: 'ghost', tab: 'settings', agent: 'Claude Code', status: 'blocked',
        cwd: '/Users/garden/Workspace/Projects/ghost', title: '설정 화면 키보드 탐색 확인' },
      text: [
        '❯ 설정 화면에서 키보드로 탭을 옮길 수 있는지 확인해 주세요.',
        '',
        '  Bash command',
        '    bun test src/ui/settings.test.tsx',
        '',
        '  Do you want to proceed?',
        '  ❯ 1. Yes',
        '    2. Yes, and don’t ask again',
        '    3. No',
      ].join('\n'),
    },
  ] satisfies HerdrOutput[]) entries.set(output.pane.id, output);

  const error = (route: Route, status: number, message: string) =>
    fulfillJson(route, status, { error: { code: status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'invalid', message } });
  await page.route('**/api/coding', route => fulfillJson(route, 200, setup));
  await page.route('**/api/coding/integrations', route => {
    const { agent } = route.request().postDataJSON() as HerdrIntegrationInstall;
    const item = setup.agents.find(item => item.id === agent);
    if (!item?.path) return error(route, 400, '에이전트가 설치되어 있지 않습니다.');
    item.integration = 'current';
    return fulfillJson(route, 200, setup);
  });
  await page.route('**/api/commands', route => {
    const { command } = route.request().postDataJSON() as { command: { type: string } & CodingPrefs };
    if (command.type !== 'coding.set') return route.fallback();
    setup.prefs = { session: command.session, agent: command.agent };
    setup.session = command.session ?? 'default';
    setup.server = setup.sessions.find(session => session.name === setup.session)?.running ? server : null;
    return fulfillJson(route, 200, { ok: true, result: {} });
  });

  await page.route('**/api/herdr', route => fulfillJson(route, 200, {
    available: true, session: setup.session, note: setup.server ? null : 'herdr 서버가 실행 중이 아닙니다.',
    panes: setup.server ? Array.from(entries.values(), entry => entry.pane) : [],
  } satisfies HerdrView));
  await page.route('**/api/herdr/output?*', route => {
    const pane = new URL(route.request().url()).searchParams.get('pane');
    const entry = entries.get(pane ?? '');
    return setup.server && entry ? fulfillJson(route, 200, entry) : error(route, 404, '패널을 찾을 수 없습니다.');
  });
  await page.route('**/api/herdr/start', route => {
    const input = route.request().postDataJSON() as CodingStart;
    if (!input.repo.startsWith('/') || input.repo === '/missing') return error(route, 400, '저장소 경로를 찾을 수 없습니다.');
    const pane: HerdrOutput['pane'] = {
      id: visualCodingIds.started, agent: setup.agents.find(item => item.id === (input.agent ?? setup.prefs.agent))?.name ?? 'omp',
      title: input.task.split('\n')[0]!, workspace: input.branch ?? '비행 기록', tab: 'main', cwd: input.repo, status: 'working',
    };
    entries.set(pane.id, { pane, text: `❯ ${input.task}` });
    return fulfillJson(route, 200, pane);
  });
  await page.route('**/api/herdr/prompt', route => {
    const { pane, text } = route.request().postDataJSON() as HerdrPrompt;
    const entry = entries.get(pane);
    if (!entry) return error(route, 404, '패널을 찾을 수 없습니다.');
    if (entry.pane.status === 'blocked') return error(route, 409, '승인에 먼저 답하세요.');
    entry.text += `\n❯ ${text}\n\n● 실패 응답도 확인하겠습니다.`;
    entry.pane.status = 'working';
    return fulfillJson(route, 200, entry.pane);
  });
  await page.route('**/api/herdr/keys', route => {
    const { pane, keys } = route.request().postDataJSON() as HerdrKeys;
    const entry = entries.get(pane);
    if (!entry) return error(route, 404, '패널을 찾을 수 없습니다.');
    if (keys.includes('esc')) {
      entry.text += '\n\nInterrupted (Esc)';
      entry.pane.status = 'idle';
    } else if (keys.includes('enter')) {
      entry.text += '\n\n● Running tests…';
      entry.pane.status = 'working';
    }
    return fulfillJson(route, 200, entry.pane);
  });
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
