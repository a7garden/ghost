import { useState } from 'react';
import { Box, Check, ChevronDown, Folder, FolderOpen, GitBranch } from 'lucide-react';
import type { CodingPrompt, CodingSession } from '@ghost/contract';
import { FolderPicker } from '../components/FolderPicker';
import { Popover, PopoverContent, PopoverTrigger } from '../ui';
import { directoryName } from './CodingModel';
import { CodingModelChip, type ModelChoice } from './CodingModelChip';
import { CodingSessionComposer } from './CodingSessionComposer';
import { relativeTime, useNow } from './time';

/** Where a new agent works: a folder (directly or in its own worktree), or an empty sandbox. */
export type LaunchPlace = { folder: string | null; worktree: boolean };
export type Launch = { prompt: CodingPrompt; place: LaunchPlace; choice: ModelChoice };

const EARLIER_SHOWN = 5;

/**
 * The start of a new agent: the instruction is the form. Folder, worktree and model sit in the composer as chips with
 * the project's defaults, so the common case is typing and pressing Enter. Earlier sessions of the project wait below.
 */
export function AgentLaunch({ folders, busyFolders, earlier, onLaunch, onResume, disabled }: {
  folders: readonly string[];
  /** Folders another live agent works in directly: a new agent there starts in its own worktree by default. */
  busyFolders: ReadonlySet<string>;
  earlier: readonly CodingSession[];
  onLaunch(launch: Launch): Promise<{ disposition: 'started' | 'queued' }>;
  onResume(session: CodingSession): void;
  disabled?: boolean;
}) {
  const [folder, setFolder] = useState<string | null>(folders[0] ?? null);
  const [worktreeChoice, setWorktree] = useState<boolean | null>(null);
  const [choice, setChoice] = useState<ModelChoice>({ model: null, thinking: null });
  const [allEarlier, setAllEarlier] = useState(false);
  const worktree = folder !== null && (worktreeChoice ?? busyFolders.has(folder));
  const shown = allEarlier ? earlier : earlier.slice(0, EARLIER_SHOWN);
  const now = useNow();

  return <div className="agent-launch">
    <div className="agent-launch__composer">
      <CodingSessionComposer state="idle" disabled={Boolean(disabled)} stopping={false} onAbort={() => {}} placeholder="새 에이전트에게 지시"
        footer={<span className="agent-launch__place">
          <FolderChip folder={folder} folders={folders} onChange={next => { setFolder(next); setWorktree(null); }}/>
          {folder !== null && <button type="button" className="composer-chip" aria-pressed={worktree} title={worktree ? '별도 worktree와 브랜치에서 작업' : '폴더에서 바로 작업'}
            onClick={() => setWorktree(!worktree)}><GitBranch size={13} aria-hidden="true"/><span>{worktree ? 'worktree' : '바로 작업'}</span></button>}
        </span>}
        model={<CodingModelChip value={choice} onChange={setChoice}/>}
        onPrompt={prompt => onLaunch({ prompt, place: { folder, worktree }, choice })}/>
    </div>
    {earlier.length > 0 && <section className="agent-launch__earlier" aria-label="이전 세션">
      <h3>이어서 하기</h3>
      <ul>
        {shown.map(session => <li key={session.id}><button type="button" title={session.repo ?? session.cwd} onClick={() => onResume(session)}>
          <span className="agent-launch__title">{session.title}</span>
          <span className="agent-launch__meta">{directoryName(session.repo ?? session.cwd)}</span>
          <time className="tabular" dateTime={new Date(session.updatedAt).toISOString()}>{relativeTime(session.updatedAt, now)}</time>
        </button></li>)}
      </ul>
      {earlier.length > EARLIER_SHOWN && <button type="button" className="agent-launch__more" aria-expanded={allEarlier} onClick={() => setAllEarlier(value => !value)}>
        {allEarlier ? '접기' : `모두 보기 · ${earlier.length}개`}</button>}
    </section>}
  </div>;
}

function FolderChip({ folder, folders, onChange }: { folder: string | null; folders: readonly string[]; onChange(folder: string | null): void }) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const label = folder ? directoryName(folder) : '샌드박스';
  const choose = (next: string | null) => { onChange(next); setOpen(false); };
  return <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="composer-chip" aria-label={`작업 폴더: ${folder ?? '샌드박스'}`} title={folder ?? '폴더 없이 빈 샌드박스에서 작업'}>
          {folder ? <Folder size={13} aria-hidden="true"/> : <Box size={13} aria-hidden="true"/>}<span className="truncate">{label}</span><ChevronDown size={13} aria-hidden="true"/>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="coding-model-menu" aria-label="작업 폴더">
        <div className="coding-model-menu__list">
          {folders.map(path => <button key={path} type="button" aria-pressed={path === folder} title={path} onClick={() => choose(path)}>
            <Folder size={14} aria-hidden="true"/><span>{directoryName(path)}</span>{path === folder && <Check size={14} aria-hidden="true"/>}
          </button>)}
          {folder && !folders.includes(folder) && <button type="button" aria-pressed title={folder}><Folder size={14} aria-hidden="true"/><span>{directoryName(folder)}</span><Check size={14} aria-hidden="true"/></button>}
          <button type="button" aria-pressed={folder === null} onClick={() => choose(null)}><Box size={14} aria-hidden="true"/><span>샌드박스</span>{folder === null && <Check size={14} aria-hidden="true"/>}</button>
          <button type="button" onClick={() => { setOpen(false); setPicking(true); }}><FolderOpen size={14} aria-hidden="true"/><span>다른 폴더…</span></button>
        </div>
      </PopoverContent>
    </Popover>
    {picking && <FolderPicker initial={folder} title="작업 폴더" onClose={() => setPicking(false)} onPick={path => { setPicking(false); onChange(path); }}/>}
  </>;
}
