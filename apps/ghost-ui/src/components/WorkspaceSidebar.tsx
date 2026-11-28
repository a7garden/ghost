import { useEffect, useId, useRef, type RefObject } from 'react';
import { Bot, Box, Compass, Folder, Home, Inbox, LayoutList, Mail, Plus, Settings2 } from 'lucide-react';
import { Navigation, NavigationGroup, NavigationItem, ScrollRail } from '../ui';
import type { Ghost, Scope, State } from '@ghost/contract';
import { ghostPresence, idlePresence, liveWork, visibleGhosts } from '../features/ghostState';
import type { Attention } from '../features/WorkbenchAttention';
import { AttentionMark } from '../features/WorkbenchPane';
import { workbenchPath } from '../features/workbenchRoute';
import { ghostAddPath, newProjectPath } from '../features/ghostRoutes';
import { PresenceAvatar } from './agent';
import { RosterGhostMenu } from './RosterGhostMenu';
import { routeLabels, uiTerms } from '../uiText';
import type { HostStatus } from '../features/hostStatus';
import '../features/Roster.css';

/**
 * Destinations stay put; Ghosts and projects scroll beneath the sticky labels. The main Ghost leads on its own,
 * then the installed Ghosts under one 「Ghost」 label whose + installs another. Each Ghost's projects sit beneath it.
 */
