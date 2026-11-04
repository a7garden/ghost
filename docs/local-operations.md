# Ghost 로컬 운영

2026-11-04 Studio 관측 기준이다.

| 역할 | 운영 진입점 | 확인 |
| --- | --- | --- |
| 상태와 작업 | `com.a7.ghost`, `127.0.0.1:62062` | `~/.local/bin/ghost`가 `20261104-dashboard-4a6b57a/ghost` 릴리스를 가리킨다. 기존 Ghost 프로필 9개를 읽었다. |
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

교체 전 활성 Pi 실행은 없었다. 중지된 Host 상태 전체를 `.orch/ghost-rollout-20261104/rollback/state`에 보존했다. 재시작 후 registry·binding·authority·work·Pi execution 행이 백업과 같고 기기 registry와 콘솔 설정의 bytes가 유지됨을 확인했다. 기존 프로필 9개 조회, Mac UI live bootstrap, Gateway loopback 및 운영 HTTPS health가 성공했다. 실제 새 모델 작업·음성·push는 이번 설치 검증 범위에 포함하지 않았다. iPhone 실행은 기기 잠금 때문에 검증 대기이며 Mac native 화면 검수는 다른 desktop workflow 점유로 수행하지 않았다.

복구 자료는 같은 rollback 디렉터리의 이전 binary link, runtime.env, Gateway plist, console.json 및 Ghost.app이다. 이전 Mac 앱은 `~/Applications/Ghost.previous-20261104.app`에도 있다. 복구 시 먼저 진행 중 작업을 확인하고 앱 및 Host/Gateway를 중지한 후 이전 실행 링크·runtime.env·Gateway plist·앱을 되돌리고 재시작한다. 상태 백업을 현재 상태에 자동 덮어쓰지 않는다. 교체 이후 업무가 생겼다면 별도 대사 없이 과거 DB를 복원해서는 안 된다.
