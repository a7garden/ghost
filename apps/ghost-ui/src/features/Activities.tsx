import { useId, useState } from 'react';
import { FlaskConical, Pause, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react';
import { Badge, Button, InlineError, SkeletonRows } from '../ui';
import { TERMINAL_WORK_STATES, type Activity, type ActivityRun } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { uiTerms } from '../uiText';
import { absoluteTime, relativeTime, useNow } from './time';
import { ActivityRuleEditor, ActivityRulePreview } from './ActivityForm';
import { deferralLabel, pendingActivityConfig, runStateLabel, runStateTone, triggerLabel } from './activity-config';
import { mainForRule, restoreRuleFocus, TellRule } from './standing-rules';

/** A run is settled when its projected Work is, or the host skipped it before any Work started. */
const settledRun = (run: ActivityRun) => run.state === 'skipped' || TERMINAL_WORK_STATES.includes(run.state);

/**
 * 설정 → 자동 활동: standing delegations per Ghost. Direct edits save through activity.*;
 * conversation-created rules and pending owner approvals use the same reading order.
 */
export function Activities({ navigate, scopeId }: { navigate(path: string): void; scopeId?: string }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const now = useNow();
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<'create' | 'tell' | Activity | null>(null);
  const controls = useId();
  const createId = `${controls}-create`, tellId = `${controls}-tell`;
  const main = mainForRule(state, 'activity_propose');
  const [removing, setRemoving] = useState<Activity | null>(null);
  const [pausing, setPausing] = useState<Activity | null>(null);
  const [stopping, setStopping] = useState(false);
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  const connections = state?.connections ?? [];
  const runs = state?.activityRuns ?? [];
  const activities = (state?.activities ?? []).filter(activity => activity.deletedAt === null && (scopeId === undefined || activity.scopeId === scopeId))
    .sort((a, b) => Number(a.paused) - Number(b.paused)
      || (a.nextAt ?? Number.POSITIVE_INFINITY) - (b.nextAt ?? Number.POSITIVE_INFINITY)
      || a.createdAt - b.createdAt);
  const activityIds = new Set(activities.map(activity => activity.id));
  const liveRuns = runs.filter(run => !settledRun(run) && (scopeId === undefined || activityIds.has(run.activityId)));
  const stoppable = liveRuns.length > 0 || activities.some(activity => !activity.paused);
  const runsOf = (activityId: string): ActivityRun[] =>
    runs.filter(run => run.activityId === activityId).sort((a, b) => b.createdAt - a.createdAt);
  const archivedRuns = scopeId === undefined ? runs.filter(run => !activityIds.has(run.activityId)).sort((a, b) => b.createdAt - a.createdAt) : [];
  const proposals = state?.decisions.flatMap(decision => {
    const config = pendingActivityConfig(decision);
    return config && (scopeId === undefined || config.scopeId === scopeId) ? [{ id: decision.id, config }] : [];
  }) ?? [];
  const editing = editor && typeof editor === 'object' ? editor : null;
  const shownActivities = editing && !activityIds.has(editing.id) ? [...activities, editing] : activities;
  const closeEditor = () => {
    setEditor(null);
    restoreRuleFocus(editing ? `${controls}-${editing.id}` : editor === 'tell' ? tellId : createId, createId);
  };

  const act = async (label: string, work: () => Promise<unknown>, done: string) => {
    setPending(label); setError(''); setNotice('');
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); }
    finally { setPending(''); }
  };

  return <section className="rule-layout" aria-label={uiTerms.activities}>
    <div className="settings-section-header flex flex-wrap items-center justify-between gap-3">
      <h2 className="section-title">{uiTerms.activities}</h2>
      <div className="rule-actions">
        {stoppable && scopeId === undefined && <Button variant="outline" type="button" disabled={pending !== '' || editor !== null} onClick={() => { setError(''); setStopping(true); }}>
          <Square size={15}/>모두 멈추기
        </Button>}
        {editor === null && <>
          {main && <Button id={tellId} variant="ghost" type="button" onClick={() => setEditor('tell')}>{main.name}에게 말하기</Button>}
          <Button id={createId} variant="add" type="button" disabled={!state} onClick={() => setEditor('create')}><Plus size={15}/>활동 만들기</Button>
        </>}
      </div>
    </div>
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    {!state ? <SkeletonRows label="자동 활동을 불러오는 중…" rows={2}/> : <>
      {editor === 'create' && <ActivityRuleEditor key={scopeId ?? 'all'} state={state} connections={connections} activity={null} initialScopeId={scopeId}
        onClose={closeEditor} onSave={async config => { await client.send({ type: 'activity.create', config }); closeEditor(); }}/>}
      {editor === 'tell' && <TellRule main={main} scopeId={scopeId} label="자동 활동으로 만들고 싶은 일"
        placeholder="어떤 일이 생길 때 무엇을 해 둘까요?"
        consequence="읽기 전용 활동은 바로 켜질 수 있습니다. 그 밖의 활동은 켜기 전에 승인을 요청합니다."
        requestText={words => `이 말을 자동 활동으로 정리해 activity_propose를 사용해 줘. 계기, 맡길 Ghost, 할 일, 완료 기준, 한도를 정리하고, 모호한 부분은 먼저 물어봐. 요청하지 않은 권한은 추가하지 마.${scopeId ? ` 이 활동의 프로젝트는 「${state.scopes.find(item => item.id === scopeId)?.name ?? scopeId}」(scopeId: ${scopeId})야.` : ''}\n\n${words}`}
        onClose={closeEditor}/>}
      {proposals.length + shownActivities.length > 0
        ? <ul className="rule-list">
          {proposals.map(({ id, config }) => <li key={id}>
            <article className="rule-sheet" aria-label={`${config.name} 제안`}>
              <ActivityRulePreview config={config} state={state}/>
              <a className="rule-review" href={`#/inbox?decision=${encodeURIComponent(id)}`}>활동 제안 확인</a>
            </article>
          </li>)}
          {shownActivities.map(activity => {
            const activityRuns = runsOf(activity.id);
            const lastRun = activityRuns[0];
            const historyOpen = openHistory === activity.id;
            const deferred = deferralLabel(activity);
            return <li key={activity.id}>
              {editing?.id === activity.id
                ? <ActivityRuleEditor state={state} connections={connections} activity={editing} initialScopeId={scopeId} onClose={closeEditor}
                  onSave={async config => {
                    await client.send({ type: 'activity.update', activityId: editing.id, expectedRevision: editing.revision, config });
                    closeEditor();
                  }}/>
                : <article className="rule-sheet" aria-label={activity.name}>
                  <ActivityRulePreview config={activity} state={state}/>
                  {activity.lastError && <p className="activity-error m-0 [overflow-wrap:anywhere]">마지막 오류 · {activity.lastError}</p>}
                  <div className="rule-actions rule-actions--spread">
                    <p className="rule-facts">
                      {activity.paused
                        ? <>일시정지{activity.pauseReason ? ` · ${activity.pauseReason}` : ''}</>
                        : activity.nextAt ? <>다음 실행 · {absoluteTime(activity.nextAt)}</> : <>다음 실행 없음</>}
                      {deferred && <> · 대기 · {deferred}</>}
                      {lastRun && <> · 마지막 {runStateLabel[lastRun.state] ?? lastRun.state}{lastRun.dryRun ? ' (시험)' : ''} · {relativeTime(lastRun.createdAt, now)}</>}
                      {activity.failureCount >= 2 && activity.lastError && <> · 연속 실패 {activity.failureCount}회</>}
                    </p>
                    <div className="rule-actions">
                      <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} aria-label={`${activity.name} 지금 실행`}
                        onClick={() => void act('run', () => client.send({ type: 'activity.run', activityId: activity.id }), '활동을 실행했습니다.')}>
                        <Play size={14}/>실행
                      </Button>
                      <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} aria-label={`${activity.name} 시험 실행`}
                        title="쓰기 없이 시험" onClick={() => void act('dry', () => client.send({ type: 'activity.run', activityId: activity.id, dryRun: true }), '쓰기 없이 시험하며 감시 진행 지점은 바꾸지 않습니다.')}>
                        <FlaskConical size={14}/>시험
                      </Button>
                      {activity.paused
                        ? <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} onClick={() => void act('resume', () => client.send({ type: 'activity.pause', activityId: activity.id, paused: false }), '활동을 재개했습니다.')}>
                          <Play size={14}/>재개
                        </Button>
                        : <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} onClick={() => {
                          setError('');
                          if (activityRuns.some(run => !settledRun(run))) setPausing(activity);
                          else void act('pause', () => client.send({ type: 'activity.pause', activityId: activity.id, paused: true }), '활동을 일시정지했습니다.');
                        }}>
                          <Pause size={14}/>일시정지
                        </Button>}
                      <Button variant="ghost" size="icon" type="button" aria-label={`${activity.name} 실행 기록`} aria-expanded={historyOpen}
                        onClick={() => setOpenHistory(historyOpen ? null : activity.id)}>
                        <span aria-hidden="true" className="fold-mark"/>
                      </Button>
                      <Button id={`${controls}-${activity.id}`} variant="ghost" size="icon" type="button" aria-label={`${activity.name} 편집`}
                        disabled={pending !== '' || editor !== null} onClick={() => { setError(''); setEditor(activity); }}><Pencil size={15}/></Button>
                      <Button variant="ghost" size="icon" type="button" aria-label={`${activity.name} 삭제`} disabled={pending !== ''}
                        onClick={() => { setError(''); setRemoving(activity); }}><Trash2 size={15}/></Button>
                    </div>
                  </div>
                </article>}
              {historyOpen && <div className="activity-runs" role="region" aria-label={`${activity.name} 실행 기록`}>
                {activityRuns.length
                  ? <ul className="activity-runs__list">{activityRuns.map(run => <RunRow key={run.id} run={run} now={now} navigate={navigate}/>)}</ul>
                  : <p className="activity-runs__empty">아직 실행 기록이 없습니다.</p>}
              </div>}
            </li>;
          })}
        </ul>
        : editor === null && <p className="rule-facts">등록된 자동 활동이 없습니다.</p>}
    </>}
    {archivedRuns.length > 0 && <section className="activity-runs" aria-label="삭제된 활동 실행 기록">
      <h3 className="section-title">삭제된 활동 실행 기록</h3>
      <ul className="activity-runs__list">{archivedRuns.map(run => <RunRow key={run.id} run={run} now={now} navigate={navigate}/>)}</ul>
    </section>}
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
