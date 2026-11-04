# Ghost 로컬 운영

2026-11-05 Studio 관측 기준이다.

| 역할 | 운영 진입점 | 확인 |
| --- | --- | --- |
| 상태와 작업 | `com.a7.ghost`, `127.0.0.1:62062` | `~/.local/bin/ghost`가 `20261105-orchestra-1d96dfd-ui/ghost` 릴리스를 가리킨다. 기존 Ghost 프로필 9개를 읽었다. |
| Mac 앱 | `~/Applications/Ghost.app`, `127.0.0.1:65164` | `~/.config/ghost/console.json`의 `host_mode: external`을 사용한다. 앱이 기존 Host에 인증해 상태를 읽었다. |
| 휴대폰 연결 | `com.a7.ghost-gateway`, `127.0.0.1:8788` | 동일 운영 상태 루트에 연결된 Gateway다. |
| 로컬 추론 | `com.a7.ghost-local-inference` | 기존 모델 경로를 유지한다. |
| 구형 콘솔 | `com.a7.ghost-ui`, `127.0.0.1:5178` | Studio에서 중지하고 자동 실행을 비활성화했다. plist는 복구용으로 보존한다. |

정본 상태는 `~/Library/Application Support/Ghost`에 있다. 앱을 열고 닫는 동안 상시 Host가 이 상태의 writer를 맡는다. 주 Ghost는 담당 Ghost에 위임할 수 있다. 기존 논리 Ghost와 연결된 기기는 보존한다. 운영 Host를 교체할 때는 실행 중 업무와 원장 보존을 먼저 확인하고, 이전 릴리스로 복구할 경로를 기록한다.

## 소스와 검증

정본 저장소는 `~/Workspace/Projects/ghost`의 `main`이다. 변경을 올리기 전에 실제 앱 진입점과 대상 영역 테스트를 확인한다. 개발용 Host에는 임시 루트와 별도 포트를 지정하고 종료 시 앱, UI 서버, Host를 함께 확인한다. 운영 Host 테스트는 조회부터 시작한다.

```sh
launchctl print "gui/$(id -u)/com.a7.ghost" | grep -E '^[[:space:]]+(state|pid) ='
launchctl print-disabled "gui/$(id -u)" | grep -F com.a7.ghost-ui
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(62062|65164|8788|5178) '
curl -fsS http://127.0.0.1:65164/ghost-api/bootstrap | jq '{mode, owner_pid}'
```

운영 콘솔의 Host 연결을 확인하려면 앱에서 기존 Ghost가 열리는지 본다. 부트스트랩 값은 필요한 필드만 출력한다. iPhone 운영 앱의 연결과 Tauri의 공유 UI Preview 검증은 따로 기록한다. [패키지와 Preview 재현](ghost-packages-and-shared-client.md)

## Bun을 포함한 Host 패키지

`ghost`는 Rust Host이고, 같은 릴리스의 `ghost-pi`에는 Bun과 Pi SDK가 들어 있다. Host는 Ghost별 정체성, 권한, 위임과 결과 수용을 관리한다. Pi는 대화별 세션과 도구 실행을 관리하고, Host와 기존 JSONL 연결로 통신한다. 릴리스에 포함된 실행 파일을 먼저 선택하며, 이전 릴리스에서는 `GHOST_LIFETIME_PI_ENTRY`가 가리키는 Node 실행 경로를 사용할 수 있다.

Bun 1.4.2와 `apps/ghost-durable`의 잠금 의존성을 준비한다. 운영 LaunchAgent는 `run --ui`를 사용하므로 `lifetime,workspace-ui` 기능으로 빌드한다. `scripts/install.py --features lifetime,workspace-ui`는 관리되는 releases 링크에만 사용한다. Studio의 bundles 설치는 검증한 버전 디렉터리와 실행 링크를 교체한다. 기존 Rust 빌드에 Pi를 포함하려면 `--skip-build --bundle-pi`를 사용한다. 설치 명세에는 두 실행 파일과 Pi 의존성 잠금 파일의 SHA-256이 들어간다. 운영은 `GHOST_LIFETIME_MODE=broker`, 격리 검증은 별도 상태 루트와 `GHOST_LIFETIME_MODE=fixture`를 사용한다. Pi 실행을 끄려면 `GHOST_LIFETIME_MODE=disabled`를 사용한다. Node 릴리스로 복귀할 수 있도록 기존의 `GHOST_LIFETIME_PI_ENTRY`와 `GHOST_LIFETIME_MODE` 설정을 보관한다.

Apple-container 업무는 Pi 기본 파일·셸 도구를 Host가 승인한 업무 공간에서 실행한다. Bun 번들 검증은 별도 Host에서 위임, Pi 재시작 후 대기 해제, 두 산출물의 검수, 기본 대화의 최종 보고까지 다룬다. [직접 실행 계약](pi-direct-execution.md)

## 구형 콘솔 복구

운영 앱의 대체 접점이 필요한 경우 기존 plist로 웹 콘솔을 일시 복구할 수 있다. Host는 기존 프로세스를 사용한다.

