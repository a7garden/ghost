# 에이전트 기본 지침: 글쓰기, UI 디자인, 토큰 절약

모든 Ghost와 내장 코딩 에이전트가 기본으로 받는 지침의 근거와 적용 위치를 적는다. 지침 원문은 `apps/ghost-host/src/core/conduct.ts` 한 곳에 있다(소유자 지시 2026-11-25, em dash 금지는 2026-11-12).

## 적용 위치

| 지침 | 직접 대화 | 깨어남 | 맡긴 일 | 검토 | 읽기 도우미 | 코딩 에이전트 |
| --- | --- | --- | --- | --- | --- | --- |
| `WRITING_CONDUCT` 글쓰기 | O | O | O | | | O |
| `DESIGN_CONDUCT` UI 디자인 | O | | O | | | O |
| `CODING_CONDUCT` 코드 변경 | | | O | | | O |
| `CONTEXT_ECONOMY` 맥락 절약 | O | O | O | O | O | O |

대화 종류별 조립은 `tools/index.ts`의 `instructionsFor`, 코딩 에이전트는 `coding/index.ts`의 `appendSystemPrompt`다.

## 지침을 쓰는 방식

조사에서 가장 일관된 결론은 무엇을 쓰지 말라는 목록보다 원하는 모습과 그 이유를 말해야 한다는 것이다. 그래서 지침은 다음을 따른다.

