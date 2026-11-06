import { routeLabels, uiTerms } from './uiText';
import { Banner, Button, EmptyState, FormField, Input, InlineError, Skeleton, Textarea, type GCommandItem } from '@garden/ui';
import { AppFrame } from './components/AppFrame';
import { AvatarProvider } from './pets/AvatarProvider';
import { Settings, type SettingsSection } from './pets/Settings';
import { FloatingPet } from './pets/FloatingPet';
import { usePreferences } from './pets/preferences';
import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Puzzle, Server, Users } from 'lucide-react';
import { PortraitAppearances, type PortraitAppearance } from './components/DotAvatar';
import { WorkspaceSidebar, type GhostMenuItem } from './components/WorkspaceSidebar';
import { ghostDisplayName } from './features/profileSummary';
import { Modal } from './components/Modal';
import { Integrations } from './features/Integrations';
import { Overview } from './features/Overview';
import { HostView } from './features/HostView';
import { TeamSettings } from './features/TeamSettings';
import { hostStatus } from './features/hostStatus';
import { useDashboardWork } from './features/useDashboardWork';
import { DotDetail } from './features/DotDetail';
import { WorkView, InboxView } from './features/WorkViews';
import { SpacesView } from './features/SpacesView';
import { connect } from './client/api';
import { searchWorkspace } from './client/searchIndex';
import { inboxItems } from './client/inbox';
import type { Client } from './client/types';
import { useWorkspace } from './client/useWorkspace';
import type { Review } from './client/types';
import { CollaborationView } from './features/CollaborationView';
import { CollaborateForm } from './features/CollaborateForm';
import { LifetimeRoute } from './features/LifetimeRoute';
import { LegacyTranscript, legacyHistoryPath, legacyHistoryRequested } from './features/LegacyTranscript';
import { ApprovalDrawer } from './plugins/ApprovalDrawer';
import type { Approval, ApprovalRef } from './plugins/approvals';
import { PackageImport, PortraitPicker } from './features/GhostPackageControls';
import { ghostPath, PackageWorkspace, portraitColors, usePackages, viewPath } from './features/PackageWorkspace';
import { faceColor, isHexColor } from './pets/appearance';

const lifetimeSetting = import.meta.env.VITE_GHOST_LIFETIME;

// Tauri 웹뷰는 모든 내비게이션에 __TAURI_INTERNALS__를 주입한다. 데스크톱 창에서만 끌 수 있는 타이틀바를 그린다.
const desktopShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !/iPhone|iPad/.test(navigator.userAgent);
const desktopMac = desktopShell && /Mac/.test(navigator.platform);

