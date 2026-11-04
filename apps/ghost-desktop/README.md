# Ghost desktop

Ghost의 기존 React 콘솔을 Tauri 2 창으로 실행한다. UI 디자인, Rust 실행 호스트와 저장 형식은 유지한다. 앱이 Node 콘솔과 그 자식 Rust/UI 서버만 감독하며 외부에서 시작한 호스트는 종료하지 않는다. 창 상단 46px은 콘솔 UI가 Tauri 셸에서만 렌더링하는 Garden `GTitleBar` 커스텀 타이틀바다(macOS traffic-light inset 80px, 전 구간 drag). 브라우저 콘솔 레이아웃은 이 바 없이 그대로 유지된다.

Garden 0.1.0의 `contracts/native/README.md`, `templates/desktop/src-tauri`, `packages/native/rust`를 기준으로 네이티브 수명주기를 통합했다. 사용자의 지시에 따라 Garden 전체 UI/문서/서비스 프레임워크 채택은 수행하지 않는다. `vendor/garden-native-host`는 실행 감독기 원본과 라이선스만 보존한 스냅샷이다. IPC 권한은 창 드래그와 오버레이 창의 native hide뿐이다. 작업 명령은 기존 typed control API와 같은 출처의 인증 브리지를 사용한다.

## 채팅 오버레이

앱은 콘솔과 같은 출처의 작은 채팅 오버레이 창(`overlay.html`)을 기동 시 화면 밖에
미리 만들어 둔다. 전역 단축키 **⌘⇧G**로 주 창 모니터 아래 center에 한 프레임 만에
띄우고, 다시 누르면 감춘다. Esc와 포커스 상실(바깥 클릭·다른 앱 전환)도 오버레이를
감춘다. 입력은 Enter로 전송하고 Shift+Enter는 줄바꿈이다. 대화 상대는 "primary"
Ghost이며 마지막 대화를 이어서 하고, Ghost·대화 선택은 `localStorage`에
workspace별로 기록된다. 전송은 콘솔과 같은 routing 절차(`routing_natural` → 접수 →
`routing_admit`)를 쓰므로 접수 대기·취소 기록도 콘솔과 공유한다.

앱은 `~/.config/ghost/console.json`의 경로·모델·포트를 읽어 재사용한다. 인증 파일이나 운영 데이터를 번들에 넣지 않는다. 설정이 없으면 `~/Library/Application Support/Ghost`와 `mock` 모델을 사용한다. 앱 종료는 작업 취소가 아니며 호스트의 정상 종료/복원 경로를 따른다. 앱을 다시 열면 저장된 대화와 작업을 복원한다. 같은 포트에 기존 콘솔이 있으면 그 프로세스를 건드리지 않고 안내한다.

상시 Host 또는 mini 연결을 사용할 때는 이 설정에 `"host_mode":"external"`을 명시한다. 앱은 해당 `root`의 접속 정보를 HMAC으로 검증한 뒤 UI만 시작한다. 연결 실패 때 새 Host를 띄우지 않으며, 앱을 닫아도 외부 Host는 종료하지 않는다. 별도 Host를 앱이 소유하는 기존 동작은 `managed` 모드다. 외부 모드 검증은 `node --test apps/ghost-ui/scripts/console.test.mjs`로 실행한다. UI 브리지의 이미지 모듈도 형제 `ghost-omp/` 경로로 함께 패키징한다.

```sh
# Ghost root에서 먼저 실행
cargo build --offline --features workspace-ui
npm --prefix apps/ghost-ui run build
# 이 폴더에서, 정확한 Tauri 2.12 CLI와 macOS용 독립 실행 Node를 준비한 뒤
GHOST_NODE_BINARY=/path/to/node-v24.21.0-darwin-arm64/bin/node npm run build
npm run check
npm test
```

`GHOST_NODE_BINARY`는 [공식 Node.js macOS 배포본](https://nodejs.org/dist/)의 standalone 실행 파일을 가리킨다. Homebrew Node처럼 `/opt/homebrew` dylib에 연결된 실행 파일은 다른 Mac에서 열리지 않으므로 패키징 단계에서 거부된다. `prepare.mjs`는 복사하기 전에 Node 버전을 실행 확인하고, macOS에서는 `otool -L`로 `/System/Library`와 `/usr/lib` 외부의 dylib 의존성을 검사한다.

번들은 로컬 개발용 `Ghost.app`이며 Apple Developer ID 서명/공증 배포를 주장하지 않는다. 사용자가 승인한 닫힌 몸체·짧은 두 눈·작은 원형 입의 Ghost PNG/SVG 원본을 `src-tauri/brand-source`에 보존하고 Tauri 아이콘 변환으로 번들·Dock에 적용한다. 기본 펫도 같은 캐릭터를 사용한다.

격리 smoke는 앱의 `Contents/MacOS/ghost-desktop --desktop-probe`를 `GHOST_ROOT`의 새 임시 경로, `GHOST_MODEL=mock`, 사용하지 않는 `GHOST_DESKTOP_PORT`로 실행한다. 프로브는 실제 패키지의 실행·health identity·종료를 검증하지만 화면 E2E 통과를 뜻하지 않는다. 실제 앱 화면에서 승인/거절, 취소, 재시작 복구를 별도로 검증해야 한다.

로컬 음성 통화는 기본 음성 입력과 출력을 Ghost의 기존 durable 대화에 연결한다. 발화 시 재생을 멈추며, 통화 종료는 접수된 작업을 취소하지 않는다. 진행 중 작업을 취소하려면 통화의 `작업 취소`를 사용한다. 마이크 권한은 통화를 시작할 때 WebKit과 macOS가 요청한다. 앱은 카메라 요청을 거부한다.

선택한 STT/TTS의 주소는 loopback이어야 한다. 오디오는 임시 HTTP 요청과 메모리에서만 처리하고 durable 명령 영수증이나 대화 기록에 넣지 않는다. 인식한 텍스트와 실제 작업 응답은 기존 대화 정책에 따라 기록한다. 외부 음성 제공자는 이 통화 경로에서 지원하지 않는다.

이 Mac에서 이미 캐시된 Whisper large-v3-turbo와 Qwen3 TTS 0.6B를 사용하도록 별도 `apps/ghost-voice-server/.venv`를 설치했다. 모델 가중치와 Python 환경은 앱 번들에 넣지 않는다. 번들의 서버 코드와 호스트 전용 설정 디렉터리의 `local-voice.json`을 사용한다:

```json
{"enabled":true,"python":"/absolute/path/to/ghost/apps/ghost-voice-server/.venv/bin/python","port":62076}
```

설정의 실행 파일 경로는 네이티브 설치자가 관리하며 renderer 입력으로 바꿀 수 없다. 설정이 없거나 Python/모델 캐시가 준비되지 않아도 일반 채팅은 시작한다. 앱이 시작한 음성 자식만 종료하고, 이미 다른 프로세스가 사용하는 포트는 거부한다. 자동 시작 여부와 관계없이 모델 설정에서 제공자 `http://127.0.0.1:62076/v1`, STT `whisper-large-v3-turbo`, TTS `qwen3-tts-0.6b-customvoice`를 선택하고 해당 Ghost 설정에서 음성 사용을 허용해야 한다.
