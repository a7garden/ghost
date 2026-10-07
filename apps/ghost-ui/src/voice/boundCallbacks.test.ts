import { expect, it, vi } from 'vitest';
import { bindVoiceCallbacks } from './boundCallbacks';
const context = (conversationId = 'one', profileId = 'ghost') => ({ profileId, conversationId, enabled: true, submitTranscript: vi.fn(async (_text: string) => {}), cancelWork: vi.fn(async () => {}), onSpeakingChange: vi.fn() });
it('uses fresh running-work callbacks while preserving the original conversation identity', async () => {
  let current = context(), original = current;
  const callbacks = bindVoiceCallbacks(original, () => current, () => {});
  current = context(); await callbacks.submitTranscript('두 번째 발화');
  expect(current.submitTranscript).toHaveBeenCalledWith('두 번째 발화'); expect(original.submitTranscript).not.toHaveBeenCalled();
});
it('rejects an old transcript after a route render before effect cleanup and clears only its original mouth source', () => {
  let current = context(), original = current; const onState = vi.fn();
  const callbacks = bindVoiceCallbacks(original, () => current, onState);
  current = context('two', 'different-ghost');
  expect(() => callbacks.submitTranscript('이전 대화에서 한 말')).toThrow('대화 또는 연결');
  expect(current.submitTranscript).not.toHaveBeenCalled(); expect(original.submitTranscript).not.toHaveBeenCalled();
  callbacks.onSpeakingChange?.(false); expect(original.onSpeakingChange).toHaveBeenCalledWith(false); expect(current.onSpeakingChange).not.toHaveBeenCalled();
});
it('blocks submission and cancellation after permission/host connection was revoked', () => {
  let current = context(); const callbacks = bindVoiceCallbacks(current, () => current, () => {});
  current = { ...current, enabled: false };
  expect(() => callbacks.submitTranscript('발화')).toThrow(); expect(() => callbacks.cancelWork()).toThrow();
  expect(current.submitTranscript).not.toHaveBeenCalled(); expect(current.cancelWork).not.toHaveBeenCalled();
});
