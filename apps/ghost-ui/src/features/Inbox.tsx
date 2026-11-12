import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { CheckCheck, ChevronDown, Undo2 } from 'lucide-react';
import { Badge, Banner, Button, Checkbox, Page, PageHeader, InlineError } from '../ui'
import type { Decision, Notification, State } from '@ghost/contract';
import { reviewOf } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { NotificationRow } from '../components/NotificationRow';
import { useHost } from '../host/context';
import { uiTerms } from '../uiText';
import { DecisionCard, autoSettleText, deadlineText, resolvedText } from './Decision';
import { decisionChip, decisionHeading } from './decisionText';
import { canHandOver, deferDecision, handedOver, ownerOrder, pruneLater, recommendedLabel, recommendedResolution, undeferDecision, useLater } from './decisionQueue';
import { pendingDecisions, toneFor } from './ghostState';
import { relativeTime, useNow } from './time';
import { notificationRoute } from './notificationRoute';

const SETTLED_PREVIEW = 8;
const NOTIFICATION_PAGE = 20;

const settledLabel: Record<Decision['state'], string> = { pending: '', approved: '승인됨', denied: '거부됨', answered: '답변됨', cancelled: '취소됨' };

/**
 * 확인할 일: 기다리는 결정을 한 줄씩 — 제목 · 추천 · 빠른 처리만 보이고, 줄을 누르면 그 자리에서 카드가 펼쳐진다.
 * 2026.11.11 : 카드 한 장씩 넘기던 화면을 빨리 훑고 넘기는 목록으로 바꿨다. 추천대로 한꺼번에 · 메인에게 맡기기 ·
 * 나중에(이 기기에서 뒤로)를 둔다. 소식과 처리한 결정은 접어서 아래에 둔다.
 */
