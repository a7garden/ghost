import { routeLabels, uiTerms } from './uiText';
import { ArcProvider } from '@garden/arc';
import '@garden/arc/styles.css';
import './arc-adoption.css';
import { GTitleBar } from '@garden/ui';
import './desktop-titlebar.css';
import { AvatarProvider } from './pets/AvatarProvider';
import { Settings } from './pets/Settings';
import { FloatingPet } from './pets/FloatingPet';
import { usePreferences } from './pets/preferences';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUpRight, ChevronRight, Folder, LayoutList, PanelLeft, Plus, Search, ArrowUp, Check, RefreshCw, CircleAlert, Monitor } from 'lucide-react';
import { DotAvatar } from './components/DotAvatar';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { usePanelState } from './components/usePanelState';
import { Modal } from './components/Modal';
import { Status } from './components/Status';
import { Planner } from './features/Planner';
import { Integrations } from './features/Integrations';
import { Overview } from './features/Overview';
import { DotDetail } from './features/DotDetail';
import { WorkView, InboxView, SpacesView } from './features/WorkViews';
import { connect } from './client/api';
import { searchWorkspace } from './client/searchIndex';
import { inboxItems } from './client/inbox';
import type { Client } from './client/types';
import { useWorkspace } from './client/useWorkspace';
import { toneFor } from './client/types';
import type { Profile, Review } from './client/types';
import { CollaborationView } from './features/CollaborationView';
import { CollaborateForm } from './features/CollaborateForm';
import { LifetimeRoute } from './features/LifetimeRoute';
import { LegacyTranscript, legacyHistoryPath, legacyHistoryRequested } from './features/LegacyTranscript';

const lifetimeEnabled = import.meta.env.VITE_GHOST_LIFETIME === 'true';

