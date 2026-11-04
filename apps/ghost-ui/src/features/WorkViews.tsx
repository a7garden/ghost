import { DetailDialog } from '../components/DetailDialog';
import { uiTerms } from '../uiText';
import { RoutingCompletionInbox } from './RoutingResults';
import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CheckCheck, CircleAlert, Clock3, FileText, LayoutList, Pause, Play, Plus } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { Status } from '../components/Status';
import { isRunning, phaseLabel, toneFor } from '../client/types';
import { taskDisplayLabel } from '../client/taskLabel';
import type { Snapshot, Command, Review } from '../client/types';
import { inboxItems, taskAttentionMessage } from '../client/inbox';
import { approvalGroup, approvalGroups, approvalKey, approvalState, approvalSubject, approvalTitle, type Approval, type ApprovalRef } from '../plugins/approvals';
import '../plugins/plugins.css';

type Action = (command: Command) => Promise<Record<string, any>>;
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
    return <article className="inbox-item" data-inbox-kind="approval" key={approvalKey(item)}>
      <DotAvatar profileId={item.ghostId} tone={toneFor(item.ghostId)} size={36}/>
      <div className="inbox-item-copy">
        <h3>{approvalTitle(item)}</h3>
        {context && <p>{context}</p>}
        {(group === 'followup' || group === 'finished') && <p>{approvalState(item)}</p>}
      </div>
      <button type="button" className="button secondary"
        disabled={!onOpenApproval && !(item.kind === 'document' && onReview)}
        onClick={() => {
          if (onOpenApproval) onOpenApproval({ kind: item.kind, id: item.id });
          else if (item.kind === 'document') onReview?.(item.review);
        }}>{group === 'pending' ? '내용 보기' : '상세 보기'}<ArrowUpRight size={14}/></button>
    </article>;
  };
  return <div className="page-content inbox-page">
    <div className="page-heading"><h1>{uiTerms.inbox}</h1></div>
    {(['pending', 'running', 'followup'] as const).map(group => groups[group].length > 0 &&
      <section className="approval-inbox-group" key={group}>
        <h2>{approvalGroups[group]}</h2>
        {groups[group].map(approvalRow)}
      </section>)}
    {tasks.length > 0 && <section className="approval-inbox-group">
      <h2>작업 후속 확인</h2>
      {tasks.map(({ p, c, t }) => <article className="inbox-item" key={`${p.id}:${c.id}:${t.id}`}>
        <CircleAlert size={24}/><div>
          <span className="eyeline">{p.name} · {phaseLabel(t.phase)}</span><h3>{c.title}</h3>
          <p>{taskAttentionMessage(t)}</p>
          {t.output && <DetailDialog title="실행 기록" className="inbox-task-record"><pre>{t.output}</pre></DetailDialog>}
          <div className="inbox-actions">
            <button className="button secondary" onClick={() => navigate(`/ghosts/${p.id}?conversation=${c.id}`)}>대화와 작업 보기<ArrowRight size={14}/></button>
            {t.phase === 'failed' && <button className="button secondary" onClick={() => navigate(`/settings?tab=models&ghost=${encodeURIComponent(p.id)}`)}>모델 설정</button>}
          </div>
        </div>
      </article>)}
    </section>}
    {!count && <div className="empty-state large-empty"><CheckCheck size={34}/><h2>확인이 필요한 항목 없음</h2><button className="button secondary" onClick={() => navigate('/')}>나의 Ghost 보기</button></div>}
    <RoutingCompletionInbox snapshot={snapshot} connected={connected}/>
    {groups.finished.length > 0 && <section className="approval-inbox-group approval-inbox-history"><h2>{approvalGroups.finished} <span className="muted">{groups.finished.length}</span></h2>
      {groups.finished.map(approvalRow)}
    </section>}
  </div>;
}

