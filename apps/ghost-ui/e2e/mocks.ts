import type { Page, Route } from '@playwright/test';
import type { CodingPrefs, CodingSetup, Decision, HerdrAgentStart, HerdrClose, HerdrFrame, HerdrInput, HerdrIntegrationInstall, HerdrOutput, HerdrPaneView, HerdrPrompt, HerdrRename, HerdrSplit, HerdrTabCreate, HerdrView, HerdrWorkspaceCreate, HerdrWorkspaceView, VaultItem } from '@ghost/contract';
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

export function fulfillHerdrFrame(route: Route, text: string, { end = false }: { end?: boolean } = {}) {
  const url = new URL(route.request().url());
  const width = Number(url.searchParams.get('cols')), height = Number(url.searchParams.get('rows'));
  const colors = [36, 0, 32, 0, 33];
  const lines = text.split('\n').slice(-height);
  const body = lines.map((line, index) => `\x1b[${colors[index % colors.length]}m${line}\x1b[0m`).join('\r\n');
  const bytes = Buffer.from(`\x1b[?25l\x1b[2J\x1b[H\x1b[?2004h${body}\x1b[?25h`).toString('base64');
  const frame: HerdrFrame = { seq: 1, full: true, bytes, width, height };
  return route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: `event: frame\r\ndata: ${JSON.stringify(frame)}\r\n\r\n${end ? 'event: end\r\n\r\n' : ''}`,
  });
}

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
    kinds: ['omp', 'claude', 'pi', 'gemini'],
    prefs: { session: null, agent: 'claude' },
  };
  const entries = new Map<string, HerdrOutput>();
  for (const output of [
    {
      pane: { id: visualCodingIds.running, workspaceId: 'w79', tabId: 'w79:tB', workspace: 'app', tab: 'checkout', agent: 'Claude Code',
        status: 'working', focused: true, cwd: '/Users/garden/Workspace/Projects/wt/app-checkout-tests', title: '결제 화면 테스트 추가' },
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
        status: 'done', focused: false, cwd: '/Users/garden/Workspace/Projects/wt/app-fix-login', title: '로그인 실패 시 안내 문구 고치기' },
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
        status: 'blocked', focused: true, cwd: '/Users/garden/Workspace/Projects/ghost', title: '설정 화면 키보드 탐색 확인' },
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
        status: 'unknown', focused: false, cwd: '/Users/garden/Workspace/Projects/app', title: 'zsh' },
      text: 'app % git status --short\n M src/checkout/payment.ts\n?? src/checkout/payment.test.ts\n\napp %',
    },
  ] satisfies HerdrOutput[]) entries.set(output.pane.id, output);
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
      agent: agentLabel(agent), status: agent ? 'working' : 'unknown', focused: true,
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

  await page.route('**/api/herdr', route => fulfillJson(route, 200, overview()));
  await page.route('**/api/herdr/terminal?*', route => {
    const id = new URL(route.request().url()).searchParams.get('pane');
    const entry = id ? entries.get(id) : undefined;
    if (!setup.server || !entry) return error(route, 404, '패널을 찾을 수 없습니다.');
    const text = id === visualCodingIds.blocked && entry.pane.status === 'blocked' && approval > 1
      ? entry.text.replace('❯ 1.', '  1.').replace(`  ${approval}.`, `❯ ${approval}.`) : entry.text;
    return fulfillHerdrFrame(route, text);
  });
  await page.route('**/api/herdr/output?*', route => {
    const pane = new URL(route.request().url()).searchParams.get('pane');
    const entry = entries.get(pane ?? '');
    return setup.server && entry ? fulfillJson(route, 200, entry) : error(route, 404, '패널을 찾을 수 없습니다.');
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
    return fulfillJson(route, 200, entry.pane);
  });
  await page.route('**/api/herdr/input', route => {
    const { pane, text, keys = [] } = route.request().postDataJSON() as HerdrInput;
    const entry = entries.get(pane);
    if (!entry) return error(route, 404, '패널을 찾을 수 없습니다.');
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
    }
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
