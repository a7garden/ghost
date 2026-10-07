# 개인용 할 일·일정과 MCP 연동

Ghost의 로컬 작업실에서 개인 정리와 외부 서비스 작업을 함께 할 수 있다.
개인 할 일·일정은 `workspace.db`의 관리 데이터이고, 에이전트 실행 큐·목표·
반복 예약 및 PDC 문서 원본과 별개다. 기존 문서는 변환하지 않는다.

## 화면에서 쓰기

- **할 일과 일정**: 할 일 추가·수정·완료·다시 열기·삭제, 날짜별 일정 추가·수정·삭제.
  마감일은 날짜로 저장하고, 일정은 Unix milliseconds로 저장해 브라우저의 시간대로 표시한다.
  저장된 항목의 버전을 비교하므로 동시에 수정된 내용을 덮어쓰지 않는다.
- **연동**: 이름, 로컬 프로그램/실행 인자 또는 MCP URL, 사용할 Ghost를 저장한다.
  연결 확인으로 서버의 도구 목록을 가져오고, 도구 보기에서 설명과 입력 형식을 확인한다.
  끄기와 제거는 이후 도구 호출을 차단한다. 이미 외부로 보낸 요청의 취소는 보장하지 않는다.
- 도구를 사용하는 대화에서 “할 일 목록 보여줘”, “내일 할 일 추가해 줘”,
  “연결한 캘린더에서 이번 주 일정 확인해 줘”처럼 요청한다.
  기존 도구 활성 대화는 다음 유휴 턴에서 새 도구를 받는다. 도구를 끈 대화에는 추가하지 않는다.
  `mock` 모델은 실제 도구를 선택하지 않는다.

로컬 일정은 Google 캘린더와 자동 동기화하지 않는다. 외부 서비스 작업은 해당
연동 도구를 통해 원본 서비스에 수행한다. 일정 화면은 초대장, 알림, 반복 이벤트를
발송하거나 생성하지 않는다. 에이전트 반복 실행에는 기존 예약 기능을 사용한다.

## Google Calendar와 Tasks

