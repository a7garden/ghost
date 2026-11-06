import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WorkspaceSidebar, type GhostMenuItem } from './WorkspaceSidebar';
import { initialWorkspace } from '../fixtures/workspace';

const menu: GhostMenuItem[] = [
  { key: 'chat', label: '대화', path: '/chat', kind: 'chat' },
  { key: 'work', label: '맡은 일', path: '/work', kind: 'work' },
];

function render(overrides: Partial<Parameters<typeof WorkspaceSidebar>[0]> = {}) {
  const snapshot = overrides.snapshot ?? initialWorkspace();
  return { snapshot, html: renderToStaticMarkup(createElement(WorkspaceSidebar, {
    snapshot, section: 'home', openGhostId: null, ghostMenu: [], currentGhostPage: null, defaultGhostId: snapshot.profiles[1].id,
    attentionCount: 2, status: { state: 'connected', label: '연결됨' }, canCreateProject: true, navigate() {}, openGhost() {}, ...overrides,
  })) };
}

it('opens no Ghost on workspace pages and lists the default Ghost first', () => {
  const { snapshot, html } = render();
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toContain('<span class="sr-only">확인 필요 </span>2');
  expect(html).not.toContain('맡은 일');
  const ghosts = html.slice(html.indexOf('Ghost</p>'));
  expect(ghosts.indexOf(snapshot.profiles[1].name)).toBeLessThan(ghosts.indexOf(snapshot.profiles[0].name));
});

it('shows pages only under the open Ghost and marks the page on screen', () => {
  const snapshot = initialWorkspace();
  const { html } = render({ snapshot, section: 'lifetime', openGhostId: snapshot.profiles[0].id, ghostMenu: menu, currentGhostPage: 'work' });
  expect(html.match(/맡은 일/g)).toHaveLength(1);
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  const current = html.slice(html.indexOf('aria-current="page"'));
  expect(current.slice(0, current.indexOf('</button>'))).toContain('맡은 일');
});

it('shows Host starter Ghosts by role name instead of their identifiers', () => {
  const snapshot = initialWorkspace();
  snapshot.profiles[0].name = 'specialist-research';
  const { html } = render({ snapshot });
  expect(html).toContain('리서치');
  expect(html).not.toContain('specialist-research');
});

it('shows host trouble on the settings entry only when the host is not connected', () => {
  expect(render().html).not.toContain('연결 끊김');
  const { html } = render({ status: { state: 'offline', label: '연결 끊김' } });
  expect(html).toContain('연결 끊김');
});
