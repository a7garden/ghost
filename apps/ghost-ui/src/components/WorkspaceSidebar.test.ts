import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ChatNavigation, WorkspaceRail, type GhostMenuItem } from './WorkspaceSidebar';
import { initialWorkspace } from '../fixtures/workspace';

const menu: GhostMenuItem[] = [
  { key: 'chat', label: '대화', path: '/chat', kind: 'chat' },
  { key: 'work', label: '맡은 일', path: '/work', kind: 'work' },
];

function chat(overrides: Partial<Parameters<typeof ChatNavigation>[0]> = {}) {
  const snapshot = initialWorkspace();
  const props = { snapshot, home: true, openGhostId: null, ghostMenu: [], currentGhostPage: null, defaultGhostId: snapshot.profiles[1].id, navigate() {}, openGhost() {}, ...overrides };
  return { snapshot, html: renderToStaticMarkup(createElement(ChatNavigation, props)) };
}

it('lists the default Ghost first and opens no Ghost on the new-request page', () => {
  const { snapshot, html } = chat();
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html.slice(html.indexOf('aria-current="page"'))).toMatch(/^[^<]*>[\s\S]*?새 요청/);
  const ghosts = html.slice(html.indexOf('Ghost</p>'));
  expect(ghosts.indexOf(snapshot.profiles[1].name)).toBeLessThan(ghosts.indexOf(snapshot.profiles[0].name));
  expect(html).not.toContain('맡은 일');
});

it('shows pages only under the open Ghost and marks the page on screen', () => {
  const snapshot = initialWorkspace();
  const { html } = chat({ snapshot, home: false, openGhostId: snapshot.profiles[0].id, ghostMenu: menu, currentGhostPage: 'work' });
  expect(html.match(/맡은 일/g)).toHaveLength(1);
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  const current = html.slice(html.indexOf('aria-current="page"'));
  expect(current.slice(0, current.indexOf('</button>'))).toContain('맡은 일');
});

it('shows Host starter Ghosts by role name instead of their identifiers', () => {
  const snapshot = initialWorkspace();
  snapshot.profiles[0].name = 'specialist-research';
  const { html } = chat({ snapshot });
  expect(html).toContain('리서치');
  expect(html).not.toContain('specialist-research');
});

it('names pending decisions and host trouble in the rail', () => {
  const open = () => {};
  const healthy = renderToStaticMarkup(createElement(WorkspaceRail, { workspace: 'chat', attentionCount: 0, status: { state: 'connected', label: '연결됨' }, open }));
  expect(healthy).toContain('aria-label="일"');
  expect(healthy).toContain('aria-label="설정"');
  const trouble = renderToStaticMarkup(createElement(WorkspaceRail, { workspace: 'work', attentionCount: 2, status: { state: 'offline', label: '연결 끊김' }, open }));
  expect(trouble).toContain('aria-label="일 · 확인 필요 2"');
  expect(trouble).toContain('aria-label="설정 · 호스트 연결 끊김"');
  expect(trouble.match(/aria-current="page"/g)).toHaveLength(1);
});
