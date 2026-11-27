import { useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { GOAL_TITLE_MAX, type Goal, type State } from '@ghost/contract';
import { Button, InlineError, Page, PageHeader } from '../../ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { StateGlyph } from '../../components/agent';
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
import '../Goals.css';

/** The project (`null` is the whole team) a goal being typed will start in; `null` when nothing is being typed. */
type Composing = { scopeId: string | null } | null;

/** Every goal, whole-team goals first and then one group per project. */
export function Goals({ state, navigate }: { state: State; navigate(path: string): void }) {
  const [composing, setComposing] = useState<Composing>(null);
  // A new goal needs a project (or the whole team) with room; the composer lists them all, so only a full board blocks it.
  const target = [null, ...state.scopes.map(scope => scope.id)].find(id => !goalsAtCap(state, id));
  const full = target === undefined;
  const reason = state.scopes.length ? '모든 프로젝트의 목표가 가득 찼습니다.' : `진행 중이거나 일시정지한 목표는 ${goalLimit(state, null)}개까지 둘 수 있습니다.`;
  const started = Boolean(state.goals?.length);
  const add = <AddGoal disabled={full} reason={reason} onAdd={() => setComposing({ scopeId: target ?? null })}/>;
  return <Page className="goals-page">
    <PageHeader title={uiTerms.goals} actions={started && !composing ? add : undefined}/>
    <GoalsBody state={state} navigate={navigate} composing={composing} dismissComposer={() => setComposing(null)} emptyAction={add}/>
  </Page>;
}

/** The 목표 tab of one project: only its goals, each limited by the project's own cap. */
export function ScopeGoals({ state, navigate, scopeId }: { state: State; navigate(path: string): void; scopeId: string }) {
  const [composing, setComposing] = useState<Composing>(null);
  const atCap = goalsAtCap(state, scopeId);
  const started = (state.goals ?? []).some(goal => goal.scopeId === scopeId);
  const add = <AddGoal disabled={atCap} reason={`진행 중이거나 일시정지한 목표는 ${goalLimit(state, scopeId)}개까지 둘 수 있습니다.`} onAdd={() => setComposing({ scopeId })}/>;
  return <section className="goals-page" aria-label="프로젝트 목표">
    {started && !composing && add}
    <GoalsBody state={state} navigate={navigate} scopeId={scopeId} composing={composing} dismissComposer={() => setComposing(null)} emptyAction={add}/>
  </section>;
}

function AddGoal({ disabled, reason, onAdd }: { disabled: boolean; reason: string; onAdd(): void }) {
  return <div className="goals-add">
    <Button disabled={disabled} aria-describedby={disabled ? 'goal-cap-reason' : undefined} onClick={onAdd}><Plus/>목표 추가</Button>
    {disabled && <span id="goal-cap-reason">{reason}</span>}
  </div>;
}

function GoalsBody({ state, navigate, scopeId, composing, dismissComposer, emptyAction }: {
  state: State; navigate(path: string): void; scopeId?: string; composing: Composing;
  dismissComposer(): void; emptyAction: ReactNode;
}) {
  const goals = (state.goals ?? []).filter(goal => scopeId === undefined || goal.scopeId === scopeId);
  const openGoals = goals.filter(open).sort((a, b) => Number(a.state === 'paused') - Number(b.state === 'paused') || a.createdAt - b.createdAt);
  const closed = goals.filter(goal => !open(goal)).sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt));
  const proposals = state.decisions.filter(decision => {
    const proposal = decision.state === 'pending' ? goalProposal(decision) : null;
    return proposal !== null && (scopeId === undefined || (proposal.scopeId ?? null) === scopeId);
  }).sort((a, b) => a.createdAt - b.createdAt);
  const groups = scopeId === undefined ? groupGoalsByScope(openGoals, state) : openGoals.length ? [{ id: scopeId, name: '', goals: openGoals }] : [];
  const labelled = scopeId === undefined && groups.some(group => group.id !== null);
  return <>
    {proposals.length > 0 && <div className="goals-decisions"><DecisionDeck state={state} navigate={navigate} decisions={proposals}/></div>}
    {composing && <GoalComposer state={state} initialScopeId={composing.scopeId} fixedScope={scopeId !== undefined} onClose={dismissComposer}/>}
    {groups.map(group => <section key={group.id ?? 'team'} className="goal-group" aria-label={labelled ? group.name : undefined}>
      {labelled && <h2 className="section-title">{group.name}</h2>}
      <div className="goal-group__rows">{group.goals.map(goal => <GoalSection key={goal.id} goal={goal} state={state} grouped={labelled}/>)}</div>
    </section>)}
    {!goals.length && !composing && <div className="goals-empty"><p>목표 없음</p>{emptyAction}</div>}
    {closed.length > 0 && <details className="goals-closed"><summary>종료된 목표</summary>
      <div className="goal-group__rows">{closed.map(goal => {
        const at = new Date(goal.closedAt ?? goal.updatedAt);
        return <details className="goals-closed__goal" key={goal.id}>
          <summary>
            <span className="goal-row__glyph" aria-hidden="true"><StateGlyph state="cancelled"/></span>
            <span className="goal-row__copy"><span className="goal-row__title">{goal.title}</span>
              <span className="goal-row__meta">{scopeId === undefined && `${scopeName(state, goal.scopeId)} · `}종료</span>
            </span>
            <time className="goal-row__time" dateTime={at.toISOString()}>{at.toLocaleDateString('ko-KR')}</time>
          </summary>
          <GoalSection goal={goal} state={state}/>
        </details>;
      })}</div>
    </details>}
  </>;
}

