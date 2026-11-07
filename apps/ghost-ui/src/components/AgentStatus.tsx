import { useEffect, useState } from 'react';
import { Check, CircleAlert, Clock3, MessageCircle, Search, Square } from 'lucide-react';
import type { Ghost, State } from '@ghost/contract';
import { ghostLiveWork } from '../features/ghostState';

export type AgentActivityState = 'queued' | 'running' | 'verifying' | 'needs_input' | 'responded' | 'cancelled' | 'failed';

export interface AgentObservation {
  id: string;
  state: AgentActivityState;
  /** What the Ghost is doing or waiting for, named like the owner wrote it. */
  label: string;
  detail?: string;
  /** Host clock; never advanced locally. */
  at: number;
  /** Openable 맡긴 일. */
  workId?: string;
  /** Live conversation a stop action can cancel; only owner turns in direct conversations. */
  conversationId?: string;
  cancellable?: boolean;
}

export interface AgentStatusModel {
  observations: AgentObservation[];
}

export interface AgentActivityProps {
  model: AgentStatusModel;
  busy?: boolean;
  actionsDisabled?: boolean;
  onInspectWork?: (workId: string) => void;
  onCancelTurn?: (conversationId: string) => void;
}

const stateLabel: Record<AgentActivityState, string> = {
  queued: '대기 중', running: '진행 중', verifying: '검증 중', needs_input: '확인 필요',
  responded: '응답 완료', cancelled: '취소됨', failed: '실패',
};

function ActivityIcon({ state, size = 15 }: { state: AgentActivityState; size?: number }) {
  if (state === 'responded') return <Check size={size} aria-hidden="true"/>;
  if (state === 'needs_input' || state === 'failed') return <CircleAlert size={size} aria-hidden="true"/>;
  if (state === 'cancelled') return <Square size={size} aria-hidden="true"/>;
  if (state === 'verifying') return <Search size={size} aria-hidden="true"/>;
  if (state === 'running') return <MessageCircle size={size} aria-hidden="true"/>;
  return <Clock3 size={size} aria-hidden="true"/>;
}

const activityInk: Partial<Record<AgentActivityState, string>> = {
  needs_input: 'text-orange', failed: 'text-red', cancelled: 'text-ink-3', responded: 'text-ink-2',
};

/** Host timestamps only; the clock never advances locally. Null when there is nothing to count. */
export function elapsedAgentTime(observation: AgentObservation, now: number): string | null {
  const seconds = Math.max(0, Math.round((now - observation.at) / 1000));
  if (seconds < 60) return '방금';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 경과`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 경과`;
  return null;
}

/** Recent activity of one Ghost: its live work, its pending questions, its running conversation. */
export function projectGhostActivity(ghost: Ghost, state: State): AgentStatusModel {
  const observations: AgentObservation[] = [];
  const seenWorks = new Set<string>();
  for (const decision of state.decisions) {
    if (decision.state !== 'pending' || decision.ghostId !== ghost.id) continue;
    observations.push({
      id: `decision:${decision.id}`, state: 'needs_input', label: decision.title, at: decision.createdAt,
      workId: decision.workId ?? undefined,
    });
    if (decision.workId) seenWorks.add(decision.workId);
  }
  for (const work of ghostLiveWork(state, ghost.id)) {
    if (seenWorks.has(work.id)) continue;
    seenWorks.add(work.id);
    const stateFor: AgentActivityState = work.state === 'queued' ? 'queued'
      : work.state === 'verifying' ? 'verifying'
        : work.state === 'blocked' || work.state === 'waiting' ? 'needs_input' : 'running';
    observations.push({
      id: `work:${work.id}`, state: work.state === 'failed' ? 'failed' : stateFor,
      label: work.title, detail: work.reason ?? undefined, at: work.updatedAt, workId: work.id,
      conversationId: work.conversationId ?? undefined,
    });
  }
  for (const conversation of state.conversations) {
    if (conversation.ghostId !== ghost.id || conversation.kind !== 'direct' || !conversation.busy) continue;
    observations.push({
      id: `conversation:${conversation.id}`, state: 'running', label: conversation.title || '대화', at: conversation.lastActivityAt,
      conversationId: conversation.id, cancellable: true,
    });
  }
  return { observations: observations.slice(0, 6) };
}

/** Small state dot shared by the status capsule and the Ghost profile. */
export function ActivityDot({ state, className = '' }: { state: AgentActivityState; className?: string }) {
  const tone = state === 'needs_input' || state === 'failed' ? 'bg-orange' : state === 'running' ? 'bg-ink animate-pulse motion-reduce:animate-none' : 'bg-ink-3';
  return <span className={`inline-block size-1.5 shrink-0 rounded-full ${tone} ${className}`} aria-hidden="true"/>;
}

/** Current and recent activity with their actions; the list names each activity by its message or work. */
export function AgentActivityList({ model, busy = false, actionsDisabled = false, onInspectWork, onCancelTurn }: AgentActivityProps & { open?: boolean; showSummary?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  if (model.observations.length === 0) return null;
  return <ul className="grid list-none gap-1.5 p-0">
    {model.observations.map(observation => <li key={observation.id} className="grid gap-0.5 text-left">
      <span className="flex min-w-0 items-center gap-1.5 text-ui text-ink">
        <ActivityIcon state={observation.state}/>
        <span className="min-w-0 flex-1 truncate">{observation.label}</span>
        <span className={`shrink-0 text-caption ${activityInk[observation.state] ?? 'text-ink-2'}`}>{stateLabel[observation.state]}</span>
      </span>
      {(observation.detail || observation.workId || observation.conversationId) && <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-6 text-caption text-ink-2">
        {observation.detail && <span className="min-w-0 [overflow-wrap:anywhere]">{observation.detail}</span>}
        {elapsedAgentTime(observation, now) && <span>{elapsedAgentTime(observation, now)}</span>}
        {observation.workId && onInspectWork && <button type="button" className="cursor-pointer underline underline-offset-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3 disabled:cursor-default disabled:no-underline" disabled={actionsDisabled} onClick={() => onInspectWork(observation.workId!)}>일 보기</button>}
        {observation.conversationId && observation.cancellable && onCancelTurn && <button type="button" className="cursor-pointer underline underline-offset-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3 disabled:cursor-default disabled:no-underline" disabled={busy || actionsDisabled} onClick={() => onCancelTurn(observation.conversationId!)}>응답 취소</button>}
      </span>}
    </li>)}
  </ul>;
}
