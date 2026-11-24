import { expect, it } from 'vitest';
import type { Decision, Scope, Work } from '@ghost/contract';
import { decisionScopeId, groupDecisionsByScope, projectWork } from './scopeState';

const state = { scopes: [{ id: 's1', name: '글' }, { id: 's2', name: '코드' }] as Scope[], works: [{ id: 'w1', scopeId: 's1' }, { id: 'w2', scopeId: null }] as Work[] };
const decision = (id: string, patch: Partial<Decision> = {}) => ({ id, ghostId: 'shared-receiver', workId: null, proposal: null, ...patch }) as Decision;

it('groups explicit project decisions and global decisions without guessing from the receiver', () => {
  const items = [decision('one', { workId: 'w1' }), decision('global'), decision('two', { proposal: { scopeId: 's2' } }), decision('global-work', { workId: 'w2' }), decision('same', { workId: 'w1' })];
  expect(groupDecisionsByScope(items, state).map(group => [group.id, group.name, group.decisions.map(item => item.id)])).toEqual([
    ['s1', '글', ['one', 'same']], [null, '전체', ['global', 'global-work']], ['s2', '코드', ['two']],
  ]);
});

it('uses the Work attribution as authority and keeps removed scopes identifiable', () => {
  expect(decisionScopeId(decision('d', { workId: 'w2', proposal: { scopeId: 's1' } }), state)).toBeNull();
  expect(groupDecisionsByScope([decision('d', { proposal: { scopeId: 'removed' } })], state)[0]?.name).toBe('삭제된 프로젝트');
});

it('splits one project’s Work into live and settled and lists only its pending decisions, oldest first', () => {
  const work = (id: string, scopeId: string | null, workState: string, updatedAt: number) => ({ id, scopeId, state: workState, updatedAt }) as unknown as Work;
  const pending = (id: string, workId: string | null, createdAt: number) => ({ ...decision(id, { workId }), state: 'pending', createdAt }) as Decision;
  const rows = {
    works: [work('a', 's1', 'running', 2), work('b', 's1', 'done', 3), work('c', 's2', 'running', 4), work('d', 's1', 'waiting', 5)],
    decisions: [pending('late', 'd', 9), pending('early', 'a', 1), pending('other', 'c', 2), { ...pending('settled', 'a', 3), state: 'resolved' } as Decision, pending('loose', null, 4)],
  };
  const result = projectWork(rows, 's1');
  expect(result.live.map(item => item.id)).toEqual(['d', 'a']);
  expect(result.settled.map(item => item.id)).toEqual(['b']);
  expect(result.pending.map(item => item.id)).toEqual(['early', 'late']);
});
