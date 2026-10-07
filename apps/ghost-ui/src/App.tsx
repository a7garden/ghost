import { ArcProvider } from '@garden/arc';
import { Tooltip as ArcTooltip } from '@garden/arc/tooltip';
import '@garden/arc/styles.css';
import './arc-adoption.css';
import { AvatarProvider } from './pets/AvatarProvider';
import { Settings } from './pets/Settings';
import { FloatingPet } from './pets/FloatingPet';
import { usePreferences } from './pets/preferences';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronRight, CircleHelp, FileText, Folder, Home, Inbox, LayoutList, Menu, Plus, Search, Settings2, X, ArrowUp, Check, RefreshCw, CircleAlert, Monitor, CalendarDays, Plug } from 'lucide-react';
import { DotAvatar, GhostMark } from './components/DotAvatar';
import { Modal } from './components/Modal';
import { Status } from './components/Status';
import { Planner } from './features/Planner';
import { Integrations } from './features/Integrations';
import { Overview } from './features/Overview';
import { DotDetail } from './features/DotDetail';
import { WorkView, InboxView, SpacesView } from './features/WorkViews';
import { connect } from './client/api';
import type { Client } from './client/types';
import { useWorkspace } from './client/useWorkspace';
import { dotState, toneFor } from './client/types';
import type { Profile, Review } from './client/types';
import { GitBranch } from 'lucide-react';
import { CollaborationView } from './features/CollaborationView';
import { CollaborateForm } from './features/CollaborateForm';

