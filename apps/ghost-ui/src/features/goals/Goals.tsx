import { useState } from 'react';
import { Plus } from 'lucide-react';
import { GOAL_SIGNAL_MAX, GOAL_TEXT_MAX, GOAL_TITLE_MAX, type Goal, type State } from '@ghost/contract';
import { Button, FormField, InlineError, Input, Page, PageHeader, Textarea } from '../../ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { useHost } from '../../host/context';
import { uiTerms } from '../../uiText';
import { DecisionDeck } from '../Decision';
import { goalProposal } from '../decisionText';
import { Choice } from '../InfrastructureFields';
import { GoalLine } from './GoalLine';
import { goalError } from './goalError';
import { goalLimit, goalsAtCap, groupGoalsByScope, open, scopeName } from './goalScope';
import './goals.css';

/** A goal being edited, or the project (`null` is the whole team) a new goal starts in. */
type Editing = { goal: Goal } | { scopeId: string | null } | null;

/** Every goal, whole-team goals first and then one group per project. */
export function Goals({ state, navigate }: { state: State; navigate(path: string): void }) {
  const [editing, setEditing] = useState<Editing>(null);
  // A new goal needs a project (or the whole team) with room; the form lists them all, so only a full board blocks it.
  const target = [null, ...state.scopes.map(scope => scope.id)].find(id => !goalsAtCap(state, id));
  const full = target === undefined;
  const reason = state.scopes.length ? '모든 프로젝트의 목표가 가득 찼습니다.' : `진행 중이거나 일시정지한 목표는 ${goalLimit(state, null)}개까지 둘 수 있습니다.`;
  return <Page className="goals-page">
    <PageHeader title={uiTerms.goals} actions={<div className="goals-add"><Button disabled={full} aria-describedby={full ? 'goal-cap-reason' : undefined} onClick={() => setEditing({ scopeId: target ?? null })}><Plus/>목표 추가</Button>
      {full && <span id="goal-cap-reason">{reason}</span>}</div>}/>
    <GoalsBody state={state} navigate={navigate} editing={editing} setEditing={setEditing}/>
  </Page>;
}

/** The 목표 tab of one project: only its goals, each limited by the project's own cap. */
export function ScopeGoals({ state, navigate, scopeId }: { state: State; navigate(path: string): void; scopeId: string }) {
  const [editing, setEditing] = useState<Editing>(null);
  const atCap = goalsAtCap(state, scopeId);
  const started = (state.goals ?? []).some(goal => goal.scopeId === scopeId);
  return <section className="goals-page" aria-label="프로젝트 목표">
    {started && <div className="goals-add"><Button disabled={atCap} aria-describedby={atCap ? 'goal-cap-reason' : undefined} onClick={() => setEditing({ scopeId })}><Plus/>목표 추가</Button>
      {atCap && <span id="goal-cap-reason">진행 중이거나 일시정지한 목표는 {goalLimit(state, scopeId)}개까지 둘 수 있습니다.</span>}</div>}
    <GoalsBody state={state} navigate={navigate} scopeId={scopeId} editing={editing} setEditing={setEditing}/>
  </section>;
}

