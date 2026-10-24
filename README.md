# Ghost

## 2026-10-22 PC–mini 복원·운영 연결 준비

실제 운영 상태의 전체 cold capture/mini dispatch-off 복원, 원 영수증을 보존하는 worker artifact 경로 재연결, stopped-Host CAS fence와 operator rebind/runtime acceptance를 구현·검증했다. mini는 Studio 없이 직접 ZAI로 대화하고 실제 Linux Node/Python 업무의 독립 수용·같은 Primary 보고를 완료했다. PC 앱은 별도 writer 대신 기존 상시 Host에 연결한다. **현재 정본 writer는 Studio이며 mini 운영 cutover는 아직 미실행이다.** 기존 Primary의 ZAI 이력 허용 응답과 최종 fence/전환·백업 원격화를 남겼다. [구현·검증·보존 경계](docs/dual-host-2026-10-22.md).

Ghost는 **Rust로 구현하는 장기 실행 에이전트의 기본 단위**다. 각 Ghost는
고유 UUID, 역할, 권한, 맡은 일과 실행 기록을 유지한다. 대화·모델·UI가
바뀌어도 identity와 저장된 작업은 남는다. 제품 목표는 OpenAI dot의 기능과 완성도이며,
OpenDots는 구현 참고 자료다. [기기·음성·컴퓨터·셀프 호스팅 설계](docs/adr-012-cross-device-voice-self-host.md)에
현재 구현과 후속 수용 기준을 정리했다. iPhone 앱은 `apps/ghost-ios`, 선택형 원격 접속
게이트웨이는 `apps/ghost-gateway`에 있다.

기본 빌드는 UI 없이 동작하는 상주 호스트다. 하나의 프로세스가 여러 Ghost의
실행, 타이머, 목표, 정책과 재시작 복구를 관리한다. 기본 모델 `mock`은 외부
요청을 하지 않는다. 실제 모델은 명시적인 provider/model과 기존 인증 설정을 사용한다.

## 설치와 CLI 실행

이 프로젝트 폴더에서 release 바이너리를 빌드·설치한다. 설치기는 서비스를 시작하지 않는다.

```sh
python3 scripts/install.py --offline
```

`~/.local/bin/ghost`가 판본별 바이너리를 가리킨다. 이 경로가 PATH에 있는 환경에서:

```sh
ghost run
# 다른 터미널에서 같은 호스트 조회/명령 전달
ghost control snapshot
ghost control send --file command.json
```

실행 중인 호스트의 주 Ghost("primary")에게 프롬프트 한 건을 보내고 답을
표준 출력으로 받는 원샷 경로도 있다. 대화가 없으면 만들고, 접수(admission)가
필요한 작업 턴은 콘솔과 같은 routing 절차를 밟는다.

```sh
ghost chat '오늘 일정 요약해줘'          # 답 텍스트만 출력
ghost chat --profile Scout --json '...'  # 대상 교체와 JSON 기록
ghost chat --timeout 600 --kind prompt '...'  # 대기 상한과 입력 종류 지정
```

`ghost run`은 기본적으로 화면 없는 foreground 호스트다. 기본 상태 위치는 macOS의
`~/Library/Application Support/Ghost`이며 `--root` 또는 `GHOST_ROOT`로 바꾼다.
터미널 종료 이후의 상시 운영은 별도 launchd/service 등록을 사용한다.
현재 기본 모델은 `mock`이므로 실제 작업에는 provider/model과 권한을 설정해야 한다.

설치기는 Python 3.9 이상과 Cargo를 사용한다. 개발 checkout의 path dependency도
빌드할 때 필요하다. 설치된 바이너리는 checkout과 별도로 보관하며 Node/Bun 기반
worker나 음성 등 선택 backend의 의존성은 별도다. 이전 release는 보존한다.
`--offline` 빌드는 의존성 cache가 있어야 하고, online 빌드는 이 옵션을 생략한다.

기존 `ghost --root DIR serve --headless`와 `ghost --root DIR run PROFILE`은 호환 경로다.
후자는 기존 queued task를 한 번 처리하는 명령이다. 새 사용 예시는 `ghost run`을 따른다.

