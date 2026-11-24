import type { Notification, State } from '@ghost/contract';
import { embeddedSessionPath } from './CodingSessionModel';

/** Inbox and native notification taps share the same precedence, including settled decisions. */
export function notificationRoute(item: Notification, state: State): string | null {
  const terminal = /^coding:terminal:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):\d+$/i.exec(item.id);
  if (terminal) return `/coding?terminal=${terminal[1]}`;
  const session = /^session:(coding-[^:]+):turn:\d+:waiting$/.exec(item.id);
  if (session) return embeddedSessionPath(session[1]!);
  if (item.decisionId && state.decisions.some(decision => decision.id === item.decisionId && decision.state === 'pending')) return `/inbox?decision=${encodeURIComponent(item.decisionId)}`;
  if (item.workId) return `/work/${encodeURIComponent(item.workId)}`;
  const conversation = state.conversations.find(entry => entry.id === item.conversationId);
  return conversation ? `/ghosts/${encodeURIComponent(conversation.ghostId)}?conversation=${encodeURIComponent(conversation.id)}` : null;
}
