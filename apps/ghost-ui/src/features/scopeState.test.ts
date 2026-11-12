import { expect, it } from 'vitest';
import type { Decision, Scope, Work } from '@ghost/contract';
import { decisionScopeId, groupDecisionsByScope } from './scopeState';

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
