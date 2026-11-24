import type { Call } from '@ghost/contract';
import type { HostClient } from '../../host/client';
import type { HostStore } from '../../host/store';
import type { CallLevels, MediaActivity } from './call-state';
import type { LineBook } from './lines';

export type MediaOptions = {
  call: Pick<Call, 'id' | 'conversationId' | 'startedAt' | 'endedAt'>;
  client: HostClient;
  store: HostStore;
  signal: AbortSignal;
  lines: LineBook;
  failed(message: string): void;
  ended(): void;
  audioBlocked(blocked: boolean): void;
};

export type CallMedia = {
  connected: Promise<void>;
  setMicMuted(muted: boolean): void;
  setSpeakerMuted(muted: boolean): void;
  resumeAudio?(): void;
  /** Loudness now; cheap enough to read on every animation frame. */
  levels(): CallLevels;
  /** Who is making sound now, for the call phase. */
  activity(): MediaActivity;
};

/** Capture is only entered from a click handler; a late grant after hangup is immediately released. */
export async function openMicrophone(signal: AbortSignal): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('이 화면에서는 마이크를 사용할 수 없습니다.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
    } });
  } catch (reason) {
    switch ((reason as DOMException)?.name) {
      case 'NotAllowedError': throw new Error('마이크 권한이 필요합니다. 설정에서 허용한 뒤 다시 전화해 주세요.');
      case 'NotFoundError': throw new Error('연결된 마이크가 없습니다.');
      case 'NotReadableError': throw new Error('마이크를 열 수 없습니다.');
      default: throw new Error(errorMessage(reason, '마이크에 연결하지 못했습니다.'));
    }
  }
  const stop = () => stream.getTracks().forEach(track => track.stop());
  if (signal.aborted) { stop(); throw signal.reason; }
  signal.addEventListener('abort', stop, { once: true });
  return stream;
}

export function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
