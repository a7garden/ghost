import { describe, expect, it } from 'vitest';
import { searchWorkspace } from './searchIndex';
import type { Snapshot } from './types';

const snapshot = {
  profiles: [
    {
      id: 'sage', name: 'Sage', persona: '조사하고 정리하는 에이전트', policy: {}, avatar_id: null,
      conversations: [
        { id: 'c1', title: '관리 화면 접근성 점검', model: 'mock', offline: true, messages: [], tasks: [{ id: 't1', name: '응답 생성', phase: 'complete', partial: '', output: '' }] },
        { id: 'c2', title: '도구 동향 조사', model: 'mock', offline: true, messages: [], tasks: [{ id: 't2', name: '비교 표 정리', phase: 'complete', partial: '', output: '' }] },
      ],
    },
    { id: 'theo', name: 'Theo', persona: '기록을 남기는 에이전트', policy: {}, avatar_id: null, conversations: [] },
  ],
  goals: [{ id: 'g1', profile_id: 'sage', title: '주간 동향 정리', criteria: '', instruction: '', state: 'running', evidence: [], note: '' }],
  schedules: [{ id: 's1', profile_id: 'sage', conversation_id: 'c1', prompt: '매주 새로운 에이전트 도구 조사', interval_seconds: 604800, next_run_ms: 0, paused: false }],
  spaces: [{ id: 'space-ghost', name: 'Ghost 프로젝트', path: '', writable: true, profiles: ['sage'] }],
} as unknown as Snapshot;

describe('searchWorkspace', () => {
  it('matches ghosts by name and persona', () => {
    const hits = searchWorkspace(snapshot, 'sage');
    expect(hits[0]).toMatchObject({ kind: 'ghost', id: 'sage', path: '/ghosts/sage' });
    expect(searchWorkspace(snapshot, '기록을 남기는')[0]?.id).toBe('theo');
  });

  it('matches conversation titles and navigates to the conversation', () => {
    const hits = searchWorkspace(snapshot, '접근성');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'work', id: 'conversation:c1', path: '/ghosts/sage?conversation=c1', subtitle: 'Sage · 대화' });
  });

  it('skips the generic task label and matches real task names', () => {
    expect(searchWorkspace(snapshot, '응답 생성').filter(h => h.id.startsWith('task:'))).toHaveLength(0);
    const task = searchWorkspace(snapshot, '비교 표')[0];
    expect(task).toMatchObject({ kind: 'work', id: 'task:t2', path: '/ghosts/sage?conversation=c2', subtitle: 'Sage · 도구 동향 조사' });
  });

  it('matches goal titles and keeps the work view as the destination', () => {
    expect(searchWorkspace(snapshot, '주간 동향')[0]).toMatchObject({ kind: 'work', id: 'goal:g1', path: '/work' });
  });

  it('matches schedule prompts', () => {
    expect(searchWorkspace(snapshot, '매주 새로운')[0]).toMatchObject({ kind: 'work', id: 'schedule:s1', path: '/ghosts/sage?conversation=c1' });
  });

  it('matches space names', () => {
    expect(searchWorkspace(snapshot, '프로젝트')[0]).toMatchObject({ kind: 'space', id: 'space-ghost', path: '/spaces/space-ghost' });
  });

  it('is case-insensitive and trims the query', () => {
    expect(searchWorkspace(snapshot, '  SAGE  ')[0]?.kind).toBe('ghost');
  });

  it('returns every entry for an empty query and none for a missed query', () => {
    expect(searchWorkspace(snapshot, '').length).toBeGreaterThan(4);
    expect(searchWorkspace(snapshot, '존재하지 않는 단어')).toEqual([]);
  });
});
