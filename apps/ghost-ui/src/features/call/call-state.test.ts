import { describe, expect, it } from 'vitest';
import type { Call, Ghost, Message } from '@ghost/contract';
import { callScreenState, callStartBlock, captionRole, isLiveCall } from './call-state';

const connecting: Call = {
  id: 'call-1', ghostId: 'sage', conversationId: 'chat-1', engine: 'local', status: 'connecting',
  startedAt: 500, answeredAt: null, endedAt: null, seconds: null, endReason: null, error: null,
};
const active: Call = { ...connecting, status: 'active', answeredAt: 1_000 };
const owner: Message = {
  id: 'message-1', conversationId: 'chat-1', callId: 'call-1', role: 'user', origin: 'owner',
  createdAt: 1_000, text: '안녕', attachments: [], toolCalls: [], tool: null,
};

describe('call presentation', () => {
  it('distinguishes connecting, a reconnect gesture, and elapsed wall time from answer', () => {
    expect(callScreenState({ now: 500 })).toEqual({ kind: 'working', text: '연결 중' });
    expect(callScreenState({ call: connecting, now: 900 })).toEqual({ kind: 'working', text: '연결 중' });
    expect(callScreenState({ call: active, resume: true, now: 4_000 })).toEqual({ kind: 'working', text: '마이크 연결 대기' });
    expect(callScreenState({ call: active, now: 62_999 })).toEqual({ kind: 'timer', text: '01:01' });
    expect(callScreenState({ call: active, now: 950 }).text).toBe('00:00');
  });

  it('keeps errors visible after media is closed and gives a limit its own state', () => {
    const failed: Call = { ...active, status: 'failed', error: '마이크 연결이 끊겼습니다.', endReason: 'error' };
    expect(callScreenState({ call: failed, now: 4_000 })).toEqual({ kind: 'failed', text: failed.error });
    expect(callScreenState({ error: 'Host error', ending: true, now: 4_000 })).toEqual({ kind: 'failed', text: 'Host error' });
    const ended: Call = { ...active, status: 'ended', endReason: 'limit' };
    expect(callScreenState({ call: ended, now: 905_000 })).toEqual({ kind: 'ended', text: '통화 시간이 끝났습니다.' });
    expect([connecting, active, failed, ended].map(isLiveCall)).toEqual([true, true, false, false]);
  });

  it('ties owner captions to the call and includes only assistant text from its conversation window', () => {
    expect(captionRole(owner, active)).toBe('owner');
    expect(captionRole({ ...owner, callId: undefined }, active)).toBeNull();
    expect(captionRole({ ...owner, callId: 'another' }, active)).toBeNull();
    const reply: Message = { ...owner, role: 'assistant', callId: undefined, origin: null };
    expect(captionRole(reply, active)).toBe('ghost');
    expect(captionRole({ ...reply, createdAt: 499 }, active)).toBeNull();
    expect(captionRole(reply, { ...active, endedAt: 950 })).toBeNull();
    expect(captionRole({ ...reply, conversationId: 'other' }, active)).toBeNull();
    expect(captionRole({ ...reply, text: '[quiet]' }, active)).toBeNull();
  });

  it('explains an occupied host or unavailable Ghost without guessing engine availability', () => {
    const ghost = { state: 'active', deletedAt: null } as Ghost;
    expect(callStartBlock(ghost, false)).toBeNull();
    expect(callStartBlock(ghost, true)).toContain('통화 중');
    expect(callStartBlock({ ...ghost, state: 'retired' }, false)).toContain('받을 수 없습니다');
    expect(callStartBlock({ ...ghost, state: 'paused' }, false)).toBeNull();
  });
});
