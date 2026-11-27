import { expect, it } from 'vitest';
import type { CodingSession } from '@ghost/contract';
import { foldedAgents, STALE_MS } from './workbenchFold';

const now = 10 * STALE_MS;
const session = (id: string, patch: Partial<CodingSession>) => [id, { id, state: 'idle', updatedAt: now, ...patch } as CodingSession] as const;
const agents = ['fresh', 'old', 'oldWorking', 'oldWaiting', 'oldFailed', 'oldFocused', 'oldAttention', 'closed', 'unknown'].map(sessionId => ({ sessionId, scopeId: 's' }));
const sessions = new Map([
  session('fresh', {}), session('old', { updatedAt: now - STALE_MS - 1 }),
  session('oldWorking', { updatedAt: 0, state: 'working' }), session('oldFocused', { updatedAt: 0 }),
  session('oldWaiting', { updatedAt: 0, state: 'waiting' }), session('oldFailed', { updatedAt: 0, state: 'failed' }),
  session('oldAttention', { updatedAt: 0 }), session('closed', { state: 'closed' }),
]);

it('folds only idle, stale or closed agents that need nothing from the owner', () => {
  const folded = foldedAgents(agents, sessions, new Map([['oldAttention', 'done']]), 'oldFocused', now);
  expect([...folded].sort()).toEqual(['closed', 'old']);
});
