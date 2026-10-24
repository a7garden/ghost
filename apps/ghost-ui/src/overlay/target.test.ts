import { describe, expect, it } from 'vitest';
import type { Profile, Snapshot } from '../client/types';
import { legacySubmitKind, pickConversation, pickProfile, routingKind } from './target';

const profile = (id: string, name: string, conversationIds: string[] = []): Profile => ({
  id,
  name,
  persona: '',
  conversations: conversationIds.map(id => ({
    id,
    title: id,
    model: 'mock',
    offline: false,
    messages: [],
    tasks: [],
  })),
  policy: {},
});

const snapshot = (profiles: Profile[]): Snapshot =>
  ({ profiles, workspace_id: 'w' }) as unknown as Snapshot;

const empty = snapshot([]);

describe('pickProfile', () => {
  it('prefers the primary Ghost by name', () => {
    const s = snapshot([profile('a', 'Scout'), profile('b', 'primary')]);
    expect(pickProfile(s)?.id).toBe('b');
  });

  it('prefers the stored target id over the primary name', () => {
    const s = snapshot([profile('a', 'Scout'), profile('b', 'primary')]);
    expect(pickProfile(s, 'a')?.id).toBe('a');
  });

  it('falls back to the first profile when no primary exists', () => {
    const s = snapshot([profile('a', 'Scout'), profile('b', 'Sage')]);
    expect(pickProfile(s)?.id).toBe('a');
  });

  it('returns null on an empty workspace', () => {
    expect(pickProfile(empty)).toBeNull();
  });
});

describe('pickConversation', () => {
  it('keeps the stored conversation while it exists', () => {
    const p = profile('p', 'primary', ['aa', 'bb']);
    expect(pickConversation(p, 'aa')).toBe('aa');
  });

  it('drops a stale stored id and picks the newest UUIDv7', () => {
    const p = profile('p', 'primary', ['018f-aa', '0190-bb']);
    expect(pickConversation(p, 'gone')).toBe('0190-bb');
  });

  it('is empty for a profile without conversations', () => {
    expect(pickConversation(profile('p', 'primary'))).toBe('');
  });
});

describe('kind mapping', () => {
  it('routes follow_up only into conversations with history', () => {
    expect(routingKind(0)).toBe('prompt');
    expect(routingKind(2)).toBe('follow_up');
  });

  it('steers only running work in the legacy fallback', () => {
    expect(legacySubmitKind(0)).toBe('prompt');
    expect(legacySubmitKind(1)).toBe('steer');
  });
});
