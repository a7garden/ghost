# Ghost 첫 단위 결과 — 2026-10-01

새 `/Users/garden/Documents/Workspace/Projects/ghost` 프로젝트를 만들었다. 기존 Ghost 폴더는 없었다. 원격 저장소 생성·push·PR·merge·배포는 하지 않았고 다른 프로젝트의 코드, 사용자 미커밋·미추적 파일, 서비스와 모델 상주 상태는 변경하지 않았다.

## 구현

- `Cargo.toml` / `Cargo.lock`, `src/{main,lib,store,provider,tools,judge}.rs`, `tests/acceptance.rs`.
- 실행 가능한 JSON CLI: profile create/list, session create/status, task submit/status/cancel, bounded run, outbox, policy allow/list/revoke.
- 독립 profile UUID와 persona, SQLite별 session/task 활동 기록. tasks가 durable inbox이며 message_id가 profile 안에서 유일하다.
- fs2 단일 writer, 승인·철회·감사 기록, native read/create-new write, 기본 deny. SQLite task/outbox/audit 완료와 중단 복구는 원자적 트랜잭션이다.
- 동일 메시지 재전송은 기존 task 반환, 충돌 재전송은 거부한다. 외부 효과 전에 durable ledger를 기록하고 중단된 작업은 uncertain으로 격리해 자동 재시도하지 않는다.
- LocalJudge trait와 허용 후보만 추천하는 mock. 선택이 권한을 부여하지 않는다.
- mock 기본 provider 및 optional oxicode SDK adapter. oxicode의 AllowAll/default Supervisor restore에 도구 권한과 복구를 맡기지 않았다. 도구 없는 엔진과 Ghost 호스트 상태/권한을 분리했다.

## 실제 검증

| 확인 | 결과 |
|---|---|
| `cargo test --offline -j1` | 수용 테스트 24 passed, 0 failed |
| `cargo test --offline --features oxicode-engine -j1` | 25 passed, 0 failed; SDK의 OpenAI/Anthropic 모델 정의를 자격증명 없이 해석 |
| `cargo check --offline --features oxicode-engine --lib -j1` | passed |
| `cargo build --offline -j1` | passed |
| `cargo fmt --check` | passed |
| 독립 macOS arm64 바이너리 smoke | passed; 두 identity·각 2 session·동시 별도 CLI 프로세스·상관관계·중복/거부/취소/쓰기 |
| 바이너리 동적 의존성 | macOS `libSystem`, `libiconv`만 확인; Node/Bun/Python/OpenSSL 추가 런타임 없음 |

수용 테스트에는 실제 CLI 프로세스 재시작, lock 경쟁, default deny, scope/철회, traversal/symlink/자기 state 보호, 중복 effect, cancel, SQLite outbox 실패 주입 및 recovery rollback을 포함한다. 처음 cache가 부족한 offline 의존성 확인과 초기 컴파일은 실패했고 이후 수정으로 해결했다. 모델이 스스로 주장한 테스트 통과는 검증 근거로 쓰지 않았다. 근거는 `evidence/` 로그와 JSON이다.

보존된 실행 파일: `dist/ghost-macos-arm64` (7.1 MiB 내외, macOS arm64 개발 빌드). 환경을 비우고 PATH=/usr/bin:/bin만 둔 별도 프로세스에서 실행했다. OS/CPU별 release 빌드나 서명/공증은 이번에 수행하지 않았다.

## OMP 개발 감사

정상 기존 전역 인증 discovery를 사용하는 OMP 18.4.4 CLI 호출 4회: Z.ai/GLM-5 3회, MiniMax-M2.7 1회. 모두 실제 모델 식별 일치, tool execution 0. 자동 retry/fallback, 전역 context/MCP/확장/skills/memory/telemetry를 격리했다. 호출별 12분, 외부 timeout 750초의 유한 상한이다. 코드/fixture 외 자료와 인증값을 모델 입력에 제공하지 않았고, 키·쿠키·토큰을 출력/복사하지 않았다.

기록된 입력 40,025 / 출력 69,081 / 총 109,106 토큰. 기록된 cost는 도구의 추정 metadata로 실제 청구 또는 추가 결제 확인이 아니다. 앞선 SDK 인증 preflight 1회는 provider 요청 전에 실패했고 성공 token 소비로 계산하지 않았다. 계정 동일성은 부모가 전달한 사용자 명시 확인에 근거한다. quota 조회는 중복하지 않았다.

## 이번에 실행하지 않은 것과 다음 단위

- Ghost runtime의 실제 LLM/API 호출 및 credentials 설정은 하지 않았다. optional SDK compile/registry probe만 검증했으므로 실프로바이더 session 복원과 요청 제한은 후속 검증이 필요하다.
- Cassette 원본 연결, oxibrain 검색 adapter, native HTTP/text search, durable delivery acknowledgement/reconciliation UI, LLM 대화 history 재구성은 backlog다. 현재 durable session/task 기록이 전체 엔진 대화 복원과 같지는 않다.
- Knock/FARM 조합, UI, scheduler/daemon, ASCENT와 별도 Garden 작업은 건드리지 않았다.
- Laya 모델 다운로드·상주 로딩·한국어 calibration은 not run. LocalJudge 후보평가와 static ONNX embedding은 별도 검증이다.
- 파일 경로 검사에는 hostile concurrent directory mutation에 대한 TOCTOU 한계가 있다. 다음 보안 단위는 handle-relative opens, state-file 경계 강화, Windows drive/case 경계 검증이다. 현재 production sandbox라는 주장은 하지 않는다.
- 현재 Cargo의 optional SDK는 로컬 oxicode checkout을 읽는 경로 의존성이다. SDK를 변경하지 않았다. release용 재현 가능한 dependency packaging과 다른 OS/CPU 빌드는 후속 단위다.

