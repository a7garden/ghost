import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { GOAL_TITLE_MAX, type State } from '@ghost/contract';
import { Button, InlineError } from '../../ui';
import { useHost } from '../../host/context';
import { goalProposal } from '../decisionText';
import { goalError } from './goalError';
import { goalLimit, goalsAtCap, scopeName } from './goalScope';
import { goalClauses, type GoalClauseField } from './GoalStatement';

type Draft = Record<'title' | GoalClauseField, string>;
const emptyDraft: Draft = { title: '', why: '', boundaries: '', signal: '' };

/** What the main Ghost receives when the owner would rather say a goal than write its statement. */
export function goalRequest(text: string, scope: { id: string; name: string } | null): string {
  const where = scope ? `프로젝트 「${scope.name}」(scope_id ${scope.id})의 목표야.` : '팀 전체 목표야.';
  return [
    `아래 내 말을 팀 목표로 goal_propose로 제안해 줘. ${where}`,
    '- 방향: 내 말을 짧게 줄인 한 문장.',
    '- 이유: 내가 한 말, 또는 그 말에서 바로 읽히는 뜻만. 기억, 지난 일, 예시를 끌어오지 마.',
    '- 지키는 선, 참고 신호: 내가 직접 말했을 때만 적고, 말하지 않았으면 비워 둬. 말을 덧붙이거나 일반론을 만들지 마.',
    '- 되묻지 말고 바로 제안해 줘.',
    '',
    `내 말: ${text}`,
  ].join('\n');
}

/**
 * A new goal begins as its own statement with blanks, completed in reading order; or, said freely,
 * goes to the main Ghost, whose proposal returns in the same statement shape.
 */
export function GoalComposer({ state, initialScopeId, fixedScope, onClose }: {
  state: State; initialScopeId: string | null; fixedScope: boolean; onClose(): void;
}) {
  const { client } = useHost();
  const main = state.ghosts.find(ghost => ghost.isDefault && ghost.state === 'active');
  const [telling, setTelling] = useState(false);
  const [scopeId, setScopeId] = useState(initialScopeId);
  const [draft, setDraft] = useState(emptyDraft);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Proposals already waiting when the request went out, and whether the main has started answering it.
  const [sent, setSent] = useState<{ before: string[]; answering: boolean } | null>(null);
  const request = useRef<{ text: string; id: string } | null>(null);
  const fields = useRef<(HTMLTextAreaElement | null)[]>([]);
  const atCap = goalsAtCap(state, scopeId);
  const proposals = state.decisions.filter(decision => decision.state === 'pending' && goalProposal(decision)).map(decision => decision.id);
  const arrived = sent !== null && proposals.some(id => !sent.before.includes(id));
  const answering = state.conversations.find(conversation => conversation.id === main?.directConversationId)?.busy ?? false;

  useEffect(() => { if (sent && answering && !sent.answering) setSent({ ...sent, answering: true }); }, [sent, answering]);
  useEffect(() => { if (arrived) onClose(); }, [arrived, onClose]);

  const create = async () => {
    const title = draft.title.trim();
    if (busy || atCap || !title) return;
    setBusy(true); setError('');
    try {
      await client.send({ type: 'goal.create', ...(scopeId ? { scopeId } : {}), title, why: draft.why.trim(), boundaries: draft.boundaries.trim(), signal: draft.signal.trim() });
      onClose();
    } catch (reason) { setError(goalError(reason)); setBusy(false); }
  };
  const tell = async () => {
    const words = said.trim();
    if (busy || atCap || !words || !main) return;
    const scope = scopeId ? { id: scopeId, name: scopeName(state, scopeId) } : null;
    const text = goalRequest(words, scope);
    // A failed admission keeps this request identity, so a retry never wakes the main twice.
    if (request.current?.text !== text) request.current = { text, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      await client.send({ type: 'message.send', conversationId: main.directConversationId, text, scopeId }, request.current.id);
      setSent({ before: proposals, answering: false });
    } catch (reason) { setError(goalError(reason)); }
    finally { setBusy(false); }
  };
  // Enter moves to the next blank and completes the statement on the last; Shift+Enter breaks a line.
  const advance = (at: number) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const next = fields.current[at + 1];
    if (next && !event.metaKey && !event.ctrlKey) next.focus(); else void create();
  };
  const edit = (field: keyof Draft) => (event: { target: { value: string } }) => setDraft(current => ({ ...current, [field]: event.target.value }));

  if (sent && main) return <section className="goal-composer" aria-label="목표 제안 요청" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    {!sent.answering || answering
      ? <p className="goal-composer__pending" role="status">{main.name} 정리 중</p>
      : <p className="goal-composer__pending" role="status">{main.name}의 답은 대화에 있습니다. <a href={`#/ghosts/${main.id}`}>대화 열기</a></p>}
    <div className="goal-composer__foot"><Button type="button" variant="ghost" size="sm" onClick={onClose}>닫기</Button></div>
  </section>;

  return <form className="goal-composer" onSubmit={event => { event.preventDefault(); void (telling ? tell() : create()); }}
    onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
    {telling
      ? <textarea className="goal-composer__said" aria-label={`${main?.name ?? '메인'}에게 할 말`} placeholder="생각나는 대로" autoFocus rows={3} value={said} readOnly={busy}
        onChange={event => setSaid(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void tell(); } }}/>
      : <>
        <textarea ref={node => { fields.current[0] = node; }} className="goal-composer__direction" aria-label="방향" placeholder="어디로 갈까요" autoFocus rows={1}
          maxLength={GOAL_TITLE_MAX} value={draft.title} readOnly={busy} onChange={edit('title')} onKeyDown={advance(0)}/>
        <div className="goal-statement__clauses">
          {goalClauses.map((clause, index) => <label key={clause.field} className="goal-composer__clause">
            <span className="goal-statement__lead">{clause.lead}</span>
            <textarea ref={node => { fields.current[index + 1] = node; }} aria-label={clause.label} rows={1} maxLength={clause.max}
              value={draft[clause.field]} readOnly={busy} onChange={edit(clause.field)} onKeyDown={advance(index + 1)}/>
          </label>)}
        </div>
      </>}
    <div className="goal-composer__foot">
      {main && <Button type="button" variant="ghost" size="sm" className="goal-composer__switch" disabled={busy} onClick={() => { setTelling(!telling); setError(''); }}>
        {telling ? '직접 쓰기' : `${main.name}에게 말하기`}</Button>}
      {!fixedScope && state.scopes.length > 0 && <select aria-label="프로젝트" value={scopeId ?? ''} disabled={busy} onChange={event => setScopeId(event.target.value || null)}>
        <option value="">전체</option>
        {state.scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.name}</option>)}
      </select>}
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>취소</Button>
      <Button type="submit" size="sm" disabled={busy || atCap || !(telling ? said : draft.title).trim()}>{telling ? '보내기' : '추가'}</Button>
    </div>
    {error && <InlineError>{error}</InlineError>}
    {atCap && <p className="goal-composer__cap">진행 중이거나 일시정지한 목표는 {goalLimit(state, scopeId)}개까지 둘 수 있습니다.</p>}
  </form>;
}
