import { reviewOf, type Decision, type Verdict, type Work } from '@ghost/contract';

/** Reasons the Host itself writes in English, because the Ghosts read them too; the owner reads them in Korean. */
const HOST_REASONS: Record<string, string> = {
  'the deadline passed': '기한이 지났습니다',
  'the Ghost stopped without completing the Work': 'Ghost가 끝내지 않고 멈췄습니다',
  'parent Work failed': '상위 일이 실패했습니다',
  'parent Work cancelled': '상위 일이 취소됐습니다',
  'cancelled by the owner': '소유자가 취소했습니다',
  'owner revoked direct PC execution': 'PC 직접 실행 권한을 거둬 멈췄습니다',
  'owner revoked Work tool authority': '도구 권한을 거둬 멈췄습니다',
  'verification started without a result': '결과 없이 검증이 시작됐습니다',
  'verification failed': '검증을 통과하지 못했습니다',
  'the question could not be resolved because this Work has no work conversation': '작업 대화가 없어 질문을 처리하지 못했습니다',
  'imported unfinished': '이전 버전에서 끝나지 않은 채 옮겨졌습니다',
  'cancelled before import': '옮기기 전에 취소됐습니다',
};

const HOST_REASON_PATTERNS: [RegExp, (match: RegExpMatchArray) => string][] = [
  [/^cancelled from the conversation of (.+)$/, match => `${match[1]} 대화에서 취소했습니다`],
  [/^unknown outcome of \S+$/, () => '실행 결과를 알 수 없습니다'],
];

/**
 * Why a Work stopped, in the owner's words, or null while it has not. A Work ended by its verdict says so in
 * one line; the verdict's own reasons stay under the result, so they are not shown twice.
 */
export function workReason(work: Pick<Work, 'state' | 'reason' | 'verdict'>): string | null {
  if (!work.reason || !(work.state === 'failed' || work.state === 'blocked' || work.state === 'cancelled')) return null;
  if (work.state === 'failed' && work.verdict && work.reason === (work.verdict.reasons || 'verification failed')) {
    return work.verdict.outcome === 'revise' ? '수정 기회를 다 쓰고도 기준을 채우지 못했습니다' : '검증을 통과하지 못했습니다';
  }
  const fixed = HOST_REASONS[work.reason];
  if (fixed) return fixed;
  for (const [pattern, say] of HOST_REASON_PATTERNS) {
    const match = work.reason.match(pattern);
    if (match) return say(match);
  }
  return work.reason;
}

/** Verdict text that only restates who judged it. */
const RESTATED = /^(Accepted by the owner\.|accepted by the owner before import|The owner asked for changes\.|\d+ check\(s\) passed\.)$/;

/**
 * Who judged a result and what they said. A result acceptance is recorded as the owner's verdict even when the
 * main Ghost settled it for them, so the deciding card names the judge and carries the main's note.
 */
export function readVerdict(verdict: Verdict, decisions: Decision[]): { judge: string; note: string | null } {
  if (verdict.source === 'checks') return { judge: '확인 규칙', note: RESTATED.test(verdict.reasons.trim()) ? null : verdict.reasons.trim() || null };
  if (verdict.source === 'review') return { judge: '검토', note: verdict.reasons.trim() || null };
  const card = decisions.find(decision => decision.kind === 'accept_result' && decision.resolvedAt === verdict.at);
  const review = card ? reviewOf(card.proposal) : null;
  if (review?.resolvedBy === 'main') return { judge: '메인 Ghost', note: review.mainNote?.trim() || null };
  if (card) return { judge: '소유자', note: card.answer?.trim() || null };
  return { judge: '소유자', note: RESTATED.test(verdict.reasons.trim()) ? null : verdict.reasons.trim() || null };
}
