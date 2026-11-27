import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { Decision, Ghost, State, Work } from '@ghost/contract';
import { WorkspaceSidebar, projectsByReceiver } from './WorkspaceSidebar';

const ghost = (id: string, isDefault = false, overrides: Partial<Ghost> = {}): Ghost => ({
  id, name: id, persona: '', look: { avatarId: null }, model: null, isDefault, state: 'active',
  tools: [], fallbacks: [], skills: [], attachments: [], deletedAt: null, directConversationId: `conv-${id}`, createdAt: 1, updatedAt: 1,
  ...overrides,
});

const decision = (id: string, ghostId: string): Decision => ({
  id, kind: 'question', ghostId, conversationId: `conv-${ghostId}`, workId: null, effectId: null,
  title: '방향 확인', detail: '', options: [], proposal: null, state: 'pending', answer: null, createdAt: 1, resolvedAt: null,
});

const state = (overrides: Partial<State> = {}): State => ({
  seq: 1,
  principal: { kind: 'owner' },
  runtime: { ready: true, detail: '', version: '0.0.0' },
  ghosts: [ghost('milo'), ghost('sage', true)],
  conversations: [
    { id: 'conv-sage', ghostId: 'sage', kind: 'direct', workId: null, title: '메인 대화', model: null, busy: false, createdAt: 1, lastActivityAt: 5 },
    { id: 'conv-old', ghostId: 'sage', kind: 'direct', workId: null, title: '이전 대화', model: null, busy: false, createdAt: 1, lastActivityAt: 2 },
  ],
  works: [],
  decisions: [],
  notifications: [],
  schedules: [],
  scopes: [{ id: 'sp1', name: '메모', paths: ['/v'], vaultPath: '/v', createdAt: 1 , ghostId: null, state: "active", attachments: [], limits: {}, updatedAt: 1 }],
  policyRules: [], mcpServers: [], configRevisions: [], avatars: [],
  settings: { defaultModel: null, reviewModel: null, providers: [] },
  devices: [],
  sandboxes: [],
  ...overrides,
});

/** A roster whose first name is the default Ghost; `extra` adds conversations, decisions and so on. */
const team = (names: string[], extra: Partial<State> = {}): State => state({
  ghosts: names.map((name, index) => ghost(name, index === 0)),
  conversations: [],
  ...extra,
});

function render(overrides: Partial<Parameters<typeof WorkspaceSidebar>[0]> = {}) {
  return renderToStaticMarkup(createElement(WorkspaceSidebar, {
    state: state(), section: 'home', openGhostId: null,
    attentionCount: 2, status: { state: 'connected', label: '연결됨' }, navigate() {}, openGhost() {}, ...overrides,
  }));
}

const roster = (html: string) => html.slice(html.indexOf('class="ghost-navigation-group sidebar-ghosts"'));

const storeSidebar = (value: unknown) => vi.stubGlobal('localStorage', {
  getItem: (key: string) => key === 'ghost-ui:sidebar' ? JSON.stringify(value) : null,
  setItem() {},
});

afterEach(() => { vi.unstubAllGlobals(); });

it('lists the main Ghost first with its badge and only workspace destinations as pages', () => {
  const html = render();
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toContain('<span class="sr-only">확인 필요 </span>2');
  expect(html.match(/맡긴 일/g)).toHaveLength(1);
  const ghosts = roster(html);
  expect(ghosts.indexOf('sage')).toBeLessThan(ghosts.indexOf('milo'));
  expect(ghosts.slice(ghosts.indexOf('sage'), ghosts.indexOf('</button>', ghosts.indexOf('sage')))).toContain('메인');
  expect(html.match(/메인/g)).toHaveLength(1);
});

it('marks the work board itself, not a Ghost, while it is on screen', () => {
  const html = render({ section: 'work' });
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  const current = html.slice(html.indexOf('aria-current="page"'));
  expect(current.slice(0, current.indexOf('</button>'))).toContain('맡긴 일');
});

