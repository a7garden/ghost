import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, GitCompare, X } from 'lucide-react';
import type { CodingSession as Session, Scope } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { StateGlyph, type GlyphState } from '../components/agent';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui';
import { absoluteTime, relativeTime } from './time';
import type { Attention } from './WorkbenchAttention';

const agentStates: Record<Session['state'], { glyph: GlyphState; label: string; word?: true }> = {
  idle: { glyph: 'queued', label: '대기 중' },
  working: { glyph: 'running', label: '작업 중', word: true },
  waiting: { glyph: 'attention', label: '답변 대기', word: true },
  failed: { glyph: 'failed', label: '실패', word: true },
  closed: { glyph: 'cancelled', label: '닫힘' },
};

export function AgentState({ state, attention, withCopy = false }: { state?: Session['state']; attention?: Attention; withCopy?: boolean }) {
  if (!state) return null;
  const { glyph, label, word } = agentStates[state];
  const done = state === 'idle' && attention === 'done';
  const copy = done ? '완료' : label;
  return <span className="workbench-state-icon" role="img" aria-label={copy} aria-hidden={withCopy && word ? true : undefined} title={copy}>
    <StateGlyph className="workbench-state" state={done ? 'done' : glyph} mark={state === 'idle' && !done ? 'ring' : undefined} accessibleLabel=""/>
  </span>;
}

export function AttentionMark({ signal }: { signal?: Attention }) {
  if (!signal) return null;
  return <StateGlyph className="workbench-project-signal" size={14} state={signal === 'waiting' ? 'attention' : signal}
    accessibleLabel={signal === 'waiting' ? agentStates.waiting.label : undefined}/>;
}

function StateWord({ state }: { state?: Session['state'] }) {
  if (!state || !agentStates[state].word) return null;
  return <span className="workbench-state-word" data-state={state}>{agentStates[state].label}</span>;
}

type GhostIdentity = { id: string; name: string };

function AgentFace({ ghost, size }: { ghost: GhostIdentity; size: number }) {
  return <span className="workbench-ghost" title={`${ghost.name}이(가) 시작한 에이전트`}>
    <DotAvatar profileId={ghost.id} size={size}/><span className="sr-only">{ghost.name}</span>
  </span>;
}

/** The same glyph, title, detail and time positions in both the roster and the launch history. */
export function AgentRowBody({ session, attention, ghost, detail, now }: {
  session?: Session; attention?: Attention; ghost?: GhostIdentity; detail?: string; now: number;
}) {
  const state = session?.state;
  const question = state === 'waiting' ? session?.pendingDialog?.title : undefined;
  return <>
    <span className="workbench-row-mark"><AgentState state={state} attention={attention} withCopy/></span>
    <span className="workbench-agent-title">{session?.title || '에이전트'}</span>
    <span className="workbench-agent-meta">
      {ghost && <AgentFace ghost={ghost} size={14}/>}
      <StateWord state={state}/>
      {question ? <span className="workbench-agent-question" title={question}>{question}</span>
        : detail && <span className="workbench-agent-detail" title={detail}>{detail}</span>}
    </span>
    {session && <time className="workbench-agent-time" dateTime={new Date(session.updatedAt).toISOString()} title={absoluteTime(session.updatedAt)}>{relativeTime(session.updatedAt, now)}</time>}
  </>;
}

/** Text that becomes a field when touched and saves on Enter or when focus leaves; Escape keeps the old name. */
export function InlineName({ value, label, editing, onEditing, onSave }: {
  value: string; label: string; editing: boolean; onEditing(editing: boolean): void; onSave(next: string): Promise<unknown>;
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
  if (!editing) return <button type="button" className="workbench-name" title={value} aria-label={`${label}: ${value}`} onClick={() => onEditing(true)}
    onKeyDown={event => { if (event.key === 'F2' || event.key === 'Enter') { event.preventDefault(); onEditing(true); } }}>{value}</button>;
  const finish = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.trim();
    onEditing(false);
    if (save && next && next !== value) void onSave(next.slice(0, 200));
  };
  return <input ref={field} className="workbench-name-field" aria-label={label} value={draft} maxLength={200}
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
export function PaneHead({ session, ghost, attention, projects, currentScopeId, fallbackContext, actions, onClosePane, children }: {
  session: Session | undefined; ghost?: GhostIdentity; attention?: Attention; fallbackContext?: string;
  projects: readonly Scope[]; currentScopeId: string | null; actions: PaneActions; onClosePane?(): void; children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const title = session?.title ?? '에이전트';
  const branch = session?.branch;
  return <header className="workbench-pane__head" data-waiting={session?.state === 'waiting' || undefined}>
    <AgentState state={session?.state} attention={attention} withCopy/>
    <div className="workbench-pane__identity">
      <InlineName value={title} label="에이전트 이름" editing={editing} onEditing={setEditing} onSave={actions.rename}/>
      <div className="workbench-pane__meta">
        {ghost && <AgentFace ghost={ghost} size={14}/>}
        <StateWord state={session?.state}/>
        {branch ? <code className="workbench-pane__branch" title={branch}>{branch}</code>
          : fallbackContext && <span className="workbench-pane__context" title={fallbackContext}>{fallbackContext}</span>}
      </div>
    </div>
    <div className="workbench-pane__actions" role="group" aria-label="패널 작업">
      {children}
      <Button variant="ghost" size="sm" type="button" onClick={actions.changes} title="작업 변경" aria-label="작업 변경"><GitCompare aria-hidden="true"/><span>변경</span></Button>
      <AgentMenu projects={projects} currentScopeId={currentScopeId} actions={actions} onRename={() => setEditing(true)}/>
      {onClosePane && <Button variant="ghost" size="sm" type="button" aria-label="패널 닫기" title="패널 닫기" onClick={onClosePane}><X aria-hidden="true"/><span>닫기</span></Button>}
    </div>
  </header>;
}
