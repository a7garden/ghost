import { useState } from 'react';
import { Clock3, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, FormField, InlineError, Input, SegmentedControl, SelectField, SettingsGroup, SettingsRow, Textarea } from '../ui'
import type { Schedule, ScheduleSpec } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { uiTerms } from '../uiText';

const dateTime = (ms: number) => new Date(ms).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const pad = (n: number) => String(n).padStart(2, '0');

/** Epoch ms → `datetime-local` input value, in the browser's zone. */
export const toLocalInput = (ms: number) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
/** `datetime-local` input value → epoch ms; null when the field is empty or unparsable. */
export const fromLocalInput = (value: string): number | null => {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

/** 3600 → '1시간', 5400 → '1시간 30분', 90 → '1분 30초'. */
export function intervalLabel(seconds: number): string {
  const parts: string[] = [];
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  if (hours) parts.push(`${hours}시간`);
  if (minutes) parts.push(`${minutes}분`);
  if (rest && !hours) parts.push(`${rest}초`);
  return parts.join(' ') || '0초';
}

export function specLabel(spec: ScheduleSpec): string {
  return spec.kind === 'at' ? `${dateTime(spec.at)}에 한 번` : `${intervalLabel(spec.seconds)}마다`;
}

export const scheduleStateLabel: Record<Schedule['state'], string> = { active: '대기 중', paused: '일시정지', done: '완료' };
const scheduleTone: Record<Schedule['state'], 'outline' | 'warning' | 'success'> = { active: 'outline', paused: 'warning', done: 'success' };

/** 예약된 반복 작업 목록. 만들기·일시정지·재개·삭제는 schedule.create · schedule.update · schedule.delete로 저장한다. */
export function Schedules({ ghostId }: { ghostId?: string }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const ghosts = state?.ghosts ?? [];
  const schedules = (state?.schedules ?? []).filter(schedule => !ghostId || schedule.ghostId === ghostId)
    .sort((a, b) => (a.nextAt ?? a.createdAt) - (b.nextAt ?? b.createdAt));
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [remove, setRemove] = useState<Schedule>();
  const ghostName = (id: string) => ghosts.find(ghost => ghost.id === id)?.name ?? id;
  const run = async (label: string, work: () => Promise<unknown>, done: string) => {
    setPending(label); setError(''); setNotice('');
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); }
    finally { setPending(''); }
  };
  return <section className="flex min-w-0 flex-col gap-6" aria-label={uiTerms.schedules}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="section-title">{uiTerms.schedules}</h2>
      <Button type="button" disabled={!state} onClick={() => setCreating(true)}><Plus size={15}/>반복 작업 예약</Button>
    </div>
    {schedules.length
      ? <SettingsGroup title={<span className="sr-only">{uiTerms.schedules}</span>}>{schedules.map(schedule => <SettingsRow key={schedule.id}
        label={<span className="flex min-w-0 flex-col gap-1.5">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {!ghostId && <Badge variant="outline">{ghostName(schedule.ghostId)}</Badge>}
            <Badge variant={scheduleTone[schedule.state]}>{scheduleStateLabel[schedule.state]}</Badge>
            <span className="text-caption font-normal text-ink-3">{specLabel(schedule.spec)}</span>
          </span>
          <span className="text-ui font-medium text-ink [overflow-wrap:anywhere]">{schedule.prompt}</span>
        </span>}
        description={schedule.nextAt ? `다음 실행 · ${dateTime(schedule.nextAt)}` : '다음 실행 없음'}>
        <span className="flex items-center gap-1">
          {schedule.state !== 'done' && (schedule.state === 'paused'
            ? <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} onClick={() => void run(schedule.id, () => client.send({ type: 'schedule.update', scheduleId: schedule.id, paused: false }), '반복 작업을 재개했습니다.')}><Play size={14}/>재개</Button>
            : <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} onClick={() => void run(schedule.id, () => client.send({ type: 'schedule.update', scheduleId: schedule.id, paused: true }), '반복 작업을 일시정지했습니다.')}><Pause size={14}/>일시정지</Button>)}
          <Button variant="ghost" size="icon" type="button" aria-label="반복 작업 삭제" disabled={pending !== ''} onClick={() => { setError(''); setRemove(schedule); }}><Trash2 size={15}/></Button>
        </span>
      </SettingsRow>)}</SettingsGroup>
      : state && <div className="calm"><Clock3 size={16} aria-hidden="true"/><p>예약된 반복 작업 없음</p></div>}
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    {creating && <ScheduleCreateDialog fixedGhostId={ghostId} onClose={() => setCreating(false)} onCreate={async input => {
      await client.send({ type: 'schedule.create', ...input });
      setCreating(false);
    }}/>}
    {remove && <Modal title="반복 작업 삭제" onClose={() => pending === '' && setRemove(undefined)}>
      <p className="m-0">이 반복 작업을 삭제할까요? 예약된 실행도 함께 사라집니다.</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => setRemove(undefined)}>취소</Button>
        <Button variant="destructive" type="button" disabled={pending !== ''} onClick={() => void run('delete', async () => { await client.send({ type: 'schedule.delete', scheduleId: remove.id }); setRemove(undefined); }, '반복 작업을 삭제했습니다.')}>삭제</Button>
      </div>
    </Modal>}
  </section>;
}

