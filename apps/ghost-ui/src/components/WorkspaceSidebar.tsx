import { CalendarDays, Cpu, Puzzle, Server, Folder, GitBranch, History, Home, Inbox, LayoutList, MessageCircle, Settings2 } from 'lucide-react';
import { useId } from 'react';
import { ghostPath, viewPath } from '../features/PackageWorkspace';
import type { GhostView } from '../../sdk/src/index';
import type { Snapshot } from '../client/types';
import { routeLabels } from '../uiText';
import { hostStatus, type HostStatus } from '../features/hostStatus';
import { legacyHistoryPath, legacyHistoryRequested } from '../features/LegacyTranscript';

type Props = {
  snapshot: Snapshot | null;
  route: string;
  section: string;
  dotId: string | null;
  selectedSpace?: string;
  views: GhostView[];
  activeView?: string;
  attentionCount: number;
  mode: string;
  error: string;
  lifetimeEnabled: boolean;
  status?: HostStatus;
  navigate(path: string): void;
};

export function WorkspaceSidebar({ snapshot, route, section, dotId, selectedSpace, views, activeView, attentionCount, mode, error, lifetimeEnabled, status, navigate }: Props) {
  const hostStatusId = useId();
  const { state: hostState, label: hostLabel } = status ?? hostStatus(mode, error, null, false);
  const durableHost = lifetimeEnabled && mode === 'live';
  const params = new URLSearchParams(route.split('?')[1] || '');
  const panel = params.get('panel');
  const profile = snapshot?.profiles.find(item => item.id === dotId);
  const conversations = profile?.conversations ?? [];
  const currentConversation = durableHost ? undefined : conversations[0];
  const previousConversations = durableHost ? conversations : conversations.slice(1);
  const conversationId = params.get('conversation') ?? conversations[0]?.id;
  const primarySection = section === 'lifetime' && panel === 'work' ? 'work' : section;
  const profilePath = profile ? ghostPath(profile.id) : '';
  const onProfileChat = section === 'ghosts' && route.split('?')[0].replace(/\/+$/, '') === profilePath;
  const onDurableChat = section === 'lifetime' && !panel && !params.has('create')
    && (!params.has('ghost') || params.get('ghost') === profile?.id);
  const viewingArchive = durableHost && onProfileChat && legacyHistoryRequested(route);
  const currentSelected = !activeView && !viewingArchive
    && (durableHost ? onProfileChat || onDurableChat : onProfileChat && conversationId === currentConversation?.id);
  const currentTitle = durableHost ? profile?.name ?? '대화' : currentConversation?.title.trim() || '새 대화';
  const currentPath = currentConversation
    ? `${profilePath}?${new URLSearchParams({ conversation: currentConversation.id })}` : profilePath;
  return <>
    <div className="sidebar-scroll">
      <nav className="primary-nav dashboard-primary-nav" aria-label="기본 메뉴">{[
        { path: '/', key: 'home', name: routeLabels.home, Icon: Home },
        { path: '/inbox', key: 'inbox', name: routeLabels.inbox, Icon: Inbox },
        { path: durableHost ? '/lifetime?panel=work&scope=all' : '/work', key: 'work', name: routeLabels.work, Icon: LayoutList },
      ].map(({ path, key, name, Icon }) => <button key={key} className={`nav-row ${primarySection === key ? 'selected' : ''}`} aria-current={primarySection === key ? 'page' : undefined} onClick={() => navigate(path)}><Icon size={16}/><span>{name}</span>{key === 'inbox' && attentionCount > 0 && <span className="nav-count">{attentionCount}</span>}</button>)}</nav>
      {profile && <section className="sidebar-menu-group" aria-label={`${profile.name} 대화`}>
        <h2 className="sidebar-group-title">대화</h2>
        <nav className="primary-nav sidebar-thread-list" aria-label={`${profile.name} 대화 목록`}>
          <button className={`nav-row ${currentSelected ? 'selected' : ''}`} aria-current={currentSelected ? 'page' : undefined}
            title={currentTitle} onClick={() => navigate(currentPath)}><MessageCircle size={16}/><span>{currentTitle}</span></button>
          {previousConversations.map((item, index) => {
            const active = !activeView && onProfileChat && (!durableHost || viewingArchive) && conversationId === item.id;
            const title = item.title || `대화 ${index + (durableHost ? 1 : 2)}`;
            return <button key={item.id} className={`nav-row ${active ? 'selected' : ''}`} aria-current={active ? 'page' : undefined}
              title={title} onClick={() => navigate(legacyHistoryPath(profile.id, item.id))}>
              <History size={16}/><span>{title}</span>
            </button>;
          })}
        </nav>
      </section>}
      {profile && views.length > 0 && <section className="sidebar-menu-group" aria-label={`${profile.name} 전용 화면`}>
        <h2 className="sidebar-group-title">전용 화면</h2>
        <nav className="primary-nav ghost-view-nav" aria-label={`${profile.name} 화면`}>
          {views.map(view => <button key={view.id} className={`nav-row ${activeView === view.id ? 'selected' : ''}`}
            aria-current={activeView === view.id ? 'page' : undefined}
            onClick={() => navigate(viewPath(profile.id, view.id))}><LayoutList size={16}/><span>{view.label}</span></button>)}
        </nav>
      </section>}
      <section className="sidebar-menu-group" aria-label={routeLabels.spaces}>
        {Boolean(snapshot?.spaces.length) && <h2 className="sidebar-group-title">{routeLabels.spaces}</h2>}
        <nav className="primary-nav sidebar-space-list" aria-label={routeLabels.spaces}>
          {snapshot?.spaces.length ? snapshot.spaces.map(space => {
            const active = selectedSpace === space.id && section === 'spaces';
            return <button key={space.id} className={`nav-row ${active ? 'selected' : ''}`}
              aria-current={active ? 'page' : undefined} title={space.name} onClick={() => navigate(`/spaces/${space.id}`)}>
              <Folder size={16}/><span>{space.name}</span>
            </button>;
          }) : <button className={`nav-row ${section === 'spaces' ? 'selected' : ''}`}
            aria-current={section === 'spaces' ? 'page' : undefined} onClick={() => navigate('/spaces')}>
            <Folder size={16}/><span>{routeLabels.spaces}</span>
          </button>}
        </nav>
      </section>
      <nav className="sidebar-menu-group primary-nav" aria-label="일정과 협업">{[
        { path: '/planner', key: 'planner', name: routeLabels.planner, Icon: CalendarDays },
        { path: '/together', key: 'together', name: routeLabels.together, Icon: GitBranch },
      ].map(({ path, key, name, Icon }) => <button key={key} className={`nav-row ${section === key ? 'selected' : ''}`}
        aria-current={section === key ? 'page' : undefined} onClick={() => navigate(path)}><Icon size={16}/><span>{name}</span></button>)}</nav>
    </div>
    <footer className="sidebar-bottom">
      <nav className="primary-nav" aria-label="관리">{[
        { path: '/host', key: 'host', name: '호스트', Icon: Server },
        { path: '/providers', key: 'providers', name: '프로바이더', Icon: Cpu },
        { path: '/integrations', key: 'integrations', name: '확장', Icon: Puzzle },
        { path: `/settings?tab=appearance${dotId ? `&ghost=${encodeURIComponent(dotId)}` : ''}`, key: 'settings', name: '앱 설정', Icon: Settings2 },
      ].map(({path,key,name,Icon}) => <button key={key} className={`nav-row ${section === key ? 'selected' : ''}`}
        aria-current={section === key ? 'page' : undefined} aria-label={key === 'host' ? name : undefined}
        aria-describedby={key === 'host' ? hostStatusId : undefined} onClick={() => navigate(path)}>
        <Icon size={16}/><span>{name}</span>
        {key === 'host' && <span className="dashboard-status sidebar-host-indicator" id={hostStatusId} data-state={hostState}><i/>{hostLabel}</span>}
      </button>)}</nav>
    </footer>
  </>;
}
