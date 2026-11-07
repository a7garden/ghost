import { useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, CircleAlert, Plus } from 'lucide-react';
import { Badge, Button, EmptyState, FormField, GPage, GPageHeader, InlineError, Input, SegmentedControl, SelectField, Textarea, cn } from '@garden/ui';
import type { State, Work, WorkState } from '@ghost/contract';
import { TERMINAL_WORK_STATES } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { uiTerms } from '../uiText';
import { toneFor } from './ghostState';
import { useHost } from '../host/context';

export type WorkRowStatus = { label: ReactNode; tone?: 'default' | 'success' | 'warning' | 'danger' | 'outline' };

type WorkRowProps = {
  /** Owner Ghost shown as the leading portrait. */
  ghostId?: string;
  /** Leading glyph when the row has no single owner Ghost. */
  icon?: ReactNode;
  title: ReactNode;
  owner?: ReactNode;
  note?: ReactNode;
  status?: WorkRowStatus;
  action?: ReactNode;
  onClick?: () => void;
  className?: string;
} & Record<`data-${string}`, string | undefined>;

/** One consistent work item: leading ghost, copy, status badge, trailing action. */
export function WorkRow({ ghostId, icon, title, owner, note, status, action, onClick, className = '', ...rest }: WorkRowProps) {
  const copy = <>
    {ghostId
      ? <DotAvatar profileId={ghostId} tone={toneFor(ghostId)} size={36}/>
      : icon && <span className="flex size-9 shrink-0 items-center justify-center text-ink-2" aria-hidden="true">{icon}</span>}
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="text-ui font-medium text-ink [overflow-wrap:anywhere]">{title}</span>
      {owner && <span className="text-caption text-ink-2">{owner}</span>}
      {note && <span className="text-caption text-ink-2 [overflow-wrap:anywhere]">{note}</span>}
    </span>
    {status && <Badge variant={status.tone} className="shrink-0">{status.label}</Badge>}
    {action && <span className="flex shrink-0 items-center gap-1">{action}</span>}
    {onClick && !action && <ArrowUpRight className="size-4 shrink-0 text-ink-3" aria-hidden="true"/>}
  </>;
  if (onClick) return <button type="button" data-slot="work-row" onClick={onClick}
    className={cn('flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-control px-2 py-2.5 text-left transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-50', className)} {...rest}>{copy}</button>;
  return <div data-slot="work-row" className={cn('flex w-full min-w-0 items-center gap-3 rounded-control px-2 py-2.5 text-left', className)} {...rest}>{copy}</div>;
}

export const workStateLabel: Record<WorkState, string> = {
  queued: '대기 중', running: '진행 중', waiting: '대기 중', verifying: '검증 중',
  blocked: '결과 미확정', done: '완료', failed: '실패', cancelled: '취소됨',
};

export const workStateTone = (state: WorkState): WorkRowStatus['tone'] =>
  state === 'failed' ? 'danger'
    : state === 'blocked' ? 'warning'
      : state === 'done' ? 'success'
        : state === 'cancelled' ? 'outline' : 'default';

/** Waiting on an owner-visible question reads as 확인 필요, not plain 대기 중. */
export const workRowStatus = (work: Work, pendingDecisionIds: ReadonlySet<string>): WorkRowStatus =>
  work.state === 'waiting' && pendingDecisionIds.has(work.id)
    ? { label: '확인 필요', tone: 'warning' }
    : { label: workStateLabel[work.state], tone: workStateTone(work.state) };

type WorkTab = 'active' | 'finished';

