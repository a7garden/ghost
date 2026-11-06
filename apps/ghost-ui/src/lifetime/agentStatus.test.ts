import { describe, expect, it } from 'vitest';
import type { ConversationRun, Goal, Snapshot, Work } from '../../../../contracts/lifetime/bindings.ts';
import { createAgentStatusReadFence, elapsedAgentTime, projectAgentStatus, runAgentStatusOwnerRead } from './agentStatus';
import type { AgentStatusReadToken } from './agentStatus';

const target = { ghost_id: 'ghost-a', conversation_id: 'conversation-a' };
const goal: Goal = {
  id: 'goal-a', revision: 2, requirement_digest: 'digest', prompt: '실제 목표',
  accountable_ghost: target.ghost_id, reply_conversation: target.conversation_id,
  privacy: 'local_only', state: 'active', acceptance_spec: {},
};
const work: Work = {
  id: 'work-a', goal_id: goal.id, goal_revision: 2, owner: 'specialist-a', owner_revision: 1,
  state: 'running', execution_id: 'execution-a', cancellation: 'none', blocker: null,
};
const run: ConversationRun = {
  ...target, turn_id: 'turn-a', state: 'running', cancel_requested: false,
  cancel_command_id: null, submission_id: 'submission-a', entry_id: null,
  reason_code: null, latest_status_command_id: 'status-a', created_at_ms: 10_000, updated_at_ms: 15_000,
};
function snapshot(goals: Goal[] = [], items: Work[] = []): Snapshot {
  return { protocol_version: 'ghost-lifetime/1', contract_revision: 1, mode: 'live',
    goals, work: items, bindings: [], artifacts: [], acceptances: [] };
}
function project(items: Work[] = [], runs: ConversationRun[] = [], goals: Goal[] = [goal]) {
  return projectAgentStatus({ target, snapshot: snapshot(goals, items), runs, availability: 'current' });
}

