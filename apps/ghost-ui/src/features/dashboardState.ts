import type { Snapshot as LifetimeSnapshot } from '../../../../contracts/lifetime/bindings.ts';
import { taskDisplayLabel } from '../client/taskLabel';
import { isRunning, phaseLabel, type Snapshot } from '../client/types';

export interface DashboardTask {
  id: string;
  title: string;
  ghostId: string;
  state: string;
  label: string;
  tone: 'running' | 'attention' | 'neutral' | 'success';
  path: string;
}

interface DashboardWork {
  tasks: DashboardTask[];
  running: number;
  attention: number;
  accepted: number;
  source: 'lifetime' | 'legacy' | 'unavailable';
}

const lifetimeStates = new Map<string, [DashboardTask['tone'], string]>([
  ['queued', ['neutral', '작업 대기']],
  ['submitted', ['neutral', '작업 접수됨']],
  ['active', ['running', '진행 중']],
  ['running', ['running', '진행 중']],
  ['steering', ['running', '진행 방향 전달됨']],
  ['steer_requested', ['running', '진행 방향 전달됨']],
  ['verifying', ['running', '결과 검수 중']],
  ['completed', ['attention', '실행 종료 · 검수 전']],
  ['complete', ['attention', '실행 종료 · 검수 전']],
  ['blocked', ['attention', '작업 대기 사유 확인']],
  ['waiting', ['attention', '작업 대기 사유 확인']],
  ['waiting_owner', ['attention', '확인 필요']],
  ['needs_input', ['attention', '입력 필요']],
  ['unknown', ['attention', '실행 결과 확인 필요']],
  ['effect_unknown', ['attention', '실행 결과 확인 필요']],
  ['uncertain', ['attention', '실행 결과 확인 필요']],
  ['failed', ['attention', '실패']],
  ['rejected', ['attention', '반려됨']],
  ['cancel_requested', ['attention', '취소 확인 중']],
]);

const cancellationInProgress = new Set(['requested', 'acknowledged', 'stopped', 'reconciled']);
const legacyAttention = new Set(['waiting_owner', 'failed', 'uncertain', 'blocked', 'waiting']);
const priority: Record<DashboardTask['tone'], number> = { attention: 0, running: 1, neutral: 2, success: 3 };

export function projectDashboardWork(workspace: Snapshot, lifetime?: LifetimeSnapshot): DashboardWork {
  if (workspace.lifetime_authority && !lifetime) {
    return { tasks: [], running: 0, attention: 0, accepted: 0, source: 'unavailable' };
  }

  const tasks: DashboardTask[] = [];
  let accepted = 0;
  const source = workspace.lifetime_authority ? 'lifetime' : 'legacy';

  if (source === 'lifetime' && lifetime) {
    const goals = new Map(lifetime.goals.map(goal => [goal.id, goal]));
    for (const work of lifetime.work) {
      const goal = goals.get(work.goal_id);
      if (!goal || goal.revision !== work.goal_revision || work.state === 'stale') continue;
      if (work.state === 'accepted') { accepted++; continue; }
      if (work.state === 'cancelled' || work.state === 'canceled' || goal.state === 'cancelled' || goal.state === 'accepted') continue;
      const cancelPending = cancellationInProgress.has(work.cancellation) && work.state !== 'failed' && work.state !== 'rejected';
      const state = cancelPending ? 'cancel_requested' : work.state;
      const [tone, label] = lifetimeStates.get(state) ?? ['attention', '작업 상태 확인 필요'];
      const query = new URLSearchParams({ panel: 'work', scope: 'all', ghost: goal.accountable_ghost, conversation: goal.reply_conversation, goal: goal.id, work: work.id });
      tasks.push({ id: work.id, title: goal.prompt, ghostId: work.owner, state, label, tone, path: `/lifetime?${query}` });
    }
  } else if (source === 'legacy') {
    for (const profile of workspace.profiles) {
      for (const conversation of profile.conversations) {
        const path = `/ghosts/${encodeURIComponent(profile.id)}?conversation=${encodeURIComponent(conversation.id)}`;
        for (const task of conversation.tasks) {
          if (!isRunning(task.phase) && !legacyAttention.has(task.phase)) continue;
          const tone = legacyAttention.has(task.phase) ? 'attention' : task.phase === 'queued' ? 'neutral' : 'running';
          const label = task.phase === 'blocked' || task.phase === 'waiting' ? '작업 대기 사유 확인' : phaseLabel(task.phase);
          tasks.push({ id: `${path}#${task.id}`, title: taskDisplayLabel(task, conversation), ghostId: profile.id, state: task.phase, label, tone, path });
        }
      }
    }
  }

  tasks.sort((left, right) => priority[left.tone] - priority[right.tone]);
  return {
    tasks, accepted, source,
    running: tasks.filter(task => task.tone === 'running').length,
    attention: tasks.filter(task => task.tone === 'attention').length,
  };
}
