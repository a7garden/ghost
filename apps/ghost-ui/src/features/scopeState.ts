import { TERMINAL_WORK_STATES, type Decision, type State } from '@ghost/contract';

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

/** What one project has in flight: its Work newest first, split live and settled, and what waits on the owner. */
export function projectWork(state: Pick<State, 'works' | 'decisions'>, scopeId: string) {
  const works = state.works.filter(work => work.scopeId === scopeId).sort((a, b) => b.updatedAt - a.updatedAt);
  const pending = state.decisions.filter(decision => decision.state === 'pending' && decisionScopeId(decision, state) === scopeId).sort((a, b) => a.createdAt - b.createdAt);
  return { works, live: works.filter(work => !TERMINAL_WORK_STATES.includes(work.state)), settled: works.filter(work => TERMINAL_WORK_STATES.includes(work.state)), pending };
}
