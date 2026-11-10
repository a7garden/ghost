# Ghost desktop

Ghost의 Mac 앱은 Tauri 2 셸이다. UI와 API는 OS 서비스로 실행되는 Ghost 호스트(하나의 Bun 프로세스)가 직접 제공하고, 셸은 그 호스트에 연결한다. 셸이 호스트를 기동하거나 UI를 서빙하지 않는다. 창 상단 48px 타이틀바는 ghost-ui의 앱 소유 `TitleBar`가 Tauri 셸에서만 렌더링한다(macOS traffic-light inset 80px). 빈 영역과 현재 위치의 글자를 끌면 창을 옮긴다. 버튼·링크·입력 등 조작 요소와 `data-tauri-drag-region="false"` 영역은 창 이동에서 제외한다.

## 호스트 연결

`~/.config/ghost/console.json`은 상태 루트인 `root`만 읽는다. 기본값은 `~/Library/Application Support/Ghost`다. 알 수 없는 키는 무시한다. `GHOST_CONSOLE_CONFIG` 환경 변수로 설정 파일 경로를 바꿀 수 있어 시험 실행을 소유자의 설정과 격리할 수 있다.

셸은 `<root>/host.json`(`{port, token, pid}`)을 읽고 `GET http://127.0.0.1:<port>/api/health`가 `{"ok":true}`로 답하는지 확인한 뒤 주 창을 `http://127.0.0.1:<port>/`로, 오버레이를 `<origin>/overlay.html`로 연다. 탐색 허용 목록은 그 오리진에 고정된다. 호스트가 루프백 요청에 한해 서빙하는 모든 HTML에 `window.__GHOST_TOKEN__`을 주입하므로 UI 인증은 호스트가 책임진다.

앱은 호스트를 시작하거나 종료하지 않는다. 연결할 수 없으면 `ghost service install` 실행을 안내하고 재연결을 기다린다. 호스트가 재시작되어 포트나 PID가 바뀌면 모든 창을 새로 연결한다.

## 채팅 오버레이

앱은 시작 시 화면 밖에 파킹해 둔 작은 오버레이 창을 만든다. 전역 단축키 **⌘⇧G**로 열고 다시 누르면 감춘다. 데스크톱 아바타가 보이면 그 아바타가 있는 모니터의 작업 영역 안에서 머리 위에 붙는다. 좌우 가장자리에서는 가로 위치와 말풍선 꼬리를 보정하고, 위 공간이 부족하면 높이를 줄인다. 최소 대화 높이도 확보할 수 없을 때만 아래로 펼친다. 아바타가 꺼져 있으면 주 창 모니터 아래 중앙에 열린다. Esc·닫기 버튼·포커스 상실(바깥 클릭·다른 앱 전환)도 오버레이를 감춘다. 페이지는 Host의 `overlay.html`이며 선택한 Ghost의 기존 대화를 이어서 한다.

앵커는 투명 창의 상단이 아니다. `companion.html`이 SVG의 실제 그려진 영역(장식 선·일 건수 표시 포함)을 측정하고 `companion_anchor`로 전달한다. 펼친 일 목록은 대화 앵커에 넣지 않는다. 이 영역은 메모리에만 보관하며 크기가 바뀌면 무효화한다. 꼬리는 비대칭 장식이 아닌 몸통 중심을 향한다. macOS 창 위치·크기는 대상 모니터 배율로 계산한다.

## 데스크톱 아바타

설정 → 데스크톱 아바타에서 켜는 세 번째 창은 Host의 `companion.html`을 연다. 투명하고 장식·그림자가 없으며 다른 앱 위와 모든 Spaces에 머문다. macOS에서는 `FullScreenAuxiliary`를 지정해 전체 화면 앱과 함께 표시할 수 있게 한다. 포커스를 빼앗지 않고, Ghost를 끌어 이동하고 한 번 눌러 해당 Ghost의 대화를 바로 연다. 주 창 열기는 대화창의 아이콘과 네이티브 우클릭 메뉴에 둔다. 평소 창은 크기에 따라 112×142 / 140×170 / 168×198 논리 픽셀이다.

긴 상태 말풍선 대신 맡긴 일 또는 확인할 일의 건수만 표시한다. 포인터를 올리거나 건수를 누르면 너비 320px, 기존 높이 +240px의 일 목록으로 펼친다. 확인할 일부터, 그 아래 모든 진행 중인 일을 제목·상태 행으로 보여 주고 긴 제목은 줄바꿈한다. 많은 일은 ScrollRail로 스크롤한다. 행은 주 창의 해당 결정 또는 맡긴 일로 이동한다. 포인터가 떠나면 닫히고, 키보드로 누르기·Tab 이동·Escape 닫기도 지원한다. 펼침·접힘은 몸통 아래 중앙을 기준으로 같은 모니터 작업 영역 안에서 보정하고, 접을 때 원래 위치를 복구한다. 끌기 중에는 펼침을 멈춘다. 투명 창 영역만 입력을 받으며, 펼친 좌표가 저장 위치를 덮어쓰지 않는다.


켜짐 여부와 마지막 물리 좌표는 `console.json` 옆 `companion.json`에 원자적으로 저장한다. `GHOST_CONSOLE_CONFIG`를 임시 폴더의 파일로 지정하면 아바타 설정도 그 폴더에 격리된다. 모니터가 사라지거나 크기가 바뀌면 작업 영역 안으로 좌표를 보정한다. 초기 위치·위치 초기화는 주 창 모니터의 오른쪽 아래다.