[Workspace MCP](https://github.com/taylorwilsdon/google_workspace_mcp#quick-start)의
로컬 stdio 설정을 제공한다. Google 계정이 자동으로 연결되는 것은 아니다.

1. 프로젝트의 안내에 따라 Google OAuth client와 Calendar/Tasks API를 준비한다.
2. `uv tool install workspace-mcp`로 서버를 설치한다. Ghost가 실행되는 셸에서
   `workspace-mcp`를 찾을 수 있어야 한다. 필요하면 UI에 설치된 실행 파일의 절대 경로를 넣는다.
3. 호스트를 시작하는 환경에 `GOOGLE_OAUTH_CLIENT_ID`와 `GOOGLE_OAUTH_CLIENT_SECRET`을
   설정한다. UI에는 값이 아니라 환경 변수 이름만 입력한다.
4. **연동 → Google 캘린더와 Tasks → 설정 가져오기**로 등록한다.
   프리셋은 `workspace-mcp --transport stdio --tools calendar tasks`를 사용한다.
5. **연결 확인** 후 Ghost에게 Google 로그인 시작이나 일정 조회를 요청하고,
   서버가 반환하는 인증 안내를 완료한다. 도구 목록 확인은 계정 인증 성공을 의미하지 않는다.

이 저장소의 테스트에서는 실제 Google 자격 증명이나 계정을 사용하지 않았다.
원격 OAuth 리디렉션·토큰 갱신을 Ghost 자체에서 처리하는 기능은 제공하지 않는다.
OAuth가 필요한 서버는 로컬 MCP의 인증 흐름을 사용하거나, 인증을 마친 서버의
Bearer 토큰을 호스트 환경 변수로 공급한다.

## 다른 MCP 추가

stdio 설정의 실행 프로그램과 인자를 분리한다. 셸 문자열을 자동으로 해석하지 않는다.
프로세스는 연결 동안 유지되므로 인증 세션과 서버 내부 상태가 유지된다.
실행 환경에는 PATH/HOME/USER/TMPDIR/LANG/XDG_CONFIG_HOME 및 설정한 환경 변수만 전달한다.
로컬 MCP는 신뢰하는 프로그램을 직접 실행하는 기능이며 OS 샌드박스는 아니다.

Streamable HTTP는 JSON 응답과 SSE 응답, 세션 ID, 프로토콜 협상을 지원한다.
HTTPS 주소를 기본으로 받고 루프백만 HTTP를 허용한다. URL 내 자격 증명·쿼리는
허용하지 않는다. Bearer 토큰은 환경 변수 이름으로 지정한다. 리디렉션과 자동 재전송은 없다.
구형 HTTP+SSE의 별도 `/sse` 연결, 서버가 요청하는 모델 실행·파일 루트·elicitation은 지원하지 않는다.
각 연동 동작은 25초, 메시지와 전체 도구 목록은 1 MiB, 도구 수는 1000개로 제한한다.

연결과 Ghost 접근 권한은 소유자 제어 API에서만 변경한다. 모델은 자신의 연동을
검색하고 실제 서버 스키마에 따라 호출할 수 있다. 위임된 Ghost의 호출은 모든
상위 송신자의 현재 연동 접근 범위로 제한된다. 외부 호출은 기존 durable 효과
기록에 저장되며 재시작 후 자동 재실행하지 않는다. 전송 도중 결과를 잃으면
`uncertain`으로 보고하므로 외부 서비스에서 결과를 확인한 후 후속 작업을 결정한다.

## 제어 API

기존 `ghost control send --file command.json`으로 아래 `command`를 보내면 된다.
봉투의 `request_id`에는 새 UUID를 사용한다. 같은 요청을 다시 확인할 때는 같은 ID를 유지한다.

```json
{
  "request_id": "00000000-0000-4000-8000-000000000001",
  "command": {
    "type": "workspace",
    "action": {
      "type": "save_todo",
      "todo": { "title": "주간 계획 정리", "notes": "", "due": "2026-10-03", "completed": false }
    }
  }
}
```

`save_todo`/`save_calendar_event`는 새 항목에는 `id`와 `version`을 생략하고,
수정에는 현재 값을 보낸다. 삭제는 `delete_todo`/`delete_calendar_event`에 현재
`id`, `version`을 보낸다. 일정 데이터는 `event: {title, notes, start_ms, end_ms}`다.

`save_integration`은 `integration: {name, transport, profiles, enabled}`를 받는다.
`transport`는 다음 둘 중 하나다. 값은 모두 예시다.

```json
{"kind":"stdio","command":"my-mcp-server","args":[],"env_refs":{"API_TOKEN":"MY_SERVICE_TOKEN"},"cwd":null}
```

```json
{"kind":"http","url":"https://example.com/mcp","bearer_env":"MY_MCP_TOKEN"}
```

`check_integration`은 `id`, `delete_integration`은 `id`, `version`을 받는다.
모델 도구는 `list_integrations`, `integration_tools`, `integration_call`과
로컬 할 일·일정 조회/저장/삭제 도구다. 검색한 MCP 도구의 입력 스키마를 사용한다.

## 참고와 검증

[Open Dots](https://github.com/Anil-matcha/open-dots)의 연결 설정과 공통 action gateway,
[OpenMuse](https://github.com/CelestoAI/celesto/tree/main/open-muse)의 실행 내역·상태 표시를
참고했다. 해당 코드의 의존성을 추가하거나 복사하지 않았으며, Ghost의 기존 호스트,
정책과 durable 실행 구조에 연결했다.

테스트는 실제 stdio 자식 프로세스와 익명 루프백 HTTP/SSE 서버를 사용한다.
도구 페이지 처리, 세션 유지, 알림, 계정 미설정, 접근 해제, 실행 직전 권한 재확인,
결과 불명, 로컬 데이터의 저장·중복 방지·버전 충돌·재시작 복구 및 날짜 경계를 검증한다.
