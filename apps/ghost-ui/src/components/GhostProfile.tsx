import { useState, type ReactNode } from 'react';
import { ChevronRight, ListTodo, Palette, Settings2, X } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui'
import { DotAvatar } from './DotAvatar';
import { AgentActivityList, type AgentActivityProps } from './AgentStatus';
import { Modal } from './Modal';
import { PresenceAvatar } from './agent';
import { toneFor, type DotState } from '../features/ghostState';
import { uiTerms } from '../uiText';

export interface GhostProfileProps {
  ghostID: string;
  name: string;
  summary?: string;
  /** Extra line under the name, for example the public conversation label. */
  note?: string;
  activity: AgentActivityProps;
  onOpenWork?: () => void;
  onManage?: () => void;
  /** Editor for the Ghost's look (꾸미기); opens in its own dialog with room for the preview. */
  design?: ReactNode;
  /** The owner's main Ghost. */
  isMain?: boolean;
  presence: DotState;
}

/** The Ghost's portrait at the head of its conversation; it opens the Ghost's profile. */
export function GhostProfile({ ghostID, name, summary, note, activity, onOpenWork, onManage, design, isMain = false, presence }: GhostProfileProps) {
  const [open, setOpen] = useState(false);
  const [designing, setDesigning] = useState(false);
  const go = (action: () => void) => () => { setOpen(false); action(); };
  const openDesign = go(() => setDesigning(true));
  const hasActivity = activity.model.observations.length > 0;
  const rows = [
    design != null && { key: 'design', icon: Palette, label: '꾸미기', action: openDesign },
    onOpenWork && { key: 'work', icon: ListTodo, label: '맡긴 일', action: go(onOpenWork) },
    onManage && { key: 'manage', icon: Settings2, label: uiTerms.ghostSettings, action: go(onManage) },
  ].filter(Boolean) as { key: string; icon: typeof ListTodo; label: string; action: () => void }[];

  return <div className="flex flex-col items-center gap-1">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`${name} 프로필 ${open ? '닫기' : '열기'}`} title={name} className="profile-trigger">
          <PresenceAvatar ghostId={ghostID} state={presence} size={36}/>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="center" aria-label={`${name} 프로필`}
        className="grid max-h-[min(42rem,calc(100vh-7rem))] w-80 max-w-[calc(100vw-1rem)] gap-3 overflow-y-auto">
        <div className="relative grid justify-items-center gap-1 pt-1 text-center">
          <Button type="button" variant="ghost" size="icon" className="absolute -top-1 -right-1" aria-label="프로필 닫기" onClick={() => setOpen(false)}><X size={16} aria-hidden="true"/></Button>
          {design != null
            ? <button type="button" aria-label={`${name} 꾸미기`} title="꾸미기" onClick={openDesign} className="profile-portrait"><DotAvatar profileId={ghostID} tone={toneFor(ghostID)} size={64}/></button>
            : <DotAvatar profileId={ghostID} tone={toneFor(ghostID)} size={64}/>}
          <strong className="mt-1 flex items-center gap-1.5 text-body font-semibold text-ink [overflow-wrap:anywhere]">{name}{isMain && <span className="presence-row__main-mark">메인</span>}</strong>
          {summary && summary.replace(/[.。]\s*$/, '') !== name && <p className="m-0 line-clamp-2 text-caption leading-relaxed text-ink-2">{summary}</p>}
        </div>
        <section className="grid gap-2 border-t border-line pt-3" aria-label="최근 활동">
          <h4 className="m-0 text-caption font-medium text-ink-2">최근 활동</h4>
          {hasActivity ? <AgentActivityList {...activity}/> : <p className="m-0 text-caption text-ink-2">최근 활동이 없습니다</p>}
        </section>
        {rows.length > 0 && <nav className="grid border-t border-line pt-2" aria-label={`${name} 바로 가기`}>
          {rows.map(({ key, icon: Icon, label, action }) =>
            <button key={key} type="button" onClick={action}
              className="flex min-h-9 w-full items-center gap-2.5 rounded-control px-1.5 text-left text-ui text-ink outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3">
              <Icon size={16} className="shrink-0 text-ink-2" aria-hidden="true"/><span className="flex-1">{label}</span><ChevronRight size={14} className="text-ink-3" aria-hidden="true"/>
            </button>)}
        </nav>}
      </PopoverContent>
    </Popover>
    {designing && design != null && <Modal title={`${name} 꾸미기`} onClose={() => setDesigning(false)} className="sm:max-w-[760px]">{design}</Modal>}
    {note && <span className="text-caption text-ink-2">{note}</span>}
  </div>;
}
