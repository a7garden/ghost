import type { Envelope, Response } from '../../../../contracts/lifetime/bindings.ts';
import { isDigest, isRecord } from './guards';

export interface BotTarget { ghost_id: string; conversation_id: string }
export interface BotDefinitionRef { ghost_id: string; revision: number; digest: string }
export type BotMode = 'active' | 'paused' | 'retired';
export type BotOperationState = 'draft' | 'evaluating' | 'provisioning' | 'ready' | 'failed' | 'reconcile_required';
export interface BotSummary extends BotTarget {
  display_name: string;
  purpose: string;
  required_capabilities: string[];
  input_contract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  definition_ref: BotDefinitionRef;
  mode: BotMode;
  lifecycle_revision: number;
  lifecycle_expected_revision: number | null;
  admission_allowed: boolean;
  managed: true;
  memory?: { state: 'verified' | 'degraded' | 'blocked'; required: boolean; reason: string | null };
}
export interface BotOperation {
  action: 'create' | 'update' | 'clone' | 'repair';
  candidate_id: string;
  candidate_digest: string;
  ghost_id: string;
  display_name: string;
  purpose: string;
  state: BotOperationState;
  blocker: string | null;
  source_turn_id: string | null;
  operation_id: string;
  definition_ref: BotDefinitionRef;
  mode: BotMode;
  lifecycle_revision: number;
  lifecycle_expected_revision: number | null;
}
export interface BotSurface { target: BotTarget; bots: BotSummary[]; operations: BotOperation[]; truncated: boolean }

const bytes = (value: string) => new TextEncoder().encode(value).length;
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.trim().length > 0 && bytes(value) <= max;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const mode = (value: unknown): value is BotMode => ['active', 'paused', 'retired'].includes(String(value));
const states = new Set(['draft', 'evaluating', 'provisioning', 'ready', 'failed', 'reconcile_required']);
function pointer(value: unknown, ghost: unknown): value is BotDefinitionRef {
  return isRecord(value) && Object.keys(value).length === 3 && value.ghost_id === ghost
    && revision(value.revision) && value.revision > 0 && isDigest(value.digest);
}
function base(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && text(value.ghost_id, 256) && text(value.display_name, 256)
    && text(value.purpose) && pointer(value.definition_ref, value.ghost_id)
    && mode(value.mode) && revision(value.lifecycle_revision)
    && value.lifecycle_expected_revision === (value.lifecycle_revision === 0 ? null : value.lifecycle_revision);
}

/** Only accept the Host's response for this exact selected Owner conversation. */
export function parseBotSurface(response: Response, target: BotTarget): BotSurface {
  const data = response.data;
  if (response.status !== 'success' || !isRecord(data) || !isRecord(data.target)
    || data.target.ghost_id !== target.ghost_id || data.target.conversation_id !== target.conversation_id
    || typeof data.truncated !== 'boolean' || !Array.isArray(data.bots) || data.bots.length > 128
    || !Array.isArray(data.operations) || data.operations.length > 128) {
    throw new Error('이 대화의 Ghost 상태를 확인하지 못했습니다.');
  }
  const ids = new Set<string>();
  for (const value of data.bots) {
    if (!base(value) || !text(value.conversation_id, 256) || value.managed !== true
      || typeof value.admission_allowed !== 'boolean'
      || value.mode !== 'active' && value.admission_allowed
      || !Array.isArray(value.required_capabilities) || value.required_capabilities.length > 32
      || !value.required_capabilities.every(capability => text(capability, 128))
      || new Set(value.required_capabilities).size !== value.required_capabilities.length
      || !isRecord(value.input_contract) || !isRecord(value.output_contract)
      || value.memory !== undefined && (!isRecord(value.memory) || !['verified', 'degraded', 'blocked'].includes(String(value.memory.state))
        || typeof value.memory.required !== 'boolean' || value.memory.reason !== null && !text(value.memory.reason, 512)
        || value.memory.required && value.memory.state !== 'verified' && value.admission_allowed)
      || ids.has(value.ghost_id as string)) throw new Error('Ghost 목록의 상태가 올바르지 않습니다.');
    ids.add(value.ghost_id as string);
  }
  const operations = new Set<string>();
  for (const value of data.operations) {
    if (!base(value) || !['create', 'update', 'clone', 'repair'].includes(String(value.action)) || !text(value.candidate_id, 256) || !isDigest(value.candidate_digest)
      || !states.has(String(value.state)) || !text(value.operation_id, 512)
      || value.source_turn_id !== null && !text(value.source_turn_id, 512)
      || value.blocker !== null && !text(value.blocker, 512)
      || operations.has(value.candidate_id as string)) throw new Error('Ghost 생성 상태가 올바르지 않습니다.');
    operations.add(value.candidate_id as string);
  }
  // Return copies: editing a form must never mutate the Host-provided pin.
  return structuredClone(data) as unknown as BotSurface;
}

