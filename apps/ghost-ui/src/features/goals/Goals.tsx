import { useState } from 'react';
import { Plus } from 'lucide-react';
import { GOAL_TITLE_MAX, type Goal, type State } from '@ghost/contract';
import { Button, InlineError, Page, PageHeader } from '../../ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useHost } from '../../host/context';
import { uiTerms } from '../../uiText';
import { DecisionDeck } from '../Decision';
import { goalProposal } from '../decisionText';
import { GoalComposer } from './GoalComposer';
import { GoalLine } from './GoalLine';
import { GoalClauses } from './GoalStatement';
import { InlineEdit } from './InlineEdit';
import { goalError } from './goalError';
import { goalLimit, goalsAtCap, groupGoalsByScope, open, scopeName } from './goalScope';
import './goals.css';

/** The project (`null` is the whole team) a goal being typed will start in; `null` when nothing is being typed. */
type Composing = { scopeId: string | null } | null;

/** Every goal, whole-team goals first and then one group per project. */
export function Goals({ state, navigate }: { state: State; navigate(path: string): void }) {
  const [composing, setComposing] = useState<Composing>(null);
  // A new goal needs a project (or the whole team) with room; the composer lists them all, so only a full board blocks it.
  const target = [null, ...state.scopes.map(scope => scope.id)].find(id => !goalsAtCap(state, id));
  const full = target === undefined;
  const reason = state.scopes.length ? '모든 프로젝트의 목표가 가득 찼습니다.' : `진행 중이거나 일시정지한 목표는 ${goalLimit(state, null)}개까지 둘 수 있습니다.`;
  return <Page className="goals-page">
    <PageHeader title={uiTerms.goals} actions={!composing && <div className="goals-add"><Button disabled={full} aria-describedby={full ? 'goal-cap-reason' : undefined} onClick={() => setComposing({ scopeId: target ?? null })}><Plus/>목표 추가</Button>
      {full && <span id="goal-cap-reason">{reason}</span>}</div>}/>
    <GoalsBody state={state} navigate={navigate} composing={composing} setComposing={setComposing}/>
  </Page>;
}

/** The 목표 tab of one project: only its goals, each limited by the project's own cap. */
export function ScopeGoals({ state, navigate, scopeId }: { state: State; navigate(path: string): void; scopeId: string }) {
  const [composing, setComposing] = useState<Composing>(null);
  const atCap = goalsAtCap(state, scopeId);
  const started = (state.goals ?? []).some(goal => goal.scopeId === scopeId);
  return <section className="goals-page" aria-label="프로젝트 목표">
    {started && !composing && <div className="goals-add"><Button disabled={atCap} aria-describedby={atCap ? 'goal-cap-reason' : undefined} onClick={() => setComposing({ scopeId })}><Plus/>목표 추가</Button>
      {atCap && <span id="goal-cap-reason">진행 중이거나 일시정지한 목표는 {goalLimit(state, scopeId)}개까지 둘 수 있습니다.</span>}</div>}
    <GoalsBody state={state} navigate={navigate} scopeId={scopeId} composing={composing} setComposing={setComposing}/>
  </section>;
}