it('marks the open Ghost while any of its conversations is on screen', () => {
  const html = render({ section: 'ghosts', openGhostId: 'sage' });
  const current = html.slice(html.indexOf('aria-current="page"'));
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(current.slice(0, current.indexOf('</button>'))).toContain('sage');
});

it('shows the sole main Ghost without roster labels or a redundant role badge', () => {
  const html = render({ state: team(['도우미']) });
  expect(html).toContain('도우미');
  expect(html).not.toContain('sidebar-ghosts');
  expect(html).not.toContain('presence-row__main-mark');
  expect(html).not.toContain('Ghost 목록');
  expect(html).toContain('프로젝트');
});

const project = (id: string, ghostId: string | null): State['scopes'][number] =>
  ({ id, name: `프로젝트-${id}`, paths: [], vaultPath: null, createdAt: 1, ghostId, state: 'active', attachments: [], limits: {}, updatedAt: 1 });

it('files each project under its receiving Ghost, unassigned ones under the main, and keeps a gone receiver\'s apart', () => {
  const roster = [ghost('main', true), ghost('writer')];
  const { byGhost, orphans } = projectsByReceiver([project('a', null), project('b', 'writer'), project('c', 'retired'), project('d', 'writer')], roster);
  expect(byGhost.get('main')?.map(scope => scope.id)).toEqual(['a']);
  expect(byGhost.get('writer')?.map(scope => scope.id)).toEqual(['b', 'd']);
  expect(orphans.map(scope => scope.id)).toEqual(['c']);
});