export const botOperationLabels: Record<BotOperationState, string> = {
  draft: '준비 중', evaluating: '평가 중', provisioning: '실행 준비 중', ready: '생성 완료', failed: '생성 실패', reconcile_required: '확인 필요',
};
export function botOperationLabel(operation: BotOperation): string {
  if (operation.action === 'update' || operation.action === 'repair') {
    return ({ draft: '수정 준비 중', evaluating: '수정 평가 중', provisioning: '수정 적용 중', ready: '수정 완료', failed: '수정 실패', reconcile_required: '수정 확인 필요' })[operation.state];
  }
  return botOperationLabels[operation.state];
}
export function botAvailability(bot: BotSummary): string {
  return bot.mode === 'retired' ? '사용 종료' : bot.mode === 'paused' ? '일시정지' : bot.admission_allowed ? '사용 가능' : '준비 확인 필요';
}
export function botBlocker(blocker: string | null): string | null {
  if (!blocker) return null;
  return ({ independent_evaluation_failed: '평가를 통과하지 못했습니다.', evaluation_evidence_unavailable: '평가 자료를 확인하지 못했습니다.', provisioning_effect_unconfirmed: '기존 준비 결과를 확인해야 합니다.', provisioning_prerequisite_unavailable: '실행 환경을 확인하지 못했습니다.', provisioning_rejected: '준비 요청이 거절되었습니다.', runtime_prepare_pending: '실행 준비 응답을 기다리고 있습니다.', required_memory_unavailable: '필수 기억 연결을 확인하지 못했습니다.', memory_permission_missing: '기억 사용 권한이 필요합니다.', memory_binding_missing: '선택된 기억 연결이 없습니다.', memory_binding_changed: '기억 연결의 권한이 변경되었습니다.', memory_profile_unavailable: '선택한 기억 판본을 확인하지 못했습니다.', memory_profile_revision_missing: '선택한 기억 판본을 찾지 못했습니다.', memory_authentication_unavailable: '기억 연결을 인증하지 못했습니다.', memory_validation_pending: '기억 연결을 확인하고 있습니다.', unprovisioned_capability: '필요한 도구를 준비하지 못했습니다.', definition_conflict: '정의가 변경되었습니다. 현재 판본을 확인해 주세요.' } as Record<string, string>)[blocker] ?? '준비를 마치지 못했습니다. 접수 기록을 확인해 주세요.';
}
export function botLifecycleCommand(bot: BotSummary, next: BotMode): { body: Envelope['body']; expectedRevision: number | null } {
  if (!mode(next) || bot.mode === 'retired' && next !== 'retired') throw new Error('사용 종료한 Ghost는 재개할 수 없습니다.');
  return { body: { method: 'bot.lifecycle.set', ghost_id: bot.ghost_id, mode: next }, expectedRevision: bot.lifecycle_expected_revision };
}
export function botDefinitionCommand(bot: BotSummary, action: 'update' | 'clone', value: string): Envelope['body'] {
  if (!pointer(bot.definition_ref, bot.ghost_id) || !text(value, action === 'clone' ? 256 : 32768)) throw new Error('변경할 내용을 확인해 주세요.');
  if (action === 'update' && bot.mode === 'retired') throw new Error('사용 종료한 Ghost는 수정할 수 없습니다.');
  return { method: action === 'update' ? 'bot.update.prepare' : 'bot.clone.prepare', ghost_id: bot.ghost_id,
    definition_ref: structuredClone(bot.definition_ref), ...(action === 'update' ? { instructions: value } : { display_name: value }) };
}
