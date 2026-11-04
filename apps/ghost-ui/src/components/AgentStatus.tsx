import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert, Clock3, MessageCircle, Search, Square, X } from 'lucide-react';
import { DotAvatar } from './DotAvatar';
import { elapsedAgentTime } from '../lifetime/agentStatus';
import type { AgentActivityState, AgentObservation, AgentStatusModel } from '../lifetime/agentStatus';
import './agent-status.css';

export interface AgentStatusProps {
  model: AgentStatusModel;
  ghostID: string;
  /** Local read time is only a freshness fence, never the start of an activity timer. */
  observedAt?: number;
  fixture?: boolean;
  busy?: boolean;
  actionsDisabled?: boolean;
  onInspectWork?: (workID: string) => void;
  onCancelTurn?: (turnID: string) => void;
}

function ActivityIcon({ state, size = 15 }: { state: AgentActivityState; size?: number }) {
  if (state === 'accepted' || state === 'responded') return <Check size={size} aria-hidden="true"/>;
  if (['unknown', 'stale', 'needs_input', 'failed'].includes(state)) return <CircleAlert size={size} aria-hidden="true"/>;
  if (state === 'cancelled') return <Square size={size} aria-hidden="true"/>;
  if (state === 'verifying') return <Search size={size} aria-hidden="true"/>;
  if (state === 'running') return <MessageCircle size={size} aria-hidden="true"/>;
  return <Clock3 size={size} aria-hidden="true"/>;
}

