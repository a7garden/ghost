import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, GitCompare, X } from 'lucide-react';
import type { CodingSession as Session, Scope } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui';
import type { Attention } from './WorkbenchAttention';

const stateLabels: Record<Session['state'], string> = {
  idle: '대기 중', working: '작업 중', waiting: '입력 대기', closed: '닫힘', failed: '실패',
};

/** A state as a shape: hollow idle, filled working, a diamond waiting on the owner, a square that failed or closed. */
export function AgentState({ state = 'idle' }: { state?: Session['state'] }) {
  return <span className="workbench-state-mark" data-state={state} role="img" aria-label={stateLabels[state]} title={stateLabels[state]}/>;
}

export function AttentionMark({ signal }: { signal?: Attention }) {
  if (!signal) return null;
  const label = signal === 'waiting' ? '입력 대기' : signal === 'failed' ? '실패' : '완료';
  return <span className="workbench-attention" data-signal={signal} role="img" aria-label={label} title={label}/>;
}

/** Text that becomes a field when touched and saves on Enter or when focus leaves; Escape keeps the old name. */
export function InlineName({ value, label, editing, onEditing, onSave, className }: {
  value: string; label: string; editing: boolean; onEditing(editing: boolean): void; onSave(next: string): Promise<unknown>; className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const field = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    if (!editing) return;
    settled.current = false;
    setDraft(value);
    requestAnimationFrame(() => { field.current?.focus(); field.current?.select(); });
  }, [editing, value]);
  if (!editing) return <button type="button" className={`workbench-name ${className ?? ''}`} title={value} aria-label={`${label}: ${value}`} onClick={() => onEditing(true)}
    onKeyDown={event => { if (event.key === 'F2' || event.key === 'Enter') { event.preventDefault(); onEditing(true); } }}>{value}</button>;
  const finish = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.trim();
    onEditing(false);
    if (save && next && next !== value) void onSave(next.slice(0, 200));
  };
  return <input ref={field} className={`workbench-name-field ${className ?? ''}`} aria-label={label} value={draft} maxLength={200}
    onChange={event => setDraft(event.target.value)} onBlur={() => finish(true)}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    }}/>;
}

export type PaneActions = {
  rename(title: string): Promise<unknown>;
  changes(): void;
  closeSession?(): void;
  remove?(): void;
  pin?(): void;
  move?(scopeId: string | null): void;
  openWork?(): void;
};

/** What can be done with an agent: from its pane header on a wide screen, from the title row on the phone. */
export function AgentMenu({ projects, currentScopeId, actions, onRename }: {
  projects: readonly Scope[]; currentScopeId: string | null; actions: PaneActions; onRename(): void;
}) {
  const [menu, setMenu] = useState<'main' | 'move' | null>(null);
  const run = (action?: () => void) => () => { setMenu(null); action?.(); };
  return <Popover open={menu !== null} onOpenChange={open => setMenu(open ? 'main' : null)}>
    <PopoverTrigger asChild><Button variant="ghost" size="icon" type="button" aria-label="에이전트 메뉴"><Ellipsis aria-hidden="true"/></Button></PopoverTrigger>
    <PopoverContent className="workbench-menu" align="end" aria-label={menu === 'move' ? '옮길 프로젝트' : '에이전트 메뉴'}>
      {menu === 'move' ? <>
        {projects.map(scope => <button key={scope.id} type="button" disabled={scope.id === currentScopeId} onClick={run(() => actions.move?.(scope.id))}>{scope.name}</button>)}
        <button type="button" disabled={currentScopeId === null} onClick={run(() => actions.move?.(null))}>프로젝트 없음</button>
      </> : <>
        <button type="button" onClick={run(onRename)}>이름 바꾸기</button>
        {actions.openWork && <button type="button" onClick={run(actions.openWork)}>맡긴 일 보기</button>}
        {actions.pin && <button type="button" onClick={run(actions.pin)}>목록에 고정</button>}
        {actions.move && <button type="button" onClick={() => setMenu('move')}>다른 프로젝트로…</button>}
        {actions.closeSession && <button type="button" onClick={run(actions.closeSession)}>세션 닫기</button>}
        {actions.remove && <button type="button" data-danger onClick={run(actions.remove)}>목록에서 삭제</button>}
      </>}
    </PopoverContent>
  </Popover>;
}

/** One pane's header: whose agent, what it is called, where it works, and what can be done with it. */
export function PaneHead({ session, ghost, attention, projects, currentScopeId, actions, onClosePane, children }: {
  session: Session | undefined; ghost?: { id: string; name: string }; attention?: Attention;
  projects: readonly Scope[]; currentScopeId: string | null; actions: PaneActions; onClosePane?(): void; children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const title = session?.title ?? '에이전트';
  return <header className="workbench-pane__head">
    <AgentState state={session?.state}/>
    {ghost && <span className="workbench-ghost" title={`${ghost.name}이(가) 시작한 에이전트`}><DotAvatar profileId={ghost.id} size={18}/><span className="sr-only">{ghost.name}</span></span>}
    <InlineName value={title} label="에이전트 이름" editing={editing} onEditing={setEditing} onSave={actions.rename}/>
    <AttentionMark signal={attention}/>
    {session?.branch && <code className="workbench-pane__branch" title={session.branch}>{session.branch}</code>}
    <span className="workbench-pane__spacer"/>
    {children}
    <Button variant="ghost" size="sm" type="button" className="workbench-pane__changes" onClick={actions.changes} title="작업 변경" aria-label="작업 변경"><GitCompare aria-hidden="true"/><span>변경</span></Button>
    <AgentMenu projects={projects} currentScopeId={currentScopeId} actions={actions} onRename={() => setEditing(true)}/>
    {onClosePane && <Button variant="ghost" size="icon" type="button" aria-label="패널 닫기" title="패널 닫기" onClick={onClosePane}><X aria-hidden="true"/></Button>}
  </header>;
}
