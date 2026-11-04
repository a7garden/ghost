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

it('gives desktop and mobile section controls separate target IDs', () => {
  const html = renderToStaticMarkup(createElement('div', null, createElement(WorkspaceSidebar, props()), createElement(WorkspaceSidebar, props())));
  const targets = [...html.matchAll(/aria-controls="([^"]+)"/g)].map(match => match[1]);
  expect(targets).toHaveLength(4);
  expect(new Set(targets).size).toBe(4);
  for (const target of targets) expect(html).toContain(`id="${target}"`);
});
