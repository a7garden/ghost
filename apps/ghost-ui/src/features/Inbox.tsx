import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { ChevronLeft, MessageCircle, Undo2 } from 'lucide-react';
import { Banner, Button, Checkbox, InlineError, Page, PageHeader } from '../ui';
import type { Decision, Notification, State } from '@ghost/contract';
import { reviewOf } from '@ghost/contract';
import { glyphLabel, PresenceAvatar, StateGlyph, type GlyphState } from '../components/agent';
import { useHost } from '../host/context';
import { uiTerms } from '../uiText';
import { DecisionCard, autoSettleText, deadlineText, resolvedText } from './Decision';
import { decisionChip, decisionHeading, decisionTone } from './decisionText';
import { canHandOver, deferDecision, handedOver, ownerOrder, pruneLater, recommendedLabel, recommendedResolution, undeferDecision, useLater } from './decisionQueue';
import { pendingDecisions } from './ghostState';
import { relativeTime, useNow } from './time';
import { notificationRoute } from './notificationRoute';
import { decisionScopeId } from './scopeState';
import './Inbox.css';

const SETTLED_PREVIEW = 8;
const NOTIFICATION_PAGE = 20;

const settledLabel: Record<Decision['state'], string> = { pending: '', approved: '승인됨', denied: '거부됨', answered: '답변됨', cancelled: '취소됨' };

const wideQuery = '(min-width: 56rem)';
function subscribeWide(notify: () => void) {
  const media = matchMedia(wideQuery);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}

const decisionPath = (id: string) => `/inbox?decision=${encodeURIComponent(id)}`;

type InboxHistory = {
  inboxQueue?: { scroll: number; row: string };
  inboxFromQueue?: boolean;
};

function isLaterKey(event: KeyboardEvent<HTMLElement>) {
  return !event.defaultPrevented && event.code === 'KeyL' && !event.repeat && !event.nativeEvent.isComposing
    && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    && !(event.target as Element).closest('input, textarea, select, [contenteditable]');
}

