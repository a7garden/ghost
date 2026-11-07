import type { Ghost, State } from '@ghost/contract';
import { ghostLiveWork } from '../features/ghostState';
import { relativeTime, useNow } from '../features/time';
import { StateGlyph, glyphLabel, type GlyphState } from './agent';

export interface AgentObservation {
  id: string;
  state: GlyphState;
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

/** Recent activity of one Ghost: its pending questions, its live work, its running conversation. */
export function projectGhostActivity(ghost: Ghost, state: State): AgentStatusModel {
  const observations: AgentObservation[] = [];
  const seenWorks = new Set<string>();
  for (const decision of state.decisions) {
    if (decision.state !== 'pending' || decision.ghostId !== ghost.id) continue;
    observations.push({ id: `decision:${decision.id}`, state: 'attention', label: decision.title, at: decision.createdAt, workId: decision.workId ?? undefined });
    if (decision.workId) seenWorks.add(decision.workId);
  }
  for (const work of ghostLiveWork(state, ghost.id)) {
    if (seenWorks.has(work.id)) continue;
    seenWorks.add(work.id);
    observations.push({
      id: `work:${work.id}`, state: work.state, label: work.title, detail: work.reason ?? undefined,
      at: work.updatedAt, workId: work.id, conversationId: work.conversationId ?? undefined,
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

/** Current activity with its actions; each item is named by its message or work. */
export function AgentActivityList({ model, busy = false, actionsDisabled = false, onInspectWork, onCancelTurn }: AgentActivityProps) {
  const now = useNow(15_000);
  if (model.observations.length === 0) return null;
  const action = 'cursor-pointer rounded-chip px-1 text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3 disabled:cursor-default disabled:opacity-50';
  return <ul className="grid list-none gap-2.5 p-0">
    {model.observations.map(observation => <li key={observation.id} className="flex min-w-0 items-start gap-2.5 text-left">
      <StateGlyph state={observation.state} size={15} className="mt-0.5"/>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-ui font-medium text-ink">{observation.label}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-ink-3">
          <span>{glyphLabel[observation.state]}</span>
          <time className="tabular">{relativeTime(observation.at, now)}</time>
          {observation.detail && <span className="min-w-0 text-ink-2 [overflow-wrap:anywhere]">{observation.detail}</span>}
          {observation.workId && onInspectWork && <button type="button" className={action} disabled={actionsDisabled} onClick={() => onInspectWork(observation.workId!)}>일 보기</button>}
          {observation.conversationId && observation.cancellable && onCancelTurn && <button type="button" className={action} disabled={busy || actionsDisabled} onClick={() => onCancelTurn(observation.conversationId!)}>응답 취소</button>}
        </span>
      </span>
    </li>)}
  </ul>;
}