function GoalSection({ goal, state, grouped = false }: { goal: Goal; state: State; grouped?: boolean }) {
  const { client } = useHost();
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closed = goal.state === 'closed';
  const milestones = (state.milestones ?? []).filter(item => item.goalId === goal.id);
  const paused = goal.state === 'paused';
  const Title = grouped ? 'h3' : 'h2';
  const save = (patch: Partial<Pick<Goal, 'title' | 'why' | 'boundaries' | 'signal'>>) => client.send({ type: 'goal.update', goalId: goal.id, ...patch }).then(() => undefined);
  const changeState = async () => {
    setBusy(true); setError('');
    try { await client.send({ type: 'goal.update', goalId: goal.id, state: goal.state === 'paused' ? 'active' : 'paused' }); }
    catch (reason) { setError(goalError(reason)); }
    finally { setBusy(false); }
  };
  return <section className="goal-section" aria-label={goal.title} data-closed={closed || undefined}>
    {!closed && <header className="goal-section__heading">
      <span className="goal-row__glyph" aria-hidden="true"><StateGlyph state={paused ? 'waiting' : 'queued'} mark="ring"/></span>
      <div className="goal-row__copy">
        <Title className="goal-row__title"><InlineEdit value={goal.title} label="방향" maxLength={GOAL_TITLE_MAX} required onSave={title => save({ title })}>{goal.title}</InlineEdit></Title>
        <p className="goal-row__meta">{paused ? '일시정지' : '진행 중'}{milestones.length === 0 && <> · <span>이정표 없음</span></>}</p>
      </div>
      <div className="goal-actions">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void changeState()}>{paused ? '재개' : '일시정지'}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setClosing(true)}>종료</Button>
      </div>
    </header>}
    <div className="goal-section__body">
      <GoalClauses value={goal} onSave={closed ? undefined : (field, text) => save({ [field]: text })}/>
      {error && <InlineError>{error}</InlineError>}
      {(milestones.length > 0 || closed) && <GoalLine milestones={milestones} state={state} readOnly={closed}/>}
    </div>
    {closing && <ConfirmDialog title="목표 종료" confirmLabel="목표 종료" onClose={() => setClosing(false)} onConfirm={async () => {
      try { await client.send({ type: 'goal.update', goalId: goal.id, state: 'closed' }); }
      catch (reason) { throw new Error(goalError(reason)); }
    }}>
      <p>「{goal.title}」 목표를 종료합니다. 진행 중이거나 예정인 이정표는 모두 접힙니다.</p>
      <p>종료한 목표는 다시 열 수 없습니다.</p>
    </ConfirmDialog>}
  </section>;
}