export function WorkView({ snapshot, action, busy, navigate, onAssign }: { snapshot: Snapshot; action: Action; busy: boolean; navigate: (path: string) => void; onAssign: () => void }) {
  const [tab, setTab] = useState('active'), [error, setError] = useState('');
  const tasks = snapshot.profiles.flatMap(p => p.conversations.flatMap(c => c.tasks.map(t => ({ p, c, t }))));
  const visible = tasks.filter(({ t }) => tab === 'active' ? isRunning(t.phase) || t.phase === 'waiting_owner' : ['complete', 'failed', 'uncertain', 'cancelled'].includes(t.phase));
  const run = async (command: Command) => { setError(''); try { await action(command); } catch (e) { setError(e instanceof Error ? e.message : '변경을 저장하지 못했습니다.'); } };
  return <div className="page-content work-page"><div className="page-heading"><div><h1>{uiTerms.work}</h1></div><button className="button primary" onClick={onAssign} disabled={!snapshot.profiles.length}><Plus size={16}/>일 맡기기</button></div>{error && <p className="inline-error" role="alert">{error}</p>}
    {snapshot.goals.length > 0 && <section className="goals-section"><div className="section-heading"><h2>{uiTerms.goals}</h2></div><div className="goals-list">{snapshot.goals.map(g => { const p = snapshot.profiles.find(p => p.id === g.profile_id); const paused = g.state === 'paused'; return <article className="goal-item" key={g.id}><DotAvatar profileId={g.profile_id} tone={toneFor(g.profile_id)} size={46}/><div><div className="eyeline">{p?.name} · {g.state === 'complete' ? '완료' : paused ? '일시정지' : '진행 중'}</div><h3>{g.title}</h3><p>{g.note || g.criteria}</p></div>{g.state !== 'complete' && <button className="icon-button" aria-label={`${g.title} ${paused ? '재개' : '일시정지'}`} disabled={busy} onClick={() => void run({ type: 'workspace', action: { type: 'goal_state', goal_id: g.id, state: paused ? 'ready' : 'paused', evidence: g.evidence } })}>{paused ? <Play size={17}/> : <Pause size={17}/>}</button>}</article>; })}</div></section>}
    <section className="work-section"><div className="section-heading work-section-head"><h2>대화에서 진행한 일</h2><div className="filter-options" role="group" aria-label="작업 상태"><button className={`filter-button ${tab === 'active' ? 'selected' : ''}`} aria-pressed={tab === 'active'} onClick={() => setTab('active')}>진행 중</button><button className={`filter-button ${tab === 'finished' ? 'selected' : ''}`} aria-pressed={tab === 'finished'} onClick={() => setTab('finished')}>종료된 작업</button></div></div><div className="work-list">{visible.map(({ p, c, t }) => <button className="work-row" key={`${p.id}:${t.id}`} onClick={() => navigate(`/ghosts/${p.id}?conversation=${c.id}`)}><DotAvatar profileId={p.id} tone={toneFor(p.id)} size={38}/><div className="work-copy"><strong>{taskDisplayLabel(t, c)}</strong><span>{p.name}</span></div><span className="work-phase">{phaseLabel(t.phase)}</span><ArrowUpRight size={15}/></button>)}</div>{!visible.length && <div className="quiet-empty"><Check size={18}/>해당하는 작업 없음</div>}</section>
    <section className="work-section"><div className="section-heading"><h2>{uiTerms.schedules}</h2><Clock3 className="muted" size={17}/></div>{snapshot.schedules.map(s => <article className="schedule-row" key={s.id}><Clock3 size={19}/><div><strong>{s.prompt}</strong><span>{snapshot.profiles.find(p => p.id === s.profile_id)?.name} · {s.paused ? '일시정지' : `다음 ${new Date(s.next_run_ms).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}</span></div><button className="button secondary" disabled={busy} onClick={() => void run({ type: 'pause_schedule', schedule_id: s.id, paused: !s.paused })}>{s.paused ? <Play size={14}/> : <Pause size={14}/>}<span>{s.paused ? '재개' : '일시정지'}</span></button></article>)}{!snapshot.schedules.length && <div className="quiet-empty"><Clock3 size={18}/>Ghost와의 대화에서 반복 작업을 예약할 수 있습니다.</div>}</section>
  </div>;
}
