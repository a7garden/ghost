import type { Page, Route } from '@playwright/test';
import type { CodingPrefs, CodingSetup, Decision, HerdrAgentStart, HerdrChanges, HerdrClose, HerdrDiff, HerdrFrame, HerdrInput, HerdrIntegrationInstall, HerdrOutput, HerdrPaneView, HerdrPrompt, HerdrRename, HerdrSplit, HerdrTabCreate, HerdrUpload, HerdrView, HerdrWorkspaceCreate, HerdrWorkspaceView, OmpInfo, VaultItem } from '@ghost/contract';
import type { HerdrAnswer, HerdrAsk, HerdrChat, HerdrChatItem, HerdrControlCommand, HerdrControlEnd, HerdrControlLease, HerdrControlRelease } from '@ghost/contract';
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

export const visualCodingIds = { finished: 'w79:pA', running: 'w79:pB', blocked: 'w80:pA', shell: 'w79:pC', started: 'w81:p81' };

const checkoutChanges: HerdrChanges = {
  git: true, branch: 'fix/login-message', base: '0b147e38b47cd99dec7c90e80ed060f58d801db4', truncated: false,
  commits: [{ sha: '8dc27e1a1443baa8ec1deb7326a6d300c2f6d813', subject: 'Show a fallback on login errors' }],
  files: [
    { path: 'src/auth/login.ts', status: 'modified', additions: 2, deletions: 1 },
    { path: 'src/auth/login.test.ts', status: 'untracked', additions: 17, deletions: 0 },
    { path: 'src/auth/legacy.ts', status: 'deleted', additions: 0, deletions: 6 },
  ],
};
const loginDiff = [
  'diff --git a/src/auth/login.ts b/src/auth/login.ts',
  'index 0b147e3..8dc27e1 100644',
  '--- a/src/auth/login.ts',
  '+++ b/src/auth/login.ts',
  '@@ -18,4 +18,5 @@ export function login() {',
  '   if (!response.ok) {',
  '-    return showError(error.message);',
  '+    const message = error.message || \"로그인할 수 없습니다. 다시 시도해 주세요.\";',
  '+    return showError(message);',
  '   }',
  ' }',
].join('\n');

