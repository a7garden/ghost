import { useId, useState, type ReactNode } from 'react';
import { Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, InlineError, SkeletonRows } from '../ui';
import type { Schedule, ScheduleSpec } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { visibleGhosts } from './ghostState';
import { uiTerms } from '../uiText';
import { mainForRule, restoreRuleFocus, ruleError, ruleKeys, TellRule } from './standing-rules';

const dateTime = (ms: number) => new Date(ms).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const beatDate = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  if (rest) parts.push(`${rest}초`);
  return parts.join(' ') || '0초';
}

export function specLabel(spec: ScheduleSpec): string {
  return spec.kind === 'at' ? `${dateTime(spec.at)}에 한 번` : `${intervalLabel(spec.seconds)}마다`;
}

export const scheduleStateLabel: Record<Schedule['state'], string> = { active: '대기 중', paused: '일시정지', done: '완료' };
const scheduleTone: Record<Schedule['state'], 'outline' | 'warning' | 'success'> = { active: 'outline', paused: 'warning', done: 'success' };

/** Make and edit the same time rule that appears in the list. A wake goes to the Ghost's conversation. */
export function Schedules({ ghostId }: { ghostId?: string }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const ghosts = state?.ghosts ?? [];
  const schedules = (state?.schedules ?? []).filter(schedule => !ghostId || schedule.ghostId === ghostId)
    .sort((a, b) => (a.nextAt ?? a.createdAt) - (b.nextAt ?? b.createdAt));
  const [editor, setEditor] = useState<'create' | 'tell' | Schedule | null>(null);
  const main = mainForRule(state, 'schedule_create');
  const talkingGhost = main && (!ghostId || main.id === ghostId) ? main : undefined;
  const controls = useId();
  const createId = `${controls}-create`, tellId = `${controls}-tell`;
  const editing = editor && typeof editor === 'object' ? editor : null;
  const shownSchedules = editing && !schedules.some(schedule => schedule.id === editing.id) ? [...schedules, editing] : schedules;
  const closeEditor = () => {
    setEditor(null);
    restoreRuleFocus(editing ? `${controls}-${editing.id}` : editor === 'tell' ? tellId : createId, createId);
  };
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [remove, setRemove] = useState<Schedule>();
  const ghostName = (id: string) => ghosts.find(ghost => ghost.id === id)?.name ?? id;
  const run = async (label: string, work: () => Promise<unknown>, done: string) => {
    setPending(label); setError(''); setNotice('');
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); }
    finally { setPending(''); }
  };
  return <section className="rule-layout" aria-label={uiTerms.schedules}>
    <div className="settings-section-header flex flex-wrap items-center justify-between gap-3">
      <h2 className="section-title">{uiTerms.schedules}</h2>
      {editor === null && <div className="rule-actions">
        {talkingGhost && <Button id={tellId} variant="ghost" type="button" onClick={() => setEditor('tell')}>{talkingGhost.name}에게 말하기</Button>}
        <Button id={createId} variant="add" type="button" disabled={!state} onClick={() => setEditor('create')}><Plus size={15}/>반복 작업 예약</Button>
      </div>}
    </div>
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    {!state ? <SkeletonRows label="반복 작업을 불러오는 중…" rows={2}/> : <>
      {editor === 'create' && <ScheduleRuleEditor fixedGhostId={ghostId} onClose={closeEditor} onSave={async input => {
        await client.send({ type: 'schedule.create', ...input });
        closeEditor();
      }}/>}
      {editor === 'tell' && <TellRule main={talkingGhost} label="예약하고 싶은 일"
        placeholder="언제 어떤 일을 할까요?"
        consequence={`${talkingGhost?.name ?? '메인 Ghost'}의 대화에 바로 예약할 수 있습니다. 반복 시작 시각을 정하려면 직접 예약해 주세요.`}
        requestText={words => `아래 요청을 이 대화에 schedule_create로 예약해 줘. 내 시간대는 ${Intl.DateTimeFormat().resolvedOptions().timeZone}야. 시각이나 간격이 모호하면 예약하기 전에 먼저 물어봐.\n\n${words}`}
        onClose={closeEditor}/>}
      {shownSchedules.length > 0
        ? <ul className="rule-list">{shownSchedules.map(schedule => <li key={schedule.id}>
          {editing?.id === schedule.id
            ? <ScheduleRuleEditor schedule={editing} onClose={closeEditor} onSave={async ({ prompt, spec }) => {
              if (prompt !== editing.prompt || spec !== editing.spec) await client.send({ type: 'schedule.update', scheduleId: editing.id, prompt, spec });
              closeEditor();
            }}/>
            : <article className="rule-sheet">
              <ScheduleRule beats={<ScheduleBeats spec={schedule.spec}/>} recipient={ghostName(schedule.ghostId)}
                message={<p className="rule-message">{schedule.prompt}</p>}/>
              <div className="schedule-rule__tail rule-actions rule-actions--spread">
                <div className="rule-actions">
                  <Badge variant={scheduleTone[schedule.state]}>{scheduleStateLabel[schedule.state]}</Badge>
                  {schedule.state === 'active' && <p className="rule-facts">{schedule.nextAt ? `다음 실행 · ${dateTime(schedule.nextAt)}` : '다음 실행 없음'}</p>}
                </div>
                <div className="rule-actions">
                  {schedule.state !== 'done' && <>
                    {schedule.state === 'paused'
                      ? <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} onClick={() => void run(schedule.id, () => client.send({ type: 'schedule.update', scheduleId: schedule.id, paused: false }), '반복 작업을 재개했습니다.')}><Play size={14}/>재개</Button>
                      : <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} onClick={() => void run(schedule.id, () => client.send({ type: 'schedule.update', scheduleId: schedule.id, paused: true }), '반복 작업을 일시정지했습니다.')}><Pause size={14}/>일시정지</Button>}
                    <Button id={`${controls}-${schedule.id}`} variant="ghost" size="icon" type="button" aria-label="반복 작업 편집"
                      disabled={pending !== '' || editor !== null} onClick={() => { setError(''); setEditor(schedule); }}><Pencil size={15}/></Button>
                  </>}
                  <Button variant="ghost" size="icon" type="button" aria-label="반복 작업 삭제" disabled={pending !== ''} onClick={() => { setError(''); setRemove(schedule); }}><Trash2 size={15}/></Button>
                </div>
              </div>
            </article>}
        </li>)}</ul>
        : editor === null && <p className="rule-facts">예약된 반복 작업 없음</p>}
    </>}
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

