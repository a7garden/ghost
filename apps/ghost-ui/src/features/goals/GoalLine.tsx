import { useId, useState } from 'react';
import { GOAL_TEXT_MAX, type Milestone, type State } from '@ghost/contract';
import { Button, FormField, InlineError, Textarea } from '../../ui';
import { StateGlyph } from '../../components/agent';
import { useCompact } from '../../ui/adaptive';
import { useHost } from '../../host/context';
import { goalLine, milestoneLabels, type GoalLineNode } from './lineLayout';
import { goalError } from './goalError';

function MilestoneMark({ node }: { node: GoalLineNode }) {
  const state = node.milestone.state;
  return <svg className="goal-node__mark" data-state={state} data-working={node.working || undefined} data-later={node.phase === 'later' || undefined} width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
    {state === 'active' && <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="1" opacity=".35"/>}
    <circle cx="16" cy="16" r="9" fill={state === 'done' || state === 'active' ? 'currentColor' : 'var(--ghost-canvas)'} stroke="currentColor" strokeWidth="1.6" strokeDasharray={node.phase === 'later' ? '3 3' : undefined}/>
    {state === 'done' && <path d="m12 16 3 3 5-6" fill="none" stroke="var(--ghost-canvas)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>}
    {state === 'dropped' && <path d="m13 13 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>}
  </svg>;
}

/** One horizontal chronology, turned upright on compact screens. No milestone is a quota. */
export function GoalLine({ milestones, state, readOnly = false }: { milestones: Milestone[]; state: State; readOnly?: boolean }) {
  const compact = useCompact();
  const detailId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const columns = goalLine(milestones, state.works);
  const milestone = milestones.find(item => item.id === selected);
  if (!columns.length) return <p className="goal-line__empty">이정표 없음</p>;
  return <div className="goal-line" data-compact={compact || undefined}>
    <div className="goal-line__scroll" tabIndex={0} role="region" aria-label="이정표 시간순">
      <div className="goal-line__track">
        {columns.map(column => <div key={column.nodes[0].milestone.id} className="goal-line__column" data-phase={column.phase} data-fork={column.fork || undefined}>
          {column.fork && <svg className="goal-line__fork" viewBox={compact ? '0 0 100 160' : '0 0 170 250'} preserveAspectRatio="none" aria-hidden="true">
            {compact ? <>
              <path d="M0 0 V160" vectorEffect="non-scaling-stroke"/>
              <path d="M0 0 C0 24 50 16 50 44 V112 C50 144 0 136 0 160" vectorEffect="non-scaling-stroke"/>
            </> : <>
              <path d="M0 120 C35 120 35 60 85 60 S135 120 170 120"/>
              <path d="M0 120 C35 120 35 180 85 180 S135 120 170 120"/>
            </>}
          </svg>}
          {column.nodes.map(node => <button type="button" key={node.milestone.id} className="goal-node"
            data-state={node.milestone.state} data-phase={node.phase} aria-label={`이정표 ${node.milestone.title}, ${milestoneLabels[node.milestone.state]}${node.phase === 'next' ? ' · 다음' : node.phase === 'later' ? ' · 나중' : ''}`}
            aria-expanded={selected === node.milestone.id} aria-controls={detailId}
            onClick={() => setSelected(selected === node.milestone.id ? null : node.milestone.id)}>
            <MilestoneMark key={`mark:${JSON.stringify(node.milestone)}:${node.working}`} node={node}/><span className="goal-node__copy" key={`copy:${JSON.stringify(node.milestone)}:${node.working}`}><span className="goal-node__title">{node.milestone.title}</span>
              <span className="goal-node__state">{milestoneLabels[node.milestone.state]}{node.phase === 'next' ? ' · 다음' : node.phase === 'later' ? ' · 나중' : ''}</span></span>
          </button>)}
        </div>)}
      </div>
    </div>
    <div id={detailId}>{milestone && <MilestoneDetail key={milestone.id} milestone={milestone} state={state} readOnly={readOnly}/>}</div>
  </div>;
}

function MilestoneDetail({ milestone, state, readOnly }: { milestone: Milestone; state: State; readOnly: boolean }) {
  const { client } = useHost();
  const [settling, setSettling] = useState<'done' | 'dropped' | null>(null);
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const editable = !readOnly && (milestone.state === 'active' || milestone.state === 'planned');
  const submit = async () => {
    if (!settling || busy) return;
    if (settling === 'dropped' && !outcome.trim()) { setError('접은 이유를 적어 주세요.'); return; }
    setBusy(true); setError('');
    try {
      await client.send({ type: 'milestone.update', milestoneId: milestone.id, state: settling, outcome: outcome.trim() });
      setSettling(null); setOutcome('');
    } catch (reason) { setError(goalError(reason)); }
    finally { setBusy(false); }
  };
  return <section className="milestone-detail" aria-label={`이정표 상세 ${milestone.title}`}>
    <header><h3>{milestone.title}</h3><span>{milestoneLabels[milestone.state]}</span></header>
    <dl className="goal-facts">
      {milestone.hypothesis && <div><dt>왜</dt><dd>{milestone.hypothesis}</dd></div>}
      {milestone.exit && <div><dt>종료 증거</dt><dd>{milestone.exit}</dd></div>}
      {milestone.outcome && <div><dt>{milestone.state === 'dropped' ? '접은 이유' : '근거'}</dt><dd>{milestone.outcome}</dd></div>}
      <div><dt>계획한 Ghost</dt><dd>{state.ghosts.find(ghost => ghost.id === milestone.createdBy)?.name ?? 'Ghost'}</dd></div>
      {milestone.startedAt !== null && <div><dt>시작</dt><dd><time dateTime={new Date(milestone.startedAt).toISOString()}>{new Date(milestone.startedAt).toLocaleString('ko-KR')}</time></dd></div>}
      {milestone.endedAt !== null && <div><dt>종료</dt><dd><time dateTime={new Date(milestone.endedAt).toISOString()}>{new Date(milestone.endedAt).toLocaleString('ko-KR')}</time></dd></div>}
    </dl>
    {milestone.workIds.length > 0 && <ul className="milestone-works" aria-label="연결된 맡긴 일">{milestone.workIds.map(id => {
      const work = state.works.find(item => item.id === id);
      return <li key={id}><a href={`#/work/${encodeURIComponent(id)}`}>{work ? <StateGlyph state={work.state}/> : <span className="milestone-works__missing" aria-hidden="true">—</span>}<span>{work?.title ?? '연결된 맡긴 일'}</span></a></li>;
    })}</ul>}
    {editable && !settling && <div className="goal-actions">
      <Button variant="ghost" size="sm" onClick={() => setSettling('done')}>완료로 표시</Button>
      <Button variant="ghost" size="sm" onClick={() => setSettling('dropped')}>접기</Button>
    </div>}
    {editable && settling && <form className="milestone-settle" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <FormField label={settling === 'done' ? '완료 근거' : '접은 이유'} required={settling === 'dropped'}>
        {control => <Textarea {...control} autoFocus rows={3} maxLength={GOAL_TEXT_MAX} value={outcome} disabled={busy} required={settling === 'dropped'} onChange={event => setOutcome(event.target.value)}/>}
      </FormField>
      {error && <InlineError>{error}</InlineError>}
      <div className="goal-actions"><Button variant="ghost" size="sm" disabled={busy} onClick={() => { setSettling(null); setError(''); }}>취소</Button>
        <Button type="submit" size="sm" disabled={busy}>{settling === 'done' ? '완료로 표시' : '접기'}</Button></div>
    </form>}
  </section>;
}
