# Ghost 로컬 운영

## 구성

| 역할 | 진입점 |
| --- | --- |
| Host | `ghost serve` 한 프로세스. 상태 루트(`~/Library/Application Support/Ghost`)의 단일 writer이고 API·웹 UI·기기 연결을 같은 포트(기본 `127.0.0.1:62062`)에서 제공한다. |
| Mac 앱 | `~/Applications/Ghost.app`. `~/.config/ghost/console.json`의 `host_mode: external`이면 상태 루트의 `host.json`을 읽어 실행 중인 Host에 붙는다. `managed`이면 앱에 들어 있는 Host를 직접 띄운다. |
| iPhone | 페어링한 기기가 Host의 공개 origin(`publicOrigin`, TLS 리버스 프록시)으로 직접 접속한다. 별도 Gateway는 없다. |

## 개발 변경의 자동 운영 반영

소유자 상시 승인(2026-11-07): 검증한 Ghost 구현 변경은 별도 확인을 묻지 않고 같은 작업에서 운영 앱까지 반영한다. 빌드만 하거나 “운영 미반영” 상태로 개발 작업을 끝내지 않는다. 런타임에 영향 없는 문서 수정만 배포 대상에서 제외한다.

1. 해당 변경의 테스트·타입 검사·실행 검증과 필요한 독립 검토를 마치고 소스 커밋을 보존한다. 검증되지 않은 편집을 감시해 즉시 설치하는 watcher는 만들지 않는다.
2. LaunchAgent, 실제 실행 파일, 포트 62062의 리스너, 열린 DB 경로와 상태 루트가 일치하는지 확인한다. 처리 중 대화·작업을 임의로 끊지 않고 유휴 시점에 전환한다. 유휴가 되지 않으면 검증한 릴리스를 준비한 채 차단 사유를 보고한다.
3. 유휴 확인 후 `ghost backup <새 백업 디렉터리>`의 DB 무결성 확인·manifest와 백업 시각을 기록하고, `artifacts/`, `skills/`, `secrets/`, `config.json`도 권한을 유지해 보관한다. 이전 릴리스는 삭제하지 않는다.
4. `~/.local/share/ghost/releases/<날짜>-bun-<소스 커밋>/`에 검증한 `ghost`와 `ui/`를 설치하고 원본·사본의 해시를 비교한다. 별도 임시 상태 루트·포트에서 설치 사본도 실행해 본다.
5. 유휴 상태를 다시 확인한 뒤 같은 디렉터리의 임시 심볼릭 링크를 `os.replace` 같은 원자적 rename으로 `current`에 교체한다. 실제 `readlink` 대상이 새 릴리스인지 확인한 후 LaunchAgent의 기존 Host를 `SIGTERM`으로 정상 종료해 재기동한다. 운영 루트에 두 번째 Host를 직접 띄우지 않는다.
6. Owner API/health로 단일 리스너·실행 경로, 준비 상태와 기존 데이터 보존을 확인하고 **설치된 Ghost 앱**에서 바뀐 화면을 실제로 연다. 운영 루트에는 `ghost doctor`를 실행하지 않는다. Host/UI만 바뀌었으면 external 모드를 유지해 새 Host/UI를 사용하고, native shell 변경이 있을 때만 기존 서명·배포 검증을 거쳐 앱 번들을 교체한다.
7. 검증 실패 시 저장 형식의 하위 호환성을 확인한 뒤 이전 릴리스 링크로 되돌려 정상 재기동한다. 새 릴리스가 인증 형식을 바꾸면 운영 검증 중 인증 정보를 저장하지 않는다. 저장 이후에는 이전 릴리스가 해당 인증을 읽지 못할 수 있으므로 별도 승인 없이 secrets를 복원하지 않고 보고한다. 데이터 복원·파괴적 마이그레이션도 별도 승인이 필요하다. 설치 경로·소스·백업·검증 결과를 이 문서에 기록한다.

Git 원격 장애가 있어도 검증한 로컬 커밋의 운영 반영은 진행한다. 푸시 실패를 숨기거나 완료로 간주하지 않고 미전송 커밋과 원격 차단 사유를 따로 보고한다.

## 현재 설치 (2026-11-07)

