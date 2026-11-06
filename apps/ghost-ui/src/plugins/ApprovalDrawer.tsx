import { DetailDialog } from '../components/DetailDialog';
import { Fragment, useEffect, useRef, useState, type ComponentType } from 'react';
import { ArrowUpRight, Check } from 'lucide-react';
import { Button, InlineError } from '@garden/ui';
import { DotAvatar } from '../components/DotAvatar';
import { ConfirmedFailure } from '../client/errors';
import { Modal } from '../components/Modal';
import { toneFor, type Command, type IntegrationApproval, type Review, type Snapshot } from '../client/types';
import { approvalKey, approvals, approvalState, approvalSubject, approvalTitle, inspectedIntegrationApproval, integrationReceipt, isEmailApproval, readableApprovalField, sameIntegrationRequest, type Approval, type ApprovalKind, type ApprovalRef } from './approvals';
import { reviewPlugin, usePluginPreferences } from './registry';

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

function drawerTitle(item?: Approval) {
  if (!item) return '요청 내용';
  if (item.kind === 'document') return '문서 저장 요청';
  return isEmailApproval(item.review.tool) ? '이메일 발송 요청' : '연동 작업 요청';
}

export function ApprovalDrawer(props: DrawerProps) {
  const { selected, snapshot, onClose } = props;
  const item = approvals(snapshot).find(candidate => approvalKey(candidate) === approvalKey(selected));
  return <Modal title={drawerTitle(item)} onClose={onClose} drawer>
    <ApprovalDrawerContent {...props}/>
  </Modal>;
}

