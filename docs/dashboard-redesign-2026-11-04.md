# Ghost 대시보드·동등한 지속형 봇·iPhone 재설계

2026-11-04. 기준 소스 `a9479fc`. 이 문서는 소스 변경과 실제 검증 범위를 기록한다.
운영 `com.a7.ghost`, 설치된 Mac/iPhone 앱과 이번 소스 빌드는 별도 판본이다.

## 제품 결정

모든 Ghost는 Pi Durable을 기본으로 사용하는 같은 종류의 지속형 봇이다.
기본 Ghost는 시작점과 기본 조율자이며 다른 Ghost보다 별도의 지속성 등급을 갖지 않는다.
기존 프로토콜의 `primary`/`specialist`는 호환되는 레지스트리 역할로 남긴다.
등록된 모든 Ghost는 정확한 자기 대화 쌍에서 직접 입력·Pi 바인딩·복구 경로를 사용한다.
프로필만 있는 이전 Ghost를 사용하려면 소유자의 명시 동작으로 같은 UUID에 새 정본 대화를
등록한다. 원래 대화, 역할 지시, 권한과 기존 기록을 덮어쓰지 않는다.

iPhone은 Ghost 앱에서 직접 대화·작업·승인·결과 확인·재연결을 수행한다.
Telegram·Slack 등 별도 메신저는 필수 접점이 아니다. 새 연결은 PC에서 승인한 정확한
Ghost·대화 쌍만 허용하고, 나중에 추가한 Ghost를 기기 권한에 자동으로 넣지 않는다.

## 메뉴 검토와 최종 방향

| 항목 | 판단과 적용 |
| --- | --- |
| 대시보드 | 작업·결정·Ghost 접근을 모으는 기본 화면. 실제 조회한 상태만 표시 |
| Ghost | 이름으로 동등하게 탐색하고 기본 Ghost만 표시. 기존 기록과 새 정본 대화 구분 |
| 맡긴 일 | 전체 작업과 선택한 Ghost의 작업을 구분. 개별 행에서 해당 목표·실행으로 이동 |
| 확인할 일 | 승인이 필요한 내용, 불명확한 요청, 결과 확인을 우선. iPhone 승인 질문과 알림을 한곳에 배치 |
| 협업 | 기존 목록은 이전 실행 경로의 기록이다. 핵심 탐색에서 내려 기록/고급 기능으로 보존 |
| 문서 공간 | 저장된 문서 라이브러리이므로 작업 산출물과 구분해 유지 |
| Host·프로바이더·확장 | 실행 상태, 모델 연결, 패키지/외부 도구/기기 연결을 각각 명확히 분리 |
| 모바일 | 대화·맡긴 일·확인할 일, 눈에 보이는 Ghost 전환. 웹 셸에서는 홈과 패키지 화면 접근도 유지 |

별도 개인 플래너 화면과 Google Calendar·Tasks 설정 예시는 제품 범위에서 제외한다.
이전 플래너 링크는 **맡긴 일**로 연결한다. Host의 실행 시간 제한, 지속형 예약 실행,
작업 재개와 완료 알림은 유지한다.
기존 플래너 데이터와 Host API는 호환을 위해 보존한다.

## 화면과 동작

Docket의 중립 표면, 얇은 구분선, 역상 기본 버튼, 기존 Ghost 마크를 재사용했다.
상태와 정체성에만 색을 쓰고 장식용 설명·새 글꼴·새 UI 의존성은 추가하지 않았다.
데스크톱 대시보드의 작업 목록과 연결 영역은 작은 화면에서 세로로 배치된다.
프로바이더 키·호환 서버·음성 설정·기기 연결은 필요한 시점에 연다.

- `live` 설정과 실제 연결을 분리했다. 최근 성공 조회, 접속 중, 연결 실패, 마지막 저장 상태,
  예시를 구별하고 실패 시 마지막 자료에 경고를 붙인다.
- 대시보드 Pi 작업은 현재 Goal revision만 계산한다. 이전 판본·취소·수용된 항목을
  진행 중으로 세지 않고 실행 종료와 최종 수용을 구분한다.
