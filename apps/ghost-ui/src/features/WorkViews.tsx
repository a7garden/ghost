import { useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Check, CheckCheck, CircleAlert, Clock3, Pause, Play, Plus } from 'lucide-react';
import { Badge, Button, cn, EmptyState, GPage, GPageHeader, InlineError, SegmentedControl } from '@garden/ui';
import { DetailDialog } from '../components/DetailDialog';
import { DotAvatar } from '../components/DotAvatar';
import { uiTerms } from '../uiText';
import { RoutingCompletionInbox } from './RoutingResults';
import { isRunning, phaseLabel, toneFor } from '../client/types';
import type { Snapshot, Command, Review } from '../client/types';
import { taskDisplayLabel } from '../client/taskLabel';
import { inboxItems, taskAttentionMessage } from '../client/inbox';
import { approvalGroup, approvalGroups, approvalKey, approvalState, approvalSubject, approvalTitle, type Approval, type ApprovalRef } from '../plugins/approvals';

type Action = (command: Command) => Promise<Record<string, any>>;

export type WorkRowStatus = { label: ReactNode; tone?: 'default' | 'success' | 'warning' | 'danger' | 'outline' };

type WorkRowProps = {
  /** Owner Ghost shown as the leading portrait. */
  ghostId?: string;
  /** Leading glyph when the row has no single owner Ghost. */
  icon?: ReactNode;
  /** Custom leading content (e.g. an avatar stack) replacing ghost/icon. */
  leading?: ReactNode;
  title: ReactNode;
  owner?: ReactNode;
  note?: ReactNode;
  status?: WorkRowStatus;
  action?: ReactNode;
  onClick?: () => void;
  className?: string;
} & Record<`data-${string}`, string | undefined>;

/** One consistent work item: leading ghost, copy, status badge, trailing action. */
export function WorkRow({ ghostId, icon, leading, title, owner, note, status, action, onClick, className = '', ...rest }: WorkRowProps) {
  const copy = <>
    {leading ?? (ghostId
      ? <DotAvatar profileId={ghostId} tone={toneFor(ghostId)} size={36}/>
      : icon && <span className="flex size-9 shrink-0 items-center justify-center text-ink-2" aria-hidden="true">{icon}</span>)}
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
    className={cn('flex w-full min-w-0 items-center gap-3 rounded-control px-2 py-2.5 text-left transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-50', className)} {...rest}>{copy}</button>;
  return <div data-slot="work-row" className={cn('flex w-full min-w-0 items-center gap-3 rounded-control px-2 py-2.5 text-left', className)} {...rest}>{copy}</div>;
}

export const phaseTone = (phase: string): WorkRowStatus['tone'] =>
  phase === 'failed' ? 'danger'
    : phase === 'uncertain' || phase === 'waiting_owner' ? 'warning'
      : phase === 'complete' ? 'success'
        : phase === 'cancelled' ? 'outline'
          : 'default';

const approvalTone = (item: Approval): WorkRowStatus['tone'] => {
  switch (item.review.state) {
    case 'failed': return 'danger';
    case 'uncertain': return 'warning';
    case 'saved': case 'sent': return 'success';
    case 'declined': return 'outline';
    default: return 'default';
  }
};

const sectionHeading = 'flex flex-wrap items-center gap-2 text-ui font-semibold text-ink';

