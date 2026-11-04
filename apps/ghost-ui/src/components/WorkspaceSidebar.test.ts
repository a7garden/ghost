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
  return { snapshot, route: `/ghosts/${profile.id}?conversation=second`, section: 'ghosts', dotId: profile.id, views: [], attentionCount: 2, mode: 'demo', error: '', lifetimeEnabled: false, navigate() {}, onConnection() {} };
}

it('marks the routed conversation rather than the first conversation as selected', () => {
  const html = renderToStaticMarkup(createElement(WorkspaceSidebar, props()));
  expect(html).toContain('class="sidebar-conversation selected" aria-current="page" title="선택한 대화"');
  expect(html).toContain('class="sidebar-conversation " title="첫 대화"');
  expect(html).toContain('nav-count">2');
});

it('shows history, spaces and collaboration as direct navigation', () => {
  const html = renderToStaticMarkup(createElement(WorkspaceSidebar, props()));
  expect(html).toContain('대화 기록</h3>');
  expect(html).toContain('협업 기록</span>');
  expect(html).not.toMatch(/<details|<summary|aria-expanded=/);
});