export function WorkspaceSidebar({ state, section, openGhostId, selectedScope, projectSignals, attentionCount, status, navigate, openGhost }: {
  state: State | null;
  section: string;
  /** Ghost whose conversation is on screen; null on workspace pages. */
  openGhostId: string | null;
  /** Project on screen: null is the unscoped workbench, undefined means no selected project. */
  selectedScope?: string | null;
  projectSignals?: ReadonlyMap<string | null, Attention | undefined>;
  attentionCount: number;
  status: HostStatus;
  navigate(path: string): void;
  openGhost(id: string): void;
}) {
  const hostStatusId = useId();
  const scopes = state?.scopes ?? [];
  let live = 0;
  const counts = new Map<string, number>();
  for (const work of state?.works ?? []) {
    if (!liveWork(work)) continue;
    live++;
    counts.set(work.ghostId, (counts.get(work.ghostId) ?? 0) + 1);
  }
  const hostTrouble = status.state !== 'connected' && !status.quiet;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useScrollEdges(scrollRef, contentRef);
  // Opening a Ghost from elsewhere (a card, search) brings its row into view.
  useEffect(() => {
    if (!openGhostId) return;
    scrollRef.current?.querySelector<HTMLElement>('.presence-row__main[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
  }, [openGhostId]);
  // Removed Ghosts leave the roster.
  const roster = visibleGhosts(state?.ghosts ?? []);
  const byGhost = projectsByReceiver(scopes, roster);
  const main = roster.find(ghost => ghost.isDefault);
  const installed = roster.filter(ghost => !ghost.isDefault);
  const presence = new Map(roster.map(ghost => [ghost.id, state ? ghostPresence(ghost, state) : idlePresence]));

  const row = (ghost: Ghost) => {
    const now = presence.get(ghost.id)!;
    const working = counts.get(ghost.id) ?? 0;
    const open = () => openGhost(ghost.id);
    return <div className="sidebar-entry__head">
      <RosterGhostMenu ghost={ghost} onOpen={open} navigate={navigate}>
        <button type="button" className="presence-row__main" data-tone={now.state}
          data-dimmed={ghost.state === 'paused' && now.state === 'idle' ? '' : undefined}
          aria-current={ghost.id === openGhostId ? 'page' : undefined} onClick={open}
          data-rail={now.state !== 'idle' || ghost.id === openGhostId ? 'ghost' : undefined}
          data-rail-tone={now.state === 'attention' ? 'amber' : now.state === 'working' ? 'signal' : ghost.id === openGhostId ? 'muted' : undefined}
          data-rail-label={now.line ? `${ghost.name} · ${now.line}` : ghost.name}>
          <PresenceAvatar ghostId={ghost.id} state={now.state} size={26}/>
          <span className="presence-row__copy">
            <span className="presence-row__name"><span className="truncate">{ghost.name}</span>{ghost.isDefault && installed.length > 0 && <span className="presence-row__main-mark">메인</span>}</span>
            {now.line ? <span className="presence-row__line" data-tone={now.state}>{now.line}</span>
              : ghost.state === 'paused' && <span className="presence-row__line">일시 중지</span>}
          </span>
          {working > 0 && <span className="sidebar-count"><span className="sr-only">맡긴 일 진행 중 </span>{working}</span>}
        </button>
      </RosterGhostMenu>
      <button type="button" className="sidebar-entry__add" aria-label={`${ghost.name}의 새 프로젝트`} title="새 프로젝트"
        onClick={() => navigate(newProjectPath(ghost.id))}><Plus aria-hidden="true"/></button>
    </div>;
  };

  const projectList = { selectedScope, signals: projectSignals, coding: section === 'coding', navigate };
  /** A Ghost row followed by the projects it receives. */
  const entry = (ghost: Ghost) => {
    const owned = byGhost.get(ghost.id);
    return <div key={ghost.id} className="sidebar-entry">
      {row(ghost)}
      {(owned || (ghost.isDefault && section === 'coding')) && <SidebarProjectList {...projectList} scopes={owned ?? []} receiver={ghost.name} showUnscoped={ghost.isDefault}/>}
    </div>;
  };

  return <>
    <Navigation label="작업실" className="ghost-sidebar min-h-0 flex-1">
      <div className="sidebar-primary">
        <NavigationItem current={section === 'home'} onClick={() => navigate('/')}>
          <Home/><span className="flex-1">{routeLabels.home}</span>
        </NavigationItem>
        <NavigationItem current={section === 'inbox'} onClick={() => navigate('/inbox')}>
          <Inbox/><span className="flex-1">{uiTerms.inbox}</span>
          {attentionCount > 0 && <span className="sidebar-count" data-tone="amber"><span className="sr-only">확인 필요 </span>{attentionCount}</span>}
        </NavigationItem>
        <NavigationItem current={section === 'work'} onClick={() => navigate('/work')}>
          <LayoutList/><span className="flex-1">{uiTerms.work}</span>
          {live > 0 && <span className="sidebar-count"><span className="sr-only">진행 중 </span>{live}</span>}
        </NavigationItem>
      </div>
      <div className="sidebar-scroll-frame">
        <div ref={scrollRef} className="sidebar-scroll">
          <div ref={contentRef}>
            {main && <div className="sidebar-main">{entry(main)}</div>}
            {state && <NavigationGroup label={routeLabels.ghosts} className="sidebar-ghosts"
              action={installed.length > 0 && <button type="button" className="sidebar-group-action" aria-label="Ghost 추가" title="Ghost 추가"
                onClick={() => navigate(ghostAddPath)}><Plus size={14} aria-hidden="true"/></button>}>
              {installed.map(entry)}
              {installed.length === 0 && <NavigationItem className="sidebar-add-ghost" onClick={() => navigate(ghostAddPath)}>
                <Plus/><span>Ghost 추가</span>
              </NavigationItem>}
            </NavigationGroup>}
          </div>
        </div>
        <ScrollRail viewportRef={scrollRef} contentRef={contentRef}/>
      </div>
      <div className="sidebar-tools">
        <NavigationItem current={section === 'coding'} onClick={() => navigate('/coding')}>
          <Bot/><span>{routeLabels.coding}</span>
        </NavigationItem>
        <NavigationItem current={section === 'mail'} onClick={() => navigate('/mail')}>
          <Mail/><span>{routeLabels.mail}</span>
        </NavigationItem>
        <NavigationItem current={section === 'goals'} onClick={() => navigate('/goals')}>
          <Compass/><span>{uiTerms.goals}</span>
        </NavigationItem>
      </div>
    </Navigation>
    <div className="sidebar-foot">
      <NavigationItem className="w-full" current={section === 'settings'} aria-describedby={hostTrouble ? hostStatusId : undefined}
        onClick={() => navigate(hostTrouble ? '/settings?tab=host' : '/settings')}>
        <Settings2/><span className="flex-1">설정</span>
        {hostTrouble && <span className="sidebar-count" data-tone={status.state === 'offline' ? 'danger' : 'amber'} id={hostStatusId}>{status.label}</span>}
      </NavigationItem>
    </div>
  </>;
}

export function SidebarProjectGroup({ navigate, children }: { navigate(path: string): void; children: React.ReactNode }) {
  return <NavigationGroup label={routeLabels.scopes}
    action={<button type="button" aria-label="새 프로젝트" title="새 프로젝트" onClick={() => navigate('/scopes?new=1')} className="sidebar-group-action"><Plus size={14} aria-hidden="true"/></button>}>
    {children}
  </NavigationGroup>;
}

/** The project's navigation rows are shared by the workspace sidebar and the phone's project sheet. */
export function SidebarProjectList({ scopes, receiver, coding, selectedScope, signals, showUnscoped, navigate }: {
  scopes: readonly Scope[];
  receiver?: string;
  coding: boolean;
  selectedScope?: string | null;
  signals?: ReadonlyMap<string | null, Attention | undefined>;
  showUnscoped?: boolean;
  navigate(path: string): void;
}) {
  return <div className="sidebar-projects" role={receiver ? 'group' : undefined} aria-label={receiver ? `${receiver}의 프로젝트` : undefined}>
    {scopes.map(scope => <NavigationItem key={scope.id} className={receiver ? 'sidebar-project sidebar-project--nested' : 'sidebar-project'}
      current={scope.id === selectedScope} onClick={() => navigate(coding ? workbenchPath(scope.id) : `/scopes/${encodeURIComponent(scope.id)}`)}>
      {!receiver && <Folder/>}<span className="truncate">{scope.name}</span>
      {scope.state === 'paused' && <span className="sidebar-project__paused">일시 중지</span>}
      {scope.id !== selectedScope && <AttentionMark signal={signals?.get(scope.id)}/>}
    </NavigationItem>)}
    {showUnscoped && coding && signals?.has(null) && <NavigationItem className="sidebar-project sidebar-project--unscoped"
      current={selectedScope === null} onClick={() => navigate(workbenchPath(null))}>
      <Box/><span>{uiTerms.noProject}</span>
      {selectedScope !== null && <AttentionMark signal={signals.get(null)}/>}
    </NavigationItem>}
  </div>;
}

/**
 * Each roster Ghost's projects, in project order. A project without a receiver, or whose receiver left the roster,
 * belongs to the main Ghost, as the Host routes it. With no main Ghost on the roster those projects are not listed.
 * Pure; tests pin it.
 */
export function projectsByReceiver(scopes: readonly Scope[], roster: readonly Ghost[]): Map<Ghost['id'], Scope[]> {
  const main = roster.find(ghost => ghost.isDefault)?.id;
  const onRoster = new Set(roster.map(ghost => ghost.id));
  const byGhost = new Map<Ghost['id'], Scope[]>();
  for (const scope of scopes) {
    const receiver = scope.ghostId !== null && onRoster.has(scope.ghostId) ? scope.ghostId : main;
    if (receiver === undefined) continue;
    const list = byGhost.get(receiver);
    if (list) list.push(scope); else byGhost.set(receiver, [scope]);
  }
  return byGhost;
}

/** Marks a scroller with `data-more-below` while content continues past its bottom edge. */
function useScrollEdges(ref: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const more = element.scrollTop + element.clientHeight < element.scrollHeight - 2;
      if (more) element.dataset.moreBelow = ''; else delete element.dataset.moreBelow;
    };
    const resize = new ResizeObserver(update);
    resize.observe(element);
    if (contentRef.current) resize.observe(contentRef.current);
    element.addEventListener('scroll', update, { passive: true });
    update();
    return () => { resize.disconnect(); element.removeEventListener('scroll', update); };
  }, [ref, contentRef]);
}
