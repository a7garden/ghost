import type { Decision, State } from '@ghost/contract';

/** A receiving Ghost may own several scopes, so its identity is never a scope fallback. */
export function decisionScopeId(decision: Decision, state: Pick<State, 'works'>): string | null {
  if (decision.workId) return state.works.find(work => work.id === decision.workId)?.scopeId ?? null;
  const proposal = decision.proposal;
  return typeof proposal?.scopeId === 'string' ? proposal.scopeId : null;
}

export function groupDecisionsByScope(decisions: Decision[], state: Pick<State, 'works' | 'scopes'>): { id: string | null; name: string; decisions: Decision[] }[] {
  const groups = new Map<string | null, Decision[]>();
  for (const decision of decisions) {
    const id = decisionScopeId(decision, state);
    const items = groups.get(id);
    if (items) items.push(decision); else groups.set(id, [decision]);
  }
  return [...groups].map(([id, items]) => ({ id, name: id === null ? '전체' : state.scopes.find(scope => scope.id === id)?.name ?? '삭제된 프로젝트', decisions: items }));
}