- 프로바이더의 인증 방식/키 저장 여부와 실제 실행 성공을 구분한다. 오류 후 설정 재조회가
  필요하며 자동으로 저장을 재시도하지 않는다. 대화별 외부 처리 동의는 쌍·선택·연결에 묶인다.
- 잠깐 연결이 끊겨도 호환 서버 편집 초안은 남고 저장만 잠긴다. API 키의 미저장 입력과
  잠정 동의는 연결이 끊기면 지운다.
- 웹에서도 Ghost를 바꾸면 새 메시지의 자료 범위는 보호된 상태로 돌아간다.
  다른 Ghost의 미확인 요청에서 공개 범위를 가져오지 않는다.
- 진행 중인 읽기 조회를 미확정 쓰기로 오인해 새 Ghost 연결을 막던 경합을 보완했다.
  같은 클라이언트가 실행 중인 읽기만 대기 목록에서 구분하며 원본 요청 기록은 보존한다.
  실패한 읽기, 다른 세션의 기록, 진행 중이거나 미확인인 쓰기는 계속 새 변경을 막는다.
- 폐기된 `work.submit`/`work.steer`를 새 작업 버튼으로 노출하지 않는다. 대화에서 지시하고 지원되는 취소·위임·검수를 사용한다.
- 새 휴대폰 연결은 최대 16개의 현재 활성 Ghost·대화 쌍을 선택한다. QR 요청 ID와 범위는
  응답이 유실돼도 바뀌지 않는다. 승인 때 레지스트리와 권한 세대를 재확인한다. 기본 Ghost 하나만 고르면 구형 iPhone이 읽을 수 있는 기존 네 필드 형식도 유지한다.
- iPhone의 상단 Ghost 선택은 이름을 표시하고 대화별 초안, 마지막 선택, 키보드 위치를 보존한다.
  불명확한 원래 요청을 다른 Ghost에게 새 요청으로 보내지 않는다.
- 상단·대화 옵션·알림·작업 상세의 Ghost 전환은 같은 규칙으로 초안과 선택을 저장하고,
  공개 범위와 첨부 선택을 초기화한다. 미확인 입력이 있으면 원래 Ghost에 머문다.
  재연결 시 모델 설정을 다시 읽고, 대상을 고르기 전에는 빈 모델 선택창을 열지 않는다.
- 작업 결과는 현재 Work/Goal/revision/실행과 정확히 연결된 Host 읽기를 사용한다.
  웹에서는 해시·길이·참조를 검증한 뒤 읽기 전용 원문으로 표시한다. HTML이나 스크립트를 실행하지
  않고 문서를 쓰거나 변환하지 않는다. iPhone은 기존 격리된 문서 렌더러를 유지한다.

## Host 및 패키지 수정

- Native provider의 HTTP/SSE 오류에서 응답 원문과 토큰을 노출하지 않는다. 스트림 중간
  이벤트를 복사하고 오류 필드를 제거해 나중에 저장할 때의 공유 객체 변형도 차단한다.
- ZAI/MiniMax의 전송 메타데이터를 실제 `native_responses` 경로로 바로잡았다.
- MCP `checked_ms`/오류는 소유자의 명시 연결 확인만 갱신한다. 도구 호출의 성공·실패가
  마지막 점검 결과를 덮어쓰지 않는다. 캐시된 스키마도 최신 조회 목록을 덮어쓰지 않는다.
- 기존 프로필을 `registry.ensure`로 등록할 때 프로비저닝이 예약한 UUID와 다른 런타임의
  바인딩을 거부한다. 새 등록은 파일·셸·브라우저 권한을 추가하지 않는다.
- Pi 산출물 응답에도 `goal_id`를 포함해 iPhone의 엄격한 결과 검증 계약과 일치시켰다.
- Mac 패키지에 Homebrew의 동적 Node 바이너리만 복사하면 `libnode.147.dylib`가 없어
  실행되지 않았다. 패키징 전 실행·시스템 라이브러리 의존성을 확인하고 독립 배포판을 요구한다.
  심볼릭 링크는 원본 경로로 해석해 번들에 실제 실행 파일을 넣는다.

