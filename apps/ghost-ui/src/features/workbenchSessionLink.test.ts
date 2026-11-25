import { expect, it } from 'vitest';
import type { WorkbenchState } from '@ghost/contract';
import { resolveSessionLink } from './workbenchSessionLink';

const session = { id: 'coding-abc', ghostId: null };
const state: WorkbenchState = {
  version: 1,
  agents: [{ sessionId: 'other', scopeId: 'one' }, { sessionId: session.id, scopeId: 'two' }],
  focus: { scopeId: 'one', sessionId: 'other' },
};

it('focuses a listed agent in its own project instead of listing it twice', () => {
  const fields = { scopeId: 'two', sessionId: session.id };
  expect(resolveSessionLink(state, session, 'one')).toEqual({ path: 'focus', fields });
  expect(resolveSessionLink({ ...state, focus: fields }, session, 'two')).toBeNull();
});

it('lists an owner session under the project that holds its folder', () => {
  expect(resolveSessionLink({ ...state, agents: state.agents.slice(0, 1) }, session, 'two'))
    .toEqual({ path: 'agents', fields: { sessionId: session.id, scopeId: 'two' } });
});

it('opens a Ghost session in its Work’s project without listing it', () => {
  expect(resolveSessionLink({ ...state, agents: [] }, { id: 'g', ghostId: 'ghost-1' }, 'two'))
    .toEqual({ path: 'focus', fields: { scopeId: 'two', sessionId: 'g' } });
});