const currentRoute = () => location.hash.replace(/^#/, '').replace(/^\/dots\//, '/ghosts/') || '/';
export function App({ connectClient = connect }: { connectClient?: () => Promise<Client> } = {}) {
  const { preferences, updatePreferences, storageError, resolvedTheme } = usePreferences();
  const workspace = useWorkspace(connectClient), { snapshot, mode, error, busy, action, query, reconnect } = workspace;
  const [route, setRoute] = useState(currentRoute), [dialog, setDialog] = useState<'add' | 'assign' | 'search' | 'connection' | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false), [review, setReview] = useState<Review | null>(null), [formError, setFormError] = useState('');
  const [assignedProfile, setAssignedProfile] = useState(''), [search, setSearch] = useState('');
  const assignmentConversation = useRef<Record<string, string>>({});
  const [collaborate, setCollaborate] = useState(false);
  const initialSelection = useRef(Boolean(location.hash));
  useEffect(() => {
    if (!initialSelection.current && snapshot) {
      initialSelection.current = true;
      if (snapshot.profiles[0]) { const next = `/ghosts/${snapshot.profiles[0].id}`; location.hash = next; setRoute(next); }
    }
  }, [snapshot]);
  useEffect(() => { const change = () => { setRoute(currentRoute()); setMobileOpen(false); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); location.hash = '/settings?tab=appearance'; } if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSearch(''); setDialog('search'); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  useEffect(() => { setFormError(''); }, [dialog, review]);
  const navigate = (path: string) => { window.scrollTo(0, 0); location.hash = path; setRoute(path); setMobileOpen(false); };
  const dotId = route.startsWith('/ghosts/') ? route.split('/')[2].split('?')[0] : null;
  const dot = snapshot?.profiles.find(p => p.id === dotId);
  const section = route.startsWith('/spaces') ? 'spaces' : route.split('/')[1]?.split('?')[0] || 'home';
  useEffect(() => { window.scrollTo(0, 0); }, [section, dotId]);
  const pending = snapshot?.reviews.filter(r => ['pending', 'approved'].includes(r.state)) ?? [];
  const assign = (p?: Profile) => { setAssignedProfile(p?.id ?? snapshot?.profiles[0]?.id ?? ''); setDialog('assign'); };
  const selectedSpace = route.startsWith('/spaces/') ? route.split('/')[2] : snapshot?.spaces[0]?.id;
  const label = dot?.name ?? ({ home: '전체 보기', settings: '설정', inbox: '내 확인', work: '맡은 일', together: '함께 하는 일', planner: '할 일과 일정', integrations: '연동', spaces: '문서 공간', ghosts: 'Ghost' }[section] || '전체 보기');
  const close = () => { if (!busy) { setDialog(null); setReview(null); } };
  const safe = async (fn: () => Promise<void>) => { setFormError(''); try { await fn(); } catch (e) { setFormError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.'); } };
  const sidebar = <>
    <button className="brand" aria-label="Ghost 전체 보기" onClick={() => navigate('/')}><GhostMark/><span>ghost</span><span className="brand-workspace">개인 작업실</span></button>
    <button className="sidebar-search" onClick={() => { setDialog('search'); setMobileOpen(false); }}><Search size={17}/><span>작업실 검색</span><kbd>⌘ K</kbd></button>
    <nav className="primary-nav" aria-label="주 탐색">{[{ path: '/', key: 'home', name: '전체 보기', Icon: Home }, { path: '/inbox', key: 'inbox', name: '내 확인', Icon: Inbox }, { path: '/work', key: 'work', name: '맡은 일', Icon: LayoutList }, { path: '/together', key: 'together', name: '함께 하는 일', Icon: GitBranch }, { path: '/planner', key: 'planner', name: '할 일과 일정', Icon: CalendarDays }, { path: '/integrations', key: 'integrations', name: '연동', Icon: Plug }].map(({ path, key, name, Icon }) => <button key={key} className={`nav-row ${section === key ? 'selected' : ''}`} onClick={() => navigate(path)} aria-current={section === key ? 'page' : undefined}><Icon size={17}/><span>{name}</span>{key === 'inbox' && pending.length > 0 && <span className="nav-count">{pending.length}</span>}</button>)}</nav>
    <div className="sidebar-section"><div className="sidebar-label"><span>나의 Ghost</span><button className="icon-button small" aria-label="새 Ghost 만들기" onClick={() => { setDialog('add'); setMobileOpen(false); }}><Plus size={15}/></button></div><nav aria-label="나의 Ghost">{snapshot?.profiles.map(p => <button key={p.id} className={`nav-row dot-nav ${dotId === p.id ? 'selected' : ''}`} onClick={() => navigate(`/ghosts/${p.id}`)} aria-current={dotId === p.id ? 'page' : undefined}><DotAvatar profileId={p.id} tone={toneFor(p.id)} size={30}/><span>{p.name}</span><span className={`nav-status state-${dotState(p, pending)}`} aria-label={dotState(p, pending) === 'attention' ? '확인 필요' : undefined}/></button>)}</nav></div>
    <div className="sidebar-section"><div className="sidebar-label"><span>문서 공간</span><Folder size={14}/></div><nav aria-label="문서 공간">{snapshot?.spaces.map(s => <button key={s.id} className={`nav-row ${selectedSpace === s.id && section === 'spaces' ? 'selected' : ''}`} onClick={() => navigate(`/spaces/${s.id}`)}><Folder size={16}/><span>{s.name}</span></button>)}{!snapshot?.spaces.length && <button className="nav-row" onClick={() => navigate('/spaces')}><Folder size={16}/><span>문서 공간 보기</span></button>}</nav></div>
    <div className="sidebar-bottom"><button className={`nav-row ${section === 'settings' ? 'selected' : ''}`} aria-current={section === 'settings' ? 'page' : undefined} onClick={() => navigate(`/settings?tab=appearance${dotId ? `&ghost=${encodeURIComponent(dotId)}` : ''}`)}><Settings2 size={17}/><span>앱 설정</span></button>{(error || mode === 'demo') && <button className="connection-row" onClick={() => setDialog('connection')}><span className={`connection-light ${error ? 'disconnected' : ''}`}/><span>{error ? '연결 확인 필요' : '예시 작업실'}</span><Settings2 size={15}/></button>}<div className="owner-row"><div className="owner-avatar">G</div><div><strong>나의 워크스페이스</strong><span>{mode === 'demo' ? '인터랙티브 미리보기' : '나만의 에이전트 팀'}</span></div><ArcTooltip content="작업실 연결 안내"><button className="icon-button" aria-label="연결 안내" onClick={() => setDialog('connection')}><CircleHelp size={17}/></button></ArcTooltip></div></div>
  </>;
  return <ArcProvider theme={resolvedTheme} density="compact" motion={preferences.animate ? 'user' : 'reduce'} className="ghost-arc"><AvatarProvider key={snapshot?.workspace_id ?? 'loading'} snapshot={snapshot} query={query} animate={preferences.animate}><div className="app-shell">
    <aside className="sidebar">{sidebar}</aside>
    <div className={`main-shell ${dot ? 'chat-shell' : ''}`}>{!dot && <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-toggle" aria-label="탐색 메뉴 열기" onClick={() => setMobileOpen(true)}><Menu size={19}/></button><button onClick={() => navigate('/')} className="breadcrumb-root">작업실</button><ChevronRight size={13}/><span>{label}</span></div><div className="topbar-actions">{mode === 'demo' && <span className="mode-badge"><i/>예시 모드</span>}</div></header>}
      {error && <div className="connection-error" role="alert"><CircleAlert size={17}/><span>{error}</span><button className="text-button" onClick={reconnect}><RefreshCw size={14}/>다시 연결</button></div>}
      {!snapshot ? <main className="page-content loading-content" aria-busy={!error}><div className="skeleton heading-skeleton"/><div className="skeleton description-skeleton"/><div className="dot-grid">{[0, 1, 2, 3].map(i => <div className="skeleton dot-skeleton" key={i}/>)}</div>{error && <p>연결되면 저장된 Ghost와 작업을 표시합니다.</p>}</main> : <main id="main-content" className={dot ? 'detail-main' : ''}>
        {section === 'settings' && <Settings snapshot={snapshot} route={route} navigate={navigate} action={action} busy={busy} mode={mode} preferences={preferences} updatePreferences={updatePreferences} storageError={storageError}/>}
        {section === 'home' && <Overview snapshot={snapshot} mode={mode} navigate={navigate} onReview={setReview} onAdd={() => setDialog('add')} onAssign={assign}/>}
        {section === 'ghosts' && (dot ? <DotDetail key={dot.id} profile={dot} snapshot={snapshot} mode={mode} action={action} busy={busy} connected={!error} routing={workspace.routing} navigate={navigate} route={route} onReview={setReview} onOpenNavigation={() => setMobileOpen(true)}/> : <div className="empty-state"><CircleAlert size={28}/><h1>이 Ghost를 찾을 수 없어요</h1><button className="button secondary" onClick={() => navigate('/')}>작업실로</button></div>)}
        {section === 'work' && <WorkView snapshot={snapshot} action={action} busy={busy} navigate={navigate} onAssign={() => assign()}/>}
        {section === 'together' && <CollaborationView snapshot={snapshot} route={route} mode={mode} action={action} query={query} busy={busy} navigate={navigate} onAssign={() => setCollaborate(true)}/>}
        {section === 'planner' && <Planner snapshot={snapshot} action={action} query={query} busy={busy} connected={!error}/>}
        {section === 'integrations' && <Integrations snapshot={snapshot} action={action} busy={busy} mode={mode} navigate={navigate}/>}
        {section === 'inbox' && <InboxView snapshot={snapshot} onReview={setReview} navigate={navigate} connected={!error}/>}
        {section === 'spaces' && <SpacesView key={selectedSpace ?? 'empty'} snapshot={snapshot} selectedSpace={selectedSpace} action={query} navigate={navigate}/>}
      </main>}
    </div>
    {mobileOpen && <Modal title="작업실 탐색" onClose={() => setMobileOpen(false)} className="mobile-nav-dialog"><div className="mobile-sidebar">{sidebar}</div></Modal>}
    {collaborate && snapshot && <CollaborateForm snapshot={snapshot} action={action} busy={busy} mode={mode} onClose={() => !busy && setCollaborate(false)} onCreated={path => { setCollaborate(false); navigate(path); }}/>} 
    {dialog === 'add' && <Modal title="Ghost 만들기" onClose={close}><form className="form-stack" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void safe(async () => { const result = await action({ type: 'create_profile', name: String(data.get('name')), persona: String(data.get('persona')) }); setDialog(null); navigate(`/ghosts/${result.profile_id}`); }); }}><div className="new-dot-illustration"><DotAvatar tone="mint" size={94}/><DotAvatar tone="lilac" size={74}/></div><label>Ghost 이름<input name="name" placeholder="예: Scout" required maxLength={64} pattern="[A-Za-z0-9_-]+" autoComplete="off"/><span className="field-help">영문, 숫자, 밑줄과 하이픈을 사용할 수 있어요.</span></label><label>맡길 역할<textarea name="persona" placeholder="자료를 조사하고, 확인한 근거와 함께 요약합니다." required maxLength={4096} rows={3}/></label>{formError && <p className="form-error" role="alert">{formError}</p>}<button className="button primary full-width" disabled={busy}>{busy ? '만드는 중…' : 'Ghost 만들기'}<Plus size={16}/></button></form></Modal>}
    {dialog === 'assign' && snapshot && <Modal title="새로운 일 맡기기" onClose={close}><form className="form-stack" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void safe(async () => { const p = snapshot.profiles.find(p => p.id === assignedProfile); if (!p) throw new Error('함께할 Ghost를 선택해 주세요.'); let cid = assignmentConversation.current[p.id]; if (!cid) { const created = await action({ type: 'create_conversation', profile_id: p.id, model: snapshot.default_model, tools: true }); cid = created.conversation_id; assignmentConversation.current[p.id] = cid; } await action({ type: 'submit', profile_id: p.id, conversation_id: cid, prompt: String(data.get('prompt')), kind: 'prompt' }); delete assignmentConversation.current[p.id]; setDialog(null); navigate(`/ghosts/${p.id}?conversation=${cid}`); }); }}><label>함께할 Ghost<select value={assignedProfile} onChange={e => setAssignedProfile(e.target.value)} disabled={busy}>{snapshot.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.persona.slice(0, 24)}</option>)}</select></label><label>어떤 결과가 필요한가요?<textarea name="prompt" rows={5} placeholder="하고 싶은 일과 원하는 결과를 알려주세요." required maxLength={8192}/></label><p className="field-help">선택한 Ghost의 새 대화에서 진행합니다. 현재 허용된 도구와 권한이 적용돼요.</p>{formError && <p className="form-error" role="alert">{formError}</p>}<button className="button primary full-width" disabled={busy || !assignedProfile}>{busy ? '요청 저장 중…' : '일 맡기기'}<ArrowUp size={16}/></button></form></Modal>}
    {dialog === 'search' && snapshot && <Modal title="작업실에서 찾기" onClose={close} className="search-dialog"><label className="search-field"><Search size={18}/><input aria-label="작업실 검색" placeholder="Ghost, 맡은 일, 문서 공간 검색" value={search} onChange={e => setSearch(e.target.value)}/></label><div className="search-results">{snapshot.profiles.filter(p => `${p.name} ${p.persona}`.toLowerCase().includes(search.toLowerCase())).map(p => <button key={p.id} onClick={() => { setDialog(null); navigate(`/ghosts/${p.id}`); }}><DotAvatar profileId={p.id} tone={toneFor(p.id)} size={36}/><span><strong>{p.name}</strong><small>{p.persona}</small></span><ArrowUpRight size={16}/></button>)}{snapshot.goals.filter(g => g.title.toLowerCase().includes(search.toLowerCase())).map(g => <button key={g.id} onClick={() => { setDialog(null); navigate('/work'); }}><LayoutList size={18}/><span>{g.title}</span><ArrowUpRight size={16}/></button>)}{snapshot.spaces.filter(s => s.name.toLowerCase().includes(search.toLowerCase())).map(s => <button key={s.id} onClick={() => { setDialog(null); navigate(`/spaces/${s.id}`); }}><Folder size={18}/><span>{s.name}</span><ArrowUpRight size={16}/></button>)}{![...snapshot.profiles.map(p => p.name + ' ' + p.persona), ...snapshot.goals.map(g => g.title), ...snapshot.spaces.map(s => s.name)].some(v => v.toLowerCase().includes(search.toLowerCase())) && <p className="quiet-empty">다른 이름이나 단어로 찾아보세요.</p>}</div></Modal>}
    {dialog === 'connection' && <Modal title="작업실 연결" onClose={close}><div className="form-stack"><div className="connection-illustration"><Monitor size={36}/></div><h3>{mode === 'demo' ? '지금은 예시 작업실이에요' : '로컬 Ghost 호스트를 사용하고 있어요'}</h3><p className="muted">{mode === 'demo' ? '여기 있는 Ghost와 작업은 UI를 살펴보기 위한 예시입니다. 대화, 검토, 예약 변경은 이 브라우저의 예시에만 반영됩니다.' : 'Ghost의 역할, 대화와 맡은 일은 호스트에 저장됩니다. 호스트가 실행 중이면 화면을 닫아도 작업이 이어집니다.'}</p><div className="connection-detail"><span>상태</span><strong>{error ? '다시 연결 필요' : mode === 'demo' ? '예시 모드' : '연결됨'}</strong></div><button className="button secondary" onClick={reconnect}><RefreshCw size={16}/>연결 다시 확인</button></div></Modal>}
    {review && snapshot && <Modal title="저장 전 검토" onClose={close} drawer><div className="review-content"><div className="review-byline"><DotAvatar profileId={review.profile_id} tone={toneFor(review.profile_id)} size={42}/><div><strong>{snapshot.profiles.find(p => p.id === review.profile_id)?.name ?? 'Ghost'}의 제안</strong><span>{snapshot.spaces.find(s => s.id === review.space_id)?.name ?? '문서 공간'}에 저장</span></div><Status state="attention" label="검토 대기"/></div><h2>{review.title}</h2><div className="document-paper"><pre>{review.body}</pre></div></div><div className="drawer-footer">{formError && <p className="form-error" role="alert">{formError}</p>}<p>내용을 확인하고 저장 여부를 결정해 주세요.</p><div><button className="button secondary" disabled={busy} onClick={() => void safe(async () => { await action({ type: 'workspace', action: { type: 'decide_review', review_id: review.id, approve: false } }); setReview(null); })}>저장하지 않음</button><button className="button primary" disabled={busy} onClick={() => void safe(async () => { await action({ type: 'workspace', action: { type: 'decide_review', review_id: review.id, approve: true } }); setReview(null); })}>{busy ? '처리 중…' : '승인하고 저장'}<Check size={16}/></button></div></div></Modal>}
    {preferences.companion && !mobileOpen && section !== 'settings' && <FloatingPet profile={snapshot?.profiles.find(p => p.id === preferences.companionProfile) ?? snapshot?.profiles[0]} onOpen={() => { const p = snapshot?.profiles.find(p => p.id === preferences.companionProfile) ?? snapshot?.profiles[0]; if (p) navigate(`/ghosts/${p.id}`); }} onHide={() => updatePreferences({ companion: false })}/>}
  </div></AvatarProvider></ArcProvider>;
}
