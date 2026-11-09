import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, ArrowUpRight, ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { Button, InlineError } from '../ui'
import type { ArtifactRef, Decision, State, WorkResult } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { ArtifactPreview } from '../components/ArtifactPreview';
import { MessageBody } from '../components/MessageBody';
import { useHost } from '../host/context';
import { decisionHeading, decisionLabel } from './decisionText';
import { toneFor } from './ghostState';
import { relativeTime, useNow } from './time';
import { uiTerms } from '../uiText';
import { isMac, modKey } from '../ui/keys';

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
 * What a question settles to when the owner does not reply in time (host `ask_owner` default),
 * as one line for the card; null when it waits for the owner.
 */
export function questionFallbackText(decision: Decision, now: number): string | null {
  if (decision.kind !== 'question' || decision.state !== 'pending' || !decision.proposal) return null;
  const { default: answer, expiresAt } = decision.proposal;
  if (typeof answer !== 'string' || typeof expiresAt !== 'number') return null;
  const minutes = Math.ceil((expiresAt - now) / 60_000);
  const when = minutes <= 0 ? '곧' : minutes < 60 ? `${minutes}분 뒤` : `${Math.round(minutes / 60)}시간 뒤`;
  return `답이 없으면 ${when} 기본값으로 진행합니다: ${answer}`;
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
  // A deny may carry the owner's reason; the host hands it to the Ghost (revise reason, reconcile note, review note).
  const reason = outcome === 'deny' ? (answer ?? '').trim() : '';
  if (reason) return { type: 'decision.resolve', decisionId: decision.id, outcome, answer: reason };
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
 * Kinds whose deny the host passes on with the owner's words (decisions.ts followUp); their deny
 * opens a reason step first. Effect approvals and questions ignore a reason, so they deny at once.
 */
export const denyReasonPrompt: Partial<Record<Decision['kind'], { label: string; placeholder: string }>> = {
  accept_result: { label: '무엇을 고칠지', placeholder: '무엇을 고칠지 적어 주세요. 비워 두면 고칠 점 없이 다시 하라고만 전합니다.' },
  document_review: { label: '거부 이유', placeholder: '거부하는 이유 (선택)' },
  reconcile_effect: { label: '확인한 내용', placeholder: '확인한 내용 (선택)' },
};

// The host has no risk level, only the Ghost's own risk text (plus a host-added "삭제:" for rm).
// Words of loss in it mark the command high-risk; a false match only costs one more press.
const destructiveRisk = /삭제|영구|되돌릴 수 없|복구할 수 없|덮어|초기화|유실|손실|delete|overwrite|irreversib|wipe|destroy/i;

/** A host command whose stated risk speaks of loss: it approves only on a second press. */
export function highRiskApproval(decision: Decision): boolean {
  return decision.kind === 'approve_effect' && Boolean(decision.proposal) && commandRiskIsHigh(decision.proposal!);
}

// A browser click that pays or changes an account cannot be called back once the site has it.
const irreversibleCommits = new Set(['payment', 'account']);

function commandRiskIsHigh(proposal: Record<string, unknown>): boolean {
  if (proposal.kind === 'browser') return typeof proposal.commit === 'string' && irreversibleCommits.has(proposal.commit);
  return typeof proposal.command === 'string' && typeof proposal.risk === 'string' && destructiveRisk.test(proposal.risk);
}

/** The acknowledgement after a resolution, said in what the owner did. */
export function resolvedText(kind: Decision['kind'], outcome: 'approve' | 'deny' | 'answer'): string {
  if (outcome === 'answer') return '답했습니다';
  if (kind === 'accept_result') return outcome === 'approve' ? '결과를 확인했습니다' : '수정을 요청했습니다';
  if (kind === 'reconcile_effect') return outcome === 'approve' ? '처리됨으로 기록했습니다' : '처리되지 않음으로 기록했습니다';
  if (kind === 'document_review' && outcome === 'approve') return '저장을 승인했습니다';
  return outcome === 'approve' ? '승인했습니다' : '거부했습니다';
}

/**
 * One decision, shaped by what the Ghost needs: numbered answer tiles for a question,
 * the exact request for an approval, a receipt for a result, the page for a document.
 */
export function DecisionCard({ decision, ghostName, workTitle, onResolved, onOpenWork, autoFocus = false }: {
  decision: Decision;
  ghostName: string;
  workTitle?: string;
  onResolved(outcome: 'approve' | 'deny' | 'answer'): void;
  onOpenWork?(workId: string): void;
  autoFocus?: boolean;
}) {
  const { client } = useHost();
  const now = useNow();
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revising, setRevising] = useState(false);
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const mountedAt = useRef(Date.now());
  useEffect(() => { if (autoFocus) cardRef.current?.focus({ preventScroll: true }); }, [autoFocus, decision.id]);
  useEffect(() => { if (revising) reasonRef.current?.focus(); }, [revising]);
  // An armed approval lapses on its own: a later stray press must not run a high-risk command.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  const resolve = (outcome: 'approve' | 'deny' | 'answer', text?: string) => {
    setBusy(true); setError('');
    const command = decisionCommand(decision, outcome, text);
    if ('error' in command) { setError(command.error); setBusy(false); return; }
    void client.send(command)
      .then(() => onResolved(outcome))
      .catch(e => { setError(e instanceof Error ? e.message : '결정을 전달하지 못했습니다. 다시 시도해 주세요.'); setBusy(false); });
  };
  const reasonPrompt = denyReasonPrompt[decision.kind];
  const highRisk = highRiskApproval(decision);
  // High risk: the first press arms, a second within 4s approves. Everything else approves at once.
  const approve = () => {
    if (highRisk && !armed) { setArmed(true); return; }
    setArmed(false); resolve('approve');
  };
  const deny = () => reasonPrompt ? setRevising(true) : resolve('deny');
  const backOut = () => { setRevising(false); cardRef.current?.focus({ preventScroll: true }); };
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
  const fallback = questionFallbackText(decision, now);

  // Digits pick a suggested answer; ⌘/Ctrl+Enter approves; D opens the reason step. Typing in a field is never
  // intercepted, and a held key (repeat) never resolves.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The reason step owns its keys: ⌘/Ctrl+Enter there must deny with the note, never approve.
    if (revising) return;
    if (busy || event.repeat || (event.target as Element).closest('textarea, input, select, [contenteditable]')) return;
    // A card that just replaced a resolved one ignores resolving keys briefly, so a double press never resolves two cards.
    const fresh = Date.now() - mountedAt.current < 400;
    if (isQuestion && /^[1-9]$/.test(event.key)) {
      if (fresh) { event.preventDefault(); return; }
      const option = decision.options[Number(event.key) - 1];
      if (option) { event.preventDefault(); resolve('answer', option); }
    } else if (!isQuestion && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault(); if (!fresh) approve();
    } else if (reasonPrompt && event.code === 'KeyD' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // By key position, so a Korean layout (ㅇ) works too.
      event.preventDefault(); setRevising(true);
    }
  };
  const approveKeys = isMac ? 'Meta+Enter' : 'Control+Enter';

  return <article ref={cardRef} tabIndex={-1} onKeyDown={onKeyDown} data-decision-kind={decision.kind} aria-label={heading} className="decision"
    onBlur={event => { if (armed && !event.currentTarget.contains(event.relatedTarget as Node | null)) setArmed(false); }}>
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
    {fallback && <p className="decision__detail">{fallback}</p>}

    {error && <InlineError>{error}</InlineError>}

    {isQuestion
      ? <form className="decision__answer" onSubmit={event => { event.preventDefault(); resolve('answer', answer); }}>
        <textarea aria-label="답변" value={answer} onChange={event => setAnswer(event.target.value)} rows={1} maxLength={8192} disabled={busy}
          placeholder={decision.options.length ? '직접 답하기' : '답변을 적어 주세요'}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); resolve('answer', answer); } }}/>
        <Button type="submit" size="icon" aria-label="답변 보내기" title="답변 보내기" disabled={busy || !answer.trim()}
          className="rounded-pill disabled:opacity-100 disabled:bg-hover-2 disabled:text-ink-3"><ArrowUp/></Button>
      </form>
      : revising && reasonPrompt
        ? <form className="decision__revise" onSubmit={event => { event.preventDefault(); resolve('deny', reason); }}>
          <textarea ref={reasonRef} aria-label={reasonPrompt.label} value={reason} onChange={event => setReason(event.target.value)} rows={2} maxLength={8192} disabled={busy}
            placeholder={reasonPrompt.placeholder}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); backOut(); }
              else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); resolve('deny', reason); }
            }}/>
          <div className="decision__actions">
            <span className="decision__hint" aria-hidden="true"><span><kbd>{modKey}</kbd><kbd>↵</kbd>보내기</span><span><kbd>Esc</kbd>돌아가기</span></span>
            <Button type="button" variant="ghost" className="h-[34px] rounded-pill px-4" disabled={busy} onClick={backOut}>돌아가기</Button>
            <Button type="submit" className="h-[34px] rounded-pill px-4" disabled={busy} aria-keyshortcuts={approveKeys}>{labels.deny}</Button>
          </div>
        </form>
        : <footer className="decision__actions">
          <span className="decision__hint" aria-hidden="true">
            {reasonPrompt && <span><kbd>D</kbd>{labels.deny}</span>}
            <span><kbd>{modKey}</kbd><kbd>↵</kbd>{armed ? '한 번 더' : labels.approve}</span>
          </span>
          <Button variant="outline" className="h-[34px] rounded-pill px-4" disabled={busy} aria-keyshortcuts={reasonPrompt ? 'D' : undefined} onClick={deny}>{labels.deny}</Button>
          <Button variant={armed ? 'destructive' : 'default'} className="h-[34px] rounded-pill px-4" disabled={busy} data-armed={armed || undefined}
            aria-keyshortcuts={approveKeys} onClick={approve}>{armed ? '한 번 더 눌러 실행 승인' : labels.approve}</Button>
          <span className="sr-only" role="status">{armed ? '되돌릴 수 없는 요청입니다. 4초 안에 한 번 더 누르면 실행을 승인합니다.' : ''}</span>
        </footer>}
  </article>;
}

