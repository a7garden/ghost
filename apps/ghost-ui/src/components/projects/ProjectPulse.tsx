import { useState } from 'react';
import type { Scope, State } from '@ghost/contract';
import { ProjectWorkRow } from './ProjectWork';
import { projectWork } from '../../features/scopeState';
import { glyphLabel, workGlyph } from '../agent';

/** The conversation names the Work the project is on right now; the 맡긴 일 tab keeps the whole ledger and its decisions. */
export function ProjectPulse({ state, scope, now, navigate }: { state: State; scope: Scope; now: number; navigate(path: string): void }) {
  const [open, setOpen] = useState(false);
  const { live, pending } = projectWork(state, scope.id);
  if (!live.length) return null;
  const waiting = new Set(pending.map(decision => decision.workId));
  const [latest, ...rest] = live;
  const glyph = workGlyph(latest.state, waiting.has(latest.id));
  return <section className="project-pulse" aria-label="이 프로젝트의 진행 상황">
    <div className="project-pulse__line">
      {rest.length > 0 && <button type="button" className="project-pulse__fold" aria-expanded={open} aria-controls="project-pulse-panel"
        aria-label={open ? '진행 중인 일 접기' : `진행 중인 일 ${live.length}건 펼치기`} onClick={() => setOpen(value => !value)}>
        <span className="fold-mark" aria-hidden="true"/>
      </button>}
      <span className="project-pulse__term">{glyphLabel[glyph]}</span>
      <button type="button" className="project-pulse__work" onClick={() => navigate(`/work/${encodeURIComponent(latest.id)}`)}>
        <span className="project-pulse__title">{latest.title}</span>
        {rest.length > 0 && <span className="project-pulse__more">외 {rest.length}건</span>}
      </button>
    </div>
    <div id="project-pulse-panel" className="project-pulse__panel" hidden={!open}>
      {open && <ul className="project-list">{live.map(work => <ProjectWorkRow key={work.id} work={work}
        ghost={state.ghosts.find(ghost => ghost.id === work.ghostId)?.name ?? 'Ghost'}
        needsOwner={waiting.has(work.id)} now={now} navigate={navigate}/>)}</ul>}
    </div>
  </section>;
}
