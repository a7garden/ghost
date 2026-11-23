import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftRight, ChevronDown, Ellipsis, Folder, Plus, SquareTerminal, MessagesSquare } from 'lucide-react';
import type { Pane, Scope, Space, Tab, WorkbenchDirection, WorkbenchPaneCreate, WorkbenchState } from '@ghost/contract';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { HostError } from '../host/client';
import { useHost } from '../host/context';
import { Button, InlineError, Input, Popover, PopoverContent, PopoverTrigger } from '../ui';
import { isMac, shortcut } from '../ui/keys';
import { StartSession } from './CodingSessionRoster';
import { codingError } from './CodingSessionModel';
import { useWorkbenchAttention, type Attention } from './WorkbenchAttention';
import { AttentionMark, paneOrder, WorkbenchCanvas } from './WorkbenchCanvas';
import { paneView } from './WorkbenchPane';
import './Workbench.css';

type Resource = { kind: 'space'; item: Space } | { kind: 'tab'; item: Tab };
type Dialog =
  | { type: 'space' | 'tab' }
  | { type: 'rename' | 'delete'; resource: Resource }
  | { type: 'pane' | 'session' | 'start'; tabId: string; targetPaneId?: string; direction?: WorkbenchDirection }
  | { type: 'close'; pane: Pane }
  | { type: 'move'; paneId: string };

const EMPTY_PANES: readonly Pane[] = [];
const OPTION = isMac ? '⌥' : 'Alt+';
const ATTENTION_PRIORITY: Record<Attention, number> = { done: 1, failed: 2, waiting: 3 };
const resourcePath = ({ kind, item }: Resource) => `${kind === 'space' ? 'spaces' : 'tabs'}/${encodeURIComponent(item.id)}`;

function NameSheet({ title, initial = '', withRoot, onSave, onClose }: {
  title: string; initial?: string; withRoot?: boolean; onSave(name: string, root: string | null): Promise<unknown>; onClose(): void;
}) {
  const [name, setName] = useState(initial);
  const [root, setRoot] = useState('');
  const [pending, setPending] = useState(false);
  const formed = useRef(false);
  const [error, setError] = useState('');
  return <Modal title={title} onClose={() => { if (!formed.current) onClose(); }} className="sm:max-w-[420px]">
    <form className="workbench-form" onSubmit={event => {
      event.preventDefault();
      if (!name.trim() || formed.current) return;
      formed.current = true;
      setPending(true); setError('');
      void onSave(name.trim(), root.trim() || null).then(onClose).catch(reason => setError(codingError(reason, '저장하지 못했습니다.')))
        .finally(() => { formed.current = false; setPending(false); });
    }}>
      <label>이름<Input value={name} required maxLength={200} disabled={pending} onChange={event => setName(event.target.value)}/></label>
      {withRoot && <label>작업 폴더 (선택)<Input value={root} maxLength={4096} disabled={pending} autoCapitalize="none" autoCorrect="off"
        spellCheck={false} placeholder="/Projects/…" onChange={event => setRoot(event.target.value)}/></label>}
      {error && <InlineError>{error}</InlineError>}
      <Button className="justify-self-end" disabled={pending || !name.trim()} type="submit">{pending ? '저장 중…' : '저장'}</Button>
    </form>
  </Modal>;
}

function ResourceMenu({ resource, disabled, open }: { resource: Resource; disabled: boolean; open(dialog: Dialog): void }) {
  const [shown, setShown] = useState(false);
  const noun = resource.kind === 'space' ? '스페이스' : '탭';
  return <Popover open={shown} onOpenChange={setShown}>
    <PopoverTrigger asChild><Button variant="ghost" size="icon" type="button" disabled={disabled} aria-label={`${resource.item.title} ${noun} 메뉴`}><Ellipsis aria-hidden="true"/></Button></PopoverTrigger>
    <PopoverContent className="workbench-menu" align="end" aria-label={`${noun} 메뉴`}>
      <button type="button" onClick={() => { setShown(false); open({ type: 'rename', resource }); }}>이름 변경</button>
      <button type="button" data-danger onClick={() => { setShown(false); open({ type: 'delete', resource }); }}>{noun} 삭제</button>
    </PopoverContent>
  </Popover>;
}