```sh
ghost_domain="gui/$(id -u)"
launchctl enable "$ghost_domain/com.a7.ghost-ui"
launchctl bootstrap "$ghost_domain" "$HOME/Library/LaunchAgents/com.a7.ghost-ui.plist"
```

일시 복구를 마치면 `launchctl disable "$ghost_domain/com.a7.ghost-ui"`와
`launchctl bootout "$ghost_domain/com.a7.ghost-ui"`로 운영 앱 경로 하나로 돌아간다.

## 2026-11-04 대시보드 운영 교체

소스 `4a6b57af33a301e331de2cc3664087f1f383844a`의 Host, Pi runtime, Gateway, Mac 앱과 실제 iPhone 14 앱을 설치했다. Host/Gateway 릴리스는 `~/.local/share/ghost/bundles/20261104-dashboard-4a6b57a`이며, Mac 앱은 기존 외부 Host 설정을 유지한다. 개발 서명 빌드이며 공증/App Store 배포는 아니다. iPhone은 기존 번들 ID에 덮어 설치했고 삭제하지 않았다. Personal Team용 별도 entitlement를 사용했으며 APNs 수용을 뜻하지 않는다.

교체 전 활성 Pi 실행은 없었다. 중지된 Host 상태 전체를 `.orch/ghost-rollout-20261104/rollback/state`에 보존했다. 재시작 후 registry·binding·authority·work·Pi execution 행이 백업과 같고 기기 registry와 콘솔 설정의 bytes가 유지됨을 확인했다. 기존 프로필 9개 조회, Mac UI live bootstrap, Gateway loopback 및 운영 HTTPS health가 성공했다. 실제 새 모델 작업·음성·push는 이번 설치 검증 범위에 포함하지 않았다. 잠금 해제 후 실제 iPhone에서 `io.a7garden.ghost` 실행이 성공했다. 휴대폰 화면의 대화 조회·전송은 별도 확인이 필요하며 Mac native 화면 검수는 다른 desktop workflow 점유로 수행하지 않았다.

복구 자료는 같은 rollback 디렉터리의 이전 binary link, runtime.env, Gateway plist, console.json 및 Ghost.app이다. 이전 Mac 앱은 `~/Applications/Ghost.previous-20261104.app`에도 있다. 복구 시 먼저 진행 중 작업을 확인하고 앱 및 Host/Gateway를 중지한 후 이전 실행 링크·runtime.env·Gateway plist·앱을 되돌리고 재시작한다. 상태 백업을 현재 상태에 자동 덮어쓰지 않는다. 교체 이후 업무가 생겼다면 별도 대사 없이 과거 DB를 복원해서는 안 된다.

## 2026-11-05 Orchestra 운영 교체

Studio의 `com.a7.ghost`에 `20261105-orchestra-1d96dfd-ui`의 Rust Host와 Bun 1.4.2/Pi를 설치했다. `~/Applications/Ghost.app`에는 `9661c38` UI를 설치했다. 앱 프로세스가 외부 Host에 인증해 프로필 9개를 조회했다. 앱이 띄운 로컬 UI에서 공개 대화와 작업 스레드를 열고 `맡긴 일 검수 완료`와 작업 보고를 확인했다. 실행 한도가 지나 그래프가 만료된 뒤에도 최신 수용 판본의 `primary → specialist-engineering` 경로와 두 작업의 검수 완료 상태가 표시된다. 기존 기본 대화의 메시지 51개, Goal 18개, 모델과 제공자 권한은 교체 전 사본과 일치했다.

기본 Ghost의 별도 공개 대화 `83a3e562-e44d-469e-b4ba-761879fe79d5`에서 합성 업무 한 건을 맡겼다. 첫 판본에서 독립 검수가 실패했고, 판정에 필요한 실행 사실과 실패 보고 경로를 보강했다. 두 번째 판본은 입력 파일이 없는 위임의 도구 입력 검증에서 멈췄고, Pi 도구 스키마를 수정했다. 같은 Goal의 세 번째 판본에서 Z.AI `glm-5.3`이 접수(`low`), 부모와 하위 Work(`high`)를 실행했다. 부모는 하위 산출물이 게시된 뒤 대기를 재개해 그 SHA-256을 결과에 포함했다. 별도 Pi 세션의 `MiniMax-M3.1-Flash-Preview`(`medium`)가 통과를 기록했다. Owner가 검수본과 게시본의 해시를 대조하고 수용했으며, 검수와 수용 보고가 원래 공개 대화에 도착했다. 테스트 대화의 리뷰 제공자 승인을 해제하고 하위 Ghost의 모델 경로를 복귀시켰다.

초기 교체에서 `workspace-ui` 없는 바이너리는 기존 릴리스로 복귀시켰다. 검증한 이후 설치본은 `lifetime,workspace-ui`를 함께 사용한다. 작업 당시 백업과 이전 바이너리·앱 경로는 이 저장소의 비공개 `.orch/ghost-orchestra-live-20261105/rollback`에 보관했다. 복구 시 현재 업무를 확인한 뒤 이전 실행 링크를 사용하고 상태 사본은 별도 대사에 사용한다.
