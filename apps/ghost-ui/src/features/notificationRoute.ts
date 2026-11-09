import type { Notification, State } from '@ghost/contract';

/** Inbox and native notification taps share the same precedence, including settled decisions. */
export function notificationRoute(item: Notification, state: State): string | null {
  if (item.decisionId && state.decisions.some(decision => decision.id === item.decisionId && decision.state === 'pending')) return `/inbox?decision=${encodeURIComponent(item.decisionId)}`;
  if (item.workId) return `/work/${encodeURIComponent(item.workId)}`;
  const conversation = state.conversations.find(entry => entry.id === item.conversationId);
  return conversation ? `/ghosts/${encodeURIComponent(conversation.ghostId)}?conversation=${encodeURIComponent(conversation.id)}` : null;
}
