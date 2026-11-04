import { DetailDialog } from '../components/DetailDialog';
import { Card } from '@garden/ui';
import { uiTerms } from '../uiText';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleAlert, CircleCheck, Clock3, FileText, Folder, GitBranch, ListTodo, Monitor, Phone, Settings2, Plus, Square, Target } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { delegationContext, finishedDelegation } from '../client/collaboration';
import { dotState, stateLabel, isRunning, phaseLabel, toneFor } from '../client/types';
import type { Conversation, Profile, Review, Snapshot, Task } from '../client/types';
import { contextualCards } from './contextProjection';
import './conversation-context.css';

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

export function ConversationContext({ workContent, workCount, profile, conversation, snapshot, busy, connected, navigate, onReview, onCancel, onSchedule, management = false, onVoice, onSettings, voiceAvailable = false }: Props) {
  const context = contextualCards(snapshot, profile.id, conversation?.id);
  const connectedComputer = snapshot.connectors.computer;
  return <div className="conversation-context context-card-stack" aria-label={`${profile.name} 프로필과 활동`}>
    <Card className="context-profile-card" role="region" aria-label={`${profile.name} 프로필`}>
    <div className="context-profile-header"><button type="button" className="avatar-edit-button" aria-label={`${profile.name} 아바타 변경`} onClick={() => navigate(`/settings?tab=pets&ghost=${encodeURIComponent(profile.id)}`)}><DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={56}/></button><div><strong>{profile.name}</strong><span>{stateLabel[dotState(profile, snapshot.reviews)]}</span></div></div>
    <div className="context-profile-actions">{onVoice && <button type="button" disabled={!voiceAvailable} onClick={onVoice}><Phone size={16}/>전화</button>}{onSettings && <button type="button" aria-label={`${profile.name} 설정`} onClick={onSettings}><Settings2 size={16}/>Ghost 설정</button>}</div>
    </Card>
    <ContextCard title="컴퓨터" icon={<Monitor size={16}/>}><button type="button" className="context-entry" onClick={() => navigate('/integrations')}><Monitor size={17}/><span><strong>{connectedComputer ? '실행 환경' : '연결된 실행 환경 없음'}</strong><small>{connectedComputer ? '사용 가능 · 도구 연결 보기' : '도구 연결'}</small></span><ArrowUpRight size={14}/></button><dl className="context-permissions"><div><dt>웹 검색·읽기</dt><dd>{profile.policy.web === true ? '허용' : '허용 안 됨'}</dd></div><div><dt>OMP 분석 작업자</dt><dd>{profile.policy.external_worker === true ? '허용' : '허용 안 됨'}</dd></div><div><dt>Codex 코드 작업자</dt><dd>{profile.policy.code_worker === true ? '허용' : '허용 안 됨'}</dd></div>{connectedComputer && <><div><dt>브라우저</dt><dd>{profile.policy.browser === true ? '허용' : '허용 안 됨'}</dd></div><div><dt>셸</dt><dd>{profile.policy.shell === true ? '허용' : '허용 안 됨'}</dd></div></>}</dl></ContextCard>
      {context.reviews.length > 0 && <ContextCard title={uiTerms.reviews} icon={<CircleAlert size={16}/>} count={context.reviews.length} attention>
        {context.reviews.map(review => <button type="button" className="context-entry context-review-entry" key={review.id} onClick={() => onReview(review)}><FileText size={16}/><span><strong>{review.title}</strong><small>{review.state === 'approved' ? '승인됨 · 저장 대기' : '검토 대기'}</small></span><ArrowUpRight size={14}/></button>)}
      </ContextCard>}

      {workContent && <ContextCard title={uiTerms.work} icon={<ListTodo size={16}/>} count={workCount}>{workContent}</ContextCard>}

      {(context.currentTasks.length > 0 || (management && context.pastTasks.length > 0)) && <ContextCard title="활동" icon={<ListTodo size={16}/>} count={context.currentTasks.length + context.pastTasks.length}>
        <div className="context-task-list">
          {context.currentTasks.map(task => <TaskRow key={task.id} task={task} disabled={busy || !connected} onCancel={onCancel}/>)}
        </div>
        {context.pastTasks.length > 0 && <DetailDialog title="지난 작업" label={<>지난 작업 {context.pastTasks.length}개</>} className="context-task-history"><div className="context-task-list">{context.pastTasks.map(task => <TaskRow key={task.id} task={task} disabled onCancel={onCancel}/>)}</div></DetailDialog>}
      </ContextCard>}

      {(context.activeDelegations.length > 0 || (management && context.delegations.length > 0)) && <ContextCard title="협업" icon={<GitBranch size={16}/>} count={context.delegations.length}>
        {context.delegations.length ? context.delegations.map(delegation => {
          const item = delegationContext(snapshot, delegation);
          const outgoing = delegation.owner === profile.id;
          const peer = outgoing ? delegation.target : delegation.owner;
          const peerProfile = outgoing ? item.target : item.owner;
          const openRecord = () => navigate(`/together?delegation=${encodeURIComponent(delegation.id)}`);
          if (finishedDelegation(delegation)) {
            return <button key={delegation.id} type="button" className="context-entry" onClick={openRecord}>
              <GitBranch size={16}/><span><strong>{item.title}</strong><small>{item.label}</small></span><ArrowUpRight size={14}/>
            </button>;
          }
          return <div key={delegation.id} className="context-collaboration">
            <div className="context-collaborator"><DotAvatar profileId={peer} tone={toneFor(peer)} size={34}/><div><strong>{peerProfile?.name ?? 'Ghost'}</strong><span>{outgoing ? '작업을 맡김' : '작업을 받음'}</span></div><span className={`context-phase ${item.status === 'attention' ? 'needs-attention' : ''}`}><span className={`mini-dot ${!finishedDelegation(delegation) ? 'active' : ''}`} aria-hidden="true"/>{item.label}</span></div>
            <p className="context-collaboration-title">{item.title}</p>
            {item.summary && <p className="context-collaboration-summary">{item.summary}</p>}
            <button type="button" className="context-card-action" onClick={openRecord}>협업 기록<ArrowUpRight size={13}/></button>
          </div>;
        }) : <p className="context-card-empty">이 대화의 협업 없음</p>}
      </ContextCard>}

      {context.goals.length > 0 && <ContextCard title={uiTerms.goals} icon={<Target size={16}/>} count={context.goals.length}>
        {context.goals.map(goal => <div className="context-goal-entry" key={goal.id}><span className={`context-goal-mark ${goal.state === 'complete' ? 'is-complete' : ''}`} aria-label={goal.state === 'complete' ? '완료' : '미완료'}>{goal.state === 'complete' ? <Check size={12}/> : null}</span><div><strong>{goal.title}</strong>{(goal.note || goal.criteria) && <p>{goal.note || goal.criteria}</p>}</div></div>)}
        <button type="button" className="context-card-action" onClick={() => navigate('/work')}>목표 관리<ArrowUpRight size={13}/></button>
      </ContextCard>}

      {(context.spaces.length > 0) && <ContextCard title="문서 폴더" icon={<Folder size={16}/>} count={context.spaces.length}>
        {context.spaces.length ? context.spaces.map(space => <button type="button" className="context-entry" key={space.id} onClick={() => navigate(`/spaces/${encodeURIComponent(space.id)}`)}><Folder size={16}/><span><strong>{space.name}</strong><small>{space.writable ? '읽기 · 쓰기' : '읽기 전용'}</small></span><ArrowUpRight size={14}/></button>) : <p className="context-card-empty">연결된 공간 없음</p>}
      </ContextCard>}

      {(context.schedules.length > 0 || management) && <ContextCard title={uiTerms.schedules} icon={<Clock3 size={16}/>} count={context.schedules.length}>
        {context.schedules.length ? context.schedules.map(schedule => <div className="context-schedule-entry" key={schedule.id}><strong>{schedule.prompt}</strong><span>{schedule.paused ? '일시정지' : `다음 ${new Date(schedule.next_run_ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}</span></div>) : <p className="context-card-empty">예약된 작업 없음</p>}
        <div className="context-card-actions"><button type="button" className="context-card-action" disabled={!conversation || busy || !connected} onClick={onSchedule}><Plus size={14}/>{uiTerms.schedules} 예약</button>{context.schedules.length > 0 && <button type="button" className="context-card-action" onClick={() => navigate('/work')}>관리<ArrowRight size={13}/></button>}</div>
      </ContextCard>}

  </div>;
}

function ContextCard({ title, icon, count, status, attention = false, children }: { title: string; icon: ReactNode; count?: number; status?: string; attention?: boolean; children: ReactNode }) {
  const id = useId();
  return <Card className={`context-card ${attention ? 'context-card-attention' : ''}`} role="region" aria-labelledby={`${id}-label`}>
    <h3 className="context-card-heading" id={`${id}-label`}><span className="context-card-icon" aria-hidden="true">{icon}</span><span className="context-card-title">{title}</span>{count !== undefined && <span className="context-card-count">{count}</span>}{status && <span className="context-card-status">{status}</span>}</h3>
    <div className="context-card-body">{children}</div>
  </Card>;
}

function TaskRow({ task, disabled, onCancel }: { task: Task; disabled: boolean; onCancel: (task: Task) => void }) {
  const running = isRunning(task.phase), attention = ['waiting_owner', 'uncertain', 'failed'].includes(task.phase);
  return <div className={`context-task-entry ${attention ? 'needs-attention' : ''}`}>
    <span className="context-task-mark" aria-hidden="true">{task.phase === 'complete' ? <CircleCheck size={14}/> : attention ? <CircleAlert size={14}/> : <span className={`mini-dot ${running ? 'active' : ''}`}/>}</span>
    <div className="context-task-copy"><strong>{task.name}</strong><span>{phaseLabel(task.phase)}</span></div>
    {running && <button type="button" className="icon-button small" disabled={disabled} onClick={() => onCancel(task)} aria-label={`${task.name} 취소`} title="작업 취소"><Square size={12}/></button>}
  </div>;
}
