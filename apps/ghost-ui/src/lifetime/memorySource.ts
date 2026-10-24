// Owner memory source review data contract (apps/ghost-ui side).
// Mirrors the Host's serde serialization of TrustedSourceOrigin,
// SourceReceipt and the memory_source_list response envelope. Values are
// validated once here and then echoed back verbatim into
// memory_source_inspect / memory_source_correct — the UI never rebuilds
// provenance fields, so the hash-checked identities stay byte-identical.

import { isRecord } from './guards';

export type MemorySourceDisclosure = 'public' | 'private' | 'local_only';

export type MemorySourceStatus =
  | 'not_found'
  | 'prepared'
  | 'recorded'
  | 'already_recorded'
  | 'effect_unknown'
  | 'redacted'
  | 'correction_complete'
  | 'correction_blocked';

export interface MemorySourceOrigin {
  owner: string;
  source_id: string;
  revision: string;
  disclosure: MemorySourceDisclosure;
  content_sha256: string;
  kind: { kind: 'note' } | { kind: 'session'; session_id: string };
}

export interface MemorySourceReceipt {
  status: MemorySourceStatus;
  owner: string;
  source_id: string;
  revision: string;
  disclosure: MemorySourceDisclosure;
  content_sha256: string;
  source_locator: string;
  episode_id: string | null;
  prior_episode_id: string | null;
  redaction_closure_sha256: string | null;
}

export interface OwnerMemorySourceView {
  origin: MemorySourceOrigin;
  receipt: MemorySourceReceipt;
  content: string | null;
  correction_request_id: string | null;
}

export interface MemorySourceList {
  sources: OwnerMemorySourceView[];
  truncated: boolean;
}

export const memorySourceStatusLabels: Record<MemorySourceStatus, string> = {
  not_found: '접수 기록 없음',
  prepared: '접수 준비 중',
  recorded: '원장 기록됨',
  already_recorded: '이미 기록된 원본',
  effect_unknown: '실행 상태 확인 필요',
  redacted: '편집 처리됨',
  correction_complete: '교정 완료',
  correction_blocked: '교정 차단됨',
};

export const memorySourceDisclosureLabels: Record<MemorySourceDisclosure, string> = {
  public: '공개 자료 허용',
  private: '비공개',
  local_only: '이 기기에서만',
};

// Only a ledger-recorded revision admits a NEW Owner correction. Unknown,
// redacted, blocked, unrecorded and completed-correction-history states stay
// inspect/resume-only: a correction_complete receipt is the record of an
// earlier correction, not the current correctable revision, and only a
// pending/unknown ORIGINAL correction UUID is resumable. The
// expected-prior-episode CAS on the Host is the second guard.
const correctionEntryStates: Record<string, true> = {
  recorded: true,
  already_recorded: true,
};

export function correctionEntryAllowed(status: MemorySourceStatus): boolean {
  return correctionEntryStates[status] === true;
}

export function memorySourceKindLabel(kind: MemorySourceOrigin['kind']): string {
  if (kind.kind === 'note') return '노트';
  return `세션 ${kind.session_id}`;
}

// Identity of one retained source revision. Owner correction revisions keep
// the same source_id, so the revision stays part of the row key.
export function memorySourceRowKey(view: OwnerMemorySourceView): string {
  return `${view.origin.owner}\u0000${view.origin.source_id}\u0000${view.origin.revision}`;
}

// The inspected receipt must describe exactly the origin under review; any
// mismatch means the ledger moved and no correction may be drafted.
export function receiptMatchesOrigin(receipt: MemorySourceReceipt, origin: MemorySourceOrigin): boolean {
  return receipt.owner === origin.owner
    && receipt.source_id === origin.source_id
    && receipt.revision === origin.revision
    && receipt.disclosure === origin.disclosure
    && receipt.content_sha256 === origin.content_sha256;
}

