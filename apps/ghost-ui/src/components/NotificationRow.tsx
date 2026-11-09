import type { Notification } from '@ghost/contract';
import { MessageCircle } from 'lucide-react';
import { StateGlyph } from './agent';
import { DotAvatar } from './DotAvatar';
import { toneFor } from '../features/ghostState';
import { relativeTime } from '../features/time';

/** One news item, with conversation identity carried by the Ghost rather than repeated metadata. */
export function NotificationRow({ item, ghostName, now, disabled, onOpen }: {
  item: Notification; ghostName: string; now: number; disabled?: boolean; onOpen(): void;
}) {
  const message = item.kind === 'message';
  return <li data-unread={!item.readAt || undefined}>
    <button type="button" className="feed__row" disabled={disabled} onClick={onOpen} data-inbox-kind="notification">
      <span className="feed__mark">{message && item.ghostId ? <DotAvatar profileId={item.ghostId} tone={toneFor(item.ghostId)} size={22}/>
        : item.kind === 'work_done' ? <StateGlyph state="done"/> : item.kind === 'work_failed' ? <StateGlyph state="failed"/>
        : item.kind === 'decision' ? <StateGlyph state="attention"/> : <MessageCircle size={15} aria-hidden="true"/>}</span>
      <span className="feed__copy"><span className="feed__title">{message ? ghostName : item.title}</span>
        {item.body && <span className="feed__body">{item.body}</span>}
      </span>
      <span className="feed__meta">{!message && item.ghostId && <span>{ghostName}</span>}<time className="tabular">{relativeTime(item.createdAt, now)}</time></span>
      {!item.readAt && <span className="feed__dot"><span className="sr-only">읽지 않음</span></span>}
    </button>
  </li>;
}
