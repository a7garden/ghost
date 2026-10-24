import { normalizeAdmission, normalizeAdmissionView, normalizeDecision, normalizeRoutingCapability, normalizeRoutingInput, normalizeRoutingProposal, normalizeWork, normalizeRoutingView } from './routingNormalize';
import { ConfirmedFailure, RoutingPending, RoutingTerminal } from './errors';
import { assertInput, preparedFromReceipt } from './routingClient';
import type { Envelope, Snapshot } from './types';
import type { AdmissionView, PendingRoutingRequest, RoutingAdapter, RoutingEntry, RoutingInput, RoutingPendingObservation, RoutingProposal, RoutingView, RoutingTurn } from './routingTypes';

export type RoutingSend = (envelope: Envelope) => Promise<unknown>;
const entryDTO = (entry: RoutingEntry) => ({ profile_id: entry.entry_profile_id, conversation_id: entry.conversation_id });

// Actual ghost-routing-host/1 control operations. No frontend classification,
// owner grant, inferred completion or invented projection endpoint.
export class HostRoutingTransport {
 constructor(private send: RoutingSend, private readSnapshot?: () => Promise<Snapshot>) {}
 private query(action: Record<string, unknown>) {
  return this.send({ request_id: crypto.randomUUID(), command: { type: 'routing', action } });
 }
 async capability() {
  const result = await this.query({ type: 'routing_capability' });
  if (!result || typeof result !== 'object' || (result as { schema?: unknown }).schema !== 'ghost-routing-host/1') throw new Error('이 호스트의 작업 접수 형식을 지원하지 않습니다.');
  return normalizeRoutingCapability(result);
 }
 async candidates(entry: RoutingEntry, query = '', limit = 50) {
  const result = await this.query({ type: 'routing_candidates', entry: entryDTO(entry), query, limit });
  if (!Array.isArray(result)) throw new Error('작업 후보 응답을 확인할 수 없습니다.');
  return result;
 }
 async work(entry: RoutingEntry, workId: string) {
  return normalizeWork(await this.query({ type: 'routing_work', entry: entryDTO(entry), work_id: workId }));
 }
 async decisions(entry: RoutingEntry, workId: string) {
  const result = await this.query({ type: 'routing_decisions', entry: entryDTO(entry), work_id: workId });
  if (!Array.isArray(result)) throw new Error('작업 기록 응답을 확인할 수 없습니다.');
  return result.map(normalizeDecision);
 }
 async view(entry: RoutingEntry): Promise<RoutingView> {
  if ((await this.capability()).entry_view !== true) throw new Error('호스트가 작업 접수 기록 조회를 제공하지 않습니다.');
  const works = new Map<string, RoutingView['works'][number]>(), decisions = new Map<string, RoutingView['decisions'][number]>(), admissions = new Map<string, RoutingView['admissions'][number]>();
  const seen = new Set<string>(); let cursor: string | null = null;
  do {
   const raw = await this.query({ type: 'routing_view', entry: entryDTO(entry), limit: 50, before_admission_id: cursor });
   if (!raw || typeof raw !== 'object' || (raw as {schema?: unknown}).schema !== 'ghost-routing-view/1') throw new Error('작업 접수 기록 계약을 확인할 수 없습니다.');
   const next = (raw as {next_before_admission_id?: unknown}).next_before_admission_id;
   if (next !== null && (typeof next !== 'string' || !next || seen.has(next))) throw new Error('작업 접수 기록 페이지를 확인할 수 없습니다.');
   const page = normalizeRoutingView(raw);
   for (const work of page.works) {
    const saved = works.get(work.id);
    if (!saved || work.work_revision > saved.work_revision) works.set(work.id, work);
    else if (work.work_revision === saved.work_revision && JSON.stringify(work) !== JSON.stringify(saved)) throw new Error('작업 버전이 일치하지 않습니다.');
   }
   for (const decision of page.decisions) {
    const saved = decisions.get(decision.id);
    if (saved && JSON.stringify(saved) !== JSON.stringify(decision)) throw new Error('작업 기록이 일치하지 않습니다.');
    decisions.set(decision.id, decision);
   }
   for (const view of page.admissions) {
    const origin = view.admission.input.origin;
    if (origin.entry_profile_id !== entry.entry_profile_id || origin.conversation_id !== entry.conversation_id || admissions.has(view.admission.id)) throw new Error('접수 기록의 대화가 일치하지 않습니다.');
    admissions.set(view.admission.id, view);
   }
   cursor = next as string | null;
   if (cursor) seen.add(cursor);
  } while (cursor);
  return {works: [...works.values()], decisions: [...decisions.values()], admissions: [...admissions.values()].sort((a,b)=>a.admission.created_ms-b.admission.created_ms || a.admission.id.localeCompare(b.admission.id))};
 }
 async receipt(entry: RoutingEntry, messageId: string) {
  const result = await this.query({ type: 'routing_receipt', entry: entryDTO(entry), message_id: messageId });
  return result === null ? null : normalizeAdmissionView(result);
 }
 async prepare(turn: RoutingTurn, requestId: string, options: {timeoutMs?:number;pollMs?:number} = {}) {
  const capability = await this.capability();
  if (!capability.model_router || !capability.model_tool_registration) throw new Error('호스트의 모델 작업 분류 경로가 아직 준비되지 않았습니다.');
  let response: unknown;
  try { response = await this.send({request_id:requestId,command:{type:'routing',action:{
   type:'routing_natural',entry:entryDTO(turn.entry),text:turn.text,kind:turn.kind??'prompt',
   resolves:turn.resolves.map(ref=>({...ref,answer_segment_id:'answer'})),clarification_target:turn.clarification_target??null,
  }}}); } catch (error) {
   if (error instanceof ConfirmedFailure) throw error;
   throw new RoutingPending(requestId, turn.entry, 'unknown');
  }
  if (!response || typeof response!=='object') throw new RoutingPending(requestId,turn.entry,'unknown');
  const r=response as {routing_pending?:unknown;submission?:{request_id?:unknown;conversation_id?:unknown;task_id?:unknown}};
  if(r.routing_pending!==true || r.submission?.request_id!==requestId || r.submission.conversation_id!==turn.entry.conversation_id || typeof r.submission.task_id!=='string') throw new RoutingPending(requestId,turn.entry,'unknown');
  const deadline=Date.now()+(options.timeoutMs??25000);
  while(Date.now()<deadline) {
   const view=await this.receipt(turn.entry,requestId);
   if(view)return preparedFromReceipt(view);
   if(this.readSnapshot) {
    const snapshot=await this.readSnapshot();
    const task=snapshot.profiles.find(p=>p.id===turn.entry.entry_profile_id)?.conversations.find(c=>c.id===turn.entry.conversation_id)?.tasks.find(t=>t.id===r.submission!.task_id);
    if(task&&['failed','cancelled','complete'].includes(task.phase)) {
     const final=await this.receipt(turn.entry,requestId);
     if(final)return preparedFromReceipt(final);
     // Confirmed terminal outcome without a canonical admission: an explicit
     // terminal record for the exact request, not a retryable validation failure.
     throw new RoutingTerminal(requestId,turn.entry,task.phase==='cancelled'?'cancelled':'failed',r.submission.task_id,
      task.phase==='cancelled'?'요청이 취소로 끝났지만 요청을 접수하지 못했습니다. 모델과 요청을 확인한 뒤 다시 보내 주세요.'
      :'분류 응답이 끝났지만 요청을 접수하지 못했습니다. 모델과 요청을 확인한 뒤 다시 보내 주세요.');
    }
   }
   await new Promise(resolve=>setTimeout(resolve,options.pollMs??500));
  }
  // The validated ACK is an asynchronous acceptance, not failed work: surface
  // the exact UUID and SDK task so callers keep the same request alive.
  throw new RoutingPending(requestId, turn.entry, 'pending', r.submission.task_id);
 }
 // Canonical receipt for the exact original UUID, validated against the original
 // turn; never matched by text.
 private async checkedReceipt(turn: RoutingTurn, messageId: string): Promise<AdmissionView | null> {
  const view = await this.receipt(turn.entry, messageId);
  if (!view) return null;
  assertInput(view.admission.input, turn, messageId);
  return view;
 }
 // The SDK task of a legacy pending turn comes only from messages carrying the
 // exact original request UUID; ambiguous or null task ids stay unknown.
 private messageTaskId(snapshot: Snapshot, request: PendingRoutingRequest): string | null {
  const conversation = snapshot.profiles.find(p => p.id === request.turn.entry.entry_profile_id)?.conversations.find(c => c.id === request.turn.entry.conversation_id);
  const ids = new Set((conversation?.messages ?? []).filter(m => m.request_id === request.request_id).map(m => m.task_id).filter((t): t is string => typeof t === 'string'));
  return ids.size === 1 ? [...ids][0] : null;
 }
 // Pure read of one pending turn: canonical receipt first, then the exact SDK
 // task of the request's own profile/conversation. Never dispatches
 // routing_natural; read failures keep the persisted state and never mark the
 // request failed, while the receipt wins even when it commits during a
 // terminal read.
 async observePending(request: PendingRoutingRequest): Promise<RoutingPendingObservation> {
  const entry = request.turn.entry;
  const resting = (): RoutingPendingObservation => ({ request_id: request.request_id, state: request.state, task_id: request.task_id ?? null });
  let view: AdmissionView | null;
  try { view = await this.checkedReceipt(request.turn, request.request_id); }
  catch (e) { if (e instanceof ConfirmedFailure) throw e; return resting(); }
  if (view) return { request_id: request.request_id, state: 'admitted', admission: view, task_id: request.task_id ?? null };
  if (!this.readSnapshot) return resting();
  try {
   const snapshot = await this.readSnapshot();
   const task_id = request.task_id ?? this.messageTaskId(snapshot, request);
   if (!task_id) return { request_id: request.request_id, state: request.state, task_id: null };
   const task = snapshot.profiles.find(p => p.id === entry.entry_profile_id)?.conversations.find(c => c.id === entry.conversation_id)?.tasks.find(t => t.id === task_id);
   if (!task || !['failed', 'cancelled', 'complete'].includes(task.phase)) return { request_id: request.request_id, state: request.state, task_id };
   const final = await this.checkedReceipt(request.turn, request.request_id);
   if (final) return { request_id: request.request_id, state: 'admitted', admission: final, task_id };
   if (task.phase === 'cancelled') return { request_id: request.request_id, state: 'cancelled', task_id };
   return { request_id: request.request_id, state: 'failed', task_id, message: task.phase === 'complete'
    ? '분류가 끝났지만 이 요청의 접수 결과가 없습니다. 모델과 요청 내용을 확인한 뒤 다시 보내 주세요.'
    : '요청 처리가 실패로 끝났습니다. 모델과 요청 내용을 확인한 뒤 다시 보내 주세요.' };
  } catch (e) { if (e instanceof ConfirmedFailure) throw e; return resting(); }
 }
 // Cancels through the normal owner command under a separate stable UUID. An
 // already admitted request is never cancelled, and a task that cannot be
 // identified exactly stays unknown for requery instead of being guessed.
 async cancelPending(request: PendingRoutingRequest): Promise<RoutingPendingObservation> {
  const admitted = await this.checkedReceipt(request.turn, request.request_id);
  if (admitted) return { request_id: request.request_id, state: 'admitted', admission: admitted, task_id: request.task_id ?? null };
  let task_id = request.task_id ?? null;
  if (!task_id && this.readSnapshot) {
   try { task_id = this.messageTaskId(await this.readSnapshot(), request); } catch { task_id = null; }
  }
  if (!task_id) return { request_id: request.request_id, state: 'unknown', message: '취소할 SDK 작업을 아직 특정할 수 없습니다. 접수 상태를 다시 확인해 주세요.' };
  if (!request.cancel_request_id) throw new Error('취소 요청 ID가 정해지지 않았습니다. 취소를 다시 요청해 주세요.');
  await this.send({ request_id: request.cancel_request_id, command: { type: 'cancel', profile_id: request.turn.entry.entry_profile_id, task_id } });
  return { request_id: request.request_id, state: 'cancel_requested', task_id };
 }
 async admit(rawInput: RoutingInput, rawProposal: RoutingProposal, requestId: string) {
  const input = normalizeRoutingInput(rawInput), proposal = normalizeRoutingProposal(rawProposal);
  if (input.origin.message_id !== requestId) throw new Error('원본 메시지와 요청 ID가 다릅니다.');
  // The server derives owner identity from its root; do not send owner_id.
  return normalizeAdmission(await this.send({ request_id: requestId, command: { type: 'routing', action: {
   type: 'routing_admit', entry: entryDTO(input.origin), text: input.text,
   segments: input.segments, resolves: input.resolves, proposal,
  } } }));
 }
}

// Owner projection is capability gated; proposal generation remains an explicit
// provider until the Host advertises and implements its model router.
export function createHostRoutingAdapter(transport: HostRoutingTransport, providers?: Partial<Pick<RoutingAdapter, 'view' | 'prepare'>> & { canPrepareInput?: boolean }): RoutingAdapter {
 return {
  canPrepareInput: providers?.canPrepareInput === true,
  capability: () => transport.capability(),
  receipt: (entry, id) => transport.receipt(entry, id),
  admit: (input, proposal, id) => transport.admit(input, proposal, id),
  view: entry => providers?.view ? providers.view(entry) : transport.view(entry),
  prepare: (turn, id) => { if (providers?.prepare) return providers.prepare(turn, id); throw new Error('호스트의 모델 작업 분류 경로가 아직 연결되지 않았습니다.'); },
  observePending: request => transport.observePending(request),
  cancelPending: request => transport.cancelPending(request),
 };
}