export function Workbench({ scopes, compact, terminalId, navigate }: { scopes: Scope[]; compact: boolean; terminalId: string | null; navigate(path: string): void }) {
  const { client } = useHost();
  const [state, setState] = useState<WorkbenchState | null>(null);
  const latest = useRef<WorkbenchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, reload] = useState(0);
  const [queued, setQueued] = useState(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [spacesOpen, setSpacesOpen] = useState(false);
  const [exited, setExited] = useState<ReadonlySet<string>>(() => new Set());
  const root = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const busy = queued > 0;
  const focus = state?.focus;
  const space = state?.spaces.find(space => space.id === focus?.spaceId);
  const tab = state?.tabs.find(tab => tab.id === focus?.tabId);
  const order = paneOrder(tab?.layout ?? null);
  const selectedPane = state?.panes.find(pane => pane.id === focus?.paneId);
  const tabs = state?.tabs.filter(tab => tab.spaceId === space?.id) ?? [];
  const { sessions, attention, observer, listError, setShowPicker, reloadList } = useWorkbenchAttention(state?.panes ?? null, focus?.paneId ?? null);
  const view = (pane: Pane) => paneView(pane, sessions, exited, attention);

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

  const activateTerminal = useEffectEvent((id: string) => showFailure(mutate(`terminals/${encodeURIComponent(id)}/focus`, 'POST')));
  const loaded = state !== null;
  useEffect(() => {
    if (loaded && terminalId) activateTerminal(terminalId);
  }, [loaded, terminalId]);

  useEffect(() => {
    if (!focusAfter.current || focusAfter.current !== focus?.paneId) return;
    const target = root.current?.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(focusAfter.current)}"]`);
    focusAfter.current = null;
    target?.focus({ preventScroll: true });
  }, [focus?.paneId]);

  useEffect(() => setShowPicker(dialog?.type === 'session'), [dialog?.type, setShowPicker]);

  function apply(snapshot: WorkbenchState) {
    if (latest.current && latest.current.version > snapshot.version) return;
    latest.current = snapshot;
    setState(snapshot);
  }

  function mutate(path: string, method: 'POST' | 'PATCH' | 'DELETE', fields: Record<string, unknown> = {}) {
    setQueued(count => count + 1);
    setError('');
    const result = queue.current.catch(() => {}).then(async () => {
      if (!latest.current) throw new Error('작업대를 아직 불러오지 못했습니다.');
      try {
        const snapshot = await client.changeWorkbench(path, method, { ...fields, version: latest.current.version });
        apply(snapshot);
      } catch (reason) {
        if (reason instanceof HostError && reason.code === 'conflict') {
          try { apply(await client.workbench()); } catch { /* Keep the original refusal visible. */ }
        }
        throw reason;
      }
    }).finally(() => setQueued(count => count - 1));
    queue.current = result;
    return result;
  }

  function showFailure(result: Promise<unknown>) {
    void result.catch(reason => setError(codingError(reason, '작업대를 바꾸지 못했습니다.')));
  }

  function select(spaceId: string, tabId?: string, paneId?: string, keyboard = false) {
    const current = latest.current?.focus;
    if (current?.spaceId === spaceId && (!tabId || tabId === current.tabId) && (!paneId || paneId === current.paneId)) return;
    if (keyboard && paneId) focusAfter.current = paneId;
    showFailure(mutate('focus', 'POST', { spaceId, tabId, paneId }));
  }

  function addPane(target: Extract<Dialog, { type: 'pane' | 'session' | 'start' }>, pane: WorkbenchPaneCreate['pane']) {
    return mutate(`tabs/${encodeURIComponent(target.tabId)}/panes`, 'POST', { targetPaneId: target.targetPaneId, direction: target.direction, pane });
  }

  function closePane(pane: Pane) {
    if (pane.kind === 'terminal' && !exited.has(pane.id)) setDialog({ type: 'close', pane });
    else showFailure(mutate(`panes/${encodeURIComponent(pane.id)}`, 'DELETE'));
  }

  function movePane(from: string, to: string) {
    showFailure(mutate(`panes/${encodeURIComponent(from)}/move`, 'POST', { targetPaneId: to }));
  }

  const keyboard = useEffectEvent((event: KeyboardEvent) => {
    if (busy || dialog || event.defaultPrevented || event.isComposing || event.repeat || (isMac ? !event.metaKey : !event.ctrlKey)) return;
    if (document.querySelector('[role="dialog"]')) return;
    const { code, altKey, shiftKey } = event;
    if (altKey && !shiftKey) {
      if (space && code === 'KeyN') setDialog({ type: 'tab' });
      else if (selectedPane && code === 'KeyX') closePane(selectedPane);
      else if (space && tab && order.length > 1 && (code === 'Comma' || code === 'Period')) {
        const delta = code === 'Comma' ? -1 : 1;
        const index = order.indexOf(focus?.paneId ?? '');
        select(space.id, tab.id, order[(index + delta + order.length) % order.length], true);
      } else return;
    } else if (shiftKey && !altKey && tab && selectedPane && (code === 'ArrowRight' || code === 'ArrowDown')) {
      setDialog({ type: 'pane', tabId: tab.id, targetPaneId: selectedPane.id, direction: code === 'ArrowRight' ? 'right' : 'down' });
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => keyboard(event);
    // Capture only the workbench shortcuts before xterm sends input to the PTY.
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, []);

  const tabSignals = new Map<string, Attention>(), spaceSignals = new Map<string, Attention>();
  if (state && attention.size) {
    for (const pane of state.panes) {
      const signal = attention.get(pane.id), prior = tabSignals.get(pane.tabId);
      if (signal && (!prior || ATTENTION_PRIORITY[signal] > ATTENTION_PRIORITY[prior])) tabSignals.set(pane.tabId, signal);
    }
    for (const candidate of state.tabs) {
      const signal = tabSignals.get(candidate.id), prior = spaceSignals.get(candidate.spaceId);
      if (signal && (!prior || ATTENTION_PRIORITY[signal] > ATTENTION_PRIORITY[prior])) spaceSignals.set(candidate.spaceId, signal);
    }
  }
  const displayDialog = (next: Dialog) => { setDialog(next); setSpacesOpen(false); };
  const dismiss = () => setDialog(null);
  const icon = <Plus aria-hidden="true"/>;
  const makeSpace = <Button variant="ghost" size="icon" type="button" disabled={!state || busy} aria-label="새 스페이스" title="새 스페이스" onClick={() => displayDialog({ type: 'space' })}>{icon}</Button>;
  const spaceList = <nav className="workbench-spaces" aria-label="스페이스">
    {state?.spaces.map(item => <div className="workbench-space-row" key={item.id} data-selected={item.id === space?.id || undefined}>
      <button type="button" aria-current={item.id === space?.id ? 'true' : undefined} title={item.root ?? item.title} onClick={() => { select(item.id); setSpacesOpen(false); }}>
        <Folder size={15} aria-hidden="true"/><span>{item.title}</span><AttentionMark signal={spaceSignals.get(item.id)}/>
      </button>
      <ResourceMenu resource={{ kind: 'space', item }} disabled={busy} open={displayDialog}/>
    </div>)}
  </nav>;
  const sideLinks = <nav className="workbench-links" aria-label="코딩 메뉴">
    <a href="#/coding/orchestration" onClick={event => { event.preventDefault(); navigate('/coding/orchestration'); }}>오케스트레이션</a>
    <a href="#/coding?view=herdr" onClick={event => { event.preventDefault(); navigate('/coding?view=herdr'); }}>herdr</a>
  </nav>;

  let sheet: ReactNode;
  if (dialog?.type === 'space') {
    sheet = <NameSheet key="space" title="새 스페이스" withRoot onClose={dismiss} onSave={(title, root) => mutate('spaces', 'POST', { title, root })}/>;
  } else if (dialog?.type === 'tab' && space) {
    sheet = <NameSheet key="tab" title="새 탭" onClose={dismiss} onSave={title => mutate(`spaces/${encodeURIComponent(space.id)}/tabs`, 'POST', { title })}/>;
  } else if (dialog?.type === 'rename') {
    const { resource } = dialog;
    sheet = <NameSheet key={resource.item.id} title="이름 변경" initial={resource.item.title} onClose={dismiss}
      onSave={title => mutate(resourcePath(resource), 'PATCH', { title })}/>;
  } else if (dialog?.type === 'delete') {
    const { resource } = dialog;
    const noun = resource.kind === 'space' ? '스페이스' : '탭';
    sheet = <ConfirmDialog title={`${noun} 삭제`} onClose={dismiss} confirmLabel="삭제" onConfirm={() => mutate(resourcePath(resource), 'DELETE')}>
      <p>‘{resource.item.title}’의 배치가 사라지고 터미널이 종료됩니다. 코딩 세션은 남습니다.</p>
    </ConfirmDialog>;
  } else if (dialog?.type === 'close') {
    const id = dialog.pane.id;
    sheet = <ConfirmDialog title="터미널 패널 닫기" onClose={dismiss} confirmLabel="터미널 닫기"
      onConfirm={() => mutate(`panes/${encodeURIComponent(id)}`, 'DELETE')}><p>터미널과 그 안에서 실행 중인 작업이 종료됩니다.</p></ConfirmDialog>;
  } else if (dialog?.type === 'move') {
    const from = dialog.paneId;
    sheet = <Modal title="패널 위치 바꾸기" onClose={dismiss}><div className="workbench-picker">
      {order.flatMap((id, index) => {
        const pane = state?.panes.find(pane => pane.id === id);
        return pane && id !== from ? [<button key={id} type="button" onClick={() => { dismiss(); movePane(from, id); }}>{index + 1}. {view(pane).title}</button>] : [];
      })}
    </div></Modal>;
  } else if (dialog?.type === 'pane') {
    const target = dialog;
    sheet = <Modal title="새 패널" onClose={dismiss}><div className="workbench-picker">
      <button type="button" onClick={() => setDialog({ ...target, type: 'session' })}><MessagesSquare aria-hidden="true"/>코딩 세션</button>
      <button type="button" onClick={() => { dismiss(); showFailure(addPane(target, { kind: 'terminal' })); }}><SquareTerminal aria-hidden="true"/>터미널</button>
    </div></Modal>;
  } else if (dialog?.type === 'session') {
    const target = dialog;
    sheet = <Modal title="코딩 세션 선택" onClose={dismiss}><div className="workbench-picker">
      <button type="button" onClick={() => setDialog({ ...target, type: 'start' })}><Plus aria-hidden="true"/>새 세션</button>
      {[...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(session => <button type="button" key={session.id} title={session.repo ?? session.cwd}
        onClick={() => { dismiss(); showFailure(addPane(target, { kind: 'session', sessionId: session.id })); }}>{session.title}</button>)}
      {listError && <InlineError onRetry={reloadList} retryLabel="다시 불러오기">{listError}</InlineError>}
    </div></Modal>;
  } else if (dialog?.type === 'start') {
    const target = dialog;
    const roots = [...new Set([space?.root, ...scopes.flatMap(scope => scope.paths)].filter((path): path is string => Boolean(path)))];
    sheet = <StartSession directories={roots} allowDirect onClose={dismiss} onCreated={session => {
      dismiss();
      showFailure(addPane(target, { kind: 'session', sessionId: session.id }));
    }}/>;
  }

  return <div ref={root} className="workbench" data-compact={compact || undefined}>
    <h1 className="sr-only">코딩 작업대</h1>
    {compact ? <div className="workbench-compact-head">
      <Popover open={spacesOpen} onOpenChange={setSpacesOpen}>
        <PopoverTrigger asChild><Button variant="ghost" type="button" aria-label={space ? `스페이스: ${space.title}` : '스페이스'}><Folder aria-hidden="true"/>
          <span>{space?.title ?? '스페이스'}</span><AttentionMark signal={space ? spaceSignals.get(space.id) : undefined}/><ChevronDown aria-hidden="true"/></Button></PopoverTrigger>
        <PopoverContent className="workbench-space-popover" align="start" aria-label="스페이스 목록">{spaceList}{sideLinks}</PopoverContent>
      </Popover>
      {makeSpace}
    </div> : <aside className="workbench-rail" aria-label="작업대 탐색">
      <div className="workbench-rail-head"><h2>스페이스</h2>{makeSpace}</div>
      {spaceList}{sideLinks}
    </aside>}
    <div className="workbench-main">
      {error && <div className="workbench-error"><InlineError onRetry={!state ? () => reload(value => value + 1) : undefined} retryLabel="다시 불러오기">{error}</InlineError></div>}
      {loading && !state && <p className="workbench-empty" role="status">작업대를 불러오는 중…</p>}
      {space ? <>
        <div className="workbench-tab-bar">
          <nav className="workbench-tabs" aria-label="탭">
            {tabs.map(item => <div className="workbench-tab" key={item.id} data-selected={item.id === tab?.id || undefined}>
              <button type="button" aria-current={item.id === tab?.id ? 'true' : undefined} title={item.title} onClick={() => select(space.id, item.id)}>
                <span>{item.title}</span><AttentionMark signal={tabSignals.get(item.id)}/>
              </button>
              {item.id === tab?.id && <ResourceMenu resource={{ kind: 'tab', item }} disabled={busy} open={displayDialog}/>}
            </div>)}
          </nav>
          <Button variant="ghost" size="icon" type="button" disabled={busy} aria-label="새 탭" title={`새 탭 (${shortcut(`${OPTION}N`)})`} onClick={() => setDialog({ type: 'tab' })}>{icon}</Button>
        </div>
        {tab?.layout ? <>
          {order.length > 1 && <div className="workbench-panel-navigation" data-compact={compact || undefined}>
            {compact && <nav className="workbench-switcher" aria-label="패널 전환">
              {order.flatMap((id, index) => {
                const pane = state?.panes.find(pane => pane.id === id);
                if (!pane) return [];
                const info = view(pane);
                return [<button key={id} type="button" aria-current={id === focus?.paneId ? 'true' : undefined} title={info.title}
                  aria-label={`${index + 1}. ${info.title}`} onClick={() => select(space.id, tab.id, id)}>
                  <span className="workbench-pane-number">{index + 1}</span><span className="workbench-pane-name">{info.title}</span><AttentionMark signal={info.attention}/>
                </button>];
              })}
            </nav>}
            {selectedPane && <Button type="button" variant="ghost" size={compact ? 'icon' : 'sm'} disabled={busy} aria-label="패널 위치 바꾸기"
              title={`패널 위치 바꾸기 · 패널 전환 (${shortcut(`${OPTION},`)} / ${shortcut(`${OPTION}.`)})`}
              onClick={() => setDialog({ type: 'move', paneId: selectedPane.id })}>{compact ? <ArrowLeftRight aria-hidden="true"/> : '패널 위치 바꾸기'}</Button>}
          </div>}
          <WorkbenchCanvas key={tab.id} layout={tab.layout} panes={state?.panes ?? EMPTY_PANES} focused={focus?.paneId ?? null} compact={compact} busy={busy} view={view}
            split={(targetPaneId, direction) => setDialog({ type: 'pane', tabId: tab.id, targetPaneId, direction })} close={closePane}
            focus={paneId => select(space.id, tab.id, paneId)} move={movePane}
            resize={(id, ratio) => showFailure(mutate(`tabs/${encodeURIComponent(tab.id)}/splits/${encodeURIComponent(id)}`, 'PATCH', { ratio }))}
            onExited={(id, stopped) => setExited(previous => {
              if (previous.has(id) === stopped) return previous;
              const next = new Set(previous);
              if (stopped) next.add(id); else next.delete(id);
              return next;
            })} observe={observer}/>
        </> : <div className="workbench-empty">
          <Button variant="outline" type="button" disabled={busy} onClick={() => setDialog(tab ? { type: 'pane', tabId: tab.id } : { type: 'tab' })}>{icon}{tab ? '새 패널' : '탭 추가'}</Button>
        </div>}
      </> : state && <div className="workbench-empty">
        <Button variant="outline" type="button" disabled={busy} onClick={() => displayDialog({ type: 'space' })}>{icon}스페이스 만들기</Button>
      </div>}
    </div>
    {sheet}
  </div>;
}
