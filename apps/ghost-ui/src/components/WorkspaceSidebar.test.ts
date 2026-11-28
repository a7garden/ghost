import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
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

/** The installed Ghosts' group, after the main Ghost's own block. */
const installedGroup = (html: string) => html.slice(html.indexOf('class="ghost-navigation-group sidebar-ghosts"'));

it('leads with the main Ghost, badged, ahead of the installed Ghosts and only workspace destinations as pages', () => {
  const html = render();
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toContain('<span class="sr-only">확인 필요 </span>2');
  expect(html.match(/맡긴 일/g)).toHaveLength(1);
  const main = html.slice(html.indexOf('class="sidebar-main"'), html.indexOf('class="ghost-navigation-group sidebar-ghosts"'));
  expect(main).toContain('sage');
  expect(main).toContain('메인');
  expect(main).not.toContain('milo');
  expect(installedGroup(html)).toContain('milo');
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

it('shows the sole main Ghost without a role badge and offers Ghost 추가 in the empty group', () => {
  const html = render({ state: team(['도우미']) });
  expect(html).toContain('도우미');
  expect(html).not.toContain('presence-row__main-mark');
  expect(installedGroup(html)).toContain('Ghost 추가');
  expect(html).not.toContain('>프로젝트<');
});

const project = (id: string, ghostId: string | null): State['scopes'][number] =>
  ({ id, name: `프로젝트-${id}`, paths: [], vaultPath: null, createdAt: 1, ghostId, state: 'active', attachments: [], limits: {}, updatedAt: 1 });

it('files each project under its receiving Ghost, and unassigned or gone receivers\' projects under the main', () => {
  const roster = [ghost('main', true), ghost('writer')];
  const byGhost = projectsByReceiver([project('a', null), project('b', 'writer'), project('c', 'retired'), project('d', 'writer')], roster);
  expect(byGhost.get('main')?.map(scope => scope.id)).toEqual(['a', 'c']);
  expect(byGhost.get('writer')?.map(scope => scope.id)).toEqual(['b', 'd']);
});

it('nests a project right under its Ghost, before the next Ghost', () => {
  const html = render({ state: team(['main', 'writer', 'zeta'], { scopes: [project('novel', 'writer')] }) });
  const writer = html.indexOf('>writer<');
  expect(writer).toBeGreaterThan(-1);
  expect(html.indexOf('프로젝트-novel')).toBeGreaterThan(writer);
  expect(html.indexOf('프로젝트-novel')).toBeLessThan(html.indexOf('>zeta<'));
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

it('never renders retired or deleted Ghosts, and dims a paused one', () => {
  const html = render({ state: state({ ghosts: [
    ghost('milo'), ghost('sage', true), ghost('gone', false, { state: 'retired' }), ghost('tomb', false, { deletedAt: 123 }),
    ghost('rest', false, { state: 'paused' }),
  ] }) });
  expect(html).toContain('milo');
  expect(html).toContain('sage');
  expect(html).not.toContain('gone');
  expect(html).not.toContain('tomb');
  expect(html.slice(html.indexOf('data-dimmed'))).toContain('rest');
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
