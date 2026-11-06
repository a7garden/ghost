import { Folder, History, Home, LayoutGrid, LayoutList, MessageCircle, Plus, Settings2 } from 'lucide-react';
import { useId } from 'react';
import type { Snapshot } from '../client/types';
import { toneFor } from '../client/types';
import { DotAvatar } from './DotAvatar';
import { routeLabels } from '../uiText';
import type { HostStatus } from '../features/hostStatus';
import { ghostDisplayName } from '../features/profileSummary';

/** One page inside the open Ghost: its conversation, its work, package views and earlier conversations. */
export interface GhostMenuItem { key: string; label: string; path: string; kind: 'chat' | 'work' | 'view' | 'history' }

type Props = {
  snapshot: Snapshot | null;
  section: string;
  /** Ghost whose pages are on screen; null on workspace pages. */
  openGhostId: string | null;
  /** Pages of the open Ghost, and which one is on screen. */
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
};

const menuIcons = { chat: MessageCircle, work: LayoutList, view: LayoutGrid, history: History };

export function WorkspaceSidebar({ snapshot, section, openGhostId, ghostMenu, currentGhostPage, defaultGhostId, selectedSpace, attentionCount, status, canCreateProject, navigate, openGhost }: Props) {
  // The sidebar renders twice on mobile (aside + navigation dialog), so ids must be per instance.
  const hostStatusId = useId(), ghostsId = useId(), projectsId = useId();
  const profiles = snapshot?.profiles ?? [];
  // The default Ghost is the entry point, so it always leads the list.
  const ghosts = [...profiles].sort((a, b) => Number(b.id === defaultGhostId) - Number(a.id === defaultGhostId));
  const hostTrouble = status.state !== 'connected' && status.state !== 'demo';
  return <>
    <div className="sidebar-scroll">
      <nav className="primary-nav" aria-label="기본 메뉴">
        <button className={`nav-row ${section === 'home' ? 'selected' : ''}`} aria-current={section === 'home' ? 'page' : undefined} onClick={() => navigate('/')}>
          <Home size={16}/><span>{routeLabels.home}</span>{attentionCount > 0 && <span className="nav-count"><span className="sr-only">확인 필요 </span>{attentionCount}</span>}
        </button>
      </nav>
      {ghosts.length > 0 && <section className="sidebar-menu-group" aria-labelledby={ghostsId}>
        <h2 className="sidebar-group-title" id={ghostsId}>Ghost</h2>
        <ul className="sidebar-ghosts">{ghosts.map(profile => {
          const open = profile.id === openGhostId;
          const name = ghostDisplayName(profile.name);
          return <li key={profile.id} className={open ? 'sidebar-ghost open' : 'sidebar-ghost'}>
            <button className="nav-row sidebar-ghost-row" onClick={() => openGhost(profile.id)}>
              <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={18}/><span>{name}</span>
              {profile.id === defaultGhostId && <span className="ghost-default-badge">기본</span>}
            </button>
            {open && ghostMenu.length > 0 && <nav className="primary-nav sidebar-ghost-menu" aria-label={`${name} 메뉴`}>{ghostMenu.map(item => {
              const Icon = menuIcons[item.kind];
              const current = item.key === currentGhostPage;
              return <button key={item.key} className={`nav-row ${current ? 'selected' : ''}`} aria-current={current ? 'page' : undefined}
                onClick={() => navigate(item.path)}><Icon size={14}/><span>{item.label}</span></button>;
            })}</nav>}
          </li>;
        })}</ul>
      </section>}
      {(Boolean(snapshot?.spaces.length) || canCreateProject) && <section className="sidebar-menu-group" aria-labelledby={projectsId}>
        <h2 className="sidebar-group-title" id={projectsId}>프로젝트</h2>
        <nav className="primary-nav" aria-label="프로젝트">
          {(snapshot?.spaces ?? []).map(space => {
            const current = section === 'spaces' && selectedSpace === space.id;
            return <button key={space.id} className={`nav-row ${current ? 'selected' : ''}`} aria-current={current ? 'page' : undefined}
              onClick={() => navigate(`/spaces/${space.id}`)}><Folder size={16}/><span>{space.name}</span></button>;
          })}
          {canCreateProject && <button className="nav-row sidebar-quiet-row" onClick={() => navigate('/spaces?new=1')}><Plus size={16}/><span>새 프로젝트</span></button>}
        </nav>
      </section>}
    </div>
    <footer className="sidebar-bottom">
      <nav className="primary-nav" aria-label="설정">
        <button className={`nav-row ${section === 'settings' ? 'selected' : ''}`} aria-current={section === 'settings' ? 'page' : undefined}
          aria-describedby={hostTrouble ? hostStatusId : undefined} onClick={() => navigate(hostTrouble ? '/settings?tab=host' : '/settings')}>
          <Settings2 size={16}/><span>설정</span>
          {hostTrouble && <span className="dashboard-status sidebar-host-indicator" id={hostStatusId} data-state={status.state}><i/>{status.label}</span>}
        </button>
      </nav>
    </footer>
  </>;
}
