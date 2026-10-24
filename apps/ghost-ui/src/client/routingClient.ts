import type { CommandQueue } from './api';
import { ConfirmedFailure } from './errors';
import { normalizeAdmission, normalizeAdmissionView, normalizeRoutingCapability, normalizeRoutingInput, normalizeRoutingProposal, normalizeRoutingView } from './routingNormalize';
import { routingErrorCodes } from './routingTypes';
import type { AdmissionView, PendingRoutingRequest, RoutingAdapter, RoutingErrorCode, RoutingInput, RoutingPendingObservation, RoutingPendingState, RoutingProposal, RoutingTurn } from './routingTypes';
import type { Client, Envelope, RoutingPendingMetadata } from './types';
export class RoutingFailure extends ConfirmedFailure {
 constructor(public readonly code: RoutingErrorCode) { super(routingErrorMessage(code)); this.name = 'RoutingFailure'; }
}
export const routingErrorMessage = (code: RoutingErrorCode) => ({
 target_unavailable: '이 작업에 접근할 수 없습니다. 현재 권한과 작업을 다시 확인해 주세요.',
 origin_unavailable: '이 대화에서 요청을 접수할 수 없습니다. 대화와 접근 권한을 확인해 주세요.',
 revision_conflict: '작업의 요구사항이 다른 곳에서 변경됐습니다. 최신 작업 기록을 확인한 뒤 다시 보내 주세요.',
 input_collision: '같은 메시지 ID에 다른 내용이 있습니다. 기존 접수 결과를 확인해 주세요.',
 authority_changed: '요청 중 권한이 변경됐습니다. 현재 허용 범위를 확인한 뒤 다시 보내 주세요.',
 mutation_conflict: '같은 작업에 겹치는 변경이 있습니다. 정정 범위를 확인한 뒤 다시 보내 주세요.',
 clarification_already_answered: '이 확인 질문은 이미 답변됐습니다. 저장된 답변을 다시 불러올게요.',
}[code]);
// Called by the future adapter for structured error codes, never error strings.
export function normalizeRoutingFailure(value: unknown): RoutingFailure | null {
 const code = value && typeof value === 'object' ? ((value as { error_code?: unknown; code?: unknown }).error_code ?? (value as { code?: unknown }).code) : undefined;
 return typeof code === 'string' && routingErrorCodes.some(c => c === code) ? new RoutingFailure(code as RoutingErrorCode) : null;
}
export function assertInput(input: RoutingInput, turn: RoutingTurn, messageId: string) {
 const refs = input.resolves.map(({ source_admission_id, source_segment_id, expected_input_hash }) => ({ source_admission_id, source_segment_id, expected_input_hash }));
 const expected = turn.resolves.map(({ source_admission_id, source_segment_id, expected_input_hash }) => ({ source_admission_id, source_segment_id, expected_input_hash }));
 if (input.origin.message_id !== messageId || input.origin.entry_profile_id !== turn.entry.entry_profile_id || input.origin.conversation_id !== turn.entry.conversation_id || input.text !== turn.text || JSON.stringify(refs) !== JSON.stringify(expected)) throw new RoutingFailure('input_collision');
}
export function preparedFromReceipt(view: AdmissionView): {input:RoutingInput;proposal:RoutingProposal} {
 const admission = view.admission;
 return {input:admission.input,proposal:{schema:'ghost-routing-proposal/2',items:admission.items.filter(i=>i.segment_id===i.group_anchor_segment_id).map(i=>({segment_id:i.segment_id,additional_segment_ids:admission.items.filter(m=>m.group_anchor_segment_id===i.segment_id&&m.segment_id!==i.segment_id).map(m=>m.segment_id),operation:i.operation}))}};
}
export class RoutingClient {
 constructor(private adapter: RoutingAdapter, private queue: CommandQueue) {}
 async capability() { return normalizeRoutingCapability(await this.adapter.capability()); }
 async view(entry: RoutingTurn['entry']) { return normalizeRoutingView(await this.adapter.view(entry)); }
 // The journal view of unresolved routing turns for one entry: the original
 // UUID, exact turn and persisted disposition. Purely local, never a submit.
 async pending(entry: RoutingTurn['entry']): Promise<PendingRoutingRequest[]> { return this.queue.pendingRouting(entry); }
 // Pure requery of one pending request, resolved against the persisted record so
 // a stale caller object cannot observe or settle a stale disposition. A
 // canonical admission clears exactly its own envelope; a confirmed terminal
 // outcome persists until dismissal.
 async pollPending(request: PendingRoutingRequest): Promise<RoutingPendingObservation> {
  if (!this.adapter.observePending) throw new Error('이 호스트는 접수 상태 조회를 지원하지 않습니다.');
  const current = (await this.queue.pendingRouting(request.turn.entry)).find(record=>record.request_id===request.request_id);
  const authoritative = current?.request_id === request.request_id ? current : request;
  return this.settlePending(authoritative, await this.adapter.observePending(authoritative));
 }
 async cancelPending(request: PendingRoutingRequest): Promise<RoutingPendingObservation> {
  if (!this.adapter.cancelPending) throw new Error('이 호스트는 접수 취소를 지원하지 않습니다.');
  // The cancellation identity lives in the persisted envelope: a caller holding
  // a stale request object after a lost reply must reuse the reserved UUID.
  const current = (await this.queue.pendingRouting(request.turn.entry)).find(record=>record.request_id===request.request_id);
  const record = current?.request_id === request.request_id ? current : undefined;
  const cancel_request_id = record?.cancel_request_id ?? request.cancel_request_id ?? crypto.randomUUID();
  // The intent and its stable UUID persist before the dispatch; they stay on a
  // lost or unknown reply, and only the observed receipt/SDK terminal closes it.
  await this.queue.patchPendingRouting(request.request_id, { state: 'cancel_requested', cancel_request_id });
  return this.settlePending(request, await this.adapter.cancelPending({ ...(record ?? request), cancel_request_id }));
 }
 // Only a confirmed terminal outcome or an already admitted request may leave
 // the journal. The authoritative record is requeried first — a stale caller
 // object that claims a terminal state never clears an active or unknown request.
 async dismissPending(request: PendingRoutingRequest): Promise<void> {
  const current = (await this.queue.pendingRouting(request.turn.entry)).find(record=>record.request_id===request.request_id);
  const authoritative = current?.request_id === request.request_id ? current : request;
  const observation = await this.pollPending(authoritative);
  if (observation.state !== 'admitted' && observation.state !== 'cancelled' && observation.state !== 'failed') throw new Error('아직 결과가 확인되지 않은 요청은 지울 수 없습니다. 먼저 접수 상태를 다시 확인해 주세요.');
  await this.queue.clearPendingRouting(request.request_id);
 }
 // Journal states never regress: unknown < pending < cancel_requested < terminal.
 private static rank(state: RoutingPendingState) { return ['unknown', 'pending', 'cancel_requested', 'cancelled', 'failed'].indexOf(state); }
 private async settlePending(request: PendingRoutingRequest, observation: RoutingPendingObservation): Promise<RoutingPendingObservation> {
  if (observation.state === 'admitted' && observation.admission) {
   assertInput(observation.admission.admission.input, request.turn, request.request_id);
   await this.queue.clearPendingRouting(request.request_id);
   return observation;
  }
  // Persist what the pure read observed: a newly identified SDK task makes the
  // pending request cancellable from the journal alone, and observed state
  // changes are kept unless they would regress an already recorded intent.
  const current = (await this.queue.pendingRouting(request.turn.entry)).find(record=>record.request_id===request.request_id);
  const record = current?.request_id === request.request_id ? current : undefined;
  const patch: Partial<RoutingPendingMetadata> = {};
  if (observation.task_id && observation.task_id !== record?.task_id) patch.task_id = observation.task_id;
  if (observation.state !== 'admitted' && observation.state !== record?.state && (!record || RoutingClient.rank(observation.state) >= RoutingClient.rank(record.state))) patch.state = observation.state;
  if (patch.state || patch.task_id) await this.queue.patchPendingRouting(request.request_id, patch);
  return observation;
 }
 async submit(turn: RoutingTurn): Promise<AdmissionView> {
  if (!(await this.capability()).admission) throw new Error('이 호스트는 작업 접수를 지원하지 않습니다.');
  if (turn.resolves.length && !(await this.capability()).clarification_resolution) throw new Error('이 호스트는 대상 확인 답변을 지원하지 않습니다.');
  let recovered: AdmissionView | null = null;
  const receipt = async (messageId: string) => {
   const r = await this.adapter.receipt(turn.entry, messageId);
   if (r === null) return null;
   const view = normalizeAdmissionView(r); assertInput(view.admission.input, turn, messageId); return view;
  };
  const bridge = { action: async (e: Envelope) => {
   // Recover the immutable receipt before any re-proposal or redispatch.
   recovered = await receipt(e.request_id);
   if (recovered) return recovered;
   const p = e.command.prepared as { input: RoutingInput; proposal: RoutingProposal };
   const input = normalizeRoutingInput(p.input), proposal = normalizeRoutingProposal(p.proposal);
   assertInput(input, turn, e.request_id);
   const admission = normalizeAdmission(await this.adapter.admit(input, proposal, e.request_id));
   assertInput(admission.input, turn, e.request_id);
   return { admission, resolutions: [] };
  } } as unknown as Client;
  const result = await this.queue.send(bridge, { type: 'routing_turn', turn }, async e => {
   recovered = await receipt(e.request_id);
   // This value is persisted only in the pending request envelope, not a Work store.
   const prepared = recovered ? preparedFromReceipt(recovered) : await this.adapter.prepare(e.command.turn as RoutingTurn, e.request_id);
   const input = normalizeRoutingInput(prepared.input), proposal = normalizeRoutingProposal(prepared.proposal);
   assertInput(input, turn, e.request_id);
   return { ...e.command, prepared: { input, proposal } };
  });
  return normalizeAdmissionView(result);
 }
}
