import { useId, useState } from 'react';
import { CalendarDays, ChevronDown, CircleHelp, Folder, GitBranch, Home, Inbox, LayoutList, MessageCircle, PanelLeft, Plus, Plug, Search, Settings2 } from 'lucide-react';
import { DotAvatar, GhostMark } from './DotAvatar';
import { dotState, stateLabel, toneFor } from '../client/types';
import type { Review, Snapshot } from '../client/types';
import { routeLabels } from '../uiText';

type Props = {
  snapshot: Snapshot | null;
  route: string;
  section: string;
  dotId: string | null;
  selectedSpace?: string;
  pending: Review[];
  attentionCount: number;
  mode: string;
  error: string;
  lifetimeEnabled: boolean;
  navigate(path: string): void;
  onSearch(): void;
  onAdd(): void;
  onConnection(): void;
  onCollapse(): void;
};

export function WorkspaceSidebar({ snapshot, route, section, dotId, selectedSpace, pending, attentionCount, mode, error, lifetimeEnabled, navigate, onSearch, onAdd, onConnection, onCollapse }: Props) {
  const [ghostsOpen, setGhostsOpen] = useState(true), [spacesOpen, setSpacesOpen] = useState(true);
  const id = useId(), ghostsId = `${id}-ghosts`, spacesId = `${id}-spaces`;
  const selectedConversation = new URLSearchParams(route.split('?')[1] || '').get('conversation');
  return <>
    <header className="workspace-sidebar-header">
      <button className="workspace-switcher" aria-label="Ghost 전체 보기" title="Ghost 전체 보기" onClick={() => navigate('/')}><GhostMark/><span className="workspace-wordmark">Ghost</span></button>
      <button className="icon-button sidebar-collapse" aria-label="탐색 사이드바 숨기기" title="탐색 사이드바 숨기기" onClick={onCollapse}><PanelLeft size={16}/></button>
    </header>
    <button className="sidebar-search" onClick={onSearch}><Search size={16}/><span>작업실 검색</span><kbd>⌘ K</kbd></button>
    <nav className="primary-nav" aria-label="주 탐색">{[
      { path: '/', key: 'home', name: routeLabels.home, Icon: Home },
      { path: '/inbox', key: 'inbox', name: routeLabels.inbox, Icon: Inbox },
      { path: '/work', key: 'work', name: routeLabels.work, Icon: LayoutList },
      { path: '/together', key: 'together', name: routeLabels.together, Icon: GitBranch },
      { path: '/planner', key: 'planner', name: routeLabels.planner, Icon: CalendarDays },
      { path: '/integrations', key: 'integrations', name: routeLabels.integrations, Icon: Plug },
      ...(lifetimeEnabled ? [{ path: '/lifetime', key: 'lifetime', name: routeLabels.lifetime, Icon: MessageCircle }] : []),
    ].map(({ path, key, name, Icon }) => <button key={key} className={`nav-row ${section === key ? 'selected' : ''}`} aria-current={section === key ? 'page' : undefined} onClick={() => navigate(path)}><Icon size={16}/><span>{name}</span>{key === 'inbox' && attentionCount > 0 && <span className="nav-count">{attentionCount}</span>}</button>)}</nav>
    <div className="sidebar-scroll">
      <section className="sidebar-section">
        <div className="sidebar-label"><button className="sidebar-section-toggle" aria-expanded={ghostsOpen} aria-controls={ghostsId} onClick={() => setGhostsOpen(!ghostsOpen)}><ChevronDown size={13}/><span>나의 Ghost</span><span className="sidebar-section-count">{snapshot?.profiles.length ?? 0}</span></button><button className="icon-button small" aria-label="새 Ghost 만들기" title="새 Ghost 만들기" onClick={onAdd}><Plus size={15}/></button></div>
        <nav id={ghostsId} aria-label="나의 Ghost" hidden={!ghostsOpen}>{snapshot?.profiles.map(p => {
          const state = dotState(p, pending), selected = dotId === p.id;
          return <div key={p.id} className="sidebar-ghost-group">
            <button className={`nav-row dot-nav ${selected ? 'selected' : ''}`} aria-current={selected ? 'page' : undefined} onClick={() => navigate(`/ghosts/${p.id}`)}><DotAvatar profileId={p.id} tone={toneFor(p.id)} size={22}/><span>{p.name}</span><span className={`nav-status state-${state}`} role="img" aria-label={stateLabel[state]}/></button>
            {selected && p.conversations.length > 0 && <div className="sidebar-conversations" role="navigation" aria-label={`${p.name} 대화`}>
              {p.conversations.map((c, index) => <button key={c.id} className={`sidebar-conversation ${(selectedConversation ?? p.conversations[0]?.id) === c.id ? 'selected' : ''}`} aria-current={(selectedConversation ?? p.conversations[0]?.id) === c.id ? 'page' : undefined} title={c.title} onClick={() => navigate(`/ghosts/${p.id}?conversation=${encodeURIComponent(c.id)}`)}><MessageCircle size={13}/><span>{c.title || `대화 ${index + 1}`}</span></button>)}
            </div>}
          </div>;
        })}</nav>
      </section>
      <section className="sidebar-section"><div className="sidebar-label"><button className="sidebar-section-toggle" aria-expanded={spacesOpen} aria-controls={spacesId} onClick={() => setSpacesOpen(!spacesOpen)}><ChevronDown size={13}/><span>문서 공간</span><span className="sidebar-section-count">{snapshot?.spaces.length ?? 0}</span></button></div><nav id={spacesId} aria-label="문서 공간" hidden={!spacesOpen}>{snapshot?.spaces.map(s => <button key={s.id} className={`nav-row ${selectedSpace === s.id && section === 'spaces' ? 'selected' : ''}`} aria-current={selectedSpace === s.id && section === 'spaces' ? 'page' : undefined} title={s.name} onClick={() => navigate(`/spaces/${s.id}`)}><Folder size={16}/><span>{s.name}</span></button>)}{!snapshot?.spaces.length && <button className="nav-row" onClick={() => navigate('/spaces')}><Folder size={16}/><span>문서 공간 보기</span></button>}</nav></section>
    </div>
    <footer className="sidebar-bottom">
      <button className={`nav-row ${section === 'settings' ? 'selected' : ''}`} aria-current={section === 'settings' ? 'page' : undefined} onClick={() => navigate(`/settings?tab=appearance${dotId ? `&ghost=${encodeURIComponent(dotId)}` : ''}`)}><Settings2 size={16}/><span>앱 설정</span></button>
      <button className="sidebar-connection" onClick={onConnection}><span className={`connection-light ${error ? 'disconnected' : ''}`} aria-hidden="true"/><span>{error ? '연결 확인 필요' : mode === 'demo' ? '예시 모드' : '작업실 연결 안내'}</span><CircleHelp size={15}/></button>
    </footer>
  </>;
}
