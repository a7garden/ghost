import { ChevronRight, Folder, History, Home, LayoutList, Plus, Settings2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Badge, Navigation, NavigationGroup, NavigationItem } from '../ui'
import type { Ghost, State } from '@ghost/contract';
import { dotState, stateLabel, toneFor, type DotState } from '../features/ghostState';
import { DotAvatar } from './DotAvatar';
import { routeLabels } from '../uiText';
import type { HostStatus } from '../features/hostStatus';

/** One page of a Ghost besides its conversation: its work and its earlier conversations. */
export interface GhostMenuItem { key: string; label: string; path: string; kind: 'work' | 'history' }

const menuIcons = { work: LayoutList, history: History };

/** Only states that need a glance get a mark; an idle Ghost stays quiet. */
const stateDot: Partial<Record<DotState, string>> = {
  working: 'bg-ink animate-pulse motion-reduce:animate-none',
  attention: 'bg-orange',
  offline: 'bg-red',
};

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
  const hostTrouble = status.state !== 'connected';
  return <>
    <Navigation label="작업실" className="ghost-sidebar min-h-0 flex-1 overflow-y-auto p-3">
      <NavigationItem current={section === 'home'} onClick={() => navigate('/')}>
        <Home/><span className="flex-1">{routeLabels.home}</span>{attentionCount > 0 && <Badge variant="warning"><span className="sr-only">확인 필요 </span>{attentionCount}</Badge>}
      </NavigationItem>
      {ghosts.length > 0 && <NavigationGroup label="Ghost">{ghosts.map(ghost => {
        const open = ghost.id === openGhostId;
        const name = ghost.name;
        const mood = state ? dotState(ghost, state) : 'idle';
        const menu = ghostMenu(ghost);
        const unfolded = menu.length > 0 && expanded.has(ghost.id);
        return <div key={ghost.id} className="grid gap-1">
          <div className="relative">
            <NavigationItem current={open && currentGhostPage === 'chat'} className={`w-full ${open ? 'text-ink' : ''}`} style={menu.length ? { paddingRight: 34 } : undefined} onClick={() => openGhost(ghost.id)}>
              <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={18}/><span className="min-w-0 flex-1 truncate">{name}</span>
              {ghost.isDefault && <Badge variant="outline">메인</Badge>}
              {stateDot[mood] && <span className={`size-1.5 shrink-0 rounded-full ${stateDot[mood]}`} title={stateLabel[mood]}><span className="sr-only">{stateLabel[mood]}</span></span>}
            </NavigationItem>
            {menu.length > 0 && <button type="button" aria-expanded={unfolded} aria-label={`${name} 하위 메뉴 ${unfolded ? '접기' : '펼치기'}`} onClick={() => toggle(ghost.id)}
              className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-full text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3">
              <ChevronRight size={14} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${unfolded ? 'rotate-90' : ''}`}/>
            </button>}
          </div>
          {unfolded && <div className="ml-[17px] grid gap-1 border-l border-line pl-1.5">{menu.map(item => {
            const Icon = menuIcons[item.kind];
            return <NavigationItem key={item.key} current={open && item.key === currentGhostPage} onClick={() => navigate(item.path)}><Icon/><span>{item.label}</span></NavigationItem>;
          })}</div>}
        </div>;
      })}</NavigationGroup>}
      {spaces.length > 0 && <NavigationGroup label="프로젝트" className="relative">
        <button type="button" aria-label="새 프로젝트" title="새 프로젝트" onClick={() => navigate('/spaces?new=1')}
          className="absolute top-1.5 right-1 grid size-6 cursor-pointer place-items-center rounded-full text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3"><Plus size={14} aria-hidden="true"/></button>
        {spaces.map(space => <NavigationItem key={space.id} current={section === 'spaces' && space.id === selectedSpace} onClick={() => navigate(`/spaces/${space.id}`)}>
          <Folder/><span>{space.name}</span>
        </NavigationItem>)}
      </NavigationGroup>}
    </Navigation>
    <div className="shrink-0 border-t border-line p-3">
      <NavigationItem className="w-full" current={section === 'settings'} aria-describedby={hostTrouble ? hostStatusId : undefined}
        onClick={() => navigate(hostTrouble ? '/settings?tab=host' : '/settings')}>
        <Settings2/><span className="flex-1">설정</span>
        {hostTrouble && <Badge variant="danger" id={hostStatusId}>{status.label}</Badge>}
      </NavigationItem>
    </div>
  </>;
}