| 항목 | 값 |
| --- | --- |
| LaunchAgent | `com.a7.ghost` → `~/Workspace/Projects/infra/scripts/ghost-run.sh` → `~/.local/bin/ghost serve` |
| 실행 파일 | `~/.local/bin/ghost` → `~/.local/share/ghost/current/ghost`, `current` → `releases/20261107-bun-f4f05fb` (UI는 같은 디렉터리의 `ui/`) |
| 상태 루트 | `~/Library/Application Support/Ghost` (`config.json`: 포트 62062, `publicOrigin` `https://macstudio.tail1d0d8d.ts.net:8443`, Apple container 샌드박스, Oxibrain) |
| 기기 origin | `tailscale serve`의 `:8443` → `127.0.0.1:62062` |
| Mac 앱 | `~/Applications/Ghost.app`(`f4f05fb` 셸·새 아이콘, 임시 서명), `console.json` = `{host_mode: external, root}` |
| 중지됨 | `com.a7.ghost-gateway`(disabled), 구형 worker LaunchAgent |
| 백업 | infra restic이 `ghost backup`(ghost-backup/2)으로 스냅숏을 만든다 |

모든 Ghost와 대화는 기본 모델(Z.AI `glm-5.3`)을 따르고, Oxibrain 기억은 `memory.spaces`의 `*` 항목(`pc-infra`)으로 모든 Ghost가 쓴다.

### Ghost 바리에이션·새 앱 아이콘 운영 반영 — 2026-11-07

- 소스 `f4f05fb`의 Host·UI를 `releases/20261107-bun-f4f05fb`에 설치했다. 계약에 선택 필드 `Look.shape`(round·egg·squircle·sheet)와 `LookMark` 여섯 값(crown·bow·ears·horns·headphones·glasses)이 추가됐다. DB 스키마는 그대로다. 컴파일 Host 바이트와 UI 85개 파일 해시가 빌드 원본과 일치한다. 설치 사본을 백업 DB 사본 위 임시 루트·포트에서 실행해, 꾸미기에서 모양 `유령`·장식 `헤드폰`을 고르면 `look`에 저장되는 것을 확인했다.
- Mac 앱을 새 아이콘(원형 Ghost와 파란 작업 호)으로 다시 빌드해 교체했다. 임시 서명, `codesign --verify --strict` 통과, 번들 `icon.icns`가 저장소 원본과 일치하고 Finder 아이콘도 새 모양이다. 이전 앱은 백업의 `Ghost.app`에 있다.
- 검사: Host 테스트 235개(모습 저장·거부 1개 추가)·타입 검사, UI 테스트 68개·타입 검사·빌드, 시각 회귀 28개(기준 갱신 후 재통과), iOS `swift test` 37개·시뮬레이터 빌드·밝게/어둡게 캡처. 독립 Codex 검토 결과 지적 사항 없음.
- 백업: `~/.local/share/ghost/backups/pre-variations-20261107-f4f05fb/`, `ghost-backup/2`, `complete: true`, 두 DB `integrity_check` ok, artifacts·secrets·config 복사·비교, 이전 앱 사본 서명 유효.
- 유휴 상태에서 `current`를 원자적으로 교체하고 Host를 정상 재기동했다(PID 55950 → 67594). 실행 파일·운영 DB·단일 리스너·준비 상태, Ghost 4·대화 9·맡긴 일 32·프로젝트 0, config·secrets 보존을 확인했다. 설치 앱에서 `--desktop-probe` health 후 의미 클릭으로 Ghost 대화 → 프로필 → 꾸미기를 열어 모양 4종과 새 장식이 보이는 것을 확인하고 닫았다. 운영 Ghost의 모습은 바꾸지 않았다.
- 되돌릴 때는 `current`를 `releases/20261107-bun-327d81b`로 교체하고 LaunchAgent를 정상 재시작한다. 새 값을 저장한 Ghost가 있으면 이전 Host가 그 `look`을 거부할 수 있으므로, 되돌리기 전에 해당 Ghost의 모양·장식을 기존 값으로 바꾼다.

### UI/UX 보완·폴더 선택 셸 운영 반영 — 2026-11-07

