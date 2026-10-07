// DTOs from task-15 ghost-routing-ab-ui-contract/2; transport is not installed.
export interface RoutingCapability { schema?: 'ghost-routing-host/1'; admission: boolean; clarification_resolution: boolean; runtime_dispatch: boolean; effect_fence: boolean; verified_completion_report: boolean; model_router?: boolean; model_tool_registration?: boolean; entry_view?: boolean; immutable_evidence?:boolean;verification_scope?:string;external_mutation_dispatch?:boolean;unsupported_bound_mutation_tools?:string[] }
export interface RoutingEntry { entry_profile_id: string; conversation_id: string }
export interface RoutingOrigin extends RoutingEntry { owner_id: string; message_id: string }
export interface RoutingSegment { id: string; start_byte: number; end_byte: number }
export interface ResolutionRef { source_admission_id: string; source_segment_id: string; expected_input_hash: string; answer_segment_id: string }
export interface RoutingInput { schema: 'ghost-routing-input/1'; origin: RoutingOrigin; text: string; segments: RoutingSegment[]; resolves: ResolutionRef[] }
export interface WorkTarget { work_id: string; expected_work_revision: number; expected_decision_revision: number }
export type RoutingOperation =
 | { type: 'new'; title: string; scope: string; responsible_profile_id: string; dependencies: WorkTarget[] }
 | { type: 'amend'; target: WorkTarget; scope: string }
 | { type: 'continue' | 'cancel'; target: WorkTarget }
 | { type: 'question'; target: WorkTarget | null }
 | { type: 'clarify'; question: string; candidates: WorkTarget[] };
export interface RoutingProposal { schema: 'ghost-routing-proposal/2'; items: { segment_id: string; additional_segment_ids: string[]; operation: RoutingOperation }[] }
export type WorkStatus = 'pending' | 'cancel_requested';
export interface Work { schema: 2; id: string; owner_id: string; title: string; scope: string; responsible_profile_id: string; origin: RoutingOrigin; conversation_ids: string[]; work_revision: number; decision_revision: number; status: WorkStatus; dependency_ids: string[]; created_ms: number; updated_ms: number }
export interface SourceFragment { segment_id: string; start_byte: number; end_byte: number; text: string }
export interface Decision { schema: 2; id: string; work_id: string; revision: number; supersedes: number | null; scope: string; status: WorkStatus; source_admission_id: string; source_segment_id: string; source_fragments: SourceFragment[]; requested_text: string; created_ms: number }
export interface RoutingCandidate { target: WorkTarget; title: string; scope_excerpt: string; responsible_profile_id: string; status: WorkStatus }
export interface AcceptedSegment { segment_id: string; group_anchor_segment_id: string; work_id: string | null; work_revision: number | null; decision_revision: number | null; intent_id: string | null; operation: RoutingOperation }
export interface Admission { schema: 2; id: string; input_hash: string; proposal_hash: string; input: RoutingInput; authority_revision: string; items: AcceptedSegment[]; created_ms: number }
export interface Resolution { schema: 2; id: string; source_admission_id: string; source_segment_id: string; answer_admission_id: string; answer_segment_id: string; created_ms: number }
export interface AdmissionView { admission: Admission; resolutions: Resolution[] }
export interface RoutingView { works: Work[]; decisions: Decision[]; admissions: AdmissionView[] }
export interface RoutingTurn { kind?: 'prompt' | 'follow_up'; entry: RoutingEntry; text: string; resolves: Omit<ResolutionRef, 'answer_segment_id'>[]; clarification_target?: WorkTarget }
export const routingErrorCodes = ['target_unavailable', 'origin_unavailable', 'revision_conflict', 'input_collision', 'authority_changed', 'clarification_already_answered', 'mutation_conflict'] as const;
export type RoutingErrorCode = typeof routingErrorCodes[number];
// Explicit asynchronous disposition of a submitted routing turn. It is keyed by
// the original UUID and never derived from text; an unknown state means the
// outcome is not confirmed yet, not that the work failed.
export type RoutingPendingState = 'pending' | 'unknown' | 'cancel_requested' | 'cancelled' | 'failed';
export interface PendingRoutingRequest {
 request_id: string;
 turn: RoutingTurn;
 task_id?: string | null;
 state: RoutingPendingState;
 cancel_request_id?: string;
 cancel_message?: string;
}
export interface RoutingPendingObservation {
 request_id: string;
 state: RoutingPendingState | 'admitted';
 admission?: AdmissionView;
 task_id?: string | null;
 message?: string;
}
// Integration seam, not a claim that any control API command exists. The host
// adapter must supply authenticated origins, segmentation/proposals and reads.
export interface RoutingAdapter {
 canPrepareInput?: boolean;
 capability(): Promise<unknown>;
 view(entry: RoutingEntry): Promise<unknown>;
 receipt(entry: RoutingEntry, messageId: string): Promise<unknown>;
 prepare(turn: RoutingTurn, messageId: string): Promise<{ input: RoutingInput; proposal: RoutingProposal }>;
 admit(input: RoutingInput, proposal: RoutingProposal, requestId: string): Promise<unknown>;
 // Pure reads and the normal owner cancel command only; never a resubmission.
 observePending?(request: PendingRoutingRequest): Promise<RoutingPendingObservation>;
 cancelPending?(request: PendingRoutingRequest): Promise<RoutingPendingObservation>;
}
