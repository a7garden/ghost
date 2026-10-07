import type { VoiceCallbacks, VoiceState } from './controller';

type Context = { profileId: string; conversationId: string; enabled: boolean; submitTranscript(text: string): Promise<void>; cancelWork(): Promise<void>; onSpeakingChange?(speaking: boolean): void };
// React updates props during render, before passive-effect cleanup. Never send
// a late transcript from the previous microphone into the newly selected chat.
export function bindVoiceCallbacks(identity: Pick<Context, 'profileId' | 'conversationId'>, current: () => Context, onState: (state: VoiceState) => void): VoiceCallbacks {
  const originalSpeaking = current().onSpeakingChange;
  const matches = () => current().profileId === identity.profileId && current().conversationId === identity.conversationId;
  const requireContext = () => {
    if (!matches() || !current().enabled) throw new Error('통화할 대화 또는 연결이 변경되었습니다. 통화를 다시 시작해 주세요.');
    return current();
  };
  return {
    submitTranscript: text => requireContext().submitTranscript(text),
    cancelWork: () => requireContext().cancelWork(),
    onState: state => { if (matches()) onState(state); },
    onSpeakingChange: speaking => originalSpeaking?.(speaking && matches()),
  };
}
