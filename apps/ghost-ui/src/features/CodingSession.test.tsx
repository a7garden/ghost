import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CodingSessionView, CodingStep } from '@ghost/contract';
import { CodingSessionBody } from './CodingSessionDetail';
import { codingStartInput } from './CodingSessionStart';

const session = (patch: Partial<CodingSessionView> = {}): CodingSessionView => ({
  id: 'a'.repeat(32), agent: 'claude', workId: 'w1', callId: 'call-1', task: '로그인 버그 고치기\n세부 설명', cwd: '/Users/garden/Workspace/Projects/wt/app-fix', branch: 'ghost/fix-login',
  nativeId: 'n-1', resumeCommand: "cd '/Users/garden/Workspace/Projects/wt/app-fix' && claude --resume n-1", startedAt: Date.UTC(2026, 10, 21, 9), endedAt: Date.UTC(2026, 10, 21, 9, 5), state: 'done', exitCode: 0, ...patch,
});
const body = (view: CodingSessionView, steps: CodingStep[] = []) => renderToStaticMarkup(createElement(CodingSessionBody, {
  session: view, steps, onSend: async () => true, onStop: () => {},
}));
const step = (kind: CodingStep['kind'], text: string): CodingStep => ({ at: 1, kind, text });

describe('CodingSessionBody', () => {
  it('shows each kind of step as what it is, in order, and keeps the agent\'s own words as text', () => {
    const markup = body(session({ workId: null }), [
      step('user', '로그인 버그 고치기'), step('say', '<b>먼저</b> 읽어 보겠습니다.\n결과를 남기겠습니다.\n```ts\nconst ok = true;\n```'),
      step('tool', 'Bash:\nbun test'), step('result', '3 pass'), step('note', '시간이 다 됐습니다'),
    ]);
    expect(markup.indexOf('data-kind="user"')).toBeLessThan(markup.indexOf('data-kind="say"'));
    expect(markup.indexOf('data-kind="say"')).toBeLessThan(markup.indexOf('data-kind="tool"'));
    expect(markup.indexOf('data-kind="tool"')).toBeLessThan(markup.indexOf('data-kind="result"'));
    expect(markup.indexOf('data-kind="result"')).toBeLessThan(markup.indexOf('data-kind="note"'));
    expect(markup).toContain('&lt;b&gt;먼저&lt;/b&gt;');
    expect(markup).not.toContain('<b>먼저</b>');
    expect(markup).toContain('읽어 보겠습니다.\n결과를 남기겠습니다.');
    expect(markup).toMatch(/<pre[^>]*><code>const ok = true;<\/code><\/pre>/);
    expect(markup).toContain('Bash: bun test');
    expect(markup).toContain('<details><summary>');
    expect(markup).not.toContain('<details open');
    expect(markup).toMatch(/<pre[^>]*>3 pass<\/pre>/);
  });

  it('offers an enabled composer for an ended Ghost work session with a native id', () => {
    const markup = body(session());
    expect(markup).toContain('aria-label="이어받기 명령 복사"');
    expect(markup).toContain('ghost/fix-login');
    expect(markup).toContain('/Users/garden/Workspace/Projects/wt/app-fix');
    expect(markup).toMatch(/<textarea(?![^>]*\sdisabled="")[^>]+aria-label="후속 메시지"/);
    expect(markup).toContain('aria-label="보내기"');
    expect(markup).not.toContain('>중지<');
  });

  it('shows Stop and disables composition while working, even before the session id arrives', () => {
    const markup = body(session({ resumeCommand: null, nativeId: null, branch: null, state: 'running', endedAt: null, exitCode: null }));
    expect(markup).not.toContain('이어받기 명령');
    expect(markup).not.toContain('브랜치');
    expect(markup).toContain('진행 중');
    expect(markup).toContain('>중지</button>');
    expect(markup).toMatch(/<textarea(?=[^>]*aria-label="후속 메시지")[^>]*\sdisabled=""/);
    expect(markup).toContain('아직 에이전트 기록이 없습니다');
  });

  it('offers only terminal resumption when no in-app continuation is possible', () => {
    const markup = body(session({ nativeId: null }));
    expect(markup).not.toContain('<textarea');
    expect(markup).toContain('claude --resume n-1');
    expect(body(session({ nativeId: null, resumeCommand: null }))).toContain('에이전트 세션 ID가 없어 이어갈 수 없습니다.');
  });

  it('says a session the Host lost track of was interrupted, not failed', () => {
    expect(body(session({ state: 'interrupted', endedAt: null, exitCode: null }), [])).toContain('중단됨');
    expect(body(session({ state: 'failed', exitCode: 1 }), [])).toContain('실패');
  });
});

describe('new coding session form payload', () => {
  const data = () => {
    const fields = new FormData();
    fields.set('repo', ' /Projects/ghost ');
    fields.set('task', ' 첫 줄\n둘째 줄 ');
    return fields;
  };

  it('passes a multiline first instruction, the agent and an optional worktree branch', () => {
    const fields = data();
    fields.set('worktree', 'on');
    fields.set('branch', ' fix/login ');
    expect(codingStartInput(fields, 'claude')).toEqual({
      agent: 'claude', repo: '/Projects/ghost', task: '첫 줄\n둘째 줄', worktree: true, branch: 'fix/login',
    });
    fields.delete('branch');
    expect(codingStartInput(fields, 'claude')).not.toHaveProperty('branch');
  });

  it('sends worktree false when its checkbox is off', () => {
    expect(codingStartInput(data(), 'omp')).toEqual({
      agent: 'omp', repo: '/Projects/ghost', task: '첫 줄\n둘째 줄', worktree: false,
    });
  });

  it('resumes in the selected directory without worktree or branch fields', () => {
    const fields = data();
    fields.set('resume', ' session-123 ');
    fields.set('worktree', 'on');
    fields.set('branch', 'not-used');
    expect(codingStartInput(fields, 'codex')).toEqual({
      agent: 'codex', repo: '/Projects/ghost', task: '첫 줄\n둘째 줄', resume: 'session-123',
    });
  });
});
