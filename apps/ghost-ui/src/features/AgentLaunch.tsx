import { useState } from 'react';
import { Box, Check, ChevronDown, Folder, FolderOpen } from 'lucide-react';
import type { CodingPrompt, CodingSession } from '@ghost/contract';
import { FolderPicker } from '../components/FolderPicker';
import { Popover, PopoverContent, PopoverTrigger, SegmentedControl } from '../ui';
import { directoryName } from './CodingModel';
import { CodingModelChip, type ModelChoice } from './CodingModelChip';
import { CodingSessionComposer } from './CodingSessionComposer';
import { useNow } from './time';
import { AgentRowBody } from './WorkbenchPane';

/** Where a new agent works: a folder (directly or in its own worktree), or an empty sandbox. */
export type LaunchPlace = { folder: string | null; worktree: boolean };
export type Launch = { prompt: CodingPrompt; place: LaunchPlace; choice: ModelChoice };

const EARLIER_SHOWN = 5;
const workModes = [{ value: 'direct', label: '폴더에서 작업' }, { value: 'worktree', label: '별도 worktree' }] as const;

/**
 * Keep the working location and isolation choice visible before the first instruction.
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
  // Until the owner picks, the project's first folder (which may arrive after the pane opens).
  const [picked, setFolder] = useState<string | null | undefined>(undefined);
  const folder = picked === undefined ? folders[0] ?? null : picked;
  const [worktreeChoice, setWorktree] = useState<boolean | null>(null);
  const [choice, setChoice] = useState<ModelChoice>({ model: null, thinking: null });
  const [allEarlier, setAllEarlier] = useState(false);
  const worktree = folder !== null && (worktreeChoice ?? busyFolders.has(folder));
  const shown = allEarlier ? earlier : earlier.slice(0, EARLIER_SHOWN);
  const now = useNow();

  return <div className="agent-launch">
    <div className="agent-launch__composer">
      <div className="agent-launch__target">
        <FolderChip folder={folder} folders={folders} onChange={next => { setFolder(next); setWorktree(null); }}/>
        {folder !== null && <SegmentedControl aria-label="작업 방식" value={worktree ? 'worktree' : 'direct'} options={workModes}
          onValueChange={mode => setWorktree(mode === 'worktree')}/>}
      </div>
      <CodingSessionComposer state="idle" disabled={Boolean(disabled)} stopping={false} onAbort={() => {}} placeholder="새 에이전트에게 지시"
        model={<CodingModelChip value={choice} onChange={setChoice}/>}
        onPrompt={prompt => onLaunch({ prompt, place: { folder, worktree }, choice })}/>
    </div>
    {earlier.length > 0 && <section className="agent-launch__earlier" aria-label="이전 세션">
      <h3>이어서 하기</h3>
      <ul>
        {shown.map(session => <li key={session.id}><button type="button" className="workbench-agent-open" title={session.repo ?? session.cwd} onClick={() => onResume(session)}>
          <AgentRowBody session={session} detail={directoryName(session.repo ?? session.cwd)} now={now}/>
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
  const label = folder ?? '샌드박스';
  const choose = (next: string | null) => { onChange(next); setOpen(false); };
  return <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="agent-launch__folder" aria-label={`작업 폴더: ${label}`} title={folder ?? '폴더 없이 빈 샌드박스에서 작업'}>
          {folder ? <Folder size={16} aria-hidden="true"/> : <Box size={16} aria-hidden="true"/>}<span dir="auto">{label}</span><ChevronDown size={13} aria-hidden="true"/>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="coding-model-menu agent-launch__folders" aria-label="작업 폴더">
        <div className="coding-model-menu__list">
          {folders.map(path => <button key={path} type="button" aria-pressed={path === folder} title={path} onClick={() => choose(path)}>
            <Folder size={14} aria-hidden="true"/><span>{path}</span>{path === folder && <Check size={14} aria-hidden="true"/>}
          </button>)}
          {folder && !folders.includes(folder) && <button type="button" aria-pressed title={folder}><Folder size={14} aria-hidden="true"/><span>{folder}</span><Check size={14} aria-hidden="true"/></button>}
          <button type="button" aria-pressed={folder === null} onClick={() => choose(null)}><Box size={14} aria-hidden="true"/><span>샌드박스</span>{folder === null && <Check size={14} aria-hidden="true"/>}</button>
          <button type="button" onClick={() => { setOpen(false); setPicking(true); }}><FolderOpen size={14} aria-hidden="true"/><span>다른 폴더…</span></button>
        </div>
      </PopoverContent>
    </Popover>
    {picking && <FolderPicker initial={folder} title="작업 폴더" onClose={() => setPicking(false)} onPick={path => { setPicking(false); onChange(path); }}/>}
  </>;
}
