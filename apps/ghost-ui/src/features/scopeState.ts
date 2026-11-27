import { TERMINAL_WORK_STATES, type Decision, type State, type Work } from '@ghost/contract';
import { handedOver } from './ghostState';

function proposalScope(decision: Decision): string | null {
  const id = decision.proposal?.scopeId;
  return typeof id === 'string' ? id : null;
}

function decisionScope(decision: Decision, workScopes: ReadonlyMap<string, string | null>): string | null {
  return decision.workId ? workScopes.get(decision.workId) ?? null : proposalScope(decision);
}

/** A receiving Ghost may own several scopes, so its identity is never a scope fallback. */
export function decisionScopeId(decision: Decision, state: Pick<State, 'works'>): string | null {
  return decision.workId ? state.works.find(work => work.id === decision.workId)?.scopeId ?? null : proposalScope(decision);
}

export function groupDecisionsByScope(decisions: Decision[], state: Pick<State, 'works' | 'scopes'>): { id: string | null; name: string; decisions: Decision[] }[] {
  const groups = new Map<string | null, Decision[]>();
  const workScopes = new Map(state.works.map(work => [work.id, work.scopeId]));
  for (const decision of decisions) {
    const id = decisionScope(decision, workScopes);
    const items = groups.get(id);
    if (items) items.push(decision); else groups.set(id, [decision]);
  }
  return [...groups].map(([id, items]) => ({ id, name: id === null ? '전체' : state.scopes.find(scope => scope.id === id)?.name ?? '삭제된 프로젝트', decisions: items }));
}

/** What one project has in flight: its Work newest first, split live and settled, and what waits on the owner. */
export function projectWork(state: Pick<State, 'works' | 'decisions'>, scopeId: string) {
  const works = state.works.filter(work => work.scopeId === scopeId).sort((a, b) => b.updatedAt - a.updatedAt);
  const workIds = new Set(works.map(work => work.id));
  const pending = state.decisions.filter(decision => decision.state === 'pending' && (decision.workId ? workIds.has(decision.workId) : proposalScope(decision) === scopeId)).sort((a, b) => a.createdAt - b.createdAt);
  return { works, live: works.filter(work => !TERMINAL_WORK_STATES.includes(work.state)), settled: works.filter(work => TERMINAL_WORK_STATES.includes(work.state)), pending };
}

/** What one project row in the directory needs: what waits on the owner, what runs, what finished. */
export interface ScopeDigest {
  /** Pending decisions that are the owner's turn; ones handed to the main Ghost wait elsewhere. */
  waiting: number;
  decision: Decision | null;
  live: number;
  liveWork: Work | null;
  settledWork: Work | null;
}

/**
 * One pass over Works and decisions answers every project row — oldest owner decision, newest live Work,
 * newest settled result per scope — instead of filtering and sorting the whole ledger once per project.
 */
export function scopeDigests(state: Pick<State, 'works' | 'decisions'>): Map<string, ScopeDigest> {
  const workScope = new Map<string, string | null>();
  const digests = new Map<string, ScopeDigest>();
  const digestOf = (scopeId: string | null): ScopeDigest | null => {
    if (scopeId === null) return null;
    let digest = digests.get(scopeId);
    if (!digest) digests.set(scopeId, digest = { waiting: 0, decision: null, live: 0, liveWork: null, settledWork: null });
    return digest;
  };
  for (const work of state.works) {
    workScope.set(work.id, work.scopeId);
    const digest = digestOf(work.scopeId);
    if (!digest) continue;
    if (TERMINAL_WORK_STATES.includes(work.state)) {
      const at = work.endedAt ?? work.updatedAt;
      if (!digest.settledWork || at > (digest.settledWork.endedAt ?? digest.settledWork.updatedAt)) digest.settledWork = work;
    } else {
      digest.live += 1;
      if (!digest.liveWork || work.updatedAt > digest.liveWork.updatedAt) digest.liveWork = work;
    }
  }
  for (const decision of state.decisions) {
    if (decision.state !== 'pending' || handedOver(decision)) continue;
    const digest = digestOf(decisionScope(decision, workScope));
    if (!digest) continue;
    digest.waiting += 1;
    if (!digest.decision || decision.createdAt < digest.decision.createdAt) digest.decision = decision;
  }
  return digests;
}
