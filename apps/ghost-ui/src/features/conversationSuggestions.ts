import { profileSummary } from './profileSummary';

const generalLabels = ['요청 구체화', '단계 나누기'];
const general = [
  '맡길 일을 설명할게. 먼저 필요한 정보와 범위를 짚어줘',
  '내 요청을 단계로 나누고 먼저 확인할 점을 알려줘',
];
const roles = [
  {
    matches: /리서처|연구자|조사|researcher|research assistant/i,
    labels: ['조사 시작', '비교 기준'],
    prompts: ['조사할 주제를 알려줄게. 확인할 질문과 출처부터 정리해줘', '비교할 대상을 알려줄게. 판단 기준을 함께 정해줘'],
  },
  {
    matches: /에디터|편집자|글쓰기|작가|\b(?:editor|writer)\b/i,
    labels: ['문장 다듬기', '글 구성'],
    prompts: ['글을 붙여넣을게. 핵심을 유지하면서 문장을 다듬어줘', '전하고 싶은 내용을 적을게. 글의 순서를 함께 잡아줘'],
  },
  {
    matches: /개발자|프로그래머|\b(?:developer|programmer|software engineer)\b/i,
    labels: ['기능 설계', '오류 분석'],
    prompts: ['만들고 싶은 기능을 설명할게. 구현 전에 확인할 조건을 정리해줘', '오류 메시지를 붙여넣을게. 원인 후보와 확인 방법을 짚어줘'],
  },
  {
    matches: /계획|할 일|일정|플래너/i,
    labels: ['맡긴 일 진행', '주간 계획'],
    prompts: ['맡긴 일의 진행 상황을 정리하고 다음 단계를 짚어줘', '이번 주 목표를 작은 할 일로 나누고 필요한 준비를 짚어줘'],
  },
];

/** Use the visible role introduction, not names or tool instructions, to offer draft examples. */
export function conversationStarters(persona: string): readonly { label: string; prompt: string }[] {
  const summary = profileSummary(persona);
  const matching = roles.filter(role => role.matches.test(summary));
  const { labels, prompts } = matching.length === 1 ? matching[0] : { labels: generalLabels, prompts: general };
  return prompts.map((prompt, index) => ({ label: labels[index], prompt }));
}

export function conversationSuggestions(persona: string): readonly string[] {
  return conversationStarters(persona).map(starter => starter.prompt);
}
