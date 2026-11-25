import { useState, type MouseEvent } from 'react';
import { Box, ChevronDown, ChevronUp, Columns2, Folder, FolderOpen, PanelLeftClose, Pencil, Pin, Plus, Settings2, Trash2 } from 'lucide-react';
import type { CodingSession as Session, Scope } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { FolderPicker } from '../components/FolderPicker';
import { Button, ContextMenu, ContextMenuAction, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Input } from '../ui';
import { shortcut } from '../ui/keys';
import { directoryName } from './CodingModel';
import { absoluteTime, relativeTime } from './time';
import type { Attention } from './WorkbenchAttention';
import { AgentState, AttentionMark, InlineName } from './WorkbenchPane';
import type { ProjectAgent } from './workbenchProjects';

export const AGENT_DRAG = 'application/x-ghost-agent';

export type RailProject = { id: string | null; scope: Scope | null; signal?: Attention };

export type RailProps = {
  projects: readonly RailProject[];
  selected: string | null;
  rows: readonly ProjectAgent[];
  folded: ReadonlySet<string>;
  shownIds: ReadonlySet<string>;
  activeId: string | null;
  launching: boolean;
  sessions: ReadonlyMap<string, Session>;
  attention: ReadonlyMap<string, Attention>;
  ghosts: ReadonlyMap<string, { id: string; name: string }>;
  now: number;
  busy: boolean;
  /** Wide screens split panes; the phone shows one agent at a time. */
  canSplit: boolean;
  selectProject(id: string | null): void;
  openAgent(id: string, split: boolean): void;
  newAgent(split: boolean): void;
  renameAgent(id: string, title: string): Promise<unknown>;
  removeAgent(id: string): void;
  pinAgent(id: string): void;
  createProject(name: string, folder: string | null): Promise<unknown>;
  openProjectSettings(id: string): void;
  onCollapse?(): void;
  footer?: React.ReactNode;
};

const wantsSplit = (event: MouseEvent) => event.metaKey || event.ctrlKey;

/** Projects, and under the one on screen its agents: the owner's and the ones its Ghosts started. */
export function WorkbenchRail(props: RailProps) {
  const { projects, selected, busy, onCollapse } = props;
  const [drafting, setDrafting] = useState(false);
  return <>
    <div className="workbench-rail-head">
      <h2>프로젝트</h2>
      <Button variant="ghost" size="icon" type="button" disabled={busy} aria-label="새 프로젝트" title="새 프로젝트" onClick={() => setDrafting(true)}><Plus aria-hidden="true"/></Button>
      {onCollapse && <Button variant="ghost" size="icon" type="button" aria-label="목록 접기" title={`목록 접기 · ${shortcut('B')}`} onClick={onCollapse}><PanelLeftClose aria-hidden="true"/></Button>}
    </div>
    <nav className="workbench-spaces" aria-label="프로젝트">
      {drafting && <ProjectDraft onCancel={() => setDrafting(false)} onCreate={(name, folder) => props.createProject(name, folder).then(() => setDrafting(false))}/>}
      {projects.map(project => {
        const current = project.id === selected;
        const name = project.scope?.name ?? '프로젝트 없음';
        return <div key={project.id ?? 'none'} className="workbench-project" data-selected={current || undefined}>
          <div className="workbench-space-row" data-selected={current || undefined}>
            <button type="button" aria-current={current ? 'true' : undefined} aria-expanded={current} title={project.scope?.paths[0] ?? name} onClick={() => props.selectProject(project.id)}>
              {project.scope ? <Folder size={15} aria-hidden="true"/> : <Box size={15} aria-hidden="true"/>}<span>{name}</span><AttentionMark signal={project.signal}/>
            </button>
            {project.scope && <Button variant="ghost" size="icon" type="button" aria-label={`${name} 프로젝트 설정`} title="프로젝트 설정" onClick={() => props.openProjectSettings(project.id!)}><Settings2 aria-hidden="true"/></Button>}
          </div>
          {current && <AgentList {...props}/>}
        </div>;
      })}
    </nav>
    {props.footer}
  </>;
}

