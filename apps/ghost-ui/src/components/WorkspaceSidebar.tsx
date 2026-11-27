import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Bot, Compass, Folder, Home, Inbox, LayoutList, Mail, Plus, Settings2 } from 'lucide-react';
import { Navigation, NavigationGroup, NavigationItem, ScrollRail } from '../ui';
import type { Ghost, Scope, State } from '@ghost/contract';
import { ghostPresence, idlePresence, liveWork, visibleGhosts } from '../features/ghostState';
import { useSidebarPreferences } from '../features/sidebarPreferences';
import { PresenceAvatar } from './agent';
import { RosterGhostMenu } from './RosterGhostMenu';
import { routeLabels, uiTerms } from '../uiText';
import type { HostStatus } from '../features/hostStatus';
import { blurTouchSearchOnEnter } from '../ui/adaptive';
import '../features/Roster.css';

const FOLD_LIMIT = 8;

/**
 * Destinations stay put; Ghosts and projects scroll beneath the sticky labels. The default
 * and pins lead one roster. On long rosters only the pool folds, leaving active Ghosts,
 * the open conversation, and project receivers in view. Projects sit under their receiver.
 */
export function WorkspaceSidebar({ state, section, openGhostId, selectedScope, attentionCount, status, navigate, openGhost }: {
  state: State | null;
  section: string;
  /** Ghost whose conversation is on screen; null on workspace pages. */
  openGhostId: string | null;
  /** Project on screen; null while the create form is open. */
  selectedScope?: string;
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
  const poolId = useId();
  useScrollEdges(scrollRef, contentRef);
  // Opening a Ghost from elsewhere (a card, search) brings its row into view.
  useEffect(() => {
    if (!openGhostId) return;
    scrollRef.current?.querySelector<HTMLElement>('.presence-row__main[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
  }, [openGhostId]);
  // Deleted and retired Ghosts leave the roster.
  const roster = visibleGhosts(state?.ghosts ?? []);
  const { byGhost, orphans } = projectsByReceiver(scopes, roster);
  const onlyMain = roster.length === 1 && roster[0]?.isDefault;
  const { pinned, expanded, togglePinned, setExpanded } = useSidebarPreferences(roster.map(ghost => ghost.id));
  const [query, setQuery] = useState('');
  const presence = new Map(roster.map(ghost => [ghost.id, state ? ghostPresence(ghost, state) : idlePresence]));
  const byId = new Map(roster.map(ghost => [ghost.id, ghost]));
  const pinnedIds = new Set(pinned);
  const main = roster.find(ghost => ghost.isDefault);
  const fixed = main ? [main] : [];
  for (const id of pinned) {
    const ghost = byId.get(id);
    if (ghost && !ghost.isDefault) fixed.push(ghost);
  }
  const pool = roster.filter(ghost => !ghost.isDefault && !pinnedIds.has(ghost.id));
  const foldable = roster.length > FOLD_LIMIT && pool.length > 0;
  // Never fold away the Ghost on screen, one with live activity, or the receiver of a project.
  const shownPool = !foldable || expanded ? pool : pool.filter(ghost =>
    ghost.id === openGhostId || presence.get(ghost.id)!.state !== 'idle' || byGhost.has(ghost.id));
  const needle = query.trim().toLowerCase();
  const filteredPool = shownPool.filter(ghost => !foldable || !expanded || !needle || ghost.name.toLowerCase().includes(needle)
    || ghost.persona.split('\n')[0]!.toLowerCase().includes(needle)
    || (byGhost.get(ghost.id) ?? []).some(scope => scope.name.toLowerCase().includes(needle)));

  const row = (ghost: Ghost) => {
    const now = presence.get(ghost.id)!;
    const working = counts.get(ghost.id) ?? 0;
    const open = () => openGhost(ghost.id);
    return <RosterGhostMenu ghost={ghost} pinned={pinnedIds.has(ghost.id)} togglePinned={togglePinned} onOpen={open} navigate={navigate}>
      <button type="button" className="presence-row__main" data-tone={now.state}
        data-dimmed={ghost.state === 'paused' && now.state === 'idle' ? '' : undefined}
        aria-current={ghost.id === openGhostId ? 'page' : undefined} onClick={open}
        data-rail={now.state !== 'idle' || ghost.id === openGhostId ? 'ghost' : undefined}
        data-rail-tone={now.state === 'attention' ? 'amber' : now.state === 'working' ? 'signal' : ghost.id === openGhostId ? 'muted' : undefined}
        data-rail-label={now.line ? `${ghost.name} · ${now.line}` : ghost.name}>
        <PresenceAvatar ghostId={ghost.id} state={now.state} size={26}/>
        <span className="presence-row__copy">
          <span className="presence-row__name"><span className="truncate">{ghost.name}</span>{ghost.isDefault && !onlyMain && <span className="presence-row__main-mark">메인</span>}</span>
          {now.line ? <span className="presence-row__line" data-tone={now.state}>{now.line}</span>
            : ghost.state === 'paused' && <span className="presence-row__line">일시 중지</span>}
        </span>
        {working > 0 && <span className="sidebar-count"><span className="sr-only">맡긴 일 진행 중 </span>{working}</span>}
      </button>
    </RosterGhostMenu>;
  };

  const projectItem = (scope: Scope, nested: boolean) => <NavigationItem key={scope.id} className={nested ? 'sidebar-project sidebar-project--nested' : 'sidebar-project'}
    current={section === 'scopes' && scope.id === selectedScope}
    onClick={() => navigate(`/scopes/${encodeURIComponent(scope.id)}`)}>
    {!nested && <Folder/>}<span className="truncate">{scope.name}</span>
    {scope.state === 'paused' && <span className="sidebar-project__paused">일시 중지</span>}
  </NavigationItem>;
  /** A Ghost row followed by the projects it receives. */
  const entry = (ghost: Ghost) => {
    const owned = byGhost.get(ghost.id);
    return <div key={ghost.id} className="sidebar-entry">
      {row(ghost)}
      {owned && <div className="sidebar-projects" role="group" aria-label={`${ghost.name}의 프로젝트`}>{owned.map(scope => projectItem(scope, true))}</div>}
    </div>;
  };

  const projects = <NavigationGroup label={routeLabels.scopes}
    action={<button type="button" aria-label="새 프로젝트" title="새 프로젝트" onClick={() => navigate('/scopes?new=1')} className="sidebar-group-action"><Plus size={14} aria-hidden="true"/></button>}>
    {orphans.map(scope => projectItem(scope, false))}
  </NavigationGroup>;

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
        <NavigationItem current={section === 'coding'} onClick={() => navigate('/coding')}>
          <Bot/><span className="flex-1">{routeLabels.coding}</span>
        </NavigationItem>
        <NavigationItem current={section === 'mail'} onClick={() => navigate('/mail')}>
          <Mail/><span className="flex-1">{routeLabels.mail}</span>
        </NavigationItem>
        <NavigationItem current={section === 'goals'} onClick={() => navigate('/goals')}>
          <Compass/><span className="flex-1">{uiTerms.goals}</span>
        </NavigationItem>
      </div>
      <div className="sidebar-scroll-frame">
        <div ref={scrollRef} className="sidebar-scroll">
          <div ref={contentRef}>
            {onlyMain ? fixed.map(entry) : roster.length > 0 && <NavigationGroup label={routeLabels.ghosts} className="sidebar-ghosts"
              action={foldable && <button type="button" className="sidebar-pool-toggle" aria-expanded={expanded} aria-controls={poolId}
                aria-label={expanded ? 'Ghost 목록 접기' : `Ghost 목록 펼치기 (${pool.length})`}
                onClick={() => { setQuery(''); setExpanded(!expanded); }}>
                <span aria-hidden="true" className="fold-mark"/>
                {!expanded && <span className="tabular" aria-hidden="true">{pool.length}</span>}
              </button>}>
              {fixed.map(entry)}
              {pool.length > 0 && <div className="sidebar-pool" id={poolId}>
                {foldable && expanded && <input type="text" enterKeyHint="search" className="sidebar-search" aria-label="Ghost 찾기"
                  placeholder="Ghost 찾기" value={query} onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => { blurTouchSearchOnEnter(event); if (event.key === 'Escape') { event.preventDefault(); setQuery(''); } }}/>}
                {filteredPool.map(entry)}
              </div>}
            </NavigationGroup>}
            {projects}
          </div>
        </div>
        <ScrollRail viewportRef={scrollRef} contentRef={contentRef}/>
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

/**
 * Each roster Ghost's projects, in project order, and the projects whose receiver is not on the roster. A project
 * without a receiver belongs to the default Ghost, as the Host routes it. Pure; tests pin it.
 */
export function projectsByReceiver(scopes: readonly Scope[], roster: readonly Ghost[]): { byGhost: Map<Ghost['id'], Scope[]>; orphans: Scope[] } {
  const main = roster.find(ghost => ghost.isDefault)?.id;
  const onRoster = new Set(roster.map(ghost => ghost.id));
  const byGhost = new Map<Ghost['id'], Scope[]>();
  const orphans: Scope[] = [];
  for (const scope of scopes) {
    const receiver = scope.ghostId ?? main;
    if (receiver === undefined || !onRoster.has(receiver)) { orphans.push(scope); continue; }
    const list = byGhost.get(receiver);
    if (list) list.push(scope); else byGhost.set(receiver, [scope]);
  }
  return { byGhost, orphans };
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
