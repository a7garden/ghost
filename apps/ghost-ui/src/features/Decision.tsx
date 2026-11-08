import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, ArrowUpRight, ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { Button, InlineError } from '../ui'
import type { Decision, State, WorkResult } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { ArtifactPreview } from '../components/ArtifactPreview';
import { MessageBody } from '../components/MessageBody';
import { useHost } from '../host/context';
import { decisionHeading, decisionLabel } from './decisionText';
import { toneFor } from './ghostState';
import { relativeTime, useNow } from './time';
import { uiTerms } from '../uiText';

type DocumentProposal = { spaceId?: string; space_id?: string; title?: string; body?: string; pageId?: string | null; page_id?: string | null };

/** The proposal payload of a document decision, in either spelling the ledger has used. */
export function documentProposal(decision: Decision): DocumentProposal | null {
  if (decision.kind !== 'document_review' || !decision.proposal) return null;
  const proposal = decision.proposal;
  return typeof proposal === 'object' ? proposal as DocumentProposal : null;
}

/** The result a Ghost submitted for acceptance, when the host attached it. */
function acceptanceProposal(decision: Decision): { result: WorkResult | null; criteria: string } {
  const proposal = decision.kind === 'accept_result' ? decision.proposal as { result?: WorkResult; criteria?: string } | null : null;
  return { result: proposal?.result ?? null, criteria: proposal?.criteria ?? '' };
}

/**
 * The exact command a resolution sends. Pure, so tests pin what each kind puts
 * on the wire; the card only renders and calls this. A question needs an
 * answer; every kind can also be approved or denied.
 */
export function decisionCommand(decision: Decision, outcome: 'approve' | 'deny' | 'answer', answer?: string):
  { type: 'decision.resolve'; decisionId: string; outcome: 'approve' | 'deny' | 'answer'; answer?: string } | { error: string } {
  if (decision.state !== 'pending') return { error: '이미 처리된 결정입니다.' };
  if (outcome === 'answer') {
    const text = (answer ?? '').trim();
    if (!text) return { error: '답변을 적어 주세요.' };
    return { type: 'decision.resolve', decisionId: decision.id, outcome: 'answer', answer: text };
  }
  return { type: 'decision.resolve', decisionId: decision.id, outcome };
}

const actionLabels: Record<Decision['kind'], { approve: string; deny: string }> = {
  approve_effect: { approve: '승인', deny: '거부' },
  question: { approve: '승인', deny: '거부' },
  accept_result: { approve: '결과 확인', deny: '수정 요청' },
  document_review: { approve: '저장 승인', deny: '거부' },
  reconcile_effect: { approve: '의도대로 처리됨', deny: '처리되지 않음' },
};

/**
 * One decision, shaped by what the Ghost needs: numbered answer tiles for a question,
 * the exact request for an approval, a receipt for a result, the page for a document.
 */
