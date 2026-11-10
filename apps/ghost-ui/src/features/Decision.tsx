import { haptic } from '../host/shell';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, ArrowUp, ArrowUpRight, ChevronLeft, ChevronRight, FileText, Monitor, KeyRound } from 'lucide-react';
import { Button, Checkbox, FormField, InlineError, Input } from '../ui'
import { DESTRUCTIVE_RISK, reviewOf, type ActivityConfig, type Decision, type SecureFormRequest, type State, type VaultItemKind, type WorkResult } from '@ghost/contract';
import { executionLabel, policySummary, sourceSummary } from './activity-config';
import { toolLabels } from './GhostSettings';
import { DotAvatar } from '../components/DotAvatar';
import { ArtifactPreview } from '../components/ArtifactPreview';
import { DocumentProposalPreview } from '../components/DocumentProposalPreview';
import { BrowserLiveView } from './BrowserLiveView';
import { MessageBody } from '../components/MessageBody';
import { useHost } from '../host/context';
import { browserHandoffProposal, decisionChip, decisionHeading, emptySecureForm, handoffDoneAnswer,
  secureFormBody, secureFormProposal, type SecureFormValues } from './decisionText';
import { toneFor } from './ghostState';
import { relativeTime, useNow } from './time';
import { uiTerms } from '../uiText';
import { isMac, modKey } from '../ui/keys';

type DocumentProposal = { spaceId?: string; space_id?: string; title?: string; body?: string; profile?: string; pageId?: string | null; page_id?: string | null };

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
 * What a pending decision settles to when the owner does not reply in time (the Host's review,
 * 2026-11-10), as one line for the card; null when it waits for the owner however long it takes.
 */
export function autoSettleText(decision: Decision, now: number): string | null {
  const review = reviewOf(decision.proposal);
  if (decision.state !== 'pending' || !review || review.expiresAt === null) return null;
  const minutes = Math.ceil((review.expiresAt - now) / 60_000);
  const when = minutes <= 0 ? '곧' : minutes < 60 ? `${minutes}분 뒤` : `${Math.round(minutes / 60)}시간 뒤`;
  return review.recommend === 'answer' ? `답이 없으면 ${when} 「${review.answer}」(으)로 답합니다.` : `답이 없으면 ${when} 추천대로 승인합니다.`;
}

