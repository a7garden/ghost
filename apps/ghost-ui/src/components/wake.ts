import type { Message } from '@ghost/contract';

/**
 * Host wakes are written for the Ghost that receives them (host core/works.ts, decisions.ts,
 * effects.ts): exact, English and full of ids. The transcript shows the owner what happened
 * in a line of their own language and keeps the Ghost's text one disclosure away.
 */

type WakeOrigin = Exclude<NonNullable<Message['origin']>, 'owner'>;

/** A settled Work as `describeOutcome` reports it to the parent or the owner. */
export interface Outcome { workId: string; title: string; state: string; reason: string }

const OUTCOME = /^Work "([\s\S]*?)" \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\) is (\w+)\.(?:\n\n([\s\S]*))?$/;

export function parseOutcome(text: string): Outcome | null {
  const match = OUTCOME.exec(text.trim());
  if (!match) return null;
  const [, title, workId, state, rest = ''] = match;
  // A settled Work carries its summary and files on the Work itself; only a failure's reason is read here.
  return { workId: workId!, title: title!, state: state!, reason: state === 'done' ? '' : rest.trim() };
}

/** How one wake reads in the transcript: a kind, one line, and the Ghost's full text when it says more. */
export interface WakeView { label: string; line: string; detail: string | null }

const originLabel: Record<WakeOrigin, string> = {
  work: '맡긴 일', child_result: '위임 결과', decision: '결정 전달', schedule: '반복 작업', verdict: '수정 요청', report: '보고',
};

const firstLine = (text: string) => text.split('\n').map(line => line.trim()).find(Boolean) ?? '';
const heading = (text: string) => /^# (.+)$/m.exec(text)?.[1]?.trim() ?? '';

type Rule = { test: RegExp; view(match: RegExpExecArray, text: string): Omit<WakeView, 'detail'> & { detail?: string | null } };

const rules: Partial<Record<WakeOrigin, Rule[]>> = {
  work: [
    { test: /^# /, view: (_match, text) => ({ label: '맡긴 일', line: heading(text) }) },
    { test: /^The owner revised this Work/, view: (_match, text) => ({ label: '수정된 지시', line: heading(text) }) },
    { test: /^The owner resumed this Work/, view: (_match, text) => ({ label: '재개', line: heading(text) }) },
    { test: /^The host restarted/, view: (_match, text) => ({ label: '다시 시작', line: heading(text) || '호스트가 다시 시작되어 이어서 진행합니다' }) },
    { test: /^Review the result of this Work/, view: (_match, text) => ({ label: '검토 요청', line: heading(text) }) },
    { test: /^You stopped without finishing/, view: () => ({ label: '이어서 진행', line: '결과 없이 멈춰서 마무리를 다시 요청했습니다', detail: null }) },
    { test: /^Nothing you were waiting on/, view: () => ({ label: '대기 끝', line: '기다리던 결정과 위임이 모두 끝났습니다', detail: null }) },
  ],
  verdict: [
    { test: /^Verification asked for a revision \(\w+\):\n([\s\S]*?)\n\nFix the result/, view: match => ({ label: '수정 요청', line: firstLine(match[1]!), detail: match[1]!.trim() }) },
  ],
  decision: [
    { test: /^The owner answered "([\s\S]*)": ([\s\S]*)$/, view: match => ({ label: '답변', line: firstLine(match[2]!) || match[1]!, detail: match[2]!.trim() }) },
    { test: /^The owner declined to answer "([\s\S]*)"\.$/, view: match => ({ label: '답변 안 함', line: match[1]!, detail: null }) },
    { test: /^The owner declined the document proposal "([\s\S]*?)"\./, view: match => ({ label: '문서 거절', line: match[1]! }) },
    { test: /^[\w.-]+ \([^)\n]*\): ([\s\S]*)$/, view: match => ({ label: '승인 결과', line: firstLine(match[1]!), detail: match[1]!.trim() }) },
  ],
};

export function describeWake(origin: WakeOrigin, text: string): WakeView {
  const trimmed = text.trim();
  for (const rule of rules[origin] ?? []) {
    const match = rule.test.exec(trimmed);
    if (!match) continue;
    const view = rule.view(match, trimmed);
    const detail = view.detail === undefined ? trimmed : view.detail;
    return { label: view.label, line: view.line || firstLine(trimmed), detail: detail && detail !== view.line ? detail : null };
  }
  const line = firstLine(trimmed);
  return { label: originLabel[origin], line, detail: trimmed !== line ? trimmed : null };
}
