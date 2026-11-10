import { useEffect, useRef, useState } from 'react';
import { BriefcaseBusiness, CircleAlert, Clock3, KeyRound, MonitorSmartphone, PlugZap, RefreshCw, Repeat2, Server, Smartphone, Users } from 'lucide-react';
import { DutySwitch } from './components/DutySwitch';
import { DutySettings } from './features/DutySettings';
import { Banner, Button, EmptyState, ScrollRails, Skeleton, type CommandItem } from './ui';
import type { Ghost, State } from '@ghost/contract';
import { AppFrame } from './components/AppFrame';
import { TitleNav } from './components/TitleNav';
import { crumbsFor } from './features/crumbs';
import { useHistoryNav } from './features/historyNav';
import { ActivityIsland, glyphLabel, workGlyph } from './components/agent';
import { PortraitAppearances } from './components/DotAvatar';
import { Settings, type SettingsSection } from './pets/Settings';
import { AvatarProvider } from './pets/AvatarProvider';
import { usePreferences } from './pets/preferences';
import { HostProvider, useHost } from './host/context';
import { useHostState } from './host/store';
import { liveWorks, pendingDecisions, visibleGhosts } from './features/ghostState';
import { decisionHeading } from './features/decisionText';
import { isMac } from './ui/keys';
import { hostStatus } from './features/hostStatus';
import { Overview } from './features/Overview';
import { GhostChat } from './features/GhostChat';
import { Conversations } from './features/Conversations';
import { WorkView } from './features/WorkViews';
import { Goals } from './features/goals/Goals';
import { WorkDetail } from './features/WorkDetail';
import { InboxView } from './features/Inbox';
import { HostView } from './features/HostView';
import { GhostSettings } from './features/GhostSettings';
import { MobilePairing } from './features/MobilePairing';
import { VaultView } from './features/VaultView';
import { MailView } from './features/mail/MailView';
import { Schedules } from './features/Schedules';
import { Activities } from './features/Activities';
import { Connections } from './features/Connections';
import { SpacesView } from './features/SpacesView';
import { UpdatePrompt } from './features/UpdatePrompt';
import { UpdateSettings } from './features/UpdateSettings';
import { useUpdate } from './features/update/useUpdate';
import { routeLabels, uiTerms } from './uiText';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { installWindowDrag } from './host/windowDrag';
import { initializeDesktopCompanion, isDesktopShell } from './host/desktop';
import DesktopAvatarSettings from './features/DesktopAvatarSettings';
import { onShellEvent, ready, shell, shellCall, type ShellEvent } from './host/shell';
import { useVisibleViewport } from './host/viewport';
import { notificationRoute } from './features/notificationRoute';
import { useCompact } from './ui/adaptive';
import './ui/mobile.css';

// Tauri 웹뷰는 모든 내비게이션에 __TAURI_INTERNALS__를 주입한다. 데스크톱 창에서만 끌 수 있는 타이틀바를 그린다.
const desktopShell = isDesktopShell();
const desktopMac = desktopShell && /Mac/.test(navigator.platform);
if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-desktop-shell', desktopShell);
if (desktopShell) {
  const tauri = (window as unknown as { __TAURI_INTERNALS__: { invoke(command: string): Promise<unknown> } }).__TAURI_INTERNALS__;
  installWindowDrag(command => tauri.invoke(command));
}