- 소스 `7fa4f8f`(iPhone 앱 리디자인, 대화 옆 스레드 패널, 보조 글자 대비 AA, 표시 전역 Ghost 색 제거, 홈 설정 카드, 생각 수준, 폴더 선택, 시각 회귀 테스트)와 후속 `327d81b`(끝난 스레드의 빈 작업 대화를 `기록 없음`으로 표시)의 UI를 `releases/20261107-bun-327d81b`에 설치했다. Host·계약은 `a7ef16e` 이후 바뀌지 않아 같은 컴파일 Host를 복사했다(바이트 일치). UI 85개 파일 해시가 빌드 원본과 일치한다. `7fa4f8f` 사본은 백업 DB 사본을 쓰는 임시 루트·포트에서 먼저 실행해 홈 설정 카드를 확인했다.
- Mac 셸을 교체했다. 메인 창에만 `allow-pick-folder` 권한을 주고 `pick_folder`가 `NSOpenPanel`을 창 시트(`beginSheetModalForWindow`)로 띄운다. 독립 검토가 지적한 `runModal` 중첩 실행 루프(종료 시 멈춤 위험)를 비차단 시트로 바꿨다. 새 앱은 임시 서명, `codesign --verify --strict` 통과. 이전 앱은 백업 디렉터리의 `Ghost.app`에 있다.
- 검사: UI 테스트 68개·타입 검사·빌드, Playwright 시각 회귀 28개(연속 3회 통과), Rust fmt·clippy·테스트 7개, iOS `swift test` 37개·시뮬레이터 빌드·UI 테스트 10개(실 Host 4개 생략). 독립 검토(UI: Codex, 셸: Claude)의 P2 다섯 건을 고쳤다.
- 백업: `~/.local/share/ghost/backups/pre-ux-gaps-20261107-7fa4f8f/`, `ghost-backup/2`, `complete: true`, `2026-11-07T13:51:54Z`, 두 DB `integrity_check` ok, artifacts·secrets·config 복사·비교, 이전 `Ghost.app` 사본 서명 유효.
- 유휴 상태에서 `current`를 두 번 원자적으로 교체하고 Host를 정상 재기동했다(PID 2704 → 55004 → 55950). 실행 파일·운영 DB·단일 리스너·준비 상태, Ghost 4·대화 9·맡긴 일 32·프로젝트 0, config·secrets 보존을 확인했다. 설치 앱에서 `--desktop-probe` health 후 접근성 의미 클릭으로 Ghost 대화 열기, 스레드 카드 → 스레드 패널 열기·닫기, 새 프로젝트 → 폴더 선택 시트 표시 → Cancel → 입력 다시 활성화를 확인했다. 운영 프로젝트는 만들지 않았다.
- 되돌릴 때는 `current`를 `releases/20261107-bun-a7ef16e`로 교체하고 LaunchAgent를 정상 재시작한다. 셸까지 되돌리려면 앱을 종료하고 백업의 `Ghost.app`으로 바꾼다. 저장 형식 변화는 없다.

### 지속 대화·추론 표시·원형 Ghost 운영 반영 — 2026-11-07

- 소스 `a7ef16e`의 Host와 UI를 `releases/20261107-bun-a7ef16e`에 설치했다. 계약에 선택 필드 `Message.thinking`·`Live.thinking`·`Look.face`·`Look.mark`가 추가됐고 Host가 추론 블록(가려진 블록 제외)을 전달한다. DB 스키마는 바뀌지 않는다. 컴파일 Host와 UI 85개 파일의 해시가 빌드 원본과 일치한다.
- Host 테스트 233개(추론 투영 2개 추가), UI 테스트 68개, 두 타입 검사가 통과했다. 모의 추론 스트리밍 제공자를 붙인 별도 Host에서 생각 중 표시·접힘, 스레드 카드·목록, 플로팅 프로필, 보낸 뒤 최신 따라가기, 입력창 테두리 윗변, 원형 Ghost·꾸미기, 프로젝트 만들기를 확인했다. 독립 Codex 검토의 P2 두 건(스크롤바 끌기 중 강제 이동, 도구 묶음 사이 스레드 위치)을 고쳤다. 백업 DB 사본을 새 릴리스로 임시 포트에서 열어 Ghost 4·대화 9·맡긴 일 32와 기존 메시지 7개의 추론 표시를 확인했다.
- 백업: `~/.local/share/ghost/backups/pre-durable-chat-20261107-a7ef16e/`, `ghost-backup/2`, `complete: true`, `2026-11-07T12:48:45Z`, 두 DB `integrity_check` ok, artifacts·secrets·config·console 설정 복사·비교.
- 유휴 상태에서 `current`를 원자적으로 교체하고 Host(PID 85405)를 정상 재기동했다. 새 PID 2704의 실행 파일·운영 DB·단일 리스너·준비 상태, Ghost 4·대화 9·맡긴 일 32, config·secrets 보존을 확인했다. Mac 앱을 외부 모드로 다시 실행해 `--desktop-probe` health와 창 캡처로 원형 Ghost가 적용된 화면을 확인했다. 앱 아이콘(네이티브 셸)은 바꾸지 않았다.
- 되돌릴 때는 `current`를 `releases/20261107-bun-64dd7b4`로 교체하고 LaunchAgent를 정상 재시작한다. 이전 Host는 새 선택 필드를 무시하므로 저장 데이터와 호환된다.