function ScheduleCreateDialog({ fixedGhostId, onClose, onCreate }: {
  fixedGhostId?: string;
  onClose(): void;
  onCreate(input: { ghostId: string; prompt: string; spec: ScheduleSpec }): Promise<void>;
}) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const ghosts = state?.ghosts ?? [];
  const [ghostKey, setGhostKey] = useState(fixedGhostId ?? ghosts[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'at' | 'every'>('at');
  const [at, setAt] = useState(() => toLocalInput(Date.now() + 3600_000));
  const [minutes, setMinutes] = useState('30');
  const [startAt, setStartAt] = useState(() => toLocalInput(Date.now()));
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const save = async () => {
    if (!ghostKey || !prompt.trim() || saving) return;
    const atMs = fromLocalInput(at), startMs = fromLocalInput(startAt);
    const spec: ScheduleSpec | null = mode === 'at'
      ? (atMs !== null ? { kind: 'at', at: atMs } : null)
      : (Number(minutes) >= 1 && Number.isFinite(Number(minutes)) ? { kind: 'every', seconds: Math.round(Number(minutes) * 60), startAt: startMs ?? Date.now() } : null);
    if (!spec) { setError(mode === 'at' ? '실행할 시각을 확인해 주세요.' : '반복 간격은 1분 이상이어야 합니다.'); return; }
    setSaving(true); setError('');
    try { await onCreate({ ghostId: ghostKey, prompt: prompt.trim(), spec }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '반복 작업을 예약하지 못했습니다.'); setSaving(false); }
  };
  return <Modal title="반복 작업 예약" onClose={() => !saving && onClose()} className="w-[min(560px,calc(100vw-2rem))] sm:max-w-[560px]">
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      {!fixedGhostId && <FormField label="Ghost">
        {control => <SelectField {...control} label="Ghost" value={ghostKey} disabled={saving || !ghosts.length} onValueChange={setGhostKey}
          options={ghosts.map(ghost => ({ value: ghost.id, label: ghost.name }))}/>}
      </FormField>}
      <FormField label="실행할 내용" description="예약 시각에 Ghost의 대화로 전달됩니다.">
        {control => <Textarea {...control} value={prompt} onChange={event => setPrompt(event.target.value)} required rows={4} maxLength={8192} disabled={saving}/>}
      </FormField>
      <SegmentedControl aria-label="실행 방식" value={mode} onValueChange={value => setMode(value as 'at' | 'every')}
        options={[{ value: 'at', label: '지정 시각' }, { value: 'every', label: '반복 간격' }]}/>
      {mode === 'at'
        ? <FormField label="실행 시각">{control => <Input {...control} type="datetime-local" value={at} disabled={saving} onChange={event => setAt(event.target.value)}/>}</FormField>
        : <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="반복 간격 (분)" description="1분 이상.">
            {control => <Input {...control} type="number" min={1} step={1} value={minutes} disabled={saving} onChange={event => setMinutes(event.target.value)}/>}
          </FormField>
          <FormField label="시작 시각">{control => <Input {...control} type="datetime-local" value={startAt} disabled={saving} onChange={event => setStartAt(event.target.value)}/>}</FormField>
        </div>}
      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={saving} onClick={onClose}>취소</Button>
        <Button type="submit" disabled={saving || !prompt.trim() || !ghostKey}>{saving ? '예약 중…' : '예약'}</Button>
      </div>
    </form>
  </Modal>;
}