describe('agent status from Host records', () => {
  it('keeps both Ghost and conversation fences, including foreign work and controller runs', () => {
    const foreignGhost = { ...goal, id: 'foreign-ghost', accountable_ghost: 'ghost-b' };
    const foreignConversation = { ...goal, id: 'foreign-conversation', reply_conversation: 'conversation-b' };
    const model = project([
      { ...work, goal_id: foreignGhost.id }, { ...work, id: 'work-b', goal_id: foreignConversation.id },
    ], [{ ...run, ghost_id: 'ghost-b' }, { ...run, turn_id: 'turn-b', conversation_id: 'conversation-b' }], [foreignGhost, foreignConversation]);
    expect(model.state).toBe('ready');
    expect(model.observations).toEqual([]);
  });

  it('hides all previous pair records while a new conversation loads', () => {
    const model = projectAgentStatus({ target, snapshot: snapshot([goal], [work]), runs: [run], availability: 'loading' });
    expect(model.state).toBe('loading');
    expect(model.observations).toEqual([]);
    expect(model.current).toBeNull();
  });

  it('never turns an answered Owner response into accepted work', () => {
    const model = project([{ ...work, state: 'completed' }], [{ ...run, state: 'answered' }]);
    expect(model.state).toBe('verifying');
    expect(model.label).toContain('검수 전');
    expect(model.observations.find(item => item.kind === 'response')?.state).toBe('responded');
  });

  it('only shows work accepted when the Host work state is accepted', () => {
    expect(project([{ ...work, state: 'accepted' }]).state).toBe('accepted');
    expect(project([{ ...work, state: 'accepted' }], [{ ...run, state: 'answered' }]).state).toBe('accepted');
    expect(project([{ ...work, state: 'complete' }]).state).toBe('verifying');
  });

  it.each([
    ['queued', 'queued'], ['running', 'running'], ['steering', 'running'], ['verifying', 'verifying'], ['blocked', 'needs_input'],
    ['unknown', 'unknown'], ['stale', 'stale'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['unrecognized', 'unknown'],
  ])('projects actual Work state %s as %s', (state, expected) => {
    expect(project([{ ...work, state }]).state).toBe(expected);
  });

  it('keeps the actual blocker and never substitutes an invented next step', () => {
    const model = project([{ ...work, state: 'blocked', blocker: 'Owner 입력 필요' }]);
    expect(model.detail).toBe('Owner 입력 필요');
    expect(model.observations).toHaveLength(1);
  });

  it('does not show a revised goal’s previous accepted result as current acceptance', () => {
    const model = project([{ ...work, state: 'accepted', goal_revision: 1 }], [{ ...run, state: 'answered' }]);
    expect(model.state).toBe('stale');
    expect(model.label).toBe('이전 목표 결과');
  });

  it('keeps a recorded goal visible before work has been assigned', () => {
    expect(project([], [], [{ ...goal, state: 'blocked' }]).state).toBe('needs_input');
    expect(project([], [], [{ ...goal, state: 'queued' }]).state).toBe('queued');
  });

  it('does not call an unavailable Host ready, running or complete', () => {
    const model = projectAgentStatus({ target, snapshot: snapshot([goal], [{ ...work, state: 'accepted' }]), runs: [], availability: 'unavailable' });
    expect(model.state).toBe('unknown');
    expect(model.observations[0]?.state).toBe('accepted');
    expect(projectAgentStatus({ target, snapshot: null, runs: [], availability: 'current' }).state).toBe('unknown');
  });

  it('does not let an old failed answer mask the newest saved answer', () => {
    const model = project([], [{ ...run, state: 'failed' }, { ...run, turn_id: 'new', state: 'answered', created_at_ms: 20_000, updated_at_ms: 30_000 }], []);
    expect(model.state).toBe('responded');
    expect(model.label).toBe('응답 저장됨');
  });

  it('keeps an unresolved response visible after a later answer', () => {
    const model = project([], [{ ...run, state: 'effect_unknown' }, { ...run, turn_id: 'new', state: 'answered', created_at_ms: 20_000, updated_at_ms: 30_000 }], []);
    expect(model.state).toBe('unknown');
    expect(model.current?.cancelTurnID).toBeUndefined();
  });

  it('never equates a requested cancellation with confirmed stopping', () => {
    const model = project([], [{ ...run, cancel_requested: true, cancel_command_id: 'cancel-a' }], []);
    expect(model.state).toBe('running');
    expect(model.label).toBe('응답 취소 요청됨');
    expect(model.current?.cancelTurnID).toBeUndefined();
    expect(project([{ ...work, cancellation: 'requested' }]).state).toBe('running');
  });

  it('names each response by its message and each work item by its goal', () => {
    const model = projectAgentStatus({ target, snapshot: snapshot([goal], [work]), availability: 'current',
      runs: [run, { ...run, turn_id: 'turn-b', created_at_ms: 20_000 }],
      turns: [{ id: 'turn-a', text: '첫 메시지\n둘째 줄' }, { id: 'turn-b', text: '다음 메시지' }] });
    expect(model.observations.map(item => item.subject)).toEqual(['실제 목표', '다음 메시지', '첫 메시지']);
  });
});

describe('Host timestamp elapsed time', () => {
  const minute = 60_000;
  it('uses the original Host start across rerenders and does not reset on a read', () => {
    const model = project([], [run], []);
    expect(elapsedAgentTime(model.current, run.created_at_ms + 30_000)).toBe('1분 미만');
    expect(elapsedAgentTime(model.current, run.created_at_ms + 9 * minute)).toBe('9분');
    expect(elapsedAgentTime(project([], [run], []).current, run.created_at_ms + 110 * minute)).toBe('1시간 50분');
    expect(elapsedAgentTime(model.current, run.created_at_ms + 120 * minute)).toBe('2시간');
  });

  it('freezes terminal runs at the Host update time', () => {
    for (const state of ['answered', 'failed', 'cancelled'] as const) {
      const model = project([], [{ ...run, state, updated_at_ms: run.created_at_ms + 5 * minute }], []);
      expect(elapsedAgentTime(model.current, run.created_at_ms + 6 * minute)).toBe('5분');
      expect(elapsedAgentTime(model.current, run.created_at_ms + 60 * minute)).toBe('5분');
    }
  });

  it('freezes an uncertain read at its last Host timestamp', () => {
    const later = { ...run, updated_at_ms: run.created_at_ms + 3 * minute };
    expect(elapsedAgentTime(project([], [later], []).current, run.created_at_ms + 9 * minute, false)).toBe('3분');
    expect(elapsedAgentTime(project([], [{ ...later, state: 'effect_unknown' }], []).current, run.created_at_ms + 9 * minute)).toBe('3분');
  });

  it('shows no time for missing Work time and invalid Host timestamp order', () => {
    expect(elapsedAgentTime(project([work]).current, 90_000)).toBeNull();
    expect(elapsedAgentTime(project([], [{ ...run, state: 'answered', updated_at_ms: 1 }], []).current, 90_000)).toBeNull();
    expect(elapsedAgentTime(null, 90_000)).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

describe('shared snapshot read ordering', () => {
  it('rejects an older poll resolved after an Owner refresh without reviving its accepted goal revision or freshness time', async () => {
    const fence = createAgentStatusReadFence();
    const scope = JSON.stringify([target.ghost_id, target.conversation_id]);
    const oldPoll = deferred<{ snapshot: Snapshot; observedAt: number }>();
    const ownerRefresh = deferred<{ snapshot: Snapshot; observedAt: number }>();
    let saved = { snapshot: snapshot(), observedAt: 0 };
    async function observe(result: typeof oldPoll) {
      const read = fence.begin(scope);
      const value = await result.promise;
      if (fence.isCurrent(read, scope)) saved = value;
    }
    const polling = observe(oldPoll);
    const refreshing = observe(ownerRefresh);
    ownerRefresh.resolve({ snapshot: snapshot([{ ...goal, revision: 3 }], [{ ...work, goal_revision: 3, state: 'queued' }]), observedAt: 200 });
    await refreshing;
    oldPoll.resolve({ snapshot: snapshot([goal], [{ ...work, state: 'accepted' }]), observedAt: 300 });
    await polling;
    expect(saved.snapshot.goals[0]?.revision).toBe(3);
    expect(saved.observedAt).toBe(200);
    expect(projectAgentStatus({ target, snapshot: saved.snapshot, runs: [], availability: 'current' }).state).toBe('queued');
  });

  it('does not let an older failed read invalidate a newer successful read', async () => {
    const fence = createAgentStatusReadFence();
    const oldPoll = deferred<number>();
    const ownerRefresh = deferred<number>();
    let observedAt = 0;
    let warning = '';
    async function observe(result: typeof oldPoll) {
      const read = fence.begin('selected-pair');
      try {
        const value = await result.promise;
        if (fence.isCurrent(read, 'selected-pair')) { observedAt = value; warning = ''; }
      } catch {
        if (fence.isCurrent(read, 'selected-pair')) warning = 'unavailable';
      }
    }
    const polling = observe(oldPoll);
    const refreshing = observe(ownerRefresh);
    ownerRefresh.resolve(200);
    await refreshing;
    oldPoll.reject(new Error('old connection failed'));
    await polling;
    expect(observedAt).toBe(200);
    expect(warning).toBe('');
  });

  it('rejects deferred callbacks after pair change, even if the Owner returns to the original pair', async () => {
    const fence = createAgentStatusReadFence();
    const result = deferred<number>();
    let scope = 'pair-a';
    let observedAt = 0;
    const read = fence.begin(scope);
    const completion = result.promise.then(value => { if (fence.isCurrent(read, scope)) observedAt = value; });
    scope = 'pair-b';
    expect(fence.isCurrent(read, scope)).toBe(false);
    fence.invalidate();
    scope = 'pair-a';
    result.resolve(300);
    await completion;
    expect(observedAt).toBe(0);
  });

  it('rejects deferred callbacks and new reads after unmount, including a later effect reactivation', async () => {
    const fence = createAgentStatusReadFence();
    const result = deferred<number>();
    let observedAt = 0;
    const read = fence.begin('pair-a');
    const completion = result.promise.then(value => { if (fence.isCurrent(read, 'pair-a')) observedAt = value; });
    fence.deactivate();
    expect(fence.begin('pair-a')).toBeNull();
    fence.activate();
    result.resolve(300);
    await completion;
    expect(observedAt).toBe(0);
    expect(fence.isCurrent(fence.begin('pair-a'), 'pair-a')).toBe(true);
  });
});

describe('Owner bundle lifecycle used by LifetimeView', () => {
  it('settles loading on a current replacement failure and allows a successful retry after the stale initial read', async () => {
    const fence = createAgentStatusReadFence();
    const foregroundReads = new Set<AgentStatusReadToken>();
    const initial = deferred<string>();
    const replacement = deferred<string>();
    let scope = 'pair-a';
    let loading = true;
    let warning = '';
    let saved = '';
    const read = (source: typeof initial) => runAgentStatusOwnerRead({
      fence, foregroundReads, currentScope: () => scope, fetch: () => source.promise,
      onSuccess: value => { saved = value; warning = ''; },
      onError: () => { warning = 'unavailable'; },
      onSettled: () => { loading = false; },
    });
    const initialResult = read(initial);
    scope = 'pair-b';
    fence.invalidate();
    const replacementResult = read(replacement);
    replacement.reject(new Error('replacement bundle failed'));
    expect(await replacementResult).toBe(false);
    expect(loading).toBe(false);
    expect(warning).toBe('unavailable');
    initial.resolve('stale initial bundle');
    expect(await initialResult).toBe(false);
    expect(saved).toBe('');
    expect(foregroundReads.size).toBe(0);
    const retry = deferred<string>();
    const retryResult = read(retry);
    retry.resolve('current replacement bundle');
    expect(await retryResult).toBe(true);
    expect(saved).toBe('current replacement bundle');
    expect(warning).toBe('');
  });

  it('keeps loading pending when the superseded initial read fails before the current replacement settles', async () => {
    const fence = createAgentStatusReadFence();
    const foregroundReads = new Set<AgentStatusReadToken>();
    const initial = deferred<string>();
    const replacement = deferred<string>();
    let scope = 'pair-a';
    let loading = true;
    let warning = '';
    const read = (source: typeof initial) => runAgentStatusOwnerRead({
      fence, foregroundReads, currentScope: () => scope, fetch: () => source.promise,
      onSuccess: () => {}, onError: () => { warning = 'unavailable'; }, onSettled: () => { loading = false; },
    });
    const initialResult = read(initial);
    scope = 'pair-b'; fence.invalidate();
    const replacementResult = read(replacement);
    initial.reject(new Error('superseded initial request failed'));
    await initialResult;
    expect(loading).toBe(true);
    expect(warning).toBe('');
    replacement.resolve('current bundle');
    await replacementResult;
    expect(loading).toBe(false);
    expect(foregroundReads.size).toBe(0);
  });

  it('starts the queued Owner refresh with the committed selection scope and retains its complete bundle', async () => {
    const fence = createAgentStatusReadFence();
    const foregroundReads = new Set<AgentStatusReadToken>();
    const old = deferred<{ registry: string[]; pending: string[] }>();
    const selected = deferred<{ registry: string[]; pending: string[] }>();
    let committedScope = 'pair-a';
    let saved = { registry: ['pair-a'], pending: [] as string[] };
    let settlements = 0;
    const requestedScopes: string[] = [];
    const read = (source: typeof old) => runAgentStatusOwnerRead({
      fence, foregroundReads, currentScope: () => committedScope,
      fetch: () => { requestedScopes.push(committedScope); return source.promise; },
      onSuccess: value => { saved = value; }, onError: () => {}, onSettled: () => { settlements++; },
    });
    const oldResult = read(old);
    // LifetimeView queues refresh via an effect; commit/invalidation precede the next bundle start.
    const afterSelectionCommit = () => read(selected);
    committedScope = 'pair-b'; fence.invalidate();
    const selectedResult = afterSelectionCommit();
    selected.resolve({ registry: ['pair-a', 'pair-b'], pending: ['pair-b-original-request'] });
    expect(await selectedResult).toBe(true);
    old.resolve({ registry: ['pair-a'], pending: [] });
    expect(await oldResult).toBe(false);
    expect(requestedScopes).toEqual(['pair-a', 'pair-b']);
    expect(saved).toEqual({ registry: ['pair-a', 'pair-b'], pending: ['pair-b-original-request'] });
    expect(settlements).toBe(1);
  });

  it('suppresses success, error and settlement callbacks after unmount', async () => {
    const fence = createAgentStatusReadFence();
    const foregroundReads = new Set<AgentStatusReadToken>();
    const result = deferred<string>();
    const callbacks: string[] = [];
    const reading = runAgentStatusOwnerRead({
      fence, foregroundReads, currentScope: () => 'pair-a', fetch: () => result.promise,
      onSuccess: () => { callbacks.push('success'); }, onError: () => { callbacks.push('error'); }, onSettled: () => { callbacks.push('settled'); },
    });
    fence.deactivate();
    result.reject(new Error('late failure'));
    expect(await reading).toBe(false);
    expect(callbacks).toEqual([]);
    expect(foregroundReads.size).toBe(0);
  });
});
