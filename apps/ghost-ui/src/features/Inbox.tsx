import { useState } from 'react';
import { CheckCheck, MessageCircle } from 'lucide-react';
import { Banner, Button, Page, PageHeader, InlineError } from '../ui'
import type { Decision, Notification, State } from '@ghost/contract';
import { StateGlyph } from '../components/agent';
import { DotAvatar } from '../components/DotAvatar';
import { useHost } from '../host/context';
import { uiTerms } from '../uiText';
import { DecisionDeck } from './Decision';
import { decisionHeading } from './decisionText';
import { toneFor } from './ghostState';
import { relativeTime, useNow } from './time';

const SETTLED_PREVIEW = 8;
const NOTIFICATION_PAGE = 20;

const settledLabel: Record<Decision['state'], string> = { pending: '', approved: '승인됨', denied: '거부됨', answered: '답변됨', cancelled: '취소됨' };

/** 확인할 일: the decision stack first, then what the host reported, then what was already decided. */
export function InboxView({ state, navigate, focusDecisionId }: {
  state: State;
  navigate(path: string): void;
  /** ?decision= brings that decision to the top of the stack. */
  focusDecisionId: string | null;
}) {
  const { client } = useHost();
  const now = useNow();
  const [error, setError] = useState('');
  const [allSettled, setAllSettled] = useState(false);
  const [notificationLimit, setNotificationLimit] = useState(NOTIFICATION_PAGE);
  const ghostName = (id: string | null) => state.ghosts.find(ghost => ghost.id === id)?.name ?? 'Ghost';
  const pending = state.decisions.filter(decision => decision.state === 'pending');
  const settled = state.decisions.filter(decision => decision.state !== 'pending')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt));
  const shownSettled = allSettled ? settled : settled.slice(0, SETTLED_PREVIEW);
  const notifications = [...state.notifications].sort((a, b) => b.createdAt - a.createdAt);
  const unread = notifications.filter(item => !item.readAt);
  const shownNotifications = notifications.slice(0, notificationLimit);
  const moreNotifications = notifications.length - shownNotifications.length;
  const focusedSettled = focusDecisionId ? state.decisions.find(decision => decision.id === focusDecisionId && decision.state !== 'pending') : undefined;
  const markRead = (ids: string[]) => { setError(''); void client.send({ type: 'notification.read', notificationIds: ids }).catch(e => setError(e instanceof Error ? e.message : '읽음 표시를 저장하지 못했습니다.')); };
  const open = (item: Notification) => {
    if (!item.readAt) markRead([item.id]);
    if (item.decisionId && pending.some(decision => decision.id === item.decisionId)) return navigate(`/inbox?decision=${encodeURIComponent(item.decisionId)}`);
    if (item.workId) return navigate(`/work/${encodeURIComponent(item.workId)}`);
    const conversation = item.conversationId ? state.conversations.find(entry => entry.id === item.conversationId) : undefined;
    if (conversation) navigate(`/ghosts/${encodeURIComponent(conversation.ghostId)}?conversation=${encodeURIComponent(conversation.id)}`);
  };
  return <Page className="grid content-start gap-12">
    <PageHeader title={uiTerms.inbox} className="mb-0"/>
    {error && <InlineError>{error}</InlineError>}
    {/* Not a failure: the link pointed at a decision someone already settled. */}
    {focusedSettled && <Banner variant="info">이미 처리된 결정입니다.</Banner>}
    {/* Mounted even when empty, so the deck can acknowledge the last resolution. */}
    <DecisionDeck key={focusDecisionId ?? 'deck'} state={state} navigate={navigate} focusId={focusDecisionId} overview/>
    {pending.length === 0 && <div className="calm"><CheckCheck aria-hidden="true"/><p>확인이 필요한 항목 없음</p></div>}

    {notifications.length > 0 && <section className="grid gap-2" aria-labelledby="inbox-notifications">
      <header className="flex items-center justify-between gap-2">
        <h2 id="inbox-notifications" className="section-title">소식{unread.length > 0 && <span className="count">새 소식 {unread.length}</span>}</h2>
        {unread.length > 0 && <Button variant="ghost" size="sm" onClick={() => markRead(unread.map(item => item.id))}>모두 읽음 표시</Button>}
      </header>
      <ul className="feed">{shownNotifications.map(item => {
        const navigable = Boolean(item.workId || item.decisionId || item.conversationId);
        return <li key={item.id} data-unread={!item.readAt || undefined}>
          <button type="button" className="feed__row" disabled={!navigable && Boolean(item.readAt)} onClick={() => navigable ? open(item) : markRead([item.id])} data-inbox-kind="notification">
            <span className="feed__mark">{item.kind === 'work_done' ? <StateGlyph state="done"/> : item.kind === 'work_failed' ? <StateGlyph state="failed"/>
              : item.kind === 'decision' ? <StateGlyph state="attention"/> : <MessageCircle size={15} aria-hidden="true"/>}</span>
            <span className="feed__copy">
              <span className="feed__title">{item.title}</span>
              {item.body && <span className="feed__body">{item.body}</span>}
            </span>
            <span className="feed__meta">{item.ghostId && <span>{ghostName(item.ghostId)}</span>}<time className="tabular">{relativeTime(item.createdAt, now)}</time></span>
            {!item.readAt && <span className="feed__dot"><span className="sr-only">읽지 않음</span></span>}
          </button>
        </li>;
      })}</ul>
      {moreNotifications > 0 && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setNotificationLimit(limit => limit + NOTIFICATION_PAGE)}>
        {Math.min(moreNotifications, NOTIFICATION_PAGE)}건 더 보기</Button>}
    </section>}

    {settled.length > 0 && <section className="grid gap-2" aria-labelledby="inbox-settled">
      <h2 id="inbox-settled" className="section-title">처리한 결정</h2>
      <ul className="feed" data-quiet>{shownSettled.map(decision => <li key={decision.id}>
        <button type="button" className="feed__row" data-inbox-kind="settled" disabled={!decision.workId} onClick={() => decision.workId && navigate(`/work/${encodeURIComponent(decision.workId)}`)}>
          <span className="feed__mark"><DotAvatar profileId={decision.ghostId} tone={toneFor(decision.ghostId)} size={18}/></span>
          <span className="feed__copy"><span className="feed__title">{decisionHeading(decision, state)}</span>{decision.answer && <span className="feed__body">{decision.answer}</span>}</span>
          <span className="feed__meta"><span data-state={decision.state}>{settledLabel[decision.state]}</span><time className="tabular">{relativeTime(decision.resolvedAt ?? decision.createdAt, now)}</time></span>
        </button>
      </li>)}</ul>
      {settled.length > SETTLED_PREVIEW && <Button variant="ghost" size="sm" className="justify-self-start" aria-expanded={allSettled} onClick={() => setAllSettled(value => !value)}>
        {allSettled ? '접기' : `${settled.length - SETTLED_PREVIEW}건 더 보기`}</Button>}
    </section>}
  </Page>;
}