const currentRoute = () => location.hash.replace(/^#/, '').replace(/^\/dots\//, '/ghosts/') || '/';

export function App() {
  return <HostProvider><Shell/><ScrollRails/></HostProvider>;
}

function Shell() {
  const { store, client } = useHost();
  const update = useUpdate(client);
  const { state, connection, error } = useHostState(store);
  const { preferences, resolvedTheme, updatePreferences, storageError } = usePreferences();
  useVisibleViewport();
  const compact = useCompact();
  const [route, setRoute] = useState(currentRoute);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [desktopError, setDesktopError] = useState('');
  // The shell owns whether the desktop Ghost is shown; mirror it into the shared preference once.
  useEffect(() => {
    if (desktopShell) void initializeDesktopCompanion().catch(reason => setDesktopError(reason instanceof Error ? reason.message : '데스크톱 아바타를 준비하지 못했습니다.'));
  }, []);
  // The main region owns scrolling; a new destination starts at its top.
  const resetScroll = () => { document.getElementById('main-content')?.scrollTo(0, 0); };
  useEffect(() => { const change = () => setRoute(currentRoute()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  const historyNav = useHistoryNav();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); location.hash = '/settings'; }
      // ⌘K/Ctrl+K belongs to the command palette, which binds it itself.
      // ⌘[ / ⌘] (Ctrl elsewhere) walk history, except where text editing owns them (indent in the document editor).
      // An open modal owns the page under it: walking history there would unmount what the dialog belongs to.
      const editing = (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"], .cm-editor'))
        || document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
      if ((e.metaKey || e.ctrlKey) && !editing && (e.key === '[' || e.key === ']')) { e.preventDefault(); if (e.key === '[') history.back(); else history.forward(); }
      // Windows and Linux owners expect Alt+←/→ for back and forward; on macOS Option+arrow moves by word.
      if (!isMac && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !editing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); if (e.key === 'ArrowLeft') history.back(); else history.forward(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  // A ?new=1 creator, once closed or done, drops the flag in place: Back must not land on it and reopen the form.
  const clearCreateRequest = () => {
    const next = currentRoute().replace(/([?&])new=1(&|$)/, (_, lead: string, tail: string) => tail ? lead : '').replace(/[?&]$/, '');
    history.replaceState(history.state, '', `#${next}`);
    setRoute(next);
  };
  const navigate = (path: string) => { resetScroll(); if (currentRoute() !== path) historyNav.push(`#${path}`); setRoute(path); };
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    if (!shell) return;
    const queued = new Set<string>();
    const drain = () => {
      const current = store.get().state;
      if (!current) return;
      for (const id of queued) {
        const item = current.notifications.find(entry => entry.id === id);
        if (!item) continue;
        queued.delete(id);
        if (!item.readAt) void client.send({ type: 'notification.read', notificationIds: [id] }).catch(() => {});
        const destination = notificationRoute(item, current);
        if (destination) navigateRef.current(destination);
      }
    };
    const handle = (event: ShellEvent) => {
      if (event.type === 'resume') store.refresh();
      else { queued.add(event.notificationId); drain(); }
    };
    const unsubscribe = onShellEvent(handle);
    const unsubscribeStore = store.subscribe(drain);
    void ready(handle).catch(reason => console.error('Ghost 셸을 준비하지 못했습니다.', reason));
    return () => { unsubscribe(); unsubscribeStore(); };
  }, [store, client]);
  useEffect(() => {
    if (shell) void shellCall({ type: 'theme', scheme: resolvedTheme }).catch(() => {});
  }, [resolvedTheme]);
  const [path, query = ''] = route.split('?');
  const params = new URLSearchParams(query);
  const section = path.split('/')[1]?.split('?')[0] || 'home';
  useEffect(() => {
    if (section === 'workspace' && !compact) {
      history.replaceState(history.state, '', '#/');
      setRoute('/');
      document.getElementById('main-content')?.scrollTo(0, 0);
    }
  }, [compact, section]);

  const ghosts = state?.ghosts ?? [];
  const defaultGhost = ghosts.find(ghost => ghost.isDefault) ?? null;
  const attentionCount = state ? pendingDecisions(state).length : 0;
  const status = hostStatus(connection, Boolean(state));

  // Ghost pages: the ghost on screen and the conversation on screen.
  const ghostSegment = section === 'ghosts' ? path.split('/')[2] : null;
  const openGhost = ghostSegment ? ghosts.find(ghost => encodeURIComponent(ghost.id) === ghostSegment) ?? null : null;
  const routeConversationId = params.get('conversation');
  const switchGhost = (id: string) => navigate(`/ghosts/${encodeURIComponent(id)}`);

  const selectedSpace = section === 'spaces' ? path.split('/')[2] : undefined;
  const ownsGeometry = section === 'settings' || section === 'ghosts' || section === 'workspace' || section === 'mail';

  const go = (target: string) => () => navigate(target);
  const ghostName = (id: string) => ghosts.find(ghost => ghost.id === id)?.name ?? 'Ghost';
  // Searchable by title: what waits on the owner opens in 확인할 일, live Work opens its own page.
  const decisionItems: CommandItem[] = state ? pendingDecisions(state).sort((a, b) => a.createdAt - b.createdAt).map(decision => ({
    id: `decision:${decision.id}`, label: decisionHeading(decision, state), group: uiTerms.inbox,
    description: ghostName(decision.ghostId), keywords: [ghostName(decision.ghostId)],
    onSelect: go(`/inbox?decision=${encodeURIComponent(decision.id)}`),
  })) : [];
  const waitingWorks = new Set(state ? pendingDecisions(state).map(decision => decision.workId).filter(Boolean) : []);
  const workItems: CommandItem[] = state ? liveWorks(state).map(work => ({
    id: `work:${work.id}`, label: work.title, group: uiTerms.work,
    description: `${ghostName(work.ghostId)} · ${glyphLabel[workGlyph(work.state, waitingWorks.has(work.id))]}`, keywords: [ghostName(work.ghostId)],
    onSelect: go(`/work/${encodeURIComponent(work.id)}`),
  })) : [];
  const commandItems: CommandItem[] = state ? [
    { id: 'new-work', label: '일 맡기기', group: '실행', onSelect: go('/work?new=1') },
    { id: 'new-ghost', label: '새 Ghost', group: '실행', onSelect: go('/settings?tab=team&new=1') },
    { id: 'new-space', label: '새 프로젝트', group: '실행', onSelect: go('/spaces?new=1') },
    { id: 'home', label: routeLabels.home, group: '이동', onSelect: go('/') },
    { id: 'inbox', label: uiTerms.inbox, group: '이동', onSelect: go('/inbox') },
    { id: 'work', label: uiTerms.work, group: '이동', onSelect: go('/work') },
    { id: 'mail', label: '메일', group: '이동', onSelect: go('/mail') },
    { id: 'goals', label: uiTerms.goals, group: '이동', onSelect: go('/goals') },
    { id: 'spaces', label: routeLabels.spaces, group: '이동', onSelect: go('/spaces') },
    ...visibleGhosts(ghosts).map(ghost => ({ id: `ghost:${ghost.id}`, label: ghost.name, description: ghost.isDefault ? '메인 Ghost' : undefined, group: 'Ghost', onSelect: () => switchGhost(ghost.id) })),
    ...state.spaces.map(space => ({ id: `space:${space.id}`, label: space.name, group: '프로젝트', onSelect: () => navigate(`/spaces/${space.id}`) })),
    ...decisionItems,
    ...workItems,
    { id: 'team', label: uiTerms.ghostSettings, group: '설정', onSelect: go('/settings?tab=team') },
    { id: 'duty', label: '근무 시간', group: '설정', onSelect: go('/settings?tab=duty') },
    { id: 'vault', label: '금고', group: '설정', onSelect: go('/settings?tab=vault') },
    { id: 'devices', label: '기기', group: '설정', onSelect: go('/settings?tab=devices') },
    { id: 'schedules', label: uiTerms.schedules, group: '설정', onSelect: go('/settings?tab=schedules') },
    { id: 'activities', label: uiTerms.activities, group: '설정', onSelect: go('/settings?tab=activities') },
    { id: 'connections', label: uiTerms.connections, group: '설정', onSelect: go('/settings?tab=connections') },
    { id: 'host', label: routeLabels.host, group: '설정', onSelect: go('/settings?tab=host') },
    { id: 'update', label: '업데이트', group: '설정', onSelect: go('/settings?tab=update') },
    { id: 'settings', label: uiTerms.settings, group: '설정', onSelect: go('/settings') },
  ] : [];

  // The Ghost's look is the one source of portrait color and variation; the pets draw from it through DotAvatar.
  const portraits = Object.fromEntries(ghosts.map(ghost => [ghost.id, { body: ghost.look.body, shape: ghost.look.shape, face: ghost.look.face, mark: ghost.look.mark }]));

  const settingsSections: SettingsSection[] = [
    { id: 'team', label: 'Ghost', icon: Users, content: <GhostSettings onChat={switchGhost}
      onSelect={id => navigate(`/settings?tab=team&ghost=${encodeURIComponent(id)}`)}
      selectedGhostId={params.get('ghost') ?? undefined} createRequested={params.get('new') === '1'} onCreateClosed={clearCreateRequest}/> },
    { id: 'duty', label: '근무 시간', icon: BriefcaseBusiness, content: <DutySettings/> },
    { id: 'vault', label: '금고', icon: KeyRound, content: <VaultView/> },
    { id: 'devices', label: '기기', icon: Smartphone, content: <MobilePairing/> },
    { id: 'schedules', label: uiTerms.schedules, icon: Clock3, content: <Schedules/> },
    { id: 'activities', label: uiTerms.activities, icon: Repeat2, content: <Activities navigate={navigate}/> },
    { id: 'connections', label: uiTerms.connections, icon: PlugZap, content: <Connections/> },
    { id: 'host', label: routeLabels.host, icon: Server, content: <HostView/> },
    { id: 'update', label: '업데이트', icon: RefreshCw, content: <UpdateSettings monitor={update}/> },
    ...(desktopShell ? [{ id: 'desktop', label: '데스크톱 아바타', icon: MonitorSmartphone, content: <>
      {desktopError && <Banner variant="warning" className="mb-4">{desktopError}</Banner>}
      <DesktopAvatarSettings/>
    </> }] : []),
  ];

  const ghostNotFound = <EmptyState icon={<CircleAlert/>} title="이 Ghost를 찾을 수 없습니다" action={<Button variant="outline" onClick={() => navigate('/')}>홈으로</Button>}/>;
  const knownSections: Record<string, true> = { home: true, conversations: true, ghosts: true, spaces: true, inbox: true, work: true, mail: true, goals: true, settings: true, workspace: true };

  const runtimeDown = Boolean(state && !state.runtime.ready);
  const sidebar = <WorkspaceSidebar state={state} section={section} openGhostId={openGhost?.id ?? null}
    selectedSpace={params.has('new') ? undefined : selectedSpace} attentionCount={attentionCount}
    status={status} navigate={navigate} openGhost={switchGhost}/>;

  return <div className="ghost-root">
    <PortraitAppearances.Provider value={portraits}>
      <AvatarProvider animate={preferences.animate}>
        <AppFrame desktop={desktopShell} macOSInset={desktopMac ? 80 : 0}
          section={section} attentionCount={attentionCount} navigate={navigate}
          hideDock={section === 'ghosts' || (section === 'work' && Boolean(path.split('/')[2])) || (section === 'settings' && params.has('tab'))}
          location={<TitleNav crumbs={crumbsFor(route, state)} canBack={historyNav.canBack} canForward={historyNav.canForward}
            compactBack={section === 'settings' && params.has('tab') ? '/settings'
              : section === 'ghosts' ? crumbsFor(route, state).at(-2)?.path ?? '/conversations'
              : section === 'work' && path.split('/')[2] ? '/work'
              : section === 'spaces' && selectedSpace ? '/workspace' : undefined}
            onBack={historyNav.back} onForward={historyNav.forward} navigate={navigate}/>}
          island={state && <ActivityIsland state={state} navigate={navigate}/>}
          duty={state && <DutySwitch state={state}/>}
          sidebar={sidebar} fill={ownsGeometry} commands={commandItems} paletteOpen={paletteOpen} onPaletteOpenChange={setPaletteOpen}>
          {error && <Banner variant="danger" className="mb-4" action={<Button variant="outline" onClick={() => store.refresh()}>다시 연결</Button>}>{error}</Banner>}
          <UpdatePrompt monitor={update} navigate={navigate}/>
          {runtimeDown && state && section !== 'home' && <Banner variant="warning" className="mb-4" action={<Button variant="outline" onClick={() => navigate('/settings?tab=models')}>모델 설정</Button>}>{`Ghost가 지금 대화를 실행할 수 없습니다. ${state.runtime.detail}`}</Banner>}
          {!state ? <div className="grid gap-3 p-8" aria-busy={!error}><Skeleton className="h-7 w-48"/><Skeleton className="h-4 w-72"/><Skeleton className="h-24 w-full"/></div> : <>
            {section === 'home' && <Overview state={state} navigate={navigate}/>}
            {section === 'conversations' && <Conversations ghosts={ghosts} openGhost={switchGhost}/>}
            {section === 'workspace' && compact && <div className="workspace-page">{sidebar}</div>}
            {section === 'inbox' && <InboxView state={state} navigate={navigate} focusDecisionId={params.get('decision')}/>}
            {section === 'mail' && <MailView/>}
            {section === 'goals' && <Goals state={state} navigate={navigate}/>}
            {section === 'work' && (path.split('/')[2]
              ? <WorkDetail state={state} workId={decodeURIComponent(path.split('/')[2])} navigate={navigate}/>
              : <WorkView state={state} navigate={navigate} filterGhostId={params.get('ghost')} createRequested={params.get('new') === '1'} onCreateClosed={clearCreateRequest}/>)}
            {section === 'ghosts' && (openGhost
              ? <GhostChat key={`${openGhost.id}:${routeConversationId ?? openGhost.directConversationId ?? 'new'}:${params.get('space') ?? ''}`} ghost={openGhost} state={state} conversationId={routeConversationId ?? openGhost.directConversationId} threadId={params.get('thread')} navigate={navigate} initialSpaceIds={params.getAll('space').slice(0, 8)}/>
              : ghostNotFound)}
            {section === 'spaces' && <SpacesView key={`${selectedSpace ?? 'empty'}:${params.get('new') ?? ''}`} selectedSpace={selectedSpace} navigate={navigate}
              onSelectSpace={id => navigate(`/spaces/${id}`)} createRequested={params.get('new') === '1'}
              onCreateClosed={() => {
                const next = path.startsWith('/spaces/') ? path : '/spaces';
                history.replaceState(history.state, '', `#${next}`);
                setRoute(next);
              }}/>}
            {section === 'settings' && <Settings route={route} navigate={navigate} preferences={preferences} updatePreferences={updatePreferences} storageError={storageError} sections={settingsSections}/>}
            {!knownSections[section] && <EmptyState icon={<CircleAlert/>} title="이 화면을 찾을 수 없습니다" description="주소가 이동했거나 잘못되었을 수 있습니다."
              action={<Button variant="outline" onClick={() => navigate('/')}>홈으로</Button>}/>}
          </>}
        </AppFrame>
      </AvatarProvider>
    </PortraitAppearances.Provider>
  </div>;
}
