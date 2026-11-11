import { describe, expect, it } from 'vitest';
import type { State } from '@ghost/contract';
import { waitingDecisions } from './WaitingLine';

describe('waitingDecisions', () => {
  it('keeps only pending decisions, the longest waiting first', () => {
    const state = { decisions: [
      { id: 'new', state: 'pending', createdAt: 30 },
      { id: 'done', state: 'answered', createdAt: 5 },
      { id: 'old', state: 'pending', createdAt: 10 },
    ] } as unknown as State;
    expect(waitingDecisions(state).map(decision => decision.id)).toEqual(['old', 'new']);
  });
});