선택형 웹 UI는 같은 호스트의 제어 API를 사용한다. UI를 닫아도 작업은 계속된다.

새 React 콘솔은 `apps/ghost-ui`에 있다. Rust 바이너리와 UI를 빌드하고 개인
콘솔 설정을 저장한 뒤 `npm --prefix apps/ghost-ui run console`로 함께 실행한다.
[콘솔 실행·인증 설정](apps/ghost-ui/README.md)과
[Z.ai 실제 E2E 검증](docs/zai-live-e2e-2026-10-03.md)을 참고한다.
아래 `serve` 명령의 내장 UI는 기존 클라이언트다.

UI 포함 바이너리는 `workspace-ui` feature로 별도 빌드한다. 그런 바이너리의
`ghost run --ui`는 내장 UI를 제공하며 `ghost run`은 화면 없이 실행한다.
현재 별도 React console launcher는 host를 자식으로 소유해 launcher 종료 시 함께
종료한다. 상시 호스트에 붙는 client와 구별하며, 기본 attach-only 전환은 후속 작업이다.

`documents`, `memory`, `computer`, `channels` 어댑터를 각각 선택할 수 있다.
`workspace-ui`는 기존 사용법을 유지하는 UI+어댑터 편의 묶음이다.
모델 도구에는 현재 연결된 backend의 지원 기능을 노출하고, 실행 시 정책을
다시 확인한다. 기존 OpenBot 연결과 `ComputerBackend` 교체 인터페이스가 있으며,
Cloudflare Computer는 후속 backend 후보로 [평가](docs/cloudflare-computer-assessment-2026-10-03.md)했다.

[전체 시스템 설계](docs/adr-011-ghost-host-control.md)에 Ghost의 기본 개념, 실행·복구,
도구·권한·프로토콜, 데이터 원본, Cloudflare 활용, UI, 운영과 개발 순서를 정리했다.
[패러다임 재평가](docs/architecture-reassessment-2026-10-03.md)는 그 결정의 배경 기록이다.
현재는 단일 소유자의 로컬 호스트다. OS 자동 시작이나 Cloudflare 배포가
자동 설치되는 것은 아니다. 검증 대상은 로컬 macOS arm64이며, 다른 플랫폼의
릴리스 이식성은 아직 검증하지 않았다.

아래 `profile`/`task`/`conversation` 직접 저장소 CLI는 기존 오프라인 호환 경로다.
상주 호스트가 writer lock을 보유할 때는 위의 `control` 경로를 사용한다.
`--no-default-features`로 기존 bounded core만 빌드할 수 있다.

## 펫과 Ghost 아바타

