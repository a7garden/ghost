import type { Snapshot, Page } from '../client/types';

// Explicit fictional design fixtures. Never merged into a connected host.
export function initialWorkspace(): Snapshot {
  return {
    workspace_id: 'ghost-ui-demo-v1', avatars: [], default_model: 'mock', capabilities: {}, connectors: {}, todos: [], calendar_events: [], integrations: [],
    profiles: [
      { id: 'sage', name: 'Sage', persona: '흩어진 자료에서 다음 판단의 근거를 찾는 리서처', policy: {}, conversations: [{ id: 'sage-chat', title: '새로운 에이전트 도구 조사', model: 'mock', offline: true, messages: [
        { role: 'user', text: '새로 나온 에이전트 도구들을 살펴보고, 우리 프로젝트에 필요한 것만 추려줘.' },
        { role: 'assistant', text: '실행의 지속성, 사람의 개입, 결과의 보존을 기준으로 나눠볼게요. 비교표와 함께 먼저 확인할 부분을 정리하겠습니다.' },
        { role: 'tool', text: '공개 문서 검토', tool: { name: 'research', output: { summary: '예시 조사 노트', status: 'success', content: { sources: ['공식 문서', '공개 저장소'], note: '이 내용은 화면 구성을 위한 예시입니다.' } } } },
      ], tasks: [{ id: 'task-research', name: '새로운 에이전트 도구 조사', phase: 'waiting_child', partial: '', output: '' }, { id: 'delegate-writing', parent_id: 'task-research', name: '소개 문서 협업', phase: 'waiting_child', partial: '', output: '' }, { id: 'delegate-code', parent_id: 'task-research', name: '접근성 점검 협업', phase: 'waiting_child', partial: '', output: '' }] }] },
      { id: 'milo', name: 'Milo', persona: '복잡한 생각을 읽기 좋은 글로 다듬는 에디터', policy: {}, conversations: [{ id: 'milo-chat', title: 'Ghost 소개 문서 다듬기', model: 'mock', offline: true, messages: [
        { role: 'user', text: 'Ghost를 처음 쓰는 사람에게 보여줄 짧은 소개 문서를 만들어줘. 저장하기 전에 보여줘.' },
        { role: 'assistant', text: '처음 만나는 사람도 바로 이해할 수 있도록 세 가지 흐름으로 정리했어요. 초안을 확인해 주시면 문서 공간에 저장하겠습니다.' },
      ], tasks: [{ id: 'task-writing', name: 'Ghost 소개 문서 다듬기', phase: 'waiting_owner', partial: '', output: '' }] }] },
      { id: 'nova', name: 'Nova', persona: '아이디어를 작동하는 작은 제품으로 만드는 개발자', policy: {}, conversations: [{ id: 'nova-chat', title: '관리 화면 접근성 점검', model: 'mock', offline: true, messages: [
        { role: 'user', text: '관리 화면을 키보드만으로 쓸 수 있는지 점검해줘.' },
        { role: 'assistant', text: '탐색 순서와 포커스 표시, 작은 화면의 조작을 차례로 살펴보겠습니다.' },
      ], tasks: [{ id: 'task-code', name: '관리 화면 접근성 점검', phase: 'model_running', partial: '탐색 메뉴와 대화 입력의 포커스 흐름을 확인하는 예시입니다.', output: '' }] }] },
      { id: 'theo', name: 'Theo', persona: '계획과 작은 할 일을 놓치지 않게 챙기는 파트너', policy: {}, conversations: [{ id: 'theo-chat', title: '이번 주 작업 정리', model: 'mock', offline: true, messages: [
        { role: 'assistant', text: '이번 주 작업을 정리해 두었어요. 새로운 일이 생기면 함께 우선순위를 정해봐요.' },
      ], tasks: [{ id: 'task-plan', name: '이번 주 작업 정리', phase: 'complete', partial: '', output: '우선순위와 다음 행동을 정리한 예시 결과입니다.' }] }] },
    ],
    delegations: [
      { id: 'collab-writing', owner: 'sage', owner_task: 'delegate-writing', target: 'milo', conversation_id: 'milo-chat', task_id: 'task-writing', background: false, state: 'running' },
      { id: 'collab-code', owner: 'sage', owner_task: 'delegate-code', target: 'nova', conversation_id: 'nova-chat', task_id: 'task-code', background: true, state: 'running' },
    ],
    reviews: [{ id: 'review-intro', profile_id: 'milo', conversation_id: 'milo-chat', title: 'Ghost 소개 문서를 저장할까요?', body: '# 함께 일하는 나의 Ghost\n\nGhost는 맡은 일을 이어가는 개인 에이전트입니다.\n\n## 일을 맡기세요\n조사, 글쓰기, 개발처럼 역할에 맞는 Ghost에게 원하는 결과를 알려주세요.\n\n## 필요할 때 함께 결정하세요\n검토가 필요한 내용은 저장 전에 보여줍니다.\n\n## 결과에서 이어가세요\n완성된 문서와 대화는 다음 작업의 출발점이 됩니다.\n\n— 화면 검증을 위한 예시 초안', state: 'pending', space_id: 'space-ghost', page_id: 'page-intro', expected_hash: null }],
    goals: [
      { id: 'goal-research', profile_id: 'sage', title: '매주 에이전트 도구 동향 정리', criteria: '새로운 도구와 적용할 만한 변화를 근거와 함께 정리', instruction: '에이전트 도구 동향을 살펴봐줘.', state: 'running', evidence: [], note: '공식 문서에서 바뀐 내용을 살펴보고 있어요.' },
      { id: 'goal-launch', profile_id: 'milo', title: '첫 사용자를 위한 시작 가이드', criteria: '소개와 시작 방법을 문서로 정리', instruction: '시작 가이드를 만들어줘.', state: 'running', evidence: [], note: '소개 문서의 저장을 기다리고 있어요.' },
    ],
    schedules: [{ id: 'schedule-weekly', profile_id: 'sage', conversation_id: 'sage-chat', prompt: '새로운 에이전트 도구 동향 정리', interval_seconds: 604800, next_run_ms: new Date('2026-10-05T09:00:00+09:00').getTime(), paused: false }],
    spaces: [{ id: 'space-ghost', name: 'Ghost 프로젝트', path: '', writable: true, profiles: ['sage', 'milo', 'nova'] }, { id: 'space-notes', name: '생각과 기록', path: '', writable: true, profiles: ['theo'] }],
  };
}
export const examplePages: Record<string, Page[]> = {
  'space-ghost': [{ id: 'page-brief', locator: 'brief.md', title: 'Ghost 프로젝트 브리프', profile: 'example', body: '여러 Ghost가 각자의 역할을 맡아 함께 일하는 개인 작업실.\n\n목표\n• 진행 중인 일을 한눈에 확인한다.\n• 필요한 결정에 집중한다.\n• 대화에서 결과까지 맥락을 이어간다.\n\n이 문서는 UI 검증을 위한 예시입니다.' }],
  'space-notes': [{ id: 'page-week', locator: 'week.md', title: '이번 주, 집중할 일', profile: 'example', body: '1. Ghost의 첫 관리 화면 만들기\n2. 작업을 맡기고 결과를 검토하는 흐름 확인\n3. 다음 주 계획 정리\n\n이 문서는 UI 검증을 위한 예시입니다.' }],
};
