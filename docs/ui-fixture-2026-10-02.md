# Ghosts temporary fixture host UI — 2026-10-02

Rust 실행파일에 HTML/CSS/JS를 포함하고 유한한 `127.0.0.1` HTTP listener로 제공하는 첫 관리 화면을 구현했다. Node/Bun/Python 설치가 제품 실행에 필요하지 않다. UI의 Sage/Rune은 각 UUID·persona·SQLite·session·task를 보존하는 별도 Ghost다. compact 대화 영역과 독립 과업 목록은 dots/Muse의 일반 UX 참고이며 내부 구현을 추측하지 않았다.

이번 화면은 명시적으로 **local fixture / MockProvider**다. 실제 LLM·API·로그인·계정·비밀 입력·v1 출시로 표시하지 않는다. 추가 OMP 호출은 0, capacity 오류·Astra fallback도 0이다. 사용자 Sol 6.1 직접 개발 승인에 따라 구현했다. configured model은 gpt-6.1-sol이며 effective turn model은 별도로 검증하지 않았다.

`ui-fixtures` feature에서만 다음 명령을 제공한다. 새 비어 있는 root 또는 이 명령이 만든 표시된 fixture root만 허용한다. 기존 사용자 root를 가져오거나 임의 폴더를 HTTP로 제공하지 않는다.

```sh
ghost --root /tmp/ghost-ui-fixture-new ui-fixture \
  --browser-pin docs/evidence/handoff-pin.json --seconds 180
```

stdout의 준비 JSON에 표시된 UI 주소를 수동으로 연다. 1..300초 후 종료하며 자동 browser open/autostart는 없다. pin 파일은 이번 Mac의 외부 fixture 실행파일을 가리킨다. 실제 브라우저 버튼에는 별도 pinned OxiBrowser + macOS sandbox-exec가 필요하며 Ghost 바이너리에 browser를 묶지 않았다. 사용자 계정·사이트·프로필을 붙이지 않는다.

화면은 Ghost 선택, 후속 질문 두 개, 별도 과업, mock 결과/오류/거절, queued 취소, 새로고침, 실제 child ownership/epoch/인계/재개/요청 취소를 연결한다. 약 1.6초의 mock queue는 표시된 fixture timing이지 추론 진행률이 아니다. 질문은 실제 MockProvider echo만 표시하며 result/error에서 task ID를 함께 볼 수 있다. browser 취소 버튼은 실제 취소 가능한 작업에만 활성화한다. UNKNOWN은 자동 재전송 없이 별도 명시 fixture 인정과 새 빈 child 시작만 허용한다.

읽기와 호스트 작업을 분리했다. 독립 background tick이 공개 core/controller API를 실행하고, GET snapshot은 미리 만든 immutable projection만 반환한다. root HTML만 메모리 session cookie/CSRF를 발급하고 쓰기는 exact Host/Origin·cookie·CSRF·JSON 형식을 검사한다. secret 값은 인수·SQLite·로그에 저장하지 않는다. 고정 route, bounded header/body 및 전체 read deadline, duplicate headers/transfer encoding 거절, no-store/no-CORS/self CSP/frame-ancestors none을 적용했다.

검증한 HTTP session에서만 private typed host action을 구성한다. prompt/result/page 데이터는 문자열이며 command로 deserialize하지 않는다. DOM은 textContent/createElement만 사용하며 iframe·HTML 삽입·script 실행은 없다. 역사적 duplicate ACK는 최신 ownership로 표시하지 않고 새 snapshot을 다시 읽는다. stale task/session/epoch는 fail closed다. UI와 untrusted HTML fixture는 서로 다른 port/origin이고, child의 sandbox는 fixture port만 허용하므로 UI port에 접근할 수 없다. 이것은 browser CSRF 경계이며 실제 사람 인증이나 같은 OS 사용자의 악성 process 격리 증거는 아니다. 페이지 script/network freeze는 없다.

## 검증

기본47 / SDK 없는 browser+UI95 / SDK/native/browser/UI114 passed, failed/ignored0이다. 95는 기존91 성공과 보존한 UI-only artifact를 실제 실행한 신규4의 합성 기록이며, 최종114는 모든 target을 한 번에 통과한 기록이다. UI checkpoint 당시 기존110 case/assertion 및 Cargo.lock을 보존했다. 이후 병행 변경은 아래에 별도로 기록한다. 신규 HTTP 수용 테스트 4개는 실제 CLI/server/MockProvider/controller와 local browser child를 사용하며 다음을 포함한다.

- 두 identity/session, 동시 질문 correlation, 별도 queued 취소, 실제 mock echo/오류/native permission deny, request ID duplicate/conflict와 refresh.
- 인증 누락/Origin·Host·CSRF mismatch, extra forged approval fields, arbitrary-file route 및 slow-drip request 거절; GET snapshot이 grant/task를 만들지 않음.
- 실제 browser setup/관찰, pending 작업 중 인계·early/stale resume 거절, epoch1→새 관찰→epoch2, 역사적 인계 ACK 이후 epoch 보존, 취소 UNKNOWN와 재전송 없는 새 scope, 다른 Ghost 비간섭.
- 기존 unmarked 사용자 root 거절과 원본 파일 보존.

