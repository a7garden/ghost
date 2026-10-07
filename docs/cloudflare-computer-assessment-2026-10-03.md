# Cloudflare Computer 활용 평가 — 2026-10-03

이 평가는 고정한 외부 소스의 조사 기록이다. 채택 범위·Rust host와의 책임 경계·구현 상태·수용 기준은 [전체 시스템 설계 — ADR 011](adr-011-ghost-host-control.md)에 반영했다. 현재 `ComputerBackend` 교체 경계와 OpenBot 구현이 있으며, Cloudflare backend 자체의 구현·배포는 후속이다.

**판정: Ghost의 선택형 원격 작업환경으로 시험 도입할 가치가 높다.** 지속 파일과 격리된 코드 실행을 재사용할 수 있다. Ghost의 identity·책임·대화·정책·복구를 소유하는 코어는 계속 Rust에 두고, 컴퓨터는 교체 가능한 adapter로 연결하는 구성을 권장한다.

검토한 저장소는 [cloudflare/computer](https://github.com/cloudflare/computer), 소스를 고정해 읽은 commit은 [`2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1`](https://github.com/cloudflare/computer/tree/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1)이다. package README와 실제 TypeScript 구현을 확인했다. npm 설치, Docker 실행, Cloudflare 계정 연결·배포·성능 실험은 하지 않았다. GitHub의 `main` 웹 캐시에는 서로 다른 시점의 내용도 보여 세부 판단에는 고정한 소스를 사용했다.

**무엇을 제공하는가.** Durable Object의 SQLite에 파일 원본을 두고, 여러 실행 backend가 같은 workspace를 사용한다. container는 FUSE와 `computerd`를 통해 파일을 동기화하고 Linux 프로그램을 실행한다. worker-shell은 Dynamic Worker의 just-bash를, worker-javascript는 격리된 JavaScript 모듈 실행을 제공한다. backend는 필요할 때 연결된다. 저장소는 이를 preview로 명시하며 API가 불안정하고 현재 production 용도가 아니라고 밝힌다. [프로젝트 설명](https://github.com/cloudflare/computer/blob/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1/README.md)

| Ghost에서 필요한 것 | 재사용 가치 | 별도로 남는 책임 |
| --- | --- | --- |
| 지속 작업 디렉터리 | 높음: 읽기·쓰기·검색·편집과 실행환경의 공통 파일 기반 | Ghost별 workspace 선택과 접근 정책 |
| 데이터 처리·작은 코드 작업 | 높음: 빠른 shell/JS와 Linux 실행 분리 | 작업에 맞는 backend 제한, 시간·출력·비용 한도 |
| 원격 실행 상태 관찰 | 높음: execution ID, 이벤트, 결과·취소·재접속 표면 | Ghost effect와 remote execution의 상관관계 |
| 장기 에이전트의 책임/기억/복구 | 보조 기능 | Ghost runtime이 계속 소유 |
| 브라우저·화면 조작·사람 takeover | 이번에 확인한 기본 패키지에서 해당 API를 찾지 못함 | 기존 OpenBot/OxiBrowser 계열 또는 별도 Browser adapter |
| 사용자 관리 UI | 재사용 대상 아님 | Ghost 목록·맡은 일·결정 대기·산출물 UI |

공개 패키지는 Worker/TypeScript 중심이고 `computerd`도 Node와 FUSE에 의존한다. Rust crate처럼 Ghost 바이너리에 직접 넣는 접근은 맞지 않는다. Rust는 원격 adapter의 client가 되고, TypeScript/Cloudflare 의존성은 선택한 backend 배포에 머무르게 한다. 직접 로컬 computerd를 실행하면 Node/FUSE 의존성이 생기므로 기본 macOS 실행환경의 필수 요소로 삼는 것은 권장하지 않는다. [패키지 manifest](https://github.com/cloudflare/computer/blob/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1/packages/computerd/package.json)

**현재 OpenBot 연결과의 관계.** Ghost의 `src/workspace/computer.rs`는 supervisor, per-Ghost credential, browser snapshot/ref, human control을 전제로 한다. Cloudflare Computer의 기본 표면은 filesystem과 exec다. 현재 adapter의 URL만 바꿔서 교체할 수 있는 서비스가 아니다.

이를 계기로 공통 `ComputerBackend`를 만들되 능력을 분리하는 것이 좋다. `filesystem`, `exec`, `browser`, `human_control`, `network_policy` 등을 backend가 선언하도록 하고, 제공하지 않는 동작은 모델과 UI에 광고하지 않는다. Cloudflare에는 파일·터미널·작업 결과 UI를 제공하고, browser backend에만 화면과 takeover를 표시한다. 공통 규격을 맞추려고 모든 backend에 가짜 screenshot이나 browser 상태를 만들 필요는 없다.

**파일 지속성과 실행 복구를 분리해야 한다.** 구현에는 `exec`, `getExec`, `killExec`, `disposeExec`, event resume, runtime 식별자가 있다. 따라서 재연결 표면이 전혀 없는 프로젝트로 평가하는 것도 부정확하다. [runtime 구현](https://github.com/cloudflare/computer/blob/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1/packages/computer/src/runtime/runtime.ts)

다만 `computerd`는 프로세스 시작 시 exec log/meta를 비운다. 파일이 살아 있어도 이전 OS 프로세스가 계속 실행되거나 모든 실행 결과를 재조회할 수 있는 것은 아니다. 상위 Workspace는 execution과 runtime ID의 관계를 durable storage에 기록해 다른 runtime을 같은 실행으로 오인하지 않도록 한다. Ghost는 이 구분을 받아들여 결과를 확정할 수 없는 작업을 `uncertain`으로 남겨야 한다. [exec schema](https://github.com/cloudflare/computer/blob/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1/packages/computerd/src/exec/schema.ts), [runtime 소유권 기록](https://github.com/cloudflare/computer/blob/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1/packages/computer/src/execution-runtime-tracker.ts)

Ghost adapter의 영수증에는 최소한 `ghost_id`, backend/workspace ID, effect key, execution ID, runtime ID, 마지막 event cursor, 결과·동기화 상태가 필요하다. 명령 종료, 파일 동기화 완료, 외부 업무 효과 성공을 각각 구분한다. 파일 pull 재개를 지원한다는 이유로 shell이나 외부 API 호출을 다시 실행해서는 안 된다.

**MCP 예제를 그대로 제품에 연결하기에는 경계가 넓다.** 예제는 인증된 요청을 `idFromName("computer")` 하나로 라우팅한다. 여러 Ghost가 같은 endpoint/token을 쓰면 같은 workspace를 공유한다. Worker shell에는 network none, container에는 direct egress가 설정되어 있다. Ghost UUID를 모델 인자로 받는 것만으로 분리를 구현하지 말고, gateway가 인증된 주체와 workspace를 바인딩해야 한다. [실제 라우팅·backend 설정](https://github.com/cloudflare/computer/blob/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1/examples/mcp/src/index.ts)

예제는 파일 변경·삭제·exec를 조합할 수 있는 Code Mode `code` 도구 하나를 노출한다. 이는 왕복을 줄이는 실험에는 유용하지만, Ghost의 세밀한 파일·shell 권한으로 바로 해석할 수 없다. 도구를 읽기 전용이라고 표시하면서 `code` 안에서 exec/write를 허용해서는 안 된다. [MCP 예제](https://github.com/cloudflare/computer/blob/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1/examples/mcp/README.md), [도구 구성 코드](https://github.com/cloudflare/computer/blob/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1/examples/mcp/src/server.ts)

권장 연결은 다음과 같다.

```text
Ghost Rust runtime
  → 현재 정책 검사 + effect 기록
  → 명시적으로 설정한 Computer adapter
  → 인증된 MCP/HTTP gateway
  → Ghost별 Cloudflare Workspace
  → 허용된 worker-shell / worker-javascript / container backend
```

MCP adapter를 만든다면 기존 엔진의 전역 MCP discovery를 켜는 방식 대신 Ghost가 선택한 서버·도구·credential을 주입한다. 초기 실험은 예제의 Code Mode로 제한된 가상 데이터에서 할 수 있다. 제품 통합에서는 `fs.read/list/write`와 `exec.start/status/cancel` 등 좁은 동작을 gateway에서 제한하고, 각 내부 호출에도 정책과 추적을 적용한다. 세부 제어가 필요하면 얇은 typed HTTP gateway가 더 단순할 수 있다. capnweb wire protocol을 Rust로 재구현하는 일부터 시작할 필요는 없다.

**동기화할 데이터의 경계를 작게 잡는다.** Ghost identity DB, durable task DB, 권한 DB, credential은 Cloudflare 작업 디렉터리로 보내지 않는다. 선택한 입력과 working copy를 전달하고 산출물을 가져온다. 원격 환경에 사용자 문서를 저장하기로 선택한 경우에도 PDC 원문과 ID를 보존하고, 로컬 원본 반영 시 hash 충돌 검사와 기존 문서 저장 정책을 적용한다. 이 방식은 Cloudflare 파일 DB를 Ghost 전체의 원본으로 삼지 않으면서 원격 실행의 이점을 얻는다.

공식 패키지는 workspace 약 10GB 한도와 container 측 파일 메모리/FUSE의 I/O 특성을 설명한다. 큰 저장소·의존성 설치·Rust `target` 동기화는 실측 전 적합하다고 가정하지 않는다. computerd의 local-only ignore 경로는 재생성 가능한 build/cache에 적용하고 사용자 산출물은 제외하지 않는다. [패키지 한계](https://github.com/cloudflare/computer/blob/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1/packages/computer/README.md), [computerd 저장·ignore 동작](https://github.com/cloudflare/computer/blob/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1/packages/computerd/README.md)

**첫 실험의 범위를 제한하면 채택 여부를 판정할 수 있다.**

| 실험 | 통과 조건 |
| --- | --- |
| 두 Ghost의 독립 workspace | A가 만든 파일을 B가 읽지 못하고 다른 workspace ID 주입도 거부됨 |
| 파일과 프로세스 수명의 구분 | 재연결/재시작 후 파일·exec 상태를 각각 정확히 보고함 |
| 단절·응답 유실·runtime 교체 | 결과가 불명인 exec를 자동 중복 실행하지 않음 |
| 권한과 backend 제한 | read-only Ghost가 write/delete/exec를 우회할 수 없고 container 사용도 host 정책에 따름 |
| 작은 실제 작업 | 입력 파일→코드 실행→산출물→해시 검증을 끝까지 연결함 |
| 비용·운영 적합성 | cold start, 전송량, 저장량, 실행 시간과 메모리를 기록해 로컬 backend와 비교함 |

이 검증에는 별도의 Cloudflare 배포와 실제 사용 비용이 따를 수 있다. 이번에는 채택 판단에 필요한 소스 평가와 실험 기준까지 정리했다. 결과적으로 **Ghost core 분리 → 공통 컴퓨터 adapter → Cloudflare의 작은 실험 → 검증 결과에 따라 선택형 지원** 순서가 적합하다.
