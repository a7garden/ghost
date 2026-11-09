import { ArrowRight, ChevronRight } from 'lucide-react';
import { TERMINAL_WORK_STATES, type State, type Work } from '@ghost/contract';
import { Page } from '../ui'
import { WorkLane } from '../components/agent';
import { HandoffComposer } from '../components/HandoffComposer';
import { DotAvatar } from '../components/DotAvatar';
import { DecisionDeck } from './Decision';
import { liveWorks, toneFor } from './ghostState';
import { useNow } from './time';
import { uiTerms } from '../uiText';

const RECENT_MS = 3 * 86_400_000;
/** Home shows this many live lanes; the rest wait on the 맡긴 일 page behind a +N link. */
const LIVE_LANES = 6;

/**
 * Home: hand something off, settle what waits on you, glance at what moves.
 * Each band appears only when it has something in it.
 */
export function Overview({ state, navigate }: { state: State; navigate(path: string): void }) {
  const now = useNow();
  const ghosts = [...state.ghosts].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const names = new Map(state.ghosts.map(ghost => [ghost.id, ghost.name]));
  const waiting = new Set(state.decisions.filter(decision => decision.state === 'pending' && decision.workId).map(decision => decision.workId!));
  // Root lanes only; a delegated child shows under its parent.
  const live = liveWorks(state);
  const roots = live.filter(work => !work.parentId || !live.some(parent => parent.id === work.parentId));
  const recent = state.works
    .filter(work => !work.parentId && TERMINAL_WORK_STATES.includes(work.state) && work.endedAt && now - work.endedAt < RECENT_MS)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 4);
  const lane = (work: Work) => {
    const children = live.filter(child => child.parentId === work.id);
    return <WorkLane key={work.id} work={work} ghostName={names.get(work.ghostId) ?? 'Ghost'} needsOwner={waiting.has(work.id)} now={now}
      onOpen={() => navigate(`/work/${encodeURIComponent(work.id)}`)}
      branch={children.length > 0 ? children.map(lane) : undefined}/>;
  };
  const quiet = !roots.length && !recent.length && !state.decisions.some(decision => decision.state === 'pending');
  // Until a provider can run Ghosts, home leads with the one step that unblocks everything.
  const setup = !state.runtime.ready;
  const lead = ghosts[0];
  return <Page width="reading" className="home" data-quiet={quiet || undefined}>
    {setup && <button type="button" className="setup-card" onClick={() => navigate('/settings?tab=models')}>
      {lead && <DotAvatar profileId={lead.id} tone={toneFor(lead.id)} size={44}/>}
      <span className="setup-card__copy">
        <strong>{!state.settings.providers.length ? '모델 제공자 연결' : !state.settings.defaultModel ? '기본 모델 선택' : '모델 연결 확인'}</strong>
        {state.settings.providers.length > 0 && state.settings.defaultModel && <span>{state.runtime.detail}</span>}
      </span>
      <ChevronRight size={18} aria-hidden="true"/>
    </button>}
    <HandoffComposer ghosts={ghosts} navigate={navigate}/>
    <DecisionDeck state={state} navigate={navigate}/>
    {roots.length > 0 && <section className="home__band" aria-labelledby="home-live">
      <header className="home__band-head">
        <h2 id="home-live" className="section-title">진행 중<span className="count">{live.length}</span></h2>
        <button type="button" className="link-quiet" onClick={() => navigate('/work')}>{uiTerms.work}<ArrowRight size={13} aria-hidden="true"/></button>
      </header>
      <div className="lanes">{roots.slice(0, LIVE_LANES).map(lane)}</div>
      {roots.length > LIVE_LANES && <button type="button" className="link-quiet justify-self-start" aria-label={`진행 중인 일 ${roots.length - LIVE_LANES}개 더 보기`}
        onClick={() => navigate('/work')}>+{roots.length - LIVE_LANES}<ArrowRight size={13} aria-hidden="true"/></button>}
    </section>}
    {recent.length > 0 && <section className="home__band" aria-labelledby="home-recent">
      <header className="home__band-head"><h2 id="home-recent" className="section-title">최근 끝난 일</h2></header>
      <div className="lanes">{recent.map(work => <WorkLane key={work.id} work={work} ghostName={names.get(work.ghostId) ?? 'Ghost'} needsOwner={false} now={now}
        onOpen={() => navigate(`/work/${encodeURIComponent(work.id)}`)}/>)}</div>
    </section>}
  </Page>;
}