const currentRoute = () => location.hash.replace(/^#/, '').replace(/^\/dots\//, '/ghosts/') || '/';
export function App({ connectClient = connect }: { connectClient?: () => Promise<Client> } = {}) {
  const { preferences, updatePreferences, storageError, resolvedTheme } = usePreferences();
  const workspace = useWorkspace(connectClient), { snapshot, mode, error, busy, action, query, reconnect } = workspace;
  const lifetimeEnabled = lifetimeSetting === 'true' || (lifetimeSetting !== 'false' && Boolean(snapshot?.lifetime_authority));
  const primaryChat = lifetimeEnabled && mode === 'live';
  const workPath = primaryChat ? '/lifetime?panel=work&scope=all' : '/work';
  const [route, setRoute] = useState(currentRoute), [dialog, setDialog] = useState<'add' | 'package' | 'portrait' | null>(null);
  const [approval, setApproval] = useState<{ workspaceId: string; ref: ApprovalRef } | null>(null), [formError, setFormError] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  // A dashboard message waiting for the primary conversation view to send it.
  const [chatHandoff, setChatHandoff] = useState<{ id: string; text: string } | null>(null);
  const approvalOpener = useRef<HTMLElement | null>(null);
  const [collaborate, setCollaborate] = useState(false);
  // The main region owns scrolling; a new destination starts at its top.
  const resetScroll = () => { document.getElementById('main-content')?.scrollTo(0, 0); };
  useEffect(() => { const change = () => setRoute(currentRoute()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); location.hash = '/settings?tab=appearance'; } if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setPaletteOpen(true); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
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
  // Owner-level pages now live in settings; old links land on the matching tab.
  const settingsTab = ({ '/host': 'host', '/providers': 'models', '/integrations': 'extensions' } as Record<string, string>)[route.split('?')[0]];
  useEffect(() => {
    if (!settingsTab) return;
    history.replaceState(history.state, '', `#/settings?tab=${settingsTab}`);
    setRoute(`/settings?tab=${settingsTab}`);
  }, [settingsTab]);
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
  // undefined = not read yet; null = the Host has no default Ghost.
  const [defaultGhostId, setDefaultGhostId] = useState<string | null | undefined>(undefined);
  // The default Ghost labels every page, so it is loaded once even when the first page is not home.
  const needDefault = primaryChat && defaultGhostId === undefined;
  const dashboardWork = useDashboardWork({ workspace: snapshot, mode, read: workspace.lifetimeRead, enabled: section === 'home' || section === 'settings' && params.get('tab') === 'host' || needDefault, loadRoster: connected && (needDefault || section === 'home' && primaryChat) });
  useEffect(() => { if (dashboardWork.defaultGhostId !== undefined) setDefaultGhostId(dashboardWork.defaultGhostId); }, [dashboardWork.defaultGhostId]);
  const profiles = snapshot?.profiles ?? [];
  const dotSegment = section === 'ghosts' ? route.split('/')[2]?.split('?')[0] : null;
  const dot = profiles.find(profile => section === 'lifetime' ? profile.id === params.get('ghost') : encodeURIComponent(profile.id) === dotSegment);
  const dotId = dot?.id ?? null;
  const [lastGhostId, setLastGhostId] = useState<string | null>(null);
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
  const homeGhostId = dashboardWork.defaultGhostId ?? defaultGhostId ?? null;
  // The primary conversation is the only valid default in Pi mode; legacy mode falls back to the first Ghost.
  const chatTarget = profiles.find(profile => profile.id === homeGhostId) ?? (primaryChat ? undefined : profiles[0]);
  const assign = () => {
    if (primaryChat) { navigate('/lifetime'); return; }
    navigate('/');
    requestAnimationFrame(() => document.getElementById('dashboard-message')?.focus());
  };
  // The primary conversation view owns privacy, retry and recovery for
  // `conversation.input`, so the dashboard hands the text to it instead of
  // sending a second, divergent command path.
  const startChat = async (text: string) => {
    if (!snapshot || !chatTarget) throw new Error('메시지를 받을 Ghost를 확인하지 못했습니다.');
    if (primaryChat) {
      setChatHandoff({ id: crypto.randomUUID(), text });
      navigate(`/lifetime?ghost=${encodeURIComponent(chatTarget.id)}`);
      return;
    }
    const created = await action({ type: 'create_conversation', profile_id: chatTarget.id, model: snapshot.default_model, tools: true });
    const conversation = String(created.conversation_id ?? '');
    if (!conversation) throw new Error('새 대화를 만들지 못했습니다.');
    await action({ type: 'submit', profile_id: chatTarget.id, conversation_id: conversation, prompt: text, kind: 'prompt' });
    navigate(`${ghostPath(chatTarget.id)}?conversation=${encodeURIComponent(conversation)}`);
  };
  const selectedSpace = route.startsWith('/spaces/') ? route.split('/')[2] : snapshot?.spaces[0]?.id;
  // Move keyboard focus to the new page's heading; GPageHeader titles are not focusable by themselves.
  const focusPageHeading = () => {
    const heading = document.querySelector<HTMLElement>('#main-content h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  };
  const selectDocumentFolder = (id: string) => {
    navigate(`/spaces/${id}`);
    requestAnimationFrame(focusPageHeading);
  };
  const addGhost = () => setDialog('add');
  // A Ghost is "open" on its conversation, its work, its package views and its earlier conversations; scope=all is the workspace-wide work board.
  const allWork = section === 'lifetime' && params.get('scope') === 'all';
  const openGhostId = section === 'lifetime' && !allWork ? selected?.id ?? null : section === 'ghosts' ? dotId : null;
  const openGhost = profiles.find(profile => profile.id === openGhostId);
  // The Ghost's own row opens its conversation; the sub-items are the Ghost's other pages.
  const ghostMenu: GhostMenuItem[] = openGhost ? [
    ...(primaryChat ? [{ key: 'work', label: '맡은 일', path: `/lifetime?ghost=${encodeURIComponent(openGhost.id)}&panel=work`, kind: 'work' as const }] : []),
    ...views.map(view => ({ key: `view:${view.id}`, label: view.label, path: viewPath(openGhost.id, view.id), kind: 'view' as const })),
    ...(primaryChat && openGhost.conversations.length > 0 ? [{ key: 'history', label: '이전 대화', path: legacyHistoryPath(openGhost.id), kind: 'history' as const }] : []),
  ] : [];
  const currentGhostPage = !openGhost ? null
    : section === 'lifetime' ? params.get('panel') === 'work' ? 'work' : params.get('panel') === 'ghosts' ? null : 'chat'
    : activeView ? `view:${activeView.id}` : legacyHistoryRequested(route) ? 'history' : 'chat';
  const ghostPageLabel = ghostMenu.find(item => item.key === currentGhostPage && item.key !== 'chat')?.label;
  const label = (openGhost && `${ghostDisplayName(openGhost.name)}${ghostPageLabel ? ` · ${ghostPageLabel}` : ''}`)
    || (allWork && routeLabels.work)
    || (section === 'spaces' && snapshot?.spaces.find(space => space.id === selectedSpace)?.name)
    || (section === 'lifetime' ? routeLabels.work : routeLabels[section as keyof typeof routeLabels]) || '찾을 수 없는 화면';
  const knownSections: Record<string, true> = { home: true, ghosts: true, spaces: true, inbox: true, work: true, together: true, integrations: true, settings: true, host: true, providers: true };
  const go = (path: string) => () => navigate(path);
  const commandItems: GCommandItem[] = snapshot ? [
    { id: 'home', label: routeLabels.home, group: '이동', onSelect: go('/') },
    { id: 'inbox', label: routeLabels.inbox, group: '이동', onSelect: go('/inbox') },
    { id: 'work', label: routeLabels.work, group: '이동', onSelect: go(workPath) },
    { id: 'together', label: routeLabels.together, group: '이동', onSelect: go('/together') },
    { id: 'spaces', label: routeLabels.spaces, group: '이동', onSelect: go('/spaces') },
    ...views.map(view => ({ id: `view:${view.id}`, label: view.label, group: '이동', onSelect: go(selected ? viewPath(selected.id, view.id) : '/') })),
    { id: 'team', label: '팀', group: '설정', onSelect: go('/settings?tab=team') },
    { id: 'models', label: '모델', group: '설정', onSelect: go('/settings?tab=models') },
    { id: 'extensions', label: routeLabels.integrations, group: '설정', onSelect: go('/settings?tab=extensions') },
    { id: 'host', label: routeLabels.host, group: '설정', onSelect: go('/settings?tab=host') },
    { id: 'settings', label: routeLabels.settings, group: '설정', onSelect: go('/settings') },
    { id: 'add-ghost', label: '새 Ghost', group: '작업', onSelect: () => setDialog('add') },
    { id: 'package', label: '패키지 추가…', group: '작업', onSelect: () => setDialog('package') },
    ...(selected ? [{ id: 'portrait', label: '초상화 색상', group: '작업', onSelect: () => setDialog('portrait') }] : []),
    ...searchWorkspace(snapshot, '').map(hit => ({
      id: `${hit.kind}:${hit.id}`, label: hit.title, description: hit.subtitle, group: hit.kind === 'ghost' ? 'Ghost' : hit.kind === 'space' ? '프로젝트' : '기록',
      onSelect: hit.kind === 'ghost' && hit.profile_id ? () => switchGhost(hit.profile_id!) : go(hit.path),
    })),
  ] : [];
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
      else focusPageHeading();
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
  const sidebar = <WorkspaceSidebar snapshot={snapshot} section={section} openGhostId={openGhostId} ghostMenu={ghostMenu} currentGhostPage={currentGhostPage}
    defaultGhostId={homeGhostId} selectedSpace={params.has('new') ? undefined : selectedSpace} attentionCount={attentionCount} status={status}
    canCreateProject={mode === 'live' && snapshot?.capabilities.documents === true} navigate={navigate} openGhost={switchGhost}/>;
  const settingsSections: SettingsSection[] = snapshot ? [
    { id: 'team', label: '팀', icon: Users, content: <TeamSettings profiles={profiles} defaultGhostId={homeGhostId} connected={connected}
      onChat={switchGhost} onAdd={addGhost} onImport={() => setDialog('package')}
      onManage={primaryChat ? id => navigate(`/lifetime?ghost=${encodeURIComponent(id)}&panel=ghosts`) : undefined}
      onPortrait={id => { setLastGhostId(id); setDialog('portrait'); }}/> },
    { id: 'extensions', label: routeLabels.integrations, icon: Puzzle, content: <Integrations snapshot={snapshot} action={action} busy={busy} mode={mode} connected={connected} navigate={navigate} packages={packagesLoading ? undefined : packages} packageError={packageError} onRefreshPackages={refresh} onImport={() => setDialog('package')}/> },
    { id: 'host', label: routeLabels.host, icon: Server, content: <HostView snapshot={snapshot} status={status} observedAt={workspace.observedAt} workObservedAt={dashboardWork.observedAt} workError={dashboardWork.error} reconnect={() => { reconnect(); dashboardWork.refresh(); }} navigate={navigate}/> },
  ] : [];

  const lifetimeScreen = (path: string) => {
    if (!snapshot) return null;
    const routeParams = new URLSearchParams(path.split('?')[1] ?? '');
    const ghostID = routeParams.get('ghost') ?? undefined;
    const registerID = routeParams.get('register') ?? undefined;
    const authorizedRegistration = lifetimePath === path && pendingRegistration && pendingRegistration.ghostID === ghostID
      && pendingRegistration.conversationID === registerID && pendingRegistration.workspaceID === snapshot.workspace_id
      && pendingRegistration.authorityEpoch === snapshot.lifetime_authority?.authority_epoch ? pendingRegistration : undefined;
    return <LifetimeRoute connected={connected} active={Boolean(lifetimePath)} route={path}
      handoff={lifetimePath === path ? chatHandoff ?? undefined : undefined}
      onHandoffConsumed={id => setChatHandoff(current => current?.id === id ? null : current)}
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
  const ghostNotFound = <EmptyState icon={<CircleAlert/>} title="이 Ghost를 찾을 수 없습니다" action={<Button variant="outline" onClick={() => navigate('/')}>홈으로</Button>}/>;
  const lifetimeVisible = Boolean(lifetimePath);
  // Conversations and settings own their geometry; everything else scrolls in the shell's padded region.
  const ownsGeometry = section === 'settings' || chatLayout || Boolean(activeView) || lifetimeVisible && (params.get('panel') ?? 'conversation') === 'conversation';
  const createGhost = (data: FormData) => {
    const name = String(data.get('name')), persona = String(data.get('persona'));
    void safe(async () => {
      const result = await action({ type: 'create_profile', name, persona });
      const id = String(result.profile_id ?? '');
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Ghost 생성 결과에서 ID를 확인하지 못했습니다. 같은 요청을 다시 확인해 주세요.');
      setDialog(null);
      if (currentRoute() !== route) return;
      if (primaryChat && snapshot?.lifetime_authority) {
        const conversationID = crypto.randomUUID();
        setPendingRegistration({ ghostID: id, conversationID, workspaceID: snapshot.workspace_id, authorityEpoch: snapshot.lifetime_authority.authority_epoch });
        navigate(`/lifetime?ghost=${encodeURIComponent(id)}&register=${encodeURIComponent(conversationID)}`);
      } else navigate(ghostPath(id));
    });
  };
  return <div className="ghost-root"><PortraitAppearances.Provider value={portraits}><AvatarProvider key={snapshot?.workspace_id ?? 'loading'} snapshot={snapshot} query={query} animate={preferences.animate}>
    <AppFrame desktop={desktopShell} macOSInset={desktopMac ? 80 : 0} location={label} sidebar={sidebar} fill={ownsGeometry}
      commands={commandItems} paletteOpen={paletteOpen} onPaletteOpenChange={setPaletteOpen}>
      {error && <Banner variant="danger" className="mb-4" action={<Button variant="outline" onClick={reconnect}>다시 연결</Button>}>{error}</Banner>}
      {!snapshot || retiredPlanner ? <div className="grid gap-3 p-8" aria-busy={!error}><Skeleton className="h-7 w-48"/><Skeleton className="h-4 w-72"/><Skeleton className="h-24 w-full"/></div> : <>
        {section === 'settings' && <Settings snapshot={snapshot} route={route} navigate={navigate} action={action} busy={busy} mode={mode} preferences={preferences} updatePreferences={updatePreferences} storageError={storageError} connected={connected} sections={settingsSections}/>}
        {section === 'home' && <Overview snapshot={snapshot} connected={connected} navigate={navigate} onOpenApproval={openApproval} onStartChat={startChat} chatTarget={chatTarget} workPath={workPath} lifetime={dashboardWork.snapshot} workError={dashboardWork.error} workLoading={dashboardWork.loading}/>}
        {section === 'ghosts' && dotSegment && (dot && pkg && activeView
          ? <PackageWorkspace key={`${dot.id}:${pkg.digest}:${activeView.id}`} info={pkg} view={activeView}
            onNavigate={view => navigate(viewPath(dot.id, view))} onChat={() => navigate(ghostPath(dot.id))}/>
          : dot ? lifetimeEnabled && mode === 'live' ? legacyHistoryRequested(route) ? <LegacyTranscript profile={dot} route={route} navigate={navigate}/> : null
            : <DotDetail key={dot.id} profile={dot} snapshot={snapshot} mode={mode} action={action} busy={busy} connected={!error} routing={workspace.routing} navigate={navigate} route={route} onReview={openDocumentReview}/>
          : ghostNotFound)}
        {section === 'work' && <WorkView snapshot={snapshot} action={action} busy={busy} navigate={navigateHistory} onAssign={() => assign()}/>}
        {section === 'together' && <CollaborationView snapshot={snapshot} route={route} mode={mode} action={action} query={query} busy={busy} navigate={navigateHistory} onAssign={() => primaryChat ? assign() : setCollaborate(true)}/>}
        {section === 'inbox' && <InboxView snapshot={snapshot} onOpenApproval={openApproval} navigate={navigate} connected={!error}/>}
        {section === 'spaces' && <SpacesView key={`${snapshot.workspace_id}:${selectedSpace ?? 'empty'}:${params.get('new') ?? ''}`} snapshot={snapshot} selectedSpace={selectedSpace}
          query={query} action={action} connected={connected} busy={busy} mode={mode} onReview={openDocumentReview} onSelectFolder={selectDocumentFolder} theme={resolvedTheme}
          createRequested={params.get('new') === '1'} onCreateClosed={() => {
            const path = route.startsWith('/spaces/') ? route.split('?')[0] : '/spaces';
            history.replaceState(history.state, '', `#${path}`);
            setRoute(path);
          }}/>}
        {retainedLifetimePath && <div hidden={!lifetimeVisible} className={lifetimeVisible ? "flex flex-col" : undefined}>{lifetimeScreen(retainedLifetimePath)}</div>}
        {!knownSections[section] && !(section === 'lifetime' && lifetimeEnabled) && <EmptyState icon={<CircleAlert/>} title="이 화면을 찾을 수 없습니다" description="주소가 이동했거나 잘못되었을 수 있습니다."
          action={<Button variant="outline" onClick={() => navigate('/')}>홈으로</Button>}/>}
      </>}
    </AppFrame>
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
    {dialog === 'add' && <Modal title="새 Ghost" onClose={close}>
      <form className="grid gap-4" onSubmit={e => { e.preventDefault(); createGhost(new FormData(e.currentTarget)); }}>
        <FormField label="이름" description="영문, 숫자, 밑줄과 하이픈을 사용할 수 있습니다." required>
          {control => <Input {...control} name="name" placeholder="예: Scout" required maxLength={64} pattern="[A-Za-z0-9_-]+" autoComplete="off"/>}
        </FormField>
        <FormField label={primaryChat ? '역할 메모' : uiTerms.roleInstructions} required>
          {control => <Textarea {...control} name="persona" placeholder={primaryChat ? '예: 여행 자료와 참고 문헌 정리' : '자료를 조사하고, 확인한 근거와 함께 요약합니다.'} required maxLength={4096} rows={3}/>}
        </FormField>
        {formError && <InlineError>{formError}</InlineError>}
        <Button type="submit" className="justify-self-end" disabled={busy || !connected}>{busy ? '만드는 중…' : '만들기'}</Button>
      </form>
    </Modal>}
    {approval && snapshot?.workspace_id === approval.workspaceId && <ApprovalDrawer
      selected={approval.ref} snapshot={snapshot} connected={!error} busy={busy} action={action} query={query}
      onClose={closeApproval} onOpenConversation={openApprovalConversation}/>}
    {preferences.companion && section !== 'settings' && <FloatingPet profile={snapshot?.profiles.find(p => p.id === preferences.companionProfile) ?? snapshot?.profiles[0]} onOpen={() => { const p = snapshot?.profiles.find(p => p.id === preferences.companionProfile) ?? snapshot?.profiles[0]; if (p) navigate(`/ghosts/${p.id}`); }} onHide={() => updatePreferences({ companion: false })}/>}
  </AvatarProvider></PortraitAppearances.Provider></div>;
}
