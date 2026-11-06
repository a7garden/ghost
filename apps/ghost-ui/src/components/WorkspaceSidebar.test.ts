import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WorkspaceSidebar, type GhostMenuItem } from './WorkspaceSidebar';
import { initialWorkspace } from '../fixtures/workspace';

const menu: GhostMenuItem[] = [
  { key: 'chat', label: '대화', path: '/chat', kind: 'chat' },
  { key: 'work', label: '맡은 일', path: '/work', kind: 'work' },
];

function props() {
  const snapshot = initialWorkspace();
  return {
    snapshot, section: 'home', openGhostId: null as string | null, ghostMenu: [] as GhostMenuItem[], currentGhostPage: null as string | null,
    defaultGhostId: snapshot.profiles[1].id, attentionCount: 2, status: { state: 'connected', label: '연결됨' } as const,
    canCreateProject: true, navigate() {}, openGhost() {},
  };
}

it('opens no Ghost on workspace pages and lists the default Ghost first', () => {
  const input = props();
  const html = renderToStaticMarkup(createElement(WorkspaceSidebar, input));
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toContain('<span class="sr-only">확인 필요 </span>2');
  expect(html).not.toContain('sidebar-ghost-menu');
  const ghosts = html.slice(html.indexOf('class="sidebar-ghosts"'));
  expect(ghosts.indexOf(input.snapshot.profiles[1].name)).toBeLessThan(ghosts.indexOf(input.snapshot.profiles[0].name));
});

it('shows the menu only under the open Ghost and marks the page on screen', () => {
  const input = props(), open = input.snapshot.profiles[0];
  const html = renderToStaticMarkup(createElement(WorkspaceSidebar, { ...input, section: 'lifetime', openGhostId: open.id, ghostMenu: menu, currentGhostPage: 'work' }));
  expect(html.match(/sidebar-ghost-menu/g)).toHaveLength(1);
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  const current = html.slice(html.indexOf('aria-current="page"'));
  expect(current.slice(0, current.indexOf('</button>'))).toContain('맡은 일');
  const openItem = html.slice(html.indexOf('sidebar-ghost open'));
  expect(openItem.slice(0, openItem.indexOf('</li>'))).toContain(open.name);
});

it('shows Host starter Ghosts by role name instead of their identifiers', () => {
  const input = props();
  input.snapshot.profiles[0].name = 'specialist-research';
  const html = renderToStaticMarkup(createElement(WorkspaceSidebar, input));
  expect(html).toContain('<span>리서치</span>');
  expect(html).not.toContain('specialist-research');
});

it('shows host trouble on the settings entry only when the host is not connected', () => {
  const healthy = renderToStaticMarkup(createElement(WorkspaceSidebar, props()));
  expect(healthy).not.toContain('sidebar-host-indicator');
  const html = renderToStaticMarkup(createElement(WorkspaceSidebar, { ...props(), status: { state: 'offline', label: '연결 끊김' } as const }));
  expect(html).toContain('data-state="offline"');
  expect(html).toContain('연결 끊김');
});
