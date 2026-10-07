# Ghost 개인 서버와 iPhone 연결

현재 제공하는 구성은 소유자 한 명을 위한 초기 접속 경로다. Rust host는 loopback에
유지하고 Caddy 등의 TLS proxy와 선택형 Node gateway를 함께 실행한다.
설치·외부 공개·실제 공급자 호출을 자동 수행하는 스크립트는 없다.

## 준비

- Rust host 빌드: 프로젝트의 기존 로컬 의존성 checkout이 필요하다.
- Node 22 이상. gateway에는 추가 npm 의존성이 없다.
- 휴대폰에서 접속 가능한 DNS 이름과 유효한 HTTPS 인증서.
- Ghost state와 기기 registry에 접근할 같은 OS 사용자. root 실행은 필요하지 않다.

저장소에서:

```sh
cargo build --release --features workspace-ui
mkdir -p "$HOME/Library/Application Support/GhostServer"
chmod 700 "$HOME/Library/Application Support/GhostServer"
target/release/ghost --root "$HOME/Library/Application Support/GhostServer/state" serve --headless
```

실제 모델·음성은 해당 서버 프로세스의 인증 환경을 별도로 설정해야 한다.
음성에는 `OPENAI_API_KEY`, 선택적으로 `GHOST_VOICE_MODEL`이 필요하며 각 Ghost의
`voice` 정책도 허용되어야 한다. 키를 휴대폰에 입력하지 않는다. 테스트의 `mock`
모델은 대화 접수·실행·복구를 확인하기 위한 것으로 실제 지능/음성 검증이 아니다.

## 기기 등록과 게이트웨이

서버 사용자로 실행한다. 아래 명령의 출력 중 token은 이 기기의 전체 owner 접근 키다.
공유 로그나 URL에 넣지 말고 iPhone의 연결 화면에 입력한다. registry에는 digest만 남는다.

```sh
node apps/ghost-gateway/devices.mjs issue "$HOME/Library/Application Support/GhostServer/devices.json" "내 iPhone"

GHOST_ROOT="$HOME/Library/Application Support/GhostServer/state" \
GHOST_GATEWAY_DEVICES="$HOME/Library/Application Support/GhostServer/devices.json" \
GHOST_GATEWAY_ORIGIN="https://ghost.example.com" \
node apps/ghost-gateway/server.mjs
```

이 gateway는 `127.0.0.1:8788`에서만 수신한다. `Caddyfile.example`의 도메인을
실제 도메인으로 바꾸고 TLS proxy를 시작한다. upstream Host는 그 도메인을 유지해야
한다. HTTPS origin에 path/query/사용자 정보는 사용할 수 없다. LAN이나 인터넷에
Rust API 또는 Vite 개발 서버를 직접 노출하지 않는다.

gateway는 `apps/ghost-ui/server/bridge.mjs`의 discovery 코드를 재사용한다.
gateway 폴더만 따로 복사하면 안 된다. 이 공통 코드를 포함한 프로젝트 구조를 유지한다.

```sh
node apps/ghost-gateway/devices.mjs list /absolute/path/devices.json
node apps/ghost-gateway/devices.mjs revoke /absolute/path/devices.json DEVICE_ID
```

철회는 이후 요청을 차단한다. 이미 접수된 작업을 취소하는 동작과 다르다.
기기 키 파일에 그룹/다른 사용자 권한이 있으면 gateway는 요청을 거절한다.

## 서비스 등록

macOS에서는 `render-launchd.py`로 plist를 생성해 검토할 수 있다. 파일은 0600으로
새로 만들고 기존 파일은 덮어쓰지 않는다. 이 명령은 서비스를 등록하지 않는다.

```sh
python3 deploy/self-host/render-launchd.py \
  --source /absolute/path/ghost \
  --binary /absolute/path/ghost/target/release/ghost \
  --node /absolute/path/node \
  --state /absolute/path/ghost-state \
  --devices /absolute/path/devices.json \
  --origin https://ghost.example.com \
  --output /absolute/path/reviewed-services
```

공급자 환경 변수는 호스트 plist의 `EnvironmentVariables` 또는 사용자가 관리하는
자격증명 로더에서 주입한다. 비밀이 담긴 설정은 0600을 유지하고 저장소에 넣지 않는다.
검토한 plist를 사용자 `~/Library/LaunchAgents`에 설치하고 `launchctl bootstrap`
명령으로 로드할 수 있다. LaunchAgent는 사용자 로그인 세션 수명에 묶인다. 로그아웃
상태에서도 필요한 서버라면 별도의 서비스 계정/LaunchDaemon 운영을 검토해야 한다.

Linux 예시는 `*.service.example`, `gateway.env.example`이다. Linux용 바이너리 빌드는
아직 검증하지 않았으며, Cargo의 로컬 checkout 의존성을 먼저 공급해야 한다.
예시의 경로·사용자와 환경 파일은 실제 설치에 맞춰야 한다. VM/container를 위한
이식 가능한 소스 빌드와 이미지 배포는 후속이다.

SIGINT와 SIGTERM은 같은 host drain 경로를 사용한다. 활성 요청과 worker를 마친 뒤
discovery를 제거한다. gateway는 최대 65초 동안 진행 중 요청을 기다린다.

## 백업·복구

살아 있는 SQLite 파일만 단순 복사하지 않는다. 기존 host의 `backup` owner action과
복원 절차를 사용한다. 문서 원본, 기기 registry, 공급자 자격증명은 보관 정책에 따라
별도 백업한다. 복원한 상태를 동시에 두 host가 쓰지 않도록 원래 host를 먼저 내린다.
서버 재시작 뒤 모바일은 새 discovery를 거쳐 같은 workspace와 대화를 조회한다.
불명 effect와 통화 시작 결과를 자동 재실행하지 않는다.

## 검증

```sh
node --test apps/ghost-gateway/gateway.test.mjs
cargo test --offline --test self_host
GHOST_TEST_BINARY="$PWD/target/debug/ghost" node --test apps/ghost-gateway/host.integration.mjs
```

현재 검증은 로컬 macOS와 격리된 mock host다. 실제 공개 도메인의 TLS 운영, iPhone의
실제 음성 오디오, 클라우드 PC 배포, 로컬 PC 제어는 별도 수용 시험 대상이다.
