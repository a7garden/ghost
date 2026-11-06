import { DetailDialog } from '../components/DetailDialog';
import { Badge, Button, Card, cn } from '@garden/ui';
import { uiTerms } from '../uiText';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleAlert, CircleCheck, Clock3, FileText, Folder, GitBranch, ListTodo, Monitor, Phone, Settings2, Plus, Square, Target } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { delegationContext, finishedDelegation } from '../client/collaboration';
import { dotState, stateLabel, isRunning, phaseLabel, toneFor } from '../client/types';
import type { Conversation, Profile, Review, Snapshot, Task } from '../client/types';
import { contextualCards } from './contextProjection';

type Props = {
  workContent?: ReactNode;
  workCount?: number;
  profile: Profile;
  conversation?: Conversation;
  snapshot: Snapshot;
  busy: boolean;
  connected: boolean;
  navigate: (route: string) => void;
  onReview: (review: Review) => void;
  onCancel: (task: Task) => void;
  onSchedule: () => void;
  management?: boolean;
  onVoice?: () => void;
  onSettings?: () => void;
  voiceAvailable?: boolean;
};

/** Quiet row that opens a destination; the leading icon and trailing arrow mark it as navigation. */
const entryClass = 'group flex w-full min-w-0 items-center gap-2.5 rounded-control py-2 text-left';

