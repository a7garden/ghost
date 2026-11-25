import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Ellipsis, Folder, GitBranch, History, Pencil, Plus, SquareTerminal, Trash2, X } from 'lucide-react';
import type { Agent, CodingSession as Session, Scope, Space, WorkbenchSpaceCreate, WorkbenchState } from '@ghost/contract';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FolderField } from '../components/FolderPicker';
import { Modal } from '../components/Modal';
import { HostError } from '../host/client';
import { useHost } from '../host/context';
import { Button, ContextMenu, ContextMenuAction, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, InlineError, Input, Popover, PopoverContent, PopoverTrigger } from '../ui';
import { CodingSession } from './CodingSession';
import { StartSession } from './CodingSessionStart';
import { codingError } from './CodingSessionModel';
import { directoryName } from './CodingModel';
import { useWorkbenchAttention, type Attention } from './WorkbenchAttention';
import { WorkbenchChanges } from './WorkbenchChanges';
import { WorkbenchTerminal } from './WorkbenchTerminal';
import { absoluteTime, relativeTime, useNow } from './time';
import { foldedAgents } from './workbenchFold';
import { resolveSessionLink } from './workbenchSessionLink';
import './Workbench.css';
import './CodingSession.css';

type Dialog =
  | { type: 'space' | 'changes' | 'agent' | 'start' }
  | { type: 'rename' | 'delete'; space: Space }
  | { type: 'renameAgent' | 'deleteAgent'; sessionId: string; title: string };

const ATTENTION_PRIORITY: Record<Attention, number> = { done: 1, failed: 2, waiting: 3 };
const stateLabels: Record<Session['state'], string> = {
  idle: '대기 중', working: '작업 중', waiting: '입력 대기', closed: '닫힘', failed: '실패',
};

export function AttentionMark({ signal }: { signal?: Attention }) {
  if (!signal) return null;
  const label = signal === 'waiting' ? '입력 대기' : signal === 'failed' ? '실패' : '완료';
  return <span className="workbench-attention" data-signal={signal} role="img" aria-label={label} title={label}/>;
}

function NameSheet({ title, initial = '', withRoot, onSave, onClose }: {
  title: string; initial?: string; withRoot?: boolean;
  onSave(name: string, root: string | null, worktree?: WorkbenchSpaceCreate['worktree']): Promise<unknown>; onClose(): void;
}) {
  const [name, setName] = useState(initial);
  const [root, setRoot] = useState('');
  const [withWorktree, setWithWorktree] = useState(false);
  const [branch, setBranch] = useState('');
  const [pending, setPending] = useState(false);
  const formed = useRef(false);
  const [error, setError] = useState('');
  // A chosen folder names the space when the name is left empty.
  const label = name.trim() || (withRoot && root ? directoryName(root).slice(0, 200) : '');
  return <Modal title={title} onClose={() => { if (!formed.current) onClose(); }} className="sm:max-w-[420px]">
    <form className="workbench-form" onSubmit={event => {
      event.preventDefault();
      if (!label || (withWorktree && !branch.trim()) || formed.current) return;
      formed.current = true;
      setPending(true); setError('');
      void onSave(label, root || null, withWorktree ? { branch: branch.trim() } : undefined).then(onClose).catch(reason => setError(codingError(reason, '저장하지 못했습니다.')))
        .finally(() => { formed.current = false; setPending(false); });
    }}>
      <label>이름<Input value={name} required={!root} placeholder={root ? directoryName(root) : undefined} maxLength={200} disabled={pending} onChange={event => setName(event.target.value)}/></label>
      {withRoot && <>
        <FolderField label="작업 폴더 (선택)" optional value={root} disabled={pending} onChange={value => {
          setRoot(value);
          if (!value) setWithWorktree(false);
        }}/>
        <label className="workbench-worktree-toggle"><input type="checkbox" checked={withWorktree} disabled={pending || !root}
          onChange={event => setWithWorktree(event.target.checked)}/>worktree로 시작</label>
        {withWorktree && <label>브랜치 이름<Input value={branch} required maxLength={200} disabled={pending} onChange={event => setBranch(event.target.value)}/></label>}
      </>}
      {error && <InlineError>{error}</InlineError>}
      <Button className="justify-self-end" disabled={pending || !label || (withWorktree && !branch.trim())} type="submit">{pending ? '저장 중…' : '저장'}</Button>
    </form>
  </Modal>;
}

