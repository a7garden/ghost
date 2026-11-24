import type { PolicyConditions, PolicyDecision, PolicyRule, State } from '@ghost/contract';

/** What the owner reads for a tool name; unknown names (attached MCP tools, owner patterns) stay as written. */
const toolNames: Record<string, string> = {
  '*': '모든 행동',
  'browser_*': '브라우저 조작', browser_click: '브라우저 클릭', browser_press: '브라우저 키 입력', browser_propose: '브라우저 결제·전송 제안',
  browser_fill_card: '카드 정보 입력', browser_handoff: '브라우저를 나에게 넘김',
  'desktop_*': '데스크톱 조작', desktop_click: '데스크톱 클릭', desktop_press: '데스크톱 키 입력', desktop_pointer: '데스크톱 포인터 조작',
  desktop_keys: '데스크톱 키 입력', desktop_propose: '데스크톱 전송·삭제 제안',
  host_command_propose: 'Mac 명령 실행', document_propose: '문서 수정 제안', document_write: '문서 쓰기',
  activity_propose: '자동 활동 제안', activity_action: '자동 활동의 행동',
  capability_request: '새 권한 요청', ask_owner: '나에게 하는 질문', complete: '일 마무리 보고',
  connection_request: '연결 계정 사용', connection_register: '연결 계정 등록', vault_request: '금고 값 요청',
  goal_propose: '목표 제안', mail_send: '메일 보내기',
  'mcp.*': '외부 도구(MCP)',
};

export const toolLabel = (tool: string) => toolNames[tool] ?? (tool.startsWith('mcp.') ? `외부 도구 ${tool.slice(4)}` : tool.startsWith('conn.') ? `연결 계정 ${tool.slice(5)}` : tool);

export const targetKinds: { value: NonNullable<PolicyConditions['targetKind']>; label: string }[] = [
  { value: 'workspace', label: 'Ghost의 작업 공간' }, { value: 'scope_path', label: '프로젝트 폴더' }, { value: 'mac', label: '프로젝트 밖의 Mac' },
  { value: 'document_vault', label: '문서 금고' }, { value: 'connection', label: '연결 계정' }, { value: 'mcp_server', label: '외부 도구 서버' },
  { value: 'browser_origin', label: '웹사이트' }, { value: 'mail_account', label: '메일 계정' }, { value: 'host', label: 'Ghost 설정·금고' },
];

export const decisionLabels: Record<PolicyDecision, string> = { allow: '바로 진행', owner: '내가 확인', review: '검토 후 진행', deny: '막기' };

export const decisionHints: Record<PolicyDecision, string> = {
  allow: '묻지 않고 바로 진행합니다.', owner: '내가 승인해야 진행합니다.', review: '메인 Ghost나 지정한 검토자가 판단합니다.', deny: '항상 거절합니다.',
};

/** Yes/no conditions, worded as the owner would say them; `yes`/`no` complete "…인 일". */
export const conditionAxes = [
  { key: 'reversible', question: '되돌릴 수 있나요?', yes: '되돌릴 수 있는 일', no: '되돌릴 수 없는 일' },
  { key: 'external', question: '바깥으로 보내나요?', yes: '메일·게시·API 쓰기처럼 바깥으로 보내는 일', no: '바깥으로 보내지 않는 일' },
  { key: 'amount', question: '돈이 드나요?', yes: '돈이 드는 일', no: '돈이 들지 않는 일' },
  { key: 'untrustedInput', question: '믿기 어려운 내용을 읽었나요?', yes: '믿기 어려운 내용을 읽은 뒤의 일', no: '믿기 어려운 내용을 읽지 않은 일' },
  { key: 'privateData', question: '비공개 데이터를 읽었나요?', yes: '비공개 데이터를 읽은 뒤의 일', no: '비공개 데이터를 읽지 않은 일' },
] as const;

export interface RuleText {
  /** What the rule is about, e.g. 「브라우저 클릭」. */
  subject: string;
  /** Narrowing conditions in plain words; empty when the rule covers everything about the subject. */
  conditions: string[];
  /** What happens, e.g. 「막기」 or 「메인 Ghost가 검토 후 진행」. */
  outcome: string;
  /** Who and where the rule applies, e.g. 「모든 Ghost · 모든 프로젝트」. */
  reach: string;
  /** Limits and timeouts, plain words. */
  extras: string[];
}

const minutesText = (minutes: number) => minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분`;

/** A rule in the owner's words. Built-in rules read the same as the ones the owner writes. */
export function describeRule(rule: PolicyRule, state: Pick<State, 'ghosts' | 'scopes' | 'activities'> | null): RuleText {
  const ghostName = (id: string) => state?.ghosts.find(ghost => ghost.id === id)?.name ?? 'Ghost';
  const when = rule.when;
  const conditions: string[] = [];
  const target = targetKinds.find(item => item.value === when.targetKind)?.label;
  if (target) conditions.push(when.targetId ? `${target} ${when.targetId}` : target);
  else if (when.targetId) conditions.push(when.targetId);
  if (when.access) conditions.push(when.access === 'read' ? '보기만 하는 일' : '바꾸는 일');
  for (const axis of conditionAxes) if (when[axis.key] !== undefined) conditions.push(when[axis.key] ? axis.yes : axis.no);
  const reviewer = rule.reviewer ? rule.reviewer.kind === 'main' ? '메인 Ghost' : rule.reviewer.kind === 'ghost' ? ghostName(rule.reviewer.ghostId) : `모델 조합 ${rule.reviewer.slot}` : null;
  const outcome = rule.decision === 'review' && reviewer ? `${reviewer}가 검토 후 진행`
    : rule.decision === 'owner' && reviewer ? `${reviewer}가 먼저 보고 내가 확인` : decisionLabels[rule.decision];
  const who = rule.ghostId ? ghostName(rule.ghostId) : '모든 Ghost';
  const where = rule.scopeId ? state?.scopes.find(scope => scope.id === rule.scopeId)?.name ?? '프로젝트' : '모든 프로젝트';
  const activity = rule.triggerId ? state?.activities?.find(item => item.id === rule.triggerId)?.name ?? '자동 활동' : null;
  const extras = [
    rule.maxPerDay ? `하루 ${rule.maxPerDay}번까지만` : null,
    rule.maxAmount ? `${rule.maxAmount.value.toLocaleString('ko-KR')} ${rule.maxAmount.currency} 넘으면 내가 확인` : null,
    rule.autoResolve ? `${minutesText(rule.autoResolve.afterMinutes)} 안에 답이 없으면 ${rule.autoResolve.answer === 'approve' ? '승인' : '추천대로 진행'}` : null,
  ].filter((item): item is string => item !== null);
  return { subject: toolLabel(rule.tool), conditions, outcome, reach: [who, where, activity && `자동 활동 「${activity}」`].filter(Boolean).join(' · '), extras };
}

/** Rules the Host writes for itself: the built-in set and the ones an automatic activity's external-action choice generates. */
export const isSystemRule = (rule: PolicyRule) => rule.createdBy.kind === 'install' || rule.id.startsWith('activity:');
