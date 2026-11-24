import type { ConfigRevision, PolicyRule, State } from '@ghost/contract';
import { describeRule, toolLabel } from './policyText';
import { uiTerms } from '../uiText';

/**
 * 「변경 기록」 wording. A stored revision reads as one plain sentence (누가 무엇을 어떻게 바꿨는가)
 * plus a short list of `이름: 이전 → 이후` lines; raw values stay inside the collapsed 「기술 정보」
 * block of ConfigHistory.
 */

export type ConfigEntity = ConfigRevision['entity'];

/** Plain kind names shared by the sentence and the 「종류」 filter. */
export const entityKindLabels: Record<ConfigEntity, string> = {
  scope: '프로젝트',
  ghost: 'Ghost',
  rule: uiTerms.rules,
  slot: uiTerms.modelCombos,
  mcp: uiTerms.mcp,
  activity: uiTerms.activities,
  limits: uiTerms.limits,
  connection: uiTerms.connections,
};

/** One readable what-changed line. */
export interface ChangeLine { label: string; before: string; after: string; }

export interface RevisionChanges {
  /** Made for the first time: shown as 「새로 만듦」 instead of a diff list. */
  created: boolean;
  /** Removed: shown as 「삭제함」 instead of a diff list. */
  deleted: boolean;
  lines: ChangeLine[];
  /** Mapped fields changed too deeply to read one by one; shown as 「그 밖의 N개 항목」. */
  extraCount: number;
}

type Side = 'before' | 'after';
type Render = (value: unknown, state: State | null, side?: Side) => string;
interface FieldSpec { key: string; label: string; render: Render; }

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Hangul final-consonant check for 을/를 · 이/가 particles; Latin names take the vowel forms (Ghost를, Ghost가). */
const endsConsonant = (word: string) => {
  const last = word.slice(-1);
  const code = last.codePointAt(0) ?? 0;
  return last >= '가' && last <= '힣' && (code - 0xac00) % 28 !== 0;
};

