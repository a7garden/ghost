import type { ConversationRun, Goal, Snapshot, Work } from '../../../../contracts/lifetime/bindings.ts';
import { workThreadTitle } from './workThread';

export interface AgentStatusReadToken { generation: number; scope: string }

/** One ordering fence for every snapshot reader, including failure/freshness callbacks. */
export function createAgentStatusReadFence() {
  let generation = 0;
  let active = true;
  return {
    activate() { active = true; generation++; },
    deactivate() { active = false; generation++; },
    invalidate() { generation++; },
    begin(scope: string): AgentStatusReadToken | null {
      return active ? { generation: ++generation, scope } : null;
    },
    isCurrent(token: AgentStatusReadToken | null, scope: string): boolean {
      return active && token !== null && token.generation === generation && token.scope === scope;
    },
  };
}

/** Shared Owner bundle lifecycle: current failures settle loading just as current successes do. */
export async function runAgentStatusOwnerRead<T>({ fence, foregroundReads, currentScope, fetch, onSuccess, onError, onSettled }: {
  fence: ReturnType<typeof createAgentStatusReadFence>;
  foregroundReads: Set<AgentStatusReadToken>;
  currentScope: () => string;
  fetch: () => Promise<T>;
  onSuccess: (value: T, read: AgentStatusReadToken) => boolean | void;
  onError: (reason: unknown) => void;
  onSettled: () => void;
}): Promise<boolean> {
  const read = fence.begin(currentScope());
  if (!read) return false;
  foregroundReads.add(read);
  try {
    const value = await fetch();
    if (!fence.isCurrent(read, currentScope())) return false;
    return onSuccess(value, read) !== false;
  } catch (reason) {
    if (fence.isCurrent(read, currentScope())) onError(reason);
    return false;
  } finally {
    foregroundReads.delete(read);
    if (fence.isCurrent(read, currentScope())) onSettled();
  }
}

export type AgentActivityState = 'ready' | 'loading' | 'queued' | 'running' | 'verifying' | 'needs_input' | 'responded' | 'accepted' | 'cancelled' | 'failed' | 'unknown' | 'stale';
export interface AgentObservation {
  id: string;
  kind: 'response' | 'work' | 'goal';
  state: AgentActivityState;
  label: string;
  /** What the activity is about: the Owner message or the goal title. */
  subject: string | null;
  detail: string | null;
  startedAt: number | null;
  endedAt: number | null;
  observedAt: number | null;
  runningClock: boolean;
  workID?: string;
  cancelTurnID?: string;
}
export interface AgentStatusModel {
  state: AgentActivityState;
  label: string;
  detail: string | null;
  current: AgentObservation | null;
  observations: AgentObservation[];
}
export interface AgentStatusInput {
  target?: { ghost_id: string; conversation_id: string };
  snapshot: Snapshot | null;
  runs: Iterable<ConversationRun>;
  /** Owner messages of the selected conversation, used to name each response. */
  turns?: Iterable<{ id: string; text: string }>;
  availability: 'loading' | 'current' | 'unavailable';
}

const terminalRuns = new Set<ConversationRun['state']>(['answered', 'failed', 'cancelled']);
const priority: Record<AgentActivityState, number> = {
  unknown: 0, stale: 1, needs_input: 2, running: 3, verifying: 4, queued: 5,
  failed: 6, cancelled: 7, accepted: 8, responded: 9, ready: 10, loading: 10,
};

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function responseObservation(run: ConversationRun, text: string | undefined): AgentObservation {
  const labels: Record<ConversationRun['state'], string> = {
    queued: '응답 대기 중', running: '응답 작성 중', answered: '응답 저장됨',
    failed: '응답 실행 실패', cancelled: '응답 취소 확인됨', effect_unknown: '응답 상태 확인 필요',
  };
  const state = run.state === 'effect_unknown' ? 'unknown' : run.state === 'answered' ? 'responded' : run.state;
  const pendingCancellation = run.cancel_requested && !terminalRuns.has(run.state);
  return {
    id: `response:${run.turn_id}`, kind: 'response', state, subject: text ? workThreadTitle(text) : null,
    label: pendingCancellation ? '응답 취소 요청됨' : labels[run.state],
    detail: pendingCancellation ? '중지 확인 전입니다.' : run.state === 'answered' ? '응답 저장과 맡긴 일의 검수는 별개입니다.' : null,
    startedAt: timestamp(run.created_at_ms),
    endedAt: terminalRuns.has(run.state) ? timestamp(run.updated_at_ms) : null,
    observedAt: timestamp(run.updated_at_ms),
    runningClock: run.state === 'queued' || run.state === 'running',
    ...(!run.cancel_requested && (run.state === 'queued' || run.state === 'running') ? { cancelTurnID: run.turn_id } : {}),
  };
}

