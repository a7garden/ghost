// Stable product terms. See docs/ui-terminology.md for their scope and meaning.
export const uiTerms = {
  inbox: '확인할 일',
  work: '맡긴 일',
  workResults: '작업 결과',
  schedules: '반복 작업',
  conversationHistory: '대화 기록',
  roleInstructions: '역할 지시',
  ghostSettings: 'Ghost 설정',
  settings: '설정',
} as const;

export const routeLabels = {
  home: '홈',
  settings: uiTerms.settings,
  inbox: uiTerms.inbox,
  work: uiTerms.work,
  host: '호스트',
  spaces: '프로젝트',
  ghosts: 'Ghost',
} as const;
