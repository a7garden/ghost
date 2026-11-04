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
import { ArrowUpRight, Folder, LayoutList, Plus, Search, ArrowUp, RefreshCw, CircleAlert, Monitor, Menu } from 'lucide-react';
import { DotAvatar, PortraitAppearances, type PortraitAppearance } from './components/DotAvatar';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { Modal } from './components/Modal';
import { Integrations } from './features/Integrations';
import { Overview } from './features/Overview';
import { HostView } from './features/HostView';
import { ModelSettings } from './pets/ModelSettings';
import { hostStatus } from './features/hostStatus';
import { useDashboardWork } from './features/useDashboardWork';
import { DotDetail } from './features/DotDetail';
import { WorkView, InboxView, SpacesView } from './features/WorkViews';
import { connect } from './client/api';
import { searchWorkspace, type SearchHit } from './client/searchIndex';
import { inboxItems } from './client/inbox';
import type { Client } from './client/types';
import { useWorkspace } from './client/useWorkspace';
import { toneFor } from './client/types';
import type { Profile, Review } from './client/types';
import { CollaborationView } from './features/CollaborationView';
import { CollaborateForm } from './features/CollaborateForm';
import { LifetimeRoute } from './features/LifetimeRoute';
import { LegacyTranscript, legacyHistoryPath, legacyHistoryRequested } from './features/LegacyTranscript';
import { ApprovalDrawer } from './plugins/ApprovalDrawer';
import type { Approval, ApprovalRef } from './plugins/approvals';
import { GhostSwitcher, MobilePrimaryTabs, PackageImport, PortraitPicker } from './features/GhostPackageControls';
import { ghostPath, PackageWorkspace, portraitColors, usePackages, viewPath } from './features/PackageWorkspace';
import { faceColor, isHexColor } from './pets/appearance';
import './ghost-packages.css';

const lifetimeSetting = import.meta.env.VITE_GHOST_LIFETIME;

// Tauri 웹뷰는 모든 내비게이션에 __TAURI_INTERNALS__를 주입한다. 브라우저 콘솔에는
// 없으므로 커스텀 타이틀바와 높이 보정은 데스크톱 창에서만 적용된다.
const desktopShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !/iPhone|iPad/.test(navigator.userAgent);

