import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Decision, Ghost, State } from '@ghost/contract';
import { HostProvider } from '../host/context';
import { InboxView } from './Inbox';

const decision = (patch: Partial<Decision>): Decision => ({
  id: 'd', kind: 'question', ghostId: 'mate', conversationId: 'c1', workId: null, effectId: null,
  title: '질문', detail: '자세한 근거', options: ['A', 'B'], proposal: null, state: 'pending', answer: null, createdAt: 1, resolvedAt: null, ...patch,
});
const ghost = (id: string, isDefault: boolean) => ({ id, name: id === 'main' ? '메인' : '메이트', isDefault, state: 'active', deletedAt: null }) as unknown as Ghost;

const state = {
  ghosts: [ghost('main', true), ghost('mate', false)], works: [], notifications: [],
  settings: { approvals: { autoMinutes: 30, delegate: 'reversible' } },
  decisions: [
    decision({ id: 'quick', title: '어느 쪽으로 할까요?', proposal: { review: { recommend: 'answer', answer: 'A', expiresAt: null } } }),
    decision({ id: 'owner', kind: 'approve_effect', title: '메일 보내기 승인', options: [], createdAt: 2 }),
    decision({ id: 'handed', title: '맡긴 질문', proposal: { review: { recommend: 'answer', answer: 'B', expiresAt: null, delegatedAt: 3 } }, createdAt: 3 }),
  ],
} as unknown as State;

const render = (focus: string | null = null) => renderToStaticMarkup(createElement(HostProvider, null, createElement(InboxView, { state, navigate() {}, focusDecisionId: focus })));

it('lists what waits as rows with quick actions, and keeps what the main is deciding apart', () => {
  const markup = render();
  expect(markup).toContain('「A」');
  expect(markup).toContain('메인에게');
  expect(markup).toContain('나중에');
  expect(markup.match(/aria-controls="queue-card-/g)).toHaveLength(2);
  expect(markup).toContain('data-inbox-kind="handed-over"');
  expect(markup).not.toContain('자세한 근거');
});

it('opens a deep link in the compact detail screen, apart from the queue', () => {
  const markup = render('quick');
  expect(markup).toContain('id="queue-card-quick"');
  expect(markup).toContain('자세한 근거');
  expect(markup).not.toContain('aria-controls="queue-card-');
  expect(markup).not.toContain('data-inbox-kind="handed-over"');
});

it('shows the deadline on a folded row and keeps results out of the bulk recommendation', () => {
  const due = {
    ...state,
    decisions: [
      decision({ id: 'due', title: '곧 정해질 질문', proposal: { review: { recommend: 'answer', answer: 'A', expiresAt: Date.now() + 12 * 60_000 - 5_000 } } }),
      decision({ id: 'result', kind: 'accept_result', title: '결과 확인: R', options: [], workId: 'w1',
        proposal: { result: { summary: '보고', artifacts: [] }, criteria: '기준', review: { recommend: 'approve', expiresAt: null } } }),
    ],
  } as unknown as State;
  const markup = renderToStaticMarkup(createElement(HostProvider, null, createElement(InboxView, { state: due, navigate() {}, focusDecisionId: null })));
  expect(markup).toContain('마감 12분');
  expect(markup.match(/마감 \d/g)).toHaveLength(1);
  expect(markup).toContain('추천대로 처리 1');
  expect(markup.match(/aria-controls="queue-card-/g)).toHaveLength(2);
});
