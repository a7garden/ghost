import { expect, it } from 'vitest';
import type { HerdrPaneView, HerdrView, Notification, State } from '@ghost/contract';
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

it('opens a coding notification only when the current herdr session matches', () => {
  const coding = { ...notification, id: 'coding:studio:w1:p1:blocked:123', decisionId: null, workId: null };
  expect(notificationRoute(coding, state, 'studio')).toBe('/coding?herdr=w1%3Ap1');
  expect(notificationRoute(coding, state, 'default')).toBeNull();
  expect(notificationRoute(coding, state, null)).toBeNull();
  expect(notificationRoute(coding, state)).toBe('/ghosts/ghost%2F1?conversation=chat%2F1');
});

it.each(['blocked', 'done', 'exit'])('opens a native %s tap only if the pane still exists in the active herdr session', kind => {
  const coding = { ...notification, id: `coding:studio:w1:p1:${kind}:123` };
  const pane = { id: 'w1:p1', agent: null } as HerdrPaneView;
  const roster: HerdrView = { available: true, session: 'studio', note: null, workspaces: [{
    id: 'w1', label: 'Studio', status: 'unknown', worktree: null,
    tabs: [{ id: 'w1:t1', label: 'Shell', status: 'unknown', panes: [pane] }],
  }] };
  expect(notificationRoute(coding, state, roster)).toBe('/coding?herdr=w1%3Ap1&herdrSession=studio');
  expect(notificationRoute(coding, state, { ...roster, workspaces: [] })).toBe('/coding');
  expect(notificationRoute(coding, state, { ...roster, session: 'default' })).toBe('/coding');
  expect(notificationRoute(coding, state, { ...roster, available: false })).toBe('/coding');
});

it('accepts an exit notification in the web inbox and still rejects a foreign session', () => {
  const coding = { ...notification, id: 'coding:studio:w1:p1:exit:123' };
  expect(notificationRoute(coding, state, 'studio')).toBe('/coding?herdr=w1%3Ap1');
  expect(notificationRoute(coding, state, 'other')).toBeNull();
});