/** The recommended answer of a question, shown first and marked on its tile. */
export function recommendedOption(decision: Decision): string | null {
  const review = reviewOf(decision.proposal);
  return review?.recommend === 'answer' && review.answer && decision.options.includes(review.answer) ? review.answer : null;
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
    // A secure-form question answers through the vault route only; typed text never carries its values.
    if (secureFormProposal(decision)) return { error: '이 결정은 금고 화면에서만 답합니다.' };
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
  approve_effect: { approve: '실행 승인', deny: '실행 안 함' },
  question: { approve: '승인', deny: '거부' },
  accept_result: { approve: '결과 확인', deny: '수정 요청' },
  document_review: { approve: '저장 승인', deny: '거부' },
  reconcile_effect: { approve: '네, 됐어요', deny: '아니요, 안 됐어요' },
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
// Words of loss in it (DESTRUCTIVE_RISK, shared with the Host) mark the command high-risk; a false match only costs one more press.

/** A host command whose stated risk speaks of loss: it approves only on a second press. */
export function highRiskApproval(decision: Decision): boolean {
  return decision.kind === 'approve_effect' && Boolean(decision.proposal) && commandRiskIsHigh(decision.proposal!);
}

function commandRiskIsHigh(proposal: Record<string, unknown>): boolean {
  // Current Host browser approvals are used for commit clicks and protected card fields.
  if (typeof proposal.url === 'string' && (proposal.element || typeof proposal.itemTitle === 'string')) return true;
  return typeof proposal.command === 'string' && typeof proposal.risk === 'string' && DESTRUCTIVE_RISK.test(proposal.risk);
}

/**
 * The context under the heading: the result summary moves to the receipt, and a detail that opens by
 * repeating the heading (questions asked before 2026-11-10 carried the whole question) loses that line.
 */
export function cardDetail(decision: Decision, heading: string, resultSummary: string | null): string {
  let detail = (resultSummary ? decision.detail.replace(resultSummary, '') : decision.detail).trim();
  const head = heading.trim();
  if (head && detail.startsWith(head)) detail = detail.slice(head.length).trim();
  return detail;
}

/** Proposals whose preview already shows every fact of the text detail. */
export function previewCoversDetail(decision: Decision): boolean {
  const proposal = decision.proposal;
  if (decision.kind !== 'approve_effect' || !proposal) return false;
  return typeof proposal.command === 'string' || typeof proposal.merchant === 'string' || typeof proposal.itemTitle === 'string';
}

/** The acknowledgement after a resolution, said in what the owner did. */
export function resolvedText(kind: Decision['kind'], outcome: 'approve' | 'deny' | 'answer'): string {
  if (outcome === 'answer') return '답했습니다';
  if (kind === 'accept_result') return outcome === 'approve' ? '결과를 확인했습니다' : '수정을 요청했습니다';
  if (kind === 'reconcile_effect') return outcome === 'approve' ? '됐다고 Ghost에게 알렸습니다' : '안 됐다고 Ghost에게 알렸습니다';
  if (kind === 'document_review' && outcome === 'approve') return '저장을 승인했습니다';
  return outcome === 'approve' ? '승인했습니다' : '거부했습니다';
}

/**
 * One decision: the question or consequence first, evidence underneath, and a
 * separate response area that stays reachable while long evidence scrolls.
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
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const armed = armedAt !== null;
  const cardRef = useRef<HTMLElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const mountedAt = useRef(Date.now());
  useEffect(() => { if (autoFocus) cardRef.current?.focus({ preventScroll: true }); }, [autoFocus, decision.id]);
  useEffect(() => { if (revising) reasonRef.current?.focus(); }, [revising]);
  // An armed approval lapses on its own: a later stray press must not run a high-risk command.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmedAt(null), 4000);
    return () => clearTimeout(timer);
  }, [armedAt]);
  const resolve = (outcome: 'approve' | 'deny' | 'answer', text?: string) => {
    setBusy(true); setError('');
    const command = decisionCommand(decision, outcome, text);
    if ('error' in command) { setError(command.error); setBusy(false); return; }
    void client.send(command)
      .then(() => { haptic(); onResolved(outcome); })
      .catch(e => { setError(e instanceof Error ? e.message : '결정을 전달하지 못했습니다. 다시 시도해 주세요.'); setBusy(false); });
  };
  const reasonPrompt = denyReasonPrompt[decision.kind];
  const highRisk = highRiskApproval(decision);
  // High risk: the first press arms, a second within 4s approves. Everything else approves at once.
  const approve = () => {
    if (highRisk) {
      const now = Date.now();
      if (armedAt === null || now - armedAt >= 4000) { setArmedAt(now); return; }
      // A single double-click must not be treated as deliberate confirmation.
      if (now - armedAt < 400) return;
    }
    setArmedAt(null); resolve('approve');
  };
  const deny = () => reasonPrompt ? setRevising(true) : resolve('deny');
  const backOut = () => { setRevising(false); cardRef.current?.focus({ preventScroll: true }); };
  const proposal = documentProposal(decision);
  const acceptance = acceptanceProposal(decision);
  const isQuestion = decision.kind === 'question';
  const secureForm = secureFormProposal(decision);
  const handoff = browserHandoffProposal(decision);
  const labels = actionLabels[decision.kind];
  const kindLabel = decisionChip(decision);
  const heading = decision.kind === 'accept_result' && workTitle ? workTitle : decision.title;
  const detail = cardDetail(decision, heading, acceptance.result?.summary ?? null);
  // A structured preview (command, checkout click, card fill) says what the text detail says for text-only clients.
  const showDetail = detail && !previewCoversDetail(decision);
  const fallback = autoSettleText(decision, now);
  const review = reviewOf(decision.proposal);
  const recommended = recommendedOption(decision);
  // The recommended answer leads; the digit keys follow what is shown.
  const options = recommended ? [recommended, ...decision.options.filter(option => option !== recommended)] : decision.options;

  // Digits pick a suggested answer; ⌘/Ctrl+Enter approves; D opens the reason step. Typing in a field is never
  // intercepted, and a held key (repeat) never resolves.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The reason step owns its keys: ⌘/Ctrl+Enter there must deny with the note, never approve.
    if (revising) return;
    if (busy || event.repeat || event.nativeEvent.isComposing || (event.target as Element).closest('textarea, input, select, [contenteditable]')) return;
    // A card that just replaced a resolved one ignores resolving keys briefly, so a double press never resolves two cards.
    const fresh = Date.now() - mountedAt.current < 400;
    if (isQuestion && !secureForm && !handoff && /^[1-9]$/.test(event.key)) {
      if (fresh) { event.preventDefault(); return; }
      const option = options[Number(event.key) - 1];
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
    onBlur={event => { if (armed && !event.currentTarget.contains(event.relatedTarget as Node | null)) setArmedAt(null); }}>
    <header className="decision__heading">
    <div className="decision__meta">
      <DotAvatar profileId={decision.ghostId} tone={toneFor(decision.ghostId)} size={20}/>
      <span className="decision__who">{ghostName}</span>
      <span className="decision__kind">{kindLabel}</span>
      <time className="decision__time tabular">{relativeTime(decision.createdAt, now)}</time>
      {decision.workId && onOpenWork && <button type="button" className="decision__work" onClick={() => onOpenWork(decision.workId!)}>
        <span className="truncate">{workTitle && workTitle !== heading ? workTitle : uiTerms.work}</span><ArrowUpRight size={13} aria-hidden="true"/>
      </button>}
    </div>
    <h3 className="decision__title">{heading}</h3>
    </header>
    <div className="decision__body">
    {showDetail && <div className="decision__detail decision__detail--md"><MessageBody text={detail}/></div>}

    {decision.kind === 'accept_result' && acceptance.result && <div className="receipt">
      <div className="receipt__body"><MessageBody text={acceptance.result.summary}/></div>
      {acceptance.result.artifacts.length > 0 && <div className="receipt__files">{acceptance.result.artifacts.map(artifact => <ArtifactPreview key={artifact.digest} artifact={artifact}/>)}</div>}
      {acceptance.criteria.trim() && <div className="receipt__criteria"><span>완료 기준</span><p>{acceptance.criteria}</p></div>}
    </div>}

    {decision.kind === 'document_review' && proposal && <div className="decision__document">
      <p className="decision__document-head"><FileText size={14} aria-hidden="true"/>제안된 문서{proposal.pageId || proposal.page_id ? ' · 기존 페이지 수정' : ' · 새 페이지'}</p>
      <DocumentProposalPreview key={decision.id} title={proposal.title} body={proposal.body} profile={proposal.profile}/>
    </div>}

    {(decision.kind === 'approve_effect' || decision.kind === 'reconcile_effect') && decision.proposal && <RequestPreview value={decision.proposal}/>}

    {secureForm && <SecureForm decision={decision} request={secureForm} cardBusy={busy} autoFocus={autoFocus}
      onResolved={() => onResolved('answer')} onDecline={() => resolve('deny')}/>}

    {!secureForm && handoff && <div className="decision__handoff">
      <p className="decision__handoff-note"><Monitor size={14} aria-hidden="true"/>{handoff.live
        ? 'Ghost의 브라우저입니다. 아래 화면을 탭하고 글자를 보내 직접 마무리한 뒤 「다 했어요」를 눌러 주세요.'
        : 'Mac에서 Chrome 창을 열어 두었습니다. 창에서 직접 마무리해 주세요.'}</p>
      {handoff.url && <p className="decision__handoff-url">{handoff.url}</p>}
      {handoff.reason.trim() && handoff.reason.trim() !== decision.detail.trim() && <p className="decision__request-reason">{handoff.reason}</p>}
      {decision.state === 'pending' && <BrowserLiveView decisionId={decision.id} disabled={busy}/>}
    </div>}

    {review?.mainNote && <div className="decision__review"><p><strong>메인 의견</strong> {review.mainNote}</p></div>}
    </div>

    <div className="decision__response">
    {(review?.recommend === 'approve' || fallback) && <div className="decision__review">
      {review?.recommend === 'approve' && <p><strong>추천</strong> 승인 · 되돌릴 수 있는 요청입니다.</p>}
      {fallback && <p className="decision__review-auto">{fallback}</p>}
    </div>}

    {error && <InlineError>{error}</InlineError>}

    {secureForm ? null : isQuestion
      ? <>
        {options.length > 0 && !handoff && <div className="decision__options" role="group" aria-label="답 고르기">
          {options.map((option, index) => <button key={option} type="button" className="decision__option" disabled={busy}
            data-recommended={option === recommended || undefined} onClick={() => resolve('answer', option)}>
            <kbd aria-hidden="true">{index + 1}</kbd>
            <span className="decision__option-label">{option}</span>
            {option === recommended && <span className="decision__recommend">추천</span>}
            <ArrowRight size={16} className="decision__option-arrow" aria-hidden="true"/>
          </button>)}
        </div>}
        {handoff && <div className="decision__actions">
          <Button variant="ghost" disabled={busy} onClick={() => resolve('deny')}>{labels.deny}</Button>
          <Button disabled={busy} onClick={() => resolve('answer', handoffDoneAnswer)}>{handoffDoneAnswer}</Button>
        </div>}
        {options.length > 0 || handoff
          ? <details className="decision__custom"><summary>직접 답하기</summary>
            <AnswerField answer={answer} onChange={setAnswer} busy={busy} onSend={() => resolve('answer', answer)}/>
          </details>
          : <AnswerField answer={answer} onChange={setAnswer} busy={busy} onSend={() => resolve('answer', answer)}/>}
      </>
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
            <Button type="button" variant="ghost" disabled={busy} onClick={backOut}>돌아가기</Button>
            <Button type="submit" disabled={busy} aria-keyshortcuts={approveKeys}>{labels.deny}</Button>
          </div>
        </form>
        : <footer className="decision__actions">
          <Button variant="ghost" disabled={busy} aria-keyshortcuts={reasonPrompt ? 'D' : undefined}
            title={reasonPrompt ? `${labels.deny} (D)` : undefined} onClick={event => { if (event.detail < 2) deny(); }}>{labels.deny}</Button>
          <Button variant={armed ? 'destructive' : 'default'} disabled={busy} data-armed={armed || undefined}
            aria-keyshortcuts={approveKeys} title={`${labels.approve} (${modKey}↵)`}
            onClick={event => { if (event.detail < 2) approve(); }}>{busy ? '전달 중…' : armed ? '한 번 더 눌러 실행 승인' : labels.approve}</Button>
          <span className="sr-only" role="status">{armed ? '위험을 확인해 주세요. 4초 안에 한 번 더 누르면 실행을 승인합니다.' : ''}</span>
        </footer>}
    </div>
  </article>;
}

function AnswerField({ answer, onChange, busy, onSend }: {
  answer: string; onChange(value: string): void; busy: boolean; onSend(): void;
}) {
  return <form className="decision__answer" onSubmit={event => { event.preventDefault(); onSend(); }}>
    <textarea aria-label="답변" value={answer} onChange={event => onChange(event.target.value)} rows={1} maxLength={8192} disabled={busy}
      placeholder="답변을 적어 주세요"
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSend(); } }}/>
    <Button type="submit" size="icon" aria-label="답변 보내기" title="답변 보내기" disabled={busy || !answer.trim()}>
      <ArrowUp/>
    </Button>
  </form>;
}

/** The fields one secure-form kind collects. */
const secureInputs: Record<VaultItemKind, readonly { key: keyof SecureFormValues; label: string; required?: boolean;
  password?: boolean; placeholder?: string; description?: string; autoComplete?: string }[]> = {
  login: [
    { key: 'username', label: '사용자 이름', required: true, autoComplete: 'off' },
    { key: 'password', label: '비밀번호', required: true, password: true, autoComplete: 'off' },
    { key: 'totp', label: '일회용 코드 시드', password: true, description: '비워 두어도 됩니다. 저장하면 Ghost가 코드를 직접 만듭니다.', autoComplete: 'off' },
  ],
  card: [
    { key: 'cardNumber', label: '카드 번호', required: true, autoComplete: 'cc-number' },
    { key: 'cardExpiry', label: '유효기간', required: true, placeholder: 'MM/YY', autoComplete: 'cc-exp' },
    { key: 'cardCvc', label: 'CVC', required: true, password: true, autoComplete: 'cc-csc' },
    { key: 'cardName', label: '카드 소유자 이름', required: true, autoComplete: 'cc-name' },
  ],
  contact: [
    { key: 'contactName', label: '이름' },
    { key: 'contactPhone', label: '전화' },
    { key: 'contactEmail', label: '이메일' },
    { key: 'contactAddress', label: '주소' },
  ],
  secret: [{ key: 'value', label: '값', required: true, password: true, autoComplete: 'off' }],
  api: [
    { key: 'username', label: '클라이언트 ID', autoComplete: 'off' },
    { key: 'value', label: '비밀 키', required: true, password: true, autoComplete: 'off' },
  ],
};

/**
 * The vault answer of a secure-form question: kind-shaped fields, the 저장 choice,
 * and a submit that posts to the vault route only — the answer API never sees a value.
 */
function SecureForm({ decision, request, cardBusy, autoFocus, onResolved, onDecline }: {
  decision: Decision;
  request: SecureFormRequest;
  cardBusy: boolean;
  autoFocus: boolean;
  onResolved(): void;
  onDecline(): void;
}) {
  const { client } = useHost();
  const [values, setValues] = useState<SecureFormValues>(emptySecureForm);
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { if (autoFocus) formRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }); }, [autoFocus, decision.id]);
  const disabled = busy || cardBusy;
  const submit = () => {
    if (disabled) return;
    const built = secureFormBody(request, values, save);
    if ('error' in built) { setError(built.error); return; }
    setBusy(true); setError('');
    void client.vaultRequestAnswer(decision.id, built.body)
      .then(() => { haptic(); onResolved(); })
      .catch(reason => { setError(reason instanceof Error ? reason.message : '금고에 전달하지 못했습니다. 다시 시도해 주세요.'); setBusy(false); });
  };
  // The host repeats the proposal reason in the decision detail; show it once.
  const reason = request.reason.trim() && request.reason.trim() !== decision.detail.trim() && <p className="decision__request-reason">{request.reason}</p>;
  return <form ref={formRef} className="decision__secure" onSubmit={event => { event.preventDefault(); submit(); }}>
    {request.origin && <p className="decision__secure-origin"><KeyRound size={13} aria-hidden="true"/>{request.origin}</p>}
    {reason}
    {!request.origin && (request.kind === 'login' || request.kind === 'api') && <div className="decision__secure-fields">
      <FormField label="주소" description={request.kind === 'login' ? '이 로그인을 저장할 https:// 주소입니다.' : undefined} required>
        {control => <Input {...control} type="text" placeholder="https://example.com" value={values.origin} disabled={disabled}
          onChange={event => setValues(current => ({ ...current, origin: event.target.value }))}/>}
      </FormField>
    </div>}
    <div className="decision__secure-fields">
      {secureInputs[request.kind].map(field => <FormField key={field.key} label={field.label} description={field.description} required={field.required}>
        {control => <Input {...control} type={field.password ? 'password' : 'text'} autoComplete={field.autoComplete}
          inputMode={request.kind === 'card' && (field.key === 'cardNumber' || field.key === 'cardExpiry' || field.key === 'cardCvc') ? 'numeric' : undefined}
          placeholder={field.placeholder} value={values[field.key]} disabled={disabled}
          onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}/>}
      </FormField>)}
    </div>
    <label className="decision__secure-save">
      <Checkbox checked={save} disabled={disabled} onCheckedChange={checked => setSave(checked === true)}/>
      <span>금고에 저장</span>
      <small>끄면 24시간 뒤 사라지는 일회용 항목으로 저장합니다.</small>
    </label>
    {error && <InlineError>{error}</InlineError>}
    <div className="decision__actions">
      <Button variant="ghost" type="button" disabled={disabled} onClick={onDecline}>거부</Button>
      <Button type="submit" disabled={disabled}>{busy ? '전달 중…' : '금고에 전달'}</Button>
    </div>
  </form>;
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
      {cwd && <p className="decision__request-location"><span>작업 위치</span> <code>{cwd}</code></p>}
      <pre className="decision__request">{command}</pre>
      {risk && <p className="decision__request-risk" data-risk={commandRiskIsHigh(value) ? 'high' : undefined}>{risk}</p>}
    </div>;
  }
  // A browser click approval: the merchant and total the host read off the page come first, not the raw JSON.
  const merchant = typeof value.merchant === 'string' && value.merchant ? value.merchant : null;
  if (merchant) {
    const page = value.page && typeof value.page === 'object' ? value.page as { checkout?: unknown } : null;
    const total = typeof value.total === 'string' && value.total ? value.total : page?.checkout ? '페이지에서 읽지 못했습니다 · 화면에서 직접 확인하세요' : '없음';
    const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
    const target = typeof value.description === 'string' ? value.description : null;
    return <div className="decision__request-block">
      {reason && <p className="decision__request-reason">{reason}</p>}
      <dl className="decision__facts">
        <div><dt>상점</dt><dd>{merchant}</dd></div>
        <div><dt>금액</dt><dd className="tabular">{total}</dd></div>
        {target && <div><dt>누를 곳</dt><dd>{target}</dd></div>}
      </dl>
      <p className="decision__request-risk">승인 뒤 금액이나 사이트가 바뀌면 누르지 않습니다.</p>
      <RawRequest json={json}/>
    </div>;
  }
  // A protected card field: which site gets which card.
  if (typeof value.itemTitle === 'string') {
    const last4 = typeof value.last4 === 'string' && value.last4 ? ` •••• ${value.last4}` : '';
    const site = typeof value.origin === 'string' ? value.origin : typeof value.url === 'string' ? value.url : '';
    return <div className="decision__request-block">
      <dl className="decision__facts">
        <div><dt>사이트</dt><dd>{site}</dd></div>
        <div><dt>카드</dt><dd>{value.itemTitle}{last4}</dd></div>
      </dl>
      <p className="decision__request-risk">승인하면 이 사이트의 입력란에 카드 정보를 채웁니다.</p>
      <RawRequest json={json}/>
    </div>;
  }
  // A standing activity: what it watches, where it runs, what it may use, how far it may go.
  const config = activityConfigOf(value);
  if (config) return <div className="decision__request-block">
    <dl className="decision__facts">
      <div><dt>지켜볼 것</dt><dd>{sourceSummary(config.source)}</dd></div>
      <div><dt>실행 위치</dt><dd>{executionLabel[config.execution.kind]}</dd></div>
      <div><dt>쓸 도구</dt><dd>{config.tools.length ? config.tools.map(tool => toolLabels[tool] ?? tool).join(', ') : '없음'}</dd></div>
      <div><dt>한도</dt><dd>{policySummary(config.policy)}</dd></div>
    </dl>
    <RawRequest json={json}/>
  </div>;
  // Anything else: the detail above already says it in words; the raw request stays one click away.
  return <RawRequest json={json}/>;
}

