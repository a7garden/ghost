import type { Decision, DecisionKind, State } from '@ghost/contract';

export const decisionLabel: Record<DecisionKind, string> = {
  approve_effect: '실행 승인', question: '답변 대기', accept_result: '결과 확인',
  document_review: '문서 검토', reconcile_effect: '결과 미확정',
};

/** A result to accept is named by its Work; every other decision by its own title. */
export function decisionHeading(decision: Decision, state: State): string {
  const work = decision.kind === 'accept_result' && decision.workId ? state.works.find(item => item.id === decision.workId) : undefined;
  return work?.title ?? decision.title;
}
