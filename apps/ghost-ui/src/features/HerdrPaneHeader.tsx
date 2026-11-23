import { useContext, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, GitCompare, MessageSquare, SquareTerminal } from 'lucide-react';
import { CompactTitleSlot } from '../components/AppFrame';
import type { HerdrPaneView } from '@ghost/contract';
import { Button, Popover, PopoverContent, PopoverTrigger, SegmentedControl } from '../ui';
import { HerdrState } from './herdrDisplay';
import { uiTerms } from '../uiText';
import { TerminalTextSize } from './HerdrTerminalControls';

export type HerdrMode = 'chat' | 'live' | 'changes';
export const herdrModes: readonly HerdrMode[] = ['chat', 'live', 'changes'];
const modes = [
  { value: 'chat', label: '대화', Icon: MessageSquare },
  { value: 'live', label: '터미널', Icon: SquareTerminal },
  { value: 'changes', label: '변경', Icon: GitCompare },
] as const;
export type PaneNavigation = { panes: readonly HerdrPaneView[]; onNavigate(id: string): void };

export function HerdrPaneHeader({ pane, mode, onMode, compact, chat, changes, branch, navigation, fontSize, onFontSize, terminalAction }: {
  pane: HerdrPaneView; mode: HerdrMode; onMode(mode: HerdrMode): void; compact: boolean;
  chat: boolean; changes: boolean; branch?: string | null; navigation?: PaneNavigation;
  fontSize: number; onFontSize(size: number): void;
  terminalAction?: ReactNode;
}) {
  const slot = useContext(CompactTitleSlot);
  const [open, setOpen] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const siblings = navigation?.panes ?? [];
  const current = siblings.findIndex(item => item.id === pane.id);
  const canSwipe = compact && siblings.length > 1 && current >= 0;
  const buttons = modes.filter(item => item.value === 'chat' ? chat : item.value === 'changes' ? changes : true);
  const context = `${pane.agent ?? '셸'}${branch ? ` · ${branch}` : ''}`;
  const workLink = pane.codingWorkId && <a className="link-quiet coding-work-link" href={`#/work/${encodeURIComponent(pane.codingWorkId)}`}>{uiTerms.work}</a>;
  const title = compact && <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button type="button" className="coding-pane-picker" aria-label={`패널 정보 · ${pane.title}`}
      onTouchStart={event => {
        const point = event.touches[0];
        touch.current = canSwipe && event.touches.length === 1 ? { x: point.clientX, y: point.clientY } : null;
      }} onTouchCancel={() => { touch.current = null; }} onTouchEnd={event => {
        const start = touch.current;
        touch.current = null;
        if (!start) return;
        const dx = event.changedTouches[0].clientX - start.x, dy = event.changedTouches[0].clientY - start.y;
        if (Math.abs(dx) < 46 || Math.abs(dx) < 1.35 * Math.abs(dy)) return;
        const next = siblings[current + (dx < 0 ? 1 : -1)];
        if (next) navigation?.onNavigate(next.id);
      }}>
      <HerdrState status={pane.status} size={15} label={false}/><strong>{pane.title}</strong><ChevronDown size={14} aria-hidden="true"/>
    </button></PopoverTrigger>
    <PopoverContent className="coding-pane-info" aria-label="패널 정보">
      <h2>{pane.title}</h2>
      <p className="coding-detail-meta">{context}</p>
      {pane.cwd && <code className="coding-directory">{pane.cwd}</code>}
      {workLink}
      {canSwipe && <nav aria-label="탭의 패널">{siblings.map(item =>
        <button key={item.id} type="button" aria-current={item.id === pane.id ? 'page' : undefined}
          onClick={() => { setOpen(false); if (item.id !== pane.id) navigation?.onNavigate(item.id); }}>
          <HerdrState status={item.status} size={14} label={false}/><span>{item.title}</span>
        </button>)}</nav>}
    </PopoverContent>
  </Popover>;
  const controls = buttons.length > 1 || mode === 'live';
  return <header className="coding-detail-head">
    {compact ? slot ? createPortal(title, slot) : title : <div className="coding-detail-title" title={pane.cwd ?? pane.title}>
      <HerdrState status={pane.status} size={15} label={false}/>
      <h2>{pane.title}</h2>
      <span className="coding-detail-meta" title={context}>{context}</span>
      {workLink}
    </div>}
    {controls && <div className="herdr-view-actions">
      {buttons.length > 1 && <SegmentedControl aria-label="패널 보기" value={mode}
        options={buttons.map(({ value, label, Icon }) => ({
          value, label: <span title={label}><Icon aria-hidden="true"/><span className="sr-only">{label}</span></span>,
        }))} onValueChange={onMode}/>}
      {mode === 'live' && <div className="herdr-pane-tools" role="toolbar" aria-label="터미널 도구">
        {terminalAction}
        <TerminalTextSize size={fontSize} onSize={onFontSize}/>
      </div>}
    </div>}
  </header>;
}
