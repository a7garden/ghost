import {
  type Activity,
  type ActivityConfig,
  type ActivityPolicy,
  type ActivitySource,
  type ExecutionTarget,
  type Ghost,
  type GhostTool,
  type ScheduleSpec,
} from '@ghost/contract';
import { fromLocalInput, intervalLabel, toLocalInput } from './Schedules';

/** A new activity starts on the contract defaults: read-only tools, deny writes, ten runs a day at most. Memory search is intrinsic to every Ghost conversation, not an activity grant. */
export const DEFAULT_ACTIVITY_TOOLS: readonly GhostTool[] = ['read', 'web_search', 'web_read'];
export const DEFAULT_POLICY: ActivityPolicy = {
  maxRunsPerDay: 10,
  maxConcurrent: 1,
  runTimeoutSeconds: 600,
  allowSelfCheck: false,
  minCheckSeconds: 900,
  externalActions: 'deny',
  delivery: 'changes',
};

/**
 * Capabilities outside an Activity's standing delegation. Browser and vault remain
 * available; account registration needs an ordinary owner-confirmed conversation.
 */
const DENIED_IN_ACTIVITY: Partial<Record<GhostTool, true>> = {
  work_create: true, work_list: true, work_inspect: true, work_update: true, work_cancel: true,
  schedule_create: true, schedule_list: true, schedule_cancel: true, ghost_list: true, activity_propose: true,
  document_propose: true, connection_register: true,
};

/** Tools the form may offer, in contract order, kept inside the Ghost's own grants. Pure. */
export function intersectTools(requested: readonly GhostTool[], allowed: readonly GhostTool[]): GhostTool[] {
  return [...new Set(requested)].filter(tool => allowed.includes(tool) && !DENIED_IN_ACTIVITY[tool]);
}

/** The chip options an activity may show, kept inside its standing delegation. */
export function activityToolChoices(tools: readonly GhostTool[]): GhostTool[] {
  return tools.filter(tool => !DENIED_IN_ACTIVITY[tool]);
}

export const sourceKindLabel: Record<ActivitySource['kind'], string> = { schedule: '일정', pull_request: 'PR', mail: '메일' };

/** One short line about what a source watches; the filters that actually apply. Pure; tests pin it. */
export function sourceSummary(source: ActivitySource): string {
  if (source.kind === 'schedule') {
    return source.spec.kind === 'at' ? `${dateTimeLabel(source.spec.at)}에 한 번` : `${intervalLabel(source.spec.seconds)}마다`;
  }
  if (source.kind === 'pull_request') {
    return [`PR · ${source.repository}`, source.baseBranch ? `${source.baseBranch} 브랜치` : null,
      source.labels.length ? `${source.labels.join(', ')} 라벨` : null,
      source.includeDrafts ? '드래프트 포함' : null].filter(Boolean).join(' · ');
  }
  return ['메일', source.sender ?? null, source.subjectContains ? `제목 “${source.subjectContains}”` : null,
    source.unreadOnly ? '안 읽은 메일만' : null].filter(Boolean).join(' · ');
}

/** Run state reads like the Work board plus the activity-only skipped outcome. */
export const runStateLabel: Record<string, string> = {
  queued: '대기 중', running: '진행 중', waiting: '응답 대기', verifying: '검증 중', blocked: '결과 미확정',
  done: '완료', failed: '실패', cancelled: '취소됨', skipped: '건너뜀',
};
export const runStateTone: Record<string, 'outline' | 'success' | 'warning' | 'danger' | 'default'> = {
  queued: 'outline', running: 'default', waiting: 'outline', verifying: 'default', blocked: 'warning',
  done: 'success', failed: 'danger', cancelled: 'outline', skipped: 'outline',
};
export const triggerLabel: Record<'schedule' | 'source' | 'self_check' | 'manual' | 'dry_run', string> = {
  schedule: '일정', source: '새 항목', self_check: '자기 점검', manual: '직접 실행', dry_run: '시험 실행',
};
export const externalActionsLabel: Record<ActivityPolicy['externalActions'], string> = {
  deny: '거부', approval: '승인 후 실행', allow: '허용',
};
export const deliveryLabel: Record<ActivityPolicy['delivery'], string> = { changes: '바뀔 때만', always: '항상' };
export const executionLabel: Record<ExecutionTarget['kind'], string> = { workspace: '작업 공간', container: '컨테이너', host: '이 Mac' };

