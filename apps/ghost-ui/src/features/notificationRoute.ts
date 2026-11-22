import type { Notification, State } from '@ghost/contract';
import { herdrPanePath, parseHerdrPane } from './herdrDisplay';

/** Inbox and native notification taps share the same precedence, including settled decisions. */
export function notificationRoute(item: Notification, state: State, codingSession?: string | null): string | null {
  if (codingSession !== undefined) {
    const coding = /^coding:([A-Za-z0-9._-]+):([A-Za-z0-9]+:[A-Za-z0-9]+):(blocked|done):\d+$/.exec(item.id);
    if (coding) {
      const pane = parseHerdrPane(coding[2] ?? null);
      return pane && coding[1] === codingSession ? herdrPanePath(pane) : null;
    }
  }
  if (item.decisionId && state.decisions.some(decision => decision.id === item.decisionId && decision.state === 'pending')) return `/inbox?decision=${encodeURIComponent(item.decisionId)}`;
  if (item.workId) return `/work/${encodeURIComponent(item.workId)}`;
  const conversation = state.conversations.find(entry => entry.id === item.conversationId);
  return conversation ? `/ghosts/${encodeURIComponent(conversation.ghostId)}?conversation=${encodeURIComponent(conversation.id)}` : null;
}