### 사이드바 Ghost 하위 메뉴 정리 운영 반영 — 2026-11-07

- 소스 `64dd7b4`의 UI를 `releases/20261107-bun-64dd7b4`에 설치했다. Host는 `f7ea509` 이후 변경이 없어 같은 컴파일 파일을 복사했고 SHA-256이 같다. UI 85개 파일 해시가 빌드 원본과 일치하고, 설치 사본을 임시 루트에서 실행해 새 번들(`main-DyYNiOyc.js`)과 health를 확인했다.
- UI 테스트 66개·타입 검사·빌드를 통과했다. 별도 Host 루트에서 제목이 같은 대화 3개로 사이드바(하위 메뉴 없음)와 헤더 대화 전환(기본 대화 고정, 시작 시각 이름)을 데스크톱·모바일 메뉴에서 확인했다.
- 백업: `~/.local/share/ghost/backups/pre-sidebar-roster-20261107-64dd7b4/`, `ghost-backup/2`, `complete: true`, `2026-11-07T12:22:34Z`, 두 DB `integrity_check` ok, artifacts·secrets·config·console 설정 복사·비교.
- 유휴 상태에서 `current`를 원자적으로 교체하고 Host(PID 67086)를 정상 재기동했다. 새 PID 85405의 실행 파일·운영 DB·단일 리스너·준비 상태와 Ghost 4개·대화 9개·맡긴 일 32개, config·secrets 보존을 확인했다. Mac 앱을 외부 모드로 다시 실행해 `--desktop-probe` health와 창 캡처로 새 사이드바를 확인했다. 되돌릴 때는 `current`를 `releases/20261107-bun-f7ea509`로 교체하고 LaunchAgent를 정상 재시작한다.

### 앱 전체 리디자인 운영 반영 — 2026-11-07

- 소스 `f7ea509`의 UI를 새 릴리스 `releases/20261107-bun-f7ea509`에 설치했다. `95ac4bc` 이후 Host·계약·데스크톱 소스 변경이 없어 컴파일 Host는 이전 릴리스 파일을 복사했고 SHA-256이 같다. UI 85개 파일의 해시가 빌드 원본과 일치한다. 설치 사본을 임시 루트·포트에서 실행해 새 번들(`main-BGd13iw2.js`)과 health를 확인했다.
- UI 테스트 66개·타입 검사·빌드를 통과했다. 별도 Host 루트(모의 OpenAI 호환 제공자로 실제 Host가 만든 위임 트리·질문·결과 확인·실패 일, 스트리밍)에서 홈·확인할 일·맡긴 일·상세·대화·설정·프로젝트를 1440/390px, 밝게·어둡게 확인하고 숫자 키 답변으로 실제 결정이 처리되는 것을 봤다. 콘솔 오류는 없었다.
- 백업: `~/.local/share/ghost/backups/pre-ui-redesign-20261107-f7ea509/`, DB는 `ghost-backup/2`, `complete: true`, 시각 `2026-11-07T12:12:42Z`, 두 DB `integrity_check` ok. artifacts·secrets·config·console 설정을 권한 유지로 복사·비교했다. 이전 릴리스 `20261107-bun-95ac4bc`는 보관했다.
- 처리 중 대화·작업이 없을 때 `current`를 원자적으로 교체하고 LaunchAgent Host(PID 9125)를 `SIGTERM`으로 재기동했다. 새 Host PID 67086의 실행 파일이 새 릴리스이고 운영 DB·포트 62062 단일 리스너·준비 상태를 확인했다. Ghost 4개·대화 9개·맡긴 일 32개, config·secrets 바이트가 보존됐다.
- 외부 모드의 Mac 앱을 정상 종료 후 백그라운드로 다시 실행했다. `--desktop-probe`가 새 Host PID의 external 연결·health를 확인했고, 설치된 앱 창을 백그라운드 캡처해 운영 데이터 위의 새 화면(존재 표시가 있는 사이드바, 새 대화 헤더·작성기)을 확인했다. 앱 번들은 바꾸지 않았다.
- 데이터·인증 저장 형식 변경은 없다. 되돌릴 때는 `current`를 `releases/20261107-bun-95ac4bc`로 원자적으로 교체하고 LaunchAgent를 정상 재시작한다.