/** One glanceable line about a policy's limits, for the run-history header. Pure; tests pin it. */
export function policySummary(policy: ActivityPolicy): string {
  return [`하루 ${policy.maxRunsPerDay}회`, `동시 ${policy.maxConcurrent}개`, `제한 ${intervalLabel(policy.runTimeoutSeconds)}`,
    policy.allowSelfCheck ? `자기 점검 ${intervalLabel(policy.minCheckSeconds)}부터` : '자기 점검 없음',
    `PR 댓글·메일 회신 ${externalActionsLabel[policy.externalActions]}`, `전달 ${deliveryLabel[policy.delivery]}`].join(' · ');
}

/**
 * Budget/concurrency deferral reads as ordinary waiting — 대기 + why + when it retries —
 * never as a failure next to lastError. Null when the activity is not deferred.
 */
export function deferralLabel(activity: Pick<Activity, 'deferredUntil' | 'deferredReason'>): string | null {
  const parts = [activity.deferredReason?.trim() ?? null,
    activity.deferredUntil ? `${dateTimeLabel(activity.deferredUntil)}에 다시 시도` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function dateTimeLabel(at: number): string {
  return new Date(at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Everything the form owns, as input strings. */
export interface ActivityDraft {
  ghostId: string;
  name: string;
  prompt: string;
  acceptanceCriteria: string;
  sourceKind: ActivitySource['kind'];
  scheduleMode: 'at' | 'every';
  scheduleAt: string;
  /** Original schedule authority; retain exact timestamps and cadence on unrelated edits. */
  scheduleSpec: ScheduleSpec | null;
  everyMinutes: string;
  connectionId: string;
  pollMinutes: string;
  includeExisting: boolean;
  repository: string;
  baseBranch: string;
  labels: string;
  includeDrafts: boolean;
  sender: string;
  subjectContains: string;
  unreadOnly: boolean;
  executionKind: ExecutionTarget['kind'];
  hostCwd: string;
  tools: GhostTool[];
  maxRunsPerDay: string;
  maxConcurrent: string;
  runTimeoutMinutes: string;
  allowSelfCheck: boolean;
  minCheckMinutes: string;
  externalActions: ActivityPolicy['externalActions'];
  delivery: ActivityPolicy['delivery'];
}

export const emptyDraft = (ghost: Ghost | null): ActivityDraft => ({
  ghostId: ghost?.id ?? '',
  name: '', prompt: '', acceptanceCriteria: '',
  sourceKind: 'schedule', scheduleMode: 'every', scheduleAt: toLocalInput(Date.now() + 3600_000), scheduleSpec: null, everyMinutes: '30',
  connectionId: '', pollMinutes: '5', includeExisting: false,
  repository: '', baseBranch: '', labels: '', includeDrafts: false,
  sender: '', subjectContains: '', unreadOnly: true,
  executionKind: 'workspace', hostCwd: '',
  tools: intersectTools(DEFAULT_ACTIVITY_TOOLS, ghost?.tools ?? []),
  maxRunsPerDay: String(DEFAULT_POLICY.maxRunsPerDay), maxConcurrent: String(DEFAULT_POLICY.maxConcurrent),
  runTimeoutMinutes: '10', allowSelfCheck: false, minCheckMinutes: '15',
  externalActions: 'deny', delivery: 'changes',
});

/** Stored config back into the form without losing second precision. */
export function draftFromConfig(config: ActivityConfig): ActivityDraft {
  const draft: ActivityDraft = {
    ...emptyDraft(null),
    ghostId: config.ghostId, name: config.name, prompt: config.prompt, acceptanceCriteria: config.acceptanceCriteria,
    sourceKind: config.source.kind, tools: activityToolChoices(config.tools),
    executionKind: config.execution.kind, hostCwd: config.execution.kind === 'host' ? config.execution.cwd : '',
    maxRunsPerDay: String(config.policy.maxRunsPerDay), maxConcurrent: String(config.policy.maxConcurrent),
    runTimeoutMinutes: String(config.policy.runTimeoutSeconds / 60),
    allowSelfCheck: config.policy.allowSelfCheck, minCheckMinutes: String(config.policy.minCheckSeconds / 60),
    externalActions: config.policy.externalActions, delivery: config.policy.delivery,
  };
  const source = config.source;
  if (source.kind === 'schedule') {
    draft.scheduleMode = source.spec.kind;
    draft.scheduleSpec = source.spec;
    if (source.spec.kind === 'at') draft.scheduleAt = toLocalInput(source.spec.at);
    else draft.everyMinutes = String(source.spec.seconds / 60);
  } else if (source.kind === "pull_request" || source.kind === "mail") {
    draft.connectionId = source.connectionId;
    draft.pollMinutes = String(source.pollSeconds / 60);
    draft.includeExisting = source.includeExisting;
    if (source.kind === 'pull_request') {
      draft.repository = source.repository;
      draft.baseBranch = source.baseBranch ?? '';
      draft.labels = source.labels.join(', ');
      draft.includeDrafts = source.includeDrafts;
    } else {
      draft.sender = source.sender ?? '';
      draft.subjectContains = source.subjectContains ?? '';
      draft.unreadOnly = source.unreadOnly;
    }
  }
  return draft;
}

const intIn = (value: string, min: number, max: number, label: string): number | string => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) return `${label}은 ${min}부터 ${max}까지의 수여야 합니다.`;
  return parsed;
};

/** Minute inputs allow whole contract seconds, including non-minute API values. */
const secondsFromMinutes = (value: string, min: number, max: number, label: string): number | string => {
  const raw = Number(value) * 60;
  const seconds = Math.round(raw);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(raw)) * 4;
  if (!value.trim() || !Number.isFinite(raw) || Math.abs(raw - seconds) > tolerance || seconds < min || seconds > max) {
    return `${label}은 ${min / 60}분 이상${Number.isFinite(max) ? ` ${max / 60}분 이하` : ''}의 초 단위 간격이어야 합니다.`;
  }
  return seconds;
};

const optionalText = (value: string, max: number, label: string): string | null | { error: string } => {
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) return { error: `${label}는 ${max}자 이하여야 합니다.` };
  return text;
};

