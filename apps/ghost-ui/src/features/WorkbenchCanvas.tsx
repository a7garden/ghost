import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowDownToLine, ArrowRightToLine, GripVertical, X } from 'lucide-react';
import { WORKBENCH_MAX_RATIO, WORKBENCH_MIN_RATIO, type CodingSession, type Layout, type Pane, type WorkbenchDirection } from '@ghost/contract';
import { Button } from '../ui';
import { isMac, shortcut } from '../ui/keys';
import type { Attention } from './WorkbenchAttention';
import { WorkbenchPaneBody, type PaneView } from './WorkbenchPane';

type Box = { x: number; y: number; w: number; h: number };
type Handle = { id: string; row: boolean; ratio: number; box: Box };
const SLOT_DRAG = 'application/x-ghost-workbench-pane';
const limit = (ratio: number) => Math.max(WORKBENCH_MIN_RATIO, Math.min(WORKBENCH_MAX_RATIO, ratio));

export function paneOrder(layout: Layout | null): string[] {
  const order: string[] = [];
  function visit(node: Layout) {
    if (node.type === 'pane') order.push(node.paneId);
    else { visit(node.first); visit(node.second); }
  }
  if (layout) visit(layout);
  return order;
}

export function AttentionMark({ signal }: { signal?: Attention }) {
  if (!signal) return null;
  const label = signal === 'waiting' ? '입력 대기' : signal === 'failed' ? '실패' : '완료';
  return <span className="workbench-attention" data-signal={signal} role="img" aria-label={label} title={label}/>;
}