export function DecisionCard({ decision, ghostName, workTitle, onResolved, onOpenWork, autoFocus = false }: {
  decision: Decision;
  ghostName: string;
  workTitle?: string;
  onResolved(): void;
  onOpenWork?(workId: string): void;
  autoFocus?: boolean;
}) {
  const { client } = useHost();
  const now = useNow();
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => { if (autoFocus) cardRef.current?.focus({ preventScroll: true }); }, [autoFocus, decision.id]);
  const resolve = (outcome: 'approve' | 'deny' | 'answer', text?: string) => {
    setBusy(true); setError('');
    const command = decisionCommand(decision, outcome, text);
    if ('error' in command) { setError(command.error); setBusy(false); return; }
    void client.send(command)
      .then(onResolved)
      .catch(e => { setError(e instanceof Error ? e.message : '결정을 전달하지 못했습니다. 다시 시도해 주세요.'); setBusy(false); });
  };
  const proposal = documentProposal(decision);
  const acceptance = acceptanceProposal(decision);
  const isQuestion = decision.kind === 'question';
  const labels = actionLabels[decision.kind];
  const heading = decision.kind === 'accept_result' && workTitle ? workTitle : decision.title;
  // The result summary is shown as the receipt; the detail repeats it after the reviewer's note.
  const detail = (decision.kind === 'accept_result' && acceptance.result
    ? decision.detail.replace(acceptance.result.summary, '') : decision.detail).trim();
  // A host command proposal carries reason, command, folder and risk in its preview; the text detail repeats them for text-only clients.
  const commandPreview = typeof decision.proposal?.command === 'string';
  const showDetail = detail && detail !== heading.trim() && !commandPreview;

  // Digits pick a suggested answer; ⌘/Ctrl+Enter approves. Typing in a field is never intercepted.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (busy || (event.target as Element).closest('textarea, input')) return;
    if (isQuestion && /^[1-9]$/.test(event.key)) {
      const option = decision.options[Number(event.key) - 1];
      if (option) { event.preventDefault(); resolve('answer', option); }
    } else if (!isQuestion && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault(); resolve('approve');
    }
  };

  return <article ref={cardRef} tabIndex={-1} onKeyDown={onKeyDown} data-decision-kind={decision.kind} aria-label={heading} className="decision">
    <header className="decision__meta">
      <DotAvatar profileId={decision.ghostId} tone={toneFor(decision.ghostId)} size={20}/>
      <span className="decision__who">{ghostName}</span>
      <span className="decision__kind">{decisionLabel[decision.kind]}</span>
      <time className="decision__time tabular">{relativeTime(decision.createdAt, now)}</time>
      {decision.workId && onOpenWork && <button type="button" className="decision__work" onClick={() => onOpenWork(decision.workId!)}>
        <span className="truncate">{workTitle && workTitle !== heading ? workTitle : uiTerms.work}</span><ArrowUpRight size={13} aria-hidden="true"/>
      </button>}
    </header>
    <h3 className="decision__title">{heading}</h3>
    {showDetail && <p className="decision__detail">{detail}</p>}

    {decision.kind === 'accept_result' && acceptance.result && <div className="receipt">
      <div className="receipt__body"><MessageBody text={acceptance.result.summary}/></div>
      {acceptance.result.artifacts.length > 0 && <div className="receipt__files">{acceptance.result.artifacts.map(artifact => <ArtifactPreview key={artifact.digest} artifact={artifact}/>)}</div>}
      {acceptance.criteria.trim() && <div className="receipt__criteria"><span>완료 기준</span><p>{acceptance.criteria}</p></div>}
    </div>}

    {decision.kind === 'document_review' && proposal && <div className="decision__document">
      <p className="decision__document-head"><FileText size={14} aria-hidden="true"/>제안된 문서{proposal.pageId || proposal.page_id ? ' · 기존 페이지 수정' : ' · 새 페이지'}</p>
      {proposal.title && <h4>{proposal.title}</h4>}
      <div className="decision__document-body">{proposal.body ?? '(본문 없음)'}</div>
    </div>}

    {(decision.kind === 'approve_effect' || decision.kind === 'reconcile_effect') && decision.proposal && <RequestPreview value={decision.proposal}/>}

    {isQuestion && decision.options.length > 0 && <div className="decision__options" role="group" aria-label="추천 답변">
      {decision.options.map((option, index) => <button key={option} type="button" className="decision__option" disabled={busy} onClick={() => resolve('answer', option)}>
        <kbd aria-hidden="true">{index + 1}</kbd><span>{option}</span>
      </button>)}
    </div>}

    {error && <InlineError>{error}</InlineError>}

    {isQuestion
      ? <form className="decision__answer" onSubmit={event => { event.preventDefault(); resolve('answer', answer); }}>
        <textarea aria-label="답변" value={answer} onChange={event => setAnswer(event.target.value)} rows={1} maxLength={8192} disabled={busy}
          placeholder={decision.options.length ? '직접 답하기' : '답변을 적어 주세요'}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); resolve('answer', answer); } }}/>
        <Button type="submit" size="icon" aria-label="답변 보내기" title="답변 보내기" disabled={busy || !answer.trim()}
          className="rounded-pill disabled:opacity-100 disabled:bg-hover-2 disabled:text-ink-3"><ArrowUp/></Button>
      </form>
      : <footer className="decision__actions">
        <span className="decision__hint" aria-hidden="true"><kbd>⌘</kbd><kbd>↵</kbd></span>
        <Button variant="outline" className="h-[34px] rounded-pill px-4" disabled={busy} onClick={() => resolve('deny')}>{labels.deny}</Button>
        <Button className="h-[34px] rounded-pill px-4" disabled={busy} onClick={() => resolve('approve')}>{labels.approve}</Button>
      </footer>}
  </article>;
}

