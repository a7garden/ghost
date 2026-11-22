import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { HerdrPaneView, HerdrView, Scope } from '@ghost/contract';
import { Button, InlineError, SegmentedControl } from '../ui';
import { useCodingPageSetup } from './CodingSetup';
import { NewHerdrWorkspace } from './HerdrStart';
import { OpenHerdrPane, useHerdr } from './Herdr';
import { HerdrActionDialog } from './HerdrActions';
import { findHerdrPane, HerdrRoster, type HerdrNode, type RosterAction } from './HerdrRoster';
import { parseHerdrPane, parseHerdrSession } from './herdrDisplay';
import { HerdrInbox, useHerdrActivity } from './HerdrInbox';
import { CodingSkeleton } from './HerdrParts';
import { useHerdrAsks } from './HerdrAsk';
import './coding.css';

const rosterModes = [{ value: 'agents', label: '에이전트' }, { value: 'spaces', label: '스페이스' }] as const;

function lastPane(session: string, pane?: string) {
  const key = `ghost.coding.last-pane:${session}`;
  try {
    if (pane) localStorage.setItem(key, pane);
    else return parseHerdrPane(localStorage.getItem(key));
  } catch { /* Storage can be unavailable. */ }
  return null;
}

export function CodingPage({ scopes, herdrPane, herdrSession, creating, onOpen, onCancel, compact, onRoster }: {
  scopes: Scope[]; herdrPane: string | null; herdrSession: string | null; creating: boolean; compact: boolean;
  onOpen(id: string): void; onCancel(): void; onRoster(view: HerdrView): void;
}) {
  const showDetail = creating || herdrPane !== null;
  const [revision, refresh] = useReducer((count: number) => count + 1, 0);
  const [action, setAction] = useState<RosterAction | null>(null);
  const [notice, setNotice] = useState('');
  const [rosterMode, setRosterMode] = useState<'agents' | 'spaces'>('agents');
  const [created, setCreated] = useState<{ snapshot: HerdrView | null; pane: HerdrPaneView } | null>(null);
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
  const restore = useRef(!creating && herdrPane === null);
  const open = useEffectEvent(onOpen);
  const session = liveSession;
  const log = useHerdrActivity(session, workspaces, pane?.id ?? null);
  const workspace = pane ? workspaces.find(item => item.id === pane.workspaceId) : undefined;
  const siblings = workspace?.tabs.find(tab => tab.id === pane?.tabId)?.panes ?? [];
  const showAgentList = rosterMode === 'agents' && (!compact || !showDetail);
  const blockedPanes = showAgentList ? workspaces.flatMap(item => item.tabs.flatMap(tab => tab.panes
    .filter(candidate => candidate.agent && candidate.status === 'blocked').map(candidate => candidate.id))) : [];
  if (pane?.agent && pane.status === 'blocked' && !blockedPanes.includes(pane.id)) blockedPanes.push(pane.id);
  const asks = useHerdrAsks(session, blockedPanes, refresh);
  const resolvedId = pane?.id;
  useEffect(() => { if (session && resolvedId) lastPane(session, resolvedId); }, [session, resolvedId]);
  useEffect(() => {
    if (herdrPane !== null || creating) restore.current = false;
    if (!restore.current || !session || !roster) return;
    restore.current = false;
    // On the phone an approval takes priority over restoring the previous pane.
    if (compact && blockedPanes.length) return;
    const remembered = findHerdrPane(roster.workspaces, lastPane(session));
    if (remembered) open(remembered.id);
  }, [creating, herdrPane, roster, session, compact, blockedPanes.length]);
  const sessionChanged = Boolean(setup && view && setup.session !== view.session);
  const needsSetup = sessionChanged || Boolean(setup && !required && (view?.available === false || view?.note));
  // A ready setup stops polling; the roster can tell us the server stopped or the owner switched sessions.
  useEffect(() => {
    if (needsSetup) refreshSetup();
  }, [needsSetup, refreshSetup]);
  const goBack = useEffectEvent(onCancel);
  const missing = Boolean(!creating && paneId && !pane && roster?.available && !roster.note);
  useEffect(() => {
    if (!creating && paneId && (sessionChanged || missing || foreignSession)) {
      if (foreignSession) setNotice(`이 링크는 다른 herdr 세션(${linkSession})의 패널을 가리킵니다. herdr의 세션을 바꾼 뒤 다시 열어 주세요.`);
      else if (missing) setNotice('이 패널은 더 이상 없습니다.');
      goBack();
    }
  }, [sessionChanged, creating, paneId, missing, foreignSession, linkSession]);
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
        <Button asChild variant={creating ? 'secondary' : 'outline'} size="icon">
          <a href="#/coding?new=1" aria-label="새 스페이스" title="새 스페이스" aria-current={creating ? 'page' : undefined}><Plus aria-hidden="true"/></a>
        </Button>
      </header>
      <div className="coding-roster-scroll">
        {notice && !showDetail && <p className="coding-hint" role="status">{notice}</p>}
        {!required && !errors && (error || roster?.note) && <InlineError onRetry={refresh} retryLabel="다시 불러오기">{error || roster?.note}</InlineError>}
        {!required && !errors && !error && !roster && <CodingSkeleton/>}
        {required && showSetupInRoster && setupNotice}
        {roster?.available && !roster.note && (rosterMode === 'agents'
          ? <HerdrInbox workspaces={workspaces} open={creating ? null : paneId} log={log} asks={asks} onSpaces={() => setRosterMode('spaces')}/>
          : workspaces.length ? <HerdrRoster workspaces={workspaces} selected={creating ? null : paneId} onAction={setAction}/>
            : <p className="coding-hint">열린 스페이스가 없습니다.</p>)}
        {!required && showSetupInRoster && setupNotice}
      </div>
    </section>
    {showDetail ? <div className="coding-pane" data-enter key={creating ? 'new' : paneId}>
      {(required || (compact && errors)) && <div className="coding-pane-setup">{errors}{required && panel}</div>}
      {creating ? <NewHerdrWorkspace scopes={scopes} setup={setup} onCancel={onCancel} onStarted={changed}/>
        : !paneId ? <div className="coding-pane-status"><InlineError>herdr 패널 주소가 올바르지 않습니다.</InlineError></div>
        : paneUnavailable || sessionChanged || missing ? null
        : pane && paneSession ? <OpenHerdrPane key={`${paneSession}/${paneId}`} pane={pane} compact={compact} onChanged={refresh} onGone={paneGone}
          preferencesKey={`${paneSession}:${paneId}`} since={log[pane.id]?.changedAt ?? 0} branch={workspace?.worktree?.branch}
          navigation={{ panes: siblings, onNavigate: onOpen }} asks={asks}/>
        : !errors && <div className="coding-pane-status">{error
          ? <InlineError onRetry={refresh} retryLabel="다시 불러오기">{error}</InlineError>
          : <CodingSkeleton detail/>}</div>}
    </div> : !compact && <div className={`coding-pane ${required ? 'coding-pane-setup' : 'coding-unselected'}`}>
      {required ? setupNotice : workspaces.length > 0 && <p className="coding-hint">{rosterMode === 'agents' ? '에이전트를 선택하세요.' : '패널을 선택하세요.'}</p>}
    </div>}
    {action && <HerdrActionDialog action={action} setup={setup} onDismiss={() => setAction(null)} onChanged={changed} onClosed={nodeClosed}/>}
  </div>;
}
