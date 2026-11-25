import { expect, it } from 'vitest';
import type { WorkbenchState } from '@ghost/contract';
import { resolveSessionLink } from './workbenchSessionLink';

const session = { id: 'coding-abc', repo: '/source/sample', cwd: '/worktrees/branch' };
const state: WorkbenchState = {
  version: 1,
  spaces: [{ id: 'one', title: 'First', root: null, createdAt: 0 }, { id: 'two', title: 'Second', root: null, createdAt: 0 }],
  agents: [{ sessionId: 'other', spaceId: 'one' }, { sessionId: session.id, spaceId: 'two' }],
  focus: { spaceId: 'one', sessionId: 'other' },
};

it('focuses the agent across spaces instead of adding a second entry', () => {
  const fields = { spaceId: 'two', sessionId: session.id };
  expect(resolveSessionLink(state, session)).toEqual({ path: 'focus', fields, opensAgent: true });
  expect(resolveSessionLink({ ...state, focus: fields }, session)).toBeNull();
});

it('adds the session to the focused space when it is not listed yet', () => {
  expect(resolveSessionLink({ ...state, agents: state.agents.slice(0, 1) }, session)).toEqual({
    path: 'spaces/one/agents', fields: { sessionId: session.id }, opensAgent: true,
  });
});

it('opens a space named after the repository when the workbench is empty', () => {
  expect(resolveSessionLink({ ...state, spaces: [], agents: [], focus: null }, session))
    .toEqual({ path: 'spaces', fields: { title: 'sample', root: '/source/sample' } });
});