## 실행한 검증

로컬 상세 증거는 `.orch/ghost-dashboard-20261104/`에 있다. 자격 증명이나 운영 원본 자료는
추가하지 않았다. 브라우저/시뮬레이터 화면은 명시적인 합성 fixture다.

| 확인 | 실제 결과 |
| --- | --- |
| UI 단위·브리지 | 최종 소스에서 Vitest 273개 + 브리지/패키지 17개 통과. TypeScript/Vite 빌드 통과. 진행 중 조회·실패한 조회·다른 클라이언트·동시 쓰기 경계 포함 |
| 브라우저 | 밝음/어두움 × 320/375/414/768/1440px, 메뉴·키보드·동의·충돌·연결 실패·다중 기기 범위 등 최종 62개 통과. 새 Ghost 생성→동일 UUID 연결, URL만으로 등록 금지, 전체 작업·정확한 상세·320px 작성기·범위 초기화·산출물 읽기 포함. `browser-final7/result.json`, `pageErrors=[]` |
| Gateway | 다중 페어링·구형 폰 호환·권한 경계 108개 통과. 알림/APNs·승인·추론·이미지 영수증·음성·요청 영수증에서 두 번째 Ghost와 교차 쌍을 검사 |
| Pi | 전체 265개 통과. 비어 있지 않은 스트림 중간 응답 뒤 HTTP/SSE 오류의 키 반사도 확인 |
| Rust | inference 5, extension 6, 중복 승인 실행 방지 1, 정본 등록 2, 기존 프로필 보존 1, 실제 Pi 산출물 읽기 1 통과 |
| Swift Core | 55개 통과. 정확한 다중 쌍, 교차 조합 거절, 승인 시 범위 바꿔치기 거절 포함 |
| 네이티브 iPhone | 격리한 iPhone 14 시뮬레이터에서 11개 시나리오를 검증. 최종 전체 실행의 10개 통과 + 선택자 보완 후 공개 범위 검사 1개 별도 통과. 320/375/414/768 레이아웃, 큰 글자, 키보드, 이전 메시지 읽기, 모델 충돌, Ghost별 초안·선택 복원, 미확인 전송 후 재실행, 기본 Ghost가 없는 연결, 실제 어두운 테마 포함 |
| Mac 패키지 | 공식 standalone Node v24.21.0을 심볼릭 링크 경유로 넣어 310.68 MiB 번들 빌드 성공. 실제 실행 파일·현재 Host/UI 해시 일치. 새 격리 state7 mock/managed Host의 `--desktop-probe` 종료 0, 시작·UI endpoint·종료 확인. GUI 조작 검증은 아님 |

주요 명령:

```sh
npm --prefix apps/ghost-ui test
npm --prefix apps/ghost-ui run build
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node apps/ghost-ui/scripts/dashboard-regression.mjs
npm --prefix apps/ghost-gateway test
npm --prefix apps/ghost-durable test
cargo test --offline --features lifetime,workspace-ui --lib host::inference::tests
cargo test --offline --features lifetime,workspace-ui --lib host::extension_tests
cargo test --offline --features lifetime,workspace-ui --lib host::lifetime_api::tests
cargo test --offline --features lifetime,workspace-ui --lib pi_direct_files_publish_and_result_without_worker_admission
(cd apps/ghost-ios && swift test)
GHOST_NODE_BINARY=/path/to/standalone/node npm --prefix apps/ghost-desktop run build
```

최종 iPhone 전체 실행은 메뉴를 `StaticText`로 찾은 테스트 선택자 1건이 실패했다.
iOS가 제공하는 접근성 항목으로 선택자를 수정한 뒤 해당 검사를 별도로 통과했다.
전체 실행의 Xcode 결과 수집이 테스트 종료 후 남아 있어 해당 테스트 프로세스만 정리했다.
전체 실행을 11/11 성공 종료한 것으로 기록하지 않는다. 원본은 `ios-peer-verified.log`,
수정된 검사의 성공 결과는 `ios-privacy-final.xcresult`에 있다.

