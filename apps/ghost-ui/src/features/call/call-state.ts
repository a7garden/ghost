import type { Call, CallEngine, Ghost, Message } from '@ghost/contract';

export const engineLabel: Record<CallEngine, string> = { realtime: '실시간', local: '이 Mac' };

/** What the call is doing right now, from the owner's side of the phone. */
export type CallPhase = 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'working' | 'speaking';
/** One utterance in the call's own transcript. `live` lines are still being spoken or recognized. */
export type CallLine = { id: string; speaker: 'owner' | 'ghost'; text: string; live: boolean };
/** Smoothed microphone and playback loudness, 0..1. Read it on every animation frame; it is not React state. */
export type CallLevels = { input: number; output: number };
/** Where the Ghost's voice comes out on a phone: the earpiece (held to the ear) or the loudspeaker. */
export type AudioRoute = 'receiver' | 'speaker';

export function isLiveCall(call: Call): boolean {
  return call.status === 'connecting' || call.status === 'active';
}

export function callStartBlock(ghost: Ghost, occupied: boolean): string | null {
  if (occupied) return '이미 통화 중입니다.';
  if (ghost.state === 'retired' || ghost.deletedAt !== null) return '이 Ghost는 전화를 받을 수 없습니다.';
  return null;
}

export function elapsedCall(answeredAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - answeredAt) / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

type ViewInput = { call?: Call; error?: string; ending?: boolean; ended?: boolean; resume?: boolean; now: number };

export function callScreenState({ call, error, ending, ended, resume, now }: ViewInput) {
  if (call?.status === 'failed' || error) return { kind: 'failed', text: call?.error || error || '통화에 실패했습니다.' } as const;
  if (ending) return { kind: 'working', text: '통화 종료 중' } as const;
  if (ended || call?.status === 'ended') return { kind: 'ended', text: call?.endReason === 'limit' ? '통화 시간이 끝났습니다.' : '통화 종료' } as const;
  if (resume) return { kind: 'working', text: '마이크 연결 대기' } as const;
  if (call?.status === 'active' && call.answeredAt !== null) return { kind: 'timer', text: elapsedCall(call.answeredAt, now) } as const;
  return { kind: 'working', text: '연결 중' } as const;
}

export function captionRole(message: Message, call: Pick<Call, 'id' | 'conversationId' | 'startedAt' | 'endedAt'>) {
  if (message.conversationId !== call.conversationId || !message.text.trim() || message.text.trim() === '[quiet]') return null;
  if (message.role === 'user') return message.callId === call.id ? 'owner' : null;
  if (message.role === 'assistant' && message.createdAt >= call.startedAt && message.createdAt <= (call.endedAt ?? Infinity)) return 'ghost';
  return null;
}

/** What the engine's media layer can tell about the audio right now. */
export type MediaActivity = { hearing: boolean; transcribing: boolean; speaking: boolean };
/** What the Ghost's conversation is doing: a run in progress and the tool it is in. */
export type GhostWork = { running: boolean; tool?: string };

/**
 * One phase for the whole call. Audio wins over work: the owner talking, then the recognizer, then the Ghost's
 * voice; only in silence does the screen say the Ghost is thinking or running a tool.
 */
export function callPhase(media: MediaActivity, work: GhostWork): { phase: CallPhase; detail?: string } {
  if (media.hearing) return { phase: 'hearing' };
  if (media.transcribing) return { phase: 'transcribing' };
  if (media.speaking) return { phase: 'speaking' };
  if (work.running) return work.tool ? { phase: 'working', detail: work.tool } : { phase: 'thinking' };
  return { phase: 'listening' };
}
