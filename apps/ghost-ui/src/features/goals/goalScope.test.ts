import { expect, it } from 'vitest';
import type { Goal, Scope, State } from '@ghost/contract';
import { goalLimit, goalsAtCap, groupGoalsByScope } from './goalScope';

const goal = (id: string, scopeId: string | null, state: Goal['state'] = 'active') => ({ id, scopeId, state }) as Goal;
const scopes = [{ id: 's1', name: '글', limits: { openGoals: 1 } }, { id: 's2', name: '코드', limits: {} }] as Scope[];
const base = { scopes, settings: { limits: { openGoals: 2 } } } as unknown as State;

it('applies the project limit before the global one, per project', () => {
  expect(goalLimit(base, 's1')).toBe(1);
  expect(goalLimit(base, 's2')).toBe(2);
  expect(goalLimit(base, null)).toBe(2);
  const goals = [goal('a', 's1'), goal('b', 's2'), goal('c', null), goal('d', null, 'closed')];
  const state = { ...base, goals };
  expect([goalsAtCap(state, 's1'), goalsAtCap(state, 's2'), goalsAtCap(state, null)]).toEqual([true, false, false]);
});

it('groups whole-team goals first, then projects in order, keeping removed projects identifiable', () => {
  const groups = groupGoalsByScope([goal('a', 's2'), goal('b', null), goal('c', 'gone'), goal('d', 's1'), goal('e', 's2')], base);
  expect(groups.map(group => [group.id, group.name, group.goals.map(item => item.id)])).toEqual([
    [null, '전체', ['b']], ['s1', '글', ['d']], ['s2', '코드', ['a', 'e']], ['gone', '삭제된 프로젝트', ['c']],
  ]);
});
