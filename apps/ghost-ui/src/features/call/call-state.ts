import type { Call, CallEngine, Ghost, Message } from '@ghost/contract';

export const engineLabel: Record<CallEngine, string> = { realtime: '실시간', local: '이 Mac' };

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
