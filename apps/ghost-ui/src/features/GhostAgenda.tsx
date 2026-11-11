import { useState } from 'react';
import { ArrowRight, Clock3, Moon, Pause, Play } from 'lucide-react';
import type { Ghost, State } from '@ghost/contract';
import { Popover, PopoverContent, PopoverTrigger } from '../ui';
import { useHost } from '../host/context';
import { specLabel } from './Schedules';
import { uiTerms } from '../uiText';

const when = (at: number) => new Date(at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** One upcoming thing on a Ghost's agenda. Pure rows so tests can pin the order. */
export type AgendaItem =
  | { kind: 'schedule'; id: string; at: number | null; title: string; detail: string; paused: boolean }
  | { kind: 'activity'; id: string; at: number | null; title: string; detail: string; paused: boolean }
  | { kind: 'plan'; id: string; at: number; title: string; detail: string; paused: false };

/**
 * What this Ghost will do on its own next: the owner's schedules, its automatic activities and its own
 * planned look, soonest first; paused ones last. Finished schedules and deleted activities leave.
 */
export function ghostAgenda(state: State, ghostId: string): AgendaItem[] {
  const items: AgendaItem[] = [];
  for (const schedule of state.schedules) {
    if (schedule.ghostId !== ghostId || schedule.state === 'done') continue;
    items.push({ kind: 'schedule', id: schedule.id, at: schedule.nextAt, title: schedule.prompt, detail: specLabel(schedule.spec), paused: schedule.state === 'paused' });
  }
  for (const activity of state.activities ?? []) {
    if (activity.ghostId !== ghostId || activity.deletedAt !== null) continue;
    items.push({ kind: 'activity', id: activity.id, at: activity.paused ? null : activity.nextAt, title: activity.name, detail: uiTerms.activities, paused: activity.paused });
  }
  const plan = state.autonomy?.find(item => item.ghostId === ghostId);
  if (plan?.enabled && plan.nextAt !== null) items.push({ kind: 'plan', id: `plan:${ghostId}`, at: plan.nextAt, title: plan.intent || '스스로 다음 할 일을 살핍니다', detail: '스스로 확인', paused: false });
  return items.sort((a, b) => Number(a.paused) - Number(b.paused) || (a.at ?? Infinity) - (b.at ?? Infinity));
}

/**
 * The clock under the thread button: this Ghost's agenda in the same kind of popover as its threads.
 * 2026.11.11 : 예약은 설정 화면에만 있어 대화하다가 「이 Ghost 가 언제 무엇을 하나」를 보려면 화면을 떠나야 했다.
 */
export function GhostAgenda({ ghost, state, navigate }: { ghost: Ghost; state: State; navigate(path: string): void }) {
  const { client } = useHost();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState('');
  const items = ghostAgenda(state, ghost.id);
  const waiting = items.filter(item => !item.paused && item.kind !== 'plan').length;
  const plan = state.autonomy?.find(item => item.ghostId === ghost.id);
  const offDuty = state.duty ? !state.duty.onDuty : false;
  const go = (path: string) => () => { setOpen(false); navigate(path); };
  const toggle = async (scheduleId: string, paused: boolean) => {
    setPending(scheduleId);
    try { await client.send({ type: 'schedule.update', scheduleId, paused }); }
    finally { setPending(''); }
  };
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" className="chat-threads chat-agenda" data-live={waiting > 0 || undefined}
        aria-label={`예약${waiting ? `, ${waiting}건` : ''}`} title="예약">
        <Clock3 aria-hidden="true"/>{waiting > 0 && <span className="tabular" aria-hidden="true">{waiting}</span>}
      </button>
    </PopoverTrigger>
    <PopoverContent side="bottom" align="end" aria-label={`${ghost.name} 예약`} className="grid w-80 gap-0.5 p-1.5">
      {offDuty && <p className="agenda-note"><Moon aria-hidden="true"/>퇴근 중이라 출근할 때까지 실행하지 않습니다.</p>}
      <div className="max-h-[60dvh] overflow-y-auto">
        {items.map(item => <div key={item.id} className="agenda-row" data-paused={item.paused || undefined} data-kind={item.kind}>
          <div className="min-w-0 flex-1">
            <p className="agenda-row__title" title={item.title}>{item.title}</p>
            <p className="agenda-row__meta">
              <span>{item.detail}</span>
              {item.paused ? <span>일시정지</span> : item.at !== null && <time className="tabular" dateTime={new Date(item.at).toISOString()}>{when(item.at)}</time>}
            </p>
          </div>
          {item.kind === 'schedule' && <button type="button" className="shell-icon-button" disabled={pending !== ''}
            aria-label={item.paused ? '예약 재개' : '예약 일시정지'} title={item.paused ? '재개' : '일시정지'}
            onClick={() => void toggle(item.id, !item.paused)}>{item.paused ? <Play aria-hidden="true"/> : <Pause aria-hidden="true"/>}</button>}
        </div>)}
        {!items.length && <p className="m-0 px-2 py-3 text-caption text-ink-3">{plan && !plan.enabled ? '예약 없음 · 말을 걸 때만 움직입니다' : '예약 없음'}</p>}
      </div>
      <div className="mt-1 grid border-t border-line pt-1">
        <button type="button" className="menu-row" onClick={go('/settings?tab=schedules')}>{uiTerms.schedules}<ArrowRight size={13} className="ml-auto" aria-hidden="true"/></button>
        <button type="button" className="menu-row" onClick={go('/settings?tab=activities')}>{uiTerms.activities}<ArrowRight size={13} className="ml-auto" aria-hidden="true"/></button>
      </div>
    </PopoverContent>
  </Popover>;
}
