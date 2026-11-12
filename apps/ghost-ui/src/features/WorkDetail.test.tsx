import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QUIET_REPLY, type Message, type Verdict, type Work, type WorkDetail as WorkDetailData } from '@ghost/contract';
import { workGlyph } from '../components/agent';
import { ToolTrail, Transcript, endsInGhostRun, trailSummary } from '../components/TranscriptMessage';
import { VerdictStamp, WorkHeader } from './WorkDetail';

const verdict = (patch: Partial<Verdict> = {}): Verdict => ({
  outcome: 'revise', source: 'review', reasons: '요약이 두 문단을 건너뜁니다.', at: 1, ...patch,
});

describe('VerdictStamp render', () => {
  it('shows reasons and hides empty evidence and scope', () => {
    const markup = renderToStaticMarkup(createElement(VerdictStamp, { verdict: verdict() }));
    expect(markup).toContain('수정 지시');
    expect(markup).toContain('사유');
    expect(markup).toContain('요약이 두 문단을 건너뜁니다.');
    expect(markup).not.toContain('근거');
    expect(markup).not.toContain('수정 범위');
  });

  it('shows the observed evidence and the bound of a revision when the verdict carries them', () => {
    const markup = renderToStaticMarkup(createElement(VerdictStamp, { verdict: verdict({
      evidence: 'src/report.ts:42 — 기대: 3문단, 실제: 1문단',
      scope: '요약 문단만 고칠 수 있습니다. 데이터 수집은 그대로 둡니다.',
    }) }));
    expect(markup).toContain('근거');
    expect(markup).toContain('src/report.ts:42');
    expect(markup).toContain('수정 범위');
    expect(markup).toContain('데이터 수집은 그대로 둡니다.');
  });

  it('keeps blank evidence and scope invisible', () => {
    const markup = renderToStaticMarkup(createElement(VerdictStamp, { verdict: verdict({ evidence: '  ', scope: '' }) }));
    expect(markup).not.toContain('근거');
    expect(markup).not.toContain('수정 범위');
  });
});

const NOW = Date.UTC(2026, 10, 12, 9);
const work = (patch: Partial<Work> = {}): Work => ({
  id: 'w1', parentId: null, rootId: 'w1', ghostId: 'sage', originConversationId: 'c1', conversationId: 'cw',
  title: '리서치 보고서', brief: '조사해 줘', acceptance: { criteria: '세 문단 요약과 출처 목록', checks: [], reviewer: null }, state: 'running',
  revision: 1, revisionsUsed: 0, deadlineAt: null, result: null, verdict: null, reason: null,
  createdAt: NOW - 3_600_000, startedAt: NOW - 3_600_000, endedAt: null, updatedAt: NOW, ...patch,
});
const file = { digest: 'a'.repeat(64), name: 'report.md', mediaType: 'text/markdown', size: 1200 } as WorkDetailData['artifacts'][number];
const header = (target: Work, patch: { pending?: number; artifacts?: WorkDetailData['artifacts']; link?: string } = {}) => renderToStaticMarkup(createElement(WorkHeader, {
  work: target, ancestors: [], glyph: workGlyph(target.state, (patch.pending ?? 0) > 0), pending: patch.pending ?? 0, artifacts: patch.artifacts ?? [],
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

  it('offers 완료 기준 and 결과 자료 only when there is something to unfold, folded at first', () => {
    const markup = header(work(), { artifacts: [file, { ...file, digest: 'b'.repeat(64) }] });
    expect(markup).toMatch(/aria-expanded="false"[^>]*>.*완료 기준<\/button>/);
    expect(markup).toMatch(/결과 자료<span class="count tabular">2<\/span>/);
    expect(markup).not.toContain('세 문단 요약');
    const bare = header(work({ acceptance: { criteria: '  ', checks: [], reviewer: null } }));
    expect(bare).not.toContain('완료 기준');
    expect(bare).not.toContain('결과 자료');
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
