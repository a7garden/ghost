import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { GitBranch, GitCompare, Import, PanelLeftOpen, Plus, SquareTerminal, Workflow, X } from 'lucide-react';
import type { CodingSession as Session, CodingSessionCreate, Ghost, Scope, Work, WorkbenchState } from '@ghost/contract';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { StateGlyph } from '../components/agent';
import { HostError } from '../host/client';
import { useHost } from '../host/context';
import { Button, InlineError } from '../ui';
import { shortcut } from '../ui/keys';
import { AgentLaunch, type Launch } from './AgentLaunch';
import { CodingSession } from './CodingSession';
import { CodingSessionChanges } from './CodingSessionChanges';
import { codingError, embeddedSessionPath } from './CodingSessionModel';
import { useWorkbenchAttention, type Attention } from './WorkbenchAttention';
import { WorkbenchChanges } from './WorkbenchChanges';
import { AgentState, PaneHead, type PaneActions } from './WorkbenchPane';
import { AGENT_DRAG, WorkbenchRail, type RailProject } from './WorkbenchRail';
import { WorkbenchTerminal } from './WorkbenchTerminal';
import { useNow } from './time';
import { foldedAgents, STALE_MS } from './workbenchFold';
import { close, emptyLayout, LAUNCH, loadLayout, prune, resize, saveLayout, show, split, type Layout } from './workbenchLayout';
import { projectAgents, sessionProject, type ProjectAgent } from './workbenchProjects';
import { resolveSessionLink } from './workbenchSessionLink';
import './Workbench.css';
import './CodingSession.css';

type Dialog =
  | { type: 'folderChanges'; root: string }
  | { type: 'agentChanges'; sessionId: string }
  | { type: 'deleteAgent' | 'closeSession'; sessionId: string; title: string };

const ATTENTION_PRIORITY: Record<Attention, number> = { done: 1, failed: 2, waiting: 3 };
const RAIL_KEY = 'ghost.workbench.rail';
const layoutKey = (scopeId: string | null) => scopeId ?? '';

