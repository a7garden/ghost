import { ChevronRight, Folder, History, Home, LayoutGrid, LayoutList, Plus, Settings2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Badge, GNavigation, GNavigationGroup, GNavigationItem } from '@garden/ui';
import type { DotState, Profile, Snapshot } from '../client/types';
import { dotState, stateLabel, toneFor } from '../client/types';
import { DotAvatar } from './DotAvatar';
import { routeLabels } from '../uiText';
import type { HostStatus } from '../features/hostStatus';
import { ghostDisplayName } from '../features/profileSummary';

/** One page of a Ghost besides its conversation: its work, package views and earlier conversations. */
export interface GhostMenuItem { key: string; label: string; path: string; kind: 'work' | 'view' | 'history' }

const menuIcons = { work: LayoutList, view: LayoutGrid, history: History };

/** Only states that need a glance get a mark; an idle Ghost stays quiet. */
const stateDot: Partial<Record<DotState, string>> = {
  working: 'bg-ink animate-pulse motion-reduce:animate-none',
  attention: 'bg-orange',
  offline: 'bg-red',
};

export function WorkspaceSidebar({ snapshot, section, openGhostId, ghostMenu, currentGhostPage, defaultGhostId, selectedSpace, attentionCount, status, canCreateProject, navigate, openGhost }: {
  snapshot: Snapshot | null;
  section: string;
  /** Ghost whose pages are on screen; null on workspace pages. */
  openGhostId: string | null;
  ghostMenu(profile: Profile): GhostMenuItem[];
  currentGhostPage: string | null;
  /** The owner's main Ghost: listed first and marked. */
  defaultGhostId: string | null;
  selectedSpace?: string;
  attentionCount: number;
  status: HostStatus;
  /** The host can connect a project folder; otherwise 새 프로젝트 would open nothing. */
  canCreateProject: boolean;
  navigate(path: string): void;
  openGhost(id: string): void;
}) {
  const hostStatusId = useId();
  // The default Ghost is the entry point, so it always leads the list.
  const ghosts = [...snapshot?.profiles ?? []].sort((a, b) => Number(b.id === defaultGhostId) - Number(a.id === defaultGhostId));
  // Each Ghost folds on its own; opening a Ghost unfolds it, and the chevron folds or unfolds without navigating.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(openGhostId ? [openGhostId] : []));
  useEffect(() => { if (openGhostId) setExpanded(current => current.has(openGhostId) ? current : new Set(current).add(openGhostId)); }, [openGhostId]);
  const toggle = (id: string) => setExpanded(current => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const spaces = snapshot?.spaces ?? [];
  const hostTrouble = status.state !== 'connected' && status.state !== 'demo';
  return <>
    <GNavigation label="작업실" className="ghost-sidebar min-h-0 flex-1 overflow-y-auto p-3">
      <GNavigationItem current={section === 'home'} onClick={() => navigate('/')}>
        <Home/><span className="flex-1">{routeLabels.home}</span>{attentionCount > 0 && <Badge variant="warning"><span className="sr-only">확인 필요 </span>{attentionCount}</Badge>}
      </GNavigationItem>
      {ghosts.length > 0 && <GNavigationGroup label="Ghost">{ghosts.map(profile => {
        const open = profile.id === openGhostId;
        const name = ghostDisplayName(profile);
        const state = dotState(profile, snapshot?.reviews ?? []);
        const menu = ghostMenu(profile);
        const unfolded = menu.length > 0 && expanded.has(profile.id);
        return <div key={profile.id} className="grid gap-1">
          <div className="relative">
            {/* Garden's unlayered item padding beats utilities; the chevron's room is set inline. */}
            <GNavigationItem current={open && currentGhostPage === 'chat'} className={`w-full ${open ? 'text-ink' : ''}`} style={menu.length ? { paddingRight: 34 } : undefined} onClick={() => openGhost(profile.id)}>
              <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={18}/><span className="min-w-0 flex-1 truncate">{name}</span>
              {profile.id === defaultGhostId && <Badge variant="outline">메인</Badge>}
              {stateDot[state] && <span className={`size-1.5 shrink-0 rounded-full ${stateDot[state]}`} title={stateLabel[state]}><span className="sr-only">{stateLabel[state]}</span></span>}
            </GNavigationItem>
            {menu.length > 0 && <button type="button" aria-expanded={unfolded} aria-label={`${name} 하위 메뉴 ${unfolded ? '접기' : '펼치기'}`} onClick={() => toggle(profile.id)}
              className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-full text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3">
              <ChevronRight size={14} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${unfolded ? 'rotate-90' : ''}`}/>
            </button>}
          </div>
          {unfolded && <div className="ml-[17px] grid gap-1 border-l border-line pl-1.5">{menu.map(item => {
            const Icon = menuIcons[item.kind];
            return <GNavigationItem key={item.key} current={open && item.key === currentGhostPage} onClick={() => navigate(item.path)}><Icon/><span>{item.label}</span></GNavigationItem>;
          })}</div>}
        </div>;
      })}</GNavigationGroup>}
      {(spaces.length > 0 || canCreateProject) && <GNavigationGroup label="프로젝트" className="relative">
        {canCreateProject && <button type="button" aria-label="새 프로젝트" title="새 프로젝트" onClick={() => navigate('/spaces?new=1')}
          className="absolute top-1.5 right-1 grid size-6 cursor-pointer place-items-center rounded-full text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3"><Plus size={14} aria-hidden="true"/></button>}
        {spaces.map(space => <GNavigationItem key={space.id} current={section === 'spaces' && space.id === selectedSpace} onClick={() => navigate(`/spaces/${space.id}`)}>
          <Folder/><span>{space.name}</span>
        </GNavigationItem>)}
      </GNavigationGroup>}
    </GNavigation>
    <div className="shrink-0 border-t border-line p-3">
      <GNavigationItem className="w-full" current={section === 'settings'} aria-describedby={hostTrouble ? hostStatusId : undefined}
        onClick={() => navigate(hostTrouble ? '/settings?tab=host' : '/settings')}>
        <Settings2/><span className="flex-1">설정</span>
        {hostTrouble && <Badge variant="danger" id={hostStatusId}>{status.label}</Badge>}
      </GNavigationItem>
    </div>
  </>;
}
