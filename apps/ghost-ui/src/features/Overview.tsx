import { ArrowRight, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { TERMINAL_WORK_STATES, type Notification, type State, type Work } from '@ghost/contract';
import { InlineError, Page } from '../ui';
import { WorkLane } from '../components/agent';
import { HandoffComposer } from '../components/HandoffComposer';
import { DotAvatar } from '../components/DotAvatar';
import { DecisionDeck } from './Decision';
import { liveWorks, pendingDecisions, toneFor } from './ghostState';
import { useNow } from './time';
import { uiTerms } from '../uiText';
import { useHost } from '../host/context';
import { NotificationRow } from '../components/NotificationRow';
import { WaitingLine } from '../components/WaitingLine';
import { notificationRoute } from './notificationRoute';
import './Home.css';

const RECENT_MS = 3 * 86_400_000;
/** Home shows this many live lanes; the rest wait on the 맡긴 일 page behind a +N link. */
const LIVE_LANES = 6;

const DESK_QUERY = '(min-width: 56rem)';
const deskMatches = () => matchMedia(DESK_QUERY).matches;
function subscribeDesk(change: () => void) {
  const query = matchMedia(DESK_QUERY);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
}

/** Latest unread preview per Ghost; opening it still reads only that notification. */
function newConversations(notifications: State['notifications']) {
  const latest = new Map<string, Notification>();
  for (const item of notifications) {
    if (item.kind !== 'message' || item.readAt !== null) continue;
    const key = item.ghostId ?? item.conversationId ?? item.id;
    const previous = latest.get(key);
    if (!previous || previous.createdAt < item.createdAt) latest.set(key, item);
  }
  return [...latest.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
}

/** The owner judges first; the dispatch column remains available without interrupting that reading. */
export function Overview({ state, navigate }: { state: State; navigate(path: string): void }) {
  const wide = useSyncExternalStore(subscribeDesk, deskMatches, () => true);
  const now = useNow();
  useLayoutEffect(() => {
    const top = history.state?.homeScroll;
    if (typeof top === 'number') document.getElementById('main-content')?.scrollTo(0, top);
  }, []);
  const open = (path: string) => {
    // The shell resets the sheet on navigation; preserve this Home entry before it does.
    const top = document.getElementById('main-content')?.scrollTop ?? 0;
    history.replaceState({ ...history.state, homeScroll: top }, '');
    navigate(path);
  };
  const { client } = useHost();
  const [error, setError] = useState('');
  const messages = newConversations(state.notifications);
  const names = new Map(state.ghosts.map(ghost => [ghost.id, ghost.name]));
  const projectOf = (work: Work) => work.scopeId ? state.scopes.find(scope => scope.id === work.scopeId)?.name ?? '삭제된 프로젝트' : undefined;
  const decisions = pendingDecisions(state);
  const awaiting = decisions.length > 0;
  const waiting = new Set(decisions.map(decision => decision.workId));
  const live = liveWorks(state);
  const liveIds = new Set(live.map(work => work.id));
  const roots: Work[] = [];
  const branches = new Map<string, Work[]>();
  for (const work of live) {
    const parent = work.parentId;
    if (!parent || !liveIds.has(parent)) roots.push(work);
    else {
      const siblings = branches.get(parent);
      if (siblings) siblings.push(work);
      else branches.set(parent, [work]);
    }
  }
  const recent = state.works
    .filter(work => !work.parentId && TERMINAL_WORK_STATES.includes(work.state) && work.endedAt && now - work.endedAt < RECENT_MS)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 4);
  const lane = (work: Work) => {
    const children = branches.get(work.id);
    return <WorkLane key={work.id} work={work} ghostName={names.get(work.ghostId) ?? 'Ghost'} projectName={projectOf(work)} needsOwner={waiting.has(work.id)} now={now}
      onOpen={() => open(`/work/${encodeURIComponent(work.id)}`)}
      branch={children?.map(lane)}/>;
  };
  // Until a provider can run Ghosts, home leads with the one step that unblocks everything.
  const setup = !state.runtime.ready;
  const lead = state.ghosts.find(ghost => ghost.isDefault) ?? state.ghosts[0];
  const quiet = !awaiting && !roots.length && !recent.length && !messages.length;
  const messagesBand = messages.length > 0 && <section className="home__band" aria-labelledby="home-messages">
    <header className="home__band-head"><h2 id="home-messages" className="section-title">새 대화</h2></header>
    {error && <InlineError>{error}</InlineError>}
    <ul className="feed">{messages.map(item => <NotificationRow key={item.id} item={item} ghostName={names.get(item.ghostId ?? '') ?? item.title} now={now}
      onOpen={() => {
        const destination = notificationRoute(item, state);
        if (!destination) return;
        setError('');
        void client.send({ type: 'notification.read', notificationIds: [item.id] })
          .then(() => open(destination))
          .catch(reason => setError(reason instanceof Error ? reason.message : '읽음 표시를 저장하지 못했습니다.'));
      }}/>)}</ul>
  </section>;
  const liveBand = roots.length > 0 && <section className="home__band" aria-labelledby="home-live">
    <header className="home__band-head">
      <h2 id="home-live" className="section-title">진행 중</h2>
      <button type="button" className="link-quiet" onClick={() => open('/work')}>{uiTerms.work}<ArrowRight size={13} aria-hidden="true"/></button>
    </header>
    <div className="lanes">{roots.slice(0, LIVE_LANES).map(lane)}</div>
    {roots.length > LIVE_LANES && <button type="button" className="link-quiet justify-self-start" aria-label={`진행 중인 일 ${roots.length - LIVE_LANES}개 더 보기`}
      onClick={() => open('/work')}>+{roots.length - LIVE_LANES}<ArrowRight size={13} aria-hidden="true"/></button>}
  </section>;
  const recentBand = recent.length > 0 && <section className="home__band" aria-labelledby="home-recent">
    <header className="home__band-head"><h2 id="home-recent" className="section-title">최근 끝난 일</h2></header>
    <div className="lanes">{recent.map(work => <WorkLane key={work.id} work={work} ghostName={names.get(work.ghostId) ?? 'Ghost'} projectName={projectOf(work)} needsOwner={false} now={now}
      onOpen={() => open(`/work/${encodeURIComponent(work.id)}`)}/>)}</div>
  </section>;
  return <Page width="full" className="home">
    {setup && <button type="button" className="setup-card" onClick={() => open('/settings?tab=models')}>
      {lead && <DotAvatar profileId={lead.id} tone={toneFor(lead.id)} size={44}/>}
      <span className="setup-card__copy">
        <strong>{!state.settings.providers.length ? '모델 제공자 연결' : !state.settings.defaultModel ? '기본 모델 선택' : '모델 연결 확인'}</strong>
        {state.settings.providers.length > 0 && state.settings.defaultModel && <span>{state.runtime.detail}</span>}
      </span>
      <ChevronRight size={18} aria-hidden="true"/>
    </button>}
    {!wide && <WaitingLine state={state} now={now} navigate={open}/>}
    <div className="home__desk" data-awaiting={awaiting || undefined} data-quiet={quiet || undefined}
      data-split={awaiting || messages.length > 0 || recent.length > 0 || undefined}>
      <div className="home__judgment">
        <DecisionDeck state={state} navigate={open} decisions={decisions}/>
        {wide && messagesBand}
        {wide && !awaiting && recentBand}
      </div>
      <div className="home__dispatch" data-short={live.length + recent.length <= 4 || undefined}>
        <HandoffComposer ghosts={state.ghosts} navigate={open} showStarters={quiet && !setup}/>
        {!wide && messagesBand}
        {liveBand}
        {(!wide || awaiting) && recentBand}
        {!wide && !quiet && !roots.length && <button type="button" className="link-quiet justify-self-start"
          onClick={() => open('/work')}>{uiTerms.work} 전체<ArrowRight size={13} aria-hidden="true"/></button>}
      </div>
    </div>
  </Page>;
}
