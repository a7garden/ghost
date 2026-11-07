import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Ghost, State } from '@ghost/contract';
import { WorkspaceSidebar, type GhostMenuItem } from './WorkspaceSidebar';

const ghost = (id: string, isDefault = false): Ghost => ({
  id, name: id, persona: '', look: { avatarId: null }, model: null, isDefault, state: 'active',
  directConversationId: `conv-${id}`, createdAt: 1, updatedAt: 1,
});

const state = (): State => ({
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
});

const menu: GhostMenuItem[] = [{ key: 'work', label: '맡긴 일', path: '/work', kind: 'work' }];

function render(overrides: Partial<Parameters<typeof WorkspaceSidebar>[0]> = {}) {
  return renderToStaticMarkup(createElement(WorkspaceSidebar, {
    state: state(), section: 'home', openGhostId: null, ghostMenu: () => menu, currentGhostPage: null,
    attentionCount: 2, status: { state: 'connected', label: '연결됨' }, navigate() {}, openGhost() {}, ...overrides,
  }));
}

it('keeps every Ghost folded on workspace pages and lists the main Ghost first with its badge', () => {
  const html = render();
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toContain('<span class="sr-only">확인 필요 </span>2');
  expect(html).not.toContain('맡긴 일</span>');
  expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  const ghosts = html.slice(html.indexOf('Ghost</p>'));
  expect(ghosts.indexOf('sage')).toBeLessThan(ghosts.indexOf('milo'));
  expect(ghosts.slice(ghosts.indexOf('sage'), ghosts.indexOf('</button>', ghosts.indexOf('sage')))).toContain('메인');
  expect(html.match(/메인/g)).toHaveLength(1);
});

it('shows pages only under the open Ghost and marks the page on screen', () => {
  const html = render({ section: 'work', openGhostId: 'sage', currentGhostPage: 'work' });
  expect(html.match(/맡긴 일/g)).toHaveLength(1);
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  const current = html.slice(html.indexOf('aria-current="page"'));
  expect(current.slice(0, current.indexOf('</button>'))).toContain('맡긴 일');
});

it('marks the open Ghost itself while its conversation is on screen', () => {
  const html = render({ section: 'ghosts', openGhostId: 'sage', currentGhostPage: 'chat' });
  const current = html.slice(html.indexOf('aria-current="page"'));
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(current.slice(0, current.indexOf('</button>'))).toContain('sage');
});

it('shows host trouble on the settings entry only when the host is not connected', () => {
  expect(render()).not.toContain('연결 필요');
  const html = render({ status: { state: 'offline', label: '연결 필요' } });
  expect(html).toContain('연결 필요');
});