export function InboxView({ state, navigate, focusDecisionId }: {
  state: State;
  navigate(path: string): void;
  /** ?decision= opens that decision in place. */
  focusDecisionId: string | null;
}) {
  const { client } = useHost();
  const now = useNow();
  const later = useLater();
  const [error, setError] = useState('');
  const [ack, setAck] = useState('');
  const [open, setOpen] = useState<string | null>(focusDecisionId);
  const [batch, setBatch] = useState<Set<string> | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [allSettled, setAllSettled] = useState(false);
  const [notificationLimit, setNotificationLimit] = useState(NOTIFICATION_PAGE);
  useEffect(() => { if (focusDecisionId) setOpen(focusDecisionId); }, [focusDecisionId]);
  useEffect(() => { if (!ack) return; const timer = setTimeout(() => setAck(''), 2400); return () => clearTimeout(timer); }, [ack]);

  const ghostName = (id: string | null) => state.ghosts.find(ghost => ghost.id === id)?.name ?? 'Ghost';
  const waiting = pendingDecisions(state);
  useEffect(() => { pruneLater(state.decisions.filter(decision => decision.state === 'pending').map(decision => decision.id)); }, [state.decisions]);
  const ordered = ownerOrder(waiting, later);
  const upNow = ordered.filter(decision => later[decision.id] === undefined);
  const deferred = ordered.filter(decision => later[decision.id] !== undefined);
  const withMain = state.decisions.filter(handedOver).sort((a, b) => a.createdAt - b.createdAt);
  const quick = ordered.filter(decision => recommendedResolution(decision));

  const settled = state.decisions.filter(decision => decision.state !== 'pending')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt));
  const shownSettled = allSettled ? settled : settled.slice(0, SETTLED_PREVIEW);
  // 아직 답을 기다리는 질문의 알림은 위 목록이 이미 말한다 — 같은 질문을 소식에 또 쌓지 않는다.
  const pendingIds = new Set(state.decisions.filter(decision => decision.state === 'pending').map(decision => decision.id));
  const notifications = state.notifications.filter(item => !item.decisionId || !pendingIds.has(item.decisionId))
    .sort((a, b) => b.createdAt - a.createdAt);
  const unread = notifications.filter(item => !item.readAt);
  // 「모두 읽음」은 목록이 대신 보여 준 질문의 알림까지 읽음으로 한다 — 숨긴 것만 남으면 답한 뒤 새 소식으로 되살아난다.
  const unreadAll = state.notifications.filter(item => !item.readAt);
  const shownNotifications = notifications.slice(0, notificationLimit);
  const moreNotifications = notifications.length - shownNotifications.length;
  const focusedSettled = focusDecisionId ? state.decisions.find(decision => decision.id === focusDecisionId && decision.state !== 'pending') : undefined;

  const fail = (fallback: string) => (e: unknown) => setError(e instanceof Error ? e.message : fallback);
  const markRead = (ids: string[]) => { setError(''); void client.send({ type: 'notification.read', notificationIds: ids }).catch(fail('읽음 표시를 저장하지 못했습니다.')); };
  const openNotification = (item: Notification) => {
    if (!item.readAt) markRead([item.id]);
    const destination = notificationRoute(item, state);
    if (destination) navigate(destination);
  };
  const resolveRecommended = async (decision: Decision) => {
    const resolution = recommendedResolution(decision);
    if (!resolution) return;
    await client.send({ type: 'decision.resolve', decisionId: decision.id, ...resolution });
    undeferDecision(decision.id);
  };
  const quickResolve = (decision: Decision) => {
    setError('');
    void resolveRecommended(decision).then(() => setAck(`${decisionHeading(decision, state)} · ${resolvedText(decision.kind, recommendedResolution(decision)?.outcome ?? 'approve')}`))
      .catch(fail('결정을 전달하지 못했습니다. 다시 시도해 주세요.'));
  };
  const handOver = (decision: Decision) => {
    setError('');
    void client.send({ type: 'decision.delegate', decisionId: decision.id })
      .then(() => { undeferDecision(decision.id); setAck(`${decisionHeading(decision, state)} · 메인 Ghost에게 맡겼습니다`); })
      .catch(fail('메인 Ghost에게 맡기지 못했습니다.'));
  };
  const runBatch = async () => {
    if (!batch) return;
    setBatchBusy(true); setError('');
    const chosen = quick.filter(decision => batch.has(decision.id));
    let done = 0;
    const failed: string[] = [];
    // 하나씩 보낸다 — 한 건이 실패해도 나머지는 처리되고, 실패한 것은 목록에 그대로 남는다.
    for (const decision of chosen) {
      try { await resolveRecommended(decision); done++; } catch { failed.push(decisionHeading(decision, state)); }
    }
    setBatchBusy(false); setBatch(null);
    setAck(`추천대로 ${done}건 처리했습니다`);
    if (failed.length) setError(`처리하지 못한 결정: ${failed.join(', ')}`);
  };

  const row = (decision: Decision, place: 'now' | 'later') => <QueueRow key={decision.id} decision={decision} state={state} now={now}
    ghostName={ghostName(decision.ghostId)} open={open === decision.id} place={place}
    onToggle={() => setOpen(current => current === decision.id ? null : decision.id)}
    onRecommended={() => quickResolve(decision)} onHandOver={() => handOver(decision)}
    onLater={() => { deferDecision(decision.id); if (open === decision.id) setOpen(null); }}
    onNow={() => undeferDecision(decision.id)}
    onResolved={outcome => { setOpen(null); setAck(`${decisionHeading(decision, state)} · ${resolvedText(decision.kind, outcome)}`); }}
    navigate={navigate}/>;

  return <Page className="grid content-start gap-10">
    <PageHeader title={uiTerms.inbox} className="mb-0" actions={quick.length > 0 && !batch
      ? <Button size="sm" onClick={() => setBatch(new Set(quick.map(decision => decision.id)))}>추천대로 처리 {quick.length}</Button> : undefined}/>
    {error && <InlineError>{error}</InlineError>}
    {/* Not a failure: the link pointed at a decision someone already settled. */}
    {focusedSettled && <Banner variant="info">이미 처리된 결정입니다.</Banner>}

    {batch && <section className="queue-batch" aria-labelledby="queue-batch-title">
      <h2 id="queue-batch-title" className="section-title">추천대로 처리</h2>
      <p className="queue-batch__note">되돌릴 수 있는 결정만 모였습니다. 보내기 · 결제 · 삭제는 여기 들어오지 않습니다.</p>
      <ul className="queue-batch__list">{quick.map(decision => <li key={decision.id}>
        <Checkbox checked={batch.has(decision.id)} disabled={batchBusy} aria-label={decisionHeading(decision, state)}
          onCheckedChange={checked => setBatch(current => { const next = new Set(current); if (checked) next.add(decision.id); else next.delete(decision.id); return next; })}/>
        <span className="queue-batch__title">{decisionHeading(decision, state)}</span>
        <span className="queue-batch__answer">{recommendedLabel(decision)}</span>
      </li>)}</ul>
      <div className="queue-batch__actions">
        <Button variant="ghost" disabled={batchBusy} onClick={() => setBatch(null)}>취소</Button>
        <Button disabled={batchBusy || batch.size === 0} onClick={() => void runBatch()}>{batchBusy ? '처리 중…' : `${batch.size}건 처리`}</Button>
      </div>
    </section>}

    <section className="grid gap-2" aria-labelledby="queue-now">
      <h2 id="queue-now" className="section-title">확인 필요{waiting.length > 0 && <span className="count">{waiting.length}</span>}</h2>
      {upNow.length > 0
        ? <ul className="queue">{upNow.map(decision => row(decision, 'now'))}</ul>
        : <div className="calm"><CheckCheck aria-hidden="true"/><p>{deferred.length ? '지금 볼 항목 없음 · 미뤄 둔 것만 남았습니다' : '확인이 필요한 항목 없음'}</p></div>}
      <p className="deck__ack" role="status" aria-live="polite">{ack}</p>
    </section>

    {deferred.length > 0 && <section className="grid gap-2" aria-labelledby="queue-later">
      <h2 id="queue-later" className="section-title">나중에<span className="count">{deferred.length}</span></h2>
      <ul className="queue" data-quiet>{deferred.map(decision => row(decision, 'later'))}</ul>
    </section>}

    {withMain.length > 0 && <section className="grid gap-2" aria-labelledby="queue-main">
      <h2 id="queue-main" className="section-title">메인 Ghost가 판단 중<span className="count">{withMain.length}</span></h2>
      <ul className="feed" data-quiet>{withMain.map(decision => <li key={decision.id}>
        <div className="feed__row" data-inbox-kind="handed-over">
          <span className="feed__mark"><DotAvatar profileId={decision.ghostId} tone={toneFor(decision.ghostId)} size={18}/></span>
          <span className="feed__copy"><span className="feed__title">{decisionHeading(decision, state)}</span>
            <span className="feed__body">{ghostName(decision.ghostId)} · {decisionChip(decision)} · 정하지 못하면 여기로 돌아옵니다</span></span>
        </div>
      </li>)}</ul>
    </section>}

    {notifications.length > 0 && <details className="queue-fold" open={unread.length > 0}>
      <summary><span className="section-title">소식{unread.length > 0 && <span className="count">새 소식 {unread.length}</span>}</span><ChevronDown aria-hidden="true"/></summary>
      {unread.length > 0 && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => markRead(unreadAll.map(item => item.id))}>모두 읽음 표시</Button>}
      <ul className="feed">{shownNotifications.map(item => {
        const navigable = Boolean(item.workId || item.decisionId || item.conversationId);
        return <NotificationRow key={item.id} item={item} ghostName={ghostName(item.ghostId)} now={now}
          disabled={!navigable && Boolean(item.readAt)} onOpen={() => navigable ? openNotification(item) : markRead([item.id])}/>;
      })}</ul>
      {moreNotifications > 0 && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setNotificationLimit(limit => limit + NOTIFICATION_PAGE)}>
        {Math.min(moreNotifications, NOTIFICATION_PAGE)}건 더 보기</Button>}
    </details>}

    {settled.length > 0 && <details className="queue-fold">
      <summary><span className="section-title">처리한 결정<span className="count">{settled.length}</span></span><ChevronDown aria-hidden="true"/></summary>
      <ul className="feed" data-quiet>{shownSettled.map(decision => {
        const by = reviewOf(decision.proposal)?.resolvedBy;
        return <li key={decision.id}>
          <button type="button" className="feed__row" data-inbox-kind="settled" disabled={!decision.workId} onClick={() => decision.workId && navigate(`/work/${encodeURIComponent(decision.workId)}`)}>
            <span className="feed__mark"><DotAvatar profileId={decision.ghostId} tone={toneFor(decision.ghostId)} size={18}/></span>
            <span className="feed__copy"><span className="feed__title">{decisionHeading(decision, state)}</span>{decision.answer && <span className="feed__body">{decision.answer}</span>}</span>
            <span className="feed__meta"><span data-state={decision.state}>{by === 'main' ? `메인이 ${settledLabel[decision.state]}` : by === 'timeout' ? `자동 ${settledLabel[decision.state]}` : settledLabel[decision.state]}</span>
              <time className="tabular">{relativeTime(decision.resolvedAt ?? decision.createdAt, now)}</time></span>
          </button>
        </li>;
      })}</ul>
      {settled.length > SETTLED_PREVIEW && <Button variant="ghost" size="sm" className="justify-self-start" aria-expanded={allSettled} onClick={() => setAllSettled(value => !value)}>
        {allSettled ? '접기' : `${settled.length - SETTLED_PREVIEW}건 더 보기`}</Button>}
    </details>}
  </Page>;
}

