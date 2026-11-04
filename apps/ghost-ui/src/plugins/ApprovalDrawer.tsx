import { DetailDialog } from '../components/DetailDialog';
import { Fragment, useEffect, useRef, useState, type ComponentType } from 'react';
import { ArrowUpRight, Check } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { ConfirmedFailure } from '../client/errors';
import { Modal } from '../components/Modal';
import { toneFor, type Command, type IntegrationApproval, type Review, type Snapshot } from '../client/types';
import { approvalKey, approvals, approvalState, approvalSubject, approvalTitle, inspectedIntegrationApproval, integrationReceipt, isEmailApproval, readableApprovalField, sameIntegrationRequest, type Approval, type ApprovalKind, type ApprovalRef } from './approvals';
import { reviewPlugin, usePluginPreferences } from './registry';
import '../features/garden-document-preview.css';
import './plugins.css';

type WorkspaceCall = (command: Command) => Promise<Record<string, unknown>>;

type DrawerProps = {
  selected: ApprovalRef;
  snapshot: Snapshot;
  connected: boolean;
  busy: boolean;
  action: WorkspaceCall;
  query: WorkspaceCall;
  onClose: () => void;
  onOpenConversation: (approval: Approval) => void;
};

type ReviewProps = Omit<DrawerProps, 'selected' | 'onClose' | 'onOpenConversation'> & {
  item: Approval;
};

const renderers: Record<ApprovalKind, ComponentType<ReviewProps>> = {
  document: DocumentApproval,
  integration: IntegrationApprovalReview,
};

export function ApprovalDrawer(props: DrawerProps) {
  const { selected, snapshot, onClose, onOpenConversation } = props;
  const item = approvals(snapshot).find(item => approvalKey(item) === approvalKey(selected));
  const { bindings } = usePluginPreferences(snapshot.workspace_id, item?.ghostId ?? '');
  const plugin = item && reviewPlugin(item.kind, snapshot, item.ghostId, bindings);
  const Renderer = plugin && renderers[plugin.reviewKind];
  const title = !item ? '요청 내용' : item.kind === 'document' ? '문서 저장 요청'
    : isEmailApproval(item.review.tool) ? '이메일 발송 요청' : '연동 작업 요청';
  const requester = snapshot.profiles.find(profile => profile.id === item?.ghostId)?.name;
  const destination = item && approvalSubject(item, snapshot);
  return <Modal title={title} onClose={onClose} drawer className="approval-drawer">
    {!item ? <p className="muted" role="status">요청 내용을 찾지 못했습니다.</p> : <>
      <div className="review-byline">
        <DotAvatar profileId={item.ghostId} tone={toneFor(item.ghostId)} size={42}/>
        <div>{requester && <strong>{requester}의 요청</strong>}
          {destination && <span>{destination}</span>}</div>
        {item.conversationId && <button type="button" className="text-button" onClick={() => onOpenConversation(item)}>
          원래 대화<ArrowUpRight size={14}/>
        </button>}
      </div>
      {Renderer ? <Renderer key={`${approvalKey(item)}:${plugin.id}:${plugin.version}`} {...props} item={item}/> :
        <div className="review-content approval-detail">
          <h2>{approvalTitle(item)}</h2>
          <p>{approvalState(item)}</p>
          <p className="muted">이 요청은 원래 대화에서 확인해 주세요.</p>
        </div>}
    </>}
  </Modal>;
}

function DocumentApproval(props: ReviewProps) {
  return props.item.kind === 'document' ? <DocumentReviewBody {...props} review={props.item.review}/> : null;
}

type CurrentPage = {
  id: string;
  hash: string;
  source: string;
  legacy: boolean;
  diagnostic: boolean;
};

