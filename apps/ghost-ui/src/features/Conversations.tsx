import { Folder, Plus } from 'lucide-react';
import { useLayoutEffect, useState, type MouseEvent } from 'react';
import type { Notification, State, Work } from '@ghost/contract';
import { PresenceAvatar } from '../components/agent';
import { RosterGhostMenu } from '../components/RosterGhostMenu';
import { blurTouchSearchOnEnter } from '../ui/adaptive';
import { routeLabels, uiTerms } from '../uiText';
import { ghostPresence, liveWork, pendingDecisions, visibleGhosts } from './ghostState';
import { absoluteTime, relativeTime, useNow } from './time';
import { ghostAddPath } from './ghostRoutes';
import './Roster.css';

const destinations = [['/work', uiTerms.work], ['/goals', uiTerms.goals], ['/mail', routeLabels.mail]] as const;
type RosterVisit = { top: number; query: string; row: string };

export function Conversations({ state, navigate, openGhost }: { state: State; navigate(path: string): void; openGhost(id: string): void }) {
  const [visit] = useState<RosterVisit | undefined>(() => typeof history === 'undefined' ? undefined : history.state?.ghostRoster);
  const [query, setQuery] = useState(visit?.query ?? '');
  const now = useNow();
  const roster = visibleGhosts(state.ghosts);
  const searchable = roster.length > 8;
  const needle = searchable ? query.trim().toLocaleLowerCase() : '';

  useLayoutEffect(() => {
    if (!visit) return;
    document.getElementById('main-content')?.scrollTo(0, visit.top);
    document.getElementById(visit.row)?.focus({ preventScroll: true });
  }, [visit]);

  const remember = (row: string) => {
    const top = document.getElementById('main-content')?.scrollTop ?? 0;
    history.replaceState({ ...history.state, ghostRoster: { top, query, row } }, '');
  };
  const follow = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    remember(event.currentTarget.id);
    navigate(path);
  };

  const direct = new Map(state.conversations.filter(row => row.kind === 'direct').map(row => [row.id, row]));
  const previews = new Map<string, Notification>();
  for (const item of state.notifications) {
    // The Host also uses kind='message' for mail and operational notices. Only emitted replies preview a chat.
    if (item.kind !== 'message' || !item.id.startsWith('message:') || !item.conversationId || !item.body.trim()) continue;
    const previous = previews.get(item.conversationId);
    if (!previous || previous.createdAt < item.createdAt) previews.set(item.conversationId, item);
  }
  const waitingSince = new Map<string, number>();
  for (const item of pendingDecisions(state)) {
    waitingSince.set(item.ghostId, Math.min(waitingSince.get(item.ghostId) ?? item.createdAt, item.createdAt));
  }
  const workingSince = new Map<string, number>();
  for (const conversation of direct.values()) {
    if (conversation.busy) workingSince.set(conversation.ghostId, Math.max(workingSince.get(conversation.ghostId) ?? 0, conversation.lastActivityAt));
  }
  const liveByGhost = new Map<string, number>();
  const liveByScope = new Map<string, number>();
  const runningByGhost = new Map<string, Work>();
  for (const work of state.works) {
    if (!liveWork(work)) continue;
    liveByGhost.set(work.ghostId, (liveByGhost.get(work.ghostId) ?? 0) + 1);
    if (work.scopeId) liveByScope.set(work.scopeId, (liveByScope.get(work.scopeId) ?? 0) + 1);
    if (work.state !== 'running' && work.state !== 'verifying') continue;
    const previous = runningByGhost.get(work.ghostId);
    if (!previous || previous.updatedAt < work.updatedAt) runningByGhost.set(work.ghostId, work);
  }

  const rows = roster.filter(ghost => ghost.name.toLocaleLowerCase().includes(needle)).map(ghost => {
    const presence = ghostPresence(ghost, state);
    const conversation = direct.get(ghost.directConversationId);
    const preview = conversation ? previews.get(conversation.id) : undefined;
    const activityAt = conversation && conversation.lastActivityAt > conversation.createdAt ? conversation.lastActivityAt : undefined;
    const at = presence.state === 'attention' ? waitingSince.get(ghost.id)
      : presence.state === 'working' ? workingSince.get(ghost.id)
      : preview?.createdAt ?? activityAt;
    const line = (presence.state === 'working' ? runningByGhost.get(ghost.id)?.title : undefined)
      ?? presence.line ?? preview?.body ?? (ghost.state === 'paused' ? '일시 중지' : null);
    return { ghost, presence, at, line };
  }).sort((a, b) => a.presence.rank - b.presence.rank || Number(b.ghost.isDefault) - Number(a.ghost.isDefault));

  const main = roster.find(ghost => ghost.isDefault);
  const names = new Map(roster.map(ghost => [ghost.id, ghost.name]));
  return <section className="conversations" aria-labelledby="conversations-heading">
    <h1 id="conversations-heading" className="sr-only">{routeLabels.conversations}</h1>
    {searchable && <input type="search" className="mobile-list-search roster-search" aria-label="Ghost 찾기" placeholder="Ghost 찾기"
      value={query} enterKeyHint="search" onChange={event => setQuery(event.target.value)} onKeyDown={blurTouchSearchOnEnter}/>}
    {rows.length > 0 ? <ul className="roster-list" aria-label="Ghost">
      {rows.map(({ ghost, presence, at, line }) => {
        const row = `roster-ghost-${ghost.id}`;
        const count = liveByGhost.get(ghost.id) ?? 0;
        const open = () => { remember(row); openGhost(ghost.id); };
        const subject = presence.state === 'attention' ? presence.line : null;
        const identity = <span className="roster-row__name"><span className="truncate">{ghost.name}</span>
          {ghost.isDefault && roster.length > 1 && <span className="presence-row__main-mark">메인</span>}
        </span>;
        return <li key={ghost.id}>
          <RosterGhostMenu ghost={ghost} onOpen={open} navigate={path => { remember(row); navigate(path); }}>
            <button id={row} type="button" className="roster-row" data-tone={presence.state} onClick={open}>
              <PresenceAvatar ghostId={ghost.id} state={presence.state} size={32}/>
              <span className="roster-row__copy">
                {subject ? <><span className="roster-row__subject">{subject}</span>{identity}</>
                  : <>{identity}{line && <span className="roster-row__meta">{line}</span>}</>}
              </span>
              {count > 0 ? <span className="roster-row__value"><span className="sr-only">맡긴 일 진행 중 </span>{count}건</span>
                : at !== undefined && <time className="roster-row__value" dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>{relativeTime(at, now)}</time>}
            </button>
          </RosterGhostMenu>
        </li>;
      })}
    </ul> : <div className="roster-empty">
      <p role="status">{needle ? '일치하는 Ghost가 없습니다.' : '대화할 Ghost가 없습니다.'}</p>
    </div>}
    {!needle && <a id="roster-add-ghost" className="roster-row roster-row--add" href={`#${ghostAddPath}`} onClick={event => follow(event, ghostAddPath)}>
      <span className="roster-row__glyph"><Plus size={18} aria-hidden="true"/></span>
      <span className="roster-row__copy"><span className="roster-row__name">Ghost 추가</span></span>
    </a>}

    <section className="roster-projects" aria-labelledby="roster-projects-heading">
      <header className="roster-projects__head">
        <h2 id="roster-projects-heading">{routeLabels.scopes}</h2>
        <a id="roster-new-project" className="roster-link" href="#/scopes?new=1" aria-label="새 프로젝트" title="새 프로젝트"
          onClick={event => follow(event, '/scopes?new=1')}><Plus size={16} aria-hidden="true"/></a>
      </header>
      {state.scopes.length > 0 && <ul className="roster-list">
        {state.scopes.map(scope => {
          const path = `/scopes/${encodeURIComponent(scope.id)}`;
          const receiver = (scope.ghostId === null ? main?.name : names.get(scope.ghostId)) ?? '받을 Ghost 없음';
          return <li key={scope.id}><a id={`roster-project-${scope.id}`} className="roster-row" href={`#${path}`} onClick={event => follow(event, path)}>
            <span className="roster-row__glyph"><Folder size={18} aria-hidden="true"/></span>
            <span className="roster-row__copy">
              <span className="roster-row__name"><span className="truncate">{scope.name}</span></span>
              <span className="roster-row__meta">{receiver}{scope.state === 'paused' ? ' · 일시 중지' : ''}</span>
            </span>
            {liveByScope.has(scope.id) && <span className="roster-row__value"><span className="sr-only">맡긴 일 진행 중 </span>{liveByScope.get(scope.id)}건</span>}
          </a></li>;
        })}
      </ul>}
    </section>

    <nav className="roster-links" aria-label="작업실">
      {destinations.map(([path, label], index) => <span key={path}>
        {index > 0 && <span aria-hidden="true">·</span>}
        <a id={`roster${path.replace('/', '-')}`} className="roster-link" href={`#${path}`} onClick={event => follow(event, path)}>{label}</a>
      </span>)}
    </nav>
  </section>;
}
