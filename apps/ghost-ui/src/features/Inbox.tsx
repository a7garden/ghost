import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCheck, CircleAlert, FileText, Inbox as InboxIcon } from 'lucide-react';
import { Badge, Button, EmptyState, Page, PageHeader, InlineError, Textarea } from '../ui'
import type { Decision, DecisionKind, State } from '@ghost/contract';
import { WorkRow } from './WorkViews';
import { useHost } from '../host/context';
import { uiTerms } from '../uiText';

export const decisionLabel: Record<DecisionKind, string> = {
  approve_effect: '실행 승인', question: '답변 대기', accept_result: '결과 확인',
  document_review: '문서 검토', reconcile_effect: '결과 미확정',
};

type DocumentProposal = { spaceId?: string; space_id?: string; title?: string; body?: string; pageId?: string | null; page_id?: string | null };

/** The proposal payload of a document decision, in either spelling the ledger has used. */
export function documentProposal(decision: Decision): DocumentProposal | null {
  if (decision.kind !== 'document_review' || !decision.proposal) return null;
  const proposal = decision.proposal;
  return typeof proposal === 'object' ? proposal as DocumentProposal : null;
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

/** One decision and its resolution: the owner settles it here and the answer goes back to the Ghost. */
export function DecisionCard({ decision, ghostName, workTitle, onResolved }: {
  decision: Decision;
  ghostName: string;
  workTitle?: string;
  onResolved(): void;
}) {
  const { client } = useHost();
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const resolve = (outcome: 'approve' | 'deny' | 'answer', text?: string) => {
    setBusy(true); setError('');
    const command = decisionCommand(decision, outcome, text);
    if ('error' in command) { setError(command.error); setBusy(false); return; }
    void client.send(command)
      .then(onResolved)
      .catch(e => { setError(e instanceof Error ? e.message : '결정을 전달하지 못했습니다. 다시 시도해 주세요.'); setBusy(false); });
  };
  const proposal = documentProposal(decision);
  const context = [ghostName, workTitle].filter(Boolean).join(' · ');
  return <article data-decision-kind={decision.kind} aria-label={decision.title} className="grid gap-3 rounded-card border border-line bg-surface p-4">
    <header className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="warning">{decisionLabel[decision.kind]}</Badge>
        {context && <span className="text-caption text-ink-2">{context}</span>}
      </div>
      <h3 className="m-0 text-body font-semibold text-ink [overflow-wrap:anywhere]">{decision.title}</h3>
    </header>
    {decision.detail.trim() && <p className="m-0 text-ui leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{decision.detail}</p>}
    {decision.kind === 'document_review' && proposal && <div className="grid gap-2 rounded-control border border-line bg-page p-4">
      <p className="m-0 flex items-center gap-1.5 text-caption text-ink-2"><FileText className="size-4" aria-hidden="true"/>제안된 문서{proposal.pageId || proposal.page_id ? ' · 기존 페이지 수정' : ' · 새 페이지'}</p>
      {proposal.title && <h4 className="m-0 text-body font-semibold text-ink">{proposal.title}</h4>}
      <div className="max-h-[24rem] overflow-y-auto text-ui leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{proposal.body ?? '(본문 없음)'}</div>
    </div>}
    {decision.kind !== 'document_review' && decision.kind !== 'question' && decision.proposal
      && <DetailJson value={decision.proposal}/>}
    {decision.kind === 'question' && <>
      {decision.options.length > 0 && <div className="flex flex-wrap gap-1.5" role="group" aria-label="추천 답변">
        {decision.options.map(option => <Button key={option} variant="outline" size="sm" disabled={busy} onClick={() => resolve('answer', option)}>{option}</Button>)}
      </div>}
      <Textarea aria-label="답변" value={answer} onChange={event => setAnswer(event.target.value)} rows={2} maxLength={8192} placeholder="답변을 적어 보내 주세요."/>
    </>}
    {error && <InlineError>{error}</InlineError>}
    <footer className="flex flex-wrap justify-end gap-2">
      {decision.kind === 'question'
        ? <Button disabled={busy || !answer.trim()} onClick={() => resolve('answer', answer)}>답변 보내기</Button>
        : <>
          <Button variant="outline" disabled={busy} onClick={() => resolve('deny')}>거부</Button>
          <Button disabled={busy} onClick={() => resolve('approve')}>{decision.kind === 'accept_result' ? '결과 확인' : decision.kind === 'reconcile_effect' ? '의도대로 처리됨' : '승인'}</Button>
        </>}
    </footer>
  </article>;
}

/** Small pretty-printed payload for effect proposals; details stay one click away. */
function DetailJson({ value }: { value: Record<string, unknown> }) {
  const json = JSON.stringify(value, null, 2);
  if (json.length > 400) return <details className="text-caption text-ink-2"><summary className="cursor-pointer">요청 내용 보기</summary><pre className="mt-2 overflow-auto text-caption [overflow-wrap:anywhere]">{json}</pre></details>;
  return <pre className="m-0 rounded-control border border-line bg-page p-3 text-caption [overflow-wrap:anywhere]">{json}</pre>;
}

/** 확인할 일: decisions waiting on the owner, then what the host wants seen, newest first. */
export function InboxView({ state, navigate, focusDecisionId }: {
  state: State;
  navigate(path: string): void;
  /** ?decision= opens that decision's resolution directly. */
  focusDecisionId: string | null;
}) {
  const { client } = useHost();
  const [error, setError] = useState('');
  const ghostName = (id: string) => state.ghosts.find(ghost => ghost.id === id)?.name ?? 'Ghost';
  const workTitle = (id: string | null) => id ? state.works.find(work => work.id === id)?.title : undefined;
  const pending = state.decisions.filter(decision => decision.state === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);
  const settled = state.decisions.filter(decision => decision.state !== 'pending')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt)).slice(0, 6);
  const notifications = [...state.notifications].sort((a, b) => b.createdAt - a.createdAt);
  const unread = notifications.filter(item => !item.readAt);
  const focused = focusDecisionId ? pending.find(decision => decision.id === focusDecisionId) ?? null : null;
  const markRead = (ids: string[]) => { setError(''); void client.send({ type: 'notification.read', notificationIds: ids }).catch(e => setError(e instanceof Error ? e.message : '읽음 표시를 저장하지 못했습니다.')); };
  const settledLabel: Record<Decision['state'], string> = { pending: '', approved: '승인됨', denied: '거부됨', answered: '답변됨', cancelled: '취소됨' };
  const settledTone: Record<Decision['state'], 'success' | 'danger' | 'outline' | 'default'> = { pending: 'default', approved: 'success', denied: 'danger', answered: 'success', cancelled: 'outline' };
  const seenFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focused || seenFocus.current === focused.id) return;
    seenFocus.current = focused.id;
    requestAnimationFrame(() => document.getElementById(`decision-${focused.id}`)?.scrollIntoView({ block: 'center' }));
  }, [focused]);
  return <Page>
    <PageHeader title={uiTerms.inbox}/>
    {error && <InlineError>{error}</InlineError>}
    <section className="grid gap-3" aria-labelledby="inbox-pending">
      <h2 id="inbox-pending" className="m-0 flex items-center gap-2 text-ui font-semibold text-ink">확인 필요
        {pending.length > 0 && <Badge variant="warning">{pending.length}</Badge>}
      </h2>
      {pending.map(decision => <div key={decision.id} id={`decision-${decision.id}`}>
        <DecisionCard decision={decision} ghostName={ghostName(decision.ghostId)} workTitle={workTitle(decision.workId) ?? undefined}
          onResolved={() => navigate('/inbox')}/>
      </div>)}
      {!pending.length && <EmptyState icon={<CheckCheck/>} title="확인이 필요한 항목 없음" className="py-10"
        action={<Button variant="outline" onClick={() => navigate('/')}>나의 Ghost 보기</Button>}/>}
    </section>
    {notifications.length > 0 && <section className="grid gap-1" aria-labelledby="inbox-notifications">
      <div className="flex items-center justify-between gap-2">
        <h2 id="inbox-notifications" className="m-0 flex items-center gap-2 text-ui font-semibold text-ink"><InboxIcon className="size-4"/>알림</h2>
        {unread.length > 0 && <Button variant="ghost" size="sm" onClick={() => markRead(unread.map(item => item.id))}>모두 읽음 표시</Button>}
      </div>
      {notifications.map(item => <WorkRow key={item.id} icon={<CircleAlert className="size-5 text-ink-3"/>} data-inbox-kind="notification"
        title={item.title} note={item.body} className={item.readAt ? 'opacity-60' : undefined}
        owner={new Date(item.createdAt).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        action={!item.readAt ? <Button variant="ghost" size="sm" onClick={() => markRead([item.id])}>읽음</Button> : undefined}
        onClick={item.workId ? () => navigate(`/work/${encodeURIComponent(item.workId!)}`) : item.decisionId ? () => navigate(`/inbox?decision=${encodeURIComponent(item.decisionId!)}`) : item.conversationId ? () => {
          const conversation = state.conversations.find(entry => entry.id === item.conversationId);
          if (conversation) navigate(`/ghosts/${encodeURIComponent(conversation.ghostId)}?conversation=${encodeURIComponent(conversation.id)}`);
        } : undefined}/>)}
    </section>}
    {settled.length > 0 && <section className="mt-4 grid gap-1" aria-labelledby="inbox-settled">
      <h2 id="inbox-settled" className="m-0 text-ui font-semibold text-ink">처리한 결정</h2>
      {settled.map(decision => <WorkRow key={decision.id} ghostId={decision.ghostId} data-inbox-kind="settled"
        title={decision.title} owner={ghostName(decision.ghostId)}
        status={{ label: settledLabel[decision.state], tone: settledTone[decision.state] }}
        onClick={decision.workId ? () => navigate(`/work/${encodeURIComponent(decision.workId!)}`) : undefined}/>)}
    </section>}
    {focused && !pending.includes(focused) && <InlineError>이미 처리된 결정입니다. <button type="button" className="cursor-pointer underline underline-offset-2" onClick={() => navigate('/inbox')}>목록으로</button></InlineError>}
    <p className="m-0 mt-6 text-caption text-ink-3"><ArrowRight className="mr-1 inline size-3" aria-hidden="true"/>결정은 Ghost의 대화에 바로 전달됩니다.</p>
  </Page>;
}
