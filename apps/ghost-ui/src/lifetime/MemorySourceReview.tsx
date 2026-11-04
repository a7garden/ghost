import { DetailDialog } from '../components/DetailDialog';
import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Clock3, RefreshCw } from 'lucide-react';
import type { Command } from '../client/types';
import {
  correctionEntryAllowed,
  interpretMemoryCorrectionResult,
  memorySourceDisclosureLabels,
  memorySourceKindLabel,
  memorySourceRowKey,
  memorySourceStatusLabels,
  parseMemorySourceList,
  parseMemorySourceReceipt,
  receiptMatchesOrigin,
  type MemorySourceList,
  type MemorySourceReceipt,
  type OwnerMemorySourceView,
} from './memorySource';

type MemorySourceAction = (command: Command) => Promise<Record<string, any>>;

export interface MemorySourceReviewProps {
  /** Current selected registered Ghost (lifetime registry ghost_id == profile id). */
  profileId: string;
  /** Current selected registered conversation of that Ghost. */
  conversationId: string;
  /** Existing workspace Owner action: CSRF, local envelope persistence, error surface. */
  action: MemorySourceAction;
}

// One open Owner correction review. `origin` and `content` keep the exact
// bytes captured from the list row; the Host hash-checks them again before
// any effect. The request UUID itself is owned by the existing command queue
// journal and is never re-created for the same intent. Once a submit has been
// attempted, the review locks to that exact body: an ambiguous transport
// outcome keeps the original envelope resumable through the queue, and an
// effect_unknown outcome is only ever continued by resuming the original
// correction_request_id from the list.
interface CorrectionFlow {
  key: string;
  origin: OwnerMemorySourceView['origin'];
  content: string;
  inspecting: boolean;
  receipt: MemorySourceReceipt | null;
  inspectError: string;
  replacement: string;
  reviewed: boolean;
  submitting: boolean;
  attempted: boolean;
  // Set when a submit ended without a completed correction: 'transport' keeps
  // the original queue envelope (same UUID retry), 'unknown' may only be
  // continued by resuming the Host's original correction_request_id.
  ambiguous: 'transport' | 'unknown' | null;
  error: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function MemorySourceReview({ profileId, conversationId, action }: MemorySourceReviewProps) {
  const [list, setList] = useState<MemorySourceList | null>(null);
  const [listError, setListError] = useState('');
  const [correctionError, setCorrectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [flow, setFlow] = useState<CorrectionFlow | null>(null);
  const [rowReceipts, setRowReceipts] = useState<Record<string, MemorySourceReceipt>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // Sources whose correction submit ended effect_unknown: no new intent until
  // the original correction_request_id shows up as resumable in the list.
  const [unknownIntents, setUnknownIntents] = useState<Record<string, true>>({});
  const pairRef = useRef('');
  // Every response is dropped unless the Owner still looks at the pair it was
  // asked for: a prior selection is never applied to a newly selected pair.
  const apply = (pair: string, update: () => void) => { if (pairRef.current === pair) update(); };

  async function refreshList(pair: string): Promise<void> {
    // A stale finally from a previous selection must not touch the new pair's
    // loading state or send its request.
    if (pairRef.current !== pair) return;
    setLoading(true);
    try {
      const result = await action({ type: 'workspace', action: { type: 'memory_source_list', profile_id: profileId, conversation_id: conversationId } });
      const parsed = parseMemorySourceList(result);
      apply(pair, () => { setList(parsed); setListError(''); });
    } catch (error) {
      apply(pair, () => setListError(errorMessage(error, '기억 출처 목록을 확인하지 못했습니다.')));
    } finally {
      apply(pair, () => setLoading(false));
    }
  }

  useEffect(() => {
    const pair = `${profileId}\u0000${conversationId}`;
    pairRef.current = pair;
    setList(null);
    setListError('');
    setCorrectionError('');
    setNotice('');
    setBusy('');
    setFlow(null);
    setRowReceipts({});
    setRowErrors({});
    setUnknownIntents({});
    if (profileId && conversationId) void refreshList(pair);
  }, [profileId, conversationId]);

  // memory_source_inspect with the row's original origin and content; the
  // receipt it returns is the only accepted basis for a correction intent.
  async function inspectReceipt(row: Pick<OwnerMemorySourceView, 'origin' | 'content'>): Promise<MemorySourceReceipt> {
    if (row.content === null) throw new Error('원문이 보관되어 있지 않아 접수 기록 검토를 진행할 수 없습니다.');
    const result = await action({ type: 'workspace', action: { type: 'memory_source_inspect', profile_id: profileId, conversation_id: conversationId, origin: row.origin, content: row.content } });
    return parseMemorySourceReceipt(result);
  }

  async function inspectRow(row: OwnerMemorySourceView): Promise<void> {
    const pair = pairRef.current, key = memorySourceRowKey(row);
    setBusy(`inspect:${key}`);
    setNotice('');
    setCorrectionError('');
    try {
      const receipt = await inspectReceipt(row);
      apply(pair, () => {
        setRowReceipts(current => ({ ...current, [key]: receipt }));
        setRowErrors(current => ({ ...current, [key]: '' }));
      });
    } catch (error) {
      apply(pair, () => setRowErrors(current => ({ ...current, [key]: errorMessage(error, '원본 접수 기록을 확인하지 못했습니다.') })));
    } finally {
      apply(pair, () => setBusy(''));
      void refreshList(pair);
    }
  }

  function inspectIntoFlow(key: string, origin: OwnerMemorySourceView['origin'], content: string): void {
    const pair = pairRef.current;
    void (async () => {
      try {
        const receipt = await inspectReceipt({ origin, content });
        apply(pair, () => setFlow(current => current?.key === key
          ? { ...current, inspecting: false, receipt, inspectError: '' }
          : current));
      } catch (error) {
        apply(pair, () => setFlow(current => current?.key === key
          ? { ...current, inspecting: false, inspectError: errorMessage(error, '원본 접수 기록을 확인하지 못했습니다.') }
          : current));
      } finally {
        void refreshList(pair);
      }
    })();
  }

  // Opens the review with memory_source_inspect on the exact listed origin and
  // content. Nothing is sent to the model and no ledger effect happens until
  // the Owner confirms a reviewed replacement.
  function startCorrection(row: OwnerMemorySourceView): void {
    if (row.content === null) return;
    const key = memorySourceRowKey(row);
    setFlow({
      key, origin: row.origin, content: row.content,
      inspecting: true, receipt: null, inspectError: '', replacement: row.content,
      reviewed: false, submitting: false, attempted: false, ambiguous: null, error: '',
    });
    setNotice('');
    setCorrectionError('');
    setRowErrors(current => ({ ...current, [key]: '' }));
    inspectIntoFlow(key, row.origin, row.content);
  }

  // The inspected receipt must describe exactly this revision, be a recorded
  // state and carry its episode; otherwise the editor never opens and the
  // Host-side CAS stays the second guard instead of the only one.
  function flowReceiptUsable(active: CorrectionFlow): boolean {
    const receipt = active.receipt;
    return receipt !== null
      && correctionEntryAllowed(receipt.status)
      && receipt.episode_id !== null
      && receiptMatchesOrigin(receipt, active.origin);
  }

  async function confirmCorrection(active: CorrectionFlow): Promise<void> {
    const pair = pairRef.current;
    if (pairRef.current !== pair) return;
    if (!flowReceiptUsable(active)) {
      setFlow({ ...active, error: '검토된 접수 기록이 현재 출처와 일치하지 않거나 기록된 상태가 아니어서 교정을 확정할 수 없습니다. 원본 접수 기록을 다시 검토해 주세요.' });
      return;
    }
    const expectedEpisodeId = active.receipt!.episode_id!;
    // Fail closed when the list is unavailable or the reviewed revision has
    // left the list: a stale, revoked, redacted or already-pending source
    // never receives a new intent from this review. A locked retry of the
    // same envelope is exempt — the Host replays the original request by its
    // unchanged ID, so it can never create a second effect.
    const replay = active.ambiguous === 'transport';
    if (!replay && (listError || !list)) {
      setFlow({ ...active, error: '출처 목록 상태를 확인할 수 없어 교정을 확정할 수 없습니다. 목록을 새로 고친 뒤 같은 검토로 다시 확정해 주세요.' });
      return;
    }
    const live = replay ? undefined : list?.sources.find(row => memorySourceRowKey(row) === active.key);
    if (!replay && (!live || live.correction_request_id !== null || live.content === null || !correctionEntryAllowed(live.receipt.status)
      || !receiptMatchesOrigin(live.receipt, live.origin) || live.receipt.episode_id !== expectedEpisodeId)) {
      setFlow({ ...active, error: '출처 상태가 검토 중에 변경됐습니다. 새 교정을 만들지 않고 목록의 접수 상태를 다시 확인해 주세요.' });
      return;
    }
    setFlow({ ...active, submitting: true, attempted: true, ambiguous: replay ? 'transport' : null, error: '' });
    try {
      const result = await action({
        type: 'workspace',
        action: {
          type: 'memory_source_correct', profile_id: profileId, conversation_id: conversationId,
          prior: active.origin, expected_prior_episode_id: expectedEpisodeId,
          prior_content: active.content, replacement_content: active.replacement,
        },
      });
      const outcome = interpretMemoryCorrectionResult(result);
      if (outcome.kind === 'complete') {
        apply(pair, () => { setFlow(null); setNotice('교정이 기록됐습니다. 대체 본문도 수용된 믿음이 아니라 다시 검토할 출처 자료입니다.'); });
      } else if (outcome.kind === 'unknown') {
        // Ambiguous effect: this exact review locks; only the original
        // journaled correction_request_id from the list may continue it.
        apply(pair, () => {
          setUnknownIntents(current => ({ ...current, [active.origin.source_id]: true }));
          setCorrectionError('교정 접수의 실행 상태를 확인하지 못했습니다. 원래 요청 ID는 보존됐습니다.');
          setFlow(current => current?.key === active.key
            ? { ...current, submitting: false, ambiguous: 'unknown', error: '교정 접수의 실행 상태를 확인하지 못했습니다. 이 검토는 원래 요청 본문에 고정됩니다. 목록에 원래 요청 이어가기가 나타나면 그쪽으로만 계속할 수 있습니다.' }
            : current);
        });
      } else {
        apply(pair, () => setFlow(current => current?.key === active.key
          ? { ...current, submitting: false, attempted: false, ambiguous: null, error: outcome.summary || '교정 결과를 확인하지 못했습니다.' }
          : current));
      }
    } catch (error) {
      // Ambiguous transport outcome: the queue still holds the original
      // envelope, so the locked retry reuses the exact same request UUID and
      // body. Editing to a different body stays impossible until it resolves.
      apply(pair, () => setFlow(current => current?.key === active.key
        ? { ...current, submitting: false, ambiguous: 'transport', error: `${errorMessage(error, '교정 요청 결과를 확인하지 못했습니다.')} 원래 요청 본문과 요청 ID는 그대로 보존됩니다.` }
        : current));
    } finally {
      void refreshList(pair);
    }
  }

  async function resumeCorrection(row: OwnerMemorySourceView): Promise<void> {
    const pair = pairRef.current, key = memorySourceRowKey(row);
    const requestId = row.correction_request_id;
    if (!requestId) return;
    setBusy(`resume:${key}`);
    setNotice('');
    setCorrectionError('');
    try {
      const result = await action({ type: 'workspace', action: { type: 'memory_source_resume', profile_id: profileId, conversation_id: conversationId, correction_request_id: requestId } });
      const outcome = interpretMemoryCorrectionResult(result);
      if (outcome.kind === 'complete') apply(pair, () => setNotice('원래 교정 요청이 이어져 기록됐습니다. 대체 본문도 수용된 믿음이 아닙니다.'));
      else if (outcome.kind === 'unknown') apply(pair, () => setCorrectionError('교정 접수의 실행 상태를 아직 확인하지 못했습니다. 원래 요청 ID는 그대로 보존됩니다.'));
      else apply(pair, () => setCorrectionError(outcome.summary || '교정 접수 결과를 확인하지 못했습니다.'));
    } catch (error) {
      apply(pair, () => setCorrectionError(errorMessage(error, '교정 접수 결과를 확인하지 못했습니다.')));
    } finally {
      apply(pair, () => setBusy(''));
      void refreshList(pair);
    }
  }

  // A locked ambiguous review may only be dismissed once the original
  // request is resolvable from the list: either the source carries a
  // resumable correction_request_id, or the reviewed revision has been
  // superseded and this review can no longer be the current intent.
  const resumable = flow !== null && (
    (list?.sources.some(row => row.origin.source_id === flow.origin.source_id && row.correction_request_id !== null) ?? false)
    || (list !== null && !listError && !list.sources.some(row => memorySourceRowKey(row) === flow.key))
  );

  return <section className="lifetime-outbox memory-sources" aria-label="기억 출처 검토">
    <div className="lifetime-section-heading">
      <div>
        <h3>기억 출처 검토</h3>
        <p>선택한 Ghost·등록 대화 쌍에 기록된 기억 출처의 원문과 접수 상태를 소유자가 직접 확인합니다. 출처 본문은 보존된 자료이며 이 Ghost가 수용한 믿음이나 검증된 사실이 아닙니다.</p>
      </div>
      <button type="button" className="button secondary" disabled={loading || !profileId || !conversationId} onClick={() => void refreshList(pairRef.current)}>
        <RefreshCw size={14}/>{loading ? '확인 중' : '출처 목록 새로 고침'}
      </button>
    </div>
    {!profileId || !conversationId ? <p className="lifetime-empty"><Clock3 size={16}/>등록된 Ghost·대화 쌍을 먼저 선택해 주세요.</p> : <>
      {listError && <p className="lifetime-alert" role="alert"><CircleAlert size={16}/><span>{listError}</span></p>}
      {correctionError && <p className="lifetime-alert" role="alert"><CircleAlert size={16}/><span>{correctionError}</span></p>}
      {notice && <p className="lifetime-notice" role="status"><Check size={16}/><span>{notice}</span></p>}
      {flow && <CorrectionFlowCard
        flow={flow}
        resumable={resumable}
        onReplacement={text => setFlow(current => current?.key === flow.key ? { ...current, replacement: text, reviewed: false } : current)}
        onReview={() => setFlow(current => current?.key === flow.key ? { ...current, reviewed: true } : current)}
        onBack={() => setFlow(current => current?.key === flow.key ? { ...current, reviewed: false } : current)}
        onCancel={() => setFlow(null)}
        onRetryInspect={() => inspectIntoFlow(flow.key, flow.origin, flow.content)}
        onConfirm={() => void confirmCorrection(flow)}
      />}
      {loading && !list && <p className="lifetime-empty"><Clock3 size={16}/>기억 출처 목록을 불러오는 중입니다.</p>}
      {list !== null && list.sources.length === 0 && <p className="lifetime-empty">이 Ghost·대화 쌍에 기록된 기억 출처가 없습니다.</p>}
      {list?.truncated && <p className="lifetime-sync-warning" role="status"><CircleAlert size={16}/><span>최신 순으로 최대 64개의 출처만 표시합니다. 더 오래된 출처는 이 목록에 없습니다.</span></p>}
      {list?.sources.map(row => <MemorySourceRow
        key={memorySourceRowKey(row)}
        row={row}
        busy={flow ? 'flow' : busy}
        intentBlocked={unknownIntents[row.origin.source_id] === true}
        receipt={rowReceipts[memorySourceRowKey(row)] ?? null}
        rowError={rowErrors[memorySourceRowKey(row)] ?? ''}
        onInspect={() => void inspectRow(row)}
        onStartCorrection={() => startCorrection(row)}
        onResume={() => void resumeCorrection(row)}
      />)}
    </>}
  </section>;
}

function MemorySourceRow({ row, busy, intentBlocked, receipt, rowError, onInspect, onStartCorrection, onResume }: {
  row: OwnerMemorySourceView;
  busy: string;
  intentBlocked: boolean;
  receipt: MemorySourceReceipt | null;
  rowError: string;
  onInspect(): void;
  onStartCorrection(): void;
  onResume(): void;
}) {
  const key = memorySourceRowKey(row);
  const pending = row.correction_request_id !== null;
  const canCorrect = row.content !== null && !pending && !intentBlocked && correctionEntryAllowed(row.receipt.status);
  return <article className="lifetime-outbox-row memory-source-row">
    <div>
      <strong>{memorySourceKindLabel(row.origin.kind)} 출처 · {row.origin.source_id}</strong>
      <span>판본 {row.origin.revision} · {memorySourceDisclosureLabels[row.origin.disclosure]} · 상태 {memorySourceStatusLabels[row.receipt.status]}</span>
      <code>원문 해시 {row.origin.content_sha256}</code>
      {row.receipt.episode_id && <code>에피소드 {row.receipt.episode_id}</code>}
      {pending && <p className="memory-source-pending" role="status">미확정 교정 요청이 있습니다. 원래 요청 ID({row.correction_request_id})만 이어갈 수 있고 새 교정은 만들 수 없습니다.</p>}
      {intentBlocked && !pending && <p className="memory-source-pending" role="status">이 출처의 교정 접수가 미확정 상태로 기록됐습니다. 목록에 원래 요청 이어가기가 나타날 때까지 새 교정을 만들 수 없습니다.</p>}
      {row.content === null
        ? <p className="memory-source-unavailable">원문 확인 불가 — 이 출처의 원본 내용이 접수 기록에서 복원되지 않았습니다. 원문 없이는 교정할 수 없습니다.</p>
        : <DetailDialog title="출처 원문"><pre className="garden-document-source-readonly memory-source-text"><code>{row.content}</code></pre></DetailDialog>}
      <p className="memory-source-note">위 내용은 보존된 출처 본문과 접수 상태이며 이 Ghost가 수용한 믿음이나 검증된 사실이 아닙니다.</p>
      {receipt && <div className="memory-source-inspect">
        <strong>접수 기록 검토 결과</strong>
        <span>상태 {memorySourceStatusLabels[receipt.status]} · 해시 {receipt.content_sha256}</span>
        {receipt.episode_id && <code>에피소드 {receipt.episode_id}</code>}
        <code>{receipt.source_locator}</code>
      </div>}
      {rowError && <p className="lifetime-alert" role="alert"><CircleAlert size={16}/><span>{rowError}</span></p>}
      <DetailDialog title="기술 정보">
        <code>owner {row.origin.owner} · 접수 판본 {row.receipt.revision}{row.receipt.prior_episode_id ? ` · 이전 에피소드 ${row.receipt.prior_episode_id}` : ''}{row.receipt.redaction_closure_sha256 ? ` · 편집 마감 해시 ${row.receipt.redaction_closure_sha256}` : ''}</code>
        <code>{row.receipt.source_locator}</code>
      </DetailDialog>
    </div>
    <div className="memory-source-actions">
      {row.content !== null && <button type="button" className="button secondary" disabled={busy !== ''} onClick={onInspect}>
        <RefreshCw size={14}/>{busy === `inspect:${key}` ? '검토 중' : '원본 접수 기록 검토'}
      </button>}
      {pending && <button type="button" className="button secondary" disabled={busy !== ''} onClick={onResume}>
        {busy === `resume:${key}` ? '이어가는 중' : '원래 요청 이어가기'}
      </button>}
      {canCorrect && <button type="button" className="button secondary" disabled={busy !== ''} onClick={onStartCorrection}>교정 검토</button>}
      {!canCorrect && !pending && !intentBlocked && row.content !== null
        && <span>{memorySourceStatusLabels[row.receipt.status]} 상태에서는 새 교정을 만들 수 없습니다. 접수 기록 검토는 가능합니다.</span>}
    </div>
  </article>;
}

function CorrectionFlowCard({ flow, resumable, onReplacement, onReview, onBack, onCancel, onRetryInspect, onConfirm }: {
  flow: CorrectionFlow;
  resumable: boolean;
  onReplacement(text: string): void;
  onReview(): void;
  onBack(): void;
  onCancel(): void;
  onRetryInspect(): void;
  onConfirm(): void;
}) {
  const unchanged = flow.replacement === flow.content;
  // The editor and the confirm path only exist for an inspected receipt that
  // is a recorded state of exactly this origin with its episode.
  const receiptUsable = flow.receipt !== null
    && correctionEntryAllowed(flow.receipt.status)
    && flow.receipt.episode_id !== null
    && receiptMatchesOrigin(flow.receipt, flow.origin);
  const locked = flow.attempted;
  return <article className="memory-source-flow" aria-label="교정 검토">
    <header className="memory-source-flow-header">
      <div>
        <strong>교정 검토 · {memorySourceKindLabel(flow.origin.kind)} {flow.origin.source_id}</strong>
        <span>{locked ? '미확정 교정 접수가 있어 이 검토는 원래 요청 본문에 고정됩니다.' : '취소하면 아무 효과도 만들지 않습니다. 확정 전까지 원장은 바뀌지 않습니다.'}</span>
      </div>
      {!locked && <button type="button" className="button secondary" disabled={flow.submitting} onClick={onCancel}>검토 취소</button>}
    </header>
    {flow.inspecting && <p className="lifetime-empty"><Clock3 size={16}/>memory_source_inspect로 원본 접수 기록을 확인하는 중입니다.</p>}
    {flow.inspectError && <>
      <p className="lifetime-alert" role="alert"><CircleAlert size={16}/><span>{flow.inspectError}</span></p>
      <div className="memory-source-actions">
        <button type="button" className="button secondary" onClick={onRetryInspect}><RefreshCw size={14}/>다시 검토</button>
        <button type="button" className="button secondary" onClick={onCancel}>검토 취소</button>
      </div>
    </>}
    {flow.receipt && <div className="memory-source-inspect">
      <strong>검토된 접수 기록</strong>
      <span>상태 {memorySourceStatusLabels[flow.receipt.status]} · 해시 {flow.receipt.content_sha256}</span>
      {flow.receipt.episode_id && <code>교정 기준 에피소드 {flow.receipt.episode_id}</code>}
      <code>{flow.receipt.source_locator}</code>
    </div>}
    {flow.receipt && !receiptUsable && !locked && <>
      <p className="lifetime-alert" role="alert"><CircleAlert size={16}/>
        <span>{memorySourceStatusLabels[flow.receipt.status]} 상태이거나 검토된 접수 기록이 이 출처와 일치하지 않아 새 교정을 만들 수 없습니다. 목록의 접수 상태를 확인해 주세요.</span>
      </p>
      <div className="memory-source-actions">
        <button type="button" className="button secondary" onClick={onCancel}>검토 닫기</button>
      </div>
    </>}
    {flow.receipt && receiptUsable && !locked && <>
      <p className="memory-source-note">대체 본문도 수용된 믿음이 아니라 다시 검토할 출처 자료로 기록됩니다. 모델은 이 교정을 요청하거나 대신 확인할 수 없습니다.</p>
      {!flow.reviewed ? <>
        <label className="lifetime-field">대체 본문<textarea value={flow.replacement} onChange={event => onReplacement(event.target.value)} disabled={flow.submitting}/></label>
        <div className="memory-source-actions">
          <span>{unchanged ? '대체 본문이 원문과 같습니다. 바꾼 뒤 검토할 수 있습니다.' : '대체 본문을 확인한 뒤 확정 단계로 진행합니다.'}</span>
          <button type="button" className="button secondary" disabled={flow.submitting || !flow.replacement || unchanged} onClick={onReview}>교정 내용 검토</button>
        </div>
      </> : <>
        <div className="memory-source-compare">
          <div>
            <strong>원문</strong>
            <pre className="garden-document-source-readonly memory-source-text"><code>{flow.content}</code></pre>
          </div>
          <div>
            <strong>대체 본문</strong>
            <pre className="garden-document-source-readonly memory-source-text"><code>{flow.replacement}</code></pre>
          </div>
        </div>
        <p className="memory-source-note">확정하면 Host가 위 원래 출처·본문·에피소드를 그대로 검증한 뒤 새 판본을 기록합니다. 같은 의도의 재시도는 같은 요청 ID로 접수됩니다.</p>
        {flow.error && <p className="lifetime-alert" role="alert"><CircleAlert size={16}/><span>{flow.error}</span></p>}
        <div className="memory-source-actions">
          <button type="button" className="button secondary" disabled={flow.submitting} onClick={onBack}>수정으로 돌아가기</button>
          <button type="button" className="button primary" disabled={flow.submitting} onClick={onConfirm}>{flow.submitting ? '확정 중' : '교정 확정'}</button>
        </div>
      </>}
    </>}
    {locked && <>
      <div className="memory-source-compare">
        <div>
          <strong>원문</strong>
          <pre className="garden-document-source-readonly memory-source-text"><code>{flow.content}</code></pre>
        </div>
        <div>
          <strong>보존된 대체 본문</strong>
          <pre className="garden-document-source-readonly memory-source-text"><code>{flow.replacement}</code></pre>
        </div>
      </div>
      {flow.error && <p className="lifetime-alert" role="alert"><CircleAlert size={16}/><span>{flow.error}</span></p>}
      <div className="memory-source-actions">
        {flow.ambiguous === 'transport' && <button type="button" className="button secondary" disabled={flow.submitting} onClick={onConfirm}>
          {flow.submitting ? '확인 중' : '같은 요청 다시 확인'}
        </button>}
        <button type="button" className="button secondary" disabled={!resumable} onClick={onCancel}>검토 닫기</button>
        {!resumable && <span>목록에 이 출처의 원래 요청 이어가기가 나타나면 닫을 수 있습니다.</span>}
      </div>
    </>}
  </article>;
}