function DocumentReviewBody({ item, review, snapshot, query, action, connected, busy }: ReviewProps & { review: Review }) {
  const [examined, setExamined] = useState(review);
  const [current, setCurrent] = useState<CurrentPage>();
  const [loadError, setLoadError] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const [decision, setDecision] = useState<'saving' | 'saved' | 'declined'>();
  const [decisionError, setDecisionError] = useState('');
  const [retry, setRetry] = useState<boolean>();
  const inFlight = useRef(false);
  const { space_id, page_id, expected_hash } = review;
  const authorityEpoch = snapshot.lifetime_authority?.authority_epoch;
  const validAuthority = !review.lifetime_origin || review.lifetime_origin.authority_epoch === authorityEpoch;
  const changed = examined.profile_id !== review.profile_id || examined.conversation_id !== review.conversation_id
    || examined.space_id !== space_id || examined.page_id !== page_id || examined.expected_hash !== expected_hash
    || examined.title !== review.title || examined.body !== review.body
    || examined.lifetime_origin?.request_digest !== review.lifetime_origin?.request_digest
    || examined.lifetime_origin?.authority_epoch !== review.lifetime_origin?.authority_epoch;
  const isOpen = review.state === 'pending' || review.state === 'approved';

  useEffect(() => {
    if (!connected || !isOpen || !page_id || !expected_hash || !validAuthority) return;
    let active = true;
    void query({ type: 'workspace', action: { type: 'read_page', space_id, page_id, locator: null } }).then(page => {
      if (!active) return;
      const { id, hash, source, body, legacy, diagnostic, deleted } = page;
      const text = typeof source === 'string' ? source : body;
      if (id !== page_id || typeof hash !== 'string' || typeof text !== 'string') throw new Error('invalid page');
      setCurrent({ id, hash, source: text, legacy: legacy === true, diagnostic: Boolean(diagnostic) || deleted === true });
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [connected, isOpen, space_id, page_id, expected_hash, validAuthority, query, readRevision]);

  const readAgain = () => {
    setExamined(review);
    setCurrent(undefined);
    setLoadError(false);
    setReadRevision(value => value + 1);
  };
  const base = page_id && current?.id === page_id ? current : undefined;
  const mismatch = Boolean(base && base.hash !== expected_hash);
  const targetKnown = Boolean(page_id && expected_hash !== undefined && space_id);
  const writable = snapshot.spaces.find(space => space.id === space_id)?.writable === true;
  const canSave = targetKnown && writable && (expected_hash === null
    || Boolean(base && !base.legacy && !base.diagnostic && (!mismatch || review.state === 'approved')));
  const disableDecision = !connected || !validAuthority || changed || busy || Boolean(decision);

  async function decide(approve: boolean) {
    if (inFlight.current || disableDecision || !isOpen || (retry !== undefined && retry !== approve)
      || (approve ? !canSave : review.state !== 'pending')) return;
    inFlight.current = true;
    setDecision('saving');
    setDecisionError('');
    try {
      await action({ type: 'workspace', action: { type: 'decide_review', review_id: review.id, approve } });
      setDecision(approve ? 'saved' : 'declined');
    } catch {
      setDecision(undefined);
      setRetry(approve);
      setDecisionError('처리 결과를 확인하지 못했습니다. 다시 확인해 주세요.');
    } finally { inFlight.current = false; }
  }
  const visibleState = decision === 'saved' ? '저장 완료' : decision === 'declined' ? '거절됨' : approvalState(item);
  return <>
    <div className="review-content approval-detail">
      <h2>{review.title}</h2>
      {(review.state !== 'pending' || decision) && <p role="status">{visibleState}</p>}
      <p className="muted">{targetKnown ? expected_hash === null ? '새 문서로 저장' : '기존 문서 수정' : '저장 위치를 확인할 수 없습니다.'}</p>
      {isOpen && !validAuthority && <p className="inline-error">저장 권한이 바뀌었습니다. 새 요청이 필요합니다.</p>}
      {isOpen && changed && <p className="inline-error">요청 내용이 바뀌었습니다. 다시 확인해 주세요.</p>}
      {isOpen && expected_hash && <>
        {!base && <p className="muted">{loadError ? '기존 문서를 불러오지 못했습니다.' : connected ? '기존 문서를 확인하는 중…' : '연결을 기다리는 중…'}</p>}
        {base && (base.legacy || base.diagnostic) && <p className="inline-error">이 문서는 읽기만 할 수 있습니다.</p>}
        {mismatch && <p className="inline-error">{review.state === 'approved'
          ? '기존 문서가 바뀌었습니다. 저장 결과를 확인해 주세요.'
          : '요청 이후 문서가 바뀌었습니다. 최신 내용으로 새 요청이 필요합니다.'}</p>}
      </>}
      <div className="approval-prose">{review.body || '본문이 비어 있습니다.'}</div>
      {base && <DetailDialog title="기존 내용과 비교" className="approval-compare">
        <div className="approval-prose">{base.source}</div>
      </DetailDialog>}
    </div>
    {isOpen && decision !== 'saved' && decision !== 'declined' && <div className="drawer-footer">
      {decisionError && <p className="inline-error" role="alert">{decisionError}</p>}
      <div>
        {(changed || loadError || retry !== undefined) && <button type="button" className="button secondary" disabled={busy || !connected}
          onClick={readAgain}>다시 확인</button>}
        {review.state === 'pending' && <button type="button" className="button secondary"
          disabled={disableDecision || retry === true} onClick={() => void decide(false)}>저장하지 않음</button>}
        <button type="button" className="button primary" disabled={disableDecision || !canSave || retry === false}
          onClick={() => void decide(true)}>{decision === 'saving' ? '처리 중…' : review.state === 'approved' ? '저장 결과 확인' : '승인하고 저장'}<Check size={16}/></button>
      </div>
    </div>}
  </>;
}

type IntegrationDetail = NonNullable<ReturnType<typeof inspectedIntegrationApproval>>;

function IntegrationApprovalReview(props: ReviewProps) {
  return props.item.kind === 'integration' ? <IntegrationReviewBody {...props} item={props.item}/> : null;
}

function IntegrationReviewBody({ item, action, query, connected, busy }: ReviewProps & { item: Extract<Approval, { kind: 'integration' }> }) {
  const [detail, setDetail] = useState<IntegrationDetail>();
  const [receipt, setReceipt] = useState<IntegrationApproval>();
  const [loadRevision, setLoadRevision] = useState(0);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [retry, setRetry] = useState<boolean>();
  const inFlight = useRef(false);
  const { review } = item;
  const { id, ghost_id, conversation_id, integration_id, integration_name, tool, created_ms } = review;
  const terminal = review.state !== 'pending' && review.state !== 'dispatching';
  const inspected = detail && sameIntegrationRequest(review, detail.summary) ? detail : undefined;
  const confirmed = receipt && sameIntegrationRequest(review, receipt) ? receipt : undefined;
  const state = terminal ? review.state : confirmed?.state ?? (review.state === 'dispatching' ? review.state : inspected?.summary.state) ?? review.state;

  useEffect(() => {
    if (!connected) return;
    let active = true;
    const expected = { id, ghost_id, conversation_id, integration_id, integration_name, tool, created_ms };
    void query({ type: 'workspace', action: { type: 'inspect_integration_approval', id } }).then(result => {
      if (!active) return;
      const inspected = inspectedIntegrationApproval(expected, result);
      if (!inspected) throw new Error('invalid approval');
      setDetail(inspected);
      setError(inspected.summary.state === 'pending' && retry !== undefined
        ? '아직 처리 결과를 확인하지 못했습니다.' : '');
    }).catch(() => { if (active) setError('요청 내용을 불러오지 못했습니다.'); });
    return () => { active = false; };
  }, [connected, id, ghost_id, conversation_id, integration_id, integration_name, tool, created_ms, query, loadRevision, retry, review.state, receipt?.state]);

  const reload = () => {
    setDetail(undefined);
    setError('');
    setLoadRevision(value => value + 1);
  };
  const canDecide = connected && !busy && !sending && state === 'pending' && inspected?.summary.state === 'pending';
  async function decide(approve: boolean) {
    if (!canDecide || inFlight.current || !inspected || (approve && !inspected.approvalAllowed)
      || (retry !== undefined && retry !== approve)) return;
    inFlight.current = true;
    setSending(true);
    setError('');
    const exactId = inspected.summary.id;
    try {
      const result = await action({ type: 'workspace', action: { type: 'decide_integration_approval', id: exactId, approve } });
      const confirmed = integrationReceipt(review, result);
      if (!confirmed || confirmed.state === 'pending') throw new Error('invalid receipt');
      setReceipt(confirmed);
    } catch (failure) {
      if (failure instanceof ConfirmedFailure) {
        setRetry(undefined);
        setError('요청을 처리할 수 없습니다. 내용을 다시 확인해 주세요.');
        return;
      }
      // Inspect the same approval before offering the same decision again.
      // The workspace command queue retains its original request envelope.
      setRetry(approve);
      setDetail(undefined);
      setLoadRevision(value => value + 1);
      setError('처리 결과를 확인하고 있습니다.');
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  const email = isEmailApproval(tool);
  const args = inspected?.arguments;
  const emailBody = email && typeof args?.body === 'string' ? args.body : undefined;
  const emailSubject = email && typeof args?.subject === 'string' ? args.subject : undefined;
  const emailFields = args && email ? Object.entries(mailFieldLabels)
    .filter(([key]) => Object.hasOwn(args, key) && args[key] !== '' && args[key] !== null)
    .map(([key, label]): [string, unknown] => [label, args[key]]) : [];
  const extraFields = args ? Object.entries(args).filter(([key]) => !email
    || (!Object.hasOwn(mailFieldLabels, key) && (key !== 'body' || emailBody === undefined)
      && (key !== 'subject' || emailSubject === undefined))) : [];
  const approval = { ...item, review: { ...review, state } };

  return <>
    <div className="review-content approval-detail">
      <h2>{email && args ? emailSubject || '제목 없는 이메일' : approvalTitle(item)}</h2>
      {state !== 'pending' && <p role="status">{email && state === 'sent' ? '메일을 보냈습니다.' : approvalState(approval)}</p>}
      {state === 'pending' && inspected && !inspected.approvalAllowed
        && <p className="inline-error">연결이나 권한이 바뀌어 이 요청을 처리할 수 없습니다.</p>}
      {state === 'uncertain' && <p className="inline-error">{email ? '메일함에서 발송 여부를 확인해 주세요.' : '서비스에서 처리 여부를 확인해 주세요.'}</p>}
      {!args && !error && <p className="muted">{connected ? '요청 내용을 불러오는 중…' : '연결을 기다리는 중…'}</p>}
      {emailFields.length > 0 && <ApprovalFields fields={emailFields}/>}
      {emailBody !== undefined && <div className="approval-prose">{emailBody || '본문이 비어 있습니다.'}</div>}
      {extraFields.length > 0 && (email ? <DetailDialog title="메일 세부 내용" className="approval-compare"><ApprovalFields fields={extraFields}/>
      </DetailDialog> : <ApprovalFields fields={extraFields}/>)}
      {args && !email && extraFields.length === 0 && <p className="muted">이 작업에 따로 보낼 내용은 없습니다.</p>}
      {inspected?.output && (!email || state !== 'sent') && <DetailDialog title="서비스 응답" className="approval-compare">
        {inspected.output.text && <div className="approval-prose">{inspected.output.text}</div>}
        {inspected.output.truncated && <p className="muted">나머지 응답은 서비스에서 확인해 주세요.</p>}
      </DetailDialog>}
    </div>
    {(state === 'pending' || error) && <div className="drawer-footer">
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div>
        {error && <button type="button" className="button secondary" onClick={reload} disabled={busy || !connected}>다시 확인</button>}
        {state === 'pending' && <>
          <button type="button" className="button secondary" disabled={!canDecide || retry === true} onClick={() => void decide(false)}>{email ? '보내지 않기' : '실행하지 않기'}</button>
          <button type="button" className="button primary" disabled={!canDecide || !inspected?.approvalAllowed || retry === false}
            onClick={() => void decide(true)}>{sending ? '처리 중…' : email ? '승인하고 보내기' : '승인하고 실행'}<Check size={16}/></button>
        </>}
      </div>
    </div>}
  </>;
}

const mailFieldLabels = {
  to: '받는 사람',
  cc: '참조',
  bcc: '숨은 참조',
  from: '보내는 사람',
  user_google_email: '보내는 계정',
};

const fieldLabels = new Map([
  ['title', '제목'], ['subject', '제목'], ['body', '본문'], ['text', '내용'],
  ['name', '이름'], ['description', '설명'], ['location', '장소'],
  ['start', '시작'], ['end', '종료'], ['attachments', '첨부 파일'],
]);

function ApprovalFields({ fields }: { fields: [string, unknown][] }) {
  return <dl className="approval-fields">{fields.map(([name, value]) => <Fragment key={name}>
    <dt>{fieldLabels.get(name) ?? readableApprovalField(name)}</dt>
    <dd><ApprovalValue value={value}/></dd>
  </Fragment>)}</dl>;
}

function ApprovalValue({ value }: { value: unknown }) {
  if (value === null || value === '') return '비어 있음';
  if (typeof value === 'boolean') return value ? '예' : '아니요';
  if (Array.isArray(value)) return value.length ? <ul>{value.map((entry, index) => <li key={index}><ApprovalValue value={entry}/></li>)}</ul> : '없음';
  if (typeof value === 'object') {
    const fields = Object.entries(value);
    return fields.length ? <ApprovalFields fields={fields}/> : '없음';
  }
  return String(value);
}
