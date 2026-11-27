import { useState } from 'react';
import type { Scope, State } from '@ghost/contract';
import { ProjectWorkRow } from './ProjectWork';
import { projectWork } from '../../features/scopeState';

/** Reveal live project Work without repeating the decisions in the conversation dock. */
export function ProjectPulse({ state, scope, now, navigate }: { state: State; scope: Scope; now: number; navigate(path: string): void }) {
  const [open, setOpen] = useState(false);
  const { live, pending } = projectWork(state, scope.id);
  if (!live.length) return null;
  const waiting = new Set(pending.map(decision => decision.workId));
  return <section className="project-pulse" aria-label="이 프로젝트의 진행 상황">
    <button type="button" className="project-pulse__line" aria-expanded={open} aria-controls="project-pulse-panel" onClick={() => setOpen(value => !value)}>
      <span className="fold-mark" aria-hidden="true"/>진행 중
    </button>
    <div id="project-pulse-panel" className="project-pulse__panel" hidden={!open}>
      {open && <ul className="project-list">{live.map(work => <ProjectWorkRow key={work.id} work={work}
        ghost={state.ghosts.find(ghost => ghost.id === work.ghostId)?.name ?? 'Ghost'}
        needsOwner={waiting.has(work.id)} now={now} navigate={navigate}/>)}</ul>}
    </div>
  </section>;
}