설정 파일이 비었거나 손상되었거나 읽을 수 없으면 로그를 남기고 기본값으로 시작한다. 다음 저장 때 임시 파일을 `sync_all`한 뒤 교체한다. 끌기 중 좌표는 메모리에서만 갱신하고, 놓았을 때 작업 스레드에서 한 번 저장한다. 주 창의 닫기 버튼은 창을 숨기며, 대화창의 주 창 열기·아바타 메뉴와 Dock 재열기로 다시 연다. 앱 종료(⌘Q)는 셸만 종료하며 호스트 서비스는 계속 실행된다.

Ghost·크기·일 표시는 같은 Host 오리진의 `localStorage` 키 `ghost-desktop:companion` (`{enabled, ghostId, size, bubble}`)에 저장하고 `storage` 이벤트로 공유한다. `bubble`은 건수·일 목록 표시 스위치다. 빈 `ghostId`는 메인 Ghost를 따른다. 셸의 켜짐 상태가 시작 시 우선하므로 Host 포트가 바뀌어도 아바타는 돌아온다. 주 창은 시작 시 `initializeDesktopCompanion()`을 호출한다. Host 재연결 때 세 창 모두 새 오리진으로 이동한다.

대화창은 400×440 논리 픽셀의 단일 대화면이다. 이름과 실제 응답 상태, 대화, 입력만 드러내며 유휴 상태를 성공으로 표시하지 않는다. 응답 중에는 파란 신호와 스트리밍 본문을 표시한다. Enter는 전송, Shift+Enter는 줄바꿈이고 한글 조합 중 Enter는 전송하지 않는다. 전송 실패 시 초안을 보존하며, 다른 Ghost로 바뀌면 이전 대화와 초안은 즉시 비운다.

주 창은 표시·위치 초기화·켜짐 상태 조회만, 아바타 창은 자체 크기·끌기·표시 영역 보고·네이티브 메뉴·채팅 열기·주 창 포커스·표시 동기화만 허용한다. 투명 macOS WebView를 위해 Tauri `macos-private-api`를 사용한다. 추가 entitlement는 없으며 App Store 배포용 설정은 아니다.


## 패키징

`npm run build`는 `tauri build --bundles app`으로 릴리스 `Ghost.app`과 업데이터 아카이브 `Ghost.app.tar.gz` 및 `.sig`를 만든다. 호스트 실행 파일이나 UI 페이로드는 앱에 포함하지 않는다. Node와 Rust 도구가 필요하며, 호스트·UI 릴리스는 별도로 만든다.

업데이터 아카이브 서명에는 `TAURI_SIGNING_PRIVATE_KEY`와 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`를 설정한다. 릴리스 개인 키는 `~/.tauri/ghost.key`에 보관한다. 개인 키를 잃으면 이미 배포된 앱의 업데이트를 서명할 수 없으므로 안전한 별도 백업이 필요하다. 개인 키를 저장소나 앱 번들에 넣지 않는다.

## 앱 업데이트

업데이트 원본은 비공개 GitHub Releases다. GitHub 인증과 릴리스 검증은 호스트가 맡으며 셸은 GitHub에 직접 연결하지 않는다. 셸의 `shell_version`, `shell_update_check`, `shell_update_install` 명령은 주 창에만 허용된다. 확인 시 최신 제안을 보관하고 소유자가 「설치」를 누르면 다운로드·서명 검증·설치를 거쳐 앱을 재시작한다.

확인과 설치 때마다 `<root>/host.json`에서 포트와 토큰을 읽는다. 확인 주소는 `http://127.0.0.1:<port>/api/update/shell/latest.json`, 다운로드 주소는 같은 호스트의 `/api/update/shell/Ghost.app.tar.gz`이며 Bearer 인증을 쓴다. HTTP 예외는 이 루프백 통신을 위한 것이며 프록시·리다이렉트·다른 다운로드 주소를 허용하지 않는다. 공개 키는 `src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 고정된다. iOS 패키지 프리뷰에는 업데이터를 포함하지 않는다.

## 검증

```sh
npm run check   # cargo fmt --check + cargo clippy --offline --all-targets -- -D warnings
npm test        # 셸·창 배치 테스트
```

격리 smoke는 임시 루트로 호스트를 띄운다(`GHOST_ROOT=$(mktemp -d) GHOST_PORT=0 GHOST_UI_DIR=<빌드된 ui 또는 임시 폴더> bun apps/ghost-host/src/main.ts serve`). 임시 `console.json`에 `{"root":"<임시 루트>"}`를 쓰고 `GHOST_CONSOLE_CONFIG`로 지정한 뒤 앱의 `Contents/MacOS/ghost-desktop --desktop-probe`를 실행한다. 프로브는 외부 호스트 발견과 health를 보고하며 호스트를 종료하지 않는다. 시험이 끝나면 해당 개발 호스트를 종료한다. 이 프로브는 화면 E2E 통과를 뜻하지 않는다.

릴리스 `Ghost.app`은 `scripts/release.ts`가 Developer ID로 서명한다. 공증은 하지 않는다. 업데이트는 Host를 거쳐 받으므로 격리 속성이 붙지 않는다. 앱 아이콘은 원형 Ghost(승인된 얼굴)와 파란 작업 호다. 원본 `src-tauri/brand-source/Ghost-round-macos.svg`를 1024px 투명 PNG로 렌더링하고 `npx tauri icon <png> -o src-tauri/icons`로 번들·Dock 아이콘을 만든다. 이전 아이콘 원본과 이력은 같은 폴더의 `provenance.json`에 있다.
