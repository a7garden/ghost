import type { VoiceConfiguration, VoiceReply, VoiceTransport } from './controller';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

// macOS 13 hosts may not expose AbortSignal.any/timeout. Keep cancellation
// attached until the response body is consumed, without depending on either.
async function withDeadline<T>(signal: AbortSignal, milliseconds: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, milliseconds);
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) controller.abort();
    if (controller.signal.aborted) throw new DOMException('음성 요청을 중단했습니다.', 'AbortError');
    return await operation(controller.signal);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

export function createLocalVoiceTransport(profileId: string, conversationId: string): VoiceTransport {
  let csrf = '', version: number | undefined;
  const context = () => ({ profile_id: profileId, conversation_id: conversationId, settings_version: version });
  async function request(operation: string, body: unknown, signal: AbortSignal): Promise<Record<string, any>> {
    return withDeadline(signal, operation === 'config' ? 10000 : 130000, async bounded => {
      const response = await fetch(`/ghost-api/voice/${operation}`, { method: 'POST', headers: { 'X-Ghost-UI-CSRF': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: bounded });
      let result: Record<string, any>;
      try { result = await response.json(); } catch { throw new Error('로컬 음성 서버의 응답을 확인할 수 없습니다.'); }
      if (!response.ok || result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : '로컬 음성 서버 요청을 처리하지 못했습니다.');
      return result.result ?? result;
    });
  }
  return {
    async configure(signal) {
      const bootstrap = await withDeadline(signal, 10000, async bounded => {
        const response = await fetch('/ghost-api/bootstrap', { cache: 'no-store', signal: bounded });
        if (!response.ok) throw new Error('실제 로컬 호스트에 연결한 뒤 통화할 수 있습니다.');
        return response.json();
      });
      if (bootstrap.mode !== 'live' || typeof bootstrap.csrf !== 'string' || !bootstrap.csrf) throw new Error('실제 로컬 호스트에 연결한 뒤 통화할 수 있습니다.');
      csrf = bootstrap.csrf;
      const result = await request('config', { profile_id: profileId, conversation_id: conversationId }, signal) as VoiceConfiguration;
      if (typeof result.available !== 'boolean' || !Number.isSafeInteger(result.settings_version)) throw new Error('음성 모델 설정 응답을 확인할 수 없습니다.');
      version = result.settings_version; return result;
    },
    async transcribe(wav, signal) {
      if (version === undefined) throw new Error('통화를 먼저 연결해 주세요.');
      if (wav.size > 4 * 1024 * 1024) throw new Error('발화가 너무 깁니다. 짧게 나눠 말씀해 주세요.');
      const result = await request('transcribe', { ...context(), mime: 'audio/wav', audio_base64: toBase64(new Uint8Array(await wav.arrayBuffer())) }, signal);
      if (typeof result.text !== 'string' || result.text.length > 8192 || result.settings_version !== version) throw new Error('음성 인식 결과 또는 모델 설정을 확인할 수 없습니다.');
      return { text: result.text };
    },
    async synthesize(reply: VoiceReply, signal) {
      if (version === undefined) throw new Error('통화를 먼저 연결해 주세요.');
      const result = await request('synthesize', { ...context(), task_id: reply.taskId }, signal);
      if (result.mime !== 'audio/wav' || typeof result.audio_base64 !== 'string' || result.audio_base64.length > Math.ceil(4 * 1024 * 1024 / 3) * 4) throw new Error('로컬 TTS 서버의 출력 형식을 확인할 수 없습니다.');
      const binary = atob(result.audio_base64), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: 'audio/wav' });
    },
  };
}
