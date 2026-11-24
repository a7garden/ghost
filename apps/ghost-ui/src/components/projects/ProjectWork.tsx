import { TERMINAL_WORK_STATES, type Scope, type State } from '@ghost/contract';
import { WorkLane } from '../agent';
import { DecisionDeck } from '../../features/Decision';
import { decisionScopeId } from '../../features/scopeState';
import { uiTerms } from '../../uiText';

/** What this project has in flight: what waits on the owner first, then live Work, then what finished. */
export function ProjectWork({ state, scope, now, navigate }: { state: State; scope: Scope; now: number; navigate(path: string): void }) {
  const pending = state.decisions.filter(decision => decision.state === 'pending' && decisionScopeId(decision, state) === scope.id).sort((a, b) => a.createdAt - b.createdAt);
  const works = state.works.filter(work => work.scopeId === scope.id).sort((a, b) => b.updatedAt - a.updatedAt);
  const live = works.filter(work => !TERMINAL_WORK_STATES.includes(work.state));
  const settled = works.filter(work => TERMINAL_WORK_STATES.includes(work.state));
  const waiting = new Set(pending.map(decision => decision.workId));
  const lane = (work: (typeof works)[number]) => <WorkLane key={work.id} work={work} ghostName={state.ghosts.find(ghost => ghost.id === work.ghostId)?.name ?? 'Ghost'}
    needsOwner={waiting.has(work.id)} now={now} onOpen={() => navigate(`/work/${encodeURIComponent(work.id)}`)}/>;
  return <div className="project-stack">
    {pending.length > 0 && <section className="project-section" aria-label={uiTerms.inbox}>
      <h2 className="section-title">{uiTerms.inbox} <span className="count tabular">{pending.length}</span></h2>
      <DecisionDeck state={state} navigate={navigate} decisions={pending}/>
    </section>}
    {live.length > 0 && <section className="project-section" aria-label="진행 중">
      <h2 className="section-title">진행 중 <span className="count tabular">{live.length}</span></h2>
      <div>{live.map(lane)}</div>
    </section>}
    {settled.length > 0 && <section className="project-section" aria-label="끝난 일">
      <h2 className="section-title">끝난 일 <span className="count tabular">{settled.length}</span></h2>
      <div>{settled.map(lane)}</div>
    </section>}
    {works.length === 0 && pending.length === 0 && <div className="calm"><p>맡긴 일 없음</p></div>}
  </div>;
}
