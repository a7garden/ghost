import { expect, it, vi } from 'vitest';
import { createAvatarSpeech } from './avatarSpeech';

it('keeps playback isolated per Ghost', () => {
  const speech = createAvatarSpeech(), source = Symbol();
  speech.set(source, 'sage');
  expect(speech.isSpeaking('sage')).toBe(true);
  expect(speech.isSpeaking('milo')).toBe(false);
  speech.set(source, null);
  expect(speech.isSpeaking('sage')).toBe(false);
});

it('does not let an old output ending clear another active output', () => {
  const speech = createAvatarSpeech(), old = Symbol(), current = Symbol();
  speech.set(old, 'sage'); speech.set(current, 'sage');
  speech.set(old, null); speech.set(old, null);
  expect(speech.isSpeaking('sage')).toBe(true);
  speech.set(current, null);
  expect(speech.isSpeaking('sage')).toBe(false);
});

it('publishes playback transitions and supports subscriber cleanup', () => {
  const speech = createAvatarSpeech(), listener = vi.fn(), source = Symbol();
  const unsubscribe = speech.subscribe(listener);
  speech.set(source, 'sage'); speech.set(source, 'sage'); speech.set(source, null);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe(); speech.set(source, 'sage');
  expect(listener).toHaveBeenCalledTimes(2);
});
