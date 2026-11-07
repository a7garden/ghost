import { useEffect, useState } from 'react';
import { CircleAlert, Clock3, Server, Smartphone, Users } from 'lucide-react';
import { Banner, Button, EmptyState, Skeleton, type GCommandItem } from '@garden/ui';
import type { Ghost, State } from '@ghost/contract';
import { AppFrame } from './components/AppFrame';
import { PortraitAppearances } from './components/DotAvatar';
import { Settings, type SettingsSection } from './pets/Settings';
import { AvatarProvider } from './pets/AvatarProvider';
import { FloatingPet } from './pets/FloatingPet';
import { usePreferences } from './pets/preferences';
import { HostProvider, useHost } from './host/context';
import { useHostState } from './host/store';
import { pendingDecisions } from './features/ghostState';
import { hostStatus } from './features/hostStatus';
import { Overview } from './features/Overview';
import { GhostChat } from './features/GhostChat';
import { WorkView } from './features/WorkViews';
import { WorkDetail } from './features/WorkDetail';
import { InboxView } from './features/Inbox';
import { HostView } from './features/HostView';
import { TeamSettings } from './features/TeamSettings';
import { MobilePairing } from './features/MobilePairing';
import { Schedules } from './features/Schedules';
import { SpacesView } from './features/SpacesView';
import { routeLabels, uiTerms } from './uiText';
import type { GhostMenuItem } from './components/WorkspaceSidebar';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { installWindowDrag } from './host/windowDrag';

// Tauri 웹뷰는 모든 내비게이션에 __TAURI_INTERNALS__를 주입한다. 데스크톱 창에서만 끌 수 있는 타이틀바를 그린다.
const desktopShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !/iPhone|iPad/.test(navigator.userAgent);
const desktopMac = desktopShell && /Mac/.test(navigator.platform);
if (desktopShell) {
  const tauri = (window as unknown as { __TAURI_INTERNALS__: { invoke(command: string): Promise<unknown> } }).__TAURI_INTERNALS__;
  installWindowDrag(command => tauri.invoke(command));
}

