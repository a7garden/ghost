import type { IntegrationApproval, Review, Snapshot } from '../client/types';

export type ApprovalKind = 'document' | 'integration';
export type ApprovalRef = { kind: ApprovalKind; id: string };
export type Approval =
  | { kind: 'document'; id: string; ghostId: string; conversationId: string; review: Review }
  | { kind: 'integration'; id: string; ghostId: string; conversationId: string; review: IntegrationApproval };
export type ApprovalGroup = 'pending' | 'running' | 'followup' | 'finished';

export const approvalGroups: Record<ApprovalGroup, string> = {
  pending: '결정 대기',
  running: '실행 중',
  followup: '결과 확인',
  finished: '처리 완료',
};

export function approvals(snapshot: Snapshot): Approval[] {
  return [
    ...snapshot.reviews.map(review => ({
      kind: 'document' as const, id: review.id, ghostId: review.profile_id, conversationId: review.conversation_id, review,
    })),
    ...(snapshot.integrationApprovals ?? []).map(review => ({
      kind: 'integration' as const, id: review.id, ghostId: review.ghost_id, conversationId: review.conversation_id, review,
    })),
  ];
}

export const approvalKey = (ref: ApprovalRef) => `${ref.kind}:${ref.id}`;

export function approvalGroup(item: Approval): ApprovalGroup {
  switch (item.review.state) {
    case 'pending': return 'pending';
    case 'dispatching': return 'running';
    // A document in approved state may already have been written. Host's
    // existing same-ID recovery path can reconcile it.
    case 'approved':
    case 'failed':
    case 'uncertain': return 'followup';
    default: return 'finished';
  }
}

export function approvalState(item: Approval) {
  switch (item.review.state) {
    case 'pending': return approvalGroups.pending;
    case 'approved': return '저장 결과 확인 필요';
    case 'dispatching': return '외부 요청 실행 중';
    case 'saved': return '저장 완료';
    case 'sent': return '연동 실행 완료';
    case 'failed': return '실행 실패';
    case 'uncertain': return '외부 결과 미확정';
    case 'declined': return '거절됨';
    default: return '상태 확인 필요';
  }
}

export const isEmailApproval = (tool: string) => tool === 'send_gmail_message' || tool === 'send_email';

export function readableApprovalField(name: string) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').trim() || '항목';
}

export function integrationApprovalTitle(tool: string) {
  if (isEmailApproval(tool)) return '이메일 보내기';
  return readableApprovalField(tool);
}

export const approvalTitle = (item: Approval) =>
  item.kind === 'document' ? item.review.title : integrationApprovalTitle(item.review.tool);

export const approvalSubject = (item: Approval, snapshot: Snapshot) => item.kind === 'document'
  ? snapshot.spaces.find(space => space.id === item.review.space_id)?.name
  : item.review.integration_name;

type IntegrationIdentity = Pick<IntegrationApproval, 'id' | 'ghost_id' | 'conversation_id' | 'integration_id' | 'integration_name' | 'tool' | 'created_ms'>;

export function sameIntegrationRequest(a: IntegrationIdentity, b: Partial<IntegrationIdentity> | Record<string, unknown>) {
  return a.id === b.id && a.ghost_id === b.ghost_id && a.conversation_id === b.conversation_id
    && a.integration_id === b.integration_id && a.integration_name === b.integration_name
    && a.tool === b.tool && a.created_ms === b.created_ms;
}

export function integrationReceipt(expected: IntegrationIdentity, result: Record<string, unknown>): IntegrationApproval | undefined {
  if (!sameIntegrationRequest(expected, result)) return;
  const { state } = result;
  if (state === 'pending' || state === 'dispatching' || state === 'sent' || state === 'failed' || state === 'uncertain' || state === 'declined') {
    return { ...expected, state };
  }
}

export function inspectedIntegrationApproval(expected: IntegrationIdentity, result: Record<string, unknown>) {
  const summary = integrationReceipt(expected, result);
  const args = result.arguments;
  if (summary && args && typeof args === 'object' && !Array.isArray(args)) {
    const output = result.result as { text?: unknown; truncated?: unknown } | undefined;
    return {
      summary, arguments: args as Record<string, unknown>, approvalAllowed: result.approval_allowed === true,
      ...(output && typeof output.text === 'string' && typeof output.truncated === 'boolean'
        ? { output: { text: output.text, truncated: output.truncated } } : {}),
    };
  }
}
