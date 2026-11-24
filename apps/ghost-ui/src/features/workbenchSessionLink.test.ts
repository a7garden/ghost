import { expect, it } from 'vitest';
import type { WorkbenchState } from '@ghost/contract';
import { resolveSessionLink } from './workbenchSessionLink';

const session = { id: 'coding-abc', repo: '/source/sample', cwd: '/worktrees/branch' };
const layout: WorkbenchState = {
  version: 1,
  spaces: [{ id: 'one', title: 'First', root: null, createdAt: 0 }, { id: 'two', title: 'Second', root: null, createdAt: 0 }],
  tabs: [
    { id: 't1', spaceId: 'one', title: 'Shell', layout: { type: 'pane', paneId: 'shell' }, focusedPaneId: 'shell' },
    { id: 't2', spaceId: 'two', title: 'Agent', layout: { type: 'pane', paneId: 'saved' }, focusedPaneId: 'saved' },
  ],
  panes: [
    { id: 'shell', tabId: 't1', kind: 'terminal', terminalSpec: { cwd: '/source' } },
    { id: 'saved', tabId: 't2', kind: 'session', sessionId: session.id },
  ],
  focus: { spaceId: 'one', tabId: 't1', paneId: 'shell' },
};

it('focuses a pane across spaces and tabs instead of adding a second pane', () => {
  const fields = { spaceId: 'two', tabId: 't2', paneId: 'saved' };
  expect(resolveSessionLink(layout, session)).toEqual({ path: 'focus', fields, opensPane: true });
  expect(resolveSessionLink({ ...layout, focus: fields }, session)).toBeNull();
});

it('splits the focused pane when the session is not already shown', () => {
  expect(resolveSessionLink({ ...layout, panes: layout.panes.slice(0, 1) }, session)).toEqual({
    path: 'tabs/t1/panes', fields: { targetPaneId: 'shell', direction: 'right', pane: { kind: 'session', sessionId: session.id } }, opensPane: true,
  });
});

it('uses the repository name for a new tab or for a new space', () => {
  const empty = { ...layout, spaces: [], tabs: [], panes: [], focus: null };
  expect(resolveSessionLink(empty, session)).toEqual({ path: 'spaces', fields: { title: 'sample', root: '/source/sample' } });
  expect(resolveSessionLink({ ...empty, spaces: layout.spaces, focus: { spaceId: 'one', tabId: null, paneId: null } }, session))
    .toEqual({ path: 'spaces/one/tabs', fields: { title: 'sample' } });
});
