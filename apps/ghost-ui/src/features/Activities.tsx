import { Fragment, useState } from 'react';
import { ChevronDown, FlaskConical, Pause, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react';
import { Badge, Button, InlineError, SettingsGroup, SettingsRow } from '../ui';
import { TERMINAL_WORK_STATES, type Activity, type ActivityRun, type Connection } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { uiTerms } from '../uiText';
import { absoluteTime, relativeTime, useNow } from './time';
import { ActivityFormDialog } from './ActivityForm';
import { deferralLabel, executionLabel, policySummary, runStateLabel, runStateTone, sourceKindLabel, sourceSummary, triggerLabel } from './activity-config';

/** A run is settled when its projected Work is, or the host skipped it before any Work started. */
const settledRun = (run: ActivityRun) => run.state === 'skipped' || TERMINAL_WORK_STATES.includes(run.state);

/**
 * 설정 → 자동 활동: standing delegations per Ghost. 만들기·편집·일시정지·삭제·실행·시험·기록은
 * activity.* 명령으로 곧장 저장되고, 활동이 활성화되려면 항상 소유자의 저장을 거칩니다.
 */
export function Activities({ navigate }: { navigate(path: string): void }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const now = useNow();
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Activity | null>(null);
  const [removing, setRemoving] = useState<Activity | null>(null);
  const [pausing, setPausing] = useState<Activity | null>(null);
  const [stopping, setStopping] = useState(false);
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  const ghosts = state?.ghosts ?? [];
  const connections = state?.connections ?? [];
  const runs = state?.activityRuns ?? [];
  const activities = (state?.activities ?? []).filter(activity => activity.deletedAt === null)
    .sort((a, b) => Number(a.paused) - Number(b.paused)
      || (a.nextAt ?? Number.POSITIVE_INFINITY) - (b.nextAt ?? Number.POSITIVE_INFINITY)
      || a.createdAt - b.createdAt);
  const liveRuns = runs.filter(run => !settledRun(run));
  const stoppable = liveRuns.length > 0 || activities.some(activity => !activity.paused);
  const runsOf = (activityId: string): ActivityRun[] =>
    runs.filter(run => run.activityId === activityId).sort((a, b) => b.createdAt - a.createdAt);
  const activeIds = new Set(activities.map(activity => activity.id));
  const archivedRuns = runs.filter(run => !activeIds.has(run.activityId)).sort((a, b) => b.createdAt - a.createdAt);

  const act = async (label: string, work: () => Promise<unknown>, done: string) => {
    setPending(label); setError(''); setNotice('');
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); }
    finally { setPending(''); }
  };

  const ghostName = (id: string) => ghosts.find(ghost => ghost.id === id)?.name ?? id;
  const connectionOf = (activity: Activity): Connection | undefined => {
    const source = activity.source;
    return 'connectionId' in source ? connections.find(item => item.id === source.connectionId) : undefined;
  };

  return <section className="flex min-w-0 flex-col gap-6" aria-label={uiTerms.activities}>
    <div className="settings-section-header flex flex-wrap items-center justify-between gap-3">
      <h2 className="section-title">{uiTerms.activities}</h2>
      <span className="flex items-center gap-2">
        {stoppable && <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => { setError(''); setStopping(true); }}>
          <Square size={15}/>모두 멈추기
        </Button>}
        <Button type="button" disabled={!state} onClick={() => { setError(''); setCreating(true); }}><Plus size={15}/>활동 만들기</Button>
      </span>
    </div>
    {activities.length
      ? <SettingsGroup title={<span className="sr-only">{uiTerms.activities}</span>}>{activities.map(activity => {
        const connection = connectionOf(activity);
        const lastRun = runsOf(activity.id)[0];
        const historyOpen = openHistory === activity.id;
        const deferred = deferralLabel(activity);
        return <Fragment key={activity.id}>
          <SettingsRow
            label={<span className="flex min-w-0 flex-col gap-1.5">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge variant="outline">{ghostName(activity.ghostId)}</Badge>
                {activity.paused && <Badge variant="warning">일시정지</Badge>}
                {deferred && <Badge variant="outline">대기</Badge>}
                {activity.source.kind !== 'schedule' && !connection && <Badge variant="danger">연결 없음</Badge>}
                <span className="text-caption font-normal text-ink-3">{sourceKindLabel[activity.source.kind]}</span>
              </span>
              <span className="text-ui font-medium text-ink [overflow-wrap:anywhere]">{activity.name}</span>
              <span className="text-caption font-normal text-ink-3 [overflow-wrap:anywhere]">
                {sourceSummary(activity.source)}{connection ? ` · ${connection.name}` : ''}
                {' · '}{executionLabel[activity.execution.kind]}
                {activity.execution.kind === 'host' && ` · ${activity.execution.cwd}`}
              </span>
              {activity.lastError && <span className="activity-error [overflow-wrap:anywhere]">마지막 오류 · {activity.lastError}</span>}
            </span>}
            description={<>
              {activity.paused
                ? <>일시정지{activity.pauseReason ? ` · ${activity.pauseReason}` : ''}</>
                : activity.nextAt ? <>다음 실행 · {absoluteTime(activity.nextAt)}</> : <>다음 실행 없음</>}
              {deferred && <> · {deferred}</>}
              {lastRun && <> · 마지막 {runStateLabel[lastRun.state] ?? lastRun.state}{lastRun.dryRun ? ' (시험)' : ''} · {relativeTime(lastRun.createdAt, now)}</>}
              {activity.failureCount >= 2 && activity.lastError && <> · 연속 실패 {activity.failureCount}회</>}
            </>}>
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} aria-label={`${activity.name} 지금 실행`}
                onClick={() => void act('run', () => client.send({ type: 'activity.run', activityId: activity.id }), '활동을 실행했습니다.')}>
                <Play size={14}/>실행
              </Button>
              <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} aria-label={`${activity.name} 시험 실행`}
                onClick={() => void act('dry', () => client.send({ type: 'activity.run', activityId: activity.id, dryRun: true }), '쓰기 없이 시험하며 감시 진행 지점은 바꾸지 않습니다.')}>
                <FlaskConical size={14}/>시험
              </Button>
              {activity.paused
                ? <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} onClick={() => void act('resume', () => client.send({ type: 'activity.pause', activityId: activity.id, paused: false }), '활동을 재개했습니다.')}>
                  <Play size={14}/>재개
                </Button>
                : <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} onClick={() => {
                  setError('');
                  if (runsOf(activity.id).some(run => !settledRun(run))) setPausing(activity);
                  else void act('pause', () => client.send({ type: 'activity.pause', activityId: activity.id, paused: true }), '활동을 일시정지했습니다.');
                }}>
                  <Pause size={14}/>일시정지
                </Button>}
              <Button variant="ghost" size="icon" type="button" aria-label={`${activity.name} 실행 기록`} aria-expanded={historyOpen}
                onClick={() => setOpenHistory(historyOpen ? null : activity.id)}>
                <ChevronDown size={15} className={historyOpen ? 'rotate-180 transition-transform' : 'transition-transform'}/>
              </Button>
              <Button variant="ghost" size="icon" type="button" aria-label={`${activity.name} 편집`} disabled={pending !== ''}
                onClick={() => { setError(''); setEditing(activity); }}><Pencil size={15}/></Button>
              <Button variant="ghost" size="icon" type="button" aria-label={`${activity.name} 삭제`} disabled={pending !== ''}
                onClick={() => { setError(''); setRemoving(activity); }}><Trash2 size={15}/></Button>
            </span>
          </SettingsRow>
          {historyOpen && <div className="activity-runs" role="region" aria-label={`${activity.name} 실행 기록`}>
            <p className="activity-runs__policy">{policySummary(activity.policy)}</p>
            {runsOf(activity.id).length
              ? <ul className="activity-runs__list">{runsOf(activity.id).map(run => <RunRow key={run.id} run={run} now={now} navigate={navigate}/>)}</ul>
              : <p className="activity-runs__empty">아직 실행 기록이 없습니다.</p>}
          </div>}
        </Fragment>;
      })}</SettingsGroup>
      : state && <div className="calm"><FlaskConical size={16} aria-hidden="true"/><p>자동 활동 없음. 메일·PR·일정을 주기적으로 살피게 할 수 있습니다.</p></div>}
    {archivedRuns.length > 0 && <section className="activity-runs" aria-label="삭제된 활동 실행 기록">
      <h3 className="section-title">삭제된 활동 실행 기록</h3>
      <ul className="activity-runs__list">{archivedRuns.map(run => <RunRow key={run.id} run={run} now={now} navigate={navigate}/>)}</ul>
    </section>}
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}

    {(creating || editing) && state && <ActivityFormDialog state={state} connections={connections} activity={editing}
      onClose={() => { setCreating(false); setEditing(null); }}
      onSave={async config => {
        await client.send(editing
          ? { type: 'activity.update', activityId: editing.id, expectedRevision: editing.revision, config }
          : { type: 'activity.create', config });
        setCreating(false); setEditing(null);
      }}/>}
    {removing && <Modal title="활동 삭제" onClose={() => pending === '' && setRemoving(null)}>
      <p className="m-0">이 활동을 삭제할까요? 예약된 확인과 실행도 멈춥니다. 실행 기록은 남습니다.</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => setRemoving(null)}>취소</Button>
        <Button variant="destructive" type="button" disabled={pending !== ''}
          onClick={() => void act('delete', async () => { await client.send({ type: 'activity.delete', activityId: removing.id }); setRemoving(null); }, '활동을 삭제했습니다.')}>삭제</Button>
      </div>
    </Modal>}
    {pausing && <Modal title="활동 일시정지" onClose={() => pending === '' && setPausing(null)}>
      <p className="m-0">자동 실행을 멈춥니다. 지금 실행 중인 맡긴 일도 함께 중지할까요?</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => setPausing(null)}>취소</Button>
        <Button variant="outline" type="button" disabled={pending !== ''}
          onClick={() => void act('pause', async () => { await client.send({ type: 'activity.pause', activityId: pausing.id, paused: true }); setPausing(null); }, '활동을 일시정지했습니다.')}>작업은 계속</Button>
        <Button variant="destructive" type="button" disabled={pending !== ''}
          onClick={() => void act('pause', async () => { await client.send({ type: 'activity.pause', activityId: pausing.id, paused: true, cancelRunning: true }); setPausing(null); }, '활동과 실행 중인 작업을 멈췄습니다.')}>작업도 중지</Button>
      </div>
    </Modal>}
    {stopping && <Modal title="자동 활동 모두 멈추기" onClose={() => pending === '' && setStopping(false)}>
      <p className="m-0">켜져 있는 자동 활동은 앞으로 자동으로 실행되지 않고, 지금 진행 중인 맡긴 일은 취소됩니다. 활동마다 재개할 수 있습니다.</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => setStopping(false)}>취소</Button>
        <Button variant="destructive" type="button" disabled={pending !== ''}
          onClick={() => void act('stop', async () => { await client.send({ type: 'activity.stop_all' }); setStopping(false); }, '자동 활동을 모두 멈췄습니다.')}>모두 멈추기</Button>
      </div>
    </Modal>}
  </section>;
}

