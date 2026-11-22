import { useRef } from 'react';
import { GitBranch } from 'lucide-react';
import type { HerdrPaneView } from '@ghost/contract';
import { Button, SegmentedControl } from '../ui';
import { HerdrState } from './herdrDisplay';
import { TerminalTextSize } from './HerdrTerminalControls';

export type HerdrMode = 'chat' | 'live' | 'history' | 'changes';
export const herdrModes: readonly HerdrMode[] = ['chat', 'live', 'history', 'changes'];
const modes = [{ value: 'chat', label: '대화' }, { value: 'live', label: '터미널' }, { value: 'changes', label: '변경' }] as const;
export type PaneNavigation = { panes: readonly HerdrPaneView[]; onNavigate(id: string): void };

export function HerdrPaneHeader({ pane, mode, onMode, compact, chat, changes, branch, navigation, onEsc, fontSize, onFontSize }: {
  pane: HerdrPaneView; mode: HerdrMode; onMode(mode: HerdrMode): void; compact: boolean;
  chat: boolean; changes: boolean; branch?: string | null; navigation?: PaneNavigation;
  onEsc?: () => void; fontSize: number; onFontSize(size: number): void;
}) {
  const touch = useRef<{ x: number; y: number }>(null);
  const siblings = navigation?.panes ?? [];
  const current = siblings.findIndex(item => item.id === pane.id);
  const canSwipe = compact && siblings.length > 1 && current >= 0;
  const inTerminal = mode === 'live' || mode === 'history';
  const buttons = modes.filter(item => item.value === 'chat' ? chat : item.value === 'changes' ? changes : true);
  return <header className="coding-detail-head">
    <div className="coding-detail-top" data-swipe={canSwipe || undefined}
      onPointerDown={event => {
        if (!canSwipe || event.pointerType !== 'touch' || (event.target as Element).closest('button')) return;
        touch.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerCancel={() => { touch.current = null; }} onPointerUp={event => {
        const start = touch.current;
        touch.current = null;
        if (!start || !canSwipe) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dx) < 46 || Math.abs(dx) < 1.35 * Math.abs(dy)) return;
        const next = siblings[current + (dx < 0 ? 1 : -1)];
        if (next) navigation?.onNavigate(next.id);
      }}>
      <div className="coding-detail-title">
        <div className="coding-context"><HerdrState status={pane.status} size={15} label={false}/><span>{pane.agent ?? '셸'}</span></div>
        <h2>{pane.title}</h2>
        {(branch || pane.cwd) && <code className="coding-directory" title={pane.cwd ?? undefined} aria-label={branch ? `브랜치 ${branch}` : `작업 디렉터리 ${pane.cwd}`}>
          {branch && <GitBranch aria-hidden="true" size={13}/>}<span>{branch || (compact ? pane.cwd?.split('/').filter(Boolean).slice(-2).join('/') || '/' : pane.cwd)}</span>
        </code>}
      </div>
      {canSwipe && <nav className="herdr-pane-dots" aria-label="탭의 패널">
        {siblings.map(item => <button key={item.id} type="button" aria-label={item.title} aria-current={item.id === pane.id ? 'page' : undefined}
          onClick={() => { if (item.id !== pane.id) navigation?.onNavigate(item.id); }}><i/></button>)}
      </nav>}
    </div>
    <div className="herdr-view-actions">
      <SegmentedControl aria-label="패널 보기" value={mode === 'history' ? 'live' : mode} options={buttons} onValueChange={next => onMode(next)}/>
      <div className="herdr-pane-tools">
        {inTerminal && <>
          <Button type="button" size="sm" variant={mode === 'history' ? 'secondary' : 'ghost'} aria-pressed={mode === 'history'}
            onClick={() => onMode(mode === 'history' ? 'live' : 'history')}>기록</Button>
          <TerminalTextSize size={fontSize} onSize={onFontSize}/>
        </>}
        {onEsc && <Button type="button" variant="outline" size="sm" aria-label="중단 (Esc)" onClick={onEsc}>Esc</Button>}
      </div>
    </div>
  </header>;
}
