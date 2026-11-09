import { expect, it } from 'vitest';
import type { Notification, State } from '@ghost/contract';
import { notificationRoute } from './notificationRoute';
const state = { decisions: [{ id: 'decision/1', state: 'pending' }], conversations: [{ id: 'chat/1', ghostId: 'ghost/1' }] } as State;
const notification = { decisionId: 'decision/1', workId: 'work/1', conversationId: 'chat/1' } as Notification;
it('prioritizes a pending decision, then work, then the actual conversation', () => {
  expect(notificationRoute(notification, state)).toBe('/inbox?decision=decision%2F1');
  expect(notificationRoute(notification, { ...state, decisions: [] })).toBe('/work/work%2F1');
  expect(notificationRoute({ ...notification, workId: null }, { ...state, decisions: [] })).toBe('/ghosts/ghost%2F1?conversation=chat%2F1');
});
it('does not fabricate a destination for stale or non-navigable notifications', () => {
  expect(notificationRoute({ ...notification, decisionId: 'gone', workId: null, conversationId: 'gone' }, state)).toBeNull();
});

it('opens a proactive message in its actual direct conversation', () => {
  expect(notificationRoute({ ...notification, kind: 'message', title: '도우미', body: '정리한 내용을 가져왔어요.', decisionId: null, workId: null }, state))
    .toBe('/ghosts/ghost%2F1?conversation=chat%2F1');
});