function AgentList(props: RailProps) {
  const { rows, folded, sessions, attention, ghosts, now, busy, canSplit, activeId, shownIds } = props;
  const [showOlder, setShowOlder] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const visible = showOlder ? rows : rows.filter(row => !folded.has(row.sessionId));
  return <ul className="workbench-agents" aria-label="에이전트">
    {visible.map(row => {
      const session = sessions.get(row.sessionId);
      const title = session?.title || '에이전트';
      const ghost = row.ghostId ? ghosts.get(row.ghostId) : undefined;
      const active = row.sessionId === activeId;
      const shown = shownIds.has(row.sessionId);
      const question = session?.state === 'waiting' ? session.pendingDialog?.title : undefined;
      return <li key={row.sessionId}><ContextMenu>
        <ContextMenuTrigger asChild touchAction="inline"><div className="workbench-agent-row" data-selected={active || undefined} data-shown={shown || undefined}
          draggable={canSplit && renaming !== row.sessionId} onDragStart={event => { event.dataTransfer.setData(AGENT_DRAG, row.sessionId); event.dataTransfer.effectAllowed = 'move'; }}>
          {renaming === row.sessionId
            ? <span className="workbench-agent-rename"><AgentState state={session?.state}/><InlineName value={title} label="에이전트 이름" editing onEditing={value => { if (!value) setRenaming(null); }} onSave={next => props.renameAgent(row.sessionId, next)}/></span>
            : <button type="button" aria-current={active ? 'true' : undefined} title={title}
              onClick={event => props.openAgent(row.sessionId, canSplit && wantsSplit(event))}>
              <AgentState state={session?.state}/>
              <span className="workbench-agent-text">
                <span className="workbench-agent-title">{title}</span>
                {question && <span className="workbench-agent-question">{question}</span>}
              </span>
              {ghost && <span className="workbench-ghost" title={`${ghost.name}이(가) 시작`}><DotAvatar profileId={ghost.id} size={16}/><span className="sr-only">{ghost.name}</span></span>}
              {session && <time className="workbench-agent-time tabular" dateTime={new Date(session.updatedAt).toISOString()} title={absoluteTime(session.updatedAt)}>{relativeTime(session.updatedAt, now)}</time>}
              <AttentionMark signal={attention.get(row.sessionId)}/>
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
      {showOlder ? <ChevronUp size={15} aria-hidden="true"/> : <ChevronDown size={15} aria-hidden="true"/>}{showOlder ? '이전 에이전트 접기' : `이전 에이전트 ${folded.size}개`}</button></li>}
    <li><button type="button" className="workbench-agent-add" data-selected={props.launching || undefined} disabled={busy}
      onClick={event => props.newAgent(canSplit && wantsSplit(event))}><Plus size={15} aria-hidden="true"/>새 에이전트</button></li>
  </ul>;
}

/** A new project starts from one line: a name, or just a folder that names it. */
function ProjectDraft({ onCreate, onCancel }: { onCreate(name: string, folder: string | null): Promise<unknown>; onCancel(): void }) {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);
  const label = name.trim() || (folder ? directoryName(folder).slice(0, 128) : '');
  return <form className="workbench-project-draft" onSubmit={event => {
    event.preventDefault();
    if (!label || pending) return;
    setPending(true);
    void onCreate(label, folder).finally(() => setPending(false));
  }} onKeyDown={event => { if (event.key === 'Escape') onCancel(); }}>
    <Input autoFocus aria-label="새 프로젝트 이름" placeholder={folder ? directoryName(folder) : '새 프로젝트'} value={name} maxLength={128} disabled={pending}
      onChange={event => setName(event.target.value)}/>
    <Button variant="ghost" size="icon" type="button" disabled={pending} aria-label={folder ? `폴더: ${folder}` : '폴더 선택'} title={folder ?? '폴더 선택'}
      aria-pressed={Boolean(folder)} onClick={() => setPicking(true)}><FolderOpen aria-hidden="true"/></Button>
    <button type="submit" hidden aria-hidden="true" tabIndex={-1}/>
    {picking && <FolderPicker title="프로젝트 폴더" onClose={() => setPicking(false)} onPick={path => { setPicking(false); setFolder(path); }}/>}
  </form>;
}
