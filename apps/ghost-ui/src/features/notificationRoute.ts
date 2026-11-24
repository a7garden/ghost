import type { HerdrView, Notification, State } from '@ghost/contract';
import { herdrPanePath, parseHerdrPane, parseHerdrSession } from './herdrDisplay';
import { embeddedSessionPath } from './CodingSessionModel';

export function codingNotificationAddress(id: string) {
  const match = /^coding:([^:]+):([^:]+:[^:]+):(blocked|done|exit):\d+$/.exec(id);
  const session = parseHerdrSession(match?.[1]);
  const pane = parseHerdrPane(match?.[2]);
  return session && pane ? { session, pane } : null;
}

/** Inbox and native notification taps share the same precedence, including settled decisions. */
export function notificationRoute(item: Notification, state: State, coding?: string | null | HerdrView): string | null {
  const terminal = /^coding:terminal:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):\d+$/i.exec(item.id);
  if (terminal) return `/coding?terminal=${terminal[1]}`;
  const session = /^session:(coding-[^:]+):turn:\d+:waiting$/.exec(item.id);
  if (session) return embeddedSessionPath(session[1]!);
  const address = coding !== undefined ? codingNotificationAddress(item.id) : null;
  if (address) {
    if (!coding || typeof coding === 'string') return address.session === coding ? herdrPanePath(address.pane) : null;
    const exists = coding.available && !coding.note && address.session === coding.session &&
      coding.workspaces.some(workspace => workspace.tabs.some(tab => tab.panes.some(pane => pane.id === address.pane)));
    return exists ? herdrPanePath(address.pane, address.session) : '/coding';
  }
  if (item.decisionId && state.decisions.some(decision => decision.id === item.decisionId && decision.state === 'pending')) return `/inbox?decision=${encodeURIComponent(item.decisionId)}`;
  if (item.workId) return `/work/${encodeURIComponent(item.workId)}`;
  const conversation = state.conversations.find(entry => entry.id === item.conversationId);
  return conversation ? `/ghosts/${encodeURIComponent(conversation.ghostId)}?conversation=${encodeURIComponent(conversation.id)}` : null;
}
