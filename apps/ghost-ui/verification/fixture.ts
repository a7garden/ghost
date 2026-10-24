import type { Admission, AdmissionView, AcceptedSegment, Decision, ResolutionRef, RoutingAdapter, RoutingCapability, RoutingEntry, RoutingInput, RoutingOperation, RoutingProposal, RoutingSegment, RoutingTurn, RoutingView, SourceFragment, Work } from '../src/client/routingTypes';
import { RoutingFailure } from '../src/client/routingClient';
import type { Snapshot } from '../src/client/types';

// Verification-only scripted fixture data, kept outside src and never merged
// into a connected host. Generations 1–4 grow append-only: later generations
// keep earlier works, decisions and admissions byte-identical and only append,
// so candidate A/B reads can compare views without rewritten history.

export const entry: RoutingEntry = { entry_profile_id: 'profile-garden', conversation_id: 'conversation-garden' };

export const capability: RoutingCapability = {
  schema: 'ghost-routing-host/1',
  admission: true,
  clarification_resolution: true,
  runtime_dispatch: false,
  effect_fence: false,
  verified_completion_report: false,
  model_router: true,
  model_tool_registration: true,
  entry_view: true,
};

const owner = 'owner-garden';
const encoder = new TextEncoder();

const segmentRows = (parts: string[]): RoutingSegment[] => {
  let start = 0;
  return parts.map((text, index) => {
    const row = { id: `s${index + 1}`, start_byte: start, end_byte: start + encoder.encode(text).length };
    start = row.end_byte;
    return row;
  });
};

const fragments = (parts: string[], indexes: number[]): SourceFragment[] => {
  const rows = segmentRows(parts);
  return indexes.map(i => ({ segment_id: rows[i].id, start_byte: rows[i].start_byte, end_byte: rows[i].end_byte, text: parts[i] }));
};

const origin = (messageId: string) => ({ owner_id: owner, entry_profile_id: entry.entry_profile_id, conversation_id: entry.conversation_id, message_id: messageId });

const WORK_META: Record<string, { title: string; scope: string; createdMs: number; originMessageId: string }> = {
  'w-meeting': { title: '주간 운영 회의', scope: '팀 운영 일정과 의제 기록', createdMs: 1000, originMessageId: 'turn-1' },
  'w-blog': { title: '개발 블로그 초안', scope: '개발 경험을 다룬 블로그 초안', createdMs: 1000, originMessageId: 'turn-1' },
  'w-review': { title: '스프린트 회고', scope: '스프린트 회고 문서', createdMs: 1000, originMessageId: 'turn-1' },
  'w-compare': { title: '구독 요금제 비교 노트', scope: '구독 요금제 항목 비교', createdMs: 2000, originMessageId: 'turn-2' },
};

const workAt = (id: string, decisionRevision: number, updatedMs: number): Work => {
  const meta = WORK_META[id];
  return {
    schema: 2, id, owner_id: owner, title: meta.title, scope: meta.scope, responsible_profile_id: entry.entry_profile_id,
    origin: origin(meta.originMessageId), conversation_ids: [entry.conversation_id], work_revision: 1,
    decision_revision: decisionRevision, status: 'pending', dependency_ids: [], created_ms: meta.createdMs, updated_ms: updatedMs,
  };
};

const newOperation = (title: string, scope: string): RoutingOperation => ({ type: 'new', title, scope, responsible_profile_id: entry.entry_profile_id, dependencies: [] });
const amendOperation = (workId: string, workRevision: number, decisionRevision: number, scope: string): RoutingOperation => ({ type: 'amend', target: { work_id: workId, expected_work_revision: workRevision, expected_decision_revision: decisionRevision }, scope });

const item = (segmentId: string, operation: RoutingOperation, assignment: { workId: string | null; decisionRevision: number | null; intentId: string | null; anchor?: string }): AcceptedSegment => ({
  segment_id: segmentId,
  group_anchor_segment_id: assignment.anchor ?? segmentId,
  work_id: assignment.workId,
  work_revision: assignment.workId === null ? null : 1,
  decision_revision: assignment.decisionRevision,
  intent_id: assignment.intentId,
  operation,
});

