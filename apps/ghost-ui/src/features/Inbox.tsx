import { useState } from 'react';
import { CheckCheck } from 'lucide-react';
import { Button, Page, PageHeader, InlineError } from '../ui'
import type { Decision, Notification, State } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { NotificationRow } from '../components/NotificationRow';
import { useHost } from '../host/context';
import { uiTerms } from '../uiText';
import { DecisionDeck } from './Decision';
import { toneFor } from './ghostState';
import { relativeTime, useNow } from './time';
import { notificationRoute } from './notificationRoute';

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
  const ghostName = (id: string | null) => state.ghosts.find(ghost => ghost.id === id)?.name ?? 'Ghost';
  const pending = state.decisions.filter(decision => decision.state === 'pending');
  const settled = state.decisions.filter(decision => decision.state !== 'pending')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt)).slice(0, 8);
  const notifications = [...state.notifications].sort((a, b) => b.createdAt - a.createdAt);
  const unread = notifications.filter(item => !item.readAt);
  const focusedSettled = focusDecisionId ? state.decisions.find(decision => decision.id === focusDecisionId && decision.state !== 'pending') : undefined;
  const markRead = (ids: string[]) => { setError(''); void client.send({ type: 'notification.read', notificationIds: ids }).catch(e => setError(e instanceof Error ? e.message : '읽음 표시를 저장하지 못했습니다.')); };
  const open = (item: Notification) => {
    if (!item.readAt) markRead([item.id]);
    const destination = notificationRoute(item, state);
    if (destination) navigate(destination);
  };
  return <Page className="grid content-start gap-12">
    <PageHeader title={uiTerms.inbox} className="mb-0"/>
    {error && <InlineError>{error}</InlineError>}
    {focusedSettled && <InlineError>이미 처리된 결정입니다.</InlineError>}
    {pending.length > 0
      ? <DecisionDeck key={focusDecisionId ?? 'deck'} state={state} navigate={navigate} focusId={focusDecisionId} overview/>
      : <div className="calm"><CheckCheck aria-hidden="true"/><p>확인이 필요한 항목 없음</p></div>}

    {notifications.length > 0 && <section className="grid gap-2" aria-labelledby="inbox-notifications">
      <header className="flex items-center justify-between gap-2">
        <h2 id="inbox-notifications" className="section-title">소식{unread.length > 0 && <span className="count">새 소식 {unread.length}</span>}</h2>
        {unread.length > 0 && <Button variant="ghost" size="sm" onClick={() => markRead(unread.map(item => item.id))}>모두 읽음 표시</Button>}
      </header>
      <ul className="feed">{notifications.map(item => {
        const navigable = Boolean(item.workId || item.decisionId || item.conversationId);
        return <NotificationRow key={item.id} item={item} ghostName={ghostName(item.ghostId)} now={now}
          disabled={!navigable && Boolean(item.readAt)} onOpen={() => navigable ? open(item) : markRead([item.id])}/>;
      })}</ul>
    </section>}

    {settled.length > 0 && <section className="grid gap-2" aria-labelledby="inbox-settled">
      <h2 id="inbox-settled" className="section-title">처리한 결정</h2>
      <ul className="feed" data-quiet>{settled.map(decision => <li key={decision.id}>
        <button type="button" className="feed__row" data-inbox-kind="settled" disabled={!decision.workId} onClick={() => decision.workId && navigate(`/work/${encodeURIComponent(decision.workId)}`)}>
          <span className="feed__mark"><DotAvatar profileId={decision.ghostId} tone={toneFor(decision.ghostId)} size={18}/></span>
          <span className="feed__copy"><span className="feed__title">{decision.title}</span>{decision.answer && <span className="feed__body">{decision.answer}</span>}</span>
          <span className="feed__meta"><span data-state={decision.state}>{settledLabel[decision.state]}</span><time className="tabular">{relativeTime(decision.resolvedAt ?? decision.createdAt, now)}</time></span>
        </button>
      </li>)}</ul>
    </section>}
  </Page>;
}