/** One run: state, what triggered it, the watched item, and where its 맡긴 일 went. */
export function RunRow({ run, now, navigate }: { run: ActivityRun; now: number; navigate(path: string): void }) {
  return <li className="activity-run" data-state={run.state}>
    <span className="activity-run__head">
      <Badge variant={runStateTone[run.state] ?? 'outline'}>{runStateLabel[run.state] ?? run.state}</Badge>
      <span className="text-caption text-ink-2">{triggerLabel[run.trigger]}</span>
      {run.dryRun && <Badge variant="outline">시험</Badge>}
      {run.noChange && run.state === 'done' && <Badge variant="outline">변경 없음</Badge>}
      <time className="text-caption text-ink-3" title={absoluteTime(run.createdAt)} dateTime={new Date(run.createdAt).toISOString()}>{relativeTime(run.createdAt, now)}</time>
    </span>
    {run.sourceItem?.title && <span className="activity-run__item [overflow-wrap:anywhere]">{run.sourceItem.title}</span>}
    {run.reason && <span className="activity-run__reason [overflow-wrap:anywhere]">{run.reason}</span>}
    {run.nextCheckReason && <span className="activity-run__reason [overflow-wrap:anywhere]">다음 점검 사유 · {run.nextCheckReason}</span>}
    <span className="activity-run__foot">
      {run.nextCheckAt && <span className="text-caption text-ink-3">다음 점검 · {absoluteTime(run.nextCheckAt)}</span>}
      {run.workId && <button type="button" className="activity-run__open" onClick={() => navigate(`/work/${encodeURIComponent(run.workId!)}`)}>맡긴 일 열기</button>}
    </span>
  </li>;
}