/** How far a finger drags a folded row left before letting go puts it off, and how far the row follows. */
const SWIPE_AT = 72;
const SWIPE_MAX = 112;

/**
 * 결정 한 줄: 무엇을 · 누가 · 추천, 그리고 빠른 처리. 줄을 누르면 전체 카드가 그 자리에 펼쳐진다.
 * 2026.11.12 : 접힌 줄에도 마감이 보이고, 손가락으로 왼쪽으로 밀거나 L 을 누르면 「나중에」로 간다 (버튼과 함께).
 * 나중에는 숨김이 아니다 — 아래 「나중에」에 남고, 배지 수도 그대로다.
 */
function QueueRow({ decision, state, now, ghostName, open, place, onToggle, onRecommended, onHandOver, onLater, onNow, onResolved, navigate }: {
  decision: Decision; state: State; now: number; ghostName: string; open: boolean; place: 'now' | 'later';
  onToggle(): void; onRecommended(): void; onHandOver(): void; onLater(): void; onNow(): void;
  onResolved(outcome: 'approve' | 'deny' | 'answer'): void; navigate(path: string): void;
}) {
  const heading = decisionHeading(decision, state);
  const recommended = recommendedLabel(decision);
  const note = reviewOf(decision.proposal)?.mainNote;
  const deadline = deadlineText(decision, now);
  const workTitle = decision.workId ? state.works.find(work => work.id === decision.workId)?.title : undefined;
  const panel = `queue-card-${decision.id}`;
  const canPutOff = place === 'now' && !open;
  const [shift, setShift] = useState(0);
  const drag = useRef<{ pointer: number; x: number; y: number; dx: number; horizontal: boolean } | null>(null);
  const swiped = useRef(false);

  // A touch drag that starts sideways moves the row; one that starts up or down is left to the page's scroll (touch-action: pan-y).
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    swiped.current = false;
    if (!canPutOff || event.pointerType === 'mouse' || !event.isPrimary) return;
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, horizontal: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.horizontal) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { drag.current = null; return; }
      if (dx > -10 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      current.horizontal = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    current.dx = Math.max(-SWIPE_MAX, Math.min(0, dx));
    setShift(current.dx);
  };
  const endDrag = (commit: boolean) => {
    const current = drag.current;
    drag.current = null;
    if (!current?.horizontal) return;
    // The press that ends a swipe is not a tap on the row or its buttons.
    swiped.current = true;
    setShift(0);
    if (commit && current.dx <= -SWIPE_AT) onLater();
  };
  // L puts a folded row off, like the deck; focus moves to the row that takes its place.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canPutOff || event.code !== 'KeyL' || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const item = event.currentTarget.closest('li');
    (item?.nextElementSibling ?? item?.previousElementSibling)?.querySelector<HTMLElement>('.queue__main')?.focus();
    onLater();
  };

  return <li className="queue__item" data-open={open || undefined}>
    {shift < 0 && <span className="queue__swipe" data-ready={shift <= -SWIPE_AT || undefined} aria-hidden="true">나중에</span>}
    <div className="queue__row" data-swipe={canPutOff || undefined} data-swiping={shift < 0 || undefined}
      style={shift < 0 ? { transform: `translateX(${shift}px)` } : undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => endDrag(true)} onPointerCancel={() => endDrag(false)}
      onClickCapture={event => { if (swiped.current) { swiped.current = false; event.preventDefault(); event.stopPropagation(); } }}
      onKeyDown={onKeyDown}>
      <button type="button" className="queue__main" aria-expanded={open} aria-controls={panel} aria-keyshortcuts={canPutOff ? 'L' : undefined} onClick={onToggle}>
        <DotAvatar profileId={decision.ghostId} tone={toneFor(decision.ghostId)} size={20}/>
        <span className="queue__copy">
          <span className="queue__title">{heading}</span>
          <span className="queue__meta">{ghostName} · {decisionChip(decision)} · <time className="tabular">{relativeTime(decision.createdAt, now)}</time>
            {deadline && <Badge variant="warning" className="queue__deadline" title={autoSettleText(decision, now) ?? undefined}>{deadline}</Badge>}</span>
          {note && !open && <span className="queue__note">메인: {note}</span>}
        </span>
      </button>
      {!open && <div className="queue__actions">
        {recommended && <Button size="sm" variant="secondary" title="추천대로 처리" onClick={onRecommended}>{recommended}</Button>}
        {canHandOver(decision, state) && <Button size="sm" variant="ghost" title="메인 Ghost가 대신 정합니다" onClick={onHandOver}>메인에게</Button>}
        {place === 'now'
          ? <Button size="sm" variant="ghost" title="나중에 (L)" aria-keyshortcuts="L" onClick={onLater}>나중에</Button>
          : <Button size="sm" variant="ghost" onClick={onNow}><Undo2 size={14} aria-hidden="true"/>지금 보기</Button>}
      </div>}
    </div>
    {open && <div id={panel} className="queue__card">
      <DecisionCard decision={decision} ghostName={ghostName} workTitle={workTitle} autoFocus
        onOpenWork={id => navigate(`/work/${encodeURIComponent(id)}`)} onResolved={onResolved}/>
    </div>}
  </li>;
}
