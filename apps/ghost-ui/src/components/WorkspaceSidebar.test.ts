import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { initialWorkspace } from '../fixtures/workspace';

function props() {
  const snapshot = initialWorkspace();
  return {
    snapshot, section: 'home', chatGhostId: null as string | null, defaultGhostId: snapshot.profiles[1].id,
    views: [], attentionCount: 2, status: { state: 'connected', label: '연결됨' } as const, canCreateProject: true, navigate() {}, openGhost() {},
  };
}

it('marks no Ghost as current on workspace pages and lists the default Ghost first', () => {
  const input = props();
  const html = renderToStaticMarkup(createElement(WorkspaceSidebar, input));
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toContain('class="nav-row selected" aria-current="page"><svg');
  expect(html).toContain('<span class="sr-only">확인 필요 </span>2');
  const chats = html.slice(html.indexOf('aria-label="Ghost 대화"'));
  expect(chats.indexOf(input.snapshot.profiles[1].name)).toBeLessThan(chats.indexOf(input.snapshot.profiles[0].name));
});

it('marks exactly the Ghost whose conversation is open', () => {
  const input = { ...props(), section: 'lifetime', chatGhostId: props().snapshot.profiles[0].id };
  const html = renderToStaticMarkup(createElement(WorkspaceSidebar, input));
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  const current = html.slice(html.indexOf('aria-current="page"'));
  expect(current.slice(0, current.indexOf('</button>'))).toContain(input.snapshot.profiles[0].name);
});

it('shows host trouble on the settings entry only when the host is not connected', () => {
  const healthy = renderToStaticMarkup(createElement(WorkspaceSidebar, props()));
  expect(healthy).not.toContain('sidebar-host-indicator');
  const html = renderToStaticMarkup(createElement(WorkspaceSidebar, { ...props(), status: { state: 'offline', label: '연결 끊김' } as const }));
  expect(html).toContain('data-state="offline"');
  expect(html).toContain('연결 끊김');
});