### 인증 링크 브라우저 열기 수정 운영 반영 — 2026-11-07

- 소스 `95ac4bc`의 Host/UI와 Mac 앱을 설치했다. 외부 `target=_blank` 이동은 기존 웹뷰 정책에 막혔다. 이동 허용 범위를 넓히지 않고 main·overlay에 HTTP(S) 전용 `open_external_url` 권한을 부여했다. 인증·키 발급·대화 링크가 이 명령으로 macOS 기본 브라우저를 연다.
- Rust 테스트 7개·fmt·clippy, UI 테스트 66개·타입 검사·빌드를 통과했다. 별도 Host 루트의 실제 Mac 앱에서 `Button asChild`와 새 링크 컴포넌트를 활성화해 Safari의 HTTP 요청을 관찰했다. main·overlay 모두 위험한 URI 5종을 거부하고 잘못된 주소에는 오류를 표시했다. 일반 브라우저는 링크 기본 동작을 유지했다. 독립 Claude 검토에 차단 사항이 없었다.
- 기존 로컬 배포 방식인 ad-hoc 서명으로 앱을 서명하고, 서명된 설치 대기 사본에서도 같은 Safari 열기를 확인했다. 설치 전후 `codesign --verify --strict`가 통과했다. Developer ID 서명·공증 배포는 아니다. Host·UI 설치 사본은 원본 바이트와 일치하며 임시 루트에서 컴파일 Host와 실제 번들도 실행했다.
- 백업: `~/.local/share/ghost/backups/pre-browser-open-20261107-95ac4bc/`, DB는 `db/backup.json`의 `ghost-backup/2`, `complete: true`, 시각 `2026-11-07T11:12:30.673Z`. artifacts·secrets·config·console 설정을 복사하고 이전 Mac 앱은 `Ghost.app`으로 보존했다. 이전 Host/UI 릴리스 `20261107-bun-f1e1a64`도 보존했다.
- 유휴 확인 후 외부 모드의 기존 Mac 앱을 정상 종료하고 설치 번들을 교체했다. `current`를 원자적으로 교체한 뒤 LaunchAgent Host만 정상 재기동했다. 새 Host PID 9125의 실행 파일·운영 DB 경로·포트 62062 단일 리스너·준비 상태를 확인했다. Ghost 4개·대화 9개·맡긴 일 32개의 기존 ID, 설정과 인증 파일 바이트가 보존됐다.
- 설치된 앱을 백그라운드로 다시 실행했고 `--desktop-probe`가 새 Host에 대한 external 연결·health를 확인했다. 창이 목록에 나왔다가 접근되지 않아 운영 네이티브 화면의 직접 클릭은 검증하지 못했으며 강제로 앞으로 가져오지 않았다. 운영 웹 UI에서는 모델 설정·Codex 설정의 공식 키 발급 링크와 새 번들을 확인했다. 운영 인증 저장·로그인은 하지 않았고 검증용 앱·Host·스크립트·상태 루트를 정리했다.
- DB·인증 저장 형식 변경은 없다. 되돌릴 때는 `current`를 이전 릴리스로 교체하고 LaunchAgent를 정상 재시작하며, 앱 종료 후 이 백업의 `Ghost.app`을 설치 경로로 돌린다. secrets나 DB를 덮어쓸 필요는 없다.

