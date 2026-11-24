import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { CodingSession as EmbeddedSession, HerdrPaneView, HerdrView, Scope } from '@ghost/contract';
import { Button, InlineError, Popover, PopoverContent, PopoverTrigger, SegmentedControl } from '../ui';
import { useHost } from '../host/context';
import { useCodingPageSetup } from './CodingSetup';
import { NewHerdrWorkspace, preferredHerdrAgent } from './HerdrStart';
import { OpenHerdrPane, useHerdr } from './Herdr';
import { HerdrActionDialog } from './HerdrActions';
import { findHerdrPane, HerdrRoster, type HerdrNode, type RosterAction } from './HerdrRoster';
import { parseHerdrPane, parseHerdrSession } from './herdrDisplay';
import { HerdrInbox, useHerdrActivity } from './HerdrInbox';
import { CodingSkeleton } from './HerdrParts';
import { useHerdrAsks } from './HerdrAsk';
import { directoryName, recentCodingDirectories } from './CodingModel';
import { readCodingValue, writeCodingValue } from './herdrInboxModel';
import { CodingSession } from './CodingSession';
import { CodingSessionRoster } from './CodingSessionRoster';
import { Workbench } from './Workbench';
import './coding.css';
import './CodingSession.css';

const rosterModes = [{ value: 'agents', label: '에이전트' }, { value: 'spaces', label: '스페이스' }] as const;

export function CodingPage({ legacy, terminalId, navigate, ...props }: HerdrCodingProps & { legacy: boolean; terminalId: string | null; navigate(path: string): void }) {
  return legacy ? <HerdrCodingPage {...props}/> : <Workbench scopes={props.scopes} compact={props.compact} terminalId={terminalId} navigate={navigate}/>;
}

type HerdrCodingProps = {
  scopes: Scope[]; herdrPane: string | null; herdrSession: string | null; creating: boolean; compact: boolean; restoreLastPane: boolean;
  onOpen(id: string): void; onRestore(id: string): void; onCancel(): void; onRoster(view: HerdrView): void;
  embeddedSessionId: string | null; onOpenEmbedded(id: string): void;
};