it('nests a project right under its Ghost, even when the folded pool would hide that Ghost', () => {
  storeSidebar({ pinned: [], expanded: false });
  const html = render({ state: team(['main', 'writer', 'idle', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6'], { scopes: [project('novel', 'writer')] }) });
  const writer = html.indexOf('writer');
  expect(writer).toBeGreaterThan(-1);
  expect(html.indexOf('프로젝트-novel')).toBeGreaterThan(writer);
  expect(html.indexOf('프로젝트-novel')).toBeLessThan(html.indexOf('프로젝트</p>'));
  expect(html).not.toContain('>idle<');
});

it('offers the unscoped workbench only when coding has unscoped agents', () => {
  expect(render({ section: 'coding' })).not.toContain('프로젝트 없음');
  expect(render({ projectSignals: new Map([[null, 'waiting']]) })).not.toContain('프로젝트 없음');
  const html = render({ section: 'coding', selectedScope: null, projectSignals: new Map([[null, undefined]]) });
  expect(html.match(/프로젝트 없음/g)).toHaveLength(1);
  expect(html).toMatch(/sidebar-project--unscoped"[^>]*>[\s\S]*?프로젝트 없음/);
  expect(html.match(/aria-current="page"/g)).toHaveLength(2);
});

it('shows host trouble on the settings entry only once it is announced, toned by severity', () => {
  expect(render()).not.toContain('연결됨');
  expect(render({ status: { state: 'connecting', label: '연결 확인 중', quiet: true } })).not.toContain('연결 확인 중');
  expect(render({ status: { state: 'reconnecting', label: '재연결 중…', quiet: true } })).not.toContain('재연결 중…');
  expect(render({ status: { state: 'reconnecting', label: '재연결 중…' } })).toMatch(/data-tone="amber"[^>]*>재연결 중…/);
  expect(render({ status: { state: 'offline', label: '연결 끊김' } })).toMatch(/data-tone="danger"[^>]*>연결 끊김/);
});

it('never renders retired or deleted Ghosts', () => {
  const html = render({ state: state({ ghosts: [
    ghost('milo'), ghost('sage', true), ghost('gone', false, { state: 'retired' }), ghost('tomb', false, { deletedAt: 123 }),
  ] }) });
  expect(html).toContain('milo');
  expect(html).toContain('sage');
  expect(html).not.toContain('gone');
  expect(html).not.toContain('tomb');
  expect(html).not.toContain('sidebar-pool-toggle');
});

it('keeps small rosters together and shows the default first even with the long roster folded', () => {
  storeSidebar({ pinned: [], expanded: false });
  const ghosts = roster(render({ state: team(['도우미', '연구원', '기록가']) }));
  expect(ghosts).not.toContain('sidebar-pool-toggle');
  expect(ghosts).toContain('도우미');
  expect(ghosts).toContain('기록가');
  expect(ghosts).toContain('연구원');
  expect(ghosts.indexOf('도우미')).toBeLessThan(ghosts.indexOf('기록가'));
  expect(ghosts.indexOf('기록가')).toBeLessThan(ghosts.indexOf('연구원'));
});

it('pins Ghosts in pin order after the default and before the pool', () => {
  storeSidebar({ pinned: ['g7', 'g2'], expanded: true });
  const ghosts = roster(render({ state: team(['도우미', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']) }));
  expect(ghosts.indexOf('도우미')).toBeLessThan(ghosts.indexOf('g7'));
  expect(ghosts.indexOf('g7')).toBeLessThan(ghosts.indexOf('g2'));
  expect(ghosts.indexOf('g2')).toBeLessThan(ghosts.indexOf('g1'));
});

it('folds the pool from its header, keeping what needs the owner or is on screen', () => {
  storeSidebar({ pinned: [], expanded: false });
  const html = render({ state: team(['도우미', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'], {
    decisions: [decision('d1', 'g3')],
    conversations: [{ id: 'conv-g5', ghostId: 'g5', kind: 'direct', workId: null, title: '대화', model: null, busy: true, createdAt: 1, lastActivityAt: 1 }],
  }), openGhostId: 'g4' });
  expect(html).toContain('aria-expanded="false"');
  const pool = html.slice(html.indexOf('class="sidebar-pool"'));
  for (const shown of ['g3', 'g4', 'g5']) expect(pool).toContain(shown);
  for (const hidden of ['g1', 'g2', 'g6', 'g7', 'g8', 'g9']) expect(pool).not.toContain(hidden);
  expect(html).not.toContain('Ghost 찾기');
});

it('an expanded roster past eight Ghosts grows a pool filter and marks paused Ghosts', () => {
  storeSidebar({ pinned: [], expanded: true });
  const ghosts10 = ['도우미', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'];
  const html = render({ state: team(ghosts10, { ghosts: ghosts10.map((name, index) => ghost(name, index === 0, index === 3 ? { state: 'paused' as const } : {})) }) });
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('Ghost 찾기');
  expect(html).toContain('data-dimmed');
});

it('clears owner-attention rings after a decision is resolved even while failed root and child work remain in history', () => {
  const failed: Work = {
    id: 'failed-root', parentId: null, rootId: 'failed-root', ghostId: 'sage',
    originConversationId: 'conv-sage', conversationId: null, title: 'Earlier failure', brief: 'Earlier work',
    acceptance: { criteria: '', checks: [], reviewer: null }, state: 'failed', revision: 1, revisionsUsed: 0,
    deadlineAt: null, scopeId: null, attachments: [], slot: null, retry: null, budgetMinutes: 90, budgetUsedMs: 0, budgetSince: null, budgetExtended: false, hold: null, result: null, verdict: null, reason: 'the deadline passed',
    createdAt: 1, startedAt: 1, endedAt: Date.now(), updatedAt: Date.now(),
  };
  const history = state({ works: [failed, { ...failed, id: 'failed-child', parentId: failed.id, ghostId: 'milo' }] });
  expect(render({ state: history, attentionCount: 0 })).not.toContain('data-presence="attention"');

  const waiting = { ...history, decisions: [decision('d1', 'milo')] };
  expect(render({ state: waiting, attentionCount: 1 }).match(/data-presence="attention"/g)).toHaveLength(1);
  const answered = { ...waiting, decisions: [{ ...waiting.decisions[0], state: 'answered' as const, resolvedAt: Date.now() }] };
  expect(render({ state: answered, attentionCount: 0 })).not.toContain('data-presence="attention"');

  const blocked = { ...answered, works: [...answered.works, { ...failed, id: 'blocked-work', state: 'blocked' as const, endedAt: null }] };
  expect(render({ state: blocked, attentionCount: 1 }).match(/data-presence="attention"/g)).toHaveLength(1);
});