export function InboxView({ state, navigate, focusDecisionId }: {
  state: State;
  navigate(path: string, options?: { replace?: boolean }): void;
  /** The decision shown in the evidence pane (wide) or on its own screen. */
  focusDecisionId: string | null;
}) {
  const { client } = useHost();
  const wide = useSyncExternalStore(subscribeWide, () => matchMedia(wideQuery).matches, () => false);
  const now = useNow();
  const later = useLater();
  const [error, setError] = useState('');
  const [ack, setAck] = useState('');
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const [batch, setBatch] = useState<Set<string> | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [allSettled, setAllSettled] = useState(false);
  const [notificationLimit, setNotificationLimit] = useState(NOTIFICATION_PAGE);
  const queueHeading = useRef<HTMLHeadingElement>(null);

  const ghostName = (id: string | null) => state.ghosts.find(ghost => ghost.id === id)?.name ?? 'Ghost';
  const projectName = (id: string | null) => id === null ? null : state.scopes.find(scope => scope.id === id)?.name ?? '삭제된 프로젝트';
  const decisionProject = (decision: Decision) => projectName(decisionScopeId(decision, state));
  const pending = pendingDecisions(state);
  const ordered = ownerOrder(handled.size ? pending.filter(decision => !handled.has(decision.id)) : pending, later);
  const upNow = ordered.filter(decision => later[decision.id] === undefined);
  const deferred = ordered.filter(decision => later[decision.id] !== undefined);
  const withMain = state.decisions.filter(handedOver).sort((a, b) => a.createdAt - b.createdAt);
  const quick = ordered.filter(decision => recommendedResolution(decision));
  const selected = ordered.find(decision => decision.id === focusDecisionId) ?? (wide ? upNow[0] : undefined);
  const detailScreen = !wide && focusDecisionId !== null;
  const focused = state.decisions.find(decision => decision.id === focusDecisionId);
  const unavailable = !focused ? null : focused.state !== 'pending' ? '이미 처리된 결정입니다.'
    : handedOver(focused) ? '메인에게 맡긴 결정입니다.' : null;

  const settled = state.decisions.filter(decision => decision.state !== 'pending')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt));
  const recentSettled = ordered.length === 0 ? settled[0] : undefined;
  const historyRows = recentSettled ? settled.slice(1) : settled;
  const shownSettled = allSettled ? historyRows : historyRows.slice(0, SETTLED_PREVIEW);
  // Pending decisions already have a place above; marking news read includes those hidden duplicates.
  const pendingIds = new Set(state.decisions.filter(decision => decision.state === 'pending').map(decision => decision.id));
  const notifications = state.notifications.filter(item => !item.decisionId || !pendingIds.has(item.decisionId))
    .sort((a, b) => b.createdAt - a.createdAt);
  const unread = notifications.some(item => item.readAt === null);
  const shownNotifications = notifications.slice(0, notificationLimit);
  const moreNotifications = notifications.length - shownNotifications.length;

  useEffect(() => { pruneLater(state.decisions.filter(decision => decision.state === 'pending').map(decision => decision.id)); }, [state.decisions]);
  // A command can succeed before its event reaches this screen. Keep its row out only until the projection catches up.
  useEffect(() => {
    if (!handled.size) return;
    const awaiting = new Set(pendingDecisions(state).filter(decision => handled.has(decision.id)).map(decision => decision.id));
    if (awaiting.size !== handled.size) setHandled(awaiting);
  }, [handled, state]);
  useEffect(() => {
    if (!ack) return;
    const timer = setTimeout(() => setAck(''), 2400);
    return () => clearTimeout(timer);
  }, [ack]);

  const firstId = upNow[0]?.id;
  useEffect(() => {
    if (wide && !focusDecisionId && firstId) navigate(decisionPath(firstId), { replace: true });
  }, [wide, focusDecisionId, firstId, navigate]);

  // The shell resets its own scroller on navigation. Save the queue's position on its history entry.
  useLayoutEffect(() => {
    if (wide) return;
    const main = document.getElementById('main-content');
    if (focusDecisionId !== null) {
      if (main) main.scrollTop = 0;
      return;
    }
    const saved = (history.state as InboxHistory | null)?.inboxQueue;
    if (!saved) return;
    if (main) main.scrollTop = saved.scroll;
    (document.getElementById(`inbox-row-${saved.row}`) ?? queueHeading.current)?.focus({ preventScroll: true });
  }, [wide, focusDecisionId]);

  const leaveDetail = () => {
    if ((history.state as InboxHistory | null)?.inboxFromQueue) history.back();
    else navigate('/inbox', { replace: true });
  };
  const selectWide = (id: string | null) => {
    const main = document.getElementById('main-content');
    const scroll = main?.scrollTop ?? 0;
    navigate(id ? decisionPath(id) : '/inbox', { replace: true });
    if (main) main.scrollTop = scroll;
  };
  const openDecision = (id: string) => {
    if (wide) {
      if (focusDecisionId === id) document.querySelector<HTMLElement>('.inbox__evidence .decision')?.focus({ preventScroll: true });
      else selectWide(id);
      return;
    }
    const scroll = document.getElementById('main-content')?.scrollTop ?? 0;
    history.replaceState({ ...history.state, inboxQueue: { scroll, row: id } }, '');
    navigate(decisionPath(id));
    history.replaceState({ ...history.state, inboxFromQueue: true }, '');
  };

  const advance = (removed: ReadonlySet<string>) => {
    if (!selected || !removed.has(selected.id)) return;
    // A slow reply must not navigate back to Inbox or over a newer selection.
    const [path, search] = location.hash.slice(1).split('?');
    if (path !== '/inbox' || new URLSearchParams(search).get('decision') !== focusDecisionId) return;
    if (!wide) { leaveDetail(); return; }
    const at = ordered.indexOf(selected);
    const next = ordered.slice(at + 1).find(decision => later[decision.id] === undefined && !removed.has(decision.id))
      ?? upNow.find(decision => !removed.has(decision.id));
    selectWide(next?.id ?? null);
  };
  const complete = (ids: string[], message: string) => {
    setAck(message);
    if (ids.length === 0) return;
    const removed = new Set(ids);
    setHandled(current => new Set([...current, ...removed]));
    advance(removed);
  };
  const putOff = (decision: Decision) => {
    deferDecision(decision.id);
    advance(new Set([decision.id]));
  };

  const fail = (fallback: string) => (e: unknown) => setError(e instanceof Error ? e.message : fallback);
  const markRead = (ids: string[]) => { setError(''); void client.send({ type: 'notification.read', notificationIds: ids }).catch(fail('읽음 표시를 저장하지 못했습니다.')); };
  const openNotification = (item: Notification) => {
    if (item.readAt === null) markRead([item.id]);
    const destination = notificationRoute(item, state);
    if (destination) navigate(destination);
  };
  const resolveRecommended = async (decision: Decision) => {
    const resolution = recommendedResolution(decision);
    if (!resolution) return;
    await client.send({ type: 'decision.resolve', decisionId: decision.id, ...resolution });
    undeferDecision(decision.id);
    return resolution.outcome;
  };
  const quickResolve = (decision: Decision) => {
    setError('');
    void resolveRecommended(decision).then(outcome => {
      if (outcome) complete([decision.id], `${resolvedText(decision.kind, outcome)} · ${decisionHeading(decision, state)}`);
    })
      .catch(fail('결정을 전달하지 못했습니다. 다시 시도해 주세요.'));
  };
  const handOver = (decision: Decision) => {
    setError('');
    void client.send({ type: 'decision.delegate', decisionId: decision.id })
      .then(() => {
        undeferDecision(decision.id);
        complete([decision.id], `메인 Ghost에게 맡겼습니다 · ${decisionHeading(decision, state)}`);
      })
      .catch(fail('메인 Ghost에게 맡기지 못했습니다.'));
  };
  const runBatch = async () => {
    if (!batch) return;
    setBatchBusy(true); setError('');
    const chosen = quick.filter(decision => batch.has(decision.id));
    const done: string[] = [];
    const failed: string[] = [];
    // 하나씩 보낸다 — 한 건이 실패해도 나머지는 처리되고, 실패한 것은 목록에 그대로 남는다.
    for (const decision of chosen) {
      try {
        if (await resolveRecommended(decision)) done.push(decision.id);
      } catch { failed.push(decisionHeading(decision, state)); }
    }
    setBatchBusy(false); setBatch(null);
    complete(done, `추천대로 ${done.length}건 처리했습니다`);
    if (failed.length) setError(`처리하지 못한 결정: ${failed.join(', ')}`);
  };

  const row = (decision: Decision, place: 'now' | 'later') => <QueueRow key={decision.id} decision={decision} state={state} now={now}
    ghostName={ghostName(decision.ghostId)} project={decisionProject(decision)} selected={selected?.id === decision.id} place={place}
    onOpen={() => openDecision(decision.id)} onRecommended={() => quickResolve(decision)} onHandOver={() => handOver(decision)}
    onLater={() => putOff(decision)} onNow={() => undeferDecision(decision.id)}/>;

  const settledRow = (decision: Decision) => {
    const by = reviewOf(decision.proposal)?.resolvedBy;
    const result = settledLabel[decision.state];
    const glyph = decision.state === 'denied' ? 'failed' : decision.state === 'cancelled' ? 'cancelled' : 'done';
    return <LedgerRow key={decision.id} kind="settled" head={decisionHeading(decision, state)}
      mark={<StateGlyph state={glyph} accessibleLabel={result}/>}
      meta={[ghostName(decision.ghostId), decisionProject(decision), by === 'main' ? `메인이 ${result}` : by === 'timeout' ? `자동 ${result}` : result]}
      preview={decision.answer} time={relativeTime(decision.resolvedAt ?? decision.createdAt, now)}
      onOpen={decision.workId ? () => navigate(`/work/${encodeURIComponent(decision.workId!)}`) : undefined}/>;
  };

  const selectedCanDefer = selected !== undefined && later[selected.id] === undefined;
  const deferFromEvidence = (event: KeyboardEvent<HTMLElement>) => {
    if (!selectedCanDefer || !isLaterKey(event)) return;
    event.preventDefault();
    putOff(selected);
  };
  const evidence = selected && <div key={selected.id} id={`queue-card-${selected.id}`} className="queue__card">
    <DecisionCard decision={selected} ghostName={ghostName(selected.ghostId)}
      workTitle={state.works.find(work => work.id === selected.workId)?.title} autoFocus
      onOpenWork={id => navigate(`/work/${encodeURIComponent(id)}`)}
      onResolved={outcome => complete([selected.id], `${resolvedText(selected.kind, outcome)} · ${decisionHeading(selected, state)}`)}/>
  </div>;

  if (detailScreen) return <Page className="inbox inbox--detail" width="reading" onKeyDown={deferFromEvidence}>
    <div className="inbox__detail-nav">
      <Button variant="ghost" size="sm" aria-label="확인할 일 목록으로" onClick={leaveDetail}><ChevronLeft aria-hidden="true"/>목록</Button>
      {selectedCanDefer && <Button variant="ghost" size="sm" aria-keyshortcuts="L" title="나중에 (L)" onClick={() => putOff(selected)}>나중에</Button>}
    </div>
    {error && <InlineError>{error}</InlineError>}
    {evidence
      ? <div className="inbox__evidence">{evidence}</div>
      : <Banner variant="info">{unavailable ?? '이 결정을 확인할 수 없습니다.'}</Banner>}
  </Page>;

  const acknowledgement = <p className="inbox__ack" role="status" aria-live="polite" title={ack || undefined}>{ack}</p>;
  return <Page className="inbox">
    <PageHeader title={uiTerms.inbox}/>
    {error && <InlineError>{error}</InlineError>}
    {unavailable && <Banner variant="info">{unavailable}</Banner>}

    <div className="inbox__triage" data-split={wide && Boolean(selected || ack) || undefined}>
      <div className="inbox__queue">
        <section className="inbox__group" aria-labelledby="queue-now">
          <div className="inbox__group-head">
            <h2 id="queue-now" className="section-title" ref={queueHeading} tabIndex={-1}>확인 필요</h2>
            {quick.length > 0 && !batch && <Button size="sm" variant="outline"
              onClick={() => setBatch(new Set(quick.map(decision => decision.id)))}>추천대로 처리 {quick.length}</Button>}
          </div>
          {batch && <section className="queue-batch" aria-labelledby="queue-batch-title">
            <h3 id="queue-batch-title" className="section-title">추천대로 처리</h3>
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
          {upNow.length > 0 ? <ul className="inbox__rows inbox__rows--queue">{upNow.map(decision => row(decision, 'now'))}</ul>
            : <p className="inbox__empty">{deferred.length ? '미뤄 둔 결정만 남았습니다.' : '확인을 기다리는 결정이 없습니다.'}</p>}
          {recentSettled && <ul className="inbox__rows" aria-label="최근 처리한 결정">{settledRow(recentSettled)}</ul>}
        </section>
        {deferred.length > 0 && <section className="inbox__group" aria-labelledby="queue-later">
          <h2 id="queue-later" className="section-title">나중에</h2>
          <ul className="inbox__rows inbox__rows--queue">{deferred.map(decision => row(decision, 'later'))}</ul>
        </section>}
        {!wide && acknowledgement}
      </div>
      {wide && <div className="inbox__evidence" onKeyDown={deferFromEvidence}>
        {acknowledgement}
        {evidence}
      </div>}
    </div>

    {withMain.length > 0 && <section className="inbox__group" aria-labelledby="queue-main">
      <h2 id="queue-main" className="section-title">맡은 중</h2>
      <ul className="inbox__rows">{withMain.map(decision => <LedgerRow key={decision.id} kind="handed-over"
        mark={<StateGlyph state="waiting" accessibleLabel="메인 판단 중"/>} head={decisionHeading(decision, state)}
        meta={[ghostName(decision.ghostId), decisionProject(decision), decisionChip(decision)]}
        time={relativeTime(reviewOf(decision.proposal)?.delegatedAt ?? decision.createdAt, now)}/>)}</ul>
    </section>}

    {notifications.length > 0 && <section className="inbox__group" aria-labelledby="inbox-news">
      <div className="inbox__group-head">
        <h2 id="inbox-news" className="section-title">소식</h2>
        {unread && <Button variant="ghost" size="sm" onClick={() => markRead(state.notifications.filter(item => item.readAt === null).map(item => item.id))}>모두 읽음</Button>}
      </div>
      <ul className="inbox__rows">{shownNotifications.map(item => {
        const message = item.kind === 'message';
        const ghost = item.ghostId ? ghostName(item.ghostId) : null;
        const linked = item.decisionId ? state.decisions.find(decision => decision.id === item.decisionId) : undefined;
        const scope = item.workId ? state.works.find(work => work.id === item.workId)?.scopeId ?? null : linked ? decisionScopeId(linked, state) : null;
        const glyph: GlyphState | null = item.kind === 'work_done' ? 'done' : item.kind === 'work_failed' ? 'failed' : item.kind === 'decision' ? 'attention' : null;
        const isUnread = item.readAt === null;
        return <LedgerRow key={item.id} kind="notification" unread={isUnread}
          mark={glyph ? <StateGlyph state={glyph}/> : item.ghostId ? <PresenceAvatar ghostId={item.ghostId} state="idle" size={22}/> : <MessageCircle size={15} aria-hidden="true"/>}
          head={message && ghost ? ghost : item.title} meta={[message ? null : ghost, projectName(scope), glyph ? glyphLabel[glyph] : null]}
          preview={item.body} time={relativeTime(item.createdAt, now)}
          onOpen={isUnread || notificationRoute(item, state) ? () => openNotification(item) : undefined}/>;
      })}</ul>
      {moreNotifications > 0 && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setNotificationLimit(limit => limit + NOTIFICATION_PAGE)}>
        {Math.min(moreNotifications, NOTIFICATION_PAGE)}건 더 보기</Button>}
    </section>}

    {historyRows.length > 0 && <details className="inbox__history">
      <summary className="section-title">처리한 결정</summary>
      <ul className="inbox__rows">{shownSettled.map(settledRow)}</ul>
      {historyRows.length > SETTLED_PREVIEW && <Button variant="ghost" size="sm" aria-expanded={allSettled} onClick={() => setAllSettled(value => !value)}>
        {allSettled ? '접기' : `${historyRows.length - SETTLED_PREVIEW}건 더 보기`}</Button>}
    </details>}
  </Page>;
}

