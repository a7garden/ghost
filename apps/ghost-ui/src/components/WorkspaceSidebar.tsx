import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Compass, Folder, Home, Inbox, LayoutList, Mail, MessageCircle, Pin, Plus, Settings2 } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Navigation, NavigationGroup, NavigationItem, ScrollRail } from '../ui'
import type { Ghost, State } from '@ghost/contract';
import { ghostLiveWork, ghostPresence, liveWorks, visibleGhosts, type Presence } from '../features/ghostState';
import { useSidebarPreferences } from '../features/sidebarPreferences';
import { PresenceAvatar } from './agent';
import { routeLabels, uiTerms } from '../uiText';
import type { HostStatus } from '../features/hostStatus';
import { blurTouchSearchOnEnter } from '../ui/adaptive';

/** An expanded pool grows its own filter once the rows alone pass this. */
const SEARCH_LIMIT = 8;

/**
 * Workspace destinations, then the Ghosts: the owner's 고정 roster and the pool. A pinned row
 * (the default Ghost is always pinned) stays up in its own group; everyone else sits in the
 * pool group, folded by its own header — the header sticks while scrolling, so folding never
 * means hunting for a button at the bottom of a long list. A folded pool still shows the Ghosts
 * that need the owner or hold the conversation on screen.
 *
 * The destinations stay put; only the roster and projects scroll, under sticky group labels,
 * fading out at the bottom while more follows. The rail beside it marks Ghosts that are
 * working or need the owner, so a long roster still shows where to look.
 */