function GoalsBody({ state, navigate, scopeId, editing, setEditing }: {
  state: State; navigate(path: string): void; scopeId?: string; editing: Editing; setEditing(value: Editing): void;
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
    {proposals.length > 0 && <DecisionDeck state={state} navigate={navigate} decisions={proposals}/>}
    {groups.map(group => <section key={group.id ?? 'team'} className="goal-group" aria-label={labelled ? group.name : undefined}>
      {labelled && <h2 className="section-title goal-group__title">{group.name}</h2>}
      {group.goals.map(goal => <GoalSection key={goal.id} goal={goal} state={state} grouped={labelled} onEdit={() => setEditing({ goal })}/>)}
    </section>)}
    {!goals.length && <div className="calm"><p>목표 없음</p><Button variant="outline" size="sm" className="ml-auto" onClick={() => setEditing({ scopeId: scopeId ?? null })}>목표 추가</Button></div>}
    {closed.length > 0 && <details className="goals-closed"><summary>종료된 목표 <span>{closed.length}</span></summary>
      {closed.map(goal => <details className="goals-closed__goal" key={goal.id}>
        <summary><span>{goal.title}{scopeId === undefined && goal.scopeId !== null && <span className="goal-closed__scope"> · {scopeName(state, goal.scopeId)}</span>}</span>
          <time dateTime={new Date(goal.closedAt ?? goal.updatedAt).toISOString()}>{new Date(goal.closedAt ?? goal.updatedAt).toLocaleDateString('ko-KR')}</time></summary>
        <GoalSection goal={goal} state={state}/>
      </details>)}
    </details>}
    {editing && <GoalForm state={state} editing={editing} fixedScope={scopeId !== undefined} onClose={() => setEditing(null)}/>}
  </>;
}

function GoalSection({ goal, state, grouped = false, onEdit }: { goal: Goal; state: State; grouped?: boolean; onEdit?(): void }) {
  const { client } = useHost();
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closed = goal.state === 'closed';
  const Title = grouped ? 'h3' : 'h2';
  const changeState = async () => {
    setBusy(true); setError('');
    try { await client.send({ type: 'goal.update', goalId: goal.id, state: goal.state === 'paused' ? 'active' : 'paused' }); }
    catch (reason) { setError(goalError(reason)); }
    finally { setBusy(false); }
  };
  return <section className="goal-section" aria-label={goal.title}>
    <header className="goal-section__heading"><div><Title>{goal.title}</Title>{goal.state === 'paused' && <span className="goal-paused"><span aria-hidden="true">Ⅱ</span> 일시정지</span>}</div>
      {!closed && <div className="goal-actions"><Button variant="ghost" size="sm" disabled={busy} onClick={onEdit}>수정</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void changeState()}>{goal.state === 'paused' ? '재개' : '일시정지'}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setClosing(true)}>종료</Button></div>}
    </header>
    {goal.why && <p className="goal-section__why">{goal.why}</p>}
    {(goal.boundaries || goal.signal) && <dl className="goal-facts goal-section__context">
      {goal.boundaries && <div><dt>지키는 선</dt><dd>{goal.boundaries}</dd></div>}
      {goal.signal && <div><dt>참고 신호</dt><dd>{goal.signal}</dd></div>}
    </dl>}
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

function GoalForm({ state, editing, fixedScope, onClose }: { state: State; editing: Exclude<Editing, null>; fixedScope: boolean; onClose(): void }) {
  const { client } = useHost();
  const goal = 'goal' in editing ? editing.goal : null;
  const [scopeId, setScopeId] = useState<string | null>('goal' in editing ? editing.goal.scopeId : editing.scopeId);
  const [title, setTitle] = useState(goal?.title ?? '');
  const [why, setWhy] = useState(goal?.why ?? '');
  const [boundaries, setBoundaries] = useState(goal?.boundaries ?? '');
  const [signal, setSignal] = useState(goal?.signal ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const atCap = !goal && goalsAtCap(state, scopeId);
  const submit = async () => {
    if (busy) return;
    if (!title.trim()) { setError('방향을 적어 주세요.'); return; }
    setBusy(true); setError('');
    const fields = { title: title.trim(), why: why.trim(), boundaries: boundaries.trim(), signal: signal.trim() };
    try {
      await client.send(goal ? { type: 'goal.update', goalId: goal.id, ...fields } : { type: 'goal.create', ...(scopeId ? { scopeId } : {}), ...fields });
      onClose();
    } catch (reason) { setError(goalError(reason)); setBusy(false); }
  };
  return <Modal title={goal ? '목표 수정' : '목표 추가'} onClose={() => { if (!busy) onClose(); }}>
    <form className="goal-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {!goal && !fixedScope && state.scopes.length > 0 && <Choice label="프로젝트" value={scopeId ?? ''} onChange={value => setScopeId(value || null)}
        options={[{ value: '', label: '전체' }, ...state.scopes.map(scope => ({ value: scope.id, label: scope.name }))]}/>}
      <FormField label="방향" required>{control => <Input {...control} required maxLength={GOAL_TITLE_MAX} value={title} disabled={busy} onChange={event => setTitle(event.target.value)}/>}</FormField>
      <FormField label="이유">{control => <Textarea {...control} rows={3} maxLength={GOAL_TEXT_MAX} value={why} disabled={busy} onChange={event => setWhy(event.target.value)}/>}</FormField>
      <FormField label="지키는 선">{control => <Textarea {...control} rows={2} maxLength={GOAL_TEXT_MAX} value={boundaries} disabled={busy} onChange={event => setBoundaries(event.target.value)}/>}</FormField>
      <FormField label="참고 신호">{control => <Textarea {...control} rows={2} maxLength={GOAL_SIGNAL_MAX} value={signal} disabled={busy} onChange={event => setSignal(event.target.value)}/>}</FormField>
      {error && <InlineError>{error}</InlineError>}
      {atCap && <p className="goal-form__cap">진행 중이거나 일시정지한 목표는 {goalLimit(state, scopeId)}개까지 둘 수 있습니다.</p>}
      <Button type="submit" className="justify-self-end" disabled={busy || atCap}>{busy ? '저장 중…' : goal ? '저장' : '목표 추가'}</Button>
    </form>
  </Modal>;
}
