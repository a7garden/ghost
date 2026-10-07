import type { Admission, AdmissionView, Decision, Resolution, RoutingCapability, RoutingInput, RoutingOperation, RoutingOrigin, RoutingProposal, RoutingView, Work, WorkStatus, WorkTarget } from './routingTypes';
const invalid = (): never => { throw new Error('과업 접수 응답 형식을 확인할 수 없습니다. 호스트 계약을 확인해 주세요.'); };
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalid();
const str = (v: unknown): string => typeof v === 'string' ? v : invalid();
const num = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : invalid();
const revision = (v: unknown) => { const n = num(v); return n > 0 ? n : invalid(); };
const arr = <T>(v: unknown, parse: (x: unknown) => T): T[] => Array.isArray(v) ? v.map(parse) : invalid();
const nil = <T>(v: unknown, parse: (x: unknown) => T) => v === null ? null : parse(v);
const schema = (v: unknown): 2 => v === 2 ? 2 : invalid();
const status = (v: unknown): WorkStatus => v === 'pending' || v === 'cancel_requested' ? v : invalid();
const origin = (v: unknown): RoutingOrigin => { const o = obj(v); return { owner_id: str(o.owner_id), entry_profile_id: str(o.entry_profile_id), conversation_id: str(o.conversation_id), message_id: str(o.message_id) }; };
const target = (v: unknown): WorkTarget => { const t = obj(v); return { work_id: str(t.work_id), expected_work_revision: revision(t.expected_work_revision), expected_decision_revision: revision(t.expected_decision_revision) }; };
export function normalizeRoutingCapability(v: unknown): RoutingCapability {
 const c = obj(v), keys = ['admission', 'clarification_resolution', 'runtime_dispatch', 'effect_fence', 'verified_completion_report'] as const;
 if (keys.some(k => typeof c[k] !== 'boolean')) return invalid();
 const result = Object.fromEntries(keys.map(k => [k, c[k]])) as unknown as RoutingCapability;
 if (c.schema !== undefined) { if (c.schema !== 'ghost-routing-host/1') return invalid(); result.schema = c.schema; }
 for (const key of ['model_router', 'model_tool_registration', 'entry_view', 'immutable_evidence', 'external_mutation_dispatch'] as const) {
  if (c[key] !== undefined) { if (typeof c[key] !== 'boolean') return invalid(); result[key] = c[key]; }
 }
 if(c.verification_scope!==undefined)result.verification_scope=str(c.verification_scope);
 if(c.unsupported_bound_mutation_tools!==undefined)result.unsupported_bound_mutation_tools=arr(c.unsupported_bound_mutation_tools,str).filter(tool=>['shell','integration_call','memory_retain','planner_mutation','browser_mutation'].includes(tool));
 return result;
}
export function normalizeRoutingOperation(v: unknown): RoutingOperation {
 const o = obj(v);
 switch (o.type) {
  case 'new': return { type: 'new', title: str(o.title), scope: str(o.scope), responsible_profile_id: str(o.responsible_profile_id), dependencies: arr(o.dependencies, target) };
  case 'amend': return { type: 'amend', target: target(o.target), scope: str(o.scope) };
  case 'continue': case 'cancel': return { type: o.type, target: target(o.target) };
  case 'question': return { type: 'question', target: nil(o.target, target) };
  case 'clarify': return { type: 'clarify', question: str(o.question), candidates: arr(o.candidates, target) };
  default: return invalid();
 }
}
export function normalizeRoutingInput(v: unknown): RoutingInput {
 const i = obj(v); if (i.schema !== 'ghost-routing-input/1') return invalid();
 return { schema: i.schema, origin: origin(i.origin), text: str(i.text), segments: arr(i.segments, s => { const x = obj(s); return { id: str(x.id), start_byte: num(x.start_byte), end_byte: num(x.end_byte) }; }), resolves: arr(i.resolves ?? [], r => { const x = obj(r); return { source_admission_id: str(x.source_admission_id), source_segment_id: str(x.source_segment_id), expected_input_hash: str(x.expected_input_hash), answer_segment_id: str(x.answer_segment_id) }; }) };
}
export function normalizeRoutingProposal(v: unknown): RoutingProposal {
 const p = obj(v); if (p.schema !== 'ghost-routing-proposal/2') return invalid();
 return { schema: p.schema, items: arr(p.items, i => { const x = obj(i); return { segment_id: str(x.segment_id), additional_segment_ids: arr(x.additional_segment_ids ?? [], str), operation: normalizeRoutingOperation(x.operation) }; }) };
}
export function normalizeWork(v: unknown): Work {
 const w = obj(v); return { schema: schema(w.schema), id: str(w.id), owner_id: str(w.owner_id), title: str(w.title), scope: str(w.scope), responsible_profile_id: str(w.responsible_profile_id), origin: origin(w.origin), conversation_ids: arr(w.conversation_ids, str), work_revision: revision(w.work_revision), decision_revision: revision(w.decision_revision), status: status(w.status), dependency_ids: arr(w.dependency_ids, str), created_ms: num(w.created_ms), updated_ms: num(w.updated_ms) };
}
export function normalizeDecision(v: unknown): Decision {
 const d = obj(v); return { schema: schema(d.schema), id: str(d.id), work_id: str(d.work_id), revision: revision(d.revision), supersedes: nil(d.supersedes, revision), scope: str(d.scope), status: status(d.status), source_admission_id: str(d.source_admission_id), source_segment_id: str(d.source_segment_id), source_fragments: arr(d.source_fragments, f => { const x = obj(f); return { segment_id: str(x.segment_id), start_byte: num(x.start_byte), end_byte: num(x.end_byte), text: str(x.text) }; }), requested_text: str(d.requested_text), created_ms: num(d.created_ms) };
}
export function normalizeAdmission(v: unknown): Admission {
 const a = obj(v); return { schema: schema(a.schema), id: str(a.id), input_hash: str(a.input_hash), proposal_hash: str(a.proposal_hash), input: normalizeRoutingInput(a.input), authority_revision: str(a.authority_revision), created_ms: num(a.created_ms), items: arr(a.items, s => { const x = obj(s); return { segment_id: str(x.segment_id), group_anchor_segment_id: str(x.group_anchor_segment_id), work_id: nil(x.work_id, str), work_revision: nil(x.work_revision, revision), decision_revision: nil(x.decision_revision, revision), intent_id: nil(x.intent_id, str), operation: normalizeRoutingOperation(x.operation) }; }) };
}
export function normalizeResolution(v: unknown): Resolution {
 const r = obj(v); return { schema: schema(r.schema), id: str(r.id), source_admission_id: str(r.source_admission_id), source_segment_id: str(r.source_segment_id), answer_admission_id: str(r.answer_admission_id), answer_segment_id: str(r.answer_segment_id), created_ms: num(r.created_ms) };
}
export function normalizeAdmissionView(v: unknown): AdmissionView { const a = obj(v); return { admission: normalizeAdmission(a.admission), resolutions: arr(a.resolutions, normalizeResolution) }; }
export function normalizeRoutingView(v: unknown): RoutingView { const r = obj(v); return { works: arr(r.works, normalizeWork), decisions: arr(r.decisions, normalizeDecision), admissions: arr(r.admissions, normalizeAdmissionView) }; }
