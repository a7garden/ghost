import { expect, it } from 'vitest';
import type { State } from '@ghost/contract';
import { ghostPetState } from './AvatarProvider';
import { spriteVersionOf } from './sprites';

const ghost = (id: string) => ({
  id, name: 'Sage', persona: '', look: { avatarId: null }, model: null, isDefault: true, state: 'active' as const,
  directConversationId: `${id}-direct`, createdAt: 1, updatedAt: 1,
});

const state = (partial: Partial<Pick<State, 'conversations' | 'decisions'>> = {}): State => ({
  seq: 0,
  principal: { kind: 'owner' },
  runtime: { ready: true, detail: '', version: '0' },
  ghosts: [ghost('sage')],
  conversations: partial.conversations ?? [],
  works: [],
  decisions: partial.decisions ?? [],
  notifications: [],
  schedules: [],
  spaces: [],
  avatars: [],
  settings: { defaultModel: null, reviewModel: null, providers: [] },
  devices: [],
  sandboxes: [],
});

it('animates a Ghost only while one of its conversations is busy', () => {
  const busy = state({ conversations: [{ id: 'c1', ghostId: 'sage', kind: 'direct', workId: null, title: '', model: null, busy: true, createdAt: 1, lastActivityAt: 1 }] });
  expect(ghostPetState(state().ghosts[0], busy)).toBe('running');
  expect(ghostPetState(state().ghosts[0], state())).toBe('idle');
});

it('shows the waiting pose on a pending decision for the Ghost', () => {
  const waiting = state({ decisions: [{ id: 'd1', kind: 'question', ghostId: 'sage', conversationId: 'c1', workId: null, effectId: null, title: '', detail: '', options: [], proposal: null, state: 'pending', answer: null, createdAt: 1, resolvedAt: null }] });
  expect(ghostPetState(state().ghosts[0], waiting)).toBe('waiting');
  const resolved = { ...waiting, decisions: waiting.decisions.map(decision => ({ ...decision, state: 'answered' as const })) };
  expect(ghostPetState(state().ghosts[0], resolved)).toBe('idle');
});

it('ignores other Ghosts and unknown ghosts', () => {
  const busy = state({ conversations: [{ id: 'c1', ghostId: 'milo', kind: 'work', workId: null, title: '', model: null, busy: true, createdAt: 1, lastActivityAt: 1 }] });
  expect(ghostPetState(state().ghosts[0], busy)).toBe('idle');
  expect(ghostPetState(undefined, busy)).toBe('idle');
});

it('reads the sprite version from the avatar design record', () => {
  expect(spriteVersionOf({ color: '#8bbca7', shape: 'ghost', eyes: 'classic', accessory: 'none', spriteVersion: 2 })).toBe(2);
  expect(spriteVersionOf(null)).toBe(2);
});
