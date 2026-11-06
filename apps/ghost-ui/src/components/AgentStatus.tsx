import { useEffect, useState } from 'react';
import { Check, CircleAlert, Clock3, MessageCircle, Search, Square, X } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@garden/ui';
import { DotAvatar } from './DotAvatar';
import { elapsedAgentTime } from '../lifetime/agentStatus';
import type { AgentActivityState, AgentObservation, AgentStatusModel } from '../lifetime/agentStatus';

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

const activityInk: Partial<Record<AgentActivityState, string>> = {
  unknown: 'text-orange',
  stale: 'text-orange',
  needs_input: 'text-orange',
  failed: 'text-red',
  accepted: 'text-green',
  responded: 'text-green',
};

export function AgentStatus({ model: projectedModel, ghostID, observedAt, fixture, busy = false, actionsDisabled = false, onInspectWork, onCancelTurn }: AgentStatusProps) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const model = !fixture && observedAt !== undefined && now - observedAt > 15_000 && projectedModel.state !== 'loading'
    ? { ...projectedModel, state: 'unknown' as const, label: '최신 상태 확인 필요', detail: '마지막으로 읽은 기록입니다.' }
    : projectedModel;
  const current = model.state !== 'unknown' && model.state !== 'stale';
  const moving = current && ['running', 'verifying', 'loading'].includes(model.state);
  const ink = activityInk[model.state] ?? 'text-ink-2';
  const ringDashed = model.state === 'queued' || model.state === 'unknown' || model.state === 'stale';
  const ticking = Boolean((!fixture && observedAt !== undefined)
    || (current && (model.current?.runningClock || open && model.observations.some(item => item.runningClock))));

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const observations = (model.current ? [model.current, ...model.observations.filter(item => item.id !== model.current!.id)] : model.observations).slice(0, 8);
  // Status announcements contain no clock values. Clock updates stay outside the live region.
  const announcement = `${fixture ? '예시 모드. ' : ''}${model.label}${model.detail ? `. ${model.detail}` : ''}`;
  const elapsed = elapsedAgentTime(model.current, now, current);
  // The list already names the current activity; repeat the summary only when it says something else.
  const summary = !model.current || model.label !== model.current.label;

  function observationActions(item: AgentObservation) {
    const inspect = item.workID && onInspectWork;
    const cancel = item.cancelTurnID && onCancelTurn && current;
    if (!inspect && !cancel) return null;
    return <div className="mt-2 flex flex-wrap gap-2">
      {inspect && <Button type="button" variant="outline" size="sm" disabled={busy || actionsDisabled}
        aria-label={`이 작업 상태 확인 · ${item.label}`} onClick={() => onInspectWork!(item.workID!)}><Search size={13} aria-hidden="true"/>상태 확인</Button>}
      {cancel && <Button type="button" variant="outline" size="sm" disabled={busy || actionsDisabled}
        aria-label={`응답 취소 · ${item.subject ?? item.label}`} onClick={() => onCancelTurn!(item.cancelTurnID!)}>응답 취소</Button>}
    </div>;
  }

  return <div className="relative min-w-0 max-w-full text-ink sm:max-w-96">
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" title={model.label}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2 min-h-12 rounded-full border border-line bg-surface py-1 pr-3 pl-2 text-left whitespace-nowrap shadow-btn transition-[background-color,color] outline-none hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink-3 active:translate-y-px">
          <span className="relative grid size-8.5 shrink-0 place-items-center" aria-hidden="true">
            <span className={`absolute inset-0 rounded-full border-[1.5px] ${ringDashed ? 'border-dashed' : ''} ${moving ? 'border-t-ink border-r-ink border-line animate-[spin_2.4s_linear_infinite] motion-reduce:animate-none' : 'border-line'}`}/>
            <DotAvatar size={28} profileId={ghostID}/>
          </span>
          <span className={`inline-flex shrink-0 ${ink}`}><ActivityIcon state={model.state}/></span>
          <span className="min-w-0 flex-1 overflow-hidden font-medium text-ui text-ink [text-overflow:ellipsis]">{model.label}</span>
          {elapsed && <span className="shrink-0 text-ui text-ink-2 [font-variant-numeric:tabular-nums]" aria-hidden="true" title="요청 후 경과">{elapsed}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Ghost 상태" className="grid w-80 max-w-[calc(100vw-1rem)] gap-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="flex items-center gap-2 text-ui font-semibold text-ink">Ghost 상태{fixture && <span className="font-normal text-caption text-orange">예시</span>}</h4>
          <Button type="button" variant="ghost" size="icon" aria-label="상태 패널 닫기" onClick={() => setOpen(false)}><X size={16} aria-hidden="true"/></Button>
        </div>
        {summary && <div className={`flex items-start gap-2 text-ui ${ink}`}><ActivityIcon state={model.state} size={16}/><strong className="font-medium [overflow-wrap:anywhere]">{model.label}</strong></div>}
        {summary && model.detail && <p className="text-caption leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{model.detail}</p>}
        {observations.length > 0 && <>
          <ul className="grid list-none p-0">
            {observations.map(item => {
              const itemElapsed = elapsedAgentTime(item, now, current);
              return <li key={item.id} className="flex min-w-0 gap-2 border-t border-line py-2 first:border-t-0 first:pt-0">
                <span className={`flex shrink-0 pt-0.5 ${activityInk[item.state] ?? 'text-ink-2'}`}><ActivityIcon state={item.state} size={14}/></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <strong className="min-w-0 font-medium text-ui [overflow-wrap:anywhere]">{item.label}</strong>
                    {itemElapsed && <time className="shrink-0 text-caption text-ink-2 [font-variant-numeric:tabular-nums]" title="요청 후 경과">{itemElapsed}</time>}
                  </div>
                  {item.subject && <p className="truncate text-caption text-ink-2" title={item.subject}>{item.subject}</p>}
                  {item.detail && <p className="text-caption leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{item.detail}</p>}
                  {observationActions(item)}
                </div>
              </li>;
            })}
          </ul>
          {model.observations.length > observations.length && <p className="text-caption leading-relaxed text-ink-2">다른 기록은 아래 대화와 맡긴 일에서 확인할 수 있습니다.</p>}
        </>}
        {busy && <p className="text-caption text-ink-2" role="status">요청 결과 확인 중</p>}
      </PopoverContent>
    </Popover>
  </div>;
}
