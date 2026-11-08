import { Folder, Home, Inbox, LayoutList, MessageCircle, Plus, Settings2 } from 'lucide-react';
import { useEffect, useId, useRef, type RefObject } from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Navigation, NavigationGroup, NavigationItem, ScrollRail } from '../ui'
import type { State } from '@ghost/contract';
import { ghostLiveWork, ghostPresence, liveWorks } from '../features/ghostState';
import { PresenceAvatar } from './agent';
import { routeLabels, uiTerms } from '../uiText';
import type { HostStatus } from '../features/hostStatus';

/**
 * Workspace destinations, then every Ghost as a presence row: its state ring, name and
 * what it is doing now. A row opens the Ghost's conversation; its history and Work are
 * reached from the conversation header, so the list stays a glanceable roster.
 *
 * The destinations stay put; only the roster and projects scroll, under sticky group labels,
 * fading out at the bottom while more follows. The rail beside it marks Ghosts that are
 * working or need the owner, so a long roster still shows where to look.
 */
export function WorkspaceSidebar({ state, section, openGhostId, selectedSpace, attentionCount, status, navigate, openGhost }: {
  state: State | null;
  section: string;
  /** Ghost whose conversation is on screen; null on workspace pages. */
  openGhostId: string | null;
  /** Project on screen; null while the create form is open. */
  selectedSpace?: string;
  attentionCount: number;
  status: HostStatus;
  navigate(path: string): void;
  openGhost(id: string): void;
}) {
  const hostStatusId = useId();
  // The default Ghost is the entry point, so it always leads the list.
  const ghosts = [...state?.ghosts ?? []].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const spaces = state?.spaces ?? [];
  const live = state ? liveWorks(state).length : 0;
  const hostTrouble = status.state !== 'connected';
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollEdges(scrollRef);
  // Opening a Ghost from elsewhere (a card, search) brings its row into view.
  useEffect(() => {
    if (!openGhostId) return;
    scrollRef.current?.querySelector<HTMLElement>('.presence-row__main[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
  }, [openGhostId]);
  return <>
    <Navigation label="작업실" className="ghost-sidebar min-h-0 flex-1">
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
      </div>
      <div className="sidebar-scroll-frame">
        <div ref={scrollRef} className="sidebar-scroll">
          {ghosts.length > 0 && <NavigationGroup label="Ghost">{ghosts.map(ghost => {
            const presence = state ? ghostPresence(ghost, state) : { state: 'idle' as const, line: null };
            const working = state ? ghostLiveWork(state, ghost.id).length : 0;
            return <ContextMenu key={ghost.id}>
              <ContextMenuTrigger asChild>
                <button type="button" className="presence-row__main" aria-current={ghost.id === openGhostId ? 'page' : undefined} onClick={() => openGhost(ghost.id)}
                  data-rail={presence.state !== 'idle' || ghost.id === openGhostId ? 'ghost' : undefined}
                  data-rail-tone={presence.state === 'attention' ? 'amber' : presence.state === 'working' ? 'signal' : ghost.id === openGhostId ? 'muted' : undefined}
                  data-rail-label={presence.line ? `${ghost.name} · ${presence.line}` : ghost.name}>
                  <PresenceAvatar ghostId={ghost.id} state={presence.state} size={26}/>
                  <span className="presence-row__copy">
                    <span className="presence-row__name"><span className="truncate">{ghost.name}</span>{ghost.isDefault && <span className="presence-row__main-mark">메인</span>}</span>
                    {presence.line && <span className="presence-row__line" data-tone={presence.state}>{presence.line}</span>}
                  </span>
                  {working > 0 && <span className="sidebar-count"><span className="sr-only">맡긴 일 진행 중 </span>{working}</span>}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent aria-label={`${ghost.name} 메뉴`}>
                <ContextMenuItem icon={<MessageCircle/>} onSelect={() => openGhost(ghost.id)}>대화 열기</ContextMenuItem>
                <ContextMenuItem icon={<LayoutList/>} onSelect={() => navigate(`/work?ghost=${encodeURIComponent(ghost.id)}`)}>{uiTerms.work}</ContextMenuItem>
                <ContextMenuItem icon={<Settings2/>} onSelect={() => navigate(`/settings?tab=team&ghost=${encodeURIComponent(ghost.id)}`)}>{uiTerms.ghostSettings}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>;
          })}</NavigationGroup>}
          <NavigationGroup label="프로젝트"
            action={<button type="button" aria-label="새 프로젝트" title="새 프로젝트" onClick={() => navigate('/spaces?new=1')} className="sidebar-group-action"><Plus size={14} aria-hidden="true"/></button>}>
            {spaces.map(space => <NavigationItem key={space.id} current={section === 'spaces' && space.id === selectedSpace} onClick={() => navigate(`/spaces/${space.id}`)}>
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
        {hostTrouble && <span className="sidebar-count" data-tone="danger" id={hostStatusId}>{status.label}</span>}
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
