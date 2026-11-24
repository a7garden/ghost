import { BriefcaseBusiness } from 'lucide-react';
import type { Scope, State, Work } from '@ghost/contract';
import { Button } from '../../ui';
import { LifecycleTrack, WorkLane } from '../agent';
import { DecisionDeck } from '../../features/Decision';
import { projectWork } from '../../features/scopeState';
import { uiTerms } from '../../uiText';

/**
 * What this project has in flight: what waits on the owner first, then live Work, then what finished.
 * Each lane carries its stage on the right, so how far along reads without opening it.
 */
export function ProjectWork({ state, scope, now, navigate, onHandoff }: { state: State; scope: Scope; now: number; navigate(path: string): void; onHandoff?(): void }) {
  const { works, live, settled, pending } = projectWork(state, scope.id);
  const waiting = new Set(pending.map(decision => decision.workId));
  const lane = (work: Work) => <WorkLane key={work.id} work={work} ghostName={state.ghosts.find(ghost => ghost.id === work.ghostId)?.name ?? 'Ghost'}
    needsOwner={waiting.has(work.id)} now={now} onOpen={() => navigate(`/work/${encodeURIComponent(work.id)}`)}
    action={<LifecycleTrack state={work.state} needsOwner={waiting.has(work.id)} compact decorative stageOnly/>}/>;
  return <div className="project-stack">
    {pending.length > 0 && <section className="project-section" aria-label={uiTerms.inbox}>
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
    {works.length === 0 && pending.length === 0 && <div className="calm"><p>맡긴 일 없음</p>
      {onHandoff && <Button variant="outline" size="sm" className="ml-auto" onClick={onHandoff}><BriefcaseBusiness size={14} aria-hidden="true"/>일 맡기기</Button>}</div>}
  </div>;
}