/** The exact request as sent, folded: a person reads the facts above, not JSON. */
function RawRequest({ json }: { json: string }) {
  return <details className="decision__request-more"><summary>요청 원문 보기</summary><pre className="decision__request">{json}</pre></details>;
}

function activityConfigOf(value: Record<string, unknown>): ActivityConfig | null {
  const config = value.config as Partial<ActivityConfig> | undefined;
  return config && typeof config === 'object' && config.source && config.execution && Array.isArray(config.tools) && config.policy ? config as ActivityConfig : null;
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
 * Pending decisions as a browsable queue. The active item stays fully actionable;
 * named queue entries show what else is waiting without decorative stacked cards.
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
  return <section className="deck" aria-label="확인 필요" data-overview={overview || undefined} data-docked={docked || undefined} onKeyDown={onKeyDown}>
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
      {pending.length > 1 && <ol className="deck__index" aria-label="확인 필요 목록">{pending.map((decision, position) => <li key={decision.id}>
        <button type="button" aria-current={position === at || undefined} onClick={() => { setIndex(position); setFocusNext(true); }}>
          <span className="deck__position tabular" aria-hidden="true">{position + 1}</span>
          <span className="deck__index-copy"><span>{decisionHeading(decision, state)}</span>
            <small>{names.get(decision.ghostId) ?? 'Ghost'} · {decisionChip(decision)}</small></span>
        </button>
      </li>)}</ol>}
      <div className="deck__top" key={current.id}>
          <DecisionCard decision={current} ghostName={ghostName} workTitle={workTitle} autoFocus={focusNext || current.id === focusId}
            onOpenWork={onOpenWork ?? (id => navigate(`/work/${encodeURIComponent(id)}`))}
            onResolved={outcome => { setSettled({ id: current.id, kind: current.kind, outcome }); setFocusNext(true); }}/>
      </div>
    </div>}
    {/* Always in the same place, so a screen reader hears each change; empty, it takes no room. */}
    <p className="deck__ack" role="status" aria-live="polite">{ack}</p>
  </section>;
}
