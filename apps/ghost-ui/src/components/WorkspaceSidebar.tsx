import { useId, useState } from 'react';
import { CalendarDays, ChevronDown, CircleHelp, Folder, GitBranch, Home, Inbox, LayoutList, MessageCircle, Plug, Settings2 } from 'lucide-react';
import { ghostPath, viewPath } from '../features/PackageWorkspace';
import type { GhostView } from '../../sdk/src/index';
import type { Snapshot } from '../client/types';
import { routeLabels } from '../uiText';

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
  showGhostHeading?: boolean;
  navigate(path: string): void;
  onConnection(): void;
};

export function WorkspaceSidebar({ snapshot, route, section, dotId, selectedSpace, views, activeView, attentionCount, mode, error, lifetimeEnabled, showGhostHeading = true, navigate, onConnection }: Props) {
  const primaryChat = lifetimeEnabled && mode === 'live';
  const [spacesOpen, setSpacesOpen] = useState(!primaryChat);
  const params = new URLSearchParams(route.split('?')[1] || '');
  const panel = params.get('panel');
  const profile = snapshot?.profiles.find(item => item.id === dotId);
  const conversation = params.get('conversation') ?? profile?.conversations[0]?.id;
  const [conversationsOpen, setConversationsOpen] = useState(true);
  const primarySection = primaryChat && section === 'lifetime' && panel === 'work' ? 'work' : section;
  const spacesId = useId(), conversationsId = useId();
  const chatSelected = Boolean(dotId && !activeView && (section === 'ghosts' || (section === 'lifetime' && !panel && !params.has('create'))));
  return <>
    <div className="sidebar-scroll">
      {profile && <section className="sidebar-menu-group" aria-label={`${profile.name} 메뉴`}>
        {showGhostHeading && <h2 className="sidebar-group-title">{profile.name}</h2>}
        <nav className="primary-nav ghost-view-nav" aria-label={`${profile.name} 화면`}>
          <button className={`nav-row ${chatSelected ? 'selected' : ''}`} aria-current={chatSelected ? 'page' : undefined}
            onClick={() => navigate(ghostPath(profile.id))}><MessageCircle size={16}/>대화</button>
          {views.map(view => <button key={view.id} className={`nav-row ${activeView === view.id ? 'selected' : ''}`}
            aria-current={activeView === view.id ? 'page' : undefined}
            onClick={() => navigate(viewPath(profile.id, view.id))}><LayoutList size={16}/><span>{view.label}</span></button>)}
        </nav>
        {profile.conversations.length > 0 && <section className="sidebar-section sidebar-history">
          <div className="sidebar-label">
            <button className="sidebar-section-toggle" aria-expanded={conversationsOpen} aria-controls={conversationsId}
              onClick={() => setConversationsOpen(!conversationsOpen)}><ChevronDown size={13}/><span>대화 기록</span></button>
          </div>
          <nav className="sidebar-nested-nav" id={conversationsId} aria-label={`${profile.name} 대화 기록`} hidden={!conversationsOpen}>
            {profile.conversations.map((item, index) => {
              const active = chatSelected && conversation === item.id;
              const path = primaryChat
                ? `/lifetime?ghost=${encodeURIComponent(profile.id)}&conversation=${encodeURIComponent(item.id)}`
                : `${ghostPath(profile.id)}?conversation=${encodeURIComponent(item.id)}`;
              return <button key={item.id} className={`sidebar-conversation ${active ? 'selected' : ''}`}
                aria-current={active ? 'page' : undefined} title={item.title} onClick={() => navigate(path)}>
                <span>{item.title || `대화 ${index + 1}`}</span></button>;
            })}
          </nav>
        </section>}
      </section>}
      <section className="sidebar-menu-group sidebar-menu-group--shared" aria-label="공통 메뉴">
        <h2 className="sidebar-group-title">공통</h2>
        <nav className="primary-nav" aria-label="공통 화면">{[
          ...(!dotId && primaryChat ? [{ path: '/lifetime', key: 'lifetime', name: routeLabels.lifetime, Icon: MessageCircle }] : []),
          { path: '/inbox', key: 'inbox', name: routeLabels.inbox, Icon: Inbox },
          { path: primaryChat ? '/lifetime?panel=work' : '/work', key: 'work', name: routeLabels.work, Icon: LayoutList },
          { path: '/', key: 'home', name: routeLabels.home, Icon: Home },
        ].map(({ path, key, name, Icon }) => <button key={key} className={`nav-row ${primarySection === key ? 'selected' : ''}`}
          aria-current={primarySection === key ? 'page' : undefined} onClick={() => navigate(path)}>
          <Icon size={16}/><span>{name}</span>{key === 'inbox' && attentionCount > 0 && <span className="nav-count">{attentionCount}</span>}
        </button>)}</nav>
        {snapshot?.spaces.length ? <section className="sidebar-section">
          <div className="sidebar-label"><button className="sidebar-section-toggle" aria-expanded={spacesOpen} aria-controls={spacesId}
            onClick={() => setSpacesOpen(!spacesOpen)}><ChevronDown size={13}/><span>{routeLabels.spaces}</span>
            <span className="sidebar-section-count">{snapshot.spaces.length}</span></button></div>
          <nav className="sidebar-nested-nav" id={spacesId} aria-label={routeLabels.spaces} hidden={!spacesOpen}>
            {snapshot.spaces.map(space =>
              <button key={space.id} className={`nav-row ${selectedSpace === space.id && section === 'spaces' ? 'selected' : ''}`}
                aria-current={selectedSpace === space.id && section === 'spaces' ? 'page' : undefined} title={space.name}
                onClick={() => navigate(`/spaces/${space.id}`)}><Folder size={14}/><span>{space.name}</span></button>)}
          </nav>
        </section> : <button className={`nav-row ${section === 'spaces' ? 'selected' : ''}`}
          aria-current={section === 'spaces' ? 'page' : undefined} onClick={() => navigate('/spaces')}>
          <Folder size={16}/><span>{routeLabels.spaces}</span></button>}
        <nav className="sidebar-tools" aria-label="작업실 도구">{[
          { path: '/together', key: 'together', name: routeLabels.together, Icon: GitBranch },
          { path: '/planner', key: 'planner', name: routeLabels.planner, Icon: CalendarDays },
          { path: '/integrations', key: 'integrations', name: routeLabels.integrations, Icon: Plug },
        ].map(({ path, key, name, Icon }) => <button key={key} className={`nav-row ${section === key ? 'selected' : ''}`}
          aria-current={section === key ? 'page' : undefined} onClick={() => navigate(path)}><Icon size={16}/><span>{name}</span></button>)}</nav>
      </section>
    </div>
    <footer className="sidebar-bottom">
      <button className={`nav-row ${section === 'settings' ? 'selected' : ''}`} aria-current={section === 'settings' ? 'page' : undefined}
        onClick={() => navigate(`/settings?tab=appearance${dotId ? `&ghost=${encodeURIComponent(dotId)}` : ''}`)}><Settings2 size={16}/><span>앱 설정</span></button>
      <button className={`icon-button sidebar-connection-status ${error ? 'disconnected' : ''}`}
        aria-label={error ? '연결 확인 필요' : mode === 'demo' ? '예시 모드' : '작업실 연결 안내'}
        title={error ? '연결 확인 필요' : mode === 'demo' ? '예시 모드' : '작업실 연결 안내'}
        onClick={onConnection}><CircleHelp size={16}/></button>
    </footer>
  </>;
}
