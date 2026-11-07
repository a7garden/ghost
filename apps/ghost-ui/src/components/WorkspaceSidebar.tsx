import { ChevronRight, Folder, History, Home, Inbox, LayoutList, Plus, Settings2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Navigation, NavigationGroup, NavigationItem } from '../ui'
import type { Ghost, State } from '@ghost/contract';
import { ghostPresence, liveWorks } from '../features/ghostState';
import { PresenceAvatar } from './agent';
import { routeLabels, uiTerms } from '../uiText';
import type { HostStatus } from '../features/hostStatus';

/** One page of a Ghost besides its conversation: its work and its earlier conversations. */
export interface GhostMenuItem { key: string; label: string; path: string; kind: 'work' | 'history' }

const menuIcons = { work: LayoutList, history: History };

export function WorkspaceSidebar({ state, section, openGhostId, ghostMenu, currentGhostPage, selectedSpace, attentionCount, status, navigate, openGhost }: {
  state: State | null;
  section: string;
  /** Ghost whose pages are on screen; null on workspace pages. */
  openGhostId: string | null;
  ghostMenu(ghost: Ghost): GhostMenuItem[];
  currentGhostPage: string | null;
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
  // Each Ghost folds on its own; opening a Ghost unfolds it, and the chevron folds or unfolds without navigating.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(openGhostId ? [openGhostId] : []));
  useEffect(() => { if (openGhostId) setExpanded(current => current.has(openGhostId) ? current : new Set(current).add(openGhostId)); }, [openGhostId]);
  const toggle = (id: string) => setExpanded(current => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const spaces = state?.spaces ?? [];
  const live = state ? liveWorks(state).length : 0;
  const hostTrouble = status.state !== 'connected';
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
        <NavigationItem current={section === 'work' && !openGhostId} onClick={() => navigate('/work')}>
          <LayoutList/><span className="flex-1">{uiTerms.work}</span>
          {live > 0 && <span className="sidebar-count"><span className="sr-only">진행 중 </span>{live}</span>}
        </NavigationItem>
      </div>
      {ghosts.length > 0 && <NavigationGroup label="Ghost">{ghosts.map(ghost => {
        const open = ghost.id === openGhostId;
        const presence = state ? ghostPresence(ghost, state) : { state: 'idle' as const, line: null };
        const menu = ghostMenu(ghost);
        const unfolded = menu.length > 0 && expanded.has(ghost.id);
        return <div key={ghost.id} className="presence-row" data-open={open || undefined}>
          <button type="button" className="presence-row__main" aria-current={open && currentGhostPage === 'chat' ? 'page' : undefined} onClick={() => openGhost(ghost.id)}>
            <PresenceAvatar ghostId={ghost.id} state={presence.state} size={26}/>
            <span className="presence-row__copy">
              <span className="presence-row__name"><span className="truncate">{ghost.name}</span>{ghost.isDefault && <span className="presence-row__main-mark">메인</span>}</span>
              {presence.line && <span className="presence-row__line" data-tone={presence.state}>{presence.line}</span>}
            </span>
          </button>
          {menu.length > 0 && <button type="button" className="presence-row__fold" aria-expanded={unfolded} aria-label={`${ghost.name} 하위 메뉴 ${unfolded ? '접기' : '펼치기'}`} onClick={() => toggle(ghost.id)}>
            <ChevronRight size={14} aria-hidden="true" data-open={unfolded || undefined}/>
          </button>}
          {unfolded && <div className="presence-row__menu">{menu.map(item => {
            const Icon = menuIcons[item.kind];
            return <NavigationItem key={item.key} current={open && item.key === currentGhostPage} onClick={() => navigate(item.path)}><Icon/><span className="truncate">{item.label}</span></NavigationItem>;
          })}</div>}
        </div>;
      })}</NavigationGroup>}
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