/** The exact action a Ghost wants to run: short payloads inline, long ones one click away. */
function RequestPreview({ value }: { value: Record<string, unknown> }) {
  const command = typeof value.command === 'string' ? value.command : null;
  const json = JSON.stringify(value, null, 2);
  if (command) {
    // A host command proposal: why, where, what, and how risky. The command stays monospace.
    const cwd = typeof value.cwd === 'string' && value.cwd ? value.cwd : null;
    const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
    const risk = typeof value.risk === 'string' && value.risk ? value.risk : null;
    return <div className="decision__request-block">
      {reason && <p className="decision__request-reason">{reason}</p>}
      <pre className="decision__request">{cwd && <span>{cwd} </span>}<span aria-hidden="true">$ </span>{command}</pre>
      {risk && <p className="decision__request-risk" data-risk={risk}>{risk}</p>}
    </div>;
  }
  if (json.length > 480) return <details className="decision__request-more"><summary>요청 내용 보기</summary><pre className="decision__request">{json}</pre></details>;
  return <pre className="decision__request">{json}</pre>;
}

/**
 * Pending decisions as a stack: the oldest on top and fully actionable, the rest
 * peeking behind it. Resolving one lifts the next; arrows browse without resolving.
 * The overview variant lists every pending item beside the stack.
 */
export function DecisionDeck({ state, navigate, focusId, overview = false }: { state: State; navigate(path: string): void; focusId?: string | null; overview?: boolean }) {
  const pending = state.decisions.filter(decision => decision.state === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  const [index, setIndex] = useState(() => Math.max(0, pending.findIndex(decision => decision.id === focusId)));
  const [focusNext, setFocusNext] = useState(false);
  const focusPosition = pending.findIndex(decision => decision.id === focusId);
  useEffect(() => { if (focusPosition >= 0) setIndex(focusPosition); }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pending.length) return null;
  const at = Math.min(index, pending.length - 1);
  const current = pending[at];
  const ghostName = state.ghosts.find(ghost => ghost.id === current.ghostId)?.name ?? 'Ghost';
  const workTitle = current.workId ? state.works.find(work => work.id === current.workId)?.title : undefined;
  const behind = Math.min(pending.length - 1, 2);
  const names = new Map(state.ghosts.map(ghost => [ghost.id, ghost.name]));
  return <section className="deck" aria-label="확인 필요" data-depth={behind} data-overview={overview || undefined}>
    <header className="deck__head">
      <h2 className="section-title">확인 필요<span className="count">{pending.length}</span></h2>
      {pending.length > 1 && <div className="deck__nav">
        <span className="tabular" aria-live="polite">{at + 1} / {pending.length}</span>
        <button type="button" aria-label="이전 항목" disabled={at === 0} onClick={() => setIndex(at - 1)}><ChevronLeft size={15}/></button>
        <button type="button" aria-label="다음 항목" disabled={at === pending.length - 1} onClick={() => setIndex(at + 1)}><ChevronRight size={15}/></button>
      </div>}
    </header>
    <div className="deck__body">
      {overview && pending.length > 1 && <ol className="deck__index" aria-label="확인 필요 목록">{pending.map((decision, position) => <li key={decision.id}>
        <button type="button" aria-current={position === at || undefined} onClick={() => setIndex(position)}>
          <DotAvatar profileId={decision.ghostId} tone={toneFor(decision.ghostId)} size={18}/>
          <span className="deck__index-copy"><span>{decisionHeading(decision, state)}</span>
            <small>{names.get(decision.ghostId) ?? 'Ghost'} · {decisionLabel[decision.kind]}</small></span>
        </button>
      </li>)}</ol>}
      <div className="deck__stack">
        {Array.from({ length: behind }, (_, layer) => <div key={layer} className="deck__ghost-card" data-layer={layer + 1} aria-hidden="true"/>)}
        <div className="deck__top" key={current.id}>
          <DecisionCard decision={current} ghostName={ghostName} workTitle={workTitle} autoFocus={focusNext || current.id === focusId}
            onOpenWork={id => navigate(`/work/${encodeURIComponent(id)}`)} onResolved={() => setFocusNext(true)}/>
        </div>
      </div>
    </div>
  </section>;
}
