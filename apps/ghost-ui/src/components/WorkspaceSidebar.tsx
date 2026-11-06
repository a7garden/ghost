import { Folder, History, Home, LayoutGrid, LayoutList, MessageCircle, Plus, Settings2 } from 'lucide-react';
import { useId } from 'react';
import { Badge, GNavigation, GNavigationGroup, GNavigationItem } from '@garden/ui';
import type { Snapshot } from '../client/types';
import { toneFor } from '../client/types';
import { DotAvatar } from './DotAvatar';
import { routeLabels } from '../uiText';
import type { HostStatus } from '../features/hostStatus';
import { ghostDisplayName } from '../features/profileSummary';

/** One page inside the open Ghost: its conversation, its work, package views and earlier conversations. */
export interface GhostMenuItem { key: string; label: string; path: string; kind: 'chat' | 'work' | 'view' | 'history' }

const menuIcons = { chat: MessageCircle, work: LayoutList, view: LayoutGrid, history: History };

export function WorkspaceSidebar({ snapshot, section, openGhostId, ghostMenu, currentGhostPage, defaultGhostId, selectedSpace, attentionCount, status, canCreateProject, navigate, openGhost }: {
  snapshot: Snapshot | null;
  section: string;
  /** Ghost whose pages are on screen; null on workspace pages. */
  openGhostId: string | null;
  ghostMenu: GhostMenuItem[];
  currentGhostPage: string | null;
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
  const spaces = snapshot?.spaces ?? [];
  const hostTrouble = status.state !== 'connected' && status.state !== 'demo';
  return <>
    <GNavigation label="작업실" className="min-h-0 flex-1 overflow-y-auto p-3">
      <GNavigationItem current={section === 'home'} onClick={() => navigate('/')}>
        <Home/><span className="flex-1">{routeLabels.home}</span>{attentionCount > 0 && <Badge variant="warning"><span className="sr-only">확인 필요 </span>{attentionCount}</Badge>}
      </GNavigationItem>
      {ghosts.length > 0 && <GNavigationGroup label="Ghost" className="mt-3">{ghosts.map(profile => {
        const open = profile.id === openGhostId;
        const name = ghostDisplayName(profile.name);
        return <div key={profile.id} className="grid gap-1">
          <GNavigationItem className={open ? 'font-semibold text-ink' : undefined} onClick={() => openGhost(profile.id)}>
            <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={18}/><span className="flex-1">{name}</span>
            {profile.id === defaultGhostId && <Badge variant="outline">기본</Badge>}
          </GNavigationItem>
          {open && ghostMenu.length > 0 && <div className="ml-[17px] grid gap-1 border-l border-line pl-1.5">{ghostMenu.map(item => {
            const Icon = menuIcons[item.kind];
            return <GNavigationItem key={item.key} current={item.key === currentGhostPage} onClick={() => navigate(item.path)}><Icon/><span>{item.label}</span></GNavigationItem>;
          })}</div>}
        </div>;
      })}</GNavigationGroup>}
      {(spaces.length > 0 || canCreateProject) && <GNavigationGroup label="프로젝트" className="mt-3">
        {spaces.map(space => <GNavigationItem key={space.id} current={section === 'spaces' && space.id === selectedSpace} onClick={() => navigate(`/spaces/${space.id}`)}>
          <Folder/><span>{space.name}</span>
        </GNavigationItem>)}
        {canCreateProject && <GNavigationItem className="text-ink-3" onClick={() => navigate('/spaces?new=1')}><Plus/><span>새 프로젝트</span></GNavigationItem>}
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
