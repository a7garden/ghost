import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { Decision, Ghost, State } from '@ghost/contract';
import { WorkspaceSidebar } from './WorkspaceSidebar';

const ghost = (id: string, isDefault = false, overrides: Partial<Ghost> = {}): Ghost => ({
  id, name: id, persona: '', look: { avatarId: null }, model: null, isDefault, state: 'active',
  tools: [], fallbacks: [], skills: [], deletedAt: null, directConversationId: `conv-${id}`, createdAt: 1, updatedAt: 1,
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
  spaces: [{ id: 'sp1', name: '메모', path: '/v', grants: [], createdAt: 1 }],
  avatars: [],
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

/** The markup inside the Ghost navigation group, where the roster rows live. */
const roster = (html: string) => html.slice(html.indexOf('Ghost</p>'));

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

it('shows host trouble on the settings entry only when the host is not connected', () => {
  expect(render()).not.toContain('연결 필요');
  const html = render({ status: { state: 'offline', label: '연결 필요' } });
  expect(html).toContain('연결 필요');
});

it('never renders retired or deleted Ghosts', () => {
  const html = render({ state: state({ ghosts: [
    ghost('milo'), ghost('sage', true), ghost('gone', false, { state: 'retired' }), ghost('tomb', false, { deletedAt: 123 }),
  ] }) });
  expect(html).toContain('milo');
  expect(html).toContain('sage');
  expect(html).not.toContain('gone');
  expect(html).not.toContain('tomb');
  expect(html).not.toContain('sidebar-more');
});

it('keeps a team of seven or fewer exactly as before', () => {
  const html = render({ state: team(['도우미', '연구원', '기록가']) });
  expect(html).not.toContain('sidebar-more');
  expect(html).not.toContain('Ghost 찾기');
  const ghosts = roster(html);
  expect(ghosts.indexOf('도우미')).toBeLessThan(ghosts.indexOf('연구원'));
  expect(ghosts.indexOf('연구원')).toBeLessThan(ghosts.indexOf('기록가'));
});

it('collapses a bigger team into the top list behind a +N disclosure', () => {
  const html = render({ state: team(['도우미', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9']) });
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('Ghost 9명 더 보기');
  expect(html).toContain('+9');
  const ghosts = roster(html);
  expect(ghosts).toContain('도우미');
  for (const hidden of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9']) expect(ghosts).not.toContain(hidden);
  expect(html).not.toContain('Ghost 찾기');
});

it('keeps attention Ghosts in the top list, decision before busy conversation', () => {
  const html = render({ state: team(['도우미', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'], {
    decisions: [decision('d1', 'g3')],
    conversations: [{ id: 'conv-g5', ghostId: 'g5', kind: 'direct', workId: null, title: '대화', model: null, busy: true, createdAt: 1, lastActivityAt: 1 }],
  }) });
  const ghosts = roster(html);
  expect(ghosts).toContain('g3');
  expect(ghosts).toContain('g5');
  expect(ghosts.indexOf('g3')).toBeLessThan(ghosts.indexOf('g5'));
  expect(html).toContain('방향 확인');
  expect(html).toContain('응답 중');
  expect(html).toContain('Ghost 7명 더 보기');
});

it('pins Ghosts in pin order above the hidden rest', () => {
  storeSidebar({ pinned: ['g7', 'g2'], expanded: false });
  const html = render({ state: team(['도우미', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9']) });
  const ghosts = roster(html);
  expect(ghosts).toContain('g7');
  expect(ghosts).toContain('g2');
  expect(ghosts.indexOf('g7')).toBeLessThan(ghosts.indexOf('g2'));
  expect(html).toContain('Ghost 7명 더 보기');
  expect(ghosts).not.toContain('g1');
});

it('keeps the conversation on screen in the top list', () => {
  const html = render({ state: team(['도우미', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9']), openGhostId: 'g4' });
  const ghosts = roster(html);
  expect(ghosts).toContain('g4');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('Ghost 8명 더 보기');
});

it('expanded, the rest appear by name with paused Ghosts dimmed', () => {
  storeSidebar({ pinned: [], expanded: true });
  const ghosts9 = ['도우미', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'];
  const html = render({ state: team(ghosts9, { ghosts: ghosts9.map((name, index) => ghost(name, index === 0, index === 2 ? { state: 'paused' as const } : {})) }) });
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('Ghost 목록 접기');
  for (const shown of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']) expect(roster(html)).toContain(shown);
  expect(html).toContain('data-dimmed');
  expect(html).not.toContain('Ghost 찾기');
});

it('an expanded overflow past eight rows grows its own filter', () => {
  storeSidebar({ pinned: [], expanded: true });
  const html = render({ state: team(['도우미', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9']) });
  expect(html).toContain('type="search"');
  expect(html).toContain('Ghost 찾기');
});
