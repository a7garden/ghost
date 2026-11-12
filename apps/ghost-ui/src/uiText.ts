// Stable product terms. See docs/ui-terminology.md for their scope and meaning.
export const uiTerms = {
  inbox: '확인할 일',
  work: '맡긴 일',
  goals: '목표',
  milestone: '이정표',
  workResults: '작업 결과',
  schedules: '반복 작업',
  activities: '자동 활동',
  connections: '연결 계정',
  conversationHistory: '대화 기록',
  roleInstructions: '역할 지시',
  ghostSettings: 'Ghost 설정',
  settings: '설정',
} as const;

export const routeLabels = {
  home: '홈',
  conversations: '대화',
  settings: uiTerms.settings,
  inbox: uiTerms.inbox,
  work: uiTerms.work,
  mail: '메일',
  host: '호스트',
  scopes: '프로젝트',
  ghosts: 'Ghost',
} as const;