/** The same leading mark, title, metadata and trailing value across the secondary groups. */
function LedgerRow({ kind, mark, head, meta, preview, time, unread, onOpen }: {
  kind: 'settled' | 'handed-over' | 'notification'; mark: ReactNode; head: string; meta: (string | null)[];
  preview?: string | null; time: string; unread?: boolean; onOpen?: () => void;
}) {
  const metadata = meta.filter(Boolean).join(' · ');
  const content = <>
    <span className="inbox-row__mark">{mark}</span>
    <span className="inbox-row__copy">
      <span className="inbox-row__title">{head}</span>
      {metadata && <span className="inbox-row__meta">{metadata}</span>}
      {preview && <span className="inbox-row__preview feed__body">{preview}</span>}
    </span>
    <time className="inbox-row__value">{time}</time>
    {unread && <span className="inbox-row__unread"><span className="sr-only">읽지 않음</span></span>}
  </>;
  return <li data-unread={unread || undefined}>
    {kind === 'handed-over'
      ? <div className="inbox-row" data-inbox-kind={kind}>{content}</div>
      : <button type="button" className="inbox-row disabled:pointer-events-none" data-inbox-kind={kind} disabled={!onOpen} onClick={onOpen}>{content}</button>}
  </li>;
}

/** How far a finger drags left to put a decision off, and how far the row follows. */
const SWIPE_AT = 72;
const SWIPE_MAX = 112;

