import { useState } from 'react';
import { Plus } from 'lucide-react';
import { GOAL_SIGNAL_MAX, GOAL_TEXT_MAX, GOAL_TITLE_MAX, MAX_OPEN_GOALS, type Goal, type State } from '@ghost/contract';
import { Button, FormField, InlineError, Input, Page, PageHeader, Textarea } from '../../ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { useHost } from '../../host/context';
import { uiTerms } from '../../uiText';
import { DecisionDeck } from '../Decision';
import { goalProposal } from '../decisionText';
import { GoalLine } from './GoalLine';
import { goalError } from './goalError';
import './goals.css';

export function Goals({ state, navigate }: { state: State; navigate(path: string): void }) {
  const [editing, setEditing] = useState<Goal | 'new' | null>(null);
  const goals = state.goals ?? [];
  const open = goals.filter(goal => goal.state !== 'closed').sort((a, b) => Number(a.state === 'paused') - Number(b.state === 'paused') || a.createdAt - b.createdAt);
  const closed = goals.filter(goal => goal.state === 'closed').sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt));
  const proposals = state.decisions.filter(decision => decision.state === 'pending' && goalProposal(decision)).sort((a, b) => a.createdAt - b.createdAt);
  const atCap = open.length >= MAX_OPEN_GOALS;
  const addAction = <div className="goals-add"><Button disabled={atCap} aria-describedby={atCap ? 'goal-cap-reason' : undefined} onClick={() => setEditing('new')}><Plus/>목표 추가</Button>
    {atCap && <span id="goal-cap-reason">진행 중이거나 일시정지한 목표는 {MAX_OPEN_GOALS}개까지 둘 수 있습니다.</span>}</div>;
  return <Page className="goals-page">
    <PageHeader title={uiTerms.goals} actions={addAction}/>
    {proposals.length > 0 && <DecisionDeck state={state} navigate={navigate} decisions={proposals}/>}
    {open.map(goal => <GoalSection key={goal.id} goal={goal} state={state} onEdit={() => setEditing(goal)}/>)}
    {!goals.length && <div className="calm"><p>목표 없음</p><Button variant="outline" onClick={() => setEditing('new')}>목표 추가</Button></div>}
    {closed.length > 0 && <details className="goals-closed"><summary>종료된 목표 <span>{closed.length}</span></summary>
      {closed.map(goal => <details className="goals-closed__goal" key={goal.id}>
        <summary><span>{goal.title}</span><time dateTime={new Date(goal.closedAt ?? goal.updatedAt).toISOString()}>{new Date(goal.closedAt ?? goal.updatedAt).toLocaleDateString('ko-KR')}</time></summary>
        <GoalSection goal={goal} state={state}/>
      </details>)}
    </details>}
    {editing && <GoalForm goal={editing === 'new' ? null : editing} atCap={atCap} onClose={() => setEditing(null)}/>}
  </Page>;
}

function GoalSection({ goal, state, onEdit }: { goal: Goal; state: State; onEdit?(): void }) {
  const { client } = useHost();
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closed = goal.state === 'closed';
  const changeState = async () => {
    setBusy(true); setError('');
    try { await client.send({ type: 'goal.update', goalId: goal.id, state: goal.state === 'paused' ? 'active' : 'paused' }); }
    catch (reason) { setError(goalError(reason)); }
    finally { setBusy(false); }
  };
  return <section className="goal-section" aria-label={goal.title}>
    <header className="goal-section__heading"><div><h2>{goal.title}</h2>{goal.state === 'paused' && <span className="goal-paused"><span aria-hidden="true">Ⅱ</span> 일시정지</span>}</div>
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
      <p>「{goal.title}」을 종료합니다. 진행 중이거나 예정인 이정표는 모두 접힙니다.</p>
      <p>종료한 목표는 다시 열 수 없습니다.</p>
    </ConfirmDialog>}
  </section>;
}

function GoalForm({ goal, atCap, onClose }: { goal: Goal | null; atCap: boolean; onClose(): void }) {
  const { client } = useHost();
  const [title, setTitle] = useState(goal?.title ?? '');
  const [why, setWhy] = useState(goal?.why ?? '');
  const [boundaries, setBoundaries] = useState(goal?.boundaries ?? '');
  const [signal, setSignal] = useState(goal?.signal ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (busy) return;
    if (!title.trim()) { setError('방향을 적어 주세요.'); return; }
    setBusy(true); setError('');
    const fields = { title: title.trim(), why: why.trim(), boundaries: boundaries.trim(), signal: signal.trim() };
    try {
      await client.send(goal ? { type: 'goal.update', goalId: goal.id, ...fields } : { type: 'goal.create', ...fields });
      onClose();
    } catch (reason) { setError(goalError(reason)); setBusy(false); }
  };
  return <Modal title={goal ? '목표 수정' : '목표 추가'} onClose={() => { if (!busy) onClose(); }}>
    <form className="goal-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <FormField label="방향" required>{control => <Input {...control} required maxLength={GOAL_TITLE_MAX} value={title} disabled={busy} onChange={event => setTitle(event.target.value)}/>}</FormField>
      <FormField label="이유">{control => <Textarea {...control} rows={3} maxLength={GOAL_TEXT_MAX} value={why} disabled={busy} onChange={event => setWhy(event.target.value)}/>}</FormField>
      <FormField label="지키는 선">{control => <Textarea {...control} rows={2} maxLength={GOAL_TEXT_MAX} value={boundaries} disabled={busy} onChange={event => setBoundaries(event.target.value)}/>}</FormField>
      <FormField label="참고 신호">{control => <Textarea {...control} rows={2} maxLength={GOAL_SIGNAL_MAX} value={signal} disabled={busy} onChange={event => setSignal(event.target.value)}/>}</FormField>
      {error && <InlineError>{error}</InlineError>}
      {!goal && atCap && <p className="goal-form__cap">진행 중이거나 일시정지한 목표는 {MAX_OPEN_GOALS}개까지 둘 수 있습니다.</p>}
      <Button type="submit" className="justify-self-end" disabled={busy || (!goal && atCap)}>{busy ? '저장 중…' : goal ? '저장' : '목표 추가'}</Button>
    </form>
  </Modal>;
}
