import { useState } from 'react';
import { GOAL_TITLE_MAX, type State } from '@ghost/contract';
import { Button, InlineError } from '../../ui';
import { useHost } from '../../host/context';
import { goalError } from './goalError';
import { goalLimit, goalsAtCap } from './goalScope';

/** One line for the direction; reason, boundaries and signal are added later on the goal itself. */
export function GoalComposer({ state, initialScopeId, fixedScope, onClose }: {
  state: State; initialScopeId: string | null; fixedScope: boolean; onClose(): void;
}) {
  const { client } = useHost();
  const [scopeId, setScopeId] = useState(initialScopeId);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const atCap = goalsAtCap(state, scopeId);
  const submit = async () => {
    const text = title.trim();
    if (busy || atCap || !text) return;
    setBusy(true); setError('');
    try { await client.send({ type: 'goal.create', ...(scopeId ? { scopeId } : {}), title: text }); onClose(); }
    catch (reason) { setError(goalError(reason)); setBusy(false); }
  };
  return <form className="goal-composer" onSubmit={event => { event.preventDefault(); void submit(); }} onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
    <div className="goal-composer__line">
      <input aria-label="방향" autoFocus maxLength={GOAL_TITLE_MAX} placeholder="어디로 가고 싶나요" value={title} readOnly={busy} onChange={event => setTitle(event.target.value)}/>
      {!fixedScope && state.scopes.length > 0 && <select aria-label="프로젝트" value={scopeId ?? ''} disabled={busy} onChange={event => setScopeId(event.target.value || null)}>
        <option value="">전체</option>
        {state.scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.name}</option>)}
      </select>}
      <Button type="submit" size="sm" disabled={busy || atCap || !title.trim()}>추가</Button>
    </div>
    {error && <InlineError>{error}</InlineError>}
    {atCap && <p className="goal-composer__cap">진행 중이거나 일시정지한 목표는 {goalLimit(state, scopeId)}개까지 둘 수 있습니다.</p>}
  </form>;
}