기존 regression host는 기존 global-config/public-network deny sandbox, 실제 local-browser/UI test host는 clean environment와 별도 per-child exact-port sandbox를 사용했다. macOS의 다른 nested sandbox 거절 때문에 실제 E2E host에 outer sandbox를 적용했다고 주장하지 않는다.

처음 새 테스트 helper의 Tokio runtime 생성 위치 오류를 수정했다. 첫 95개 조합은 연결 복구에서 executor key 변경 오류로 최종 로그가 없어 interrupted/unverified로 분리했다. 잔류 테스트/fixture process가 없음을 PID/comm만으로 확인하고 처음부터 새 구현을 만들지 않았다. 이어진 회귀에서 ACK 직후 추가 관찰 중 요청의 409를 발견했고, UI의 실제 활성 조건인 새 관찰 완료·idle까지 기다리도록 새 테스트를 강화했다. 이전 실패/중단 기록도 보존한다. 기존 테스트는 변경하지 않았다.

보존한 실행파일은 `dist/ghost-ui-fixture-macos-arm64` (12,814,264 bytes, SHA-256 `7a7eb3e3cda54cbc302ec2259ece86bb08146cd276fd7a02bf26d4e6011e6bd3`)다. 동적 링크는 macOS libSystem/libiconv만 확인했다. 깨끗한 환경에서 --help 및 3초 finite UI 서버·두 identity/session·MockProvider·origin 분리·정상 종료 smoke가 passed다. 추가4개 수용 테스트도 이 dist 파일 자체를 실행해 passed다. Cargo test 개발 dependency 조합에서 target/debug CLI의 해시가 달라질 수 있어 explicit test-only artifact override로 보존한 개발 artifact를 직접 검증했다. JS 구문 검사와 cargo fmt도 passed며 이는 DOM/render 검증을 대체하지 않는다.

근거는 [integrity](evidence/ui-integrity.json), [전체114](evidence/ui-engine-tests.log), [UI artifact4](evidence/ui-artifact-tests.log), [artifact](evidence/ui-artifact.json), [smoke](evidence/ui-smoke.json), [ADR008](adr-008-fixture-host-ui.md), [화면 검증 helper](../tests/fixtures/ui_window_proof.swift)다. 처음의 실패/중단 로그도 evidence에 보존했다.

## 화면 증거와 남은 범위

실제 frontend render/버튼 상호작용/PNG는 아직 not run이다. 부모의 공유 GUI/GPU 슬롯 조율을 기다리고 있다. 준비한 development-only AppKit/WKWebView helper는 OS SDK로 컴파일 완료됐고, 비영구 window 한 개와 owned WebKit content snapshot만 사용한다. 사용자 browser/profile·desktop capture·접근성/보안 설정 변경은 없다. 이 Swift helper는 Ghost 제품 의존성이 아니다. synthetic DOM fixture event가 사람의 실제 승인 증거는 아니다.

browser repo는 읽기만 했고 빌드/수정/기존 browser 종료를 하지 않았다. 여섯 기존 artifact도 보존했다. Git 생성/remote/push/PR/merge/deploy, 다른 프로젝트 변경, 서비스·scheduler·모델 다운로드/상주 loading, credentials·결제·외부 공유는 하지 않았다.

이 단위의 남은 blocker는 GUI/GPU 슬롯 후 실제 화면 검증과 screenshot이다. 이후 v1 backlog는 일반 기존 profile 생성/선택·role/workflow UI, reconnect/event cursor·socket kill/replay, 실provider 직접 비밀 입력/승인된 저장·철회, canonical conversation/compaction, Cassette/oxibrain provenance, portable SDK packaging·OS/CPU build·migration·서명/공증 및 filesystem handle-relative 강화다.


## 병행 작업과 검증 경계

최종 감사 중 같은 checkout에 durable-runtime/src/durable.rs/tests/durable.rs와
main/lib/Cargo 추가 변경을 발견했다. SDK에도 oxicode-durable 의존성이 들어왔다.
protocol/store/collaboration와 기존 acceptance/collaboration 테스트의 변경도
이어지고 있다. 이 변경은 이번 UI 작업의 작성물이 아니며 덮기/되돌리기/재개발/
추가 빌드하지 않았다. UI CLI/모듈 선언은 공유 소스에서도 보존돼 있다.

위47/95/114는 UI checkpoint 검증이다. 이후 변경 중인 전체 checkout/SDK를
검증했다는 뜻이 아니다. 원래 lock의 정확한 SHA와 일치하는 snapshot 및 새 lock
diff를 보존했다. 추가 package는 oxicode-durable0.81.0이며 Ghost futures/SDK
의존성 변경을 확인했다. [lock 기록](evidence/ui-lock-drift.json),
[diff](evidence/ui-lock-drift.diff), [변경 전 보존 감사](evidence/ui-preservation-check.json)를 참조한다.

보존한 UI artifact의 네 가지 수용 테스트와 smoke는 통과했고 SHA도 유지된다.
이 artifact는 병행 source의 최신 상태를 담았다고 주장하지 않는다. 부모는 공유
GUI/GPU 슬롯 이후 준비된 helper로 이 artifact의 화면 증거를 얻을 수 있다.
현재 source 통합 회귀는 병행 작업의 완료 후 조율이 필요하다.