function HerdrCodingPage({ scopes, herdrPane, herdrSession, creating, onOpen, onRestore, onCancel, compact, onRoster, restoreLastPane, embeddedSessionId, onOpenEmbedded }: HerdrCodingProps) {
  const showDetail = creating || herdrPane !== null || embeddedSessionId !== null;
  const [embeddedView, setEmbeddedView] = useState<EmbeddedSession | null>(null);
  const [revision, refresh] = useReducer((count: number) => count + 1, 0);
  const { client } = useHost();
  const [action, setAction] = useState<RosterAction | null>(null);
  const [notice, setNotice] = useState('');
  const [rosterMode, setRosterMode] = useState<'agents' | 'spaces'>('agents');
  const [created, setCreated] = useState<{ snapshot: HerdrView | null; pane: HerdrPaneView } | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [pendingDirectory, setPendingDirectory] = useState<string | null>(null);
  const creatingDirectory = useRef(false);
  const { setup, required, panel, errors, refreshSetup } = useCodingPageSetup(!compact || !showDetail, () => {
    if (!creating && herdrPane !== null) onCancel();
    refresh();
  });
  const { view, error } = useHerdr(revision);
  const report = useEffectEvent(onRoster);
  useEffect(() => { if (view) report(view); }, [view]);
  const roster = setup && view?.session !== setup.session ? null : view;
  const paneId = parseHerdrPane(herdrPane);
  const workspaces = roster?.workspaces ?? [];
  const linkSession = parseHerdrSession(herdrSession);
  const liveSession = roster?.available && !roster.note ? roster.session : null;
  // A pane id is unique only inside its herdr session: a link naming another session never opens this session's same-id pane.
  const foreignSession = linkSession !== null && liveSession !== null && linkSession !== liveSession;
  const pane = foreignSession ? undefined : created?.snapshot === view && created.pane.id === paneId ? created.pane : findHerdrPane(workspaces, paneId);
  const restore = useRef(restoreLastPane && !showDetail);
  const openRemembered = useEffectEvent(onRestore);
  const session = liveSession;
  const log = useHerdrActivity(session, workspaces, pane?.id ?? null);
  const directories = adding ? recentCodingDirectories(workspaces, scopes, log) : [];
  const agent = preferredHerdrAgent(setup);
  const workspace = pane ? workspaces.find(item => item.id === pane.workspaceId) : undefined;
  const siblings = workspace?.tabs.find(tab => tab.id === pane?.tabId)?.panes ?? [];
  const showAgentList = rosterMode === 'agents' && (!compact || !showDetail);
  const blockedPanes = showAgentList ? workspaces.flatMap(item => item.tabs.flatMap(tab => tab.panes
    .filter(candidate => candidate.agent && candidate.status === 'blocked').map(candidate => candidate.id))) : [];
  if (pane?.agent && pane.status === 'blocked' && !blockedPanes.includes(pane.id)) blockedPanes.push(pane.id);
  const asks = useHerdrAsks(session, blockedPanes, refresh);
  const resolvedId = pane?.id;
  useEffect(() => { if (session && resolvedId) writeCodingValue(`last-pane:${session}`, resolvedId); }, [session, resolvedId]);
  useEffect(() => {
    if (showDetail) restore.current = false;
    if (!restore.current || !session || !roster) return;
    restore.current = false;
    // On the phone an approval takes priority over restoring the previous pane.
    if (compact && blockedPanes.length) return;
    const remembered = findHerdrPane(roster.workspaces, parseHerdrPane(readCodingValue(`last-pane:${session}`)));
    if (remembered) openRemembered(remembered.id);
  }, [showDetail, roster, session, compact, blockedPanes.length]);
  const sessionChanged = Boolean(setup && view && setup.session !== view.session);
  const needsSetup = sessionChanged || Boolean(setup && !required && (view?.available === false || view?.note));
  // A ready setup stops polling; the roster can tell us the server stopped or the owner switched sessions.
  useEffect(() => {
    if (needsSetup) refreshSetup();
  }, [needsSetup, refreshSetup]);
  const goBack = useEffectEvent(onCancel);
  const missing = Boolean(!creating && paneId && !pane && roster?.available && !roster.note);
  useEffect(() => {
    if (!creating && paneId && (missing || foreignSession)) {
      if (foreignSession) setNotice(`이 링크는 다른 herdr 세션(${linkSession})의 패널을 가리킵니다. herdr의 세션을 바꾼 뒤 다시 열어 주세요.`);
      else if (missing) setNotice('이 패널은 더 이상 없습니다.');
      goBack();
    }
  }, [creating, paneId, missing, foreignSession, linkSession]);
  const showSetupInRoster = (compact && !showDetail) || (!compact && !required);
  const setupNotice = <>{errors}{panel}</>;
  const paneSession = setup?.session ?? roster?.session;
  const paneUnavailable = setup && (!setup.herdr.path || !setup.server || !setup.server.compatible || !setup.config.ok);
  function changed(createdPane?: HerdrPaneView) {
    if (createdPane) {
      setNotice('');
      setCreated({ snapshot: view, pane: createdPane });
      onOpen(createdPane.id);
    }
    refresh();
  }
  async function createDirectory(cwd: string) {
    if (!agent || creatingDirectory.current) return;
    creatingDirectory.current = true;
    setPendingDirectory(cwd);
    setAddError('');
    try {
      const newPane = await client.createHerdrWorkspace({ cwd, worktree: false, agent });
      setAdding(false);
      changed(newPane);
    } catch (reason) {
      setAddError(reason instanceof Error ? reason.message : '스페이스를 만들지 못했습니다.');
    } finally {
      creatingDirectory.current = false;
      setPendingDirectory(null);
    }
  }
  /** One tap: the preferred (else first installed) agent, no dialog. Options stay one menu item away. */
  async function quick(request: RosterAction & { kind: 'tab' | 'split' | 'agent' }) {
    setNotice('');
    try {
      let created: HerdrPaneView;
      if (request.kind === 'tab') created = await client.createHerdrTab({ workspace: request.node.id, ...(agent && { agent }) });
      else if (request.kind === 'split') created = await client.splitHerdrPane({ pane: request.pane, direction: request.direction, ...(agent && { agent }) });
      else if (agent) created = await client.startHerdrAgent({ pane: request.node.id, agent });
      else { setNotice('설치된 에이전트가 없습니다.'); return; }
      changed(created);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : '만들지 못했습니다.');
      refresh();
    }
  }
  function paneGone() {
    setNotice('이 패널은 더 이상 없습니다.');
    onCancel();
    refresh();
  }
  function nodeClosed(node: HerdrNode) {
    if (pane && (pane.id === node.id || pane.tabId === node.id || pane.workspaceId === node.id)) {
      setNotice('패널을 닫았습니다.');
      onCancel();
    }
    refresh();
  }
  return <div className="coding-page" data-compact={compact || undefined} data-detail={showDetail || undefined}>
    <section className="coding-roster" aria-label="코딩 세션">
      <header className="coding-roster-head">
        <h1 className="sr-only">코딩</h1>
        <SegmentedControl aria-label="코딩 목록" value={rosterMode} options={rosterModes} onValueChange={setRosterMode}/>
        <Popover open={adding} onOpenChange={open => { if (open || !creatingDirectory.current) setAdding(open); }}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="새 스페이스" title="새 스페이스"><Plus aria-hidden="true"/></Button>
          </PopoverTrigger>
          <PopoverContent className="coding-quick-add" align="end" aria-label="새 스페이스" aria-busy={pendingDirectory !== null || undefined}>
            {directories.map(path => <button type="button" key={path} title={path}
              disabled={!agent || Boolean(pendingDirectory) || Boolean(paneUnavailable) || !liveSession}
              onClick={() => void createDirectory(path)}>
              <strong>{directoryName(path)}</strong>
              <small>{pendingDirectory === path ? '만드는 중…' : path}</small>
            </button>)}
            {addError && <InlineError>{addError}</InlineError>}
            {setup && !agent && <p className="coding-hint">설치된 에이전트가 없습니다.</p>}
            <a href="#/coding?new=1" aria-current={creating ? 'page' : undefined} onClick={event => {
              if (creatingDirectory.current) { event.preventDefault(); return; }
              setAdding(false);
            }}>새 스페이스…</a>
          </PopoverContent>
        </Popover>
      </header>
      <div className="coding-roster-scroll">
        {embeddedSessionId !== null && <CodingSessionRoster directories={recentCodingDirectories(workspaces, scopes, log)} selected={embeddedSessionId}
          observed={embeddedView?.id === embeddedSessionId ? embeddedView : null} onOpen={onOpenEmbedded}/>}
        {notice && <p className="coding-hint" role="status">{notice}</p>}
        {!required && !errors && (error || roster?.note) && <InlineError onRetry={refresh} retryLabel="다시 불러오기">{error || roster?.note}</InlineError>}
        {!required && !errors && !error && !roster && <CodingSkeleton/>}
        {required && showSetupInRoster && setupNotice}
        {roster?.available && !roster.note && (rosterMode === 'agents'
          ? <HerdrInbox workspaces={workspaces} open={creating ? null : paneId} log={log} asks={asks} onSpaces={() => setRosterMode('spaces')}/>
          : workspaces.length ? <HerdrRoster workspaces={workspaces} selected={creating ? null : paneId} onAction={request => { if (request.kind !== 'rename' && request.kind !== 'close' && request.quick) void quick({ ...request, quick: true }); else setAction(request); }}/>
            : <p className="coding-hint">열린 스페이스가 없습니다.</p>)}
        {!required && showSetupInRoster && setupNotice}
      </div>
    </section>
    {embeddedSessionId !== null ? <div className="coding-pane"><CodingSession key={embeddedSessionId} id={embeddedSessionId} onUpdate={setEmbeddedView}/></div>
      : showDetail ? <div className="coding-pane" data-enter key={creating ? 'new' : paneId}>
      {(required || (compact && errors)) && <div className="coding-pane-setup">{errors}{required && panel}</div>}
      {creating ? <NewHerdrWorkspace setup={setup} onCancel={onCancel} onStarted={changed}/>
        : !paneId ? <div className="coding-pane-status"><InlineError>herdr 패널 주소가 올바르지 않습니다.</InlineError></div>
        : paneUnavailable || sessionChanged || missing ? null
        : pane && paneSession ? <OpenHerdrPane key={`${paneSession}/${paneId}`} pane={pane} compact={compact} onChanged={refresh} onGone={paneGone}
          preferencesKey={`${paneSession}:${paneId}`} since={log[pane.id]?.changedAt ?? 0} branch={workspace?.worktree?.branch}
          navigation={{ panes: siblings, onNavigate: onOpen }} asks={asks} setup={setup}/>
        : !errors && <div className="coding-pane-status">{error
          ? <InlineError onRetry={refresh} retryLabel="다시 불러오기">{error}</InlineError>
          : <CodingSkeleton detail/>}</div>}
    </div> : !compact && <div className={`coding-pane ${required ? 'coding-pane-setup' : 'coding-unselected'}`}>
      {required ? setupNotice : workspaces.length > 0 && <p className="coding-hint">{rosterMode === 'agents' ? '에이전트를 선택하세요.' : '패널을 선택하세요.'}</p>}
    </div>}
    {action && <HerdrActionDialog action={action} setup={setup} onDismiss={() => setAction(null)} onChanged={changed} onClosed={nodeClosed}/>}
  </div>;
}