이 첫 단위의 남은 실행 blocker는 없다. 위 후속 항목은 완료로 표시하지 않았다.


## 최신 checkpoint — 2026-10-02 실제 브라우저 로컬 fixture

이 파일 앞부분은 최초 단위의 기록이다. 이후 협업·native HTTP·fake browser와
실제 OxiBrowser 로컬 fixture까지 검증했다. 최신 [결과](browser-local-e2e-2026-10-02.md):
기본 47 / 실제 브라우저 포함 77 / SDK·HTTP 포함 96 passed, failed/ignored 0.
기본 단일 바이너리 `dist/ghost-local-browser-macos-arm64`의 깨끗한 환경 CLI
실행도 passed다. 실제 browser는 별도 optional executable + macOS sandbox-exec
의존성이고 기본 바이너리에는 포함하지 않았다. 이번 단위 blocker는 없다.
새 private-FD ownership와 UI/실사용 계정·provider·배포는 not run이며 v1 완료가 아니다.


## 최신 checkpoint — 2026-10-02 private FD·epoch·watchdog

최신 [실제 검증](browser-handoff-2026-10-02.md): 기본47 / SDK 없는 브라우저91 /
전체110 passed, failed/ignored0. 기존96 테스트를 보존하고 실제 local child
handoff/watchdog14개를 추가했다. 기본 단일 실행파일
`dist/ghost-handoff-checkpoint-macos-arm64`도 깨끗한 환경 smoke passed다.
이 checkpoint의 blocker는 없다. 사용자 확인은 trusted fixture 입력만 검증했으며
실제 UI 승인·로그인·credentials·freeze·v1 출시는 완료로 표시하지 않았다.
다음은 이 상태머신을 사용하는 bounded 호스트 UI와 실제 local 입력 검증이다.


## 최신 checkpoint — 2026-10-02 embedded fixture host UI

[UI 구현·검증 결과](ui-fixture-2026-10-02.md): 기본47 / SDK 없는 browser+UI95 /
전체114 passed, failed/ignored0. 기존110 case/assertion은 변경하지 않았다.
신규4 HTTP 수용 테스트와 clean-environment smoke는 보존한
`dist/ghost-ui-fixture-macos-arm64` 자체를 실행해 passed다. MockProvider와
실제 local child 제어를 연결한 화면·임시 loopback API를 구현했다.
Node/Bun/Python 제품 런타임 설치는 없다. OMP 추가0/capacity0/fallback 없음.

연결 key 변경으로 중단된 첫 조합은 별도로 기록했고, 잔류 확인 뒤 기존 작업에서
이어서 검증했다. 현재 blocker는 부모의 공유 GUI/GPU 슬롯 조율과 이후 실제
frontend 상호작용·PNG다. 화면 검증 helper는 컴파일 완료지만 **not run**이다.
실제 사람 승인·계정·provider 비밀 입력·freeze·v1 출시로 표시하지 않는다.


## 구조 checkpoint — 2026-10-03 Ghost host·control·adapters

[ADR 011](adr-011-ghost-host-control.md)에 따라 상주 host를 workspace UI에서 분리했다.
기본 feature는 host이며, CLI/UI는 공통 owner command를 사용한다. 문서·기억·컴퓨터·채널은
선택형 어댑터다. ComputerBackend 주입 경계와 기존 OpenBot 연결을 유지하고, Cloudflare는
후속 backend 후보로 남겼다. 기존 DB 이름·wire payload·PDC 동작을 보존했다.

[검증 기록](evidence/host-architecture-2026-10-03.json): 기본 67 / workspace-ui 74 passed,
failed·ignored·warning 0. 독립 feature 빌드 6개 통과. 호스트 종료 후 재시작 시 owned
delegation 유지, 명시적 취소 전파, 라이브 writer 중 CLI 제어, 접속정보 인증, 진행 중 HTTP
요청의 종료 정리를 검증했다. 외부 모델·Cloudflare·새 UI 시각 검증은 수행하지 않았다.
공유 폴더의 별도 문서·채널·운영 기능 통합은 계속되며, 이 기록은 각 실행 시점의 근거다.


## 기기·음성·셀프 호스팅 checkpoint — 2026-10-03

OpenAI dot를 제품 목표로 명시한 [ADR 012](adr-012-cross-device-voice-self-host.md)를 추가했다.
iPhone SwiftUI 앱(`apps/ghost-ios`), 기기별 인증 gateway(`apps/ghost-gateway`),
전경 WebRTC 통화 연결 코드와 [운영 예시](../deploy/self-host/README.md)를 추가했다.
Rust host의 SIGTERM도 기존 drain 경로로 처리한다. 기존 웹 UI·MCP·협업 작업은
다른 세션의 구현을 유지하고 공통 API를 사용한다.

[검증 기록](evidence/mobile-foundation-2026-10-03.json): 관련 테스트 20 passed,
iOS simulator build 성공 및 연결 화면 확인. 실제 mock host를 통한 메시지 처리,
중복 요청, 재시작 후 workspace/receipt 보존을 포함한다. 실기기 오디오, 공개 TLS,
클라우드 화면 제어, 로컬 PC agent/router, CallKit·APNs는 아직 완료되지 않았다.
