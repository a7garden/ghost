import { describe, expect, it } from 'vitest';
import type { Ghost, LedgerEventData, State } from '@ghost/contract';
import { applyEvent } from './store';

const baseState = (): State => ({
  seq: 7,
  principal: { kind: 'owner' },
  runtime: { ready: true, detail: '', version: '0.0.0' },
  ghosts: [],
  conversations: [],
  works: [],
  decisions: [],
  notifications: [],
  schedules: [],
  spaces: [],
  avatars: [],
  settings: { defaultModel: null, reviewModel: null, providers: [] },
  devices: [],
  sandboxes: [],
});

const ghost = (id: string, patch: Partial<Ghost> = {}): Ghost => ({
  id, name: id, persona: '', look: { avatarId: null }, model: null, isDefault: false, state: 'active',
  directConversationId: `conv-${id}`, createdAt: 1, updatedAt: 1, ...patch,
});

const event = (data: LedgerEventData) => data;

describe('applyEvent', () => {
  it('inserts a new ghost and updates an existing one by id', () => {
    let state = applyEvent(baseState(), event({ type: 'ghost', ghost: ghost('sage') }));
    expect(state.ghosts.map(row => row.id)).toEqual(['sage']);
    state = applyEvent(state, event({ type: 'ghost', ghost: ghost('milo') }));
    expect(state.ghosts.map(row => row.id)).toEqual(['sage', 'milo']);
    state = applyEvent(state, event({ type: 'ghost', ghost: ghost('sage', { name: '세이지', isDefault: true }) }));
    expect(state.ghosts.map(row => row.id)).toEqual(['sage', 'milo']);
    expect(state.ghosts[0]).toMatchObject({ name: '세이지', isDefault: true });
  });

  it('removes conversations and keeps the rest', () => {
    let state = applyEvent(baseState(), event({ type: 'conversation', conversation: { id: 'c1', ghostId: 'sage', kind: 'direct', workId: null, title: '대화', model: null, busy: false, createdAt: 1, lastActivityAt: 1 } }));
    state = applyEvent(state, event({ type: 'conversation', conversation: { id: 'c2', ghostId: 'sage', kind: 'direct', workId: null, title: '이전 대화', model: null, busy: false, createdAt: 1, lastActivityAt: 1 } }));
    expect(state.conversations).toHaveLength(2);
    state = applyEvent(state, event({ type: 'conversation.removed', id: 'c1' }));
    expect(state.conversations.map(row => row.id)).toEqual(['c2']);
    state = applyEvent(state, event({ type: 'conversation.removed', id: 'missing' }));
    expect(state.conversations.map(row => row.id)).toEqual(['c2']);
  });

  it('upserts work and decision rows by id', () => {
    const work = {
      id: 'w1', parentId: null, rootId: 'w1', ghostId: 'sage', originConversationId: 'c1', conversationId: null,
      title: '조사', brief: '조사해 줘', acceptance: { criteria: '', checks: [], reviewer: null }, state: 'queued' as const,
      revision: 1, revisionsUsed: 0, deadlineAt: null, result: null, verdict: null, reason: null,
      createdAt: 1, startedAt: null, endedAt: null, updatedAt: 1,
    };
    let state = applyEvent(baseState(), event({ type: 'work', work }));
    state = applyEvent(state, event({ type: 'work', work: { ...work, state: 'running' as const, updatedAt: 2 } }));
    expect(state.works).toHaveLength(1);
    expect(state.works[0]).toMatchObject({ state: 'running', updatedAt: 2 });
    state = applyEvent(state, event({ type: 'decision', decision: { id: 'd1', kind: 'question', ghostId: 'sage', conversationId: 'c1', workId: null, effectId: null, title: '어디로 갈까요', detail: '', options: ['서울', '부산'], proposal: null, state: 'pending', answer: null, createdAt: 1, resolvedAt: null } }));
    expect(state.decisions[0]).toMatchObject({ id: 'd1', state: 'pending' });
  });

  it('replaces settings wholesale and swaps sandbox rows per ghost', () => {
    let state = applyEvent(baseState(), event({ type: 'settings', settings: { defaultModel: { provider: 'zai', model: 'glm-5.3' }, reviewModel: null, providers: [] } }));
    expect(state.settings.defaultModel).toEqual({ provider: 'zai', model: 'glm-5.3' });
    state = applyEvent(state, event({ type: 'sandbox', sandbox: { ghostId: 'sage', state: 'running', detail: '' } }));
    state = applyEvent(state, event({ type: 'sandbox', sandbox: { ghostId: 'milo', state: 'stopped', detail: '' } }));
    state = applyEvent(state, event({ type: 'sandbox', sandbox: { ghostId: 'sage', state: 'error', detail: 'container lost' } }));
    expect(state.sandboxes.map(row => [row.ghostId, row.state])).toEqual([['milo', 'stopped'], ['sage', 'error']]);
  });

  it('removes schedules, spaces, avatars and devices', () => {
    let state = applyEvent(baseState(), event({ type: 'space', space: { id: 'sp1', name: '메모', path: '/v', grants: [], createdAt: 1 } }));
    state = applyEvent(state, event({ type: 'space.removed', id: 'sp1' }));
    expect(state.spaces).toEqual([]);
    state = applyEvent(state, event({ type: 'device', device: { id: 'dev1', name: 'iPhone', grants: [], pushEnabled: true, createdAt: 1, lastSeenAt: null } }));
    state = applyEvent(state, event({ type: 'device.removed', id: 'dev1' }));
    expect(state.devices).toEqual([]);
  });

  it('ignores effect events: they ride on work detail reads', () => {
    const before = baseState();
    const after = applyEvent(before, event({ type: 'effect', effect: { id: 'e1', workId: 'w1', conversationId: 'c9', callId: 'call', tool: 'bash', summary: 'ls', inputDigest: 'a'.repeat(64), state: 'done', result: null, createdAt: 1, endedAt: 2 } }));
    expect(after).toBe(before);
  });
});
