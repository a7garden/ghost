import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { initialWorkspace } from '../fixtures/workspace';

function props() {
  const snapshot = initialWorkspace(), profile = snapshot.profiles[0];
  profile.conversations = [
    { id: 'first', title: '첫 대화', model: 'mock', offline: true, messages: [], tasks: [] },
    { id: 'second', title: '선택한 대화', model: 'mock', offline: true, messages: [], tasks: [] },
  ];
  return { snapshot, route: `/ghosts/${profile.id}?conversation=second`, section: 'ghosts', dotId: profile.id, views: [], attentionCount: 2, mode: 'demo', error: '', lifetimeEnabled: false, navigate() {} };
}

it('shows each saved conversation once and selects only the routed row', () => {
  const input = props();
  const earlier = renderToStaticMarkup(createElement(WorkspaceSidebar, input));
  expect(earlier.match(/aria-current="page"/g)).toHaveLength(1);
  expect(earlier).toContain('class="nav-row selected" aria-current="page" title="선택한 대화"');
  expect(earlier.match(/title="첫 대화"/g)).toHaveLength(1);

  const current = renderToStaticMarkup(createElement(WorkspaceSidebar, { ...input, route: `/ghosts/${input.dotId}` }));
  expect(current.match(/aria-current="page"/g)).toHaveLength(1);
  expect(current).toContain('class="nav-row selected" aria-current="page" title="첫 대화"');
  expect(current).toContain('nav-count">2');
});

it('keeps current and archived Host conversations distinct', () => {
  const input = { ...props(), mode: 'live', lifetimeEnabled: true };
  const current = renderToStaticMarkup(createElement(WorkspaceSidebar, { ...input, section: 'lifetime', route: `/lifetime?ghost=${input.dotId}` }));
  expect(current).toContain(`class="nav-row selected" aria-current="page" title="${input.snapshot.profiles[0].name}"`);
  expect(current.match(/aria-current="page"/g)).toHaveLength(1);

  const archived = renderToStaticMarkup(createElement(WorkspaceSidebar, { ...input, route: `${input.route}&history=1` }));
  expect(archived).toContain('class="nav-row selected" aria-current="page" title="선택한 대화"');
  expect(archived.match(/aria-current="page"/g)).toHaveLength(1);
});

it('shows direct navigation in a single conversation group', () => {
  const html = renderToStaticMarkup(createElement(WorkspaceSidebar, props()));
  expect(html).toContain('class="sidebar-group-title">대화</h2>');
  expect(html).toContain('협업</span>');
  expect(html).not.toMatch(/대화 기록<|<details|<summary|aria-expanded=/);
});