/** The exact action a Ghost wants to run: short payloads inline, long ones one click away. */
function RequestPreview({ value }: { value: Record<string, unknown> }) {
  const command = typeof value.command === 'string' ? value.command : null;
  const json = JSON.stringify(value, null, 2);
  if (value.kind === 'browser') {
    // A browser action: which page, which element, and the page as the Ghost saw it when it asked.
    const screenshot = value.screenshot as ArtifactRef | null | undefined;
    const url = typeof value.url === 'string' ? value.url : '';
    const typed = typeof value.value === 'string' ? value.value : null;
    return <div className="decision__request-block">
      {typeof value.commit === 'string' && <p className="decision__request-risk" data-risk={value.commit}>{value.commit}</p>}
      <pre className="decision__request">{url}{'\n'}{String(value.target ?? '')}{typed !== null ? ` = ${JSON.stringify(typed)}` : ''}</pre>
      {screenshot && <ArtifactPreview artifact={screenshot} label="승인을 요청한 화면"/>}
      <p className="decision__request-reason">승인하면 같은 화면에서 같은 요소일 때만 실행합니다.</p>
    </div>;
  }
  if (command) {
    // A host command proposal: why, where, what, and how risky. The command stays monospace.
    const cwd = typeof value.cwd === 'string' && value.cwd ? value.cwd : null;
    const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
    const risk = typeof value.risk === 'string' && value.risk ? value.risk : null;
    return <div className="decision__request-block">
      {reason && <p className="decision__request-reason">{reason}</p>}
      <pre className="decision__request">{cwd && <span>{cwd} </span>}<span aria-hidden="true">$ </span>{command}</pre>
      {risk && <p className="decision__request-risk" data-risk={commandRiskIsHigh(value) ? 'high' : 'normal'}>{risk}</p>}
    </div>;
  }
  if (json.length > 480) return <details className="decision__request-more"><summary>요청 내용 보기</summary><pre className="decision__request">{json}</pre></details>;
  return <pre className="decision__request">{json}</pre>;
}

