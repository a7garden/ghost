import type { Scope, State, Work } from '@ghost/contract';
import { StateGlyph, glyphLabel, workGlyph } from '../agent';
import { DecisionDeck } from '../../features/Decision';
import { projectWork } from '../../features/scopeState';
import { uiTerms } from '../../uiText';
import { absoluteTime, relativeTime } from '../../features/time';
import { workReason } from '../../features/workText';

/** The same row in the project's Work ledger and above its conversation. */
export function ProjectWorkRow({ work, ghost, needsOwner, now, navigate }: {
  work: Work; ghost: string; needsOwner: boolean; now: number; navigate(path: string): void;
}) {
  const glyph = workGlyph(work.state, needsOwner);
  const at = work.endedAt ?? work.updatedAt;
  const reason = workReason(work);
  return <li><button type="button" className="project-item" onClick={() => navigate(`/work/${encodeURIComponent(work.id)}`)}>
    <span className="project-item__mark" aria-hidden="true"><StateGlyph state={glyph}/></span>
    <span className="project-item__copy">
      <span className="project-item__title">{work.title}</span>
      <span className="project-item__meta">{ghost} · {glyphLabel[glyph]}{reason && ` · ${reason}`}</span>
    </span>
    <time className="project-item__value" dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>{relativeTime(at, now)}</time>
  </button></li>;
}

/** Decisions before live Work, then the record of what finished. */
export function ProjectWork({ state, scope, now, navigate }: { state: State; scope: Scope; now: number; navigate(path: string): void }) {
  const { works, live, settled, pending } = projectWork(state, scope.id);
  const waiting = new Set(pending.map(decision => decision.workId));
  const group = (label: string, items: Work[]) => items.length > 0 && <section className="project-section" aria-label={label}>
    <h2 className="section-title">{label}</h2>
    <ul className="project-list">{items.map(work => <ProjectWorkRow key={work.id} work={work}
      ghost={state.ghosts.find(ghost => ghost.id === work.ghostId)?.name ?? 'Ghost'}
      needsOwner={waiting.has(work.id)} now={now} navigate={navigate}/>)}</ul>
  </section>;
  return <div className="project-stack">
    <section className="project-decisions" aria-label={uiTerms.inbox}>
      <DecisionDeck state={state} navigate={navigate} decisions={pending}/>
    </section>
    {group('진행 중', live)}
    {group('끝난 일', settled)}
    {works.length === 0 && pending.length === 0 && <p className="project-empty">맡긴 일이 없습니다.</p>}
  </div>;
}
