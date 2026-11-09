import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, ArrowUpRight, ChevronLeft, ChevronRight, FileText, Monitor, KeyRound } from 'lucide-react';
import { Button, Checkbox, FormField, InlineError, Input } from '../ui'
import type { Decision, SecureFormRequest, State, VaultItemKind, WorkResult } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { ArtifactPreview } from '../components/ArtifactPreview';
import { MessageBody } from '../components/MessageBody';
import { useHost } from '../host/context';
import { browserHandoffProposal, decisionChip, decisionHeading, emptySecureForm, handoffDoneAnswer,
  secureFormBody, secureFormProposal, type SecureFormValues } from './decisionText';
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
    // A secure-form question answers through the vault route only; typed text never carries its values.
    if (secureFormProposal(decision)) return { error: '이 결정은 금고 화면에서만 답합니다.' };
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
  const secureForm = secureFormProposal(decision);
  const handoff = browserHandoffProposal(decision);
  const labels = actionLabels[decision.kind];
  const kindLabel = decisionChip(decision);
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
    if (isQuestion && !secureForm && !handoff && /^[1-9]$/.test(event.key)) {
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
      <span className="decision__kind">{kindLabel}</span>
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

    {secureForm && <SecureForm decision={decision} request={secureForm} cardBusy={busy} autoFocus={autoFocus}
      onResolved={onResolved} onDecline={() => resolve('deny')}/>}

    {!secureForm && handoff && <div className="decision__handoff">
      <p className="decision__handoff-note"><Monitor size={14} aria-hidden="true"/>Mac에서 Chrome 창을 열어 두었습니다. 창에서 직접 마무리해 주세요.</p>
      {handoff.url && <p className="decision__handoff-url">{handoff.url}</p>}
      {handoff.reason.trim() && handoff.reason.trim() !== decision.detail.trim() && <p className="decision__request-reason">{handoff.reason}</p>}
    </div>}

    {isQuestion && !secureForm && !handoff && decision.options.length > 0 && <div className="decision__options" role="group" aria-label="추천 답변">
      {decision.options.map((option, index) => <button key={option} type="button" className="decision__option" disabled={busy} onClick={() => resolve('answer', option)}>
        <kbd aria-hidden="true">{index + 1}</kbd><span>{option}</span>
      </button>)}
    </div>}

    {error && <InlineError>{error}</InlineError>}

    {secureForm ? null : isQuestion
      ? <>
        {handoff && <div className="decision__actions">
          <Button variant="outline" className="h-[34px] rounded-pill px-4" disabled={busy} onClick={() => resolve('deny')}>{labels.deny}</Button>
          <Button className="h-[34px] rounded-pill px-4" disabled={busy} onClick={() => resolve('answer', handoffDoneAnswer)}>{handoffDoneAnswer}</Button>
        </div>}
        <form className="decision__answer" onSubmit={event => { event.preventDefault(); resolve('answer', answer); }}>
          <textarea aria-label="답변" value={answer} onChange={event => setAnswer(event.target.value)} rows={1} maxLength={8192} disabled={busy}
            placeholder={decision.options.length ? '직접 답하기' : '답변을 적어 주세요'}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); resolve('answer', answer); } }}/>
          <Button type="submit" size="icon" aria-label="답변 보내기" title="답변 보내기" disabled={busy || !answer.trim()}
            className="rounded-pill disabled:opacity-100 disabled:bg-hover-2 disabled:text-ink-3"><ArrowUp/></Button>
        </form>
      </>
      : <footer className="decision__actions">
        <span className="decision__hint" aria-hidden="true"><kbd>⌘</kbd><kbd>↵</kbd></span>
        <Button variant="outline" className="h-[34px] rounded-pill px-4" disabled={busy} onClick={() => resolve('deny')}>{labels.deny}</Button>
        <Button className="h-[34px] rounded-pill px-4" disabled={busy} onClick={() => resolve('approve')}>{labels.approve}</Button>
      </footer>}
  </article>;
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
      .then(onResolved)
      .catch(reason => { setError(reason instanceof Error ? reason.message : '금고에 전달하지 못했습니다. 다시 시도해 주세요.'); setBusy(false); });
  };
  // The host repeats the proposal reason in the decision detail; show it once.
  const reason = request.reason.trim() && request.reason.trim() !== decision.detail.trim() && <p className="decision__request-reason">{request.reason}</p>;
  return <form ref={formRef} className="decision__secure" onSubmit={event => { event.preventDefault(); submit(); }}>
    {request.origin && <p className="decision__secure-origin"><KeyRound size={13} aria-hidden="true"/>{request.origin}</p>}
    {reason}
    {!request.origin && request.kind === 'login' && <div className="decision__secure-fields">
      <FormField label="주소" description="이 로그인을 저장할 https:// 주소입니다." required>
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
      <Button variant="outline" type="button" className="h-[34px] rounded-pill px-4" disabled={disabled} onClick={onDecline}>거부</Button>
      <Button type="submit" className="h-[34px] rounded-pill px-4" disabled={disabled}>금고에 전달</Button>
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
      <pre className="decision__request">{cwd && <span>{cwd} </span>}<span aria-hidden="true">$ </span>{command}</pre>
      {risk && <p className="decision__request-risk" data-risk={risk}>{risk}</p>}
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
  const focusPosition = pending.findIndex(decision => decision.id === focusId);
  useEffect(() => { if (focusPosition >= 0) setIndex(focusPosition); }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pending.length) return null;
  const at = Math.min(index, pending.length - 1);
  const current = pending[at];
  const ghostName = state.ghosts.find(ghost => ghost.id === current.ghostId)?.name ?? 'Ghost';
  const workTitle = current.workId ? state.works.find(work => work.id === current.workId)?.title : undefined;
  const behind = Math.min(pending.length - 1, 2);
  const names = new Map(state.ghosts.map(ghost => [ghost.id, ghost.name]));
  return <section className="deck" aria-label="확인 필요" data-depth={behind} data-overview={overview || undefined} data-docked={docked || undefined}>
    {/* Docked, a single card speaks for itself; the head appears only to browse several. */}
    {(!docked || pending.length > 1) && <header className="deck__head">
      <h2 className="section-title">확인 필요<span className="count">{pending.length}</span></h2>
      {pending.length > 1 && <div className="deck__nav">
        <span className="tabular" aria-live="polite">{at + 1} / {pending.length}</span>
        <button type="button" aria-label="이전 항목" disabled={at === 0} onClick={() => setIndex(at - 1)}><ChevronLeft size={15}/></button>
        <button type="button" aria-label="다음 항목" disabled={at === pending.length - 1} onClick={() => setIndex(at + 1)}><ChevronRight size={15}/></button>
      </div>}
    </header>}
    <div className="deck__body">
      {overview && pending.length > 1 && <ol className="deck__index" aria-label="확인 필요 목록">{pending.map((decision, position) => <li key={decision.id}>
        <button type="button" aria-current={position === at || undefined} onClick={() => setIndex(position)}>
          <DotAvatar profileId={decision.ghostId} tone={toneFor(decision.ghostId)} size={18}/>
          <span className="deck__index-copy"><span>{decisionHeading(decision, state)}</span>
            <small>{names.get(decision.ghostId) ?? 'Ghost'} · {decisionChip(decision)}</small></span>
        </button>
      </li>)}</ol>}
      <div className="deck__stack">
        {Array.from({ length: behind }, (_, layer) => <div key={layer} className="deck__ghost-card" data-layer={layer + 1} aria-hidden="true"/>)}
        <div className="deck__top" key={current.id}>
          <DecisionCard decision={current} ghostName={ghostName} workTitle={workTitle} autoFocus={focusNext || current.id === focusId}
            onOpenWork={onOpenWork ?? (id => navigate(`/work/${encodeURIComponent(id)}`))} onResolved={() => setFocusNext(true)}/>
        </div>
      </div>
    </div>
  </section>;
}