/**
 * What a Ghost's conversation needs from the owner: every pending decision of that Ghost
 * (what its sidebar row announces) plus those of threads begun in this conversation, at any
 * depth, whoever carries them. Oldest first.
 */
export function chatDecisions(state: State, ghostId: string, conversationId: string | null): Decision[] {
  const roots = new Set(conversationId ? state.works.filter(work => work.originConversationId === conversationId && !work.parentId).map(work => work.id) : []);
  const threads = new Set(state.works.filter(work => roots.has(work.rootId) || roots.has(work.id)).map(work => work.id));
  return state.decisions
    .filter(decision => decision.state === 'pending' && (decision.ghostId === ghostId || (decision.workId !== null && threads.has(decision.workId))))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Pending decisions as a stack: the oldest on top and fully actionable, the rest
 * peeking behind it. Resolving one lifts the next; arrows browse without resolving.
 * The overview variant lists every pending item beside the stack; the docked variant sits
 * above a conversation's composer with only that conversation's decisions.
 */
export function DecisionDeck({ state, navigate, focusId, overview = false, docked = false, decisions, onOpenWork }: {
  state: State;
  navigate(path: string): void;
  focusId?: string | null;
  overview?: boolean;
  docked?: boolean;
  /** The pending decisions to stack, oldest first; every pending decision when omitted. */
  decisions?: Decision[];
  onOpenWork?(workId: string): void;
}) {
  const pending = decisions ?? state.decisions.filter(decision => decision.state === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  const [index, setIndex] = useState(() => Math.max(0, pending.findIndex(decision => decision.id === focusId)));
  const [focusNext, setFocusNext] = useState(false);
  const [settled, setSettled] = useState<{ id: string; kind: Decision['kind']; outcome: 'approve' | 'deny' | 'answer' } | null>(null);
  const focusPosition = pending.findIndex(decision => decision.id === focusId);
  useEffect(() => { if (focusPosition >= 0) setIndex(focusPosition); }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => setSettled(null), 2400);
    return () => clearTimeout(timer);
  }, [settled]);
  // The deck stays mounted while its acknowledgement shows, so the last resolution is still announced.
  if (!pending.length && !settled) return null;
  const rest = settled ? pending.filter(decision => decision.id !== settled.id).length : 0;
  const ack = settled ? `${resolvedText(settled.kind, settled.outcome)} · ${rest ? `다음 확인 ${rest}건` : '남은 확인 없음'}` : '';
  const at = Math.min(index, Math.max(0, pending.length - 1));
  const current = pending[at] as Decision | undefined;
  const ghostName = state.ghosts.find(ghost => ghost.id === current?.ghostId)?.name ?? 'Ghost';
  const workTitle = current?.workId ? state.works.find(work => work.id === current.workId)?.title : undefined;
  const behind = Math.max(0, Math.min(pending.length - 1, 2));
  const names = new Map(state.ghosts.map(ghost => [ghost.id, ghost.name]));
  // ←/→ (or [ ]) page like the arrows when no text field has focus; the new card takes focus so paging continues.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    // Only the card itself or the deck's own controls page; a focused preview, media or scroll box keeps its arrows.
    const target = event.target as Element;
    if (!(target.matches('.decision') || target.closest('.deck__head, .deck__index'))) return;
    const step = event.key === 'ArrowLeft' || event.key === '[' ? -1 : event.key === 'ArrowRight' || event.key === ']' ? 1 : 0;
    const next = at + step;
    if (!step || next < 0 || next >= pending.length) return;
    event.preventDefault(); setIndex(next); setFocusNext(true);
  };
  return <section className="deck" aria-label="확인 필요" data-depth={behind} data-overview={overview || undefined} data-docked={docked || undefined} onKeyDown={onKeyDown}>
    {/* Docked, a single card speaks for itself; the head appears only to browse several. */}
    {current && (!docked || pending.length > 1) && <header className="deck__head">
      <h2 className="section-title">확인 필요<span className="count">{pending.length}</span></h2>
      {pending.length > 1 && <div className="deck__nav">
        <span className="tabular" aria-live="polite">{at + 1} / {pending.length}</span>
        <button type="button" aria-label="이전 항목" title="이전 항목 (←)" aria-keyshortcuts="ArrowLeft" disabled={at === 0} onClick={() => setIndex(at - 1)}><ChevronLeft size={15}/></button>
        <button type="button" aria-label="다음 항목" title="다음 항목 (→)" aria-keyshortcuts="ArrowRight" disabled={at === pending.length - 1} onClick={() => setIndex(at + 1)}><ChevronRight size={15}/></button>
      </div>}
    </header>}
    {current && <div className="deck__body">
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
            onOpenWork={onOpenWork ?? (id => navigate(`/work/${encodeURIComponent(id)}`))}
            onResolved={outcome => { setSettled({ id: current.id, kind: current.kind, outcome }); setFocusNext(true); }}/>
        </div>
      </div>
    </div>}
    {/* Always in the same place, so a screen reader hears each change; empty, it takes no room. */}
    <p className="deck__ack" role="status" aria-live="polite">{ack}</p>
  </section>;
}