/** Use the same first beat, cadence extension, and recipient line in both modes. */
function ScheduleRule({ beats, recipient, message }: { beats: ReactNode; recipient: ReactNode; message: ReactNode }) {
  return <div className="rule-layout">
    <div className="schedule-rule__beats">{beats}</div>
    <div className="schedule-rule__delivery">
      <div className="schedule-rule__target rule-inline">{recipient}의 대화로</div>
      {message}
    </div>
  </div>;
}

function ScheduleBeats({ spec }: { spec: ScheduleSpec }) {
  const first = spec.kind === 'at' ? spec.at : spec.startAt;
  return <>
    <span className="schedule-rule__beat"><time dateTime={new Date(first).toISOString()}>{beatDate.format(first)}</time>{spec.kind === 'at' ? '에 한 번' : '부터'}</span>
    {spec.kind === 'every' && <span className="schedule-rule__beat schedule-rule__beat--repeat"><strong>{intervalLabel(spec.seconds)}</strong>마다</span>}
  </>;
}

type ScheduleTiming = { mode: ScheduleSpec['kind']; at: string; startAt: string; minutes: string };

/** Keep an unchanged schedule exact, even though the time input shows only wall-clock minutes. */
export function scheduleTimingSpec(timing: ScheduleTiming, original: ScheduleSpec | undefined, now: number): ScheduleSpec | null {
  if (timing.mode === 'at') {
    if (original?.kind === 'at' && timing.at === toLocalInput(original.at)) return original;
    const at = fromLocalInput(timing.at);
    return at !== null && at > now ? { kind: 'at', at } : null;
  }
  const minutes = Number(timing.minutes);
  const rawSeconds = minutes * 60;
  const seconds = Math.round(rawSeconds);
  if (!Number.isSafeInteger(seconds) || seconds < 60
    || (original ? Math.abs(seconds - rawSeconds) > Number.EPSILON * Math.max(1, rawSeconds) * 4 : !Number.isInteger(minutes))) return null;
  const unchangedStart = original?.kind === 'every' && timing.startAt === toLocalInput(original.startAt);
  if (unchangedStart && seconds === original.seconds) return original;
  return { kind: 'every', seconds, startAt: unchangedStart ? original.startAt : fromLocalInput(timing.startAt) ?? now };
}