export function ConversationContext({ workContent, workCount, profile, conversation, snapshot, busy, connected, navigate, onReview, onCancel, onSchedule, management = false, onVoice, onSettings, voiceAvailable = false }: Props) {
  const context = contextualCards(snapshot, profile.id, conversation?.id);
  const connectedComputer = snapshot.connectors.computer;
  return <div className="flex min-w-0 flex-col gap-3" aria-label={`${profile.name} 프로필과 활동`}>
    <Card role="region" aria-label={`${profile.name} 프로필`}>
      <div className="flex min-w-0 items-center gap-3">
        <button type="button" className="shrink-0 rounded-full outline-none hover:bg-hover" aria-label={`${profile.name} 아바타 변경`} onClick={() => navigate(`/settings?tab=pets&ghost=${encodeURIComponent(profile.id)}`)}><DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={56}/></button>
        <div className="grid min-w-0 gap-1"><strong className="text-body font-semibold [overflow-wrap:anywhere]">{profile.name}</strong><span className="text-caption text-ink-2">{stateLabel[dotState(profile, snapshot.reviews)]}</span></div>
      </div>
      <div className="mt-4 flex gap-2">{onVoice && <Button type="button" variant="secondary" size="lg" className="min-w-0 flex-1" disabled={!voiceAvailable} onClick={onVoice}><Phone size={16}/>전화</Button>}{onSettings && <Button type="button" variant="secondary" size="lg" className="min-w-0 flex-1" aria-label={`${profile.name} 설정`} onClick={onSettings}><Settings2 size={16}/>Ghost 설정</Button>}</div>
    </Card>
    <ContextCard title="컴퓨터" icon={<Monitor size={16}/>}><button type="button" className={entryClass} onClick={() => navigate('/settings?tab=extensions')}><Monitor size={17} className="shrink-0 text-ink-3"/><span className="grid min-w-0 flex-1 gap-0.5"><strong className="text-ui leading-relaxed [overflow-wrap:anywhere] group-hover:underline group-hover:underline-offset-2">{connectedComputer ? '실행 환경' : '연결된 실행 환경 없음'}</strong><small className="text-caption text-ink-2">{connectedComputer ? '사용 가능 · 도구 연결 보기' : '도구 연결'}</small></span><ArrowUpRight size={14} className="shrink-0 text-ink-3"/></button><dl className="mt-3 grid gap-1.5 text-caption"><div className="flex justify-between gap-3"><dt className="text-ink-2">웹 검색·읽기</dt><dd className="text-ink-2">{profile.policy.web === true ? '허용' : '허용 안 됨'}</dd></div><div className="flex justify-between gap-3"><dt className="text-ink-2">OMP 분석 작업자</dt><dd className="text-ink-2">{profile.policy.external_worker === true ? '허용' : '허용 안 됨'}</dd></div><div className="flex justify-between gap-3"><dt className="text-ink-2">Codex 코드 작업자</dt><dd className="text-ink-2">{profile.policy.code_worker === true ? '허용' : '허용 안 됨'}</dd></div>{connectedComputer && <><div className="flex justify-between gap-3"><dt className="text-ink-2">브라우저</dt><dd className="text-ink-2">{profile.policy.browser === true ? '허용' : '허용 안 됨'}</dd></div><div className="flex justify-between gap-3"><dt className="text-ink-2">셸</dt><dd className="text-ink-2">{profile.policy.shell === true ? '허용' : '허용 안 됨'}</dd></div></>}</dl></ContextCard>
      {context.reviews.length > 0 && <ContextCard title={uiTerms.reviews} icon={<CircleAlert size={16}/>} count={context.reviews.length} attention>
        <div className="grid">{context.reviews.map(review => <button type="button" className={entryClass} key={review.id} onClick={() => onReview(review)}><FileText size={16} className="shrink-0 text-ink-3"/><span className="grid min-w-0 flex-1 gap-0.5"><strong className="text-ui leading-relaxed [overflow-wrap:anywhere] group-hover:underline group-hover:underline-offset-2">{review.title}</strong><small className="text-caption text-ink-2">{review.state === 'approved' ? '승인됨 · 저장 대기' : '검토 대기'}</small></span><ArrowUpRight size={14} className="shrink-0 text-ink-3"/></button>)}</div>
      </ContextCard>}

      {workContent && <ContextCard title={uiTerms.work} icon={<ListTodo size={16}/>} count={workCount}>{workContent}</ContextCard>}

      {(context.currentTasks.length > 0 || (management && context.pastTasks.length > 0)) && <ContextCard title="활동" icon={<ListTodo size={16}/>} count={context.currentTasks.length + context.pastTasks.length}>
        <div className="grid">
          {context.currentTasks.map(task => <TaskRow key={task.id} task={task} disabled={busy || !connected} onCancel={onCancel}/>)}
        </div>
        {context.pastTasks.length > 0 && <DetailDialog title="지난 작업" label={<>지난 작업 {context.pastTasks.length}개</>} className="mt-2 border-t border-line pt-2"><div className="grid">{context.pastTasks.map(task => <TaskRow key={task.id} task={task} disabled onCancel={onCancel}/>)}</div></DetailDialog>}
      </ContextCard>}

      {(context.activeDelegations.length > 0 || (management && context.delegations.length > 0)) && <ContextCard title="협업" icon={<GitBranch size={16}/>} count={context.delegations.length}>
        {context.delegations.length ? context.delegations.map(delegation => {
          const item = delegationContext(snapshot, delegation);
          const outgoing = delegation.owner === profile.id;
          const peer = outgoing ? delegation.target : delegation.owner;
          const peerProfile = outgoing ? item.target : item.owner;
          const openRecord = () => navigate(`/together?delegation=${encodeURIComponent(delegation.id)}`);
          if (finishedDelegation(delegation)) {
            return <button key={delegation.id} type="button" className={entryClass} onClick={openRecord}>
              <GitBranch size={16} className="shrink-0 text-ink-3"/><span className="grid min-w-0 flex-1 gap-0.5"><strong className="text-ui leading-relaxed [overflow-wrap:anywhere] group-hover:underline group-hover:underline-offset-2">{item.title}</strong><small className="text-caption text-ink-2">{item.label}</small></span><ArrowUpRight size={14} className="shrink-0 text-ink-3"/>
            </button>;
          }
          return <div key={delegation.id} className="min-w-0 py-1.5 [&+&]:mt-2.5 [&+&]:border-t [&+&]:border-line [&+&]:pt-3">
            <div className="flex flex-wrap items-center gap-1.5"><DotAvatar profileId={peer} tone={toneFor(peer)} size={34}/><div className="grid min-w-0 flex-1 gap-0.5"><strong className="text-ui font-medium [overflow-wrap:anywhere]">{peerProfile?.name ?? 'Ghost'}</strong><span className="text-caption text-ink-2">{outgoing ? '작업을 맡김' : '작업을 받음'}</span></div><span className={cn('inline-flex items-center gap-1 text-caption text-ink-2', item.status === 'attention' && 'text-warning')}><span className={`mini-dot ${!finishedDelegation(delegation) ? 'active' : ''}`} aria-hidden="true"/>{item.label}</span></div>
            <p className="mt-2.5 text-ui leading-relaxed [overflow-wrap:anywhere]">{item.title}</p>
            {item.summary && <p className="mt-1 line-clamp-3 text-caption leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{item.summary}</p>}
            <Button type="button" variant="ghost" size="sm" className="mt-1 -ml-2 justify-self-start text-ink-2 hover:text-ink" onClick={openRecord}>협업 기록<ArrowUpRight size={13}/></Button>
          </div>;
        }) : <p className="py-1 text-caption text-ink-2">이 대화의 협업 없음</p>}
      </ContextCard>}

      {context.goals.length > 0 && <ContextCard title={uiTerms.goals} icon={<Target size={16}/>} count={context.goals.length}>
        <div className="grid gap-2">{context.goals.map(goal => <div className="flex min-w-0 items-start gap-2" key={goal.id}><span className={`mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border border-line-strong ${goal.state === 'complete' ? 'text-ink-2' : ''}`} aria-label={goal.state === 'complete' ? '완료' : '미완료'}>{goal.state === 'complete' ? <Check size={12}/> : null}</span><div className="min-w-0"><strong className="text-ui [overflow-wrap:anywhere]">{goal.title}</strong>{(goal.note || goal.criteria) && <p className="mt-1 text-caption leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{goal.note || goal.criteria}</p>}</div></div>)}</div>
        <Button type="button" variant="ghost" size="sm" className="mt-1 -ml-2 justify-self-start text-ink-2 hover:text-ink" onClick={() => navigate('/work')}>목표 관리<ArrowUpRight size={13}/></Button>
      </ContextCard>}

      {(context.spaces.length > 0) && <ContextCard title="문서 폴더" icon={<Folder size={16}/>} count={context.spaces.length}>
        {context.spaces.length ? <div className="grid">{context.spaces.map(space => <button type="button" className={entryClass} key={space.id} onClick={() => navigate(`/spaces/${encodeURIComponent(space.id)}`)}><Folder size={16} className="shrink-0 text-ink-3"/><span className="grid min-w-0 flex-1 gap-0.5"><strong className="text-ui leading-relaxed [overflow-wrap:anywhere] group-hover:underline group-hover:underline-offset-2">{space.name}</strong><small className="text-caption text-ink-2">{space.writable ? '읽기 · 쓰기' : '읽기 전용'}</small></span><ArrowUpRight size={14} className="shrink-0 text-ink-3"/></button>)}</div> : <p className="py-1 text-caption text-ink-2">연결된 공간 없음</p>}
      </ContextCard>}

      {(context.schedules.length > 0 || management) && <ContextCard title={uiTerms.schedules} icon={<Clock3 size={16}/>} count={context.schedules.length}>
        {context.schedules.length ? <div className="grid">{context.schedules.map(schedule => <div className="grid gap-1 py-1.5 [&+&]:mt-0.5 [&+&]:border-t [&+&]:border-line [&+&]:pt-2.5" key={schedule.id}><strong className="text-ui [overflow-wrap:anywhere]">{schedule.prompt}</strong><span className="text-caption text-ink-2">{schedule.paused ? '일시정지' : `다음 ${new Date(schedule.next_run_ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}</span></div>)}</div> : <p className="py-1 text-caption text-ink-2">예약된 작업 없음</p>}
        <div className="mt-1 flex items-center justify-between gap-2.5"><Button type="button" variant="ghost" size="sm" className="-ml-2 text-ink-2 hover:text-ink" disabled={!conversation || busy || !connected} onClick={onSchedule}><Plus size={14}/>{uiTerms.schedules} 예약</Button>{context.schedules.length > 0 && <Button type="button" variant="ghost" size="sm" className="text-ink-2 hover:text-ink" onClick={() => navigate('/work')}>관리<ArrowRight size={13}/></Button>}</div>
      </ContextCard>}

  </div>;
}

function ContextCard({ title, icon, count, status, attention = false, children }: { title: string; icon: ReactNode; count?: number; status?: string; attention?: boolean; children: ReactNode }) {
  const id = useId();
  return <Card role="region" aria-labelledby={`${id}-label`} className="gap-0 py-4">
    <h3 id={`${id}-label`} className={cn('flex min-w-0 items-center gap-2 px-4 text-ui font-semibold', attention && 'text-warning')}><span aria-hidden="true" className={cn('flex shrink-0', attention ? 'text-warning' : 'text-ink-2')}>{icon}</span><span className="min-w-0 flex-1 truncate">{title}</span>{count !== undefined && <Badge variant={attention ? 'warning' : 'default'}>{count}</Badge>}{status && <span className="text-caption font-normal text-ink-2">{status}</span>}</h3>
    <div className="mt-3 grid min-w-0 px-4">{children}</div>
  </Card>;
}

function TaskRow({ task, disabled, onCancel }: { task: Task; disabled: boolean; onCancel: (task: Task) => void }) {
  const running = isRunning(task.phase), attention = ['waiting_owner', 'uncertain', 'failed'].includes(task.phase);
  return <div className={cn('flex items-start gap-2 py-2 [&+&]:border-t [&+&]:border-line', attention && 'text-warning')}>
    <span aria-hidden="true" className={cn('grid size-4 shrink-0 place-items-center', attention ? 'text-warning' : 'text-ink-3')}>{task.phase === 'complete' ? <CircleCheck size={14}/> : attention ? <CircleAlert size={14}/> : <span className={`mini-dot ${running ? 'active' : ''}`}/>}</span>
    <div className="grid min-w-0 flex-1 gap-0.5"><strong className="text-ui leading-relaxed [overflow-wrap:anywhere]">{task.name}</strong><span className="text-caption text-ink-2">{phaseLabel(task.phase)}</span></div>
    {running && <Button type="button" variant="ghost" size="icon" className="size-6" disabled={disabled} onClick={() => onCancel(task)} aria-label={`${task.name} 취소`} title="작업 취소"><Square size={12}/></Button>}
  </div>;
}