export function Workbench({ scopes, works, ghosts, compact, detail, sessionId, navigate }: {
  scopes: readonly Scope[]; works: readonly Work[]; ghosts: readonly Ghost[]; compact: boolean;
  /** Phone: an agent or the launch pad is on screen; otherwise the roster is. */
  detail: boolean; sessionId: string | null; navigate(path: string, options?: { replace?: boolean }): void;
}) {
  const { client } = useHost();
  const [state, setState] = useState<WorkbenchState | null>(null);
  const latest = useRef<WorkbenchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sessionLink, setSessionLink] = useState<{ id: string; error: string } | null>(null);
  const [revision, reload] = useState(0);
  const [queued, setQueued] = useState(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [terminalRequest, setTerminalRequest] = useState<{ paneId: string; scopeId: string | null } | null>(null);
  const [railHidden, setRailHidden] = useState(() => { try { return localStorage.getItem(RAIL_KEY) === 'hidden'; } catch { return false; } });
  const [layouts, setLayouts] = useState<Record<string, Layout>>({});
  const [changeRevisions, setChangeRevisions] = useState<Record<string, number>>({});
  const [dropHint, setDropHint] = useState<{ index: number; side: 'split' | 'replace' } | null>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const rosterRef = useRef<HTMLElement>(null);
  const rosterScroll = useRef(0);
  const [folders, setFolders] = useState<{ scopeId: string; paths: string[] } | null>(null);
  const busy = queued > 0;
  const now = useNow();
  const loaded = state !== null;
  const roster = compact && !detail;
  const compactLaunch = compact && detail && sessionId === null;
  useLayoutEffect(() => {
    if (roster && loaded && rosterRef.current) rosterRef.current.scrollTop = rosterScroll.current;
  }, [roster, loaded]);

  const selected = state?.focus ? state.focus.scopeId : scopes[0]?.id ?? null;
  const scope = scopes.find(item => item.id === selected);
  const workMap = useMemo(() => new Map(works.map(work => [work.id, work])), [works]);
  const ghostMap = useMemo(() => new Map(ghosts.map(ghost => [ghost.id, { id: ghost.id, name: ghost.name }])), [ghosts]);

  const layout = layouts[layoutKey(selected)] ?? emptyLayout;
  const activeId = layout.panes[layout.active] ?? null;
  const displayedId = compact && detail ? compactLaunch ? LAUNCH : activeId ?? sessionId ?? LAUNCH : activeId;
  const activeSession = activeId && activeId !== LAUNCH ? activeId : null;
  const { sessions, attention, observer, listed: sessionsListed, setShowPicker } = useWorkbenchAttention(state?.agents ?? null, activeSession);
  // The session list feeds Ghost-started agents and the project's earlier sessions.
  useEffect(() => setShowPicker(true), [setShowPicker]);

  const rows = useMemo(() => (state ? projectAgents(state.agents, sessions, workMap, scopes) : []).filter(row => {
    if (row.listed) return true;
    const session = sessions.get(row.sessionId);
    return Boolean(session && (session.state !== 'closed' || now - session.updatedAt < STALE_MS));
  }), [state, sessions, workMap, scopes, now]);
  const projectRows = rows.filter(row => row.scopeId === selected);
  const folded = foldedAgents(projectRows, sessions, attention, activeSession, now);
  const listedIds = new Set(state?.agents.map(agent => agent.sessionId));
  const earlier = [...sessions.values()].filter(session => !session.ghostId && !listedIds.has(session.id)
    && sessionProject(session, workMap, scopes) === selected).sort((a, b) => b.updatedAt - a.updatedAt);
  const busyFolders = new Set(projectRows.flatMap(row => {
    const session = sessions.get(row.sessionId);
    return session && !session.repo && (session.state === 'working' || session.state === 'waiting') ? [session.cwd] : [];
  }));

  const signals = new Map<string | null, Attention>();
  let firstWaiting: ProjectAgent | undefined;
  let firstFailed: ProjectAgent | undefined;
  let attentionCount = 0;
  for (const row of rows) {
    const phase = sessions.get(row.sessionId)?.state;
    if (phase === 'waiting' || phase === 'failed') {
      attentionCount++;
      if (phase === 'waiting') firstWaiting ??= row;
      else firstFailed ??= row;
    }
    const signal = phase === 'waiting' || phase === 'failed' ? phase
      : phase === 'idle' && attention.get(row.sessionId) === 'done' ? 'done' : undefined;
    const prior = signals.get(row.scopeId);
    if (signal && (!prior || ATTENTION_PRIORITY[signal] > ATTENTION_PRIORITY[prior])) signals.set(row.scopeId, signal);
  }
  const firstAttention = firstWaiting ?? firstFailed;
  const projects: RailProject[] = scopes.map(item => ({ id: item.id, scope: item, signal: signals.get(item.id) }));
  if (!scopes.length || selected === null || rows.some(row => row.scopeId === null)) projects.push({ id: null, scope: null, signal: signals.get(null) });

  // Every unfolded agent of the project stays mounted, so a draft and the live stream survive switching panes.
  const mounted = new Set([...projectRows.filter(row => !folded.has(row.sessionId)).map(row => row.sessionId), ...layout.panes]);
  if (compactLaunch) mounted.add(LAUNCH);
  const projectFolder = (folders?.scopeId === selected ? folders.paths[0] : undefined) ?? scope?.paths[0];
  // A shell belongs to the pane and folder explicitly requested, not the latest focus or session snapshot.
  const folderOf = (id: string) => (id !== LAUNCH && sessions.get(id)?.cwd) || projectFolder;
  const activeTerminal = terminalRequest && terminalRequest.scopeId === selected && terminalRequest.paneId === displayedId
    ? { ...terminalRequest, cwd: folderOf(terminalRequest.paneId) } : null;

  function setLayout(update: (current: Layout) => Layout, scopeId = selected) {
    setLayouts(all => {
      const key = layoutKey(scopeId);
      const current = all[key] ?? emptyLayout;
      const next = update(current);
      return next === current ? all : { ...all, [key]: next };
    });
  }

  // A project's panes come back as the owner left them; a first visit opens the agent the Host remembers, else a launch pad.
  useEffect(() => {
    if (!state) return;
    const key = layoutKey(selected);
    if (layouts[key]) return;
    let restored = loadLayout(selected);
    const remembered = state.focus?.scopeId === selected ? state.focus.sessionId : null;
    if (remembered && !restored.panes.includes(remembered)) restored = show(restored, remembered);
    if (!restored.panes.length) {
      const first = projectRows.find(row => !folded.has(row.sessionId));
      restored = show(restored, first?.sessionId ?? LAUNCH);
    }
    setLayouts(all => ({ ...all, [key]: restored }));
  }, [state, selected, layouts, projectRows, folded]);

  useEffect(() => { if (layouts[layoutKey(selected)]) saveLayout(selected, layout); }, [selected, layout, layouts]);

  // Panes of sessions that no longer exist close once the session list has loaded.
  useEffect(() => {
    if (!sessionsListed) return;
    setLayout(current => prune(current, id => sessions.has(id)));
  }, [sessionsListed, sessions, selected]);

  // The active agent is the Host's focus, so the phone and the Mac return to the same place.
  const syncFocus = useEffectEvent((id: string) => {
    const focus = latest.current?.focus;
    if (!latest.current || (focus?.scopeId === selected && focus.sessionId === id)) return;
    showFailure(mutate('focus', 'POST', { scopeId: selected, sessionId: id }));
  });
  useEffect(() => { if (activeSession && sessions.has(activeSession)) syncFocus(activeSession); }, [activeSession, sessions.size > 0]);

  // A focus that arrives from elsewhere (a link from 맡긴 일, another device) shows in the active pane.
  const hostFocus = state?.focus?.sessionId ?? null;
  useEffect(() => {
    if (hostFocus && layouts[layoutKey(selected)]) setLayout(current => current.panes.includes(hostFocus) ? current : show(current, hostFocus));
  }, [hostFocus]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void client.workbench(controller.signal).then(snapshot => {
      if (!controller.signal.aborted) apply(snapshot);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(codingError(reason, '작업대를 불러오지 못했습니다.'));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, revision]);

  // A project's folders as a new agent sees them: the repositories its paths sit in come first.
  const scopePaths = scope?.paths.join('\n');
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void client.workbenchFolders(selected, controller.signal).then(paths => {
      if (!controller.signal.aborted) setFolders({ scopeId: selected, paths });
    }).catch(() => { /* The project's own paths still serve. */ });
    return () => controller.abort();
  }, [client, selected, scopePaths]);
  const launchFolders = folders?.scopeId === selected ? folders.paths : scope?.paths ?? [];

  const activateSession = useEffectEvent((id: string, signal: AbortSignal) => {
    setSessionLink(null);
    void enqueue(async () => {
      if (signal.aborted) return;
      const session = await client.codingSession(id, signal);
      const action = latest.current && resolveSessionLink(latest.current, session, sessionProject(session, workMap, scopes));
      if (action && !signal.aborted) await change(action.path, 'POST', action.fields);
      if (!signal.aborted) setSessionLink({ id, error: '' });
    }).catch(reason => {
      if (signal.aborted) return;
      setSessionLink({ id, error: reason instanceof HostError && reason.code === 'not_found'
        ? '에이전트를 찾을 수 없습니다.' : codingError(reason, '에이전트를 열지 못했습니다.') });
    });
  });
  useEffect(() => {
    if (!loaded || sessionId === null) return;
    const controller = new AbortController();
    activateSession(sessionId, controller.signal);
    return () => controller.abort();
  }, [client, loaded, sessionId]);

  useEffect(() => {
    if (compact) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'b') return;
      event.preventDefault();
      toggleRail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact]);

  function toggleRail() {
    setRailHidden(hidden => {
      try { localStorage.setItem(RAIL_KEY, hidden ? 'shown' : 'hidden'); } catch { /* The choice still holds for this visit. */ }
      return !hidden;
    });
  }

  function apply(snapshot: WorkbenchState) {
    if (latest.current && latest.current.version > snapshot.version) return;
    latest.current = snapshot;
    setState(snapshot);
  }

  function enqueue(run: () => Promise<void>) {
    setQueued(count => count + 1);
    setError('');
    const result = queue.current.catch(() => {}).then(run).finally(() => setQueued(count => count - 1));
    queue.current = result;
    return result;
  }

  async function change(path: string, method: 'POST' | 'PATCH' | 'DELETE', fields: Record<string, unknown>) {
    if (!latest.current) throw new Error('작업대를 아직 불러오지 못했습니다.');
    try {
      apply(await client.changeWorkbench(path, method, { ...fields, version: latest.current.version }));
    } catch (reason) {
      if (reason instanceof HostError && reason.code === 'conflict') {
        try { apply(await client.workbench()); } catch { /* Keep the original refusal visible. */ }
      }
      throw reason;
    }
  }

  function mutate(path: string, method: 'POST' | 'PATCH' | 'DELETE', fields: Record<string, unknown> = {}) {
    return enqueue(() => change(path, method, fields));
  }

  function showFailure(result: Promise<unknown>) {
    void result.catch(reason => setError(codingError(reason, '작업대를 바꾸지 못했습니다.')));
  }

  function selectProject(id: string | null) {
    if (latest.current?.focus?.scopeId === id && latest.current.focus !== null) return;
    showFailure(mutate('focus', 'POST', { scopeId: id }));
  }

  function openAgent(id: string, beside = false) {
    setLayout(current => beside ? split(current, id) : show(current, id));
    if (compact) navigate(embeddedSessionPath(id));
  }

  function openAttention(target: ProjectAgent) {
    if (target.scopeId === selected) {
      openAgent(target.sessionId);
      return;
    }
    showFailure(enqueue(async () => {
      await change('focus', 'POST', { scopeId: target.scopeId, sessionId: target.sessionId });
      setLayout(current => show(current === emptyLayout ? loadLayout(target.scopeId) : current, target.sessionId), target.scopeId);
      if (compact) navigate(embeddedSessionPath(target.sessionId));
    }));
  }

  function newAgent(beside = false) {
    setLayout(current => beside ? split(current, LAUNCH) : show(current, LAUNCH));
    if (compact) navigate('/coding?launch=1');
  }

  // A launch pad gives way to the agent it started; on a phone that screen replaces the pad in history, so Back lands on the roster.
  const replaceLaunch = (id: string) => {
    setLayout(current => {
      const at = current.panes.indexOf(LAUNCH);
      if (current.panes.includes(id)) return at < 0 ? { ...current, active: current.panes.indexOf(id) } : close({ ...current, active: current.panes.indexOf(id) }, at);
      if (at < 0) return show(current, id);
      const panes = current.panes.slice();
      panes[at] = id;
      return { ...current, panes, active: at };
    });
    if (compact) navigate(embeddedSessionPath(id), { replace: true });
  };

  async function launch({ prompt, place, choice }: Launch) {
    const withImages = Boolean(prompt.images?.length);
    const input: CodingSessionCreate = {
      ...(place.folder ? place.worktree ? { repo: place.folder } : { cwd: place.folder } : {}),
      ...(choice.model && { model: choice.model }), ...(choice.thinking && { thinking: choice.thinking }),
      ...(!withImages && { prompt: prompt.text }),
    };
    const session = await client.createCodingSession(input);
    observer(session);
    const result = withImages ? await client.promptCodingSession(session.id, prompt) : { disposition: 'started' as const };
    await mutate('agents', 'POST', { sessionId: session.id, scopeId: selected });
    replaceLaunch(session.id);
    return result;
  }

  function resume(session: Session) {
    showFailure(mutate('agents', 'POST', { sessionId: session.id, scopeId: selected }).then(() => replaceLaunch(session.id)));
  }

  async function renameAgent(id: string, title: string) {
    try { observer(await client.patchCodingSession(id, { title })); }
    catch (reason) { setError(codingError(reason, '이름을 바꾸지 못했습니다.')); }
  }

  function dropPanes(id: string) {
    for (const key of Object.keys(layouts)) setLayout(current => {
      let next = current;
      for (let at = next.panes.indexOf(id); at >= 0; at = next.panes.indexOf(id)) next = close(next, at);
      return next;
    }, key || null);
    // The agent on a phone screen is gone: the roster is what is left to show.
    if (compact && detail && id === activeSession) navigate('/coding', { replace: true });
  }

  function removeAgent(id: string) {
    showFailure(mutate(`agents/${encodeURIComponent(id)}`, 'DELETE').then(() => dropPanes(id)));
  }

  function pinAgent(id: string) {
    const row = rows.find(candidate => candidate.sessionId === id);
    showFailure(mutate('agents', 'POST', { sessionId: id, scopeId: row?.scopeId ?? selected }));
  }

  function moveAgent(id: string, scopeId: string | null) {
    const listed = state?.agents.some(agent => agent.sessionId === id);
    const result = listed ? mutate(`agents/${encodeURIComponent(id)}`, 'PATCH', { scopeId }) : mutate('agents', 'POST', { sessionId: id, scopeId });
    showFailure(result.then(() => dropPanes(id)));
  }

  async function createProject(name: string, folder: string | null) {
    try {
      const { scopeId } = await client.send<{ scopeId: string }>({ type: 'scope.create', name, ghostId: null, paths: folder ? [folder] : [], vaultPath: null, state: 'active', attachments: [], limits: {} });
      await mutate('focus', 'POST', { scopeId });
    } catch (reason) {
      setError(codingError(reason, '프로젝트를 만들지 못했습니다.'));
      throw reason;
    }
  }

  function startResize(index: number, event: ReactPointerEvent<HTMLDivElement>) {
    const width = panesRef.current?.getBoundingClientRect().width;
    if (!width) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let last = event.clientX;
    const move = (next: PointerEvent) => { const delta = (next.clientX - last) / width; last = next.clientX; setLayout(current => resize(current, index, delta)); };
    const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function dragTarget(event: DragEvent<HTMLElement>) {
    const pane = (event.target as Element).closest<HTMLElement>('[data-pane-index]');
    if (!pane) return null;
    const box = pane.getBoundingClientRect();
    const side: 'split' | 'replace' = event.clientX > box.left + box.width * 0.6 ? 'split' : 'replace';
    return { index: Number(pane.dataset.paneIndex), side };
  }

  const changesFor = (id: string) => setDialog({ type: 'agentChanges', sessionId: id });
  const terminalToggle = (id: string) => {
    const cwd = folderOf(id);
    const isOpen = activeTerminal?.paneId === id;
    return <Button variant="ghost" size="sm" type="button" aria-label="터미널" title="터미널"
      aria-pressed={isOpen} disabled={!cwd && !isOpen}
      onClick={() => {
        if (!compact && activeId !== id) setLayout(current => show(current, id));
        setTerminalRequest(isOpen || !cwd ? null : { paneId: id, scopeId: selected });
      }}><SquareTerminal aria-hidden="true"/><span>터미널</span></Button>;
  };

  let sheet = null;
  if (dialog?.type === 'folderChanges') sheet = <WorkbenchChanges key={dialog.root} root={dialog.root} onClose={() => setDialog(null)}/>;
  else if (dialog?.type === 'agentChanges') sheet = <CodingSessionChanges id={dialog.sessionId} revision={changeRevisions[dialog.sessionId] ?? 0} onClose={() => setDialog(null)}/>;
  else if (dialog?.type === 'deleteAgent') {
    const target = dialog;
    sheet = <ConfirmDialog title="에이전트 삭제" onClose={() => setDialog(null)} confirmLabel="삭제" onConfirm={() => mutate(`agents/${encodeURIComponent(target.sessionId)}`, 'DELETE').then(() => dropPanes(target.sessionId))}>
      <p>‘{target.title}’을 목록에서 삭제합니다. 세션 기록은 남고 새 에이전트 화면의 「이어서 하기」에서 다시 열 수 있습니다.</p>
    </ConfirmDialog>;
  } else if (dialog?.type === 'closeSession') {
    const target = dialog;
    sheet = <ConfirmDialog title="세션 닫기" confirmLabel="세션 닫기" onClose={() => setDialog(null)}
      onConfirm={async () => observer(await client.closeCodingSession(target.sessionId))}>
      <p>‘{target.title}’에 새 지시를 보낼 수 없게 됩니다. 작업 트리와 브랜치는 그대로 남습니다.</p>
    </ConfirmDialog>;
  }

  const attentionLabel = `확인 필요 ${attentionCount}`;
  const attentionAction = firstAttention && <button type="button" className="workbench-review" disabled={busy}
    aria-label={attentionLabel} title={`${attentionLabel} · ${sessions.get(firstAttention.sessionId)?.title ?? '에이전트'}`}
    onClick={() => openAttention(firstAttention)}>
    <StateGlyph state="attention" accessibleLabel=""/>
    <span className="workbench-review__label">확인 필요</span>{' '}<span className="workbench-review__count">{attentionCount}</span>
  </button>;
  const rail = <WorkbenchRail projects={projects} selected={selected} rows={projectRows} folded={folded} activeId={activeId}
    launching={!compact && layout.panes.includes(LAUNCH)} sessions={sessions} attention={attention} ghosts={ghostMap} now={now} busy={busy || !state} canSplit={!compact}
    selectProject={selectProject} openAgent={openAgent} newAgent={newAgent}
    renameAgent={renameAgent} removeAgent={id => setDialog({ type: 'deleteAgent', sessionId: id, title: sessions.get(id)?.title ?? '에이전트' })} pinAgent={pinAgent}
    createProject={createProject} openProjectSettings={id => navigate(`/scopes/${encodeURIComponent(id)}?view=settings`)}
    onCollapse={compact ? undefined : toggleRail} attentionAction={attentionAction}
    footer={<nav className="workbench-tools" aria-label="코딩 메뉴">
      <h2>도구</h2>
      <ul>
        {scope?.paths[0] && <li><button type="button" onClick={() => setDialog({ type: 'folderChanges', root: scope.paths[0]! })}><GitBranch size={16} aria-hidden="true"/>git 변경</button></li>}
        <li><a href="#/coding/orchestration" onClick={event => { event.preventDefault(); navigate('/coding/orchestration'); }}><Workflow size={16} aria-hidden="true"/>오케스트레이션</a></li>
        <li><a href="#/coding/orchestration?import=1" onClick={event => { event.preventDefault(); navigate('/coding/orchestration?import=1'); }}><Import size={16} aria-hidden="true"/>하네스 가져오기</a></li>
      </ul>
    </nav>}/>;

  const paneBody = (id: string) => id === LAUNCH
    // A launch pad belongs to its project: folder and model picks never carry over to another one.
    ? <AgentLaunch key={selected ?? 'none'} folders={launchFolders} busyFolders={busyFolders} earlier={earlier} disabled={!state} onLaunch={launch} onResume={resume}/>
    : <CodingSession id={id} onUpdate={observer} changesRevision={value => setChangeRevisions(all => all[id] === value ? all : { ...all, [id]: value })}/>;

  const agentActions = (id: string): PaneActions => {
    const session = sessions.get(id);
    const row = rows.find(candidate => candidate.sessionId === id);
    return {
      rename: title => renameAgent(id, title),
      changes: () => changesFor(id),
      closeSession: session && session.state !== 'closed' ? () => setDialog({ type: 'closeSession', sessionId: id, title: session.title }) : undefined,
      remove: row?.listed ? () => setDialog({ type: 'deleteAgent', sessionId: id, title: session?.title ?? '에이전트' }) : undefined,
      pin: row && !row.listed ? () => pinAgent(id) : undefined,
      move: scopeId => moveAgent(id, scopeId),
      openWork: session?.workId ? () => navigate(`/work/${encodeURIComponent(session.workId!)}`) : undefined,
    };
  };
  const scopeOf = (id: string) => rows.find(candidate => candidate.sessionId === id)?.scopeId ?? selected;

  const paneHead = (id: string, index: number) => {
    const closePane = !compact && (layout.panes.length > 1 || id === LAUNCH && projectRows.length > 0)
      ? () => setLayout(current => close(current, index)) : undefined;
    if (id === LAUNCH) return <header className="workbench-pane__head">
      <Plus size={16} aria-hidden="true"/><h2 className="workbench-name">새 에이전트</h2>
      <div className="workbench-pane__actions" role="group" aria-label="패널 작업">
        {terminalToggle(id)}
        {compact && <Button variant="ghost" size="icon" type="button" aria-label="작업 변경" title="작업 변경" disabled={!scope?.paths[0]}
          onClick={() => scope?.paths[0] && setDialog({ type: 'folderChanges', root: scope.paths[0] })}><GitCompare aria-hidden="true"/></Button>}
        {closePane && <Button variant="ghost" size="sm" type="button" aria-label="패널 닫기" title="패널 닫기" onClick={closePane}><X aria-hidden="true"/><span>닫기</span></Button>}
      </div>
    </header>;
    const session = sessions.get(id);
    const ghost = session?.ghostId ? ghostMap.get(session.ghostId) ?? { id: session.ghostId, name: 'Ghost' } : undefined;
    return <PaneHead key={id} session={session} ghost={ghost} attention={attention.get(id)} projects={scopes} currentScopeId={scopeOf(id)}
      fallbackContext={compact ? scope?.name ?? '프로젝트 없음' : undefined} onClosePane={closePane}
      actions={agentActions(id)}>{terminalToggle(id)}</PaneHead>;
  };

  return <div className="workbench" data-compact={compact || undefined} data-rail={!compact && railHidden ? 'hidden' : undefined}>
    <h1 className="sr-only">코딩 작업대</h1>
    {compact ? detail && displayedId && paneHead(displayedId, layout.active) : railHidden ? <aside className="workbench-strip" aria-label="작업대 탐색">
      <Button variant="ghost" size="icon" type="button" aria-label="목록 펼치기" title={`목록 펼치기 · ${shortcut('B')}`} onClick={toggleRail}><PanelLeftOpen aria-hidden="true"/></Button>
      {attentionAction}
      {projectRows.filter(row => !folded.has(row.sessionId)).map(row => {
        const session = sessions.get(row.sessionId);
        return <button key={row.sessionId} type="button" className="workbench-strip__agent" aria-current={row.sessionId === activeId ? 'true' : undefined}
          title={session?.title ?? '에이전트'} onClick={event => openAgent(row.sessionId, event.metaKey || event.ctrlKey)}>
          <span className="sr-only">{session?.title ?? '에이전트'}</span><AgentState state={session?.state} attention={attention.get(row.sessionId)}/>
        </button>;
      })}
      <Button variant="ghost" size="icon" type="button" aria-label="새 에이전트" title="새 에이전트" disabled={!state} onClick={() => setLayout(current => show(current, LAUNCH))}><Plus aria-hidden="true"/></Button>
    </aside> : <aside className="workbench-rail" aria-label="작업대 탐색">{rail}</aside>}
    <div className="workbench-main">
      {error && <div className="workbench-error"><InlineError onRetry={!state ? () => reload(value => value + 1) : undefined} retryLabel="다시 불러오기">{error}</InlineError></div>}
      {loading && !state && <p className="workbench-empty" role="status">작업대를 불러오는 중…</p>}
      {loaded && sessionId !== null && (sessionLink?.id !== sessionId
        ? <p className="workbench-error" role="status">에이전트를 여는 중…</p>
        : sessionLink.error && <div className="workbench-error"><InlineError>{sessionLink.error}</InlineError></div>)}
      {roster && state && <aside ref={rosterRef} className="workbench-rail" aria-label="작업대 탐색"
        onScroll={event => { rosterScroll.current = event.currentTarget.scrollTop; }}>{rail}</aside>}
      {state && <div ref={panesRef} className="workbench-panes" data-covered={(roster || (compact && activeTerminal !== null)) || undefined}
        onDragOver={event => {
          if (compact || !event.dataTransfer.types.includes(AGENT_DRAG)) return;
          event.preventDefault();
          const target = dragTarget(event);
          setDropHint(hint => hint?.index === target?.index && hint?.side === target?.side ? hint : target);
        }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropHint(null); }}
        onDrop={event => {
          const id = event.dataTransfer.getData(AGENT_DRAG);
          const target = dragTarget(event);
          setDropHint(null);
          if (!id || !target) return;
          event.preventDefault();
          setLayout(current => (target.side === 'split' ? split : show)({ ...current, active: target.index }, id));
        }}>
        {[...mounted].map(id => {
          const index = layout.panes.indexOf(id);
          const visible = compact ? detail && (compactLaunch ? id === LAUNCH : index === layout.active) : index >= 0;
          const style = { order: index * 2, flexGrow: layout.sizes[index] ?? 1 } as CSSProperties;
          return <section key={id} className="workbench-pane" data-pane-index={visible ? index : undefined} hidden={!visible} style={style}
            data-active={(!compact && layout.panes.length > 1 && index === layout.active) || undefined} data-drop={dropHint?.index === index ? dropHint.side : undefined}
            aria-label={id === LAUNCH ? '새 에이전트' : `에이전트: ${sessions.get(id)?.title ?? '에이전트'}`}
            onPointerDownCapture={() => { if (index >= 0 && index !== layout.active) setLayout(current => ({ ...current, active: index })); }}
            onFocusCapture={() => { if (index >= 0 && index !== layout.active) setLayout(current => ({ ...current, active: index })); }}>
            {!compact && paneHead(id, index)}
            {paneBody(id)}
          </section>;
        })}
        {!compact && layout.panes.slice(0, -1).map((_, index) => <div key={`border-${index}`} className="workbench-pane-border" role="separator" aria-orientation="vertical"
          aria-label="패널 너비" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((layout.sizes[index] ?? 0) * 100)} tabIndex={0}
          style={{ order: index * 2 + 1 }} onPointerDown={event => startResize(index, event)}
          onKeyDown={event => {
            const step = event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : 0;
            if (!step) return;
            event.preventDefault();
            setLayout(current => resize(current, index, step));
          }}/>)}
      </div>}
      {activeTerminal?.cwd && !roster && <WorkbenchTerminal key={activeTerminal.cwd} cwd={activeTerminal.cwd} onHide={() => setTerminalRequest(null)}/>}
    </div>
    {sheet}
  </div>;
}
