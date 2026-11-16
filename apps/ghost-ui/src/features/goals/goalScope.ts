import { DEFAULT_LIMITS, type Goal, type State } from '@ghost/contract';

export const open = (goal: Goal) => goal.state !== 'closed';

/** Open goals a project (or the whole team, `null`) may hold: its own limit, else the global one. */
export function goalLimit(state: Pick<State, 'scopes' | 'settings'>, scopeId: string | null): number {
  const own = scopeId === null ? undefined : state.scopes.find(scope => scope.id === scopeId)?.limits.openGoals;
  return own ?? state.settings.limits?.openGoals ?? DEFAULT_LIMITS.openGoals;
}

export function goalsAtCap(state: Pick<State, 'goals' | 'scopes' | 'settings'>, scopeId: string | null): boolean {
  return (state.goals ?? []).filter(goal => open(goal) && goal.scopeId === scopeId).length >= goalLimit(state, scopeId);
}

export function scopeName(state: Pick<State, 'scopes'>, scopeId: string | null): string {
  return scopeId === null ? '전체' : state.scopes.find(scope => scope.id === scopeId)?.name ?? '삭제된 프로젝트';
}

/** Whole-team goals first, then one group per project in project order; projects without goals are omitted. */
export function groupGoalsByScope(goals: readonly Goal[], state: Pick<State, 'scopes'>): { id: string | null; name: string; goals: Goal[] }[] {
  const groups = new Map<string | null, Goal[]>();
  for (const goal of goals) {
    const items = groups.get(goal.scopeId);
    if (items) items.push(goal); else groups.set(goal.scopeId, [goal]);
  }
  const known = state.scopes.map(scope => scope.id);
  const order = [null, ...known, ...[...groups.keys()].filter((id): id is string => id !== null && !known.includes(id))];
  return order.filter(id => groups.has(id)).map(id => ({ id, name: scopeName(state, id), goals: groups.get(id)! }));
}
