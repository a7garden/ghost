import { useState, type MouseEvent } from 'react';
import { Box, Columns2, Folder, Minus, PanelLeftClose, Pencil, Pin, Plus, Settings2, Trash2 } from 'lucide-react';
import type { CodingSession as Session, Scope } from '@ghost/contract';
import { Button, ContextMenu, ContextMenuAction, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui';
import { shortcut } from '../ui/keys';
import { uiTerms } from '../uiText';
import type { Attention } from './WorkbenchAttention';
import { AgentRowBody, AgentState, InlineName } from './WorkbenchPane';
import type { ProjectAgent } from './workbenchProjects';

export const AGENT_DRAG = 'application/x-ghost-agent';

type RailProps = {
  scope: Scope | undefined;
  navigate(path: string): void;
  projectPicker?: React.ReactNode;
  rows: readonly ProjectAgent[];
  folded: ReadonlySet<string>;
  activeId: string | null;
  launching: boolean;
  sessions: ReadonlyMap<string, Session>;
  attention: ReadonlyMap<string, Attention>;
  ghosts: ReadonlyMap<string, { id: string; name: string }>;
  now: number;
  busy: boolean;
  /** Wide screens split panes; the phone shows one agent at a time. */
  canSplit: boolean;
  openAgent(id: string, split: boolean): void;
  newAgent(split: boolean): void;
  renameAgent(id: string, title: string): Promise<unknown>;
  removeAgent(id: string): void;
  pinAgent(id: string): void;
  onCollapse?(): void;
  attentionAction?: React.ReactNode;
  footer?: React.ReactNode;
};

const wantsSplit = (event: MouseEvent) => event.metaKey || event.ctrlKey;

/** One project's agents: the owner's and the ones its Ghosts started. */
export function WorkbenchRail(props: RailProps) {
  const { scope, busy, onCollapse, navigate } = props;
  const project = scope ? `/scopes/${encodeURIComponent(scope.id)}` : undefined;
  const addAgent = <button type="button" className="workbench-agent-add" data-selected={props.launching || undefined} disabled={busy}
    onClick={event => props.newAgent(props.canSplit && wantsSplit(event))}><Plus size={16} aria-hidden="true"/>새 에이전트</button>;
  return <>
    {props.attentionAction}
    <div className="workbench-rail-head">
      <h2>{project ? <a href={`#${project}`} onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate(project);
      }}><Folder size={16} aria-hidden="true"/><span>{scope?.name}</span></a> : <><Box size={16} aria-hidden="true"/><span>{uiTerms.noProject}</span></>}</h2>
      {props.projectPicker}
      {project && <Button asChild variant="ghost" size="icon"><a href={`#${project}?view=settings`} aria-label="프로젝트 설정" title="프로젝트 설정"
        onClick={event => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); navigate(`${project}?view=settings`);
        }}><Settings2 aria-hidden="true"/></a></Button>}
      {onCollapse && <Button variant="ghost" size="icon" type="button" aria-label="목록 접기" title={`목록 접기 · ${shortcut('B')}`} onClick={onCollapse}><PanelLeftClose aria-hidden="true"/></Button>}
    </div>
    <div className="workbench-agent-list">
      {!props.canSplit && addAgent}
      <AgentList key={scope?.id ?? ''} {...props}/>
      {props.canSplit && addAgent}
    </div>
    {props.footer}
  </>;
}

function AgentList(props: RailProps) {
  const { rows, folded, sessions, attention, ghosts, now, busy, canSplit, activeId } = props;
  const [showOlder, setShowOlder] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const visible = showOlder ? rows : rows.filter(row => !folded.has(row.sessionId));
  return <ul className="workbench-agents" aria-label="에이전트">
    {visible.map(row => {
      const session = sessions.get(row.sessionId);
      const title = session?.title || '에이전트';
      const ghost = row.ghostId ? ghosts.get(row.ghostId) : undefined;
      const active = row.sessionId === activeId;
      return <li key={row.sessionId}><ContextMenu>
        <ContextMenuTrigger asChild touchAction="inline"><div className="workbench-agent-row" data-selected={active || undefined}
          draggable={canSplit && renaming !== row.sessionId} onDragStart={event => { event.dataTransfer.setData(AGENT_DRAG, row.sessionId); event.dataTransfer.effectAllowed = 'move'; }}>
          {renaming === row.sessionId
            ? <span className="workbench-agent-rename"><AgentState state={session?.state}/><InlineName value={title} label="에이전트 이름" editing onEditing={value => { if (!value) setRenaming(null); }} onSave={next => props.renameAgent(row.sessionId, next)}/></span>
            : <button type="button" className="workbench-agent-open" aria-current={active ? 'true' : undefined} title={title}
              onClick={event => props.openAgent(row.sessionId, canSplit && wantsSplit(event))}>
              <AgentRowBody session={session} attention={attention.get(row.sessionId)} ghost={ghost} now={now}/>
            </button>}
          <ContextMenuAction/>
        </div></ContextMenuTrigger>
        <ContextMenuContent aria-label="에이전트 메뉴">
          {canSplit && <ContextMenuItem icon={<Columns2/>} shortcut={shortcut('클릭')} onSelect={() => props.openAgent(row.sessionId, true)}>옆에 열기</ContextMenuItem>}
          <ContextMenuItem icon={<Pencil/>} onSelect={() => setRenaming(row.sessionId)}>이름 바꾸기</ContextMenuItem>
          {!row.listed && <ContextMenuItem icon={<Pin/>} disabled={busy} onSelect={() => props.pinAgent(row.sessionId)}>목록에 고정</ContextMenuItem>}
          {row.listed && <ContextMenuItem icon={<Trash2/>} disabled={busy} onSelect={() => props.removeAgent(row.sessionId)}>목록에서 삭제</ContextMenuItem>}
        </ContextMenuContent>
      </ContextMenu></li>;
    })}
    {folded.size > 0 && <li><button type="button" className="workbench-agent-add" aria-expanded={showOlder} onClick={() => setShowOlder(value => !value)}>
      {showOlder ? <Minus size={15} aria-hidden="true"/> : <Plus size={15} aria-hidden="true"/>}{showOlder ? '이전 에이전트 접기' : `이전 에이전트 ${folded.size}개`}</button></li>}
  </ul>;
}

