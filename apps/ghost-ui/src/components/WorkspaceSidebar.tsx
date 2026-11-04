import { CalendarDays, Cpu, Puzzle, Server, Folder, GitBranch, Home, Inbox, LayoutList, MessageCircle, Settings2 } from 'lucide-react';
import { ghostPath, viewPath } from '../features/PackageWorkspace';
import type { GhostView } from '../../sdk/src/index';
import type { Snapshot } from '../client/types';
import { routeLabels } from '../uiText';
import type { HostStatus } from '../features/hostStatus';
import { legacyHistoryPath } from '../features/LegacyTranscript';

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
  status?: HostStatus;
  navigate(path: string): void;
  onConnection(): void;
};

export function WorkspaceSidebar({ snapshot, route, section, dotId, selectedSpace, views, activeView, attentionCount, mode, error, lifetimeEnabled, showGhostHeading = true, status, navigate, onConnection }: Props) {
  const durableHost = lifetimeEnabled && mode === 'live';
  const params = new URLSearchParams(route.split('?')[1] || '');
  const panel = params.get('panel');
  const profile = snapshot?.profiles.find(item => item.id === dotId);
  const conversation = params.get('conversation') ?? profile?.conversations[0]?.id;
  const primarySection = section === 'lifetime' ? panel === 'work' ? 'work' : panel === 'ghosts' ? 'ghosts' : 'ghosts' : section;
  const chatSelected = Boolean(dotId && !activeView && (section === 'ghosts' || (section === 'lifetime' && !panel && !params.has('create'))));
  return <>
    <div className="sidebar-scroll">
      <nav className="primary-nav dashboard-primary-nav" aria-label="기본 메뉴">{[
        { path: '/', key: 'home', name: routeLabels.home, Icon: Home },
        { path: '/ghosts', key: 'ghosts', name: routeLabels.ghosts, Icon: MessageCircle },
        { path: '/inbox', key: 'inbox', name: routeLabels.inbox, Icon: Inbox },
        { path: durableHost ? '/lifetime?panel=work&scope=all' : '/work', key: 'work', name: routeLabels.work, Icon: LayoutList },
      ].map(({ path, key, name, Icon }) => <button key={key} className={`nav-row ${primarySection === key ? 'selected' : ''}`} aria-current={primarySection === key ? 'page' : undefined} onClick={() => navigate(path)}><Icon size={16}/><span>{name}</span>{key === 'inbox' && attentionCount > 0 && <span className="nav-count">{attentionCount}</span>}</button>)}</nav>
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
          <h3 className="sidebar-label">대화 기록</h3>
          <nav className="sidebar-nested-nav" aria-label={`${profile.name} 대화 기록`}>
            {profile.conversations.map((item, index) => {
              const active = chatSelected && conversation === item.id;
              const path = legacyHistoryPath(profile.id, item.id);
              return <button key={item.id} className={`sidebar-conversation ${active ? 'selected' : ''}`}
                aria-current={active ? 'page' : undefined} title={item.title} onClick={() => navigate(path)}>
                <span>{item.title || `대화 ${index + 1}`}</span></button>;
            })}
          </nav>
        </section>}
      </section>}
      <section className="sidebar-menu-group sidebar-menu-group--shared" aria-label="도구">
        <h2 className="sidebar-group-title">도구</h2>
        {snapshot?.spaces.length ? <section className="sidebar-section">
          <h3 className="sidebar-label">{routeLabels.spaces}</h3>
          <nav className="sidebar-nested-nav" aria-label={routeLabels.spaces}>
            {snapshot.spaces.map(space =>
              <button key={space.id} className={`nav-row ${selectedSpace === space.id && section === 'spaces' ? 'selected' : ''}`}
                aria-current={selectedSpace === space.id && section === 'spaces' ? 'page' : undefined} title={space.name}
                onClick={() => navigate(`/spaces/${space.id}`)}><Folder size={14}/><span>{space.name}</span></button>)}
          </nav>
        </section> : <button className={`nav-row ${section === 'spaces' ? 'selected' : ''}`}
          aria-current={section === 'spaces' ? 'page' : undefined} onClick={() => navigate('/spaces')}>
          <Folder size={16}/><span>{routeLabels.spaces}</span></button>}
        <nav className="sidebar-tools" aria-label="도구">{[
          { path: '/planner', key: 'planner', name: routeLabels.planner, Icon: CalendarDays },
        ].map(({ path, key, name, Icon }) => <button key={key} className={`nav-row ${section === key ? 'selected' : ''}`}
          aria-current={section === key ? 'page' : undefined} onClick={() => navigate(path)}><Icon size={16}/><span>{name}</span></button>)}
          <button className={`nav-row ${section === 'together' ? 'selected' : ''}`} aria-current={section === 'together' ? 'page' : undefined}
            onClick={() => navigate('/together')}><GitBranch size={16}/><span>협업 기록</span></button>
        </nav>
      </section>
      <section className="sidebar-menu-group" aria-label="호스트 관리"><h2 className="sidebar-group-title">관리</h2><nav className="primary-nav">{[
        { path: '/host', key: 'host', name: '호스트', Icon: Server },
        { path: '/providers', key: 'providers', name: '프로바이더', Icon: Cpu },
        { path: '/integrations', key: 'integrations', name: '확장', Icon: Puzzle },
      ].map(({path,key,name,Icon}) => <button key={key} className={`nav-row ${section === key ? 'selected' : ''}`} aria-current={section === key ? 'page' : undefined} onClick={() => navigate(path)}><Icon size={16}/><span>{name}</span></button>)}</nav></section>
    </div>
    <footer className="sidebar-bottom">
      <button className={`nav-row ${section === 'settings' ? 'selected' : ''}`} aria-current={section === 'settings' ? 'page' : undefined}
        onClick={() => navigate(`/settings?tab=appearance${dotId ? `&ghost=${encodeURIComponent(dotId)}` : ''}`)}><Settings2 size={16}/><span>앱 설정</span></button>
      <button className="sidebar-host-status" onClick={onConnection}><span className="dashboard-status" data-state={status?.state ?? (error ? 'stale' : mode === 'demo' ? 'demo' : 'connecting')}><i/>{status?.label ?? (error ? '연결 확인 필요' : mode === 'demo' ? '예시 모드' : '연결 확인 중')}</span><Server size={14}/></button>
    </footer>
  </>;
}