마지막 Mac 재빌드는 오프라인 Cargo 캐시의 `adler2` 누락으로 한 번 실패했다.
잠금 파일을 유지한 `cargo fetch --locked`로 캐시를 복원했으며, 소스 의존성 버전은 바꾸지 않았다.
이후 일반 `target` 출력이 빌드 직후 사라진 것을 관측했다. 삭제 주체는 확인하지 못했다.
검증한 Host 실행 파일의 해시를 보존하고 작업 전용 `CARGO_TARGET_DIR`에서 앱을 다시 빌드했다.
최종 앱은 `.orch/ghost-dashboard-20261104/desktop-compile/debug/bundle/macos/Ghost.app`에 남겼고
새 state7의 시작·종료와 최신 UI/Host 일치를 다시 검증했다.

SwiftUI 검증은 `xcodebuild ... -destination 'platform=iOS Simulator,id=<task-owned>'
-only-testing:GhostUITests/MobileRedesignUITests ... test`로 실행했다. 테스트용 simulator는
다른 작업의 켜진 기기와 별도로 만들었고 `.invalid` URLProtocol만 사용한다.

독립 Claude 소스 검토 두 차례에서 발견한 일시 단절 편집 손실·모바일 메뉴 닫힘과
구형 폰 페어링 호환을 보완했다. Mac runtime 심볼릭 링크 처리도 보완했다. 검토자는 테스트를 실행하지 않았으며 실제 실행 결과는
위 구현팀의 증거다. 마지막 공유 탐색의 생성 영수증·활성 경로·조회 순서·정확한 작업 링크도 소스 확인 후 보완했다.

`cargo fmt --all -- --check`는 153개 파일의 포맷 불일치로 실패했다. 변경한 Rust 파일
8개 모두 기준 커밋 원문에서도 `rustfmt --check`가 실패함을 별도로 확인했다.
관련 없는 전체 저장소와 형제 의존성을 일괄 포맷하지 않았다. 포맷 검사를 통과한 것으로
세지 않으며 실제 Host 빌드와 표적 기능 검사는 위 결과대로 구분한다.

## 운영 상태와 남은 경계

이 작업의 임시 브라우저·미리보기 서버·시뮬레이터와 mock Host는 종료했다.
운영 Host·Mac UI·Gateway의 기존 PID와 포트는 유지됐다.

운영 Host는 조회만 했다. 관측 당시 프로필은 9개, 정본 등록은 4개(기본 1, 역할 3),
Pi 바인딩은 2개였다. 등록된 나머지는 첫 입력에 바인딩을 만들 수 있지만, 이를 이미
실행 검증한 것으로 세지 않는다. 프로필만 있는 5개는 자동으로 운영 등록하지 않았다.

설치된 Mac/iPhone 앱, Gateway·Host 서비스와 기존 기기 권한은 교체하지 않았다.
실물 iPhone의 새 QR 페어링·셀룰러 재연결·실제 모델/위임/승인/결과 왕복과 APNs·음성은
이번 시뮬레이터 검증과 별개다. Mac GUI 자동화는 다른 작업의 lease 때문에 사용하지
않았으며 같은 React 화면의 브라우저 검사와 패키지 시작 검증으로 범위를 명시했다.

이전 MCP 점검 기록에는 호출 출처가 없으므로 과거 값을 일괄 보정하지 않았다.
다음 명시 점검부터 새 의미가 적용된다. 직접 대화의 프로필 persona 주입, 기본 Ghost를
쓰는 자동 평가·운영 정책은 별도의 후속 설계 영역이며 이번에 전체 역할 정책을 바꾸지 않았다.

## 참고한 제품 형식

[Linear Inbox](https://linear.app/docs/inbox)의 결정 우선 목록,
[Tailscale 기기 필터](https://tailscale.com/docs/features/access-control/device-management/how-to/filter)의
현재/마지막 관측 구분, [Raycast 모델 선택](https://manual.raycast.com/ai/extension-models)의
제공자별 설정, [Vercel 통합 관리](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference)의
설치/권한 구분을 검토했다. 시각 자산은 복사하지 않고 기존 Ghost/Docket 시스템에 맞췄다.