- 금지 단어를 나열하지 않는다. 부정 제약이 실패하는 경우의 87.5%에서 금지어를 언급한 것 자체가 그 단어를 끌어냈다([arXiv 2601.08070](https://arxiv.org/html/2601.08070)). 지시가 길고 다양할수록 이 경향이 강하다는 한국어 관찰도 있다([fluent-korean](https://github.com/snflkd/fluent-korean)).
- 이유를 붙인다. Anthropic은 「줄임표를 쓰지 마라」보다 「음성으로 읽히니 줄임표를 쓰지 마라」가 더 잘 일반화된다고 쓴다([Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).
- 지침 자체를 원하는 문체로 쓴다. 같은 문서는 프롬프트의 서식이 응답 서식에 영향을 준다고 쓴다. 그래서 지침은 평범한 문단이고, 모델이 읽는 Host 문자열(지침, 도구 설명, 도구 결과)에서 em dash를 모두 걷어냈다. em dash는 글자 대신 코드 포인트 U+2014로 가리킨다.
- 짧게 둔다. 맥락은 길수록 정확도가 떨어지고([Chroma, Context rot](https://research.trychroma.com/context-rot)), 모순되거나 모호한 지시는 추론 모델에 더 해롭다([OpenAI GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)).

## 글쓰기

| 근거 | 지침에 반영한 것 |
| --- | --- |
| [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) | 의미를 부풀리는 꼬리 절, 평범한 동사 대신 부풀린 동사, 「A가 아니라 B」 대비 틀, 셋씩 묶는 나열, 칭찬하거나 요청을 되풀이하는 첫머리, 요약과 제안으로 끝맺기 |
| [sloptells](https://sloptells.com/tells.md) | 문장 길이의 균일함이 짧음보다 강한 표지다. 대화 답에 굵은 글씨와 목록, 이모지 구조를 쓰는 비율이 사람보다 수십 배 높다 |
| [KatFishNet, ACL 2025](https://aclanthology.org/2025.acl-long.1030) | 한국어 LLM 글은 접속어 뒤 쉼표와 품사 패턴의 단조로움으로 가장 잘 구별된다. 접속어는 논리가 꺾일 때만, 종결 어미는 자연스럽게 다르게 |
| [yoonmoon AI-tell taxonomy](https://github.com/amondnet/yoonmoon/blob/main/skills/humanize/references/ai-tell-taxonomy.md), 번역투 연구 | 능동문과 분명한 주어, 명사를 쌓는 대신 동사, 영어 구문을 옮긴 표현 대신 한국어 어순과 조사 |
| 소유자 지시 2026-11-12 | em dash 금지. en dash나 겹하이픈으로 바꾸지 않고 쉼표, 콜론, 괄호, 문장 나누기로 잇는다. 화살표, 체크 표시, 이모지는 의미가 있을 때만 |

em dash 하나는 AI 글의 증거가 아니고(sloptells는 낡은 표지로 분류한다), 문장부호를 지나치게 줄인 글도 표지가 된다. 그래서 지침은 쉼표, 콜론, 괄호를 쓰라고 말하고 다른 부호까지 막지 않는다.

## UI 디자인

| 근거 | 지침에 반영한 것 |
| --- | --- |
| [Anthropic, Improving frontend design through Skills](https://claude.com/blog/improving-frontend-design-through-skills) | 방향이 없으면 모델은 학습 데이터의 가장 안전한 중심(분포 수렴)을 고른다. 금지만 하면 다음 흔한 선택으로 옮겨 갈 뿐이라, 내용에서 출발하라는 방향을 준다 |
| [anthropics/skills frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) | 같은 반경과 그림자의 카드로 쪼갠 내용, 장식용 그라데이션, 모든 제목 위의 작은 대문자 라벨, 순서가 아닌 내용의 01/02/03, 버튼 글자 뒤 화살표, 모든 hover의 움직임. 강조는 한 곳에 |
| [Design Theater, arXiv 2607.22928](https://arxiv.org/abs/2607.22928) | 생성 도구들의 UI가 모양과 배치에서 서로 수렴한다 |
| [NN/g Consistency and standards](https://www.nngroup.com/articles/consistency-and-standards/), [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/design-principles) | 모양은 새로워도 조작은 익숙하게. 로그인, 설정, 평범한 양식은 표준 컨트롤 |
| [W3C ARIA APG](https://www.w3.org/WAI/ARIA/apg/practices/read-me-first/), [HIG Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | 네이티브 요소나 정해진 ARIA 패턴, 키보드, 보이는 초점, 접근 가능한 이름, 모든 상태, iPhone 44pt 터치 영역, 화면당 주 동작 하나 |

기본 버튼이나 카드를 피하라는 금지가 아니라, 내용의 구조(순서, 비교, 시간에 따른 상태, 결정 하나)를 먼저 말하고 그 구조가 요구하는 컴포넌트를 만들라는 지시다. 소유자의 `anti-slop` 스킬 `design-profile.md`의 「Shape components to the content」「Novel form, familiar contract」와 같은 입장이다.

## 맥락과 토큰

| 근거 | 지침 또는 Host 구조에 반영한 것 |
| --- | --- |
| [Anthropic, Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 필요한 순간에 찾아 읽기: 검색과 목록으로 위치를 찾은 뒤 필요한 범위만 읽는다. 이미 읽은 것은 다시 읽지 않는다 |
| [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | 독립된 읽기는 한 번에 병렬로. 충분한 결과가 있는데 계속 찾는 것이 주된 실패였다 |
| [OpenAI GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide), [Codex prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) | 답이 뒷받침되면 멈추고, 실패한 검색을 되풀이하지 않는다. 호출 사이에 계획을 늘어놓지 않는다 |
| [Anthropic, Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | 도구 결과는 필요한 줄만 인용하고 나머지는 이름으로 가리킨다 |
| [Claude Code best practices](https://code.claude.com/docs/en/best-practices) | 편집이 끝난 뒤 변경을 덮는 가장 좁은 검사를 한 번. 이미 본 검사 결과를 다시 돌리지 않는다 |
| [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | 캐시 읽기는 기본 입력의 0.1배 이하이고, 앞부분이 바뀌면 그 뒤 전체가 다시 계산된다 |

Host 구조: Pi Durable은 매 요청 시스템 구획(section)을 다시 그리고, 값이 바뀐 구획만 대화 끝에 새 시스템 메시지로 붙인다. 이전에는 페르소나, 대화 종류 지침, 메모리, 범위와 첨부가 `ghost_context` 한 구획이어서 메모리 색인이나 첨부가 바뀔 때마다 수천 토큰의 지침 전체가 다시 붙었다. 이제 `ghost_instructions`(페르소나와 지침), `ghost_memory`(메모리 색인), `ghost_context`(범위와 첨부) 세 구획으로 나눠 바뀐 부분만 다시 붙는다(`engine/index.ts`). 기존 대화는 처음 한 번 세 구획으로 다시 쓰인다.

## 고칠 때

새 규칙은 관찰된 실패에서만 더한다. 금지어 목록을 늘리기보다 원하는 모습과 이유를 한 문장으로 쓰고, 모델이 읽는 Host 문자열에 em dash를 넣지 않는다.