function requiredString(record: Record<string, unknown>, field: string, where_: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`기억 출처 ${where_}의 ${field} 값이 예상과 다릅니다.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string, where_: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`기억 출처 ${where_}의 ${field} 값이 예상과 다릅니다.`);
  return value;
}

function parseDisclosure(value: unknown, where_: string): MemorySourceDisclosure {
  if (value !== 'public' && value !== 'private' && value !== 'local_only') {
    throw new Error(`기억 출처 ${where_}의 disclosure 값이 예상과 다릅니다.`);
  }
  return value;
}

function parseStatus(value: unknown, where_: string): MemorySourceStatus {
  if (typeof value !== 'string' || !(value in memorySourceStatusLabels)) {
    throw new Error(`기억 출처 ${where_}의 status 값이 예상과 다릅니다.`);
  }
  return value as MemorySourceStatus;
}

function parseOrigin(value: unknown, where_: string): MemorySourceOrigin {
  if (!isRecord(value)) throw new Error(`기억 출처 ${where_}의 origin 형식이 예상과 다릅니다.`);
  const kind = value.kind;
  const kindOk = isRecord(kind) && (kind.kind === 'note' || (kind.kind === 'session' && typeof kind.session_id === 'string'));
  if (!kindOk) throw new Error(`기억 출처 ${where_}의 kind 형식이 예상과 다릅니다.`);
  return {
    owner: requiredString(value, 'owner', where_),
    source_id: requiredString(value, 'source_id', where_),
    revision: requiredString(value, 'revision', where_),
    disclosure: parseDisclosure(value.disclosure, where_),
    content_sha256: requiredString(value, 'content_sha256', where_),
    kind: kind as MemorySourceOrigin['kind'],
  };
}

function parseReceipt(value: unknown, where_: string): MemorySourceReceipt {
  if (!isRecord(value)) throw new Error(`기억 출처 ${where_}의 접수 기록 형식이 예상과 다릅니다.`);
  return {
    status: parseStatus(value.status, where_),
    owner: requiredString(value, 'owner', where_),
    source_id: requiredString(value, 'source_id', where_),
    revision: requiredString(value, 'revision', where_),
    disclosure: parseDisclosure(value.disclosure, where_),
    content_sha256: requiredString(value, 'content_sha256', where_),
    source_locator: requiredString(value, 'source_locator', where_),
    episode_id: optionalString(value, 'episode_id', where_),
    prior_episode_id: optionalString(value, 'prior_episode_id', where_),
    redaction_closure_sha256: optionalString(value, 'redaction_closure_sha256', where_),
  };
}

function parseSourceView(value: unknown, index: number): OwnerMemorySourceView {
  const where_ = `${index + 1}번째 항목`;
  if (!isRecord(value)) throw new Error(`기억 출처 ${where_}의 형식이 예상과 다릅니다.`);
  const content = optionalString(value, 'content', where_);
  const correction = optionalString(value, 'correction_request_id', where_);
  return {
    origin: parseOrigin(value.origin, where_),
    receipt: parseReceipt(value.receipt, where_),
    content,
    correction_request_id: correction,
  };
}

// The list action replies only with the existing Source action Response
// envelope: status success and data = {sources, truncated}. There is no
// alternate wire format; anything else is an honest failure.
export function parseMemorySourceList(result: unknown): MemorySourceList {
  if (!isRecord(result)) throw new Error('기억 출처 목록 응답 형식이 예상과 다릅니다.');
  if (result.status !== 'success') {
    throw new Error(typeof result.summary === 'string' ? result.summary : '기억 출처 목록을 확인하지 못했습니다.');
  }
  if (!isRecord(result.data) || !Array.isArray(result.data.sources)) {
    throw new Error('기억 출처 목록 형식이 예상과 다릅니다.');
  }
  return { sources: result.data.sources.map(parseSourceView), truncated: result.data.truncated === true };
}

// memory_source_inspect replies with the same Response envelope; a success
// carries the SourceReceipt in data. Error envelopes are never parsed into a
// receipt here — a denial must never become correction input.
export function parseMemorySourceReceipt(result: unknown): MemorySourceReceipt {
  if (!isRecord(result)) throw new Error('접수 기록 응답 형식이 예상과 다릅니다.');
  if (result.status !== 'success' || !isRecord(result.data)) {
    throw new Error(typeof result.summary === 'string' ? result.summary : '접수 기록을 확인하지 못했습니다.');
  }
  return parseReceipt(result.data, '접수 기록');
}

export interface MemorySourceOutcome {
  // 'complete' only when the Host answered success with a receipt whose
  // status is correction_complete. 'unknown' is an effect_unknown outcome:
  // the original journaled request ID must be resumed, never re-created.
  // 'reported' keeps the Host's own summary; it never opens a correction.
  kind: 'complete' | 'unknown' | 'reported';
  summary: string;
}

// Shared interpreter for correct/resume replies. A rejected Host denial
// (ok:false) already throws before this point and keeps its message.
export function interpretMemoryCorrectionResult(result: unknown): MemorySourceOutcome {
  if (!isRecord(result)) throw new Error('교정 결과 응답 형식이 예상과 다릅니다.');
  const summary = typeof result.summary === 'string' ? result.summary : '';
  if (result.error_code === 'effect_unknown') return { kind: 'unknown', summary };
  if (result.status === 'success') {
    if (!isRecord(result.data)) throw new Error('교정 접수 기록 형식이 예상과 다릅니다.');
    if (result.data.status === 'effect_unknown') return { kind: 'unknown', summary };
    if (result.data.status === 'correction_complete') return { kind: 'complete', summary };
    const status = typeof result.data.status === 'string' ? result.data.status : '알 수 없음';
    return { kind: 'reported', summary: summary || `교정 접수 상태가 예상과 다릅니다(${status}).` };
  }
  return { kind: 'reported', summary: summary || '교정 결과를 확인하지 못했습니다.' };
}