function GoalsBody({ state, navigate, scopeId, composing, setComposing }: {
  state: State; navigate(path: string): void; scopeId?: string; composing: Composing; setComposing(value: Composing): void;
}) {
  const goals = (state.goals ?? []).filter(goal => scopeId === undefined || goal.scopeId === scopeId);
  const openGoals = goals.filter(open).sort((a, b) => Number(a.state === 'paused') - Number(b.state === 'paused') || a.createdAt - b.createdAt);
  const closed = goals.filter(goal => !open(goal)).sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt));
  const proposals = state.decisions.filter(decision => {
    const proposal = decision.state === 'pending' ? goalProposal(decision) : null;
    return proposal !== null && (scopeId === undefined || (proposal.scopeId ?? null) === scopeId);
  }).sort((a, b) => a.createdAt - b.createdAt);
  const groups = scopeId === undefined ? groupGoalsByScope(openGoals, state) : [{ id: scopeId, name: '', goals: openGoals }];
  const labelled = scopeId === undefined && (groups.length > 1 || groups.some(group => group.id !== null));
  return <>
    {composing && <GoalComposer state={state} initialScopeId={composing.scopeId} fixedScope={scopeId !== undefined} onClose={() => setComposing(null)}/>}
    {proposals.length > 0 && <DecisionDeck state={state} navigate={navigate} decisions={proposals}/>}
    {groups.map(group => <section key={group.id ?? 'team'} className="goal-group" aria-label={labelled ? group.name : undefined}>
      {labelled && <h2 className="section-title goal-group__title">{group.name}</h2>}
      {group.goals.map(goal => <GoalSection key={goal.id} goal={goal} state={state} grouped={labelled}/>)}
    </section>)}
    {!goals.length && !composing && <div className="calm"><p>목표 없음</p><Button variant="add" size="sm" className="ml-auto" onClick={() => setComposing({ scopeId: scopeId ?? null })}>목표 추가</Button></div>}
    {closed.length > 0 && <details className="goals-closed"><summary>종료된 목표 <span>{closed.length}</span></summary>
      {closed.map(goal => <details className="goals-closed__goal" key={goal.id}>
        <summary><span>{goal.title}{scopeId === undefined && goal.scopeId !== null && <span className="goal-closed__scope"> · {scopeName(state, goal.scopeId)}</span>}</span>
          <time dateTime={new Date(goal.closedAt ?? goal.updatedAt).toISOString()}>{new Date(goal.closedAt ?? goal.updatedAt).toLocaleDateString('ko-KR')}</time></summary>
        <GoalSection goal={goal} state={state}/>
      </details>)}
    </details>}
  </>;
}

function GoalSection({ goal, state, grouped = false }: { goal: Goal; state: State; grouped?: boolean }) {
  const { client } = useHost();
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closed = goal.state === 'closed';
  const Title = grouped ? 'h3' : 'h2';
  const save = (patch: Partial<Pick<Goal, 'title' | 'why' | 'boundaries' | 'signal'>>) => client.send({ type: 'goal.update', goalId: goal.id, ...patch }).then(() => undefined);
  const changeState = async () => {
    setBusy(true); setError('');
    try { await client.send({ type: 'goal.update', goalId: goal.id, state: goal.state === 'paused' ? 'active' : 'paused' }); }
    catch (reason) { setError(goalError(reason)); }
    finally { setBusy(false); }
  };
  return <section className="goal-section" aria-label={goal.title}>
    <header className="goal-section__heading"><div><Title>{closed ? goal.title
      : <InlineEdit value={goal.title} label="방향" maxLength={GOAL_TITLE_MAX} required onSave={title => save({ title })}>{goal.title}</InlineEdit>}</Title>
      {goal.state === 'paused' && <span className="goal-paused"><span aria-hidden="true">Ⅱ</span> 일시정지</span>}</div>
      {!closed && <div className="goal-actions">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void changeState()}>{goal.state === 'paused' ? '재개' : '일시정지'}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setClosing(true)}>종료</Button></div>}
    </header>
    <GoalClauses value={goal} onSave={closed ? undefined : (field, text) => save({ [field]: text })}/>
    {error && <InlineError>{error}</InlineError>}
    <GoalLine milestones={(state.milestones ?? []).filter(item => item.goalId === goal.id)} state={state} readOnly={closed}/>
    {closing && <ConfirmDialog title="목표 종료" confirmLabel="목표 종료" onClose={() => setClosing(false)} onConfirm={async () => {
      try { await client.send({ type: 'goal.update', goalId: goal.id, state: 'closed' }); }
      catch (reason) { throw new Error(goalError(reason)); }
    }}>
      <p>「{goal.title}」 목표를 종료합니다. 진행 중이거나 예정인 이정표는 모두 접힙니다.</p>
      <p>종료한 목표는 다시 열 수 없습니다.</p>
    </ConfirmDialog>}
  </section>;
}
