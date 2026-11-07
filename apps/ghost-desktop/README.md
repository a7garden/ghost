# Ghost desktop

Ghost의 Mac 앱은 Tauri 2 셸이다. UI와 API는 Ghost 호스트(하나의 Bun 프로세스)가 직접 제공하고, 셸은 그 호스트를 찾아 붙거나 직접 기동한다. 셸이 UI를 서빙하거나 브리지를 운영하지 않는다. 창 상단 46px 타이틀바는 ghost-ui의 앱 소유 `TitleBar`가 Tauri 셸에서만 렌더링한다(macOS traffic-light inset 80px, 전 구간 drag).

## 호스트 연결

`~/.config/ghost/console.json`은 두 키만 읽는다.

- `host_mode` — `external` | `managed` (기본값: `managed`)
- `root` — 상태 루트 (기본값: `~/Library/Application Support/Ghost`)

알 수 없는 키는 무시한다(이전 설정의 `port`·`model`·`auth_file` 등은 더 읽지 않는다). `GHOST_CONSOLE_CONFIG` 환경 변수가 설정 파일 경로를 대신한다 — 시험 실행이 소유자의 설정을 건드리지 않도록 임시 파일을 가리키는 데 쓴다.

- **external** — `<root>/host.json`(`{port, token, pid}`)을 읽고 `GET http://127.0.0.1:<port>/api/health`가 `{"ok":true}`로 답하는지 확인한 뒤 주 창을 `http://127.0.0.1:<port>/`로, 오버레이를 `<origin>/overlay.html`로 연다. 탐색 허용 목록은 그 오리진에 고정된다. 호스트가 루프백 요청에 한해 서빙하는 모든 HTML에 `window.__GHOST_TOKEN__`을 주입하므로 UI 인증은 호스트가 책임진다. 앱은 외부 호스트를 시작하지도, 종료하지도 않는다.
- **managed** — 번들에 포함된 `resources/host/ghost serve`를 `GHOST_ROOT=<root>`, `GHOST_UI_DIR=<resources/ui>`로 기동하고 host.json과 health를 기다린다. 포트는 host.json이 진실이다(루트의 config.json이 정하거나 호스트가 고른다). 호스트가 죽으면 지수 백오프로 재시작하고, 앱 종료 때 프로세스 그룹째 종료한다.

## 채팅 오버레이

앱은 시작 시 화면 밖에 파킹해 둔 작은 오버레이 창을 만든다. 전역 단축키 **⌘⇧G**로 주 창 모니터 아래 center에 한 프레임 만에 띄우고, 다시 누르면 감춘다. Esc와 포커스 상실(바깥 클릭·다른 앱 전환)도 오버레이를 감춘다. 오버레이 페이지는 호스트가 서빙하는 `overlay.html`이며 기본 Ghost와의 대화를 이어서 한다. Ghost·대화 선택은 `localStorage`에 기록된다.

## 패키징

`npm run prepare`가 번들 페이로드를 만든다:

1. `bun build apps/ghost-host/src/main.ts --compile --outfile src-tauri/resources/host/ghost` — 호스트 실행 파일(단일 실행 파일, Bun 컴파일).
2. `bun run build` in `apps/ghost-ui` — UI를 빌드.
3. `apps/ghost-ui/dist` → `src-tauri/resources/ui` 복사.
4. `src-tauri/resources/payload.json` — 호스트·UI sha256 기록. 자격 증명과 사용자 데이터는 포함하지 않는다.

Node 런타임, 콘솔 런처, 로컬 음성 리소스는 더는 번들에 넣지 않는다. Bun(호스트 빌드)과 Rust 도구만 필요하다.

## 검증

```sh
npm run check   # cargo fmt --check + cargo clippy --offline --all-targets -- -D warnings
npm test        # src-tauri 프로세스 감독(supervisor) 테스트
```

격리 smoke는 앱의 `Contents/MacOS/ghost-desktop --desktop-probe`를 임시 설정(`GHOST_CONSOLE_CONFIG`가 가리키는 `{"host_mode":"managed","root":"<임시>"}` 파일)으로 실행한다. 프로브는 실제 패키지의 실행·host.json 발견·health·종료를 검증하지만 화면 E2E 통과를 뜻하지 않는다.

외부 모드 실행 검증: 임시 루트로 호스트를 띄운다(`GHOST_ROOT=$(mktemp -d) GHOST_PORT=0 GHOST_UI_DIR=<빌드된 ui> bun apps/ghost-host/src/main.ts serve`), 임시 console.json을 쓰고(`GHOST_CONSOLE_CONFIG`) 디버그 빌드를 실행해 창이 호스트 UI를 띄우는지 확인한다.

번들은 로컬 개발용 `Ghost.app`이며 Apple Developer ID 서명/공증 배포를 추진하지 않는다. 앱 아이콘은 원형 Ghost(승인된 얼굴)와 파란 작업 호다. 원본 `src-tauri/brand-source/Ghost-round-macos.svg`를 1024px 투명 PNG로 렌더링하고 `npx tauri icon <png> -o src-tauri/icons`로 번들·Dock 아이콘을 만든다. 이전 아이콘 원본과 이력은 같은 폴더의 `provenance.json`에 있다.
