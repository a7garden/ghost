import { describe, expect, it } from 'vitest';
import type { Decision, Ghost, State } from '@ghost/contract';
import { canHandOver, handedOver, ownerOrder, recommendedLabel, recommendedResolution } from './decisionQueue';
import { pendingDecisions } from './ghostState';
import { chatDecisions } from './Decision';

const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', kind: 'question', ghostId: 'mate', conversationId: 'c1', workId: null, effectId: null,
  title: '어느 쪽으로 할까요?', detail: '', options: ['A', 'B'], proposal: { review: { recommend: 'answer', answer: 'A', expiresAt: null } },
  state: 'pending', answer: null, createdAt: 1, resolvedAt: null, ...patch,
});

const ghost = (id: string, isDefault: boolean) => ({ id, name: id, isDefault, state: 'active', deletedAt: null }) as unknown as Ghost;

const stateOf = (decisions: Decision[], delegate: 'reversible' | 'none' = 'reversible') => ({
  ghosts: [ghost('main', true), ghost('mate', false)], decisions, works: [],
  settings: { approvals: { autoMinutes: 30, delegate } },
}) as unknown as State;

const handed = (patch: Partial<Decision> = {}) => decision({ proposal: { review: { recommend: 'answer', answer: 'A', expiresAt: null, delegatedAt: 5 } }, ...patch });

describe('확인할 일 빠른 처리', () => {
  it('drops decisions handed to the main from everything that counts what waits on the owner', () => {
    const state = stateOf([decision({ id: 'mine' }), handed({ id: 'main' })]);
    expect(handedOver(state.decisions[1]!)).toBe(true);
    expect(pendingDecisions(state).map(item => item.id)).toEqual(['mine']);
    expect(chatDecisions(state, 'mate', null).map(item => item.id)).toEqual(['mine']);
  });

  it('offers the main only reversible decisions of another Ghost while delegation is on', () => {
    expect(canHandOver(decision(), stateOf([]))).toBe(true);
    // No recommendation: the Host found it not reversible (sending, spending, deleting, accepting a result).
    expect(canHandOver(decision({ proposal: null }), stateOf([]))).toBe(false);
    expect(canHandOver(decision({ ghostId: 'main' }), stateOf([]))).toBe(false);
    expect(canHandOver(decision(), stateOf([], 'none'))).toBe(false);
    expect(canHandOver(handed(), stateOf([]))).toBe(false);
  });

  it('settles by recommendation only what needs no second look', () => {
    expect(recommendedResolution(decision())).toEqual({ outcome: 'answer', answer: 'A' });
    expect(recommendedLabel(decision())).toBe('「A」');
    const page = decision({ kind: 'document_review', options: [], proposal: { review: { recommend: 'approve', expiresAt: null } } });
    expect(recommendedResolution(page)).toEqual({ outcome: 'approve' });
    expect(recommendedLabel(page)).toBe('저장 승인');
    expect(recommendedResolution(decision({ proposal: { review: { mainNote: '직접 보세요', expiresAt: null } } }))).toBeNull();
    expect(recommendedResolution(decision({ proposal: { secureForm: { kind: 'login' }, review: { recommend: 'answer', answer: 'A', expiresAt: null } } }))).toBeNull();
    // A recommended answer that is not among the offered options is never sent blind.
    expect(recommendedResolution(decision({ proposal: { review: { recommend: 'answer', answer: 'C', expiresAt: null } } }))).toBeNull();
    expect(recommendedResolution(handed())).toBeNull();
  });

  it('keeps the oldest first and moves what was put off to the back, in the order it was put off', () => {
    const items = [decision({ id: 'a', createdAt: 1 }), decision({ id: 'b', createdAt: 2 }), decision({ id: 'c', createdAt: 3 })];
    expect(ownerOrder(items, {}).map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(ownerOrder(items, { c: 10, a: 20 }).map(item => item.id)).toEqual(['b', 'c', 'a']);
  });
});
