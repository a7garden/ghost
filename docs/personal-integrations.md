# 외부 MCP 연동

Ghost의 **확장**에서 MCP 연결, 사용할 Ghost, 도구 권한을 관리한다.
목록 확인으로 서버에서 도구 이름과 입력 형식을 가져온다. 연결을 끄거나 제거하면
이후 호출이 차단된다. 이미 보낸 요청은 원본 서비스에서 상태를 확인한다.

## 주 Ghost에서 외부 기능 사용

1. **확장**에서 연결을 등록하고 사용할 Ghost를 선택한 뒤 **목록 확인**을 실행한다.
2. **도구 권한**에서 승인 요청을 허용할 기능을 선택한다. 새 연결은 선택 목록이 비어
   시작한다. 기존 직접 실행 방식의 연결은 이 화면에서 승인 방식으로 전환할 수 있다.
3. 주 Ghost 또는 해당 Ghost의 대화에서 원하는 외부 작업을 요청한다.
   일반 대화는 같은 입력창에서 바로 이어 간다. 외부 실행 제안은 **확인할 일**에서 검토한다.
4. 전송 입력을 확인해 승인하면 Host가 연결 권한, 입력 형식과 안건 상태를 다시 확인한 뒤 한 번 호출한다.
   서비스 응답의 텍스트나 구조화된 결과는 승인 상세에서 확인한다. 연결이나 도구 권한 변경은
   기존 안건을 무효화한다. 전송 결과가 미확정이면 Host는 다시 보내지 않으며
   원본 서비스에서 결과를 확인할 수 있다.

도구 승인 기능을 지원하는 Host에서는 Workspace MCP의 Gmail OAuth 설정을 마친 뒤
**확장 → MCP 설정 예시 → Gmail**에서 등록하고
`send_gmail_message`를 선택한다. 검토 상세에 수신자·제목·본문과 전송 입력이 표시된다.
승인 전용으로 전환된 연결은 이를 지원하는 Host에 표시된다. 이전 Host에는 해당 연결이 노출되지 않는다.

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

기존 `ghost control send --file command.json`으로 `workspace` 명령을 보낸다.
봉투의 `request_id`에는 새 UUID를 사용한다. 같은 요청을 다시 확인할 때는 같은 ID를 유지한다.

`save_integration`은 `integration: {name, transport, profiles, enabled}`를 받는다.
`transport`는 다음 둘 중 하나다. 값은 모두 예시다.

```json
{"kind":"stdio","command":"my-mcp-server","args":[],"env_refs":{"API_TOKEN":"MY_SERVICE_TOKEN"},"cwd":null}
```

```json
{"kind":"http","url":"https://example.com/mcp","bearer_env":"MY_MCP_TOKEN"}
```

`check_integration`은 `id`, `delete_integration`은 `id`, `version`을 받는다.
모델은 `list_integrations`, `integration_tools`, `integration_call`로 연결과 도구를
찾고 호출한다. 호출에는 검색한 도구의 입력 스키마를 사용한다.

## 기존 플래너 호환

개인 할 일·일정 기록, 기존 연결과 Google 인증 임대는 보존한다. Host의 기존
`save_todo`, `save_calendar_event`, 컬렉션 동기화 제어 API와 `caldav` 전송은
호환 목적으로 남아 있다. 해당 기록은 Ghost 작업 원장과 별개다.
이전 `/planner` 링크는 **맡긴 일**을 열고, 기존 MCP 연결은 **확장**에 표시된다.

기존 플래너 모델 도구는 구형 실행 경로의 호환용이다. 정본 Pi 대화의 도구 목록에서
개인 할 일·일정 도구는 제공하지 않는다. 구형 도구의 저장 결과는 **맡긴 일**에 나타나지 않는다.

기존 Google 인증 임대는 `caldav` 빌드에서 관리한다. 기존 임대 파일을
`GHOST_GOOGLE_TOKEN_STORE`로 지정하고 `ghost planner-google status`로 상태를 확인하거나
`ghost planner-google revoke`로 철회한다. Google이 철회나 토큰 무효를 확인한 뒤
같은 임대의 로컬 파일을 제거한다.

## 참고와 검증

[Open Dots](https://github.com/Anil-matcha/open-dots)의 연결 설정과 공통 action gateway,
[OpenMuse](https://github.com/CelestoAI/celesto/tree/main/open-muse)의 실행 내역·상태 표시를
참고했다. 해당 코드의 의존성을 추가하거나 복사하지 않았으며, Ghost의 기존 호스트,
정책과 durable 실행 구조에 연결했다.

테스트는 실제 stdio 자식 프로세스와 익명 루프백 HTTP/SSE 서버를 사용한다.
도구 페이지 처리, 세션 유지, 알림, 계정 미설정, 접근 해제, 실행 직전 권한 재확인,
결과 불명, 로컬 데이터의 저장·중복 방지·버전 충돌·재시작 복구 및 날짜 경계를 검증한다.
