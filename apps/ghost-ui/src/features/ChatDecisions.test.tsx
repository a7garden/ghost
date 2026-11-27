import { describe, expect, it } from 'vitest';
import type { Decision, State } from '@ghost/contract';
import { chatPendingSummary } from './ChatDecisions';

const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', kind: 'approve_effect', ghostId: 'sage', conversationId: 'c1', workId: null, effectId: 'e1',
  title: '파일 저장 승인', detail: '메모에 한 줄을 추가합니다.', options: [], proposal: null, state: 'pending',
  answer: null, createdAt: 1, resolvedAt: null, ...patch,
});

const state = (decisions: Decision[]) => ({ decisions, works: [], ghosts: [{ id: 'sage', name: '세이지' }] }) as unknown as State;

describe('chatPendingSummary', () => {
  it('counts what waits and names the first card of the deck, in owner order', () => {
    const calm = decision({ id: 'calm', kind: 'accept_result', title: '주간 보고 초안', createdAt: 1 });
    const urgent = decision({ id: 'urgent', kind: 'question', title: '어느 쪽으로 할까요?', options: ['서울'], createdAt: 2 });
    const summary = chatPendingSummary([calm, urgent], {}, state([calm, urgent]), 0);
    expect(summary.count).toMatch(/2건/);
    expect(summary.lead).toBe(urgent.title);
    expect(summary.due).toBeNull();
  });

  it('keeps the deadline of the first card on the row', () => {
    const item = decision({ kind: 'question', title: '어느 쪽으로 할까요?', proposal: { review: { recommend: 'answer', answer: '서울', expiresAt: 12 * 60_000 } } });
    expect(chatPendingSummary([item], {}, state([item]), 0).due).toBe('마감 12분');
  });
});
