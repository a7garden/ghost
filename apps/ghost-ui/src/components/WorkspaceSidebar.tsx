import { Folder, History, Inbox, LayoutGrid, LayoutList, MessageCircle, Plus, Settings2, Users } from 'lucide-react';
import { Badge, GActivityRail, GActivityRailItem, GNavigation, GNavigationGroup, GNavigationItem } from '@garden/ui';
import type { Snapshot } from '../client/types';
import { toneFor } from '../client/types';
import { DotAvatar } from './DotAvatar';
import type { HostStatus } from '../features/hostStatus';
import { ghostDisplayName } from '../features/profileSummary';
import { routeLabels } from '../uiText';

/** Major workspaces selected by the activity rail; each has its own sidebar destinations. */
export type Workspace = 'chat' | 'work' | 'projects' | 'settings';

/** One page inside the open Ghost: its conversation, its work, package views and earlier conversations. */
export interface GhostMenuItem { key: string; label: string; path: string; kind: 'chat' | 'work' | 'view' | 'history' }

const menuIcons = { chat: MessageCircle, work: LayoutList, view: LayoutGrid, history: History };

export function WorkspaceRail({ workspace, attentionCount, status, open }: {
  workspace: Workspace; attentionCount: number; status: HostStatus; open(workspace: Workspace): void;
}) {
  const hostTrouble = status.state !== 'connected' && status.state !== 'demo';
  const settingsLabel = hostTrouble ? `설정 · 호스트 ${status.label}` : '설정';
  return <GActivityRail label="작업 공간" footer={
    <GActivityRailItem label={settingsLabel} current={workspace === 'settings'} onClick={() => open('settings')}>
      <span className="relative inline-flex"><Settings2 size={18}/>{hostTrouble && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-danger"/>}</span>
    </GActivityRailItem>}>
    <GActivityRailItem label="대화" current={workspace === 'chat'} onClick={() => open('chat')}><MessageCircle size={18}/></GActivityRailItem>
    <GActivityRailItem label={attentionCount ? `일 · 확인 필요 ${attentionCount}` : '일'} current={workspace === 'work'} onClick={() => open('work')}>
      <span className="relative inline-flex"><LayoutList size={18}/>{attentionCount > 0 && <span className="absolute -top-1 -right-1.5 min-w-3.5 rounded-full bg-ink px-1 text-center text-[10px] leading-3.5 text-canvas">{attentionCount}</span>}</span>
    </GActivityRailItem>
    <GActivityRailItem label="프로젝트" current={workspace === 'projects'} onClick={() => open('projects')}><Folder size={18}/></GActivityRailItem>
  </GActivityRail>;
}

/** Destinations of the conversation workspace: a new request and each Ghost, with the open Ghost's own pages. */
export function ChatNavigation({ snapshot, home, openGhostId, ghostMenu, currentGhostPage, defaultGhostId, navigate, openGhost }: {
  snapshot: Snapshot; home: boolean; openGhostId: string | null; ghostMenu: GhostMenuItem[]; currentGhostPage: string | null;
  defaultGhostId: string | null; navigate(path: string): void; openGhost(id: string): void;
}) {
  // The default Ghost is the entry point, so it always leads the list.
  const ghosts = [...snapshot.profiles].sort((a, b) => Number(b.id === defaultGhostId) - Number(a.id === defaultGhostId));
  return <GNavigation label="대화">
    <GNavigationItem current={home} onClick={() => navigate('/')}><Plus/><span>새 요청</span></GNavigationItem>
    {ghosts.length > 0 && <GNavigationGroup label="Ghost">{ghosts.map(profile => {
      const open = profile.id === openGhostId;
      const name = ghostDisplayName(profile.name);
      return <div key={profile.id} className="grid gap-1">
        <GNavigationItem className={open ? 'font-semibold text-ink' : undefined} onClick={() => openGhost(profile.id)}>
          <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={18}/><span className="flex-1">{name}</span>
          {profile.id === defaultGhostId && <Badge variant="outline">기본</Badge>}
        </GNavigationItem>
        {open && ghostMenu.map(item => {
          const Icon = menuIcons[item.kind];
          return <GNavigationItem key={item.key} className="ml-6" current={item.key === currentGhostPage} onClick={() => navigate(item.path)}>
            <Icon/><span>{item.label}</span>
          </GNavigationItem>;
        })}
      </div>;
    })}</GNavigationGroup>}
  </GNavigation>;
}

/** Destinations of the work workspace: decisions first, then every piece of work, then collaboration records. */
export function WorkNavigation({ current, attentionCount, workPath, navigate }: {
  current: 'inbox' | 'all' | 'together' | null; attentionCount: number; workPath: string; navigate(path: string): void;
}) {
  return <GNavigation label="일">
    <GNavigationItem current={current === 'inbox'} onClick={() => navigate('/inbox')}>
      <Inbox/><span className="flex-1">{routeLabels.inbox}</span>{attentionCount > 0 && <Badge>{attentionCount}</Badge>}
    </GNavigationItem>
    <GNavigationItem current={current === 'all'} onClick={() => navigate(workPath)}><LayoutList/><span>{routeLabels.work}</span></GNavigationItem>
    <GNavigationItem current={current === 'together'} onClick={() => navigate('/together')}><Users/><span>협업</span></GNavigationItem>
  </GNavigation>;
}

export function ProjectNavigation({ snapshot, selectedSpace, canCreate, navigate }: {
  snapshot: Snapshot; selectedSpace?: string; canCreate: boolean; navigate(path: string): void;
}) {
  return <GNavigation label="프로젝트">
    {snapshot.spaces.map(space => <GNavigationItem key={space.id} current={space.id === selectedSpace} onClick={() => navigate(`/spaces/${space.id}`)}>
      <Folder/><span>{space.name}</span>
    </GNavigationItem>)}
    {canCreate && <GNavigationItem className="text-ink-3" onClick={() => navigate('/spaces?new=1')}><Plus/><span>새 프로젝트</span></GNavigationItem>}
  </GNavigation>;
}
