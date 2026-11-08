import { useId, useState } from 'react';
import { Folder, Home, Inbox, LayoutList, MessageCircle, Pin, Plus, Settings2 } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Navigation, NavigationGroup, NavigationItem } from '../ui'
import type { Ghost, State } from '@ghost/contract';
import { ghostLiveWork, ghostPresence, liveWorks, visibleGhosts, type Presence } from '../features/ghostState';
import { useSidebarPreferences } from '../features/sidebarPreferences';
import { PresenceAvatar } from './agent';
import { routeLabels, uiTerms } from '../uiText';
import type { HostStatus } from '../features/hostStatus';

/** Beyond this many Ghosts the roster collapses to a top list and a +N disclosure; at or below it renders exactly as before. */
const COLLAPSE_LIMIT = 7;
/** An expanded overflow list grows its own filter only once the hidden rows alone pass this. */
const SEARCH_LIMIT = 8;

/**
 * Workspace destinations, then every Ghost as a presence row: its state ring, name and
 * what it is doing now. A row opens the Ghost's conversation; its history and Work are
 * reached from the conversation header, so the list stays a glanceable roster. Once the
 * team grows past seven, only the Ghosts that need the owner stay up: the default, those
 * with a presence line, pinned ones and the open conversation — the rest sit behind +N.
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
  const spaces = state?.spaces ?? [];
  const live = state ? liveWorks(state).length : 0;
  const hostTrouble = status.state !== 'connected';
  // Deleted and retired Ghosts leave the roster. Small teams keep the classic order:
  // the default leads, the rest follow in roster order.
  const ghosts = (state?.ghosts ?? []).filter(ghost => ghost.state !== 'retired' && ghost.deletedAt === null);
  const flat = [...ghosts].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const roster = visibleGhosts(state?.ghosts ?? []);
  const overflow = roster.length > COLLAPSE_LIMIT;
  const { pinned, expanded, togglePinned, setExpanded } = useSidebarPreferences(roster.map(ghost => ghost.id));
  const [query, setQuery] = useState('');

  const presence = new Map<Ghost['id'], Presence>(roster.map(ghost => [ghost.id, state ? ghostPresence(ghost, state) : { state: 'idle', line: null, rank: 5 }]));
  const byId = new Map(roster.map(ghost => [ghost.id, ghost]));
  const pinnedIds = new Set(pinned);
  // The collapsed top list: default first, then presence (attention before progress),
  // then the owner's pins, then the conversation on screen — each Ghost once, at its
  // highest spot.
  const top: Ghost[] = [];
  const admit = (ghost?: Ghost) => { if (ghost && !top.includes(ghost)) top.push(ghost); };
  if (overflow) {
    admit(roster.find(ghost => ghost.isDefault));
    for (const ghost of roster.filter(ghost => presence.get(ghost.id)!.line !== null)
      .sort((a, b) => presence.get(a.id)!.rank - presence.get(b.id)!.rank)) admit(ghost);
    for (const id of pinned) admit(byId.get(id));
    admit(openGhostId ? byId.get(openGhostId) : undefined);
  }
  const rest = overflow ? roster.filter(ghost => !top.includes(ghost)) : [];
  const needle = query.trim().toLowerCase();
  const shownRest = rest.filter(ghost => !needle || ghost.name.toLowerCase().includes(needle)
    || ghost.persona.split('\n')[0]!.toLowerCase().includes(needle));

  const row = (ghost: Ghost, dimmed = false) => {
    const now = presence.get(ghost.id)!;
    const working = state ? ghostLiveWork(state, ghost.id).length : 0;
    return <ContextMenu key={ghost.id}>
      <ContextMenuTrigger asChild>
        <button type="button" className="presence-row__main" data-dimmed={dimmed && ghost.state === 'paused' ? '' : undefined}
          aria-current={ghost.id === openGhostId ? 'page' : undefined} onClick={() => openGhost(ghost.id)}>
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
    <Navigation label="작업실" className="ghost-sidebar min-h-0 flex-1 overflow-y-auto">
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
      {ghosts.length > 0 && <NavigationGroup label="Ghost">
        {overflow ? <>
          {top.map(ghost => row(ghost))}
          {expanded && rest.length > SEARCH_LIMIT && <input type="search" className="sidebar-search" aria-label="Ghost 찾기"
            placeholder="Ghost 찾기" value={query} onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setQuery(''); } }}/>}
          {expanded && shownRest.map(ghost => row(ghost, true))}
          {rest.length > 0 && <button type="button" className="sidebar-more" aria-expanded={expanded}
            aria-label={expanded ? 'Ghost 목록 접기' : `Ghost ${rest.length}명 더 보기`}
            onClick={() => { setQuery(''); setExpanded(!expanded); }}>
            <span aria-hidden="true">{expanded ? `−${rest.length}` : `+${rest.length}`}</span>
          </button>}
        </> : flat.map(ghost => row(ghost))}
      </NavigationGroup>}
      <NavigationGroup label="프로젝트" className="relative">
        <button type="button" aria-label="새 프로젝트" title="새 프로젝트" onClick={() => navigate('/spaces?new=1')} className="sidebar-group-action"><Plus size={14} aria-hidden="true"/></button>
        {spaces.map(space => <NavigationItem key={space.id} current={section === 'spaces' && space.id === selectedSpace} onClick={() => navigate(`/spaces/${space.id}`)}>
          <Folder/><span className="truncate">{space.name}</span>
        </NavigationItem>)}
      </NavigationGroup>
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
