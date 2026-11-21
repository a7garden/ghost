import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CodingSessionView, CodingStep } from '@ghost/contract';
import { CodingSessionBody } from './CodingSession';

const session = (patch: Partial<CodingSessionView> = {}): CodingSessionView => ({
  id: 'a'.repeat(32), agent: 'claude', workId: 'w1', callId: 'call-1', task: '로그인 버그 고치기\n세부 설명', cwd: '/Users/garden/Workspace/Projects/wt/app-fix', branch: 'ghost/fix-login',
  nativeId: 'n-1', resumeCommand: "cd '/Users/garden/Workspace/Projects/wt/app-fix' && claude --resume n-1", startedAt: Date.UTC(2026, 10, 21, 9), endedAt: Date.UTC(2026, 10, 21, 9, 5), state: 'done', exitCode: 0, ...patch,
});
const body = (view: CodingSessionView, steps: CodingStep[]) => renderToStaticMarkup(createElement(CodingSessionBody, { session: view, steps }));
const step = (kind: CodingStep['kind'], text: string): CodingStep => ({ at: 1, kind, text });

describe('CodingSessionBody', () => {
  it('shows each kind of step as what it is, in order, and keeps the agent\'s own words as text', () => {
    const markup = body(session(), [step('say', '<b>먼저</b> 읽어 보겠습니다.'), step('tool', 'Bash: bun test'), step('result', '3 pass'), step('note', '시간이 다 됐습니다')]);
    expect(markup.indexOf('data-kind="say"')).toBeLessThan(markup.indexOf('data-kind="tool"'));
    expect(markup.indexOf('data-kind="tool"')).toBeLessThan(markup.indexOf('data-kind="result"'));
    expect(markup.indexOf('data-kind="result"')).toBeLessThan(markup.indexOf('data-kind="note"'));
    expect(markup).toContain('&lt;b&gt;먼저&lt;/b&gt;');
    expect(markup).not.toContain('<b>먼저</b>');
    expect(markup).toMatch(/<pre[^>]*>3 pass<\/pre>/);
  });

  it('gives the command that carries the session on by hand, and the place and branch it ran in', () => {
    const markup = body(session(), []);
    expect(markup).toContain("claude --resume n-1");
    expect(markup).toContain('ghost/fix-login');
    expect(markup).toContain('/Users/garden/Workspace/Projects/wt/app-fix');
    expect(markup).toContain('복사');
  });

  it('offers no command before the agent has said its session id, and no branch outside git', () => {
    const markup = body(session({ resumeCommand: null, nativeId: null, branch: null, state: 'running', endedAt: null, exitCode: null }), []);
    expect(markup).not.toContain('이어받기 명령');
    expect(markup).not.toContain('브랜치');
    expect(markup).toContain('진행 중');
    expect(markup).toContain('아직 한 일이 없습니다');
  });

  it('says a session the Host lost track of was interrupted, not failed', () => {
    expect(body(session({ state: 'interrupted', endedAt: null, exitCode: null }), [])).toContain('중단됨');
    expect(body(session({ state: 'failed', exitCode: 1 }), [])).toContain('실패');
  });
});