const decision = (id: string, workId: string, revision: number, supersedes: number | null, scope: string, admissionId: string, segmentId: string, sourceFragments: SourceFragment[], requestedText: string, createdMs: number): Decision => ({
  schema: 2, id, work_id: workId, revision, supersedes, scope, status: 'pending',
  source_admission_id: admissionId, source_segment_id: segmentId, source_fragments: sourceFragments,
  requested_text: requestedText, created_ms: createdMs,
});

const admission = (id: string, text: string, parts: string[], items: AcceptedSegment[], createdMs: number): Admission => ({
  schema: 2, id, input_hash: `input-hash-${id}`, proposal_hash: `proposal-hash-${id}`,
  input: { schema: 'ghost-routing-input/1', origin: origin(id), text, segments: segmentRows(parts), resolves: [] },
  authority_revision: 'authority-1', created_ms: createdMs, items,
});

// Generation 1: the first prompt creates three works from its three segments.
const parts1 = ['주간 운영 회의를 만들고,', ' 개발 블로그 초안을 시작하고,', ' 스프린트 회고 문서도 준비해 주세요.'];
export const firstText = parts1.join('');
const turn1View: AdmissionView = {
  admission: admission('turn-1', firstText, parts1, [
    item('s1', newOperation('주간 운영 회의', '팀 운영 일정과 의제 기록'), { workId: 'w-meeting', decisionRevision: 1, intentId: 'intent-meeting-1' }),
    item('s2', newOperation('개발 블로그 초안', '개발 경험을 다룬 블로그 초안'), { workId: 'w-blog', decisionRevision: 1, intentId: 'intent-blog-1' }),
    item('s3', newOperation('스프린트 회고', '스프린트 회고 문서'), { workId: 'w-review', decisionRevision: 1, intentId: 'intent-review-1' }),
  ], 1000),
  resolutions: [],
};
const decisions1: Decision[] = [
  decision('d-meeting-1', 'w-meeting', 1, null, '팀 운영 일정 확정', 'turn-1', 's1', fragments(parts1, [0]), parts1[0], 1000),
  decision('d-blog-1', 'w-blog', 1, null, '블로그 초안 구성', 'turn-1', 's2', fragments(parts1, [1]), parts1[1].trim(), 1000),
  decision('d-review-1', 'w-review', 1, null, '회고 문서 준비', 'turn-1', 's3', fragments(parts1, [2]), parts1[2].trim(), 1000),
];

// Generation 2: two works are amended and one new work appears; w-meeting and
// its decisions stay untouched, and the admission amends two distinct works.
const parts2 = ['개발 블로그 초안 목차를 정리하고,', ' 스프린트 회고에 지난 회고 결과를 반영하고,', ' 구독 요금제 비교 노트를 새로 만들어 주세요.'];
const turn2View: AdmissionView = {
  admission: admission('turn-2', parts2.join(''), parts2, [
    item('s1', amendOperation('w-blog', 1, 1, '블로그 목차 정리'), { workId: 'w-blog', decisionRevision: 2, intentId: 'intent-blog-2' }),
    item('s2', amendOperation('w-review', 1, 1, '지난 회고 결과 반영'), { workId: 'w-review', decisionRevision: 2, intentId: 'intent-review-2' }),
    item('s3', newOperation('구독 요금제 비교 노트', '구독 요금제 항목 비교'), { workId: 'w-compare', decisionRevision: 1, intentId: 'intent-compare-1' }),
  ], 2000),
  resolutions: [],
};
const decisions2: Decision[] = [
  decision('d-blog-2', 'w-blog', 2, 1, '블로그 목차 정리', 'turn-2', 's1', fragments(parts2, [0]), parts2[0], 2000),
  decision('d-review-2', 'w-review', 2, 1, '지난 회고 결과 반영', 'turn-2', 's2', fragments(parts2, [1]), parts2[1].trim(), 2000),
  decision('d-compare-1', 'w-compare', 1, null, '요금제 비교 항목 구성', 'turn-2', 's3', fragments(parts2, [2]), parts2[2].trim(), 2000),
];