export function WorkbenchCanvas({ layout, panes, focused, compact, busy, view, split, close, focus, move, resize, onExited, observe }: {
  layout: Layout; panes: readonly Pane[]; focused: string | null; compact: boolean; busy: boolean;
  view(pane: Pane): PaneView;
  split(id: string, direction: WorkbenchDirection): void;
  close(pane: Pane): void;
  focus(id: string): void;
  move(from: string, to: string): void;
  resize(id: string, ratio: number): void;
  onExited(id: string, exited: boolean): void;
  observe(session: CodingSession): void;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; ratio: number; start: number; initial: number } | null>(null);
  const [preview, setPreview] = useState<{ id: string; ratio: number } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const slots = new Map<string, Box>();
  const handles: Handle[] = [];
  function visit(node: Layout, box: Box) {
    if (node.type === 'pane') { slots.set(node.paneId, box); return; }
    const { id, direction, first, second } = node;
    const ratio = preview?.id === id ? preview.ratio : node.ratio;
    const row = direction === 'row';
    const { x, y, w, h } = box;
    handles.push({ id, row, ratio, box });
    if (row) {
      const width = w * ratio;
      visit(first, { x, y, w: width, h });
      visit(second, { x: x + width, y, w: w - width, h });
    } else {
      const height = h * ratio;
      visit(first, { x, y, w, h: height });
      visit(second, { x, y: y + height, w, h: h - height });
    }
  }
  visit(layout, { x: 0, y: 0, w: 1, h: 1 });

  function ratioAt(event: PointerEvent, handle: Handle, start: number, initial: number): number {
    const canvasBox = canvas.current?.getBoundingClientRect();
    if (!canvasBox) return initial;
    const delta = handle.row ? event.clientX - start : event.clientY - start;
    const size = handle.row ? canvasBox.width * handle.box.w : canvasBox.height * handle.box.h;
    return size > 0 ? limit(initial + delta / size) : initial;
  }

  function resizeKey(event: KeyboardEvent, handle: Handle) {
    if (busy) return;
    const { row, ratio, id } = handle;
    const previous = row ? 'ArrowLeft' : 'ArrowUp', next = row ? 'ArrowRight' : 'ArrowDown';
    const value = event.key === previous ? ratio - 0.05 : event.key === next ? ratio + 0.05
      : event.key === 'Home' ? WORKBENCH_MIN_RATIO : event.key === 'End' ? WORKBENCH_MAX_RATIO : null;
    if (value !== null && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      resize(id, limit(value));
    }
  }

  return <div ref={canvas} className="workbench-canvas" aria-label="패널 배치">
    {/* Keys stay at canvas level; moving/splitting never remounts a surviving pane or loses its draft. */}
    {[...slots].map(([id, { x, y, w, h }]) => {
      const pane = panes.find(candidate => candidate.id === id);
      if (!pane) return null;
      const shown = !compact || id === focused;
      const info = view(pane);
      const style: CSSProperties = { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` };
      return <section key={id} className="workbench-slot" aria-label={`패널: ${info.title}`} tabIndex={-1} data-pane-id={id} data-pane-kind={pane.kind}
        style={style} hidden={!shown} data-focused={id === focused || undefined} data-drop={target === id || undefined}
        onPointerDown={event => {
          if (event.button === 0 && id !== focused && !busy && !(event.target as Element).closest('.workbench-pane-actions')) focus(id);
        }}
        onFocusCapture={event => {
          if (id !== focused && !busy && !(event.target as Element).closest('.workbench-pane-actions')) focus(id);
        }}
        onDragOver={event => {
          if (!source || source === id || busy || !event.dataTransfer.types.includes(SLOT_DRAG)) return;
          event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTarget(id);
        }}
        onDragLeave={event => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setTarget(current => current === id ? null : current);
        }}
        onDrop={event => {
          if (!source || source === id || busy || event.dataTransfer.getData(SLOT_DRAG) !== source) return;
          event.preventDefault(); setTarget(null); setSource(null); move(source, id);
        }}>
        <div className="workbench-pane">
          <header className="workbench-pane-head">
            {!compact && <span className="workbench-grip" draggable={!busy && slots.size > 1} title="패널을 끌어 서로 바꾸기"
              onPointerDown={event => event.stopPropagation()}
              onDragStart={event => { event.dataTransfer.setData(SLOT_DRAG, id); event.dataTransfer.effectAllowed = 'move'; setSource(id); }}
              onDragEnd={() => { setSource(null); setTarget(null); }}><GripVertical size={13} aria-hidden="true"/></span>}
            <span className="workbench-state-mark" data-state={info.state} role="img" aria-label={info.stateLabel} title={info.stateLabel}/>
            <h2 title={info.title}>{info.title}</h2><AttentionMark signal={info.attention}/>
            <div className="workbench-pane-actions">
              <Button variant="ghost" size="icon" type="button" disabled={busy} aria-label="오른쪽으로 분할" title={`오른쪽으로 분할 (${shortcut('⇧→')})`} onClick={() => split(id, 'right')}><ArrowRightToLine aria-hidden="true"/></Button>
              <Button variant="ghost" size="icon" type="button" disabled={busy} aria-label="아래로 분할" title={`아래로 분할 (${shortcut('⇧↓')})`} onClick={() => split(id, 'down')}><ArrowDownToLine aria-hidden="true"/></Button>
              <Button variant="ghost" size="icon" type="button" disabled={busy} aria-label="패널 닫기" title={`패널 닫기 (${shortcut(isMac ? '⌥X' : 'Alt+X')})`} onClick={() => close(pane)}><X aria-hidden="true"/></Button>
            </div>
          </header>
          <WorkbenchPaneBody pane={pane} visible={shown} onExited={onExited} observe={observe}/>
        </div>
      </section>;
    })}
    {!compact && handles.map(handle => {
      const { id, row, ratio, box: { x, y, w, h } } = handle;
      // Leave four pixels at each end so a nested divider never steals its parent's intersection.
      const style: CSSProperties = row
        ? { left: `${(x + w * ratio) * 100}%`, top: `calc(${y * 100}% + 4px)`, height: `max(0px, calc(${h * 100}% - 8px))` }
        : { top: `${(y + h * ratio) * 100}%`, left: `calc(${x * 100}% + 4px)`, width: `max(0px, calc(${w * 100}% - 8px))` };
      return <div key={id} className="workbench-divider" data-row={row || undefined} style={style} role="separator"
        aria-orientation={row ? 'vertical' : 'horizontal'} aria-label={row ? '패널 너비' : '패널 높이'} aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={WORKBENCH_MIN_RATIO * 100} aria-valuemax={WORKBENCH_MAX_RATIO * 100} aria-disabled={busy || undefined} tabIndex={busy ? -1 : 0}
        onKeyDown={event => resizeKey(event, handle)}
        onPointerDown={event => {
          if (busy || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id, ratio, start: row ? event.clientX : event.clientY, initial: ratio };
        }}
        onPointerMove={event => {
          if (drag.current?.id !== id) return;
          drag.current.ratio = ratioAt(event, handle, drag.current.start, drag.current.initial);
          setPreview({ id, ratio: drag.current.ratio });
        }}
        onLostPointerCapture={() => { if (drag.current?.id === id) { drag.current = null; setPreview(null); } }}
        onPointerUp={event => {
          if (drag.current?.id !== id) return;
          const current = drag.current;
          drag.current = null; setPreview(null);
          const ratio = ratioAt(event, handle, current.start, current.initial);
          if (ratio !== current.initial) resize(id, ratio);
        }}/>
    })}
  </div>;
}
