import { describe, expect, it } from 'vitest';
import type { Ghost, State } from '@ghost/contract';
import { pickConversation, pickGhost } from './target';

const ghost = (id: string, isDefault = false, directId = `direct-${id}`): Ghost => ({
  id, name: id, persona: '', look: { avatarId: null }, model: null, isDefault, state: 'active',
  directConversationId: directId, createdAt: 1, updatedAt: 1,
});

const state = (): State => ({
  seq: 1,
  principal: { kind: 'owner' },
  runtime: { ready: true, detail: '', version: '0.0.0' },
  ghosts: [ghost('milo'), ghost('sage', true)],
  conversations: [
    { id: 'extra', ghostId: 'sage', kind: 'direct', workId: null, title: '이전 대화', privacy: 'public', model: null, busy: false, createdAt: 1, lastActivityAt: 2 },
    { id: 'work-conv', ghostId: 'sage', kind: 'work', workId: 'w1', title: '작업 대화', privacy: 'public', model: null, busy: false, createdAt: 1, lastActivityAt: 3 },
  ],
  works: [], decisions: [], notifications: [], schedules: [], spaces: [], avatars: [],
  settings: { defaultModel: null, reviewModel: null, providers: [] }, devices: [], sandboxes: [],
});

describe('pickGhost', () => {
  it('prefers the stored target, then the default Ghost, then the first Ghost', () => {
    const snapshot = state();
    expect(pickGhost(snapshot)?.id).toBe('sage');
    expect(pickGhost(snapshot, 'milo')?.id).toBe('milo');
    expect(pickGhost({ ...snapshot, ghosts: [ghost('milo')] })?.id).toBe('milo');
    expect(pickGhost({ ...snapshot, ghosts: [] })).toBeNull();
  });
});

describe('pickConversation', () => {
  it('keeps a stored direct conversation only while this Ghost still owns it', () => {
    const snapshot = state();
    const sage = pickGhost(snapshot, 'sage')!;
    expect(pickConversation(snapshot, sage, 'extra')).toBe('extra');
    expect(pickConversation(snapshot, sage, 'work-conv')).toBe('direct-sage');
    expect(pickConversation(snapshot, sage, 'gone')).toBe('direct-sage');
    expect(pickConversation(snapshot, sage)).toBe('direct-sage');
  });
});