const ompModels: OmpInfo['models'] = [
  { selector: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic', thinking: ['low', 'medium', 'high'] },
  { selector: 'zai/glm-5.1', name: 'GLM 5.1', provider: 'Z.AI', thinking: ['low', 'high'] },
  { selector: 'local/qwen3', name: 'Qwen3', provider: 'Local', thinking: [] },
];

function colourTerminal(text: string) {
  const colors = [36, 0, 32, 0, 33];
  return text.split('\n').map((line, index) => `\x1b[${colors[index % colors.length]}m${line}\x1b[0m`).join('\n');
}

function herdrFrame(text: string, width: number, height: number, seq: number, tracksMouse: boolean, padded = false): HerdrFrame {
  const colors = [36, 0, 32, 0, 33];
  const lines = text.split('\n').slice(-height);
  const body = lines.map((line, index) => `\x1b[${colors[index % colors.length]}m${padded ? line.padEnd(width) : line}\x1b[0m`).join('\r\n');
  const mouse = tracksMouse ? '\x1b[?1000h\x1b[?1006h' : '';
  const bytes = Buffer.from(`\x1b[?25l\x1b[2J\x1b[H\x1b[?2004h${mouse}${body}\x1b[?25h`).toString('base64');
  return { seq, full: true, bytes, width, height };
}

export function fulfillHerdrFrame(route: Route, text: string, { end = false, tracksMouse = false, padded = false, lease, reason, drop = false }: {
  end?: boolean; tracksMouse?: boolean; padded?: boolean; lease?: HerdrControlLease; reason?: HerdrControlEnd['reason']; drop?: boolean;
} = {}) {
  const url = new URL(route.request().url());
  const frame = herdrFrame(text, Number(url.searchParams.get('cols')), Number(url.searchParams.get('rows')), 1, tracksMouse, padded);
  const leased = lease ? `event: lease\r\ndata: ${JSON.stringify(lease)}\r\n\r\n` : '';
  const ended = reason ? `event: end\r\ndata: ${JSON.stringify({ reason })}\r\n\r\n` : end ? 'event: end\r\n\r\n' : '';
  return route.fulfill({
    status: 200, contentType: 'text/event-stream',
    headers: drop ? { 'x-mock-drop': '1' } : undefined,
    body: `${leased}event: frame\r\ndata: ${JSON.stringify(frame)}\r\n\r\n${ended}`,
  });
}

/** Coding requests use a page-local herdr session; other API calls go to the seeded Host. */
export async function mockCodingApi(page: Page, { stopped = false, rich = false, owned = [], held = [], mouse = [] }: {
  stopped?: boolean; rich?: boolean; owned?: readonly string[]; held?: readonly string[]; mouse?: readonly string[];
} = {}): Promise<void> {
  // Playwright fulfills a finite body. Keep successful mock leases open until the caller cancels.
  await page.addInitScript(() => {
    const fetchHost = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await fetchHost(input, init);
      if (new URL(response.url || location.href).pathname !== '/api/herdr/control' || !response.ok || !response.body || response.headers.has('x-mock-drop')) return response;
      const reader = response.body.getReader();
      const signal = init?.signal;
      const pane = new URL(response.url).searchParams.get('pane');
      const encoder = new TextEncoder();
      let detach = () => {};
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const frame = (event: Event) => {
            const update = (event as CustomEvent<{ pane: string; frame: HerdrFrame }>).detail;
            if (update.pane === pane) controller.enqueue(encoder.encode(`event: frame\ndata: ${JSON.stringify(update.frame)}\n\n`));
          };
          const abort = () => { detach(); controller.error(signal?.reason); };
          detach = () => {
            window.removeEventListener('ghost-test:herdr-frame', frame);
            signal?.removeEventListener('abort', abort);
          };
          window.addEventListener('ghost-test:herdr-frame', frame);
          signal?.addEventListener('abort', abort, { once: true });
        },
        async pull(controller) {
          const item = await reader.read();
          if (!item.done && !signal?.aborted) controller.enqueue(item.value);
        },
        cancel: reason => {
          detach();
          return reader.cancel(reason);
        },
      }), { status: response.status, headers: response.headers });
    };
  });
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
    kinds: ['omp', 'claude', 'pi', 'gemini'],
    prefs: { session: null, agent: 'claude', notify: 'blocked' },
  };
  const entries = new Map<string, HerdrOutput>();
  for (const output of [
    {
      pane: { id: visualCodingIds.running, workspaceId: 'w79', tabId: 'w79:tB', workspace: 'app', tab: 'checkout', agent: 'Claude Code',
        status: 'working', owned: owned.includes(visualCodingIds.running), focused: true, cwd: '/Users/garden/Workspace/Projects/wt/app-checkout-tests', title: '결제 화면 테스트 추가' },
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
      pane: { id: visualCodingIds.finished, workspaceId: 'w79', tabId: 'w79:tA', workspace: 'app', tab: 'login', agent: 'omp',
        status: 'done', owned: owned.includes(visualCodingIds.finished), focused: false, cwd: '/Users/garden/Workspace/Projects/wt/app-fix-login', title: '로그인 실패 시 안내 문구 고치기' },
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
      pane: { id: visualCodingIds.blocked, workspaceId: 'w80', tabId: 'w80:tA', workspace: 'ghost', tab: 'settings', agent: 'Claude Code',
        status: 'blocked', owned: owned.includes(visualCodingIds.blocked), focused: true, cwd: '/Users/garden/Workspace/Projects/ghost', title: '설정 화면 키보드 탐색 확인' },
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
    {
      pane: { id: visualCodingIds.shell, workspaceId: 'w79', tabId: 'w79:tB', workspace: 'app', tab: 'checkout', agent: null,
        status: 'unknown', owned: owned.includes(visualCodingIds.shell), focused: false, cwd: '/Users/garden/Workspace/Projects/app', title: 'zsh' },
      text: 'app % git status --short\n M src/checkout/payment.ts\n?? src/checkout/payment.test.ts\n\napp %',
    },
  ] satisfies HerdrOutput[]) entries.set(output.pane.id, output);
  const now = readRunState().fixedNow;
  const initialChats = new Map<string, HerdrChatItem[]>([
    [visualCodingIds.running, [
      { id: 'run-u1', kind: 'user', at: now - 140_000, text: '카드 결제 화면에 승인·거절 테스트를 추가해 주세요.' },
      { id: 'run-t1', kind: 'thinking', at: now - 135_000 },
      { id: 'run-t2', kind: 'tool', at: now - 128_000, name: 'grep', summary: '결제 테스트와 모의 응답 찾기', ok: true },
      { id: 'run-a1', kind: 'agent', at: now - 118_000, text: '기존 결제 테스트에서 카드사의 **승인·거절 응답**을 찾았습니다. 거절 뒤에 결제 버튼이 다시 활성화되는지도 확인하겠습니다.' },
      { id: 'run-t3', kind: 'tool', at: now - 104_000, name: 'edit', summary: 'src/checkout/payment.test.ts', ok: null },
    ]],
    [visualCodingIds.finished, [
      { id: 'done-note', kind: 'note', at: now - 560_000, text: 'fix/login-message' },
      { id: 'done-u1', kind: 'user', at: now - 520_000, text: '로그인 실패 시 안내 문구를 고쳐 주세요.' },
      { id: 'done-t1', kind: 'thinking', at: now - 515_000 },
      { id: 'done-t2', kind: 'tool', at: now - 456_000, name: 'edit', summary: 'src/auth/login.ts', ok: true },
      { id: 'done-t3', kind: 'tool', at: now - 389_000, name: 'bash', summary: 'bun test src/auth/login.test.ts', ok: true },
      { id: 'done-a1', kind: 'agent', at: now - 325_000, text: '오류 문구가 비어 있으면 **기본 안내 문구**를 표시하도록 바꿨습니다.\n\n- 안내: “로그인할 수 없습니다. 다시 시도해 주세요.”\n- 테스트 3개 통과' },
    ]],
    [visualCodingIds.blocked, [
      { id: 'ask-u1', kind: 'user', at: now - 60_000, text: '설정 화면에서 키보드로 탭을 이동할 수 있는지 확인해 주세요.' },
      { id: 'ask-t1', kind: 'tool', at: now - 32_000, name: 'read', summary: 'src/ui/settings.test.tsx', ok: true },
      { id: 'ask-a1', kind: 'agent', at: now - 22_000, text: '**탭 순서와 초점 표시**를 검증하는 테스트가 있습니다. 기존 테스트를 실행해 확인하겠습니다.' },
    ]],
  ]);
  const question: HerdrAsk = {
    pane: visualCodingIds.blocked, kind: 'approval', title: '설정 테스트를 실행할까요?', detail: 'bun test src/ui/settings.test.tsx',
    choices: [
      { index: 0, label: '이번만 실행', tone: 'approve' },
      { index: 1, label: '이 세션에서 항상 허용', tone: 'trust' },
      { index: 2, label: '실행하지 않기', tone: 'deny' },
    ], selected: 0,
  };
  const spaces = new Map<string, Pick<HerdrWorkspaceView, 'label' | 'worktree'>>([
    ['w79', { label: 'app', worktree: null }],
    ['w80', { label: 'ghost', worktree: { path: '/Projects/wt/ghost-settings', branch: 'fix/settings-navigation' } }],
  ]);
  let sequence = 81;
  let approval = 1;
  const agentLabel = (id?: string) => setup.agents.find(item => item.id === id)?.name ?? (id === 'pi' ? 'Pi' : id ?? null);
  function addPane({ workspaceId, tabId, cwd, title, tab, agent, task }: {
    workspaceId: string; tabId: string; cwd: string | null; tab: string; title?: string; agent?: string; task?: string;
  }): HerdrPaneView {
    const id = `${workspaceId}:p${sequence++}`;
    const pane = {
      id, tabId, workspaceId, cwd, tab, workspace: spaces.get(workspaceId)!.label,
      title: title || task?.split('\n')[0] || (agent ? agentLabel(agent)! : 'zsh'),
      agent: agentLabel(agent), status: agent ? 'working' : 'unknown', owned: true, focused: true,
    } satisfies HerdrPaneView;
    entries.set(id, { pane, text: task ? `❯ ${task}` : agent ? `${pane.agent} ready` : 'zsh %' });
    return pane;
  }
  function overview(): HerdrView {
    const workspaces: HerdrWorkspaceView[] = [];
    if (setup.server) for (const [id, space] of spaces) {
      const tabs = new Map<string, HerdrWorkspaceView['tabs'][number]>();
      for (const { pane } of entries.values()) {
        if (pane.workspaceId !== id) continue;
        const tab = tabs.get(pane.tabId);
        if (tab) tab.panes.push(pane);
        else tabs.set(pane.tabId, { id: pane.tabId, label: pane.tab, status: pane.status, panes: [pane] });
      }
      const groups = [...tabs.values()];
      workspaces.push({ id, ...space, status: groups.some(tab => tab.status === 'blocked') ? 'blocked' : groups[0]?.status ?? 'unknown', tabs: groups });
    }
    return { available: true, session: setup.session, note: setup.server ? null : 'herdr 서버가 실행 중이 아닙니다.', workspaces };
  }

  const error = (route: Route, status: number, message: string) =>
    fulfillJson(route, status, { error: { code: status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'invalid', message } });
  await page.route('**/api/coding', route => fulfillJson(route, 200, setup));
  await page.route('**/api/coding/omp?*', route => {
    const cwd = new URL(route.request().url()).searchParams.get('cwd');
    const { fixedNow } = readRunState();
    return fulfillJson(route, 200, {
      models: ompModels, sessions: cwd === '/Projects/app' ? [
        { id: 'omp-login-session', title: '로그인 실패 테스트', updatedAt: fixedNow - 15_000 },
        { id: 'omp-checkout-session', title: '결제 화면 점검', updatedAt: fixedNow - 300_000 },
      ] : [],
    } satisfies OmpInfo);
  });
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
    if (!['off', 'blocked', 'all'].includes(command.notify)) return error(route, 400, '알림 값을 확인하세요.');
    setup.prefs = { session: command.session, agent: command.agent, notify: command.notify };
    setup.session = command.session ?? 'default';
    setup.server = setup.sessions.find(session => session.name === setup.session)?.running ? server : null;
    return fulfillJson(route, 200, { ok: true, result: {} });
  });

  await page.route('**/api/herdr', route => fulfillJson(route, 200, overview()));
  await page.route('**/api/herdr/ask?*', route => {
    const pane = new URL(route.request().url()).searchParams.get('pane') ?? '';
    return fulfillJson(route, 200, rich && pane === question.pane && entries.get(pane)?.pane.status === 'blocked' ? question : null);
  });
  await page.route('**/api/herdr/answer', route => {
    const { pane, index, title } = route.request().postDataJSON() as HerdrAnswer;
    const entry = entries.get(pane);
    if (!rich || entry?.pane.status !== 'blocked' || pane !== question.pane || title !== question.title || !question.choices[index]) {
      return error(route, 409, '질문이 바뀌었습니다.');
    }
    entry.pane.status = index === 2 ? 'idle' : 'working';
    return fulfillJson(route, 200, entry.pane);
  });
  await page.route('**/api/herdr/chat?*', route => {
    const query = new URL(route.request().url()).searchParams;
    const pane = query.get('pane') ?? '';
    const items = rich ? initialChats.get(pane) : undefined;
    const after = Number(query.get('after') ?? 0);
    const source = items ? pane === visualCodingIds.finished ? 'omp' : 'claude' : null;
    return fulfillJson(route, 200, { pane, source, items: items?.slice(after) ?? [], title: null, cursor: String(items?.length ?? 0), reset: !after } satisfies HerdrChat);
  });
  await page.route('**/api/herdr/terminal?*', route => {
    const id = new URL(route.request().url()).searchParams.get('pane');
    const entry = id ? entries.get(id) : undefined;
    if (!setup.server || !entry) return error(route, 404, '패널을 찾을 수 없습니다.');
    const text = id === visualCodingIds.blocked && entry.pane.status === 'blocked' && approval > 1
      ? entry.text.replace('❯ 1.', '  1.').replace(`  ${approval}.`, `❯ ${approval}.`) : entry.text;
    if (rich && id === visualCodingIds.shell) {
      const log = Array.from({ length: 42 }, (_, index) => `  checkout: verified shard ${String(index + 1).padStart(2, '0')}`).join('\n');
      return fulfillHerdrFrame(route, `${log}\n${text}`);
    }
    return fulfillHerdrFrame(route, text);
  });
  let lease: HerdrControlLease | undefined;
  let leaseSequence = 0;
  let controlSize = { cols: 80, rows: 24, seq: 1 };
  await page.route('**/api/herdr/control?*', route => {
    const query = new URL(route.request().url()).searchParams;
    const pane = query.get('pane') ?? '';
    const entry = entries.get(pane);
    if (!setup.server || !entry) return error(route, 404, '패널을 찾을 수 없습니다.');
    if (!entry.pane.owned && query.get('fit') !== '1') {
      return fulfillJson(route, 409, { error: { code: 'confirm_required', message: '크기 변경을 확인하세요.' } });
    }
    if (held.includes(pane) && query.get('takeover') !== '1' && !lease) {
      return fulfillJson(route, 409, { error: { code: 'held', message: '다른 곳에서 쓰는 중입니다.' } });
    }
    if (lease && lease.pane !== pane) return fulfillJson(route, 409, { error: { code: 'held', message: '기존 제어가 끝나지 않았습니다.' } });
    lease = { pane, owned: entry.pane.owned, baseline: { cols: 100, rows: 40 }, leaseId: `00000000-0000-4000-8000-${String(++leaseSequence).padStart(12, '0')}` };
    controlSize = { cols: Number(query.get('cols')), rows: Number(query.get('rows')), seq: 1 };
    const text = rich && pane === visualCodingIds.shell
      ? `${Array.from({ length: 42 }, (_, index) => `  checkout: verified shard ${String(index + 1).padStart(2, '0')}`).join('\n')}\n${entry.text}`
      : entry.text;
    return fulfillHerdrFrame(route, text, { lease, tracksMouse: mouse.includes(pane) });
  });
  await page.route('**/api/herdr/control/send', async route => {
    const command = route.request().postDataJSON() as HerdrControlCommand;
    if (lease?.leaseId !== command.leaseId || lease?.pane !== command.pane) {
      return fulfillJson(route, 409, { error: { code: 'held', message: '이 제어가 끝났습니다.' } });
    }
    const entry = entries.get(command.pane);
    if (entry && (command.type === 'resize' || (command.type === 'input' && applyInput(entry, [], command.text)))) {
      if (command.type === 'resize') controlSize = { cols: command.cols, rows: command.rows, seq: controlSize.seq };
      const frame = herdrFrame(entry.text, controlSize.cols, controlSize.rows, ++controlSize.seq, mouse.includes(command.pane));
      await page.evaluate(detail => { window.dispatchEvent(new CustomEvent('ghost-test:herdr-frame', { detail })); }, { pane: command.pane, frame });
    }
    return fulfillJson(route, 200, { ok: true });
  });
  await page.route('**/api/herdr/control/release', route => {
    const release = route.request().postDataJSON() as HerdrControlRelease;
    if (lease?.leaseId === release.leaseId && lease.pane === release.pane) lease = undefined;
    return fulfillJson(route, 200, { ok: true });
  });
  await page.route('**/api/herdr/output?*', route => {
    const query = new URL(route.request().url()).searchParams;
    const entry = entries.get(query.get('pane') ?? '');
    if (!setup.server || !entry) return error(route, 404, '패널을 찾을 수 없습니다.');
    if (query.get('format') !== 'ansi') return fulfillJson(route, 200, entry);
    const text = rich && entry.pane.id === visualCodingIds.finished
      ? `${Array.from({ length: 60 }, (_, index) => `  실행 로그 · ${String(index + 1).padStart(2, '0')}`).join('\n')}\n${entry.text}` : entry.text;
    return fulfillJson(route, 200, { ...entry, text: colourTerminal(text) });
  });
  await page.route('**/api/herdr/changes?*', route => {
    const pane = new URL(route.request().url()).searchParams.get('pane');
    return fulfillJson(route, 200, pane === visualCodingIds.finished ? checkoutChanges : {
      git: false, branch: null, base: null, commits: [], files: [], truncated: false,
    } satisfies HerdrChanges);
  });
  await page.route('**/api/herdr/diff?*', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (!path || !checkoutChanges.files.some(file => file.path === path)) return error(route, 404, '파일을 찾을 수 없습니다.');
    return fulfillJson(route, 200, { path, diff: path === 'src/auth/login.ts' ? loginDiff : '', truncated: false } satisfies HerdrDiff);
  });
  await page.route('**/api/herdr/upload?*', route => {
    const file = route.request().postDataBuffer();
    const name = new URL(route.request().url()).searchParams.get('name') ?? 'file';
    if (!file?.length) return error(route, 400, '빈 파일은 첨부할 수 없습니다.');
    return fulfillJson(route, 200, { name, path: `/Ghost/uploads/a1b2c3d4-${name}`, size: file.length } satisfies HerdrUpload);
  });
  await page.route('**/api/herdr/workspaces', route => {
    const { cwd, label, branch, worktree, agent, task } = route.request().postDataJSON() as HerdrWorkspaceCreate;
    if (!cwd.startsWith('/') || cwd === '/missing') return error(route, 400, '디렉터리를 찾을 수 없습니다.');
    const workspaceId = `w${sequence}`;
    spaces.set(workspaceId, { label: label ?? '비행 기록', worktree: worktree ? { path: cwd, branch: branch ?? null } : null });
    const pane = addPane({ workspaceId, tabId: `${workspaceId}:tA`, cwd, tab: 'main', agent, task });
    return fulfillJson(route, 200, pane);
  });
  await page.route('**/api/herdr/tabs', route => {
    const { workspace: workspaceId, label, cwd, agent, task } = route.request().postDataJSON() as HerdrTabCreate;
    if (!spaces.has(workspaceId)) return error(route, 404, '스페이스를 찾을 수 없습니다.');
    const pane = addPane({ workspaceId, tabId: `${workspaceId}:t${sequence}`, cwd: cwd ?? '/Projects/app', tab: label ?? 'shell', agent, task });
    return fulfillJson(route, 200, pane);
  });
  await page.route('**/api/herdr/split', route => {
    const { pane: id, agent, task } = route.request().postDataJSON() as HerdrSplit;
    const original = entries.get(id)?.pane;
    if (!original) return error(route, 404, '패널을 찾을 수 없습니다.');
    const pane = addPane({ workspaceId: original.workspaceId, tabId: original.tabId, cwd: original.cwd, tab: original.tab, agent, task });
    return fulfillJson(route, 200, pane);
  });
  await page.route('**/api/herdr/agents', route => {
    const { pane: id, agent, task } = route.request().postDataJSON() as HerdrAgentStart;
    const entry = entries.get(id);
    if (!entry) return error(route, 404, '패널을 찾을 수 없습니다.');
    if (entry.pane.agent) return error(route, 409, '셸에서만 에이전트를 시작할 수 있습니다.');
    entry.pane.agent = agentLabel(agent);
    entry.pane.status = task ? 'working' : 'idle';
    entry.text = task ? `❯ ${task}` : `${entry.pane.agent} ready`;
    return fulfillJson(route, 200, entry.pane);
  });
  await page.route('**/api/herdr/rename', route => {
    const { target, id, label } = route.request().postDataJSON() as HerdrRename;
    const space = spaces.get(id);
    if (target === 'workspace' && space) space.label = label;
    for (const { pane } of entries.values()) {
      if (target === 'workspace' && pane.workspaceId === id) pane.workspace = label;
      if (target === 'tab' && pane.tabId === id) pane.tab = label;
    }
    return fulfillJson(route, 200, { ok: true });
  });
  await page.route('**/api/herdr/close', route => {
    const { target, id } = route.request().postDataJSON() as HerdrClose;
    if (target === 'workspace' && id === 'w79' && spaces.has('w80')) return error(route, 409, '워크트리 스페이스를 먼저 닫으세요.');
    if (target === 'workspace') spaces.delete(id);
    for (const [key, { pane }] of entries) {
      if ((target === 'pane' && pane.id === id) || (target === 'tab' && pane.tabId === id) || (target === 'workspace' && pane.workspaceId === id)) entries.delete(key);
    }
    return fulfillJson(route, 200, { ok: true });
  });
  await page.route('**/api/herdr/prompt', route => {
    const { pane, text } = route.request().postDataJSON() as HerdrPrompt;
    const entry = entries.get(pane);
    if (!entry) return error(route, 404, '패널을 찾을 수 없습니다.');
    if (entry.pane.status === 'blocked') return error(route, 409, '승인에 먼저 답하세요.');
    entry.text += `\n❯ ${text}\n\n● 실패 응답도 확인하겠습니다.`;
    entry.pane.status = 'working';
    const list = initialChats.get(pane);
    if (list) list.push({ id: `prompt-${list.length}`, kind: 'user', at: now, text });
    return fulfillJson(route, 200, entry.pane);
  });
  function applyInput(entry: HerdrOutput, keys: readonly string[], text?: string): boolean {
    if (keys.includes('esc') || keys.includes('ctrl+c') || text === '\x03' || text === '\x1b') {
      entry.text += '\n\nInterrupted';
      entry.pane.status = 'idle';
    } else if (entry.pane.status === 'blocked' && (keys.includes('down') || text === '\x1b[B')) {
      approval = Math.min(3, approval + 1);
    } else if (entry.pane.status === 'blocked' && (keys.includes('enter') || text === '\r' || /^[123yn]$/i.test(text ?? ''))) {
      entry.text += '\n\n● Running tests…';
      entry.pane.status = 'working';
    } else if (entry.pane.agent === null && text) {
      entry.text += text.replaceAll('\r', '\n').replace(/\x1b\[(200|201)~/g, '');
    } else return false;
    return true;
  }
  await page.route('**/api/herdr/input', route => {
    const { pane, text, keys = [] } = route.request().postDataJSON() as HerdrInput;
    const entry = entries.get(pane);
    if (!entry) return error(route, 404, '패널을 찾을 수 없습니다.');
    applyInput(entry, keys, text);
    return fulfillJson(route, 200, { ok: true });
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