export function WorkspaceSidebar({ state, section, openGhostId, selectedScope, attentionCount, status, navigate, openGhost }: {
  state: State | null;
  section: string;
  /** Ghost whose conversation is on screen; null on workspace pages. */
  openGhostId: string | null;
  /** Project on screen; null while the create form is open. */
  selectedScope?: string;
  attentionCount: number;
  status: HostStatus;
  navigate(path: string): void;
  openGhost(id: string): void;
}) {
  const hostStatusId = useId();
  const scopes = state?.scopes ?? [];
  const live = state ? liveWorks(state).length : 0;
  const hostTrouble = status.state !== 'connected' && !status.quiet;
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollEdges(scrollRef);
  // Opening a Ghost from elsewhere (a card, search) brings its row into view.
  useEffect(() => {
    if (!openGhostId) return;
    scrollRef.current?.querySelector<HTMLElement>('.presence-row__main[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
  }, [openGhostId]);
  // Deleted and retired Ghosts leave the roster.
  const roster = visibleGhosts(state?.ghosts ?? []);
  const { pinned, expanded, togglePinned, setExpanded } = useSidebarPreferences(roster.map(ghost => ghost.id));
  const [query, setQuery] = useState('');
  const presence = new Map<Ghost['id'], Presence>(roster.map(ghost => [ghost.id, state ? ghostPresence(ghost, state) : { state: 'idle', line: null, rank: 5 }]));
  const byId = new Map(roster.map(ghost => [ghost.id, ghost]));
  const pinnedIds = new Set(pinned);
  // The default Ghost is the entry point and always sits in 고정; pins follow in pin order.
  const fixed: Ghost[] = [];
  const admitFixed = (ghost?: Ghost) => { if (ghost && !fixed.includes(ghost)) fixed.push(ghost); };
  admitFixed(roster.find(ghost => ghost.isDefault));
  for (const id of pinned) admitFixed(byId.get(id));
  const pool = roster.filter(ghost => !fixed.includes(ghost));
  // A folded pool keeps the rows the owner is looking at or must answer.
  const needsEyes = (ghost: Ghost) => ghost.id === openGhostId || presence.get(ghost.id)!.line !== null;
  const shownPool = expanded ? pool : pool.filter(needsEyes);
  const needle = query.trim().toLowerCase();
  const filteredPool = shownPool.filter(ghost => !needle || ghost.name.toLowerCase().includes(needle)
    || ghost.persona.split('\n')[0]!.toLowerCase().includes(needle));

  const row = (ghost: Ghost, dimmed = false) => {
    const now = presence.get(ghost.id)!;
    const working = state ? ghostLiveWork(state, ghost.id).length : 0;
    return <ContextMenu key={ghost.id}>
      <ContextMenuTrigger asChild>
        <button type="button" className="presence-row__main" data-dimmed={dimmed && ghost.state === 'paused' ? '' : undefined}
          aria-current={ghost.id === openGhostId ? 'page' : undefined} onClick={() => openGhost(ghost.id)}
          data-rail={now.state !== 'idle' || ghost.id === openGhostId ? 'ghost' : undefined}
          data-rail-tone={now.state === 'attention' ? 'amber' : now.state === 'working' ? 'signal' : ghost.id === openGhostId ? 'muted' : undefined}
          data-rail-label={now.line ? `${ghost.name} · ${now.line}` : ghost.name}>
          <PresenceAvatar ghostId={ghost.id} state={now.state} size={26}/>
          <span className="presence-row__copy">
            <span className="presence-row__name"><span className="truncate">{ghost.name}</span>{ghost.isDefault && <span className="presence-row__main-mark">메인</span>}</span>
            {now.line && <span className="presence-row__line" data-tone={now.state}>{now.line}</span>}
          </span>
          {working > 0 && <span className="sidebar-count"><span className="sr-only">맡긴 일 진행 중 </span>{working}</span>}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={`${ghost.name} 메뉴`}>
        <ContextMenuItem icon={<MessageCircle/>} onSelect={() => openGhost(ghost.id)}>대화 열기</ContextMenuItem>
        <ContextMenuItem icon={<Pin/>} onSelect={() => togglePinned(ghost.id)}>{pinnedIds.has(ghost.id) ? '고정 해제' : '고정'}</ContextMenuItem>
        <ContextMenuItem icon={<LayoutList/>} onSelect={() => navigate(`/work?ghost=${encodeURIComponent(ghost.id)}`)}>{uiTerms.work}</ContextMenuItem>
        <ContextMenuItem icon={<Settings2/>} onSelect={() => navigate(`/settings?tab=team&ghost=${encodeURIComponent(ghost.id)}`)}>{uiTerms.ghostSettings}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>;
  };

  return <>
    <Navigation label="작업실" className="ghost-sidebar min-h-0 flex-1">
      {section === 'workspace' && <NavigationItem onClick={() => navigate('/goals')}>
        <Compass/><span className="flex-1">{uiTerms.goals}</span>
      </NavigationItem>}
      <div className="sidebar-primary">
        <NavigationItem current={section === 'home'} onClick={() => navigate('/')}>
          <Home/><span className="flex-1">{routeLabels.home}</span>
        </NavigationItem>
        <NavigationItem current={section === 'inbox'} onClick={() => navigate('/inbox')}>
          <Inbox/><span className="flex-1">{uiTerms.inbox}</span>
          {attentionCount > 0 && <span className="sidebar-count" data-tone="amber"><span className="sr-only">확인 필요 </span>{attentionCount}</span>}
        </NavigationItem>
        <NavigationItem current={section === 'work'} onClick={() => navigate('/work')}>
          <LayoutList/><span className="flex-1">{uiTerms.work}</span>
          {live > 0 && <span className="sidebar-count"><span className="sr-only">진행 중 </span>{live}</span>}
        </NavigationItem>
        <NavigationItem current={section === 'mail'} onClick={() => navigate('/mail')}>
          <Mail/><span className="flex-1">{routeLabels.mail}</span>
        </NavigationItem>
        <NavigationItem current={section === 'goals'} onClick={() => navigate('/goals')}>
          <Compass/><span className="flex-1">{uiTerms.goals}</span>
        </NavigationItem>
      </div>
      <div className="sidebar-scroll-frame">
        <div ref={scrollRef} className="sidebar-scroll">
          {roster.length > 0 && <NavigationGroup label="고정">{fixed.map(ghost => row(ghost))}</NavigationGroup>}
          {roster.length > 0 && <NavigationGroup label="Ghost"
            action={<button type="button" className="sidebar-pool-toggle" aria-expanded={expanded}
              aria-label={expanded ? 'Ghost 목록 접기' : `Ghost 목록 펼치기${pool.length ? ` (${pool.length})` : ''}`}
              onClick={() => { setQuery(''); setExpanded(!expanded); }}>
              {expanded ? <ChevronUp size={13} aria-hidden="true"/> : <ChevronDown size={13} aria-hidden="true"/>}
              {!expanded && pool.length > 0 && <span className="tabular">{pool.length}</span>}
            </button>}>
            {expanded && pool.length > SEARCH_LIMIT && <input type="text" enterKeyHint="search" className="sidebar-search" aria-label="Ghost 찾기"
              placeholder="Ghost 찾기" value={query} onChange={event => setQuery(event.target.value)}
              onKeyDown={event => { blurTouchSearchOnEnter(event); if (event.key === 'Escape') { event.preventDefault(); setQuery(''); } }}/>}
            {filteredPool.map(ghost => row(ghost, true))}
          </NavigationGroup>}
          <NavigationGroup label="프로젝트"
            action={<button type="button" aria-label="새 프로젝트" title="새 프로젝트" onClick={() => navigate('/scopes?new=1')} className="sidebar-group-action"><Plus size={14} aria-hidden="true"/></button>}>
            {scopes.map(space => <NavigationItem key={space.id} current={section === 'scopes' && space.id === selectedScope} onClick={() => navigate(`/scopes/${space.id}`)}>
              <Folder/><span className="truncate">{space.name}</span>
            </NavigationItem>)}
          </NavigationGroup>
        </div>
        <ScrollRail viewportRef={scrollRef} contentRef={scrollRef}/>
      </div>
    </Navigation>
    <div className="sidebar-foot">
      <NavigationItem className="w-full" current={section === 'settings'} aria-describedby={hostTrouble ? hostStatusId : undefined}
        onClick={() => navigate(hostTrouble ? '/settings?tab=host' : '/settings')}>
        <Settings2/><span className="flex-1">설정</span>
        {hostTrouble && <span className="sidebar-count" data-tone={status.state === 'offline' ? 'danger' : 'amber'} id={hostStatusId}>{status.label}</span>}
      </NavigationItem>
    </div>
  </>;
}

/** Marks a scroller with `data-more-below` while content continues past its bottom edge. */
function useScrollEdges(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const more = element.scrollTop + element.clientHeight < element.scrollHeight - 2;
      if (more) element.dataset.moreBelow = ''; else delete element.dataset.moreBelow;
    };
    const resize = new ResizeObserver(update);
    resize.observe(element);
    for (const group of element.children) resize.observe(group);
    element.addEventListener('scroll', update, { passive: true });
    update();
    return () => { resize.disconnect(); element.removeEventListener('scroll', update); };
  }, [ref]);
}
