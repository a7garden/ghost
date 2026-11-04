// Stable product terms. See docs/ui-terminology.md for their scope and meaning.
export const uiTerms = {
  workspace: '작업실',
  inbox: '확인할 일',
  work: '맡긴 일',
  collaboration: '협업',
  reviews: '문서 검토',
  schedules: '반복 작업',
  conversationHistory: '대화 기록',
  roleInstructions: '역할 지시',
  workResults: '작업 결과',
  goals: '목표',
  settings: '설정',
} as const;

export const routeLabels = {
  home: '대시보드',
  settings: uiTerms.settings,
  inbox: uiTerms.inbox,
  work: uiTerms.work,
  together: uiTerms.collaboration,
  integrations: '확장',
  providers: '프로바이더',
  host: '호스트',
  spaces: '문서 공간',
  ghosts: 'Ghost',
  lifetime: '대화',
} as const;
