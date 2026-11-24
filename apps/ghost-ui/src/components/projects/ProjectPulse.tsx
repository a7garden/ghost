import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Scope, State } from '@ghost/contract';
import { WorkLane } from '../agent';
import { projectWork } from '../../features/scopeState';
import { uiTerms } from '../../uiText';

/**
 * One line above the project's conversation: how much is running and how much waits on the owner.
 * It opens in place to the live Work, so the chat and its state are read together; with nothing
 * running it is not there at all.
 */
export function ProjectPulse({ state, scope, now, navigate, onAll }: { state: State; scope: Scope; now: number; navigate(path: string): void; onAll(): void }) {
  const [open, setOpen] = useState(false);
  const { live, pending } = projectWork(state, scope.id);
  if (live.length === 0 && pending.length === 0) return null;
  const waiting = new Set(pending.map(decision => decision.workId));
  return <section className="project-pulse" aria-label="이 프로젝트의 진행 상황">
    <button type="button" className="project-pulse__line" aria-expanded={open} aria-controls="project-pulse-panel" onClick={() => setOpen(value => !value)}>
      {live.length > 0 && <span>진행 중 <b className="tabular">{live.length}</b></span>}
      {pending.length > 0 && <span className="project-pulse__owner">{uiTerms.inbox} <b className="tabular">{pending.length}</b></span>}
      <ChevronDown size={14} aria-hidden="true" className="project-pulse__chevron"/>
    </button>
    {open && <div id="project-pulse-panel" className="project-pulse__panel">
      {live.map(work => <WorkLane key={work.id} work={work} ghostName={state.ghosts.find(ghost => ghost.id === work.ghostId)?.name ?? 'Ghost'} showGhost={false}
        needsOwner={waiting.has(work.id)} now={now} onOpen={() => navigate(`/work/${encodeURIComponent(work.id)}`)}/>)}
      {live.length === 0 && <p className="project-pulse__empty">진행 중인 일은 없고, 확인할 일이 입력창 위에 있습니다.</p>}
      <button type="button" className="link-quiet project-pulse__all" onClick={onAll}>{uiTerms.work} 전체</button>
    </div>}
  </section>;
}