export type BuiltActivity = { ok: true; config: ActivityConfig } | { ok: false; error: string };

/**
 * Form → contract ActivityConfig. Every bound is the contract's own; the host revalidates.
 * Pure; tests pin what goes on the wire and which mistakes stay local.
 */
export function buildActivityConfig(draft: ActivityDraft, ghost: Ghost | undefined): BuiltActivity {
  const name = draft.name.trim();
  if (!draft.ghostId) return { ok: false, error: '활동을 맡길 Ghost를 선택해 주세요.' };
  if (!ghost) return { ok: false, error: '선택한 Ghost를 찾을 수 없습니다.' };
  if (!name) return { ok: false, error: '활동 이름을 입력해 주세요.' };
  if (name.length > 128) return { ok: false, error: '활동 이름은 128자 이하여야 합니다.' };
  const prompt = draft.prompt.trim();
  if (!prompt) return { ok: false, error: '활동 지시를 입력해 주세요.' };
  if (prompt.length > 8192) return { ok: false, error: '활동 지시는 8,192자 이하여야 합니다.' };
  const criteria = draft.acceptanceCriteria.trim();
  if (!criteria) return { ok: false, error: '완료 기준을 입력해 주세요.' };
  if (criteria.length > 8192) return { ok: false, error: '완료 기준은 8,192자 이하여야 합니다.' };

  let source: ActivitySource;
  if (draft.sourceKind === 'schedule') {
    let spec: ScheduleSpec | string;
    if (draft.scheduleMode === 'at') {
      const at = fromLocalInput(draft.scheduleAt);
      if (at === null) return { ok: false, error: '실행할 시각을 확인해 주세요.' };
      const original = draft.scheduleSpec;
      spec = { kind: 'at', at: original?.kind === 'at' && draft.scheduleAt === toLocalInput(original.at) ? original.at : at };
    } else {
      const seconds = secondsFromMinutes(draft.everyMinutes, 60, Infinity, '반복 간격(분)');
      if (typeof seconds === 'string') return { ok: false, error: seconds };
      const original = draft.scheduleSpec;
      spec = original?.kind === 'every' && original.seconds === seconds
        ? original : { kind: 'every', seconds, startAt: Date.now() };
    }
    source = { kind: 'schedule', spec };
  } else {
    if (!draft.connectionId) return { ok: false, error: `${draft.sourceKind === 'pull_request' ? 'GitHub·Gitea' : '메일'} 연결을 선택해 주세요. 연결 계정에서 먼저 만들 수 있습니다.` };
    const poll = secondsFromMinutes(draft.pollMinutes, 60, 86400, '확인 주기(분)');
    if (typeof poll === 'string') return { ok: false, error: poll };
    if (draft.sourceKind === 'pull_request') {
      const repository = draft.repository.trim();
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return { ok: false, error: '저장소는 owner/repo 형태로 입력해 주세요.' };
      if (repository.length > 256) return { ok: false, error: '저장소 이름은 256자 이하여야 합니다.' };
      const baseBranch = optionalText(draft.baseBranch, 256, '기준 브랜치');
      if (baseBranch !== null && typeof baseBranch === 'object') return { ok: false, error: baseBranch.error };
      const labels = [...new Set(draft.labels.split(',').map(label => label.trim()).filter(Boolean))];
      if (labels.some(label => label.length > 128)) return { ok: false, error: '라벨은 128자 이하여야 합니다.' };
      if (labels.length > 32) return { ok: false, error: '라벨은 32개까지 넣을 수 있습니다.' };
      source = {
        kind: 'pull_request', connectionId: draft.connectionId, repository, baseBranch, labels,
        includeDrafts: draft.includeDrafts, includeExisting: draft.includeExisting, pollSeconds: poll,
      };
    } else {
      const sender = optionalText(draft.sender, 320, '보낸 사람');
      if (sender !== null && typeof sender === 'object') return { ok: false, error: sender.error };
      const subject = optionalText(draft.subjectContains, 256, '제목 조건');
      if (subject !== null && typeof subject === 'object') return { ok: false, error: subject.error };
      source = {
        kind: 'mail', connectionId: draft.connectionId, sender, subjectContains: subject,
        unreadOnly: draft.unreadOnly, includeExisting: draft.includeExisting, pollSeconds: poll,
      };
    }
  }

  let execution: ExecutionTarget;
  if (draft.executionKind === 'host') {
    if (ghost.hostExecution !== true) return { ok: false, error: '이 Ghost는 PC 직접 실행이 허용되지 않았습니다. Ghost 설정의 운영에서 먼저 허용해 주세요.' };
    const cwd = draft.hostCwd.trim();
    if (!cwd.startsWith('/')) return { ok: false, error: '작업 폴더는 /로 시작하는 전체 경로여야 합니다.' };
    if (cwd.length > 4096) return { ok: false, error: '작업 폴더 경로는 4,096자 이하여야 합니다.' };
    execution = { kind: 'host', cwd };
  } else {
    execution = { kind: 'workspace' };
  }

  const maxRunsPerDay = intIn(draft.maxRunsPerDay, 1, 1000, '하루 최대 실행');
  if (typeof maxRunsPerDay === 'string') return { ok: false, error: maxRunsPerDay };
  const maxConcurrent = intIn(draft.maxConcurrent, 1, 8, '동시 실행');
  if (typeof maxConcurrent === 'string') return { ok: false, error: maxConcurrent };
  const runTimeout = secondsFromMinutes(draft.runTimeoutMinutes, 30, 86400, '실행 제한(분)');
  if (typeof runTimeout === 'string') return { ok: false, error: runTimeout };
  const minCheck = secondsFromMinutes(draft.minCheckMinutes, 60, 86400, '자기 점검 최소 간격(분)');
  if (typeof minCheck === 'string') return { ok: false, error: minCheck };

  return {
    ok: true,
    config: {
      ghostId: draft.ghostId, name, prompt, acceptanceCriteria: criteria, source, execution,
      tools: intersectTools(draft.tools, ghost.tools),
      policy: {
        maxRunsPerDay, maxConcurrent, runTimeoutSeconds: runTimeout,
        allowSelfCheck: draft.allowSelfCheck, minCheckSeconds: minCheck,
        externalActions: draft.externalActions, delivery: draft.delivery,
      },
    },
  };
}
