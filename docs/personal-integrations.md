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

## 주 Ghost에서 외부 기능 사용

1. **연동**에서 연결을 등록하고 사용할 Ghost를 선택한 뒤 **연결 확인**을 실행한다.
2. **도구 권한**에서 승인 요청을 허용할 기능을 선택한다. 새 연결은 선택 목록이 비어
   시작한다. 기존 직접 실행 방식의 연결은 이 화면에서 승인 방식으로 전환할 수 있다.
3. 주 Ghost 또는 해당 Ghost의 대화에서 원하는 외부 작업을 요청한다.
   일반 대화는 같은 입력창에서 바로 이어 간다. 외부 실행 제안은 **확인할 일**에서 검토한다.
4. 전송 입력을 확인해 승인하면 Host가 연결 권한, 입력 형식과 안건 상태를 다시 확인한 뒤 한 번 호출한다.
   서비스 응답의 텍스트나 구조화된 결과는 승인 상세에서 확인한다. 연결이나 도구 권한 변경은
   기존 안건을 무효화한다. 전송 결과가 미확정이면 Host는 다시 보내지 않으며
   원본 서비스에서 결과를 확인할 수 있다.

Gmail은 Workspace MCP의 Gmail OAuth 설정을 마친 뒤 **연동 → Gmail**에서 등록하고
`send_gmail_message`를 선택한다. 검토 상세에 수신자·제목·본문과 전송 입력이 표시된다.
승인 전용으로 전환된 연결은 이를 지원하는 Host에 표시된다. 이전 Host에는 해당 연결이 노출되지 않는다.

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
위 MCP 연동 경로에서 Ghost가 리디렉션·토큰 갱신을 대신 처리하지는 않는다.
OAuth가 필요한 서버는 로컬 MCP의 인증 흐름을 사용하거나, 인증을 마친 서버의
Bearer 토큰을 호스트 환경 변수로 공급한다. 연결된 일정·할 일의 호스트 자체
Google 인증은 아래 절을 따른다.

## 연결된 Google 일정·할 일 (호스트 자체 인증)

연결된 컬렉션은 로컬 목록과 별도로 원격 Google Calendar/Tasks를 읽는 창이다.
`caldav` 기능으로 빌드된 Host와 UI의 “연결된 목록” 화면에서 사용한다.

1. **OAuth client 준비**: Google Cloud에서 installed-app OAuth client를 만들고
   Calendar/Tasks API를 켠다. client 자격은 개인 파일(0600)로 저장한다.
   ```json
   {"schema":"ghost-google-oauth-client/1","client_id":"...","client_secret":"..."}
   ```
   Host·CLI 환경에 `GHOST_GOOGLE_OAUTH_CLIENT=<파일 절대경로>`를 설정한다.
2. **동의 및 임대 저장**: `ghost planner-google login --account <라벨>`을 실행해
   표시된 URL에서 브라우저로 동의한다(기본 스코프는 읽기 전용이고, `--write`는
   이벤트·작업 쓰기 스코프를 추가한다). 루프백 리디렉션으로 받은 임대는
   `GHOST_GOOGLE_TOKEN_STORE`가 가리키는 0600 파일에 저장된다. 토큰은
   출력되지 않고, 갱신 토큰이 있으면 Host가 만료 전 자동 갱신하며 Google이
   교체 갱신 토큰을 반환하면 그 값이 저장된다. 콜백은 10분의 절대 마감 안에서
   예상 state가 확인된 응답만 받아들이고, 다른 state·경로·형식의 요청은
   무시된다. `--account` 라벨은 소유자가 붙인 로컬 이름일 뿐 Google 계정
   신원과 대조되지 않는다( userinfo 스코프를 요청하지 않는다). 로그인 확정과
   철회는 임대 저장소 옆 `<파일>.lock` 잠금으로 전 프로세스가 직렬화되고,
   저장 내용 세대(compare-and-swap) 기준으로 반영된다. 동의 중 저장소가
   다른 로그인으로 바뀌었으면 `--replace`가 있어도 같은 계정 라벨이 아니면
   덮어쓰지 않는다. 임대 파일과 client 파일이 있는 디렉터리 체인은 소유자
   전용이어야 한다(그룹·기타 쓰기 가능 디렉터리와 심볼릭 링크 항목은
   거부되고, 각 구성 요소는 실행 사용자 또는 root 소유여야 한다). macOS
   확장 ACL의 ALLOW 항목은 0600 파일 노출이나 디렉터리 항목 교체를 허용할
   수 있어 거부되며, DENY 항목(예: "group:everyone deny delete")은 무해하게
   허용된다. 이 강화된 격리는 libc 포함 빌드(caldav·lifetime)에서 동작하고,
   그 외 빌드에서는 자격 파일 I/O 자체가 거부된다.
   `ghost planner-google status`로 상태를 확인하고 `ghost planner-google
   revoke`로 Google에서 철회한다. revoke는 갱신 토큰이 있으면 그 자격을
   철회 대상으로 삼고, Google이 확인한 뒤 같은 세대의 파일만 제거한다(제거는
   디렉터리 동기화로 영구 반영된다). 철회 결과를 확인할 수 없거나 철회 중에
   새 로그인이 저장소를 바꿨으면 파일을 남겨 두고 다시 시도한다.
3. **컬렉션 연결**: 제어 API의 `save_planner_collection`으로 `wire_format`
   `google_calendar`(VEVENT) 또는 `google_tasks`(VTODO) 컬렉션을 만든다.
   새 컬렉션은 항상 `read_only_import`로 시작하며, `account_ref`는 로그인에
   쓴 라벨과 정확히 일치해야 하고 `collection_ref`는 Google의 정확한 컬렉션
   식별자다. `primary`·`@default`는 받지 않는다.
4. **읽기와 쓰기**: `planner_sync_once`(UI의 “원격 목록 새로 읽기”)는 항상
   전체 원본 목록을 다시 읽고 `write:false`로는 대기 중인 쓰기를 절대 보내지
   않는다. 원격 쓰기는 컬렉션이 `explicit_active` 단계일 때 소유자의
   `write:true` 요청으로만 진행된다. 결과 불명(`uncertain`) 쓰기는 같은
   요청에서 다시 보내지 않고 안정된 원격 항목 ID로 상태를 재확인하며,
   읽어서 확인할 수 없으면 불명 상태로 남는다. 충돌은 소유자 해석 대상이다.

CalDAV 컬렉션은 자격 없는 HTTPS 컬렉션 URL을 `binding`으로 쓰며 같은 단계
모델을 따른다. 연결 상태는 네트워크 없이 임대 저장소와 바인딩 검증으로
판정하며, 자격이 없으면 `credential_required`로 표시한다.

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