const currentRoute = () => location.hash.replace(/^#/, '').replace(/^\/dots\//, '/ghosts/') || '/';
export function App({ connectClient = connect }: { connectClient?: () => Promise<Client> } = {}) {
  const { preferences, updatePreferences, storageError, resolvedTheme } = usePreferences();
  const workspace = useWorkspace(connectClient), { snapshot, mode, error, busy, action, query, reconnect } = workspace;
  const lifetimeEnabled = lifetimeSetting === 'true' || (lifetimeSetting !== 'false' && Boolean(snapshot?.lifetime_authority));
  const primaryChat = lifetimeEnabled && mode === 'live';
  const workPath = primaryChat ? '/lifetime?panel=work&scope=all' : '/work';
  const [route, setRoute] = useState(currentRoute), [dialog, setDialog] = useState<'add' | 'assign' | 'search' | 'connection' | 'package' | 'portrait' | 'views' | 'navigation' | null>(null);
  const [approval, setApproval] = useState<{ workspaceId: string; ref: ApprovalRef } | null>(null), [formError, setFormError] = useState('');
  const [assignedProfile, setAssignedProfile] = useState(''), [search, setSearch] = useState('');
  const assignmentConversation = useRef<Record<string, string>>({});
  const approvalOpener = useRef<HTMLElement | null>(null);
  const [collaborate, setCollaborate] = useState(false);
  const mainContent = useRef<HTMLElement>(null);
  const resetScroll = () => {
    if (desktopShell) mainContent.current?.scrollTo(0, 0);
    else window.scrollTo(0, 0);
  };
  useEffect(() => { const change = () => setRoute(currentRoute()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); location.hash = '/settings?tab=appearance'; } if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSearch(''); setDialog('search'); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  useEffect(() => { setFormError(''); }, [dialog]);
  const navigate = (path: string) => { resetScroll(); if (currentRoute() !== path) history.pushState(null, '', `#${path}`); setRoute(path); };
  const params = new URLSearchParams(route.split('?')[1] ?? '');
  const retiredPlanner = /^\/planner(?:[/?]|$)/.test(route);
  const workspaceReady = snapshot !== null;
  useEffect(() => {
    if (!retiredPlanner || !workspaceReady) return;
    history.replaceState(history.state, '', `#${workPath}`);
    setRoute(workPath);
  }, [retiredPlanner, workspaceReady, workPath]);
  const legacyGhostIndex = /^\/ghosts\/?$/.test(route.split('?')[0]);
  useEffect(() => {
    if (!legacyGhostIndex) return;
    history.replaceState(history.state, '', '#/');
    setRoute('/');
  }, [legacyGhostIndex]);
  const section = legacyGhostIndex ? 'home' : route.startsWith('/spaces') ? 'spaces' : route.split('/')[1]?.split('?')[0] || 'home';
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 10000); return () => clearInterval(timer); }, []);
  const status = hostStatus(mode, error, workspace.observedAt, workspace.connecting, clock);
  const connected = status.state === 'connected' || status.state === 'demo';
  const dashboardWork = useDashboardWork({ workspace: snapshot, mode, read: workspace.lifetimeRead, enabled: section === 'home' || section === 'host', loadRoster: section === 'home' && primaryChat && connected });
  const profiles = snapshot?.profiles ?? [];
  const dotSegment = section === 'ghosts' ? route.split('/')[2]?.split('?')[0] : null;
  const dot = profiles.find(profile => section === 'lifetime' ? profile.id === params.get('ghost') : encodeURIComponent(profile.id) === dotSegment);
  const dotId = dot?.id ?? null;
  const [lastGhostId, setLastGhostId] = useState<string | null>(null);
  const [defaultGhostId, setDefaultGhostId] = useState<string | null>(null);
  const [lifetimeGhostId, setLifetimeGhostId] = useState<string | null>(null);
  const [pendingRegistration, setPendingRegistration] = useState<{ ghostID: string; conversationID: string; workspaceID: string; authorityEpoch: number } | null>(null);
  useEffect(() => { if (dotId) setLastGhostId(dotId); }, [dotId]);
  const selected = section === 'lifetime'
    ? dot ?? profiles.find(profile => profile.id === lifetimeGhostId) ?? profiles.find(profile => profile.id === defaultGhostId)
    : dot ?? profiles.find(profile => profile.id === lastGhostId) ?? profiles[0];
  const { packages, refresh, error: packageError, loading: packagesLoading } = usePackages(snapshot?.workspace_id, profiles.map(profile => profile.id));
  const pkg = dot && packages[dot.id], selectedPkg = selected && packages[selected.id];
  const views = selectedPkg?.ui?.views ?? [];
  const requestedView = section === 'ghosts' ? params.get('view') : null;
  const activeView = requestedView ? pkg?.ui?.views.find(view => view.id === requestedView)
    ?? pkg?.ui?.views.find(view => view.id === pkg.ui?.defaultView) : undefined;
  const storageKey = `ghost-ui:package-shell:${snapshot?.workspace_id ?? ''}:`;
  const remember = (key: string, value?: string) => {
    try { if (value === undefined) localStorage.removeItem(storageKey + key); else localStorage.setItem(storageKey + key, value); }
    catch { /* Current navigation still works without local storage. */ }
  };
  const recalled = (key: string) => {
    try { return localStorage.getItem(storageKey + key); } catch { return null; }
  };
  const [portraitOverrides, setPortraitOverrides] = useState<Record<string, string | null>>({});
  const portraitKey = (id: string, part: keyof PortraitAppearance) =>
    part === 'background' ? `portrait:${id}` : `portrait-body:${id}`;
  const portraitChoice = (id: string, part: keyof PortraitAppearance) => {
    const key = portraitKey(id, part);
    const local = portraitOverrides[storageKey + key];
    const saved = local === undefined ? recalled(key) : local;
    if (isHexColor(saved)) return saved.toLowerCase();
    if (part === 'background' && saved && Object.hasOwn(portraitColors, saved)) {
      return portraitColors[saved as keyof typeof portraitColors];
    }
    return undefined;
  };
  const portraits = Object.fromEntries(profiles.map(({ id }) => {
    const preset = packages[id]?.ui?.portraitBackground;
    const background = portraitChoice(id, 'background') ?? (preset ? portraitColors[preset] : undefined);
    const body = portraitChoice(id, 'body') ?? (preferences.ghostColor === 'auto' && background ? faceColor(background) : undefined);
    return [id, { body, background }];
  }));
  useEffect(() => {
    if (!dotId || (section !== 'ghosts' && section !== 'lifetime') || (requestedView && !activeView)) return;
    try {
      const key = storageKey + `route:${dotId}`;
      if (section === 'ghosts' || (!params.has('panel') && !params.has('create'))) localStorage.setItem(key, route);
    } catch { /* Navigation remains available. */ }
  }, [route, dotId, section, requestedView, activeView, storageKey]);
  const switchGhost = (id: string) => {
    const saved = recalled(`route:${id}`);
    const savedQuery = new URLSearchParams(saved?.split('?')[1] ?? '');
    if (primaryChat) {
      if (saved?.startsWith('/lifetime?') && savedQuery.get('ghost') === id && savedQuery.has('conversation')) navigate(saved);
      else navigate(`/lifetime?ghost=${encodeURIComponent(id)}`);
      return;
    }
    if (saved?.split('?')[0] === ghostPath(id)) navigate(saved);
    else navigate(ghostPath(id));
  };
  const lifetimeDot = Boolean(section === 'ghosts' && dot && !activeView && lifetimeEnabled && mode === 'live' && !legacyHistoryRequested(route));
  const chatLayout = Boolean(section === 'ghosts' && dot && !activeView && !lifetimeDot);
  const lifetimePath = lifetimeDot && dot ? `/lifetime?ghost=${encodeURIComponent(dot.id)}`
    : section === 'lifetime' && lifetimeEnabled ? route : null;
  const [lastLifetimePath, setLastLifetimePath] = useState<string | null>(null);
  useEffect(() => { if (lifetimePath) setLastLifetimePath(lifetimePath); }, [lifetimePath]);
  const retainedLifetimePath = lifetimePath ?? lastLifetimePath;
  useEffect(() => {
    if (!pendingRegistration) return;
    const current = new URLSearchParams(lifetimePath?.split('?')[1] ?? '');
    if (current.get('ghost') !== pendingRegistration.ghostID || current.get('register') !== pendingRegistration.conversationID
      || snapshot?.workspace_id !== pendingRegistration.workspaceID || snapshot?.lifetime_authority?.authority_epoch !== pendingRegistration.authorityEpoch) {
      setPendingRegistration(null);
    }
  }, [lifetimePath, snapshot?.workspace_id, snapshot?.lifetime_authority?.authority_epoch, pendingRegistration]);
  useEffect(resetScroll, [section, dotId]);
  const inbox = snapshot ? inboxItems(snapshot, !error) : null;
  const attentionCount = inbox?.approvalCount ?? 0;
  const assign = (p?: Profile) => {
    if (lifetimeEnabled && mode === 'live') { navigate(p ? `/lifetime?ghost=${encodeURIComponent(p.id)}` : '/lifetime'); return; }
    setAssignedProfile(p?.id ?? snapshot?.profiles[0]?.id ?? ''); setDialog('assign');
  };
  const selectedSpace = route.startsWith('/spaces/') ? route.split('/')[2] : snapshot?.spaces[0]?.id;
  const addGhost = () => setDialog('add');
  const label = lifetimeDot ? 'Ghost 작업실' : dot?.name ?? routeLabels[section as keyof typeof routeLabels] ?? '찾을 수 없는 화면';
  const knownSections: Record<string, true> = { home: true, ghosts: true, spaces: true, inbox: true, work: true, together: true, integrations: true, settings: true, host: true, providers: true };
  const commands: SearchHit[] = [
    ...views.map(view => ({ kind: 'work' as const, id: `view:${view.id}`, title: view.label, path: selected ? viewPath(selected.id, view.id) : '/' })),
    ...[
      { id: 'inbox', title: routeLabels.inbox, path: '/inbox' },
      { id: 'home', title: routeLabels.home, path: '/' },
      { id: 'work', title: routeLabels.work, path: workPath },
      { id: 'spaces', title: routeLabels.spaces, path: '/spaces' },
      { id: 'together', title: routeLabels.together, path: '/together' },
      { id: 'integrations', title: routeLabels.integrations, path: '/integrations' },
      { id: 'host', title: '호스트', path: '/host' },
      { id: 'providers', title: '프로바이더', path: '/providers' },
      { id: 'settings', title: '앱 설정', path: '/settings' },
    ].map(command => ({ ...command, kind: 'work' as const })),
    { kind: 'work', id: 'package', title: '패키지 추가…', path: '' },
    ...(selected ? [{ kind: 'work' as const, id: 'portrait', title: '초상화 색상', path: '' }] : []),
  ];
  const searchHits = snapshot ? [...commands.filter(hit => hit.title.toLowerCase().includes(search.trim().toLowerCase())), ...searchWorkspace(snapshot, search)] : [];
  const runSearch = (hit: SearchHit) => {
    if (hit.id === 'package' || hit.id === 'portrait') { setDialog(hit.id); return; }
    setDialog(null);
    if (hit.kind === 'ghost' && hit.profile_id) switchGhost(hit.profile_id);
    else navigate(hit.path);
  };
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
      if (hit) { e.preventDefault(); runSearch(hit); }
    }
  };
  const close = () => { if (!busy) setDialog(null); };
  const openApproval = (ref: ApprovalRef) => {
    if (!snapshot) return;
    approvalOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setApproval({ workspaceId: snapshot.workspace_id, ref });
  };
  const openDocumentReview = (review: Review) => openApproval({ kind: 'document', id: review.id });
  const closeApproval = () => {
    if (busy) return;
    setApproval(null);
    const opener = approvalOpener.current;
    requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      else document.getElementById('main-content')?.focus({ preventScroll: true });
    });
  };
  const openApprovalConversation = (item: Approval) => {
    if (busy) return;
    setApproval(null);
    if (item.kind === 'document' && !item.review.lifetime_origin) {
      navigate(lifetimeEnabled && mode === 'live' ? legacyHistoryPath(item.ghostId, item.conversationId)
        : `/ghosts/${encodeURIComponent(item.ghostId)}?conversation=${encodeURIComponent(item.conversationId)}`);
    } else {
      navigate(`/lifetime?ghost=${encodeURIComponent(item.ghostId)}&conversation=${encodeURIComponent(item.conversationId)}`);
    }
  };
  const navigateHistory = (path: string) => {
    const [pathname, queryString] = path.split('?');
    const match = /^\/ghosts\/([^/]+)$/.exec(pathname);
    if (primaryChat && match) {
      const conversation = new URLSearchParams(queryString).get('conversation') ?? undefined;
      navigate(legacyHistoryPath(decodeURIComponent(match[1]), conversation));
    } else navigate(path);
  };
  const safe = async (fn: () => Promise<void>) => { setFormError(''); try { await fn(); } catch (e) { setFormError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.'); } };
  const sidebar = <WorkspaceSidebar snapshot={snapshot} route={route} section={section} dotId={selected?.id ?? null}
    selectedSpace={selectedSpace} views={views} activeView={activeView?.id} attentionCount={attentionCount} mode={mode}
    error={error} lifetimeEnabled={lifetimeEnabled} showGhostHeading={!desktopShell} status={status} navigate={path => { setDialog(null); navigate(path); }} onConnection={() => { setDialog(null); navigate('/host'); }}/>;

  const lifetimeScreen = (path: string) => {
    if (!snapshot) return null;
    const routeParams = new URLSearchParams(path.split('?')[1] ?? '');
    const ghostID = routeParams.get('ghost') ?? undefined;
    const registerID = routeParams.get('register') ?? undefined;
    const authorizedRegistration = lifetimePath === path && pendingRegistration && pendingRegistration.ghostID === ghostID
      && pendingRegistration.conversationID === registerID && pendingRegistration.workspaceID === snapshot.workspace_id
      && pendingRegistration.authorityEpoch === snapshot.lifetime_authority?.authority_epoch ? pendingRegistration : undefined;
    return <LifetimeRoute connected={connected} active={Boolean(lifetimePath)} route={path} legacyGhostIDs={snapshot.profiles.map(profile => profile.id)}
      onOpenHistory={ghost => { if (snapshot.profiles.some(profile => profile.id === ghost)) navigate(legacyHistoryPath(ghost)); }}
      action={workspace.lifetimeAction} memoryAction={action} workspaceId={snapshot.workspace_id} authority={snapshot.lifetime_authority} mode={mode}
      documentReviews={snapshot.reviews} documentAuthorityEpoch={snapshot.lifetime_authority?.authority_epoch} onOpenDocumentReview={openDocumentReview}
      snapshot={snapshot} onOpenApproval={openApproval} onDefaultGhostChange={setDefaultGhostId} onTargetChange={setLifetimeGhostId}
      authorizedRegistration={authorizedRegistration}
      onRegistrationConsumed={(profile, conversation) => setPendingRegistration(current => current?.ghostID === profile && current.conversationID === conversation ? null : current)}
      onOpenTarget={(ghost, conversation, preserveWorkRoute = true) => {
        const activeRoute = currentRoute();
        if (!lifetimePath || activeRoute !== route) return;
        if (!activeRoute.startsWith('/lifetime') && !activeRoute.startsWith('/ghosts/')) return;
        if (activeRoute.startsWith('/ghosts/') && legacyHistoryRequested(activeRoute)) return;
        const params = new URLSearchParams(activeRoute.split('?')[1] ?? '');
        const visibleGhost = params.get('ghost') ?? (activeRoute.startsWith('/ghosts/') ? decodeURIComponent(activeRoute.split('/')[2]?.split('?')[0] ?? '') : null);
        if (preserveWorkRoute && visibleGhost && visibleGhost !== ghost) return;
        if (!preserveWorkRoute) {
          params.delete('panel'); params.delete('scope'); params.delete('goal'); params.delete('work');
        }
        params.delete('register'); params.delete('create');
        params.set('ghost', ghost); params.set('conversation', conversation);
        navigate(`/lifetime?${params}`);
      }}
      navigate={navigate}/>;
  };
  const ghostSwitcher = <GhostSwitcher profiles={profiles} selected={selected} onSelect={switchGhost} onAdd={addGhost}
    defaultGhostId={defaultGhostId} onImport={() => setDialog('package')} onPortrait={() => setDialog('portrait')}/>;
  const searchControl = <button className={desktopShell ? 'desktop-command-trigger' : 'icon-button ghost-search-button'} title="명령 검색 · ⌘K" aria-label="명령 검색"
    onClick={() => { setSearch(''); setDialog('search'); }}><Search size={desktopShell ? 16 : 18}/>{desktopShell && <kbd aria-hidden="true">⌘K</kbd>}</button>;
  return <ArcProvider theme={resolvedTheme} density="compact" motion={preferences.animate ? 'user' : 'reduce'} className="ghost-arc"><PortraitAppearances.Provider value={portraits}><AvatarProvider key={snapshot?.workspace_id ?? 'loading'} snapshot={snapshot} query={query} animate={preferences.animate}>
    {desktopShell && <GTitleBar className="ghost-desktop-titlebar" aria-label="Ghost"
      center={<div className="ghost-desktop-titlebar__drag" data-tauri-drag-region>
        {ghostSwitcher}
      </div>}
      right={<div className="shell-quick-actions"><button className="icon-button mobile-menu-trigger" aria-label="전체 메뉴" onClick={() => setDialog('navigation')}><Menu size={19}/></button>{searchControl}</div>}/>}
    <div className={`app-shell ${desktopShell ? 'app-shell--desktop' : ''}`}>
    <aside className="sidebar" aria-label="작업실 탐색">{sidebar}</aside>
    <div className={`main-shell ${chatLayout ? 'chat-shell' : ''} ${activeView ? 'package-shell' : ''}`}>
      {!desktopShell && <header className="ghost-shell-toolbar">
        <button className="icon-button mobile-menu-trigger" aria-label="전체 메뉴" onClick={() => setDialog('navigation')}><Menu size={19}/></button>
        {ghostSwitcher}
        <span className="ghost-shell-location">{activeView?.label ?? (!dot ? label : '')}</span>
        {searchControl}
      </header>}
      {error && <div className="connection-error" role="alert"><CircleAlert size={17}/><span>{error}</span><button className="text-button" onClick={reconnect}><RefreshCw size={14}/>다시 연결</button></div>}
      {!snapshot || retiredPlanner ? <main className="page-content loading-content" aria-busy={!error}><div className="skeleton heading-skeleton"/><div className="skeleton description-skeleton"/><div className="dot-grid">{[0, 1, 2, 3].map(i => <div className="skeleton dot-skeleton" key={i}/>)}</div>{error && <p>연결되면 저장된 Ghost와 작업을 표시합니다.</p>}</main> : <main ref={mainContent} id="main-content" tabIndex={-1} className={chatLayout ? 'detail-main' : ''}>
        {section === 'settings' && <Settings snapshot={snapshot} route={route} navigate={navigate} action={action} busy={busy} mode={mode} preferences={preferences} updatePreferences={updatePreferences} storageError={storageError} connected={connected}/>}
        {section === 'home' && <Overview snapshot={snapshot} mode={mode} connected={connected} navigate={navigate} onReview={openDocumentReview} onAdd={addGhost} onAssign={assign} defaultGhostId={dashboardWork.defaultGhostId} lifetime={dashboardWork.snapshot} workError={dashboardWork.error} workLoading={dashboardWork.loading} status={status}/>}
        {section === 'ghosts' && dotSegment && (dot && pkg && activeView ?
          <PackageWorkspace key={`${dot.id}:${pkg.digest}:${activeView.id}`} info={pkg} view={activeView}
            onNavigate={view => navigate(viewPath(dot.id, view))} onChat={() => navigate(ghostPath(dot.id))}/> : dot ? lifetimeEnabled && mode === 'live' ? legacyHistoryRequested(route) ? <LegacyTranscript profile={dot} route={route} navigate={navigate}/> : null : <DotDetail key={dot.id} profile={dot} snapshot={snapshot} mode={mode} action={action} busy={busy} connected={!error} routing={workspace.routing} navigate={navigate} route={route} onReview={openDocumentReview}/> : <div className="empty-state"><CircleAlert size={28}/><h1>이 Ghost를 찾을 수 없습니다</h1><button className="button secondary" onClick={() => navigate('/')}>작업실로</button></div>)}
        {section === 'work' && <WorkView snapshot={snapshot} action={action} busy={busy} navigate={navigateHistory} onAssign={() => assign()}/>}
        {section === 'together' && <CollaborationView snapshot={snapshot} route={route} mode={mode} action={action} query={query} busy={busy} navigate={navigateHistory} onAssign={() => primaryChat ? assign() : setCollaborate(true)}/>}
        {section === 'providers' && <div className="page-content providers-page"><div className="page-heading"><h1>프로바이더</h1></div><ModelSettings snapshot={snapshot} action={action} busy={busy} mode={mode} connected={connected}/></div>}
        {section === 'host' && <HostView snapshot={snapshot} status={status} observedAt={workspace.observedAt} workObservedAt={dashboardWork.observedAt} workError={dashboardWork.error} reconnect={() => { reconnect(); dashboardWork.refresh(); }} navigate={navigate}/>}
        {section === 'integrations' && <Integrations snapshot={snapshot} action={action} busy={busy} mode={mode} connected={connected} navigate={navigate} packages={packagesLoading ? undefined : packages} packageError={packageError} onRefreshPackages={refresh} onImport={() => setDialog('package')}/>}
        {section === 'inbox' && <InboxView snapshot={snapshot} onOpenApproval={openApproval} navigate={navigate} connected={!error}/>}
        {section === 'spaces' && <SpacesView key={selectedSpace ?? 'empty'} snapshot={snapshot} selectedSpace={selectedSpace} action={query} navigate={navigate} theme={resolvedTheme}/>}
        {retainedLifetimePath && <div className="lifetime-route-surface" hidden={!lifetimePath}>
          {lifetimeScreen(retainedLifetimePath)}
        </div>}
        {!knownSections[section] && !(section === 'lifetime' && lifetimeEnabled) && <div className="empty-state"><CircleAlert size={28}/><h1>이 화면을 찾을 수 없습니다</h1><p className="muted">주소가 이동했거나 잘못되었을 수 있습니다.</p><button className="button secondary" onClick={() => navigate('/')}>작업실로</button></div>}
      </main>}
    </div>
    <MobilePrimaryTabs selectedGhostId={selected?.id} hasViews={views.length > 0} workPath={workPath}
      active={activeView ? 'workspace' : section === 'home' ? 'home' : section === 'inbox' ? 'inbox'
        : section === 'work' || section === 'lifetime' && params.get('panel') === 'work' ? 'work'
          : section === 'ghosts' || section === 'lifetime' && !['work', 'ghosts'].includes(params.get('panel') ?? '') ? 'chat' : undefined}
      onNavigate={navigate} onChat={() => { if (selected) switchGhost(selected.id); }} onWorkspace={() => {
        if (!selected) return;
        if (views.length === 1) navigate(viewPath(selected.id, views[0].id));
        else setDialog('views');
      }}/>
    {dialog === 'navigation' && <Modal title="Ghost" className="navigation-dialog" onClose={close}><div className="mobile-sidebar">{sidebar}</div></Modal>}
    {dialog === 'views' && selected && <Modal title="작업실" className="mobile-workspace-dialog" onClose={close}>
      <nav aria-label={`${selected.name} 전용 화면`} className="mobile-workspace-menu">{views.map(view =>
        <button className="nav-row" key={view.id} aria-current={view.id === activeView?.id ? 'page' : undefined}
          onClick={() => { setDialog(null); navigate(viewPath(selected.id, view.id)); }}>{view.label}</button>)}</nav>
    </Modal>}
    {dialog === 'package' && snapshot && <PackageImport workspace={snapshot.workspace_id} profiles={profiles} selected={selected?.id ?? ''}
      onClose={close} onInstalled={id => { refresh(); setDialog(null); navigate(ghostPath(id)); }}/>}
    {dialog === 'portrait' && selected && <PortraitPicker key={selected.id} profile={selected}
      appearance={portraits[selected.id]}
      choices={{ body: portraitChoice(selected.id, 'body'), background: portraitChoice(selected.id, 'background') }}
      defaults={{
        body: preferences.ghostColor === 'auto' ? (resolvedTheme === 'dark' ? '#f5f5f5' : '#191919') : preferences.ghostColor,
        background: resolvedTheme === 'dark' ? '#191919' : '#ffffff',
      }}
      onClose={close} onSelect={(part, color) => {
        const key = portraitKey(selected.id, part);
        remember(key, color);
        setPortraitOverrides(previous => ({ ...previous, [storageKey + key]: color ?? null }));
      }}/>}
    {collaborate && snapshot && !primaryChat && <CollaborateForm snapshot={snapshot} action={action} busy={busy} mode={mode} onClose={() => !busy && setCollaborate(false)} onCreated={path => { setCollaborate(false); navigate(path); }}/>}
    {dialog === 'add' && <Modal title="Ghost 만들기" onClose={close}><form className="form-stack" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const name = String(data.get('name')), persona = String(data.get('persona')); void safe(async () => { const result = await action({ type: 'create_profile', name, persona }); const id = String(result.profile_id ?? ''); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Ghost 생성 결과에서 ID를 확인하지 못했습니다. 같은 요청을 다시 확인해 주세요.'); setDialog(null); if (currentRoute() !== route) return; if (primaryChat && snapshot?.lifetime_authority) {
      const conversationID = crypto.randomUUID();
      setPendingRegistration({ ghostID: id, conversationID, workspaceID: snapshot.workspace_id, authorityEpoch: snapshot.lifetime_authority.authority_epoch });
      navigate(`/lifetime?ghost=${encodeURIComponent(id)}&register=${encodeURIComponent(conversationID)}`);
    } else navigate(ghostPath(id)); }); }}><div className="new-dot-illustration"><DotAvatar tone="mint" size={94}/><DotAvatar tone="lilac" size={74}/></div><label>Ghost 이름<input name="name" placeholder="예: Scout" required maxLength={64} pattern="[A-Za-z0-9_-]+" autoComplete="off"/><span className="field-help">영문, 숫자, 밑줄과 하이픈을 사용할 수 있습니다.</span></label><label>{primaryChat ? "역할 메모" : uiTerms.roleInstructions}<textarea name="persona" placeholder={primaryChat ? "예: 여행 자료와 참고 문헌 정리" : "자료를 조사하고, 확인한 근거와 함께 요약합니다."} required maxLength={4096} rows={3}/></label>{formError && <p className="form-error" role="alert">{formError}</p>}<button className="button primary full-width" disabled={busy || !connected}>{busy ? '만드는 중…' : 'Ghost 만들기'}<Plus size={16}/></button></form></Modal>}
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
    {dialog === 'search' && snapshot && <Modal title={`${uiTerms.workspace} 검색`} onClose={close} className="search-dialog"><label className="search-field"><Search size={18}/><input role="combobox" aria-expanded="true" aria-controls="ghost-search-results" aria-label="작업실 검색" aria-activedescendant={`search-hit-${searchIndex}`} placeholder="Ghost, 화면, 맡긴 일 검색" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={searchKeyDown}/></label><div className="search-results" role="listbox" id="ghost-search-results" aria-label="검색 결과">{searchHits.map((hit, i) => <button key={`${hit.kind}:${hit.id}`} id={`search-hit-${i}`} role="option" aria-selected={i === searchIndex} className={i === searchIndex ? 'selected' : undefined} onClick={() => { runSearch(hit); }}>{hit.kind === 'ghost' && hit.profile_id ? <DotAvatar profileId={hit.profile_id} tone={toneFor(hit.profile_id)} size={36}/> : hit.kind === 'space' ? <Folder size={18}/> : <LayoutList size={18}/>}<span><strong>{hit.title}</strong>{hit.subtitle && <small>{hit.subtitle}</small>}</span><ArrowUpRight size={16}/></button>)}{!searchHits.length && <p className="quiet-empty">다른 이름이나 단어로 검색해 주세요.</p>}</div></Modal>}
    {dialog === 'connection' && <Modal title="작업실 연결" onClose={close}><div className="form-stack"><div className="connection-illustration"><Monitor size={36}/></div><h3>{mode === 'demo' ? '예시 모드입니다' : '로컬 Ghost 호스트를 사용합니다'}</h3><p className="muted">{mode === 'demo' ? '여기 있는 Ghost와 작업은 UI를 살펴보기 위한 예시입니다. 대화, 문서 검토, 반복 작업 변경은 이 브라우저의 예시에만 반영됩니다.' : 'Ghost의 역할, 대화와 맡은 일은 호스트에 저장됩니다. 호스트가 실행 중이면 화면을 닫아도 작업이 이어집니다.'}</p><div className="connection-detail"><span>상태</span><strong>{error ? '다시 연결 필요' : mode === 'demo' ? '예시 모드' : '연결됨'}</strong></div><button className="button secondary" onClick={reconnect}><RefreshCw size={16}/>연결 다시 확인</button></div></Modal>}
    {approval && snapshot?.workspace_id === approval.workspaceId && <ApprovalDrawer
      selected={approval.ref} snapshot={snapshot} connected={!error} busy={busy} action={action} query={query}
      onClose={closeApproval} onOpenConversation={openApprovalConversation}/>}
    {preferences.companion && section !== 'settings' && <FloatingPet profile={snapshot?.profiles.find(p => p.id === preferences.companionProfile) ?? snapshot?.profiles[0]} onOpen={() => { const p = snapshot?.profiles.find(p => p.id === preferences.companionProfile) ?? snapshot?.profiles[0]; if (p) navigate(`/ghosts/${p.id}`); }} onHide={() => updatePreferences({ companion: false })}/>}
  </div></AvatarProvider></PortraitAppearances.Provider></ArcProvider>;
}