### OAuth·제공자 설정 운영 반영 — 2026-11-07

- 검증한 소스 `f1e1a64`(OAuth `d5e84cd` 포함)의 Host/UI를 새 릴리스로 설치했다. 컴파일 Host SHA-256 일치와 UI 전체 바이트 일치를 확인하고 설치 사본도 임시 루트·포트에서 실행했다. 기존 Mac 셸은 external 모드로 유지했다.
- 백업: `~/.local/share/ghost/backups/pre-provider-settings-20261107-f1e1a64/`, `ghost-backup/2`, `complete: true`, DB 무결성 확인. 백업 시각은 `2026-11-07T10:30:43.768Z`. artifacts·secrets·config·console 설정도 권한을 유지해 복사·비교했다. 이 루트에는 별도 skills 디렉터리가 없었다. 이전 릴리스 `20261107-bun-74cd0fb`는 보관했다.
- 유휴 상태에서 링크를 원자적으로 교체하고 LaunchAgent를 정상 재기동했다. 새 실행 파일, 운영 DB 경로와 포트 62062의 단일 리스너를 확인했다. runtime 준비 상태, Ghost 4개·대화 8개·맡긴 일 32개와 제공자·모델 설정, 인증 파일 바이트가 보존됐다.
- 설치된 앱의 `--desktop-probe`가 새 Host PID의 external 연결과 health를 확인했다. 기존 native 프로세스의 Ghost webview는 한 번 관찰했으나 이후 백그라운드 창 목록에 없어 네이티브 설정 클릭은 추가 검증하지 못했다. 강제로 앞으로 가져오지 않았다. 운영 Host의 실제 웹 UI에서 새 제공자 선택 화면을 열어 6개 선택지와 새 번들을 확인했다. 운영 인증 저장·로그인은 실행하지 않았다.
- DB 스키마는 변경하지 않았다. 다만 이 릴리스가 새로 저장하는 인증은 이전 릴리스와 형식이 다르다. 이번 검증은 인증 파일을 변경하지 않았으므로 이전 링크로 되돌릴 수 있다. 이후 인증을 저장한 제공자는 이전 실행 파일에서 읽지 못할 수 있으므로 secrets를 자동 복원하지 않는다.

### 대화형 UI 설치 — 2026-11-07

- 검증한 소스 `74cd0fb`의 Bun 컴파일 Host와 UI를 새 릴리스에 복사하고 SHA-256 일치를 확인했다. 기존 Mac 앱은 external 모드 그대로 새 Host의 UI를 사용한다. 앱 셸 교체나 서명·공증 배포는 하지 않았다.
- 전환 전 백업: `~/.local/share/ghost/backups/pre-intelligent-ui-20261107-74cd0fb/` (`ghost-backup/2`, `complete: true`). 이전 릴리스: `releases/20261107-bun-33cfe04`.
- 처리 중 대화가 없을 때 `current` 링크를 원자적으로 교체하고 LaunchAgent에 `SIGTERM`을 보내 정상 종료·재기동했다. 포트 62062의 단일 Host, 모델 제공자 준비 상태, 기존 Ghost 4개와 맡긴 일 32개 보존을 확인했다.
- 설치된 Mac 앱의 새 채팅 화면을 확인하고, 별도 브라우저 세션에서 운영 모델의 `present_ui` 생성, 사과 2·배 3 차트/데이터 전환, 선택지의 일반 메시지 전송, sandbox·CSP가 적용된 정적 HTML을 확인했다. 검증 대화는 합성 데이터로 표시했다.
- 이 릴리스는 데이터 스키마를 변경하지 않는다. 되돌릴 때는 `current`를 이전 릴리스로 원자적으로 교체하고 같은 LaunchAgent를 정상 재시작한다. DB 복원이나 운영 상태 루트 교체는 필요하지 않다.

### 되돌리기

전환 전 상태와 설정은 `~/.local/share/ghost/backups/pre-bun-20261107/`에 있다(`state/`, `state.sha256`, `config-ghost/`, 이전 실행 링크, plist, `ghost-run.sh.previous`, `tailscale-serve.txt`, `import-report.json`). 이전 상태 루트는 `~/Library/Application Support/Ghost.pre-bun-20261107`에 그대로 있다.

