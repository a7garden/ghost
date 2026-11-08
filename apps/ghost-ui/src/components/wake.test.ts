import { expect, it } from 'vitest';
import { describeWake, parseOutcome } from './wake';

const ID = '01a1ba68-182c-7456-9b69-22abd40a3b5f';

it('reads the settled Work from a report even when its title holds quotes and parentheses', () => {
  const done = parseOutcome(`Work "상자 "1m" (게임용)" (${ID}) is done.\n\n요약입니다.\n\nArtifacts:\n- result.py (60083fa5e45e, 4667 bytes)\n\nIts files are in inputs/${ID}/ in your workspace.`);
  expect(done).toEqual({ workId: ID, title: '상자 "1m" (게임용)', state: 'done', reason: '' });
  expect(parseOutcome(`Work "렌더" (${ID}) is failed.\n\nverification failed: exit 1`)).toEqual({ workId: ID, title: '렌더', state: 'failed', reason: 'verification failed: exit 1' });
  expect(parseOutcome('Work done.')).toBeNull();
});

it('names each host wake in a line and keeps the Ghost-facing text as the detail', () => {
  const start = describeWake('work', '# 주간 보고 초안\n\n이번 주 활동을 요약해 줘.\n\n## Done when\n표 하나');
  expect(start.label).toBe('맡긴 일');
  expect(start.line).toBe('주간 보고 초안');
  expect(start.detail).toContain('## Done when');

  const nudge = describeWake('work', 'You stopped without finishing. Call `complete` with the result, `delegate` part of the Work, or `ask_owner` if you are blocked.');
  expect(nudge.detail).toBeNull();
  expect(nudge.line).not.toMatch(/complete|delegate/);

  const verdict = describeWake('verdict', 'Verification asked for a revision (review):\n표가 비었습니다.\n출처 없음.\n\nFix the result and call complete again.');
  expect(verdict).toEqual({ label: '수정 요청', line: '표가 비었습니다.', detail: '표가 비었습니다.\n출처 없음.' });

  const effect = describeWake('decision', 'bash (call_8x2): exit 0');
  expect(effect).toEqual({ label: '승인 결과', line: 'exit 0', detail: null });

  const answer = describeWake('decision', 'The owner answered "어느 쪽?": 두 번째');
  expect(answer).toEqual({ label: '답변', line: '두 번째', detail: null });
});

it('falls back to the first line of an unknown wake under its origin', () => {
  expect(describeWake('schedule', '아침 브리핑\n\n어제 일 정리')).toEqual({ label: '반복 작업', line: '아침 브리핑', detail: '아침 브리핑\n\n어제 일 정리' });
});
