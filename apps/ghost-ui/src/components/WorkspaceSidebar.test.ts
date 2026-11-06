import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WorkspaceSidebar, type GhostMenuItem } from './WorkspaceSidebar';
import { initialWorkspace } from '../fixtures/workspace';

const menu: GhostMenuItem[] = [
  { key: 'work', label: '맡은 일', path: '/work', kind: 'work' },
];

function render(overrides: Partial<Parameters<typeof WorkspaceSidebar>[0]> = {}) {
  const snapshot = overrides.snapshot ?? initialWorkspace();
  return { snapshot, html: renderToStaticMarkup(createElement(WorkspaceSidebar, {
    snapshot, section: 'home', openGhostId: null, ghostMenu: () => menu, currentGhostPage: null, defaultGhostId: snapshot.profiles[1].id,
    attentionCount: 2, status: { state: 'connected', label: '연결됨' }, canCreateProject: true, navigate() {}, openGhost() {}, ...overrides,
  })) };
}

it('keeps every Ghost folded on workspace pages and lists the main Ghost first with its badge', () => {
  const { snapshot, html } = render();
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toContain('<span class="sr-only">확인 필요 </span>2');
  expect(html).not.toContain('맡은 일');
  expect(html.match(/aria-expanded="false"/g)).toHaveLength(snapshot.profiles.length);
  const ghosts = html.slice(html.indexOf('Ghost</p>'));
  const main = ghosts.indexOf(snapshot.profiles[1].name);
  expect(main).toBeLessThan(ghosts.indexOf(snapshot.profiles[0].name));
  expect(ghosts.slice(main, ghosts.indexOf('</button>', main))).toContain('메인');
  expect(html.match(/메인/g)).toHaveLength(1);
});

it('shows pages only under the open Ghost and marks the page on screen', () => {
  const snapshot = initialWorkspace();
  const { html } = render({ snapshot, section: 'lifetime', openGhostId: snapshot.profiles[0].id, currentGhostPage: 'work' });
  expect(html.match(/맡은 일/g)).toHaveLength(1);
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  const current = html.slice(html.indexOf('aria-current="page"'));
  expect(current.slice(0, current.indexOf('</button>'))).toContain('맡은 일');
});

it('marks the open Ghost itself while its conversation is on screen', () => {
  const snapshot = initialWorkspace();
  const { html } = render({ snapshot, section: 'lifetime', openGhostId: snapshot.profiles[0].id, currentGhostPage: 'chat' });
  const current = html.slice(html.indexOf('aria-current="page"'));
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(current.slice(0, current.indexOf('</button>'))).toContain(snapshot.profiles[0].name);
});

it('shows Host starter Ghosts by role name instead of their identifiers', () => {
  const snapshot = initialWorkspace();
  snapshot.profiles[0].name = 'specialist-research';
  const { html } = render({ snapshot });
  expect(html).toContain('리서치');
  expect(html).not.toContain('specialist-research');
});

it('shows the owner-chosen display name over the profile identifier', () => {
  const snapshot = initialWorkspace();
  snapshot.profiles[0].name = 'specialist-research';
  snapshot.profiles[0].display_name = '조사 담당';
  const { html } = render({ snapshot });
  expect(html).toContain('조사 담당');
  expect(html).not.toContain('리서치');
});

it('shows host trouble on the settings entry only when the host is not connected', () => {
  expect(render().html).not.toContain('연결 끊김');
  const { html } = render({ status: { state: 'offline', label: '연결 끊김' } });
  expect(html).toContain('연결 끊김');
});