function ScheduleRuleEditor({ schedule, fixedGhostId, onClose, onSave }: {
  schedule?: Schedule;
  fixedGhostId?: string;
  onClose(): void;
  onSave(input: { ghostId: string; prompt: string; spec: ScheduleSpec }): Promise<void>;
}) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const ghosts = visibleGhosts(state?.ghosts ?? []);
  const bound = schedule?.ghostId ?? fixedGhostId;
  const [ghostKey, setGhostKey] = useState(bound ?? ghosts[0]?.id ?? '');
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const original = schedule?.spec;
  const [mode, setMode] = useState<ScheduleSpec['kind']>(original?.kind ?? 'at');
  const [at, setAt] = useState(() => toLocalInput(original?.kind === 'at' ? original.at : Date.now() + 3600_000));
  const [minutes, setMinutes] = useState(original?.kind === 'every' ? String(original.seconds / 60) : '30');
  const [startAt, setStartAt] = useState(() => toLocalInput(original?.kind === 'every' ? original.startAt : Date.now()));
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const close = () => { if (!saving) onClose(); };
  const save = async () => {
    if (!ghostKey || !prompt.trim() || saving) return;
    const spec = scheduleTimingSpec({ mode, at, startAt, minutes }, original, Date.now());
    if (!spec) {
      setError(mode === 'at' ? '실행할 미래 시각을 선택해 주세요.' : schedule ? '반복 간격은 1분 이상, 초 단위로 입력해 주세요.' : '반복 간격은 1분 이상의 정수로 입력해 주세요.');
      return;
    }
    setSaving(true); setError('');
    try { await onSave({ ghostId: ghostKey, prompt: prompt.trim(), spec }); }
    catch (reason) { setError(ruleError(reason, schedule ? '반복 작업을 저장하지 못했습니다.' : '반복 작업을 예약하지 못했습니다.')); setSaving(false); }
  };
  return <form className="rule-sheet" data-editing aria-label={schedule ? '반복 작업 편집' : '반복 작업 예약'} aria-busy={saving} noValidate
    onKeyDown={event => ruleKeys(event, close)} onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="schedule-rule__timing">
      <select className="rule-blank" aria-label="실행 방식" value={mode} disabled={saving} autoFocus={!schedule}
        onChange={event => setMode(event.target.value === 'every' ? 'every' : 'at')}>
        <option value="at">지정 시각</option><option value="every">반복 간격</option>
      </select>
    </div>
    <ScheduleRule beats={mode === 'at'
      ? <label className="schedule-rule__beat"><input data-rule-blank className="rule-blank" aria-label="실행 시각" type="datetime-local" value={at}
        disabled={saving} onChange={event => setAt(event.target.value)}/>에 한 번</label>
      : <>
        <label className="schedule-rule__beat"><input data-rule-blank className="rule-blank" aria-label="시작 시각" type="datetime-local" value={startAt}
          disabled={saving} onChange={event => setStartAt(event.target.value)}/>부터</label>
        <label className="schedule-rule__beat schedule-rule__beat--repeat">
          <input data-rule-blank className="rule-blank" aria-label="반복 간격 (분)" type="number" min={1} step={schedule ? 'any' : 1}
            value={minutes} disabled={saving} onChange={event => setMinutes(event.target.value)}/>분마다
        </label>
      </>}
      recipient={bound ? (state?.ghosts.find(ghost => ghost.id === bound)?.name ?? bound)
        : <select data-rule-blank className="rule-blank" aria-label="Ghost" value={ghostKey} disabled={saving || !ghosts.length}
          onChange={event => setGhostKey(event.target.value)}>
          <option value="">Ghost 선택</option>{ghosts.map(ghost => <option key={ghost.id} value={ghost.id}>{ghost.name}</option>)}
        </select>}
      message={<textarea data-rule-blank className="rule-blank rule-message" aria-label="실행할 내용" placeholder="그때 무엇을 할까요?"
        value={prompt} onChange={event => setPrompt(event.target.value)} autoFocus={!!schedule} required rows={2} maxLength={8192} disabled={saving}/>}/>
    {error && <InlineError>{error}</InlineError>}
    <div className="rule-actions rule-actions--end">
      <Button variant="ghost" type="button" disabled={saving} onClick={close}>취소</Button>
      <Button type="submit" disabled={saving || !prompt.trim() || !ghostKey}>{schedule ? (saving ? '저장하는 중…' : '저장') : (saving ? '예약 중…' : '예약')}</Button>
    </div>
  </form>;
}