// Generation 3: one ambiguous segment stays waiting (clarify, unresolved) while
// the compare-note request in the same admission is admitted with a decision.
const parts3 = ['새로 쓴 문단을 블로그 초안과 비교 노트 중 어느 쪽에 넣을까요?', ' 비교 노트에는 환불 정책 행도 추가해 주세요.'];
const turn3View: AdmissionView = {
  admission: admission('turn-3', parts3.join(''), parts3, [
    item('s1', { type: 'clarify', question: parts3[0], candidates: [
      { work_id: 'w-blog', expected_work_revision: 1, expected_decision_revision: 2 },
      { work_id: 'w-compare', expected_work_revision: 1, expected_decision_revision: 1 },
    ] }, { workId: null, decisionRevision: null, intentId: null }),
    item('s2', amendOperation('w-compare', 1, 1, '환불 정책 행 추가'), { workId: 'w-compare', decisionRevision: 2, intentId: 'intent-compare-3' }),
  ], 3000),
  resolutions: [],
};
const decisions3: Decision[] = [
  decision('d-compare-2', 'w-compare', 2, 1, '환불 정책 행 추가', 'turn-3', 's2', fragments(parts3, [1]), parts3[1].trim(), 3000),
];

// Generation 4: segments s1 and s3 belong to one blog intent (noncontiguous
// sources around the review segment s2), producing one decision per group.
const parts4 = ['블로그 도입부에 최신 통계를 넣어 주세요.', ' 회고 문서에는 유입표를 그대로 옮기고,', ' 블로그 결론에는 다음 단계 링크를 추가해 주세요.'];
const turn4View: AdmissionView = {
  admission: admission('turn-4', parts4.join(''), parts4, [
    item('s1', amendOperation('w-blog', 1, 2, '블로그 도입부 보강'), { workId: 'w-blog', decisionRevision: 3, intentId: 'intent-blog-4' }),
    item('s2', amendOperation('w-review', 1, 2, '회고에 유입표 수치 반영'), { workId: 'w-review', decisionRevision: 3, intentId: 'intent-review-4' }),
    item('s3', amendOperation('w-blog', 1, 2, '블로그 결론 보강'), { workId: 'w-blog', decisionRevision: 3, intentId: 'intent-blog-4', anchor: 's1' }),
  ], 4000),
  resolutions: [],
};
const decisions4: Decision[] = [
  decision('d-blog-3', 'w-blog', 3, 2, '블로그 도입부와 결론 보강', 'turn-4', 's1', fragments(parts4, [0, 2]), `${parts4[0]} ${parts4[2].trim()}`, 4000),
  decision('d-review-3', 'w-review', 3, 2, '회고에 유입표 수치 반영', 'turn-4', 's2', fragments(parts4, [1]), parts4[1].trim(), 4000),
];

const generations: Record<1 | 2 | 3 | 4, RoutingView> = {
  1: { works: [workAt('w-meeting', 1, 1000), workAt('w-blog', 1, 1000), workAt('w-review', 1, 1000)], decisions: decisions1, admissions: [turn1View] },
  2: { works: [workAt('w-meeting', 1, 1000), workAt('w-blog', 2, 2000), workAt('w-review', 2, 2000), workAt('w-compare', 1, 2000)], decisions: [...decisions1, ...decisions2], admissions: [turn1View, turn2View] },
  3: { works: [workAt('w-meeting', 1, 1000), workAt('w-blog', 2, 2000), workAt('w-review', 2, 2000), workAt('w-compare', 2, 3000)], decisions: [...decisions1, ...decisions2, ...decisions3], admissions: [turn1View, turn2View, turn3View] },
  4: { works: [workAt('w-meeting', 1, 1000), workAt('w-blog', 3, 4000), workAt('w-review', 3, 4000), workAt('w-compare', 2, 3000)], decisions: [...decisions1, ...decisions2, ...decisions3, ...decisions4], admissions: [turn1View, turn2View, turn3View, turn4View] },
};

export const fixtureView = (generation: 1 | 2 | 3 | 4 = 4): RoutingView => structuredClone(generations[generation]);