/** 맡긴 일: every Work the host keeps — live first, then what recently settled. */
export function WorkView({ state, navigate, filterGhostId }: {
  state: State;
  navigate: (path: string) => void;
  /** ?ghost= from the sidebar; null on the workspace-wide board. */
  filterGhostId: string | null;
}) {
  const { client } = useHost();
  const [tab, setTab] = useState<WorkTab>('active');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const ghostName = (id: string) => state.ghosts.find(ghost => ghost.id === id)?.name ?? 'Ghost';
  const pendingWorkIds = new Set(state.decisions.filter(decision => decision.state === 'pending' && decision.workId).map(decision => decision.workId!));
  const works = state.works
    .filter(work => (filterGhostId ? work.ghostId === filterGhostId : true))
    .filter(work => tab === 'active' ? !TERMINAL_WORK_STATES.includes(work.state) : TERMINAL_WORK_STATES.includes(work.state))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const cancel = (work: Work) => { setError(''); void client.send({ type: 'work.cancel', workId: work.id }).catch(e => setError(e instanceof Error ? e.message : '맡긴 일을 취소하지 못했습니다.')); };
  const filterName = filterGhostId ? ghostName(filterGhostId) : null;
  return <GPage>
    <GPageHeader title={uiTerms.work} actions={<Button onClick={() => setCreating(true)} disabled={!state.ghosts.length}><Plus className="size-4"/>일 맡기기</Button>}/>
    {filterName && <p className="m-0 text-caption text-ink-2" role="status">{filterName}에게 맡긴 일만 보고 있습니다. <button type="button" className="cursor-pointer underline underline-offset-2 hover:text-ink" onClick={() => navigate('/work')}>전체 보기</button></p>}
    {error && <InlineError>{error}</InlineError>}
    <section className="grid gap-1" aria-labelledby="work-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="work-list" className="m-0 flex flex-wrap items-center gap-2 text-ui font-semibold text-ink">
          {tab === 'active' ? '진행 중' : '종료된 일'}
          {works.length > 0 && <Badge variant="outline">{works.length}</Badge>}
        </h2>
        <SegmentedControl variant="filter" aria-label="맡긴 일 상태" value={tab} onValueChange={setTab}
          options={[{ value: 'active', label: '진행 중' }, { value: 'finished', label: '종료된 일' }]}/>
      </div>
      {works.map(work => <WorkRow key={work.id} ghostId={work.ghostId} data-work-state={work.state}
        title={work.title}
        owner={filterGhostId ? undefined : ghostName(work.ghostId)}
        note={work.state === 'failed' || work.state === 'blocked' || work.state === 'cancelled' ? work.reason ?? undefined : undefined}
        status={workRowStatus(work, pendingWorkIds)}
        action={tab === 'active' && (work.state === 'running' || work.state === 'queued' || work.state === 'waiting') ? <Button variant="ghost" size="sm" onClick={() => cancel(work)}>취소</Button> : undefined}
        onClick={() => navigate(`/work/${encodeURIComponent(work.id)}`)}/>)}
      {!works.length && <EmptyState icon={tab === 'active' ? <CircleAlert/> : <Check/>} className="py-6"
        title={tab === 'active' ? '진행 중인 일 없음' : '종료된 일 없음'}
        action={tab === 'active' && <Button variant="outline" onClick={() => setCreating(true)}><Plus className="size-4"/>일 맡기기</Button>}/>}
    </section>
    {creating && <NewWorkModal state={state} defaultGhostId={filterGhostId ?? state.ghosts.find(ghost => ghost.isDefault)?.id ?? state.ghosts[0]?.id ?? ''}
      onClose={() => setCreating(false)} onCreated={id => { setCreating(false); navigate(`/work/${encodeURIComponent(id)}`); }}/>}
  </GPage>;
}

/** 일 맡기기: one Ghost, what to do, and when it must be done. */
export function NewWorkModal({ state, defaultGhostId, onClose, onCreated }: {
  state: State;
  defaultGhostId: string | null;
  onClose(): void;
  onCreated(workId: string): void;
}) {
  const { client } = useHost();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ghosts = [...state.ghosts].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const [ghostId, setGhostId] = useState(defaultGhostId ?? ghosts[0]?.id ?? '');
  const submit = (data: FormData) => {
    const title = String(data.get('title')).trim();
    const brief = String(data.get('brief')).trim();
    const deadline = String(data.get('deadline'));
    if (!title || !brief || !ghostId) return;
    setBusy(true); setError('');
    void (async () => {
      try {
        const created = await client.send<{ workId: string }>({
          type: 'work.create', ghostId, title,
          brief,
          ...(deadline ? { deadlineAt: new Date(deadline).getTime() } : {}),
        });
        onCreated(created.workId);
      } catch (e) {
        setError(e instanceof Error ? e.message : '맡긴 일을 만들지 못했습니다. 다시 시도해 주세요.');
        setBusy(false);
      }
    })();
  };
  return <Modal title="일 맡기기" onClose={() => { if (!busy) onClose(); }}>
    <form className="grid gap-4" onSubmit={e => { e.preventDefault(); submit(new FormData(e.currentTarget)); }}>
      <FormField label="맡길 Ghost" required>
        {control => <SelectField {...control} label="맡길 Ghost" value={ghostId} onValueChange={setGhostId} required
          options={ghosts.map(ghost => ({ value: ghost.id, label: ghost.isDefault ? `${ghost.name} · 메인` : ghost.name }))}/>}
      </FormField>
      <FormField label="제목" description="한 줄로 무엇을 할지 적어 주세요." required>
        {control => <Input {...control} name="title" placeholder="예: 1분기 회고 자료 모으기" required maxLength={256}/>}
      </FormField>
      <FormField label="할 일" description="완료해야 할 내용과 확인 방법을 적어 주세요." required>
        {control => <Textarea {...control} name="brief" placeholder="무엇을, 어떻게 완료할지 적어 주세요." required maxLength={32768} rows={5}/>}
      </FormField>
      <FormField label="기한" description="비워 두면 기한 없이 진행합니다.">
        {control => <Input {...control} type="datetime-local" name="deadline"/>}
      </FormField>
      {error && <InlineError>{error}</InlineError>}
      <Button type="submit" className="justify-self-end" disabled={busy}>{busy ? '만드는 중…' : '일 맡기기'}</Button>
    </form>
  </Modal>;
}