function workObservation(work: Work, goal: Goal): AgentObservation {
  let state: AgentActivityState;
  let label: string;
  if (work.goal_revision !== goal.revision || work.state === 'stale') {
    state = 'stale'; label = '이전 목표 결과';
  } else {
    const states: Record<string, [AgentActivityState, string]> = {
      queued: ['queued', '작업 배정 대기'], active: ['running', '맡긴 일 진행 중'], running: ['running', '맡긴 일 진행 중'],
      verifying: ['verifying', '결과 검수 중'], completed: ['verifying', '실행 종료 · 검수 전'], complete: ['verifying', '실행 종료 · 검수 확인 필요'],
      accepted: ['accepted', '맡긴 일 검수 완료'], cancelled: ['cancelled', '맡긴 일 취소됨'],
      failed: ['failed', '맡긴 일 실패'], rejected: ['failed', '맡긴 일 반려됨'],
      blocked: ['needs_input', '맡긴 일 대기 중'], needs_input: ['needs_input', '입력 필요'],
      unknown: ['unknown', '실행 결과 확인 필요'], effect_unknown: ['unknown', '실행 결과 확인 필요'],
      steering: ['running', '진행 방향 전달됨'], steer_requested: ['running', '진행 방향 전달됨'],
    };
    [state, label] = states[work.state] ?? ['unknown', '작업 상태 확인 필요'];
  }
  const cancelPending = ['requested', 'acknowledged', 'stopped', 'reconciled'].includes(work.cancellation)
    && !['accepted', 'cancelled', 'failed'].includes(state);
  return {
    id: `work:${work.id}`, kind: 'work', state,
    label: cancelPending ? '작업 취소 확인 중' : label, subject: workThreadTitle(goal.prompt),
    detail: work.blocker || (cancelPending ? '취소 요청과 실행 중지 확인은 별개입니다.' : null),
    // The frozen Snapshot contract has no Work timestamps. Never start a timer at render/fetch time.
    startedAt: null, endedAt: null, observedAt: null, runningClock: false, workID: work.id,
  };
}

function goalObservation(goal: Goal): AgentObservation {
  const states: Record<string, [AgentActivityState, string]> = {
    open: ['queued', '목표 접수됨'], queued: ['queued', '목표 배정 대기'], active: ['running', '목표 진행 중'],
    blocked: ['needs_input', '목표 대기 중'], verifying: ['verifying', '목표 검수 중'],
    accepted: ['accepted', '목표 검수 완료'], complete: ['verifying', '목표 완료 · 검수 확인 필요'],
    cancelled: ['cancelled', '목표 취소됨'], rejected: ['failed', '목표 반려됨'],
  };
  const [state, label] = states[goal.state] ?? ['unknown', '목표 상태 확인 필요'];
  return { id: `goal:${goal.id}`, kind: 'goal', state, label, subject: workThreadTitle(goal.prompt), detail: null,
    startedAt: null, endedAt: null, observedAt: null, runningClock: false };
}

/** Project only the selected registered pair. An answered Owner turn never accepts Work. */
export function projectAgentStatus({ target, snapshot, runs, turns = [], availability }: AgentStatusInput): AgentStatusModel {
  const empty = { current: null, observations: [], detail: null };
  if (!target) return { ...empty, state: 'unknown', label: '등록 대화 확인 필요' };
  if (availability === 'loading') return { ...empty, state: 'loading', label: '상태 불러오는 중' };
  const goals = new Map((snapshot?.goals ?? []).filter(goal => goal.accountable_ghost === target.ghost_id
    && goal.reply_conversation === target.conversation_id).map(goal => [goal.id, goal]));
  const work = (snapshot?.work ?? []).filter(item => goals.has(item.goal_id)).map(item => workObservation(item, goals.get(item.goal_id)!));
  const workGoalIDs = new Set((snapshot?.work ?? []).map(item => item.goal_id));
  const unassignedGoals = [...goals.values()].filter(goal => !workGoalIDs.has(goal.id)).map(goalObservation);
  const turnText = new Map([...turns].map(turn => [turn.id, turn.text]));
  const responses = [...runs].filter(run => run.ghost_id === target.ghost_id && run.conversation_id === target.conversation_id)
    .sort((left, right) => right.created_at_ms - left.created_at_ms || right.updated_at_ms - left.updated_at_ms)
    .map(run => responseObservation(run, turnText.get(run.turn_id)));
  const observations = [...work, ...unassignedGoals, ...responses];
  // Historical terminal responses must not mask the latest answer. Unresolved runs remain visible.
  const currentWork = work.filter(item => item.state !== 'stale');
  const candidates = [...currentWork, ...unassignedGoals, ...responses.filter((item, index) => index === 0
    || !['responded', 'failed', 'cancelled'].includes(item.state))];
  if (currentWork.length === 0 && work.length > 0) candidates.push(...work);
  candidates.sort((left, right) => priority[left.state] - priority[right.state]
    || (right.observedAt ?? -1) - (left.observedAt ?? -1));
  const current = candidates[0] ?? null;
  if (availability === 'unavailable' || !snapshot) {
    return { state: 'unknown', label: '최신 상태 확인 필요', detail: '마지막으로 읽은 기록입니다.', current, observations };
  }
  return current
    ? { state: current.state, label: current.label, detail: current.detail, current, observations }
    : { ...empty, state: 'ready', label: '대화 준비됨' };
}

/** Host timestamps only; terminal, stale and uncertain clocks never advance locally. Null when no Host time exists. */
export function elapsedAgentTime(observation: AgentObservation | null, now: number, current = true): string | null {
  if (!observation || observation.startedAt === null) return null;
  const end = observation.endedAt ?? (observation.runningClock && current ? now : observation.observedAt);
  if (end === null || end < observation.startedAt) return null;
  const minutes = Math.floor((end - observation.startedAt) / 60_000);
  if (minutes < 1) return '1분 미만';
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}분`;
  return minutes % 60 ? `${hours}시간 ${minutes % 60}분` : `${hours}시간`;
}