1. `launchctl bootout gui/$UID/com.a7.ghost`, Mac 앱 종료.
2. 새 루트를 다른 이름으로 옮기고 `Ghost.pre-bun-20261107`을 `Ghost`로 되돌린다.
3. `~/.local/bin/ghost`를 `previous-ghost-link.txt`의 경로로, infra `scripts/ghost-run.sh`를 `ghost-run.sh.previous`로 되돌린다.
4. `tailscale serve --bg --https=8443 http://127.0.0.1:8788`, `launchctl enable`/`bootstrap` `com.a7.ghost-gateway`.
5. `~/Applications/Ghost.previous-20261107.app`을 `Ghost.app`으로, `config-ghost/console.json`을 `~/.config/ghost/`로 되돌린 뒤 `com.a7.ghost`를 다시 띄운다.

전환 뒤에 생긴 대화·맡긴 일은 이전 Host로 옮겨지지 않는다.

원장 마이그레이션 2(개인정보 등급·로컬 제공자 제거) 직전 상태는 `~/.local/share/ghost/backups/pre-noprivacy-20261107/`(`ghost-backup/2`, 이전 `config.json`)에 있다. 마이그레이션은 되돌리지 않으므로 그 시점으로 돌아가려면 이 백업의 `ledger.db`·`pi.db`와 그 무렵 실행 파일을 함께 복원한다.

상태 루트:

```
ledger.db   pi.db   host.json (0600)   config.json (선택)
artifacts/sha256/…   skills/…   secrets/<provider>.json (0600)   sandboxes/<ghost>/<work>/workspace
```

`config.json`은 `publicOrigin`, `uiDir`, `sandbox`(`local` 또는 `apple-container`), `memory`(Oxibrain; `spaces`는 Ghost id → space, `*`는 나머지 모든 Ghost), `apns`를 담는다. 환경 변수는 `GHOST_ROOT`, `GHOST_PORT`, `GHOST_HOST`, `GHOST_PUBLIC_ORIGIN`, `GHOST_UI_DIR`만 읽는다.

## 확인

```sh
curl -fsS http://127.0.0.1:62062/api/health
```

실행 중 Host의 준비 상태는 인증된 `GET /api/state`로 확인한다. `ghost doctor`는 DB와 엔진을 열기 때문에 운영 루트에 쓰지 않는다. 필요하면 별도 임시 상태 루트에만 실행한다.

## 제공자 설정

웹·Mac UI에서 **설정 → 모델 → 제공자 추가**를 열고 OpenAI, Anthropic, Google Gemini, Z.AI Coding Plan, MiniMax 또는 OpenAI 호환 서버를 선택한다. 구현 변경은 위의 자동 운영 반영 절차로 설치한다.

- 기본 이름·ID·주소와 추천 모델을 채워 준다. API 키를 입력하고 사용할 모델을 검색해 선택한다. **API 키 발급**은 각 제공자의 공식 키 관리 페이지를 연다.
- 모델 목록은 설치된 pi-ai SDK의 정적 목록이지 계정에서 조회한 허용 목록이 아니다. 다른 모델은 **모델 ID 직접 추가**에서 등록한다. OpenAI 호환 서버는 주소와 모델을 직접 지정한다.
- **고급 설정**에서 이름·내부 ID·API 형식·서버 주소를 바꾼다. 기존 ID는 고정이며, 같은 제공자를 추가하면 새 ID를 배정한다. API 형식을 바꿀 때는 새 API 키를 입력하거나 기존 인증 정보를 명시적으로 삭제한다.
- 기존 제공자를 저장할 때 API 키를 비워 두면 저장된 인증을 유지한다. 기존 사용자 모델의 이름·컨텍스트·추론 정보도 기본 목록으로 덮어쓰지 않는다.
- 저장 후 **기본 모델** 또는 Ghost별 모델을 선택한다. 인증 상태 표시는 키/OAuth의 저장 여부이며 실제 모델 호출 성공을 뜻하지 않는다.

