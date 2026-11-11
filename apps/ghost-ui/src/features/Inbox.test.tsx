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
  expect(markup).toContain('추천대로 처리 1');
  expect(markup).toContain('「A」');
  expect(markup).toContain('메인에게');
  expect(markup).toContain('나중에');
  // 두 건만 주인 차례다. 맡긴 질문은 「메인 Ghost가 판단 중」에 따로.
  expect(markup).toMatch(/확인 필요<span class="count">2<\/span>/);
  expect(markup).toContain('메인 Ghost가 판단 중');
  // 접힌 줄은 근거를 펼치지 않는다.
  expect(markup).not.toContain('자세한 근거');
});

it('opens the linked decision in place', () => {
  expect(render('quick')).toContain('자세한 근거');
});