`apps/ghost-ui`의 **설정 → 펫과 아바타**에서 Ghost별 아바타를 만들거나
Codex 펫 v1/v2 스프라이트를 가져와 지정합니다. 색·형태·표정·장식을 조합하는
제작기, 동작 미리보기, Codex용 ZIP 내보내기, 작업실 펫 표시를 제공합니다.
호스트 연결 시 아바타와 지정 상태는 `workspace.db`에 보존합니다.
[사용 방법과 호환 규격](apps/ghost-ui/README.md#펫과-아바타)을 참고하세요.

## 개인 할 일·일정과 외부 연동

`apps/ghost-ui`의 **할 일과 일정**에서 개인 할 일(마감일·완료 상태)과 시간대가
반영된 일정을 관리한다. **연동**에서 로컬 MCP 프로그램(stdio) 또는
Streamable HTTP 서버를 등록하고, 사용할 Ghost를 선택한 뒤 연결을 확인한다.
Google Calendar·Tasks용 Workspace MCP 설정 예시도 포함한다.

```sh
cargo run --features workspace-ui -- --root /path/to/ghost-state serve --headless
cd apps/ghost-ui
GHOST_ROOT=/path/to/ghost-state npm run dev
```

UI 주소는 `http://127.0.0.1:5178`이다. `GHOST_ROOT` 없이 UI를 실행하면
브라우저에만 저장하는 예시 모드이며 외부 MCP를 실행하지 않는다.
호스트는 기본적으로 `mock` 모델을 사용하므로 자연어 도구 실행에는 실제 모델을
선택해야 한다. 로컬 할 일·일정 화면의 직접 조작에는 모델이 필요 없다.

계정 로그인, 지원 범위와 제어 API 예시는
[개인용 연동 안내](docs/personal-integrations.md)를 참고한다.

## Grammar

```
ghost --root DIR profile create NAME [--persona TEXT]
ghost --root DIR profile list
ghost --root DIR session create PROFILE
ghost --root DIR session status PROFILE SESSION_ID
ghost --root DIR task submit PROFILE SESSION_ID --message-id MSG --prompt TEXT \
    [--read PATH | --write PATH --content TEXT]
ghost --root DIR task status PROFILE [--task TASK_ID]
ghost --root DIR task cancel PROFILE TASK_ID
ghost --root DIR run PROFILE [--provider mock | --provider oxicode --model MODEL]
ghost --root DIR outbox PROFILE
ghost --root DIR policy allow PROFILE --path EXISTING_FOLDER --operation read|write
ghost --root DIR policy revoke PROFILE GRANT_ID
ghost --root DIR policy list PROFILE
```

All output is JSON. `TASK_ID` may be a task uuid, message id, or numeric id.

## Example fixture session

```
mkdir -p /tmp/g-work && echo payload > /tmp/g-work/in.txt
ghost --root ~/ghosts profile create garden --persona "a careful ghost"
ghost --root ~/ghosts session create garden
# use the session uuid printed above
ghost --root ~/ghosts task submit garden $SESSION --message-id m-1 --prompt hi
ghost --root ~/ghosts policy allow garden --path /tmp/g-work --operation write
ghost --root ~/ghosts task submit garden $SESSION --message-id m-2 --prompt write \
    --write /tmp/g-work/out.txt --content written
ghost --root ~/ghosts run garden
ghost --root ~/ghosts outbox garden
```

## Guarantees (legacy task API)

These guarantees describe the original `task`/`run` path. Durable conversations
and the workspace have their own continuation/cancellation contract in ADR 009
and ADR 010.

- **Durable submit**: a submitted task is committed to SQLite before the
  process exits; `run` is a bounded drain of queued tasks with one attempt
  each and no automatic retries.
- **Inbox deduplication**: message ids are UNIQUE per profile. An identical
  duplicate submit returns the same task; a mismatched reuse of a message id
  is rejected. Distinct ghosts cannot cross-correlate.
- **Tasks double as the inbox queue** (documented design choice).
- **Single writer**: an exclusive `fs2` lock per profile is held for the
  command's lifetime; a second writer fails fast and reacquires on drop.
- **Effects**: a ledger row (`UNIQUE(task_id, action)`) is written **before**
  any external effect. After an ambiguous interruption the task/effect is
  `uncertain` and is **never automatically replayed**; writes promise
  at-most-once automatic attempts plus manual reconciliation, not exactly-once.
  Recovery runs on every open: `running` tasks and `started` effects become
  `uncertain`. A tool success followed by a ledger failure is recorded as
  `uncertain`, never duplicated.
- **Cancellation**: only `queued` tasks are cancellable; cancellation is
  terminal and persisted. `running` can only become `uncertain` via crash
  recovery.
- **Provider failures** mark that task `failed` (with an outbox record) and do
  not strand the remaining queued tasks.
- **Capabilities**: everything is denied by default. Grants are explicit,
  local, persisted user approvals of a canonical directory + operation,
  re-checked at every execution; revocation removes eligibility. Approving `/`
  or anything inside the Ghost root is refused (a tool can never alter its own
  policy or identity store). Symlink components below the granted directory
  are denied; lexical `..` escapes and sibling-prefix tricks are rejected;
  writes use atomic `create_new` and refuse to overwrite existing files; reads
  are capped at 1 MiB. All SQL is parameterized.
- **Persona** is immutable per profile, persists across reopen, and is carried
  in every provider request (mock output echoes it). Reconstructed LLM
  conversation history is available through the newer durable conversation API;
  this legacy task path retains its session/task records.

**Security honesty**: path checks are `symlink_metadata`-based and subject to
TOCTOU above the final component; this MVP assumes no hostile concurrent
mutation of granted folders and makes no production-sandbox claim. The single
profile lock cannot stop independent external filesystem actors. A hardened
build should use handle-relative opens (e.g. cap-std) with symlink denial.

## Providers

- `mock` (default): deterministic, offline echo of identity/session/correlation
  context. It never loads credentials and never touches the network.
- `oxicode` (optional feature `oxicode-engine`): adapter over a local SDK
  checkout; no engine tools are registered — host tools are the sole capability
  enforcement, and Ghost (not the SDK supervisor) owns persistence and
  rebinding. Build with `cargo build --features oxicode-engine`; provider
  selection is by `--model` only. Multi-provider engine routing is backlog.

The manifest configures reqwest with rustls; the HTTP tool itself is not yet
implemented or exercised in this unit. No shell, git, browser, MCP, Python, local model, or
HTTP capability is implicitly enabled, and the CLI itself never grants
agent-issued permissions.

## Judge

`LocalJudge` is advisory-only: given a prompt, candidates, and the allowed set,
it returns a recommendation with a rationale (or `None` for empty candidates).
It has no authority-grant API. The deterministic mock picks the first allowed
candidate. Laya candidate notes are coordinator backlog; no weights exist.

## Tests

`cargo test --offline -j1` uses mocks/fixtures only (no model downloads or
auth); dependencies must already be cached. CLI tests spawn separate `ghost` processes to prove submit survives
process exit and that two ghosts stay isolated. Optional engine construction is
tested only under `cargo test --features oxicode-engine` and makes no model or
API calls.

## Backlog

Oxibrain search integration, reconstructed conversation history, Knock/FARM
composition, engine multi-provider routing, hardened handle-relative FS tools.

## Verified first unit

See [status and evidence](docs/status.md). The default standalone development
binary is `dist/ghost-macos-arm64`; it has been run with a cleared environment.
Default acceptance tests: 24 passed. Optional engine tests: 25 passed, including
credential-free model registry resolution; live LLM calls were not performed.

## Ghosts collaboration checkpoint

Ghosts manages exactly two existing Ghosts in this bounded unit. A parent is
owned by one of those Ghosts; worker roles provide text context. Delegation
cannot inherit file, HTTP, shell or MCP capabilities. Each worker retains its
own identity, policy, sessions and inbox/outbox.

```
ghost --root DIR ghosts submit --request-id MSG --owner alpha --title TEXT \
    --worker alpha:research --worker beta:review
ghost --root DIR ghosts run WORKFLOW_ID
ghost --root DIR ghosts status WORKFLOW_ID
ghost --root DIR ghosts cancel WORKFLOW_ID
ghost --root DIR ghosts list
```

`ghosts run` uses MockProvider only. Status/list use public read-only APIs and
show last-harvested persisted results. The coordinator journal and profile
DBs are separate: durable intent, sender/message dedup and receipt validation
reconcile delivery; no cross-DB atomic transaction is claimed. Cancellation
is recorded before propagation and unknown work is not automatically replayed.

See [collaboration contract](docs/collaboration-acceptance.md),
[architecture](docs/adr-003-ghosts-collaboration.md),
[v1 acceptance stages](docs/v1-acceptance.md) and
[next native provider unit](docs/native-provider-next.md).
Mock CLI checkpoints do not constitute a finished Ghosts v1 app.

## Verified collaboration recovery — 2026-10-02

See [recovery result and evidence](docs/recovery-2026-10-02.md).
Default regression: 43 passed. Optional SDK regression: 44 passed with global
MCP/config access and networking denied. The standalone macOS arm64 development
binary is `dist/ghosts-macos-arm64`; cleared-environment smoke passed.
Live providers, credentials and browser integration remain future units.

## Native text provider mock unit — 2026-10-02

Two explicit library configurations (OpenAI/Z.ai) share a bounded SSE text/usage
adapter with host-controlled endpoint policy, cancellation/deadline and durable
per-profile call receipts. Default CLI execution remains mock; user credential
input and live native execution are a later unit. Read a stored receipt with:

```sh
ghost --root DIR task provider-receipt PROFILE TASK_ID
```

The command opens the profile through the existing writer/recovery path; the
receipt projection itself is read-only. Terminal and uncertain calls are never
automatically replayed. Raw provider error bodies are excluded from records.
Reported token usage is advisory and does not prove billing or completion.

See [transport decision](docs/adr-004-native-provider-control.md),
[native verification](docs/native-provider-2026-10-02.md) and
[proposed browser boundary](docs/browser-core-next.md). Loopback-only test
constructors require `native-fixtures`, absent from the default artifact.
This is a bounded mock acceptance unit, not a Ghosts v1 release.

## Browser core fixture unit — 2026-10-02

The `browser` library API binds a fake stdio child to one Ghost/session, checks
fixture-only grants, and joins request/snapshot/cancellation handling to the
existing durable effect ledger. Unknown outcomes block restart until separate
trusted reconciliation and never replay the old effect. Page data cannot mint
permissions or resume control. No production browser constructor or browser CLI
execution command is exposed. The default executable still runs without an
extra runtime or browser executable.

See [browser host contract](docs/adr-005-browser-fixture-host.md) and
[actual verification](docs/browser-core-2026-10-02.md). `browser-fixtures` builds
a finite test helper only. The following checkpoint adds actual local-fixture validation.


## Actual browser local-fixture unit — 2026-10-02

`browser-local-e2e` runs nine acceptance cases against a pinned actual OxiBrowser
CLI with separate local-fixture grants and per-child exact-port macOS containment.
Observe/fill/click, two Ghosts, refs, deny, dedup, cancel/timeout/crash and lost
commit recovery passed. Default 47, local 77, combined SDK/HTTP 96 tests passed;
base standalone CLI smoke passed. See [verification and remaining scope](docs/browser-local-e2e-2026-10-02.md).
The base binary is `dist/ghost-local-browser-macos-arm64`; actual browser execution
remains an optional feature-gated library test, with no browser CLI command.
Private-FD human ownership, real sites/credentials and Ghosts v1 remain unverified.


## Private controller and watchdog fixture unit — 2026-10-02

A separate browser-handoff-fixtures library host owns an anonymous private control
FD and an independent child watchdog. Task/session/epoch binding, pause/human
admission, all-tab fresh observations and durable UNKNOWN recovery passed against
actual local OxiBrowser children. Trusted input is fixture-only; it does not prove
actual user confirmation or UI approval. No script/network freeze is available.

Default 47 / no-SDK browser 91 / complete SDK-HTTP-browser 110 passed,
failed/ignored 0. Base CLI smoke passed; default artifact is
`dist/ghost-handoff-checkpoint-macos-arm64`, with fixture constructors disabled.
See [actual verification and limits](docs/browser-handoff-2026-10-02.md).
Next is a bounded host UI and real trusted input validation, before live accounts.


## Temporary fixture host UI — 2026-10-02

`ui-fixtures` embeds static HTML/CSS/JS in one Rust executable and serves a
finite loopback session, without a Node/Bun/Python product runtime. Its two
marked fixture profiles expose mock conversation, independent tasks, actual
results/errors/cancel and local-browser ownership/epoch/handoff/resume.
Actual browser buttons additionally require the pinned OxiBrowser artifact
and macOS sandbox-exec; the browser is not bundled.

```sh
# Use a new empty fixture root and the explicit local artifact pin.
dist/ghost-ui-fixture-macos-arm64 --root /tmp/ghost-ui-new ui-fixture   --browser-pin docs/evidence/handoff-pin.json --seconds 180
```

Open the public loopback URL from stdout manually. It expires in 1..300 seconds;
no auto-open, accounts, credentials, publishing or autostart. MockProvider and
fixture mode are visible. Fixed routes, session/CSRF/Origin checks and typed
host actions keep page/model text separate from commands. UI and untrusted
page fixtures have different origins; child containment excludes the UI port.
This is CSRF containment, not real human authentication or script/network freeze.

Default47 / no-SDK browser+UI95 / complete114 passed, failed/ignored0.
Standalone fixture artifact smoke and its four HTTP acceptance cases passed.
Actual GUI render/DOM interaction/screenshots await the parent's shared GPU
slot; they are **not verified yet**. See [result, evidence and limits](docs/ui-fixture-2026-10-02.md).