설정 흐름은 [OpenCode의 제공자 선택·인증·모델 선택](https://github.com/anomalyco/opencode/blob/21bf6b493b76efcf3769ade999f05163760d61af/packages/app/src/settings/providers/providers.tsx)과 [Cherry Studio의 기본 주소·모델 목록](https://docs.cherryai.com.cn/docs/en-us/pre-basic/providers/openrouter.md)을 참고했다. 외부 앱의 코드나 시각 자산은 복사하지 않았다.

## OpenAI OAuth

**설정 → 모델 → 제공자 추가 → OpenAI**에서 **ChatGPT 구독**을 선택하고 사용할 모델을 고른 뒤 **ChatGPT로 로그인**을 누른다. 서버 주소는 비워 둔다. 표시된 코드를 **인증 페이지 열기**에서 입력하고 승인한다. 계정에서 기기 코드 로그인을 허용해야 한다.

Mac 앱의 **인증 페이지 열기**·**API 키 발급**과 대화의 웹 링크는 기본 브라우저로 연다. 웹뷰의 Host 전용 이동 제한은 유지하며, 네이티브 명령은 HTTP(S) 주소만 허용한다. 열기에 실패하면 링크 옆에 오류를 표시하고 다시 누를 수 있다. 일반 웹 브라우저의 링크 동작은 바꾸지 않는다.

로그인 완료 후 기본 모델 또는 Ghost의 모델로 해당 제공자를 선택한다. ChatGPT OAuth는 Codex 경로를 사용하며 일반 OpenAI API 키와 별개다. 지원 모델·구독·조직 정책은 해당 계정의 허용 범위를 따른다.

인증 정보는 Host의 `secrets/<provider>.json`에만 저장한다(0600). 만료 전 자동 갱신하며 새로고침 토큰도 원자적으로 교체한다. 로그인 취소는 기존 인증 정보를 유지한다. 로그아웃은 제공자 설정의 **고급 설정 → 저장된 인증 정보 삭제**를 선택한 뒤 저장한다. API 키로 전환하려면 인증 방법을 **API 키**로 바꾸고 새 키를 입력해 저장한다. Host를 재시작하면 미완료 로그인만 다시 시작해야 한다.

## 백업

`ghost backup <빈 디렉터리>`는 실행 중에도 `ledger.db`와 `pi.db`의 일관된 사본을 만든다(SQLite `VACUUM INTO`). `artifacts/`, `skills/`, `secrets/`는 파일 복사로 함께 보관한다. 백업은 Host를 멈추거나 전역 잠금을 잡지 않는다.

## 개발 Host

개발과 검증은 항상 임시 상태 루트와 별도 포트를 쓴다.

```sh
GHOST_ROOT=$(mktemp -d) GHOST_PORT=0 bun apps/ghost-host/src/main.ts serve
```

종료할 때 띄운 Host, UI 개발 서버, 앱을 함께 닫는다.

## 이전 Host에서 옮기기

Bun Host는 이전 Rust Host의 상태 루트를 읽지 않는다. 옮길 때는 다음 순서를 따른다. 실제 운영 전환은 소유자 승인 후 별도로 진행한다.

1. 이전 Host(`com.a7.ghost`)에 실행 중인 업무가 없는지 확인하고 멈춘다.
2. 이전 상태 루트 전체를 보관 위치로 복사한다.
3. 새 상태 루트를 만들고 `ghost import --from <이전 루트> --root <새 루트> --artifacts ~/.local/state/ghost/w/e --artifacts ~/.local/state/ghost/w/o --artifacts ~/.local/state/ghost/w/p --artifacts ~/.local/state/ghost/w/r`를 실행한다. `--artifacts`는 이전 작업자 저널의 산출물 위치다. 이전 루트와 저널은 읽기만 한다. 출력의 `skipped`가 옮기지 않은 항목과 이유다. 가져온 맡긴 일은 이미 보고된 기록으로 들어가 다시 알리지 않는다.
4. 새 루트로 `ghost serve`를 띄우고 Ghost·대화·맡긴 일이 보이는지 확인한다.
5. iPhone은 다시 페어링한다(이전 기기 토큰은 옮기지 않는다).
6. LaunchAgent를 새 실행 파일과 새 루트로 바꾼다. 되돌릴 때는 이전 실행 파일과 이전 루트로 LaunchAgent를 복구한다.