export function AgentStatus({ model: projectedModel, ghostID, observedAt, fixture, busy = false, actionsDisabled = false, onInspectWork, onCancelTurn }: AgentStatusProps) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [panelBounds, setPanelBounds] = useState<{ placement: 'above' | 'below'; availableHeight: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const panelID = `agent-status-${id}`;
  const headingID = `${panelID}-heading`;
  const model = !fixture && observedAt !== undefined && now - observedAt > 15_000 && projectedModel.state !== 'loading'
    ? { ...projectedModel, state: 'unknown' as const, label: '최신 상태 확인 필요', detail: '마지막으로 읽은 기록입니다.', activityCount: 0 }
    : projectedModel;
  const current = model.state !== 'unknown' && model.state !== 'stale';
  const moving = current && ['running', 'verifying', 'loading'].includes(model.state);
  const ticking = Boolean((!fixture && observedAt !== undefined)
    || (current && (model.current?.runningClock || open && model.observations.some(item => item.runningClock))));

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const viewport = window.visualViewport;
    const measure = () => {
      if (!root.current || !panel.current) return;
      const anchor = root.current.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const gap = Number.parseFloat(getComputedStyle(root.current).getPropertyValue('--space-xs')) || 8;
      if (anchor.bottom <= top || anchor.top >= bottom) { setOpen(false); return; }
      const below = Math.max(0, bottom - anchor.bottom - gap * 2);
      const above = Math.max(0, anchor.top - top - gap * 2);
      const desired = panel.current.scrollHeight + 2;
      const placement = below >= desired || below >= above ? 'below' : 'above';
      const availableHeight = Math.floor(placement === 'below' ? below : above);
      setPanelBounds(previous => previous?.placement === placement && previous.availableHeight === availableHeight
        ? previous : { placement, availableHeight });
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    // Capture also observes scrollable ancestors, without moving focus or scrolling the page.
    window.addEventListener('scroll', scheduleMeasure, true);
    window.addEventListener('resize', scheduleMeasure);
    viewport?.addEventListener('resize', scheduleMeasure);
    viewport?.addEventListener('scroll', scheduleMeasure);
    const observer = new ResizeObserver(scheduleMeasure);
    if (root.current) observer.observe(root.current);
    if (panel.current) observer.observe(panel.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', scheduleMeasure, true);
      window.removeEventListener('resize', scheduleMeasure);
      viewport?.removeEventListener('resize', scheduleMeasure);
      viewport?.removeEventListener('scroll', scheduleMeasure);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });
    const close = (restoreFocus: boolean) => {
      setOpen(false);
      if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        close(Boolean(panel.current?.contains(document.activeElement)));
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
    };
    const focusOutside = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    document.addEventListener('focusin', focusOutside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('focusin', focusOutside);
    };
  }, [open]);

  const closePanel = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const observations = (model.current ? [model.current, ...model.observations.filter(item => item.id !== model.current!.id)] : model.observations).slice(0, 8);
  // Status announcements contain no clock values. Clock updates stay outside the live region.
  const announcement = `${fixture ? '예시 모드. ' : ''}${model.label}${model.detail ? `. ${model.detail}` : ''}`;
  const elapsed = elapsedAgentTime(model.current, now, current);

  function observationActions(item: AgentObservation) {
    const inspect = item.workID && onInspectWork;
    const cancel = item.cancelTurnID && onCancelTurn && current;
    if (!inspect && !cancel) return null;
    return <div className="agent-status-record-actions">
      {inspect && <button type="button" className="agent-status-action" disabled={busy || actionsDisabled}
        aria-label={`이 작업 상태 확인 · ${item.label}`} onClick={() => onInspectWork!(item.workID!)}><Search size={13} aria-hidden="true"/>상태 확인</button>}
      {cancel && <button type="button" className="agent-status-action" disabled={busy || actionsDisabled}
        aria-label={`이 응답 취소 요청 · ${item.label}`} onClick={() => onCancelTurn!(item.cancelTurnID!)}><Square size={12} aria-hidden="true"/>응답 취소</button>}
    </div>;
  }

  return <div ref={root} className="agent-status" data-state={model.state} data-moving={moving || undefined}>
    <span className="agent-status-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    <button ref={trigger} type="button" className="agent-status-trigger" aria-expanded={open} aria-controls={panelID}
      aria-haspopup="dialog" onClick={() => setOpen(value => !value)} title={model.label}>
      <span className="agent-status-mark" aria-hidden="true"><span className="agent-status-ring"/><DotAvatar size={28} profileId={ghostID}/></span>
      <span className="agent-status-activity-icon"><ActivityIcon state={model.state}/></span>
      <span className="agent-status-label">{model.label}</span>
      <span className="agent-status-time" aria-hidden="true" title={elapsed === '—' ? '호스트 시간 기록 없음' : '응답 접수 후 경과'}>{elapsed}</span>
      <ChevronDown size={13} className="agent-status-chevron" aria-hidden="true"/>
    </button>
    {open && <div ref={panel} id={panelID} className="agent-status-popover" data-placement={panelBounds?.placement ?? 'below'}
      style={panelBounds ? { maxBlockSize: `min(32rem, ${panelBounds.availableHeight}px)` } : undefined}
      role="dialog" aria-modal="false" aria-labelledby={headingID} tabIndex={-1}>
      <header className="agent-status-panel-heading">
        <h4 id={headingID}>Ghost 상태{fixture && <span>예시</span>}</h4>
        <button type="button" className="agent-status-close" aria-label="상태 패널 닫기" onClick={closePanel}><X size={16} aria-hidden="true"/></button>
      </header>
      <div className="agent-status-current"><ActivityIcon state={model.state} size={16}/><strong>{model.label}</strong></div>
      {model.detail && <p className="agent-status-detail">{model.detail}</p>}
      {observations.length > 0 && <>
        <p className="agent-status-record-heading">확인한 기록{model.activityCount > 1 && <span>진행 {model.activityCount}개</span>}</p>
        <ul className="agent-status-records">
          {observations.map(item => <li key={item.id} className="agent-status-record" data-record-state={item.state}>
            <span className="agent-status-record-icon"><ActivityIcon state={item.state} size={14}/></span>
            <div className="agent-status-record-copy">
              <div><span>{item.kind === 'response' ? '응답' : item.kind === 'goal' ? '목표' : '맡긴 일'}</span><time title={item.startedAt === null ? '호스트 시간 기록 없음' : '응답 접수 후 경과'}>{elapsedAgentTime(item, now, current)}</time></div>
              <strong>{item.label}</strong>
              {item.detail && <p>{item.detail}</p>}
              {observationActions(item)}
            </div>
          </li>)}
        </ul>
        {model.observations.length > observations.length && <p className="agent-status-detail">다른 기록은 아래 대화와 맡긴 일에서 확인할 수 있습니다.</p>}
      </>}
      {busy && <p className="agent-status-action-pending" role="status">요청 결과 확인 중</p>}
    </div>}
  </div>;
}