const currentRoute = () => location.hash.replace(/^#/, '').replace(/^\/dots\//, '/ghosts/') || '/';

export function App() {
  return <HostProvider><Shell/></HostProvider>;
}

function Shell() {
  const { store } = useHost();
  const { state, connection, error } = useHostState(store);
  const { preferences, updatePreferences, storageError } = usePreferences();
  const [route, setRoute] = useState(currentRoute);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The main region owns scrolling; a new destination starts at its top.
  const resetScroll = () => { document.getElementById('main-content')?.scrollTo(0, 0); };
  useEffect(() => { const change = () => setRoute(currentRoute()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); location.hash = '/settings'; } if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setPaletteOpen(true); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  const navigate = (path: string) => { resetScroll(); if (currentRoute() !== path) history.pushState(null, '', `#${path}`); setRoute(path); };
  const [path, query = ''] = route.split('?');
  const params = new URLSearchParams(query);
  const section = path.split('/')[1]?.split('?')[0] || 'home';

  const ghosts = state?.ghosts ?? [];
  const defaultGhost = ghosts.find(ghost => ghost.isDefault) ?? null;
  const attentionCount = state ? pendingDecisions(state).length : 0;
  const status = hostStatus(connection, Boolean(state));

  // Ghost pages: the ghost on screen and the conversation on screen.
  const ghostSegment = section === 'ghosts' ? path.split('/')[2] : null;
  const openGhost = ghostSegment ? ghosts.find(ghost => encodeURIComponent(ghost.id) === ghostSegment) ?? null : null;
  const routeConversationId = params.get('conversation');
  const currentGhostPage = !openGhost ? null
    : routeConversationId && routeConversationId !== openGhost.directConversationId ? `conversation:${routeConversationId}` : 'chat';
  const ghostMenu = (ghost: Ghost): GhostMenuItem[] => [
    { key: 'work', label: uiTerms.work, path: `/work?ghost=${encodeURIComponent(ghost.id)}`, kind: 'work' as const },
    // The Ghost's own row is the main conversation; the submenu lists only older ones.
    ...(state?.conversations ?? [])
      .filter(conversation => conversation.ghostId === ghost.id && conversation.kind === 'direct' && conversation.id !== ghost.directConversationId)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 5)
      .map(conversation => ({ key: `conversation:${conversation.id}`, label: conversation.title || '대화', path: `/ghosts/${encodeURIComponent(ghost.id)}?conversation=${encodeURIComponent(conversation.id)}`, kind: 'history' as const })),
  ];
  const switchGhost = (id: string) => navigate(`/ghosts/${encodeURIComponent(id)}`);

  const selectedSpace = section === 'spaces' ? path.split('/')[2] : undefined;
  const ownsGeometry = section === 'settings' || section === 'ghosts';

  const go = (target: string) => () => navigate(target);
  const commandItems: GCommandItem[] = state ? [
    { id: 'home', label: routeLabels.home, group: '이동', onSelect: go('/') },
    { id: 'inbox', label: uiTerms.inbox, group: '이동', onSelect: go('/inbox') },
    { id: 'work', label: uiTerms.work, group: '이동', onSelect: go('/work') },
    { id: 'spaces', label: routeLabels.spaces, group: '이동', onSelect: go('/spaces') },
    ...ghosts.map(ghost => ({ id: `ghost:${ghost.id}`, label: ghost.name, description: ghost.isDefault ? '메인 Ghost' : undefined, group: 'Ghost', onSelect: () => switchGhost(ghost.id) })),
    ...state.spaces.map(space => ({ id: `space:${space.id}`, label: space.name, group: '프로젝트', onSelect: () => navigate(`/spaces/${space.id}`) })),
    { id: 'team', label: '팀', group: '설정', onSelect: go('/settings?tab=team') },
    { id: 'devices', label: '기기', group: '설정', onSelect: go('/settings?tab=devices') },
    { id: 'schedules', label: uiTerms.schedules, group: '설정', onSelect: go('/settings?tab=schedules') },
    { id: 'host', label: routeLabels.host, group: '설정', onSelect: go('/settings?tab=host') },
    { id: 'settings', label: uiTerms.settings, group: '설정', onSelect: go('/settings') },
  ] : [];

  // The Ghost's look is the one source of portrait colors; the pets draw from it through DotAvatar.
  const portraits = Object.fromEntries(ghosts.map(ghost => [ghost.id, { body: ghost.look.body, background: ghost.look.background }]));

  const companion = ghosts.find(ghost => ghost.id === preferences.companionProfile) ?? defaultGhost ?? ghosts[0] ?? null;

  const settingsSections: SettingsSection[] = [
    { id: 'team', label: '팀', icon: Users, content: <TeamSettings onChat={switchGhost}
      onManage={id => navigate(`/settings?tab=team&ghost=${encodeURIComponent(id)}`)} onPortrait={switchGhost}
      selectedGhostId={params.get('ghost') ?? undefined}/> },
    { id: 'devices', label: '기기', icon: Smartphone, content: <MobilePairing/> },
    { id: 'schedules', label: uiTerms.schedules, icon: Clock3, content: <Schedules/> },
    { id: 'host', label: routeLabels.host, icon: Server, content: <HostView/> },
  ];

  const ghostNotFound = <EmptyState icon={<CircleAlert/>} title="이 Ghost를 찾을 수 없습니다" action={<Button variant="outline" onClick={() => navigate('/')}>홈으로</Button>}/>;
  const knownSections: Record<string, true> = { home: true, ghosts: true, spaces: true, inbox: true, work: true, settings: true };

  const runtimeDown = Boolean(state && !state.runtime.ready);
  const sidebar = <WorkspaceSidebar state={state} section={section} openGhostId={openGhost?.id ?? null} ghostMenu={ghostMenu}
    currentGhostPage={currentGhostPage} selectedSpace={params.has('new') ? undefined : selectedSpace} attentionCount={attentionCount}
    status={status} navigate={navigate} openGhost={switchGhost}/>;

  return <div className="ghost-root">
    <PortraitAppearances.Provider value={portraits}>
      <AvatarProvider animate={preferences.animate}>
        <AppFrame desktop={desktopShell} macOSInset={desktopMac ? 80 : 0}
          location={pageLabel(section, openGhost, currentGhostPage, state?.spaces.find(space => space.id === selectedSpace)?.name ?? null)}
          sidebar={sidebar} fill={ownsGeometry} commands={commandItems} paletteOpen={paletteOpen} onPaletteOpenChange={setPaletteOpen}>
          {error && <Banner variant="danger" className="mb-4" action={<Button variant="outline" onClick={() => store.refresh()}>다시 연결</Button>}>{error}</Banner>}
          {runtimeDown && state && <Banner variant="warning" className="mb-4">{`Ghost가 지금 대화를 실행할 수 없습니다. ${state.runtime.detail}`}</Banner>}
          {!state ? <div className="grid gap-3 p-8" aria-busy={!error}><Skeleton className="h-7 w-48"/><Skeleton className="h-4 w-72"/><Skeleton className="h-24 w-full"/></div> : <>
            {section === 'home' && <Overview state={state} navigate={navigate} onOpenGhost={switchGhost}/>}
            {section === 'inbox' && <InboxView state={state} navigate={navigate} focusDecisionId={params.get('decision')}/>}
            {section === 'work' && (path.split('/')[2]
              ? <WorkDetail state={state} workId={decodeURIComponent(path.split('/')[2])} navigate={navigate}/>
              : <WorkView state={state} navigate={navigate} filterGhostId={params.get('ghost')}/>)}
            {section === 'ghosts' && (openGhost
              ? <GhostChat key={`${openGhost.id}:${routeConversationId ?? openGhost.directConversationId ?? 'new'}`} ghost={openGhost} state={state} conversationId={routeConversationId ?? openGhost.directConversationId} navigate={navigate}/>
              : ghostNotFound)}
            {section === 'spaces' && <SpacesView key={`${selectedSpace ?? 'empty'}:${params.get('new') ?? ''}`} selectedSpace={selectedSpace}
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
        {preferences.companion && section !== 'settings' && companion && <FloatingPet ghost={{ id: companion.id, name: companion.name }}
          onOpen={() => switchGhost(companion.id)} onHide={() => updatePreferences({ companion: false })}/>}
      </AvatarProvider>
    </PortraitAppearances.Provider>
  </div>;
}

function pageLabel(section: string, openGhost: { name: string } | null, currentGhostPage: string | null, spaceName: string | null): string {
  if (openGhost && currentGhostPage) {
    const suffix = currentGhostPage === 'chat' ? null : currentGhostPage === 'work' ? uiTerms.work : '대화';
    return suffix ? `${openGhost.name} · ${suffix}` : openGhost.name;
  }
  if (spaceName) return spaceName;
  return (routeLabels[section as keyof typeof routeLabels] as string | undefined) ?? '찾을 수 없는 화면';
}