// Tauri 웹뷰는 모든 내비게이션에 __TAURI_INTERNALS__를 주입한다. 브라우저 콘솔에는
// 없으므로 커스텀 타이틀바와 높이 보정은 데스크톱 창에서만 적용된다.
const desktopShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const currentRoute = () => location.hash.replace(/^#/, '').replace(/^\/dots\//, '/ghosts/') || '/';
export function App({ connectClient = connect }: { connectClient?: () => Promise<Client> } = {}) {
  const { preferences, updatePreferences, storageError, resolvedTheme } = usePreferences();
  const workspace = useWorkspace(connectClient), { snapshot, mode, error, busy, action, query, reconnect } = workspace;
  const [route, setRoute] = useState(currentRoute), [dialog, setDialog] = useState<'add' | 'assign' | 'search' | 'connection' | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false), [review, setReview] = useState<Review | null>(null), [formError, setFormError] = useState('');
  const [assignedProfile, setAssignedProfile] = useState(''), [search, setSearch] = useState('');
  const assignmentConversation = useRef<Record<string, string>>({});
  const [collaborate, setCollaborate] = useState(false);
  const [navigationCollapsed, setNavigationCollapsed] = usePanelState('ghost-ui:navigation-collapsed');
  const [desktopNavigation, setDesktopNavigation] = useState(() => window.matchMedia('(min-width: 56rem)').matches);
  useEffect(() => { const media = window.matchMedia('(min-width: 56rem)'); const change = () => { setDesktopNavigation(media.matches); if (media.matches) setMobileOpen(false); }; media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  const focusNavigation = () => requestAnimationFrame(() => document.querySelector<HTMLElement>('.main-shell .navigation-toggle')?.focus());
  const closeNavigation = () => { setMobileOpen(false); focusNavigation(); };
  const navigationOpen = desktopNavigation ? !navigationCollapsed : mobileOpen;
  const toggleNavigation = () => desktopNavigation ? setNavigationCollapsed(!navigationCollapsed) : setMobileOpen(!mobileOpen);
  const initialSelection = useRef(Boolean(location.hash));
  useEffect(() => {
    if (!initialSelection.current && snapshot) {
      initialSelection.current = true;
      if (lifetimeEnabled && mode === 'live') { location.hash = '/lifetime'; setRoute('/lifetime'); }
      else if (snapshot.profiles[0]) { const next = `/ghosts/${snapshot.profiles[0].id}`; location.hash = next; setRoute(next); }
    }
  }, [snapshot, mode]);
  useEffect(() => { const change = () => { setRoute(currentRoute()); setMobileOpen(false); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); location.hash = '/settings?tab=appearance'; } if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSearch(''); setDialog('search'); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  useEffect(() => { setFormError(''); }, [dialog, review]);
  const navigate = (path: string) => { window.scrollTo(0, 0); location.hash = path; setRoute(path); setMobileOpen(false); if (mobileOpen) focusNavigation(); };
  const dotId = route.startsWith('/ghosts/') ? route.split('/')[2].split('?')[0] : null;
  const dot = snapshot?.profiles.find(p => p.id === dotId);
  const lifetimeDot = Boolean(dot && lifetimeEnabled && mode === 'live' && !legacyHistoryRequested(route));
  const chatLayout = dot && !lifetimeDot;
  const section = route.startsWith('/spaces') ? 'spaces' : route.split('/')[1]?.split('?')[0] || 'home';
  useEffect(() => { window.scrollTo(0, 0); }, [section, dotId]);
  const inbox = snapshot ? inboxItems(snapshot, !error) : null;
  const pending = inbox?.reviews ?? [];
  const attentionCount = inbox?.count ?? 0;
  const assign = (p?: Profile) => {
    if (lifetimeEnabled && mode === 'live') { navigate(p ? `/lifetime?ghost=${encodeURIComponent(p.id)}` : '/lifetime'); return; }
    setAssignedProfile(p?.id ?? snapshot?.profiles[0]?.id ?? ''); setDialog('assign');
  };
  const selectedSpace = route.startsWith('/spaces/') ? route.split('/')[2] : snapshot?.spaces[0]?.id;
  const addGhost = () => { if (lifetimeEnabled && mode === 'live') navigate('/lifetime?create=1'); else setDialog('add'); };
  const label = lifetimeDot ? 'Ghost 작업실' : dot?.name ?? routeLabels[section as keyof typeof routeLabels] ?? '찾을 수 없는 화면';
  const knownSections: Record<string, true> = { home: true, ghosts: true, spaces: true, inbox: true, work: true, together: true, planner: true, integrations: true, settings: true };
  const searchHits = snapshot ? searchWorkspace(snapshot, search) : [];
  const [searchActive, setSearchActive] = useState(0);
  const searchIndex = Math.min(searchActive, Math.max(searchHits.length - 1, 0));
  useEffect(() => { setSearchActive(0); }, [dialog, search]);
  useEffect(() => { document.getElementById(`search-hit-${searchIndex}`)?.scrollIntoView({ block: 'nearest' }); }, [searchIndex, searchHits.length, dialog]);
  const searchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const last = searchHits.length - 1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setSearchActive(i => e.key === 'ArrowDown' ? Math.min(i + 1, last) : e.key === 'ArrowUp' ? Math.max(i - 1, 0) : e.key === 'Home' ? 0 : last);
    } else if (e.key === 'Enter') {
      const hit = searchHits[searchIndex];
      if (hit) { e.preventDefault(); setDialog(null); navigate(hit.path); }
    }
  };
  const close = () => { if (!busy) { setDialog(null); setReview(null); } };
  const safe = async (fn: () => Promise<void>) => { setFormError(''); try { await fn(); } catch (e) { setFormError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.'); } };
  const sidebar = <WorkspaceSidebar snapshot={snapshot} route={route} section={section} dotId={dotId} selectedSpace={selectedSpace} pending={pending} attentionCount={attentionCount} mode={mode} error={error} lifetimeEnabled={lifetimeEnabled} navigate={navigate} onSearch={() => { setSearch(''); setDialog('search'); setMobileOpen(false); }} onAdd={() => { addGhost(); setMobileOpen(false); }} onConnection={() => { setDialog('connection'); setMobileOpen(false); }} onCollapse={() => { setNavigationCollapsed(true); focusNavigation(); }}/>;
  const lifetimeScreen = (path: string) => snapshot && <LifetimeRoute route={path} legacyGhostIDs={snapshot.profiles.map(profile => profile.id)} onOpenHistory={ghost => { if (snapshot.profiles.some(profile => profile.id === ghost)) navigate(legacyHistoryPath(ghost, dotId === ghost ? new URLSearchParams(route.split('?')[1] ?? '').get('conversation') ?? undefined : undefined)); }} action={workspace.lifetimeAction} memoryAction={action} workspaceId={snapshot.workspace_id} authority={snapshot.lifetime_authority} mode={mode} documentReviews={snapshot.reviews} documentAuthorityEpoch={snapshot.lifetime_authority?.authority_epoch} onOpenDocumentReview={setReview}/>;
  return <ArcProvider theme={resolvedTheme} density="compact" motion={preferences.animate ? 'user' : 'reduce'} className="ghost-arc"><AvatarProvider key={snapshot?.workspace_id ?? 'loading'} snapshot={snapshot} query={query} animate={preferences.animate}>{desktopShell && <GTitleBar className="ghost-desktop-titlebar" aria-label="Ghost" macOSInset={80} left={<span className="ghost-desktop-titlebar__title">Ghost</span>}/>}<div className={`app-shell ${navigationCollapsed ? 'navigation-collapsed' : ''} ${desktopShell ? 'app-shell--desktop' : ''}`}>
    <aside className="sidebar" aria-label="작업실 탐색">{sidebar}</aside>
    <div className={`main-shell ${chatLayout ? 'chat-shell' : ''}`}>{!chatLayout && <header className="topbar"><div className="breadcrumbs"><button className="icon-button navigation-toggle" aria-label={navigationOpen ? '탐색 사이드바 숨기기' : '탐색 사이드바 보기'} aria-expanded={navigationOpen} onClick={toggleNavigation}><PanelLeft size={17}/></button><button onClick={() => navigate('/')} className="breadcrumb-root">작업실</button><ChevronRight size={13}/><span>{label}</span></div><div className="topbar-actions">{mode === 'demo' && <span className="mode-badge"><i/>예시 모드</span>}</div></header>}
      {error && <div className="connection-error" role="alert"><CircleAlert size={17}/><span>{error}</span><button className="text-button" onClick={reconnect}><RefreshCw size={14}/>다시 연결</button></div>}
      {!snapshot ? <main className="page-content loading-content" aria-busy={!error}><div className="skeleton heading-skeleton"/><div className="skeleton description-skeleton"/><div className="dot-grid">{[0, 1, 2, 3].map(i => <div className="skeleton dot-skeleton" key={i}/>)}</div>{error && <p>연결되면 저장된 Ghost와 작업을 표시합니다.</p>}</main> : <main id="main-content" className={chatLayout ? 'detail-main' : ''}>
        {section === 'settings' && <Settings snapshot={snapshot} route={route} navigate={navigate} action={action} busy={busy} mode={mode} preferences={preferences} updatePreferences={updatePreferences} storageError={storageError}/>}
        {section === 'home' && <Overview snapshot={snapshot} mode={mode} connected={!error} navigate={navigate} onReview={setReview} onAdd={addGhost} onAssign={assign}/>}
        {section === 'ghosts' && (dot ? lifetimeEnabled && mode === 'live' ? legacyHistoryRequested(route) ? <LegacyTranscript profile={dot} route={route} navigate={navigate}/> : lifetimeScreen(`/lifetime?ghost=${encodeURIComponent(dot.id)}`) : <DotDetail key={dot.id} profile={dot} snapshot={snapshot} mode={mode} action={action} busy={busy} connected={!error} routing={workspace.routing} navigate={navigate} route={route} onReview={setReview} onOpenNavigation={toggleNavigation} navigationOpen={navigationOpen}/> : <div className="empty-state"><CircleAlert size={28}/><h1>이 Ghost를 찾을 수 없습니다</h1><button className="button secondary" onClick={() => navigate('/')}>작업실로</button></div>)}
        {section === 'work' && <WorkView snapshot={snapshot} action={action} busy={busy} navigate={navigate} onAssign={() => assign()}/>}
        {section === 'together' && <CollaborationView snapshot={snapshot} route={route} mode={mode} action={action} query={query} busy={busy} navigate={navigate} onAssign={() => setCollaborate(true)}/>}
        {section === 'planner' && <Planner snapshot={snapshot} action={action} query={query} busy={busy} connected={!error}/>}
        {section === 'integrations' && <Integrations snapshot={snapshot} action={action} busy={busy} mode={mode} navigate={navigate}/>}
        {section === 'inbox' && <InboxView snapshot={snapshot} onReview={setReview} navigate={navigate} connected={!error}/>}
        {section === 'spaces' && <SpacesView key={selectedSpace ?? 'empty'} snapshot={snapshot} selectedSpace={selectedSpace} action={query} navigate={navigate} theme={resolvedTheme}/>}
        {section === 'lifetime' && lifetimeEnabled && lifetimeScreen(route)}
        {!knownSections[section] && !(section === 'lifetime' && lifetimeEnabled) && <div className="empty-state"><CircleAlert size={28}/><h1>이 화면을 찾을 수 없습니다</h1><p className="muted">주소가 이동했거나 잘못되었을 수 있습니다.</p><button className="button secondary" onClick={() => navigate('/')}>작업실로</button></div>}
      </main>}
    </div>
    {mobileOpen && <Modal title="작업실 탐색" onClose={closeNavigation} drawer className="mobile-nav-dialog"><div className="mobile-sidebar">{sidebar}</div></Modal>}
    {collaborate && snapshot && <CollaborateForm snapshot={snapshot} action={action} busy={busy} mode={mode} onClose={() => !busy && setCollaborate(false)} onCreated={path => { setCollaborate(false); navigate(path); }}/>} 
    {dialog === 'add' && <Modal title="Ghost 만들기" onClose={close}><form className="form-stack" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void safe(async () => { const result = await action({ type: 'create_profile', name: String(data.get('name')), persona: String(data.get('persona')) }); setDialog(null); navigate(`/ghosts/${result.profile_id}`); }); }}><div className="new-dot-illustration"><DotAvatar tone="mint" size={94}/><DotAvatar tone="lilac" size={74}/></div><label>Ghost 이름<input name="name" placeholder="예: Scout" required maxLength={64} pattern="[A-Za-z0-9_-]+" autoComplete="off"/><span className="field-help">영문, 숫자, 밑줄과 하이픈을 사용할 수 있습니다.</span></label><label>{uiTerms.roleInstructions}<textarea name="persona" placeholder="자료를 조사하고, 확인한 근거와 함께 요약합니다." required maxLength={4096} rows={3}/></label>{formError && <p className="form-error" role="alert">{formError}</p>}<button className="button primary full-width" disabled={busy}>{busy ? '만드는 중…' : 'Ghost 만들기'}<Plus size={16}/></button></form></Modal>}
    {dialog === 'assign' && snapshot && <Modal title="일 맡기기" onClose={close}><form className="form-stack" onSubmit={e => {
      e.preventDefault();
      const form = e.currentTarget;
      const prompt = String(new FormData(form).get('prompt') ?? '');
      void safe(async () => {
        if (!prompt.trim()) {
          (form.elements.namedItem('prompt') as HTMLTextAreaElement)?.focus();
          throw new Error('맡길 일을 입력해 주세요.');
        }
        const p = snapshot.profiles.find(p => p.id === assignedProfile);
        if (!p) throw new Error('담당 Ghost를 선택해 주세요.');
        let cid = assignmentConversation.current[p.id];
        if (!cid) {
          const created = await action({ type: 'create_conversation', profile_id: p.id, model: snapshot.default_model, tools: true });
          cid = created.conversation_id;
          assignmentConversation.current[p.id] = cid;
        }
        await action({ type: 'submit', profile_id: p.id, conversation_id: cid, prompt, kind: 'prompt' });
        delete assignmentConversation.current[p.id];
        setDialog(null);
        navigate(`/ghosts/${p.id}?conversation=${cid}`);
      });
    }}><label>담당 Ghost<select value={assignedProfile} onChange={e => setAssignedProfile(e.target.value)} disabled={busy}>{snapshot.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.persona.slice(0, 24)}</option>)}</select></label><label>어떤 결과가 필요한가요?<textarea name="prompt" rows={5} placeholder="하고 싶은 일과 원하는 결과를 알려주세요." required maxLength={8192}/></label><p className="field-help">선택한 Ghost의 새 대화에서 진행합니다. 현재 허용된 도구와 권한이 적용됩니다.</p>{formError && <p className="form-error" role="alert">{formError}</p>}<button className="button primary full-width" disabled={busy || !assignedProfile}>{busy ? '요청 저장 중…' : '일 맡기기'}<ArrowUp size={16}/></button></form></Modal>}
    {dialog === 'search' && snapshot && <Modal title={`${uiTerms.workspace} 검색`} onClose={close} className="search-dialog"><label className="search-field"><Search size={18}/><input role="combobox" aria-expanded="true" aria-controls="ghost-search-results" aria-label="작업실 검색" aria-activedescendant={`search-hit-${searchIndex}`} placeholder="Ghost, 맡긴 일, 문서 공간 검색" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={searchKeyDown}/></label><div className="search-results" role="listbox" id="ghost-search-results" aria-label="검색 결과">{searchHits.map((hit, i) => <button key={`${hit.kind}:${hit.id}`} id={`search-hit-${i}`} role="option" aria-selected={i === searchIndex} className={i === searchIndex ? 'selected' : undefined} onClick={() => { setDialog(null); navigate(hit.path); }}>{hit.kind === 'ghost' && hit.profile_id ? <DotAvatar profileId={hit.profile_id} tone={toneFor(hit.profile_id)} size={36}/> : hit.kind === 'space' ? <Folder size={18}/> : <LayoutList size={18}/>}<span><strong>{hit.title}</strong>{hit.subtitle && <small>{hit.subtitle}</small>}</span><ArrowUpRight size={16}/></button>)}{!searchHits.length && <p className="quiet-empty">다른 이름이나 단어로 검색해 주세요.</p>}</div></Modal>}
    {dialog === 'connection' && <Modal title="작업실 연결" onClose={close}><div className="form-stack"><div className="connection-illustration"><Monitor size={36}/></div><h3>{mode === 'demo' ? '예시 모드입니다' : '로컬 Ghost 호스트를 사용합니다'}</h3><p className="muted">{mode === 'demo' ? '여기 있는 Ghost와 작업은 UI를 살펴보기 위한 예시입니다. 대화, 문서 검토, 반복 작업 변경은 이 브라우저의 예시에만 반영됩니다.' : 'Ghost의 역할, 대화와 맡은 일은 호스트에 저장됩니다. 호스트가 실행 중이면 화면을 닫아도 작업이 이어집니다.'}</p><div className="connection-detail"><span>상태</span><strong>{error ? '다시 연결 필요' : mode === 'demo' ? '예시 모드' : '연결됨'}</strong></div><button className="button secondary" onClick={reconnect}><RefreshCw size={16}/>연결 다시 확인</button></div></Modal>}
    {review && snapshot && <Modal title={`저장 전 ${uiTerms.reviews}`} onClose={close} drawer><div className="review-content"><div className="review-byline"><DotAvatar profileId={review.profile_id} tone={toneFor(review.profile_id)} size={42}/><div><strong>{snapshot.profiles.find(p => p.id === review.profile_id)?.name ?? 'Ghost'}의 제안</strong><span>{snapshot.spaces.find(s => s.id === review.space_id)?.name ?? '문서 공간'}에 저장</span></div><Status state="attention" label="검토 대기"/></div><h2>{review.title}</h2><p className="field-help">{review.page_id && review.expected_hash !== undefined ? `${review.expected_hash === null ? '새 문서 생성' : '기존 문서 수정'} · 대상 문서 ${review.page_id}` : '저장 대상 정보가 없습니다. 호스트의 제안을 다시 확인해 주세요.'}</p><pre className="garden-document-source-readonly"><code>{review.body}</code></pre></div><div className="drawer-footer">{formError && <p className="form-error" role="alert">{formError}</p>}<p>내용과 저장 대상을 확인하고 저장 여부를 결정해 주세요.</p><div><button className="button secondary" disabled={busy} onClick={() => void safe(async () => { await action({ type: 'workspace', action: { type: 'decide_review', review_id: review.id, approve: false } }); setReview(null); })}>저장하지 않음</button><button className="button primary" disabled={busy || !review.page_id || review.expected_hash === undefined} onClick={() => void safe(async () => { await action({ type: 'workspace', action: { type: 'decide_review', review_id: review.id, approve: true } }); setReview(null); })}>{busy ? '처리 중…' : '승인하고 저장'}<Check size={16}/></button></div></div></Modal>}
    {preferences.companion && !mobileOpen && section !== 'settings' && <FloatingPet profile={snapshot?.profiles.find(p => p.id === preferences.companionProfile) ?? snapshot?.profiles[0]} onOpen={() => { const p = snapshot?.profiles.find(p => p.id === preferences.companionProfile) ?? snapshot?.profiles[0]; if (p) navigate(`/ghosts/${p.id}`); }} onHide={() => updatePreferences({ companion: false })}/>}
  </div></AvatarProvider></ArcProvider>;
}
