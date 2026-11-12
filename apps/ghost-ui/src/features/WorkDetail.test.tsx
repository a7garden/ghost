import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QUIET_REPLY, type Decision, type Message, type Verdict, type Work } from '@ghost/contract';
import { workGlyph } from '../components/agent';
import { ToolTrail, Transcript, endsInGhostRun, trailSummary } from '../components/TranscriptMessage';
import { VerdictStamp, WorkHeader } from './WorkDetail';
import { readVerdict, workReason } from './workText';

const verdict = (patch: Partial<Verdict> = {}): Verdict => ({
  outcome: 'revise', source: 'review', reasons: '요약이 두 문단을 건너뜁니다.', at: 1, ...patch,
});
const acceptance = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', kind: 'accept_result', ghostId: 'sage', conversationId: 'cw', workId: 'w1', effectId: null, title: '결과 확인: 리서치 보고서',
  detail: '', options: [], proposal: null, state: 'approved', answer: null, createdAt: 0, resolvedAt: 1, ...patch,
} as Decision);

describe('VerdictStamp', () => {
  it('folds what the judge said under 사유, and shows no fold when there is nothing to say', () => {
    const said = renderToStaticMarkup(createElement(VerdictStamp, { verdict: verdict(), judge: '검토', note: '요약이 두 문단을 건너뜁니다.' }));
    expect(said).toContain('수정 지시');
    expect(said).toMatch(/<summary>사유<\/summary><p>요약이 두 문단을 건너뜁니다.<\/p>/);
    expect(renderToStaticMarkup(createElement(VerdictStamp, { verdict: verdict({ outcome: 'pass' }), judge: '소유자', note: null }))).not.toContain('사유');
  });
});

describe('who judged a result', () => {
  it('names the main Ghost and carries its note when it settled the owner\'s result card', () => {
    const owner = verdict({ outcome: 'pass', source: 'owner', reasons: 'Accepted by the main Ghost for the owner after checking the report against the acceptance criteria. 기준 세 가지를 모두 확인했습니다.' });
    const card = acceptance({ proposal: { review: { recommend: 'approve', expiresAt: null, resolvedBy: 'main', mainNote: '기준 세 가지를 모두 확인했습니다.' } } });
    expect(readVerdict(owner, [card])).toEqual({ judge: '메인 Ghost', note: '기준 세 가지를 모두 확인했습니다.' });
  });

  it('keeps the owner as judge with their own words, and says nothing when the verdict only restates the acceptance', () => {
    const owner = verdict({ outcome: 'revise', source: 'owner', reasons: '출처를 붙여 주세요.' });
    expect(readVerdict(owner, [acceptance({ state: 'denied', answer: '출처를 붙여 주세요.' })])).toEqual({ judge: '소유자', note: '출처를 붙여 주세요.' });
    expect(readVerdict(verdict({ outcome: 'pass', source: 'owner', reasons: 'Accepted by the owner.' }), [])).toEqual({ judge: '소유자', note: null });
    expect(readVerdict(verdict({ outcome: 'pass', source: 'checks', reasons: '1 check(s) passed.' }), [])).toEqual({ judge: '확인 규칙', note: null });
  });
});

describe('why a Work stopped', () => {
  it('says a Work ended by its verdict in one line, leaving the verdict\'s reasons under the result', () => {
    const ended = verdict({ source: 'owner', reasons: 'The main Ghost asked for changes. 표가 서로 맞지 않습니다.' });
    const reason = workReason({ state: 'failed', verdict: ended, reason: ended.reasons });
    expect(reason).not.toContain('표가 서로 맞지 않습니다');
    expect(reason).toBe('수정 기회를 다 쓰고도 기준을 채우지 못했습니다');
  });

  it('has nothing to say while the Work runs or after it is done', () => {
    expect(workReason({ state: 'running', verdict: null, reason: 'the deadline passed' })).toBeNull();
    expect(workReason({ state: 'done', verdict: null, reason: null })).toBeNull();
  });
});

const NOW = Date.UTC(2026, 10, 12, 9);
const work = (patch: Partial<Work> = {}): Work => ({
  id: 'w1', parentId: null, rootId: 'w1', ghostId: 'sage', originConversationId: 'c1', conversationId: 'cw',
  title: '리서치 보고서', brief: '조사해 줘', acceptance: { criteria: '세 문단 요약과 출처 목록', checks: [], reviewer: null }, state: 'running',
  revision: 1, revisionsUsed: 0, deadlineAt: null, scopeId: null, attachments: [], slot: null, retry: null, budgetMinutes: 90, budgetUsedMs: 0, budgetSince: null, budgetExtended: false, hold: null, result: null, verdict: null, reason: null,
  createdAt: NOW - 3_600_000, startedAt: NOW - 3_600_000, endedAt: null, updatedAt: NOW, ...patch,
});
const header = (target: Work, patch: { pending?: number; criteria?: string; link?: string } = {}) => renderToStaticMarkup(createElement(WorkHeader, {
  work: target, ancestors: [], glyph: workGlyph(target.state, (patch.pending ?? 0) > 0), pending: patch.pending ?? 0, criteria: patch.criteria ?? target.acceptance.criteria,
  ghostName: '리서치', now: NOW, link: patch.link, navigate: () => undefined, onPending: () => undefined,
  onEdit: () => undefined, onCancel: () => undefined,
}));

