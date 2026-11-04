import { describe, expect, it } from 'vitest';
import { CONTRACT_REVISION, VERSION, type Goal, type Response, type Snapshot as LifetimeSnapshot, type Work } from '../../../../contracts/lifetime/bindings.ts';
import type { Envelope, Snapshot } from '../client/types';
import { createLifetimeControlTransport } from '../lifetime/controlTransport';
import { projectDashboardWork } from './dashboardState';

const legacy: Snapshot = {
  workspace_id: 'workspace', default_model: 'mock',
  profiles: [{
    id: 'legacy-ghost', name: 'Ghost', persona: '', policy: {},
    conversations: [{
      id: 'test chat', title: 'legacy conversation', model: 'mock', offline: false, messages: [],
      tasks: ['model_running', 'queued', 'waiting_owner', 'uncertain', 'complete', 'cancelled'].map(phase => ({
        id: phase, name: '응답 생성', phase, partial: '', output: '',
      })),
    }],
  }],
  reviews: [], goals: [], schedules: [], spaces: [], delegations: [], todos: [], calendar_events: [], avatars: [], integrations: [],
  capabilities: {}, connectors: {},
};
const workspace: Snapshot = { ...legacy, lifetime_authority: { authority_epoch: 2, dispatch_enabled: true } };
const goal: Goal = {
  id: 'goal', revision: 2, requirement_digest: 'a'.repeat(64), prompt: 'current task', accountable_ghost: 'primary',
  reply_conversation: 'primary room', privacy: 'private', state: 'open', acceptance_spec: {},
};
const work = (id: string, state: string, overrides: Partial<Work> = {}): Work => ({
  id, state, goal_id: goal.id, goal_revision: 2, owner: 'specialist', owner_revision: 1, execution_id: null,
  cancellation: 'none', blocker: null, ...overrides,
});
const lifetime = (entries: Work[], goals: Goal[] = [goal]): LifetimeSnapshot => ({
  protocol_version: VERSION, contract_revision: CONTRACT_REVISION, mode: 'live',
  goals, work: entries, bindings: [], artifacts: [], acceptances: [],
});

describe('dashboard work projection', () => {
  it('does not treat legacy tasks as a live Lifetime total before the authoritative read', () => {
    expect(projectDashboardWork(workspace)).toEqual({
      source: 'unavailable', tasks: [], running: 0, attention: 0, accepted: 0,
    });
    expect(projectDashboardWork(workspace, lifetime([]))).toMatchObject({ source: 'lifetime', tasks: [], running: 0 });
  });

  it('includes only current work and distinguishes execution, review and explicit acceptance', () => {
    const projection = projectDashboardWork(workspace, lifetime([
      work('running', 'running'), work('completed', 'completed'), work('accepted', 'accepted'), work('cancelled', 'cancelled'),
      work('old-running', 'running', { goal_revision: 1 }), work('old-accepted', 'accepted', { goal_revision: 1 }),
      work('stale', 'stale'), work('orphan', 'running', { goal_id: 'missing' }),
      work('queued', 'queued'), work('submitted', 'submitted'),
    ]));
    expect(projection).toMatchObject({ source: 'lifetime', running: 1, attention: 1, accepted: 1 });
    expect(projection.tasks.map(({ id, tone }) => [id, tone])).toEqual([
      ['completed', 'attention'], ['running', 'running'], ['queued', 'neutral'], ['submitted', 'neutral'],
    ]);
    expect(projection.tasks[0]).toMatchObject({
      title: 'current task', ghostId: 'specialist', state: 'completed', label: '실행 종료 · 검수 전',
      path: '/lifetime?panel=work&scope=all&ghost=primary&conversation=primary+room&goal=goal&work=completed',
    });
  });

  it('keeps blocked, waiting, uncertain and failed tasks actionable without counting pending cancellation as running', () => {
    const entries = ['blocked', 'waiting_owner', 'effect_unknown', 'failed', 'unknown_state'].map(state => work(state, state));
    entries.push(work('cancelling', 'running', { cancellation: 'requested' }));
    const projection = projectDashboardWork(workspace, lifetime(entries));
    expect(projection).toMatchObject({ running: 0, attention: 6, accepted: 0 });
    expect(projection.tasks.find(task => task.id === 'cancelling')).toMatchObject({ state: 'cancel_requested', label: '취소 확인 중' });
    expect(projection.tasks.find(task => task.id === 'unknown_state')).toMatchObject({ label: '작업 상태 확인 필요' });
  });

  it('projects legacy conversation tasks only for workspaces without Lifetime authority', () => {
    const projection = projectDashboardWork(legacy, lifetime([work('running', 'running')]));
    expect(projection).toMatchObject({ source: 'legacy', running: 1, attention: 2, accepted: 0 });
    expect(projection.tasks.map(task => task.state)).toEqual(['waiting_owner', 'uncertain', 'model_running', 'queued']);
    expect(projection.tasks[0]).toMatchObject({ title: 'legacy conversation', path: '/ghosts/legacy-ghost?conversation=test%20chat' });
  });

  it('reads Lifetime work with the owner epoch and a snapshot-only authenticated envelope', async () => {
    const commands: Envelope[] = [];
    const data = lifetime([work('running', 'running')]);
    const reply: Response = {
      status: 'success', summary: '', object_refs: [], artifacts: [], next_actions: [], error_code: null, retry_class: 'never', data,
    };
    const transport = createLifetimeControlTransport(async envelope => {
      commands.push(envelope);
      return reply;
    }, { actor_ref: 'owner', authority_epoch: 2 });
    expect(await transport.snapshot()).toEqual(data);
    expect(commands).toMatchObject([{
      command: { type: 'lifetime', envelope: { actor_ref: 'owner', authority_epoch: 2, body: { method: 'snapshot' } } },
    }]);
  });
});