/** The drawer body without the overlay, so its content can be read on its own. */
export function ApprovalDrawerContent(props: DrawerProps) {
  const { selected, snapshot, onOpenConversation } = props;
  const item = approvals(snapshot).find(candidate => approvalKey(candidate) === approvalKey(selected));
  const { bindings } = usePluginPreferences(snapshot.workspace_id, item?.ghostId ?? '');
  const plugin = item && reviewPlugin(item.kind, snapshot, item.ghostId, bindings);
  const Renderer = plugin && renderers[plugin.reviewKind];
  const requester = snapshot.profiles.find(profile => profile.id === item?.ghostId)?.name;
  const destination = item && approvalSubject(item, snapshot);
  return <>
    {!item ? <p role="status" className="text-ui text-ink-2">요청 내용을 찾지 못했습니다.</p> : <>
      <div className="mb-6 flex items-start gap-3">
        <DotAvatar profileId={item.ghostId} tone={toneFor(item.ghostId)} size={42}/>
        <div className="grid min-w-0 flex-1 gap-0.5">
          {requester && <strong className="text-ui font-semibold text-ink">{requester}의 요청</strong>}
          {destination && <span className="text-caption text-ink-2">{destination}</span>}
        </div>
        {item.conversationId && <Button variant="ghost" type="button" className="shrink-0"
          onClick={() => onOpenConversation(item)}>
          원래 대화<ArrowUpRight size={14} aria-hidden="true"/>
        </Button>}
      </div>
      {Renderer ? <Renderer key={`${approvalKey(item)}:${plugin.id}:${plugin.version}`} {...props} item={item}/>
        : <div className="grid gap-2">
          <h2 className="text-headingSm font-semibold text-ink">{approvalTitle(item)}</h2>
          <p className="text-ui text-ink-2">{approvalState(item)}</p>
          <p className="text-ui text-ink-2">이 요청은 원래 대화에서 확인해 주세요.</p>
        </div>}
    </>}
  </>;
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
    <div className="grid gap-2">
      <h2 className="text-headingSm font-semibold text-ink">{review.title}</h2>
      {(review.state !== 'pending' || decision) && <p role="status" className="text-ui text-ink-2">{visibleState}</p>}
      <p className="text-ui text-ink-2">{targetKnown ? expected_hash === null ? '새 문서로 저장' : '기존 문서 수정' : '저장 위치를 확인할 수 없습니다.'}</p>
      {isOpen && !validAuthority && <InlineError>저장 권한이 바뀌었습니다. 새 요청이 필요합니다.</InlineError>}
      {isOpen && changed && <InlineError>요청 내용이 바뀌었습니다. 다시 확인해 주세요.</InlineError>}
      {isOpen && expected_hash && <>
        {!base && <p className="text-ui text-ink-2">{loadError ? '기존 문서를 불러오지 못했습니다.' : connected ? '기존 문서를 확인하는 중…' : '연결을 기다리는 중…'}</p>}
        {base && (base.legacy || base.diagnostic) && <InlineError>이 문서는 읽기만 할 수 있습니다.</InlineError>}
        {mismatch && <InlineError>{review.state === 'approved'
          ? '기존 문서가 바뀌었습니다. 저장 결과를 확인해 주세요.'
          : '요청 이후 문서가 바뀌었습니다. 최신 내용으로 새 요청이 필요합니다.'}</InlineError>}
      </>}
      <div className="whitespace-pre-wrap border-t border-line pt-3 leading-relaxed">{review.body || '본문이 비어 있습니다.'}</div>
      {base && <DetailDialog title="기존 내용과 비교">
        <div className="whitespace-pre-wrap">{base.source}</div>
      </DetailDialog>}
    </div>
    {isOpen && decision !== 'saved' && decision !== 'declined' && <div className="mt-4 grid gap-2 border-t border-line pt-4">
      {decisionError && <InlineError>{decisionError}</InlineError>}
      <div className="flex flex-wrap justify-end gap-2">
        {(changed || loadError || retry !== undefined) && <Button variant="outline" type="button" disabled={busy || !connected}
          onClick={readAgain}>다시 확인</Button>}
        {review.state === 'pending' && <Button variant="outline" type="button"
          disabled={disableDecision || retry === true} onClick={() => void decide(false)}>저장하지 않음</Button>}
        <Button type="button" disabled={disableDecision || !canSave || retry === false}
          onClick={() => void decide(true)}>{decision === 'saving' ? '처리 중…' : review.state === 'approved' ? '저장 결과 확인' : '승인하고 저장'}<Check size={16} aria-hidden="true"/></Button>
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
    <div className="grid gap-2">
      <h2 className="text-headingSm font-semibold text-ink">{email && args ? emailSubject || '제목 없는 이메일' : approvalTitle(item)}</h2>
      {state !== 'pending' && <p role="status" className="text-ui text-ink-2">{email && state === 'sent' ? '메일을 보냈습니다.' : approvalState(approval)}</p>}
      {state === 'pending' && inspected && !inspected.approvalAllowed
        && <InlineError>연결이나 권한이 바뀌어 이 요청을 처리할 수 없습니다.</InlineError>}
      {state === 'uncertain' && <InlineError>{email ? '메일함에서 발송 여부를 확인해 주세요.' : '서비스에서 처리 여부를 확인해 주세요.'}</InlineError>}
      {!args && !error && <p className="text-ui text-ink-2">{connected ? '요청 내용을 불러오는 중…' : '연결을 기다리는 중…'}</p>}
      {emailFields.length > 0 && <ApprovalFields fields={emailFields}/>}
      {emailBody !== undefined && <div className="whitespace-pre-wrap border-t border-line pt-3 leading-relaxed">{emailBody || '본문이 비어 있습니다.'}</div>}
      {extraFields.length > 0 && (email ? <DetailDialog title="메일 세부 내용"><ApprovalFields fields={extraFields}/>
      </DetailDialog> : <ApprovalFields fields={extraFields}/>)}
      {args && !email && extraFields.length === 0 && <p className="text-ui text-ink-2">이 작업에 따로 보낼 내용은 없습니다.</p>}
      {inspected?.output && (!email || state !== 'sent') && <DetailDialog title="서비스 응답">
        {inspected.output.text && <div className="whitespace-pre-wrap">{inspected.output.text}</div>}
        {inspected.output.truncated && <p className="text-ui text-ink-2">나머지 응답은 서비스에서 확인해 주세요.</p>}
      </DetailDialog>}
    </div>
    {(state === 'pending' || error) && <div className="mt-4 grid gap-2 border-t border-line pt-4">
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap justify-end gap-2">
        {error && <Button variant="outline" type="button" onClick={reload} disabled={busy || !connected}>다시 확인</Button>}
        {state === 'pending' && <>
          <Button variant="outline" type="button" disabled={!canDecide || retry === true} onClick={() => void decide(false)}>{email ? '보내지 않기' : '실행하지 않기'}</Button>
          <Button type="button" disabled={!canDecide || !inspected?.approvalAllowed || retry === false}
            onClick={() => void decide(true)}>{sending ? '처리 중…' : email ? '승인하고 보내기' : '승인하고 실행'}<Check size={16} aria-hidden="true"/></Button>
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

const fieldLabels: Record<string, string> = {
  title: '제목', subject: '제목', body: '본문', text: '내용',
  name: '이름', description: '설명', location: '장소',
  start: '시작', end: '종료', attachments: '첨부 파일',
};

function ApprovalFields({ fields }: { fields: [string, unknown][] }) {
  return <dl className="my-3 grid grid-cols-[minmax(5rem,26%)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-ui">
    {fields.map(([name, value]) => <Fragment key={name}>
      <dt className="text-ink-2">{fieldLabels[name] ?? readableApprovalField(name)}</dt>
      <dd className="m-0 min-w-0 whitespace-pre-wrap"><ApprovalValue value={value}/></dd>
    </Fragment>)}
  </dl>;
}

function ApprovalValue({ value }: { value: unknown }) {
  if (value === null || value === '') return '비어 있음';
  if (typeof value === 'boolean') return value ? '예' : '아니요';
  if (Array.isArray(value)) return value.length ? <ul className="m-0 list-disc pl-5">{value.map((entry, index) => <li key={index}><ApprovalValue value={entry}/></li>)}</ul> : '없음';
  if (typeof value === 'object') {
    const fields = Object.entries(value);
    return fields.length ? <ApprovalFields fields={fields}/> : '없음';
  }
  return String(value);
}
