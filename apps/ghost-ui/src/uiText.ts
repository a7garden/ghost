// Stable product terms. See docs/ui-terminology.md for their scope and meaning.
import type { Provider } from '@ghost/contract';

/** Subscription account label per provider kind: Claude 계정 로그인 vs ChatGPT 계정 로그인. */
export const oauthName = (kind: Provider['kind']) => kind === 'anthropic' ? 'Claude' : 'ChatGPT';

export const uiTerms = {
  inbox: '확인할 일',
  work: '맡긴 일',
  goals: '목표',
  milestone: '이정표',
  workResults: '작업 결과',
  schedules: '반복 작업',
  activities: '자동 활동',
  rules: '승인 규칙',
  metrics: '성과와 비용',
  configHistory: '변경 기록',
  modelCombos: '모델 조합',
  limits: '작업량 한도',
  mcp: '외부 도구 서버',
  connectionStatus: '연결 상태',
  advanced: '고급',
  connections: '연결 계정',
  conversationHistory: '대화 기록',
  standingInstructions: '책임과 원칙',
  ghostSettings: 'Ghost 설정',
  settings: '설정',
} as const;

export const routeLabels = {
  home: '홈',
  conversations: '대화',
  settings: uiTerms.settings,
  inbox: uiTerms.inbox,
  work: uiTerms.work,
  coding: '코딩',
  mail: '메일',
  host: '호스트',
  scopes: '프로젝트',
  ghosts: 'Ghost',
} as const;
