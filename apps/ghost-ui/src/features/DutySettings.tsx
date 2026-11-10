import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { DutyHours } from '@ghost/contract';
import { Button, Checkbox, InlineError, Input, SettingsGroup, SettingsRow, Switch } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const DEFAULT_HOURS: DutyHours = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] };
const clock = (at: number) => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * 근무 시간표. 시간표 밖에서는 모든 Ghost 가 스스로 새 일을 시작하지 않는다.
 * 제목 표시줄의 원버튼은 다음 시간표 경계까지만 시간표를 덮는다.
 */
export function DutySettings() {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const duty = state?.duty;
  const [draft, setDraft] = useState<DutyHours | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => { if (duty) setDraft(duty.hours); }, [duty?.hours?.start, duty?.hours?.end, duty?.hours?.days.join(',')]);
  if (!duty) return <p className="m-0 text-caption text-ink-3">이 Host 는 근무 시간을 지원하지 않습니다.</p>;

  const run = async (work: () => Promise<unknown>, done: string) => {
    setPending(true); setError(''); setNotice('');
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '저장하지 못했습니다.'); }
    finally { setPending(false); }
  };
  const save = (hours: DutyHours | null) => run(() => client.send({ type: 'duty.hours', hours }), hours ? '근무 시간표를 저장했습니다.' : '시간표를 껐습니다. 이제 원버튼으로만 바뀝니다.');
  const valid = draft === null || (draft.days.length > 0 && /^\d\d:\d\d$/.test(draft.start) && /^\d\d:\d\d$/.test(draft.end));
  const dirty = JSON.stringify(draft) !== JSON.stringify(duty.hours);

  return <section className="flex min-w-0 flex-col gap-6" aria-label="근무 시간">
    <SettingsGroup title="지금">
      <SettingsRow label={duty.onDuty ? '근무 중' : '퇴근'}
        description={<>
          {duty.onDuty ? 'Ghost들이 자율 깨우기 · 예약 · 활동 규칙으로 스스로 일합니다.' : 'Ghost들이 새 일을 스스로 시작하지 않습니다. 진행 중인 일은 마저 끝내고, 그동안 때가 된 예약은 출근하면 한 번씩 돕니다.'}
          {duty.nextChangeAt !== null && <span className="mt-0.5 block">{clock(duty.nextChangeAt)}에 {duty.onDuty ? '퇴근' : '출근'}합니다{duty.override ? ' (직접 바꾼 상태가 끝나는 때)' : ''}.</span>}
        </>}>
        <Button variant="outline" type="button" disabled={pending} onClick={() => void run(() => client.send({ type: 'duty.switch', onDuty: !duty.onDuty }), duty.onDuty ? '퇴근했습니다.' : '출근했습니다.')}>
          {duty.onDuty ? '퇴근하기' : '출근하기'}
        </Button>
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup title="근무 시간표">
      <SettingsRow label="시간표 사용" description="정해 둔 시간에 저절로 출근 · 퇴근합니다. 끄면 원버튼으로만 바뀝니다." htmlFor="duty-hours-enabled">
        <Switch id="duty-hours-enabled" checked={draft !== null} disabled={pending} onCheckedChange={on => setDraft(on ? duty.hours ?? DEFAULT_HOURS : null)}/>
      </SettingsRow>
      {draft && <>
        <SettingsRow label="출근 · 퇴근 시각" description="퇴근 시각이 출근 시각보다 이르면 자정을 넘는 근무입니다.">
          <span className="flex items-center gap-2">
            <Input type="time" aria-label="출근 시각" className="w-[120px]" value={draft.start} disabled={pending} onChange={event => setDraft({ ...draft, start: event.target.value })}/>
            <span aria-hidden="true">–</span>
            <Input type="time" aria-label="퇴근 시각" className="w-[120px]" value={draft.end} disabled={pending} onChange={event => setDraft({ ...draft, end: event.target.value })}/>
          </span>
        </SettingsRow>
        <SettingsRow label="근무 요일" description="근무가 시작하는 요일입니다.">
          <span className="flex flex-wrap items-center gap-3" role="group" aria-label="근무 요일">
            {DAYS.map((name, day) => <label key={day} className="flex items-center gap-1.5 text-ui">
              <Checkbox checked={draft.days.includes(day)} disabled={pending}
                onCheckedChange={checked => setDraft({ ...draft, days: checked ? [...draft.days, day].sort() : draft.days.filter(item => item !== day) })}/>
              {name}
            </label>)}
          </span>
        </SettingsRow>
      </>}
    </SettingsGroup>
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 flex items-start gap-1.5 text-caption text-success" role="status"><Check size={14} className="mt-0.5 flex-none"/>{notice}</p>}
    <div className="flex justify-end">
      <Button type="button" disabled={pending || !dirty || !valid} onClick={() => void save(draft)}>저장</Button>
    </div>
  </section>;
}