function SpaceMenu({ space, disabled, open }: { space: Space; disabled: boolean; open(dialog: Dialog): void }) {
  const [shown, setShown] = useState(false);
  return <Popover open={shown} onOpenChange={setShown}>
    <PopoverTrigger asChild><Button variant="ghost" size="icon" type="button" disabled={disabled} aria-label={`${space.title} 스페이스 메뉴`}><Ellipsis aria-hidden="true"/></Button></PopoverTrigger>
    <PopoverContent className="workbench-menu" align="end" aria-label="스페이스 메뉴">
      <button type="button" onClick={() => { setShown(false); open({ type: 'rename', space }); }}>이름 변경</button>
      <button type="button" data-danger onClick={() => { setShown(false); open({ type: 'delete', space }); }}>스페이스 삭제</button>
    </PopoverContent>
  </Popover>;
}

function AgentState({ session }: { session: Session | undefined }) {
  const state = session?.state ?? 'idle';
  return <span className="workbench-state-mark" data-state={state} role="img" aria-label={stateLabels[state]} title={stateLabels[state]}/>;
}

export function Workbench({ scopes, compact, sessionId, navigate }: {
  scopes: Scope[]; compact: boolean; sessionId: string | null; navigate(path: string): void;
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
  const [spacesOpen, setSpacesOpen] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const busy = queued > 0;
  const now = useNow();
  const focus = state?.focus;
  const space = state?.spaces.find(space => space.id === focus?.spaceId);
  const agents = state?.agents.filter(agent => agent.spaceId === space?.id) ?? [];
  const focusedId = focus?.sessionId ?? null;
  const { sessions, attention, observer, listError, setShowPicker, reloadList } = useWorkbenchAttention(state?.agents ?? null, focusedId);
  const agentTitle = (agent: Agent) => sessions.get(agent.sessionId)?.title || '에이전트';
  const folded = foldedAgents(agents, sessions, attention, focusedId, Date.now());
  const listed = showOlder ? agents : agents.filter(agent => !folded.has(agent.sessionId));
  const listedIds = new Set(state?.agents.map(agent => agent.sessionId));
  const earlier = [...sessions.values()].filter(session => !listedIds.has(session.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  const focusedAgent = agents.find(agent => agent.sessionId === focusedId);
  // The shell opens where the agent works, else in the space's folder.
  const terminalCwd = (focusedAgent && sessions.get(focusedAgent.sessionId)?.cwd) || space?.root || null;
  const covered = compact && terminalOpen && terminalCwd !== null;
  const terminalButton = <Button variant={terminalOpen ? 'secondary' : 'ghost'} size={compact ? 'icon' : 'sm'} type="button" disabled={!terminalCwd} aria-pressed={terminalOpen}
    aria-label="터미널" title="터미널" onClick={() => setTerminalOpen(value => !value)}><SquareTerminal aria-hidden="true"/>{!compact && '터미널'}</Button>;

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

  const activateSession = useEffectEvent((id: string, signal: AbortSignal) => {
    setSessionLink(null);
    void enqueue(async () => {
      if (signal.aborted) return;
      const session = await client.codingSession(id, signal);
      while (!signal.aborted && latest.current) {
        const action = resolveSessionLink(latest.current, session);
        if (!action) break;
        await change(action.path, 'POST', action.fields);
        if (action.opensAgent) break;
      }
      if (!signal.aborted) setSessionLink({ id, error: '' });
    }).catch(reason => {
      if (signal.aborted) return;
      setSessionLink({ id, error: reason instanceof HostError && reason.code === 'not_found'
        ? '에이전트를 찾을 수 없습니다.' : codingError(reason, '에이전트를 열지 못했습니다.') });
    });
  });
  const loaded = state !== null;
  useEffect(() => {
    if (!loaded || sessionId === null) return;
    const controller = new AbortController();
    activateSession(sessionId, controller.signal);
    return () => controller.abort();
  }, [client, loaded, sessionId]);

  // The session list also tells whether earlier sessions are waiting to be opened.
  useEffect(() => setShowPicker(true), [setShowPicker]);

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

  function select(spaceId: string, agentId?: string) {
    const current = latest.current?.focus;
    if (current?.spaceId === spaceId && (!agentId || agentId === current.sessionId)) return;
    showFailure(mutate('focus', 'POST', { spaceId, sessionId: agentId }));
  }

  function addAgent(id: string) {
    if (!space) return Promise.resolve();
    return mutate(`spaces/${encodeURIComponent(space.id)}/agents`, 'POST', { sessionId: id });
  }

  const spaceSignals = new Map<string, Attention>();
  if (state && attention.size) {
    for (const agent of state.agents) {
      const signal = attention.get(agent.sessionId), prior = spaceSignals.get(agent.spaceId);
      if (signal && (!prior || ATTENTION_PRIORITY[signal] > ATTENTION_PRIORITY[prior])) spaceSignals.set(agent.spaceId, signal);
    }
  }
  const displayDialog = (next: Dialog) => { setDialog(next); setSpacesOpen(false); };
  const dismiss = () => setDialog(null);
  const makeSpace = <Button variant="ghost" size="icon" type="button" disabled={!state || busy} aria-label="새 스페이스" title="새 스페이스" onClick={() => displayDialog({ type: 'space' })}><Plus aria-hidden="true"/></Button>;
  const spaceList = <nav className="workbench-spaces" aria-label="스페이스">
    {state?.spaces.map(item => {
      const selected = item.id === space?.id;
      return <div key={item.id}>
        <div className="workbench-space-row" data-selected={selected || undefined}>
          <button type="button" aria-current={selected ? 'true' : undefined} title={item.root ?? item.title} onClick={() => { select(item.id); setSpacesOpen(false); }}>
            <Folder size={15} aria-hidden="true"/><span>{item.title}</span><AttentionMark signal={spaceSignals.get(item.id)}/>
          </button>
          <SpaceMenu space={item} disabled={busy} open={displayDialog}/>
        </div>
        {selected && <ul className="workbench-agents" aria-label="에이전트">
          {listed.map(agent => {
            const title = agentTitle(agent);
            const updatedAt = sessions.get(agent.sessionId)?.updatedAt;
            const removeAgent = () => showFailure(mutate(`agents/${encodeURIComponent(agent.sessionId)}`, 'DELETE'));
            return <li key={agent.sessionId}><ContextMenu>
              <ContextMenuTrigger asChild touchAction="inline"><div className="workbench-agent-row" data-selected={agent.sessionId === focusedId || undefined}>
              <button type="button" aria-current={agent.sessionId === focusedId ? 'true' : undefined} title={title}
                onClick={() => { select(item.id, agent.sessionId); setSpacesOpen(false); }}>
                <AgentState session={sessions.get(agent.sessionId)}/><span className="workbench-agent-title">{title}</span>{updatedAt !== undefined && <time className="workbench-agent-time tabular" dateTime={new Date(updatedAt).toISOString()} title={absoluteTime(updatedAt)}>{relativeTime(updatedAt, now)}</time>}<AttentionMark signal={attention.get(agent.sessionId)}/>
              </button>
              <ContextMenuAction/>
              <Button variant="ghost" size="icon" type="button" disabled={busy} aria-label={`${title} 닫기`} title="닫기"
                onClick={removeAgent}><X aria-hidden="true"/></Button>
              </div></ContextMenuTrigger>
              <ContextMenuContent aria-label="에이전트 메뉴">
                <ContextMenuItem icon={<Pencil/>} onSelect={() => setDialog({ type: 'renameAgent', sessionId: agent.sessionId, title })}>이름 바꾸기</ContextMenuItem>
                <ContextMenuItem icon={<Trash2/>} onSelect={() => setDialog({ type: 'deleteAgent', sessionId: agent.sessionId, title })}>삭제</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu></li>;
          })}
          {folded.size > 0 && <li><button type="button" className="workbench-agent-add" aria-expanded={showOlder} onClick={() => setShowOlder(value => !value)}>
            {showOlder ? <ChevronUp size={15} aria-hidden="true"/> : <ChevronDown size={15} aria-hidden="true"/>}{showOlder ? '이전 에이전트 접기' : `이전 에이전트 ${folded.size}개`}</button></li>}
          <li><button type="button" className="workbench-agent-add" disabled={busy} onClick={() => displayDialog({ type: 'start' })}><Plus size={15} aria-hidden="true"/>새 에이전트</button></li>
          {earlier.length > 0 && <li><button type="button" className="workbench-agent-add" disabled={busy} onClick={() => displayDialog({ type: 'agent' })}><History size={15} aria-hidden="true"/>이전 세션 열기</button></li>}
        </ul>}
      </div>;
    })}
  </nav>;
  const sideLinks = <nav className="workbench-links" aria-label="코딩 메뉴">
    <a href="#/coding/orchestration" onClick={event => { event.preventDefault(); navigate('/coding/orchestration'); }}>오케스트레이션</a>
  </nav>;

  let sheet: ReactNode;
  if (dialog?.type === 'space') {
    sheet = <NameSheet key="space" title="새 스페이스" withRoot onClose={dismiss}
      onSave={(title, root, worktree) => mutate('spaces', 'POST', { title, root, worktree })}/>;
  } else if (dialog?.type === 'changes' && space) {
    sheet = <WorkbenchChanges key={space.id} spaceId={space.id} onClose={dismiss}/>;
  } else if (dialog?.type === 'rename') {
    const target = dialog.space;
    sheet = <NameSheet key={target.id} title="이름 변경" initial={target.title} onClose={dismiss}
      onSave={title => mutate(`spaces/${encodeURIComponent(target.id)}`, 'PATCH', { title })}/>;
  } else if (dialog?.type === 'delete') {
    const target = dialog.space;
    sheet = <ConfirmDialog title="스페이스 삭제" onClose={dismiss} confirmLabel="삭제" onConfirm={() => mutate(`spaces/${encodeURIComponent(target.id)}`, 'DELETE')}>
      <p>‘{target.title}’과 그 에이전트 목록이 사라집니다. 코딩 세션은 남습니다.{target.worktree && ' worktree와 브랜치도 남습니다.'}</p>
    </ConfirmDialog>;
  } else if (dialog?.type === 'renameAgent') {
    const target = dialog;
    sheet = <NameSheet key={target.sessionId} title="이름 바꾸기" initial={target.title} onClose={dismiss}
      onSave={title => client.patchCodingSession(target.sessionId, { title })}/>;
  } else if (dialog?.type === 'deleteAgent') {
    const target = dialog;
    sheet = <ConfirmDialog title="에이전트 삭제" onClose={dismiss} confirmLabel="삭제"
      onConfirm={() => mutate(`agents/${encodeURIComponent(target.sessionId)}`, 'DELETE')}>
      <p>‘{target.title}’을 목록에서 삭제합니다. 코딩 세션 기록은 남고 「이전 세션 열기」에서 다시 열 수 있습니다.</p>
    </ConfirmDialog>;
  } else if (dialog?.type === 'agent') {
    sheet = <Modal title="이전 세션 열기" onClose={dismiss}><div className="workbench-picker">
      {earlier.map(session => <button type="button" key={session.id} title={session.repo ?? session.cwd} onClick={() => { dismiss(); showFailure(addAgent(session.id)); }}>{session.title}</button>)}
      {earlier.length === 0 && !listError && <p className="workbench-empty">열 수 있는 이전 세션이 없습니다.</p>}
      {listError && <InlineError onRetry={reloadList} retryLabel="다시 불러오기">{listError}</InlineError>}
    </div></Modal>;
  } else if (dialog?.type === 'start') {
    const roots = [...new Set([space?.root, ...scopes.flatMap(scope => scope.paths)].filter((path): path is string => Boolean(path)))];
    sheet = <StartSession directories={roots} sandboxFirst={!space?.root} onClose={dismiss} onCreated={session => {
      dismiss();
      showFailure(addAgent(session.id));
    }}/>;
  }

  return <div className="workbench" data-compact={compact || undefined}>
    <h1 className="sr-only">코딩 작업대</h1>
    {compact ? <div className="workbench-compact-head">
      <Popover open={spacesOpen} onOpenChange={setSpacesOpen}>
        <PopoverTrigger asChild><Button variant="ghost" className="justify-start" type="button" aria-label={space ? `스페이스: ${space.title}${focusedAgent ? `, ${agentTitle(focusedAgent)}` : ''}` : '스페이스'}>
          {focusedAgent ? <AgentState session={sessions.get(focusedAgent.sessionId)}/> : <Folder aria-hidden="true"/>}
          <span className="workbench-agent-title">{focusedAgent ? agentTitle(focusedAgent) : space?.title ?? '스페이스'}</span>
          {focusedAgent && <small>{space?.title}</small>}<AttentionMark signal={focusedAgent ? attention.get(focusedAgent.sessionId) : space ? spaceSignals.get(space.id) : undefined}/><ChevronDown aria-hidden="true"/></Button></PopoverTrigger>
        <PopoverContent className="workbench-space-popover" align="start" aria-label="스페이스 목록">{spaceList}
          <button type="button" className="workbench-agent-add" disabled={!state || busy} onClick={() => displayDialog({ type: 'space' })}><Plus size={15} aria-hidden="true"/>새 스페이스</button>
          {sideLinks}</PopoverContent>
      </Popover>
      {!space && makeSpace}
      {space && terminalButton}
      {space?.root && <Button variant="ghost" size="icon" type="button" disabled={busy} aria-label="git 변경" title="git 변경" onClick={() => setDialog({ type: 'changes' })}><GitBranch aria-hidden="true"/></Button>}
      {space && <Button variant="ghost" size="icon" type="button" disabled={busy} aria-label="새 에이전트" title="새 에이전트" onClick={() => displayDialog({ type: 'start' })}><Plus aria-hidden="true"/></Button>}
    </div> : <aside className="workbench-rail" aria-label="작업대 탐색">
      <div className="workbench-rail-head"><h2>스페이스</h2>{makeSpace}</div>
      {spaceList}{sideLinks}
    </aside>}
    <div className="workbench-main">
      {error && <div className="workbench-error"><InlineError onRetry={!state ? () => reload(value => value + 1) : undefined} retryLabel="다시 불러오기">{error}</InlineError></div>}
      {loading && !state && <p className="workbench-empty" role="status">작업대를 불러오는 중…</p>}
      {loaded && sessionId !== null && (sessionLink?.id !== sessionId
        ? <p className="workbench-error" role="status">에이전트를 여는 중…</p>
        : sessionLink.error && <div className="workbench-error"><InlineError>{sessionLink.error}</InlineError></div>)}
      {space ? <>
        {!compact && <header className="workbench-head">
          {focusedAgent && <AgentState session={sessions.get(focusedAgent.sessionId)}/>}
          <h2 title={focusedAgent ? agentTitle(focusedAgent) : space.title}>{focusedAgent ? agentTitle(focusedAgent) : space.title}</h2>
          {focusedAgent && <AttentionMark signal={attention.get(focusedAgent.sessionId)}/>}
          <span className="ml-auto"/>{terminalButton}
          {space.root && <Button className="shrink-0" variant="ghost" size="sm" type="button" disabled={busy}
            onClick={() => setDialog({ type: 'changes' })}><GitBranch aria-hidden="true"/>git 변경</Button>}
        </header>}
        {agents.length ? <div className="workbench-agent-stack" data-covered={covered || undefined}>
          {/* Every unfolded agent stays mounted so a draft and the live stream survive switching. */}
          {agents.filter(agent => !folded.has(agent.sessionId)).map(agent => <section key={agent.sessionId} className="workbench-agent" aria-label={`에이전트: ${agentTitle(agent)}`}
            data-focused={agent.sessionId === focusedId || undefined} hidden={agent.sessionId !== focusedId}>
            <CodingSession id={agent.sessionId} onUpdate={observer}/>
          </section>)}
        </div> : !covered && <div className="workbench-empty">
          <Button variant="add" type="button" disabled={busy} onClick={() => setDialog({ type: 'start' })}>새 에이전트</Button>
          {earlier.length > 0 && <Button variant="ghost" type="button" disabled={busy} onClick={() => setDialog({ type: 'agent' })}>이전 세션 열기</Button>}
        </div>}
        {terminalOpen && terminalCwd !== null && <WorkbenchTerminal key={terminalCwd} cwd={terminalCwd} onHide={() => setTerminalOpen(false)}/>}
      </> : state && <div className="workbench-empty">
        <Button variant="add" type="button" disabled={busy} onClick={() => displayDialog({ type: 'space' })}>스페이스 만들기</Button>
      </div>}
    </div>
    {sheet}
  </div>;
}