export const fixtureSnapshot = (): Snapshot => ({
  workspace_id: 'ghost-ui-verification', avatars: [], default_model: 'mock', capabilities: {}, connectors: {},
  todos: [], calendar_events: [], integrations: [], reviews: [], goals: [], schedules: [], spaces: [], delegations: [],
  profiles: [{
    id: entry.entry_profile_id, name: 'Garden', persona: '작업 기록을 직접 정리하는 사용자', policy: {},
    conversations: [{
      id: entry.conversation_id, title: '과업 접수 기록', model: 'mock', offline: false,
      messages: [
        { role: 'user', text: firstText, request_id: 'turn-1', task_id: 'router' },
        { role: 'assistant', text: '세 가지 과업을 접수했습니다. 각 요청의 진행 상태는 요청 목록에서 확인할 수 있습니다.', task_id: 'router' },
      ],
      tasks: [],
    }],
  }],
});

const preparedTurn = (turn: RoutingTurn, messageId: string): { input: RoutingInput; proposal: RoutingProposal } => {
  const operation: RoutingOperation = turn.clarification_target
    ? { type: 'amend', target: turn.clarification_target, scope: '확인한 과업에 내용을 반영합니다.' }
    : { type: 'new', title: turn.text.slice(0, 20), scope: '검증 스크립트 접수', responsible_profile_id: turn.entry.entry_profile_id, dependencies: [] };
  const input: RoutingInput = {
    schema: 'ghost-routing-input/1',
    origin: origin(messageId),
    text: turn.text,
    segments: [{ id: 's1', start_byte: 0, end_byte: encoder.encode(turn.text).length }],
    resolves: turn.resolves.map((ref: Omit<ResolutionRef, 'answer_segment_id'>): ResolutionRef => ({ ...ref, answer_segment_id: 'answer' })),
  };
  return { input, proposal: { schema: 'ghost-routing-proposal/2', items: [{ segment_id: 's1', additional_segment_ids: [], operation }] } };
};

const admitted = (input: RoutingInput, proposal: RoutingProposal, requestId: string): Admission => ({
  schema: 2,
  id: `admission-${requestId}`,
  input_hash: `input-hash-${requestId}`,
  proposal_hash: `proposal-hash-${requestId}`,
  input,
  authority_revision: 'authority-1',
  created_ms: 1000,
  items: proposal.items.map(itemMap => {
    const operation = itemMap.operation;
    const workId = operation.type === 'new' ? 'w-scripted' : operation.type === 'clarify' || operation.type === 'question' ? null : operation.target.work_id;
    return {
      segment_id: itemMap.segment_id,
      group_anchor_segment_id: itemMap.segment_id,
      work_id: workId,
      work_revision: workId === null ? null : 1,
      decision_revision: workId === null ? null : 1,
      intent_id: `intent-${itemMap.segment_id}`,
      operation,
    };
  }),
});

// Scripted routing host for the uninstalled-candidate seam: prepares one
// segment per turn, records every prepare/admit, and keeps canonical receipts
// keyed by the submission UUID. Flags replay the failure modes the client must
// distinguish: a lost ACK (receipt committed, reply gone), an authority change,
// and a revision conflict.
export class FixtureAdapter implements RoutingAdapter {
  readonly calls: string[] = [];
  readonly receipts = new Map<string, AdmissionView>();
  preparations = 0;
  loseResponse = false;
  revoked = false;
  stale = false;

  async capability(): Promise<unknown> { return capability; }
  async view(): Promise<unknown> { return fixtureView(); }
  async receipt(_entryParameter: RoutingEntry, messageId: string): Promise<unknown> { return this.receipts.get(messageId) ?? null; }

  async prepare(turn: RoutingTurn, messageId: string): Promise<{ input: RoutingInput; proposal: RoutingProposal }> {
    this.preparations += 1;
    this.calls.push(`prepare:${messageId}`);
    return preparedTurn(turn, messageId);
  }

  async admit(input: RoutingInput, proposal: RoutingProposal, requestId: string): Promise<unknown> {
    this.calls.push(`admit:${requestId}`);
    if (this.revoked) throw new RoutingFailure('authority_changed');
    if (this.stale) throw new RoutingFailure('revision_conflict');
    // The client normalizes the raw admission itself; receipts are views.
    const admission = admitted(input, proposal, requestId);
    this.receipts.set(requestId, { admission, resolutions: [] });
    if (this.loseResponse) throw new Error(`접수 응답(ACK)을 전달하지 못했습니다: ${requestId}`);
    return admission;
  }
}