const truncate = (text: string, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const textOf: Render = value => (typeof value === 'string' ? truncate(value) : value == null ? '없음' : '');
const onOff: Render = value => (value === true ? '켬' : value === false ? '끔' : value == null ? '없음' : '');
const counted: Render = value => (Array.isArray(value) ? `${value.length}개` : value == null ? '없음' : '');
const times: Render = value => (typeof value === 'number' ? `${value.toLocaleString('ko-KR')}번` : value == null ? '없음' : '');
const plainNumber: Render = value => (typeof value === 'number' ? value.toLocaleString('ko-KR') : value == null ? '없음' : '');
const named: Render = value => (value === true ? '기본으로 지정' : value === false ? '지정 안 함' : '');

const thinkingText: Record<string, string> = { off: '끔', low: '낮게', medium: '보통', high: '높게' };
const modelOf: Render = value => {
  if (value == null) return '없음';
  if (!isObject(value) || typeof value.model !== 'string') return '';
  const thinking = typeof value.thinking === 'string' && value.thinking !== 'off' ? ` · 생각 ${thinkingText[value.thinking] ?? value.thinking}` : '';
  return `${value.model}${thinking}`;
};
const modelList: Render = value => {
  if (value == null) return '없음';
  if (!Array.isArray(value)) return '';
  const names = value.map(item => modelOf(item, null)).filter(Boolean);
  return names.length ? names.join(' · ') : '없음';
};

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const folderList: Render = value => {
  if (value == null) return '없음';
  if (!Array.isArray(value)) return '';
  const names = value.filter((item): item is string => typeof item === 'string').map(baseName);
  return names.length ? names.join(' · ') : '없음';
};
const folderName: Render = value => (typeof value === 'string' ? baseName(value) : value == null ? '없음' : '');

const ghostRef: Render = (value, state) => (value == null ? '없음' : typeof value === 'string' ? state?.ghosts.find(ghost => ghost.id === value)?.name ?? '삭제된 Ghost' : '');
const scopeRef: Render = (value, state) => (value == null ? '모든 프로젝트' : typeof value === 'string' ? state?.scopes.find(scope => scope.id === value)?.name ?? '삭제된 프로젝트' : '');
const activityRef: Render = (value, state) => (value == null ? '없음' : typeof value === 'string' ? state?.activities?.find(item => item.id === value)?.name ?? '삭제된 자동 활동' : '');

const ghostStates: Record<string, string> = { active: '사용 중', paused: '잠시 멈춤', retired: '은퇴' };
const scopeStates: Record<string, string> = { active: '사용 중', paused: '잠시 멈춤' };
const ghostStateText: Render = value => (typeof value === 'string' ? ghostStates[value] ?? '' : value == null ? '없음' : '');
const scopeStateText: Render = value => (typeof value === 'string' ? scopeStates[value] ?? '' : value == null ? '없음' : '');

const asRule = (value: unknown) => (isObject(value) && typeof value.tool === 'string' ? value as unknown as PolicyRule : null);
const ruleConditions: Render = (value, state) => {
  if (value == null) return '제한 없음';
  if (!isObject(value)) return '';
  const conditions = describeRule({ tool: '*', when: value } as unknown as PolicyRule, state).conditions;
  return conditions.length ? conditions.join(' · ') : '제한 없음';
};
const ruleOutcome: Render = (value, state) => {
  const rule = asRule(value);
  return rule ? describeRule(rule, state).outcome : value == null ? '없음' : '';
};
const reviewerOf: Render = (value, state) => {
  if (value == null) return '없음';
  if (!isObject(value)) return '';
  if (value.kind === 'main') return '메인 Ghost';
  if (value.kind === 'ghost') return ghostRef(value.ghostId, state);
  if (value.kind === 'slot') return `${uiTerms.modelCombos} ‘${String(value.slot)}’`;
  return '';
};
const autoResolveOf: Render = value => {
  if (value == null) return '없음';
  if (!isObject(value) || typeof value.afterMinutes !== 'number') return '';
  return `${value.afterMinutes}분 안에 답이 없으면 ${value.answer === 'approve' ? '승인' : '추천대로 진행'}`;
};
const amountOf: Render = value => {
  if (value == null) return '없음';
  if (!isObject(value) || typeof value.value !== 'number') return '';
  return `${value.value.toLocaleString('ko-KR')} ${String(value.currency ?? '')}`;
};
const toolOf: Render = value => (typeof value === 'string' ? toolLabel(value) : value == null ? '없음' : '');

const sourceText: Record<string, string> = { schedule: '정해 둔 시간', commit: '프로젝트의 새 기록', poll: '주기적인 확인', pull_request: '새 풀 리퀘스트', mail: '메일함' };
const executionText: Record<string, string> = { workspace: '작업 공간', container: '컨테이너', host: '이 Mac' };
const transportText: Record<string, string> = { stdio: '명령줄 프로그램', http: '웹 주소' };
const connectionText: Record<string, string> = { github: 'GitHub', gitea: 'Gitea', api: 'API', mail: '메일' };

const kindText = (map: Record<string, string>): Render => (value, _state, side) => {
  if (value == null) return '없음';
  if (isObject(value) && typeof value.kind === 'string' && map[value.kind]) return map[value.kind];
  if (typeof value === 'string' && map[value]) return map[value];
  return side === 'before' ? '이전 설정' : '새 설정';
};

const activityPolicyOf: Render = value => (isObject(value) && typeof value.maxRunsPerDay === 'number' ? `하루 ${value.maxRunsPerDay}번까지` : '');

/** 작업량 한도 값들, 한국어 이름으로. */
export const limitFieldLabels: Record<string, string> = {
  dailyWakes: '하루 자율 시작',
  concurrentWakes: '동시에 진행하는 자율 일',
  rootNodes: '프로젝트 하나가 담는 일의 양',
  activityNodes: '활동 하나가 담는 일의 양',
  revisions: '스스로 다시 고치는 횟수',
  depth: '일을 다시 맡길 수 있는 단계',
  liveChildren: '동시에 진행하는 하위 일',
  workQuestions: '일 하나가 남길 수 있는 질문',
  goalProposalCooldownDays: '목표 제안이 거절된 뒤 기다리는 날',
  openGoals: '열어 둘 수 있는 목표',
  ghostsPerDay: '하루 만들 수 있는 Ghost',
};
const limitsSummary: Render = value => {
  if (value == null) return '없음';
  if (!isObject(value)) return '';
  const parts = Object.entries(value).filter(([key]) => key in limitFieldLabels).map(([key, item]) => `${limitFieldLabels[key]} ${String(item)}`);
  return parts.length ? parts.join(' · ') : '없음';
};
const limitsFields: FieldSpec[] = Object.entries(limitFieldLabels).map(([key, label]) => ({ key, label, render: plainNumber }));

/** 시곗값 · 고유번호 따라 목록에 나열하지 않는 필드들. */
const skippedFields: Record<string, true> = {
  id: true, createdAt: true, updatedAt: true, revision: true, createdBy: true, cursor: true, nextAt: true, lastCheckedAt: true, lastError: true,
  deferredUntil: true, deferredReason: true, failureCount: true, deletedAt: true, pauseReason: true, directConversationId: true, iconUrl: true, serviceId: true,
};

const fieldSpecs: Record<ConfigEntity, FieldSpec[]> = {
  scope: [
    { key: 'name', label: '이름', render: textOf },
    { key: 'ghostId', label: '맡긴 Ghost', render: ghostRef },
    { key: 'paths', label: '폴더', render: folderList },
    { key: 'vaultPath', label: '금고 폴더', render: folderName },
    { key: 'state', label: '상태', render: scopeStateText },
    { key: 'attachments', label: '첨부 문서', render: counted },
    { key: 'limits', label: '작업량 한도', render: limitsSummary },
  ],
  ghost: [
    { key: 'name', label: '이름', render: textOf },
    { key: 'persona', label: '맡은 역할', render: textOf },
    { key: 'model', label: '모델', render: modelOf },
    { key: 'isDefault', label: '기본 Ghost', render: named },
    { key: 'state', label: '상태', render: ghostStateText },
    { key: 'tools', label: '쓸 수 있는 도구', render: counted },
    { key: 'fallbacks', label: '대체 모델', render: modelList },
    { key: 'skills', label: '기술', render: counted },
    { key: 'hostExecution', label: 'PC 직접 실행', render: onOff },
    { key: 'attachments', label: '첨부 문서', render: counted },
  ],
  rule: [
    { key: 'tool', label: '무슨 일', render: toolOf },
    { key: 'when', label: '조건', render: ruleConditions },
    { key: 'decision', label: '처리 방식', render: ruleOutcome },
    { key: 'reviewer', label: '검토하는 사람', render: reviewerOf },
    { key: 'autoResolve', label: '답이 없을 때', render: autoResolveOf },
    { key: 'ghostId', label: '맡긴 Ghost', render: ghostRef },
    { key: 'scopeId', label: '적용 프로젝트', render: scopeRef },
    { key: 'triggerId', label: '자동 활동', render: activityRef },
    { key: 'maxPerDay', label: '하루 최대 횟수', render: times },
    { key: 'maxAmount', label: '금액 한도', render: amountOf },
  ],
  slot: [
    { key: 'model', label: '모델', render: modelOf },
    { key: 'fallbacks', label: '대체 모델', render: modelList },
  ],
  mcp: [
    { key: 'name', label: '이름', render: textOf },
    { key: 'enabled', label: '사용', render: onOff },
    { key: 'transport', label: '연결 방식', render: kindText(transportText) },
    { key: 'readTools', label: '읽기만 하는 도구', render: counted },
  ],
  activity: [
    { key: 'name', label: '이름', render: textOf },
    { key: 'ghostId', label: '맡긴 Ghost', render: ghostRef },
    { key: 'scopeId', label: '프로젝트', render: scopeRef },
    { key: 'prompt', label: '지시 내용', render: textOf },
    { key: 'acceptanceCriteria', label: '완료 기준', render: textOf },
    { key: 'source', label: '가져오는 곳', render: kindText(sourceText) },
    { key: 'execution', label: '실행 장소', render: kindText(executionText) },
    { key: 'tools', label: '쓸 수 있는 도구', render: counted },
    { key: 'policy', label: '세부 방식', render: activityPolicyOf },
    { key: 'paused', label: '켬 · 끔', render: onOff },
  ],
  limits: limitsFields,
  connection: [
    { key: 'name', label: '이름', render: textOf },
    { key: 'config', label: '연결 방식', render: kindText(connectionText) },
  ],
};

const revisionVerb = (revision: ConfigRevision): string => {
  const reason = revision.reason;
  if (reason.startsWith('config.revert')) return '되돌렸습니다';
  if (reason.endsWith('.create')) return '만들었습니다';
  if (reason.endsWith('.delete')) return '삭제했습니다';
  if (reason === 'ghost.set_default') return '기본으로 정했습니다';
  if (reason === 'activity.pause') return isObject(revision.after) ? (revision.after.paused === true ? '껐습니다' : '켰습니다') : '삭제했습니다';
  if (reason.includes('registration')) return '만들었습니다';
  if (reason.includes('replacement')) return '다시 연결했습니다';
  if ((reason === 'slot.set' || reason === 'connection.upsert') && revision.before === null) return '만들었습니다';
  return '바꿨습니다';
};

/** What the sentence points at, e.g. 「프로젝트 ‘비행 기록’」; `last` carries the particle. */
const revisionTopic = (revision: ConfigRevision, state: State | null): { text: string; last: string } => {
  const plain = (text: string) => ({ text, last: text });
  const name = [revision.after, revision.before].map(value => (isObject(value) && typeof value.name === 'string' ? value.name : '')).find(Boolean);
  switch (revision.entity) {
    case 'scope': {
      const found = name ?? (typeof revision.entityId === 'string' ? state?.scopes.find(scope => scope.id === revision.entityId)?.name : undefined);
      return found ? { text: `프로젝트 ‘${found}’`, last: found } : plain('프로젝트');
    }
    case 'ghost': {
      const found = name ?? (typeof revision.entityId === 'string' ? state?.ghosts.find(ghost => ghost.id === revision.entityId)?.name : undefined);
      return found ? { text: `Ghost ‘${found}’`, last: found } : plain('Ghost');
    }
    case 'rule': {
      const rule = asRule(revision.after) ?? asRule(revision.before);
      const subject = rule ? describeRule(rule, state).subject : '';
      return subject ? { text: `${uiTerms.rules} ‘${subject}’`, last: subject } : plain(uiTerms.rules);
    }
    case 'slot':
      return revision.entityId
        ? { text: `${uiTerms.modelCombos} ‘${revision.entityId}’`, last: revision.entityId }
        : plain(`기본 ${uiTerms.modelCombos}`);
    case 'mcp':
      return name ? { text: `${uiTerms.mcp} ‘${name}’`, last: name } : plain(uiTerms.mcp);
    case 'activity':
      return name ? { text: `${uiTerms.activities} ‘${name}’`, last: name } : plain(uiTerms.activities);
    case 'limits': {
      const scope = typeof revision.entityId === 'string' ? state?.scopes.find(item => item.id === revision.entityId)?.name : undefined;
      return scope ? { text: `‘${scope}’의 ${uiTerms.limits}`, last: uiTerms.limits } : plain(uiTerms.limits);
    }
    case 'connection':
      return name ? { text: `${uiTerms.connections} ‘${name}’`, last: name } : plain(uiTerms.connections);
  }
};

const actorPhrase = (revision: ConfigRevision, state: State | null): string => {
  const { kind, id } = revision.actor;
  if (kind === 'owner') return '내가';
  if (kind === 'ghost') {
    const name = typeof id === 'string' ? state?.ghosts.find(ghost => ghost.id === id)?.name ?? 'Ghost' : 'Ghost';
    return `${name}${endsConsonant(name) ? '이' : '가'}`;
  }
  const device = typeof id === 'string' ? state?.devices.find(item => item.id === id) : undefined;
  return `${device?.name ?? '기기'}에서`;
};

/** One plain sentence for the timeline, e.g. 「내가 프로젝트 ‘비행 기록’을 만들었습니다」. */
export function revisionSentence(revision: ConfigRevision, state: State | null): string {
  const topic = revisionTopic(revision, state);
  return `${actorPhrase(revision, state)} ${topic.text}${endsConsonant(topic.last) ? '을' : '를'} ${revisionVerb(revision)}`;
}

/** WHAT changed: mapped fields as `이름: 이전 → 이후`, the rest counted, creation and removal flagged. */
export function revisionChanges(revision: ConfigRevision, state: State | null): RevisionChanges {
  const before = revision.before;
  const after = revision.after;
  if (before == null || after == null) return { created: before == null, deleted: after == null, lines: [], extraCount: 0 };
  if (!isObject(before) || !isObject(after)) {
    // 기본 모델 조합처럼 값 자체가 저장되는 변경 (이름 없는 개체).
    return {
      created: false, deleted: false, extraCount: 0,
      lines: [{ label: `기본 ${uiTerms.modelCombos}`, before: String(before), after: String(after) }],
    };
  }
  const spec = fieldSpecs[revision.entity] ?? [];
  const known = new Set(spec.map(item => item.key));
  const lines: ChangeLine[] = [];
  for (const item of spec) {
    if (JSON.stringify(before[item.key]) === JSON.stringify(after[item.key])) continue;
    const was = item.render(before[item.key], state, 'before');
    const now = item.render(after[item.key], state, 'after');
    if (!was && !now) continue;
    lines.push({ label: item.label, before: was || '이전 설정', after: now || '새 설정' });
  }
  let extraCount = 0;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (!known.has(key) && !(key in skippedFields)) extraCount++;
  return { created: false, deleted: false, lines, extraCount };
}