function QueueRow({ decision, state, now, ghostName, project, selected, place, onOpen, onRecommended, onHandOver, onLater, onNow }: {
  decision: Decision; state: State; now: number; ghostName: string; project: string | null; selected: boolean; place: 'now' | 'later';
  onOpen(): void; onRecommended(): void; onHandOver(): void; onLater(): void; onNow(): void;
}) {
  const recommended = recommendedLabel(decision);
  const note = reviewOf(decision.proposal)?.mainNote;
  const deadline = deadlineText(decision, now);
  const tone = decisionTone(decision);
  const canPutOff = place === 'now';
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
  // Move focus to the next row before the deferred row leaves this group.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canPutOff || !isLaterKey(event)) return;
    event.preventDefault();
    const item = event.currentTarget.closest('li');
    (item?.nextElementSibling ?? item?.previousElementSibling)?.querySelector<HTMLElement>('.inbox__pick')?.focus();
    onLater();
  };

  return <li className="inbox__item" data-selected={selected || undefined} data-tone={tone}>
    {shift < 0 && <span className="inbox__swipe" data-ready={shift <= -SWIPE_AT || undefined} aria-hidden="true">나중에</span>}
    <div className="inbox__row" data-swipe={canPutOff || undefined} data-swiping={shift < 0 || undefined}
      style={shift < 0 ? { transform: `translateX(${shift}px)` } : undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => endDrag(true)} onPointerCancel={() => endDrag(false)}
      onClickCapture={event => { if (swiped.current) { swiped.current = false; event.preventDefault(); event.stopPropagation(); } }}
      onKeyDown={onKeyDown}>
      <button id={`inbox-row-${decision.id}`} type="button" className="inbox-row inbox__pick" aria-expanded={selected}
        aria-current={selected || undefined} aria-controls={`queue-card-${decision.id}`} aria-keyshortcuts={canPutOff ? 'L' : undefined} onClick={onOpen}>
        <span className="inbox-row__mark"><PresenceAvatar ghostId={decision.ghostId} state={tone === 'urgent' ? 'attention' : 'idle'} size={22}/></span>
        <span className="inbox-row__copy">
          <span className="inbox-row__title">{decisionHeading(decision, state)}</span>
          <span className="inbox-row__meta">{[ghostName, project, decisionChip(decision)].filter(Boolean).join(' · ')}<time dateTime={new Date(decision.createdAt).toISOString()}> · {relativeTime(decision.createdAt, now)}</time></span>
          {note && <span className="inbox-row__preview">메인: {note}</span>}
        </span>
        {deadline && <span className="inbox-row__value inbox__deadline" title={autoSettleText(decision, now) ?? undefined}>{deadline}</span>}
      </button>
      <div className="inbox__actions">
        {recommended && <button type="button" className="inbox__recommended" title={`추천대로 처리: ${recommended}`} onClick={onRecommended}>{recommended}</button>}
        {canHandOver(decision, state) && <Button size="sm" variant="ghost" title="메인 Ghost가 대신 정합니다" onClick={onHandOver}>메인에게</Button>}
        {canPutOff
          ? <Button size="sm" variant="ghost" title="나중에 (L)" aria-keyshortcuts="L" onClick={onLater}>나중에</Button>
          : <Button size="sm" variant="ghost" onClick={onNow}><Undo2 aria-hidden="true"/>지금 보기</Button>}
      </div>
    </div>
  </li>;
}