describe('WorkHeader', () => {
  it('makes 확인 필요 itself the pointer to the waiting cards, counted, and says it once', () => {
    const markup = header(work(), { pending: 2 });
    expect(markup).toMatch(/<button type="button" class="work-bar__pending">.*확인 필요.*>2<\/span><\/button>/);
    expect(markup.match(/확인 필요/g)).toHaveLength(1);
    expect(header(work())).not.toContain('work-bar__pending');
  });

  it('says a passed deadline in words, not only in red, while the Work is live', () => {
    expect(header(work({ deadlineAt: NOW - 60_000 }))).toContain('기한 지남');
    expect(header(work({ deadlineAt: NOW + 60_000 }))).not.toContain('기한 지남');
    expect(header(work({ state: 'done', deadlineAt: NOW - 60_000 }))).not.toContain('기한 지남');
  });

  it('offers 완료 기준 folded, and not at all when a result card already shows it', () => {
    expect(header(work())).toMatch(/aria-expanded="false"[^>]*>.*완료 기준<\/button>/);
    expect(header(work())).not.toContain('세 문단 요약');
    expect(header(work(), { criteria: '' })).not.toContain('완료 기준');
  });

  it('drops the lifecycle and deadline once the Work has settled, and says when it ended', () => {
    const live = header(work({ deadlineAt: NOW + 60_000 }));
    expect(live).toContain('class="lifecycle');
    expect(live).toContain('맡김');
    const ended = header(work({ state: 'failed', reason: 'the deadline passed', deadlineAt: NOW - 60_000, endedAt: NOW - 60_000 }));
    expect(ended).not.toContain('class="lifecycle');
    expect(ended).not.toContain('work-bar__due');
    expect(ended).toContain('1분 전 끝남');
  });

  it('says how far behind the host the page may be while the link is down', () => {
    expect(header(work(), { link: '연결 끊김' })).toContain('연결 끊김 · 마지막 기록 방금');
    expect(header(work())).not.toContain('마지막 기록');
  });
});

const message = (id: string, role: Message['role'], text: string, patch: Partial<Message> = {}): Message => ({
  id, conversationId: 'cw', role, origin: role === 'user' ? 'owner' : null, text, toolCalls: [], tool: null, attachments: [], createdAt: Number(id.replace(/\D/g, '')) || 1, ...patch,
} as Message);
const tool = (id: string, name: string, text = 'ok', isError = false) => message(id, 'tool', text, { tool: { callId: id, name, isError } });
const speaker = (row: Message) => row.role === 'user' ? 'Ghost에게 전달' : '리서치';

describe('work conversation stream', () => {
  const rows = [
    message('m1', 'user', '보고서를 써 줘'),
    tool('m2', 'read'), tool('m3', 'read'), tool('m4', 'bash'),
    message('m5', 'assistant', '초안을 썼습니다.'),
    message('m6', 'assistant', QUIET_REPLY),
    message('m7', 'user', '출처를 더해 줘'),
    message('m8', 'assistant', '더했습니다.'),
  ];

  it("names the Ghost once per run of its rows, again after the owner speaks, and never in the direct conversation", () => {
    const markup = renderToStaticMarkup(createElement(Transcript, { messages: rows, speaker, runLabel: '리서치' }));
    expect(markup.match(/data-kind="speaker"/g)).toHaveLength(2);
    expect(markup.indexOf('data-kind="speaker"')).toBeGreaterThan(markup.indexOf('보고서를 써 줘'));
    expect(markup.indexOf('data-kind="speaker"')).toBeLessThan(markup.indexOf('data-kind="trail"'));
    expect(renderToStaticMarkup(createElement(Transcript, { messages: rows, speaker }))).not.toContain('data-kind="speaker"');
  });

  it('lets a streaming reply continue the run only when the Ghost spoke last', () => {
    expect(endsInGhostRun(rows)).toBe(true);
    expect(endsInGhostRun([...rows, message('m9', 'user', '고마워')])).toBe(false);
    expect(endsInGhostRun([message('m1', 'user', '시작'), message('m2', 'assistant', '')])).toBe(false);
  });

  it('folds tool work to what was done, in the owner\'s tool names', () => {
    expect(trailSummary(['read', 'read', 'read', 'bash'], false)).toBe('파일 읽기 3번 · 명령 실행');
    expect(trailSummary(['bash'], true)).toBe('명령 실행 중');
    expect(trailSummary(['read', 'bash', 'web_search', 'mcp__ghost__delegate_work', 'write'], false)).toBe('파일 읽기 · 명령 실행 · 웹 검색 외 2개');
    const markup = renderToStaticMarkup(createElement(ToolTrail, { results: [tool('m2', 'read'), tool('m3', 'bash', 'boom', true)] }));
    expect(markup).toContain('파일 읽기 · 명령 실행<span class="trail__failed"> · 실패 1</span>');
  });

  it('keeps a long tool name and tool output inside the trail\'s wrapping step, not on the summary line', () => {
    const name = 'mcp__ghost__delegate_work_with_a_very_long_identifier_that_never_breaks';
    const markup = renderToStaticMarkup(createElement(ToolTrail, { results: [tool('m2', name, `curl https://example.com/${'a'.repeat(200)}`)] }));
    expect(markup).toContain(`<span class="trail__count">${name}</span>`);
    expect(markup).toContain(`<span class="trail__step-name">${name}</span>`);
    expect(markup).toMatch(/<pre>curl https:\/\/example\.com\/a{200}<\/pre>/);
  });
});
