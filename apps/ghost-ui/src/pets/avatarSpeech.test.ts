import { expect, it, vi } from 'vitest';
import { createAvatarSpeech } from './avatarSpeech';

it('keeps playback isolated to its workspace and Ghost', () => {
  const speech = createAvatarSpeech(), source = Symbol();
  speech.set(source, { workspaceId: 'personal', profileId: 'sage' });
  expect(speech.isSpeaking('personal', 'sage')).toBe(true);
  expect(speech.isSpeaking('personal', 'milo')).toBe(false);
  expect(speech.isSpeaking('another', 'sage')).toBe(false);
  speech.set(source, null);
  expect(speech.isSpeaking('personal', 'sage')).toBe(false);
});

it('does not let an old output ending clear another active output', () => {
  const speech = createAvatarSpeech(), old = Symbol(), current = Symbol();
  const speaker = { workspaceId: 'personal', profileId: 'sage' };
  speech.set(old, speaker); speech.set(current, speaker);
  speech.set(old, null); speech.set(old, null);
  expect(speech.isSpeaking('personal', 'sage')).toBe(true);
  speech.set(current, null);
  expect(speech.isSpeaking('personal', 'sage')).toBe(false);
});

it('publishes playback transitions and supports subscriber cleanup', () => {
  const speech = createAvatarSpeech(), listener = vi.fn(), source = Symbol();
  const unsubscribe = speech.subscribe(listener), speaker = { workspaceId: 'personal', profileId: 'sage' };
  speech.set(source, speaker); speech.set(source, speaker); speech.set(source, null);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe(); speech.set(source, speaker);
  expect(listener).toHaveBeenCalledTimes(2);
});