export function InboxView({ snapshot, onReview, onOpenApproval, navigate, connected = true }: {
  snapshot: Snapshot;
  connected?: boolean;
  onReview?: (review: Review) => void;
  onOpenApproval?: (ref: ApprovalRef) => void;
  navigate: (path: string) => void;
}) {
  const { tasks, groups, count } = inboxItems(snapshot, connected);
  const approvalRow = (item: Approval) => {
    const ghost = snapshot.profiles.find(profile => profile.id === item.ghostId);
    const group = approvalGroup(item);
    const context = [ghost?.name, item.kind === 'document' ? '문서 저장' : approvalSubject(item, snapshot)].filter(Boolean).join(' · ');
    const showState = group === 'followup' || group === 'finished';
    return <WorkRow ghostId={item.ghostId} data-inbox-kind="approval" key={approvalKey(item)}
      title={approvalTitle(item)}
      owner={context || undefined}
      status={showState ? { label: approvalState(item), tone: approvalTone(item) } : undefined}
      action={<Button variant="outline" size="sm"
        disabled={!onOpenApproval && !(item.kind === 'document' && onReview)}
        onClick={() => {
          if (onOpenApproval) onOpenApproval({ kind: item.kind, id: item.id });
          else if (item.kind === 'document') onReview?.(item.review);
        }}>{group === 'pending' ? '내용 보기' : '상세 보기'}<ArrowUpRight className="size-3.5"/></Button>}
    />;
  };
  return <GPage>
    <GPageHeader title={uiTerms.inbox}/>
    {(['pending', 'running', 'followup'] as const).map(group => groups[group].length > 0 &&
      <section className="grid gap-1" aria-labelledby={`inbox-${group}`} key={group}>
        <h2 id={`inbox-${group}`} className={sectionHeading}>{approvalGroups[group]}</h2>
        {groups[group].map(approvalRow)}
      </section>)}
    {tasks.length > 0 && <section className="grid gap-1" aria-labelledby="inbox-followup-tasks">
      <h2 id="inbox-followup-tasks" className={sectionHeading}>작업 후속 확인</h2>
      {tasks.map(({ p, c, t }) => <WorkRow key={`${p.id}:${c.id}:${t.id}`} icon={<CircleAlert className="size-5"/>}
        title={c.title}
        owner={`${p.name} · ${phaseLabel(t.phase)}`}
        note={taskAttentionMessage(t)}
        action={<>
          {t.output && <DetailDialog title="실행 기록"><pre className="max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{t.output}</pre></DetailDialog>}
          <Button variant="outline" size="sm" onClick={() => navigate(`/ghosts/${p.id}?conversation=${c.id}`)}>대화와 작업 보기<ArrowRight className="size-3.5"/></Button>
          {t.phase === 'failed' && <Button variant="outline" size="sm" onClick={() => navigate(`/settings?tab=models&ghost=${encodeURIComponent(p.id)}`)}>모델 설정</Button>}
        </>}
      />)}
    </section>}
    {!count && <EmptyState icon={<CheckCheck/>} title="확인이 필요한 항목 없음" className="py-16"
      action={<Button variant="outline" onClick={() => navigate('/')}>나의 Ghost 보기</Button>}/>}
    <RoutingCompletionInbox snapshot={snapshot} connected={connected}/>
    {groups.finished.length > 0 && <section className="mt-8 grid gap-1" aria-labelledby="inbox-finished">
      <h2 id="inbox-finished" className={sectionHeading}>{approvalGroups.finished} <Badge>{groups.finished.length}</Badge></h2>
      {groups.finished.map(approvalRow)}
    </section>}
  </GPage>;
}

type WorkTab = 'active' | 'finished';

export function WorkView({ snapshot, action, busy, navigate, onAssign }: { snapshot: Snapshot; action: Action; busy: boolean; navigate: (path: string) => void; onAssign: () => void }) {
  const [tab, setTab] = useState<WorkTab>('active'), [error, setError] = useState('');
  const tasks = snapshot.profiles.flatMap(p => p.conversations.flatMap(c => c.tasks.map(t => ({ p, c, t }))));
  const visible = tasks.filter(({ t }) => tab === 'active' ? isRunning(t.phase) || t.phase === 'waiting_owner' : ['complete', 'failed', 'uncertain', 'cancelled'].includes(t.phase));
  const run = async (command: Command) => { setError(''); try { await action(command); } catch (e) { setError(e instanceof Error ? e.message : '변경을 저장하지 못했습니다.'); } };
  return <GPage>
    <GPageHeader title={uiTerms.work} actions={<Button onClick={onAssign} disabled={!snapshot.profiles.length}><Plus className="size-4"/>새 요청</Button>}/>
    {error && <InlineError>{error}</InlineError>}
    {snapshot.goals.length > 0 && <section className="grid gap-1" aria-labelledby="work-goals">
      <h2 id="work-goals" className={sectionHeading}>{uiTerms.goals}</h2>
      {snapshot.goals.map(g => {
        const p = snapshot.profiles.find(p => p.id === g.profile_id);
        const paused = g.state === 'paused';
        return <WorkRow ghostId={g.profile_id} key={g.id}
          title={g.title}
          owner={p?.name}
          note={g.note || g.criteria || undefined}
          status={{ label: g.state === 'complete' ? '완료' : paused ? '일시정지' : '진행 중', tone: g.state === 'complete' ? 'success' : paused ? 'warning' : 'default' }}
          action={g.state !== 'complete' && <Button variant="ghost" size="icon" aria-label={`${g.title} ${paused ? '재개' : '일시정지'}`} disabled={busy}
            onClick={() => void run({ type: 'workspace', action: { type: 'goal_state', goal_id: g.id, state: paused ? 'ready' : 'paused', evidence: g.evidence } })}>{paused ? <Play className="size-4"/> : <Pause className="size-4"/>}</Button>}
        />;
      })}
    </section>}
    <section className="mt-8 grid gap-1" aria-labelledby="work-conversation-tasks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="work-conversation-tasks" className={sectionHeading}>대화에서 진행한 일</h2>
        <SegmentedControl variant="filter" aria-label="작업 상태" value={tab} onValueChange={setTab}
          options={[{ value: 'active', label: '진행 중' }, { value: 'finished', label: '종료된 작업' }]}/>
      </div>
      {visible.map(({ p, c, t }) => <WorkRow ghostId={p.id} key={`${p.id}:${t.id}`}
        title={taskDisplayLabel(t, c)}
        owner={p.name}
        status={{ label: phaseLabel(t.phase), tone: phaseTone(t.phase) }}
        onClick={() => navigate(`/ghosts/${p.id}?conversation=${c.id}`)}
      />)}
      {!visible.length && <EmptyState icon={<Check/>} title="해당하는 작업 없음" className="py-6"/>}
    </section>
    <section className="mt-8 grid gap-1" aria-labelledby="work-schedules">
      <h2 id="work-schedules" className={sectionHeading}>{uiTerms.schedules} <Clock3 className="size-4 text-ink-3"/></h2>
      {snapshot.schedules.map(s => <WorkRow icon={<Clock3 className="size-5"/>} key={s.id}
        title={s.prompt}
        owner={`${snapshot.profiles.find(p => p.id === s.profile_id)?.name} · ${s.paused ? '일시정지' : `다음 ${new Date(s.next_run_ms).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}`}
        action={<Button variant="outline" size="sm" disabled={busy} onClick={() => void run({ type: 'pause_schedule', schedule_id: s.id, paused: !s.paused })}>{s.paused ? <Play className="size-3.5"/> : <Pause className="size-3.5"/>}<span>{s.paused ? '재개' : '일시정지'}</span></Button>}
      />)}
      {!snapshot.schedules.length && <EmptyState icon={<Clock3/>} title="Ghost와의 대화에서 반복 작업을 예약할 수 있습니다." className="py-6"/>}
    </section>
  </GPage>;
}
