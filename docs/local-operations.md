# Ghost 로컬 운영

## 구성

| 역할 | 진입점 |
| --- | --- |
| Host | `ghost serve` 한 프로세스. 상태 루트(`~/Library/Application Support/Ghost`)의 단일 writer이고 API·웹 UI·기기 연결을 같은 포트(기본 `127.0.0.1:62062`)에서 제공한다. LaunchAgent `com.a7.ghost`가 `ghost service install`이 만든 `~/.local/share/ghost/bin/ghost-launch`로 띄운다. |
| Mac 앱 | `~/Applications/Ghost.app`. 상태 루트의 `host.json`을 읽어 실행 중인 Host에 붙기만 한다. Host를 띄우거나 끄지 않는다. `~/.config/ghost/console.json`은 `root`만 읽는다. |
| iPhone | 페어링한 기기가 Host의 공개 origin(`publicOrigin`, TLS 리버스 프록시)으로 직접 접속한다. 별도 Gateway는 없다. |

## 개발 변경의 자동 운영 반영

소유자 상시 승인(2026-11-07): 검증한 Ghost 구현 변경은 별도 확인을 묻지 않고 같은 작업에서 운영 앱까지 반영한다. 빌드만 하거나 “운영 미반영” 상태로 개발 작업을 끝내지 않는다. 런타임에 영향 없는 문서 수정만 배포 대상에서 제외한다. 2026-11-10부터 반영은 GitHub Release와 Host 자체 업데이트로 한다.

1. 해당 변경의 테스트·타입 검사·실행 검증과 필요한 독립 검토를 마치고 `main`에 커밋한다. 검증되지 않은 편집을 감시해 즉시 설치하는 watcher는 만들지 않는다.
2. `apps/ghost-host/package.json`의 `version`을 올린다. 네이티브 셸(`apps/ghost-desktop/src-tauri`)이 바뀐 때만 `tauri.conf.json`·`Cargo.toml` 버전도 올리고, iPhone 네이티브(`apps/ghost-ios`)가 바뀐 때만 `project.yml`·`project.pbxproj`의 `CURRENT_PROJECT_VERSION`을 올린다. 커밋한다.
3. 깨끗한 작업 트리에서 `bun scripts/release.ts --publish`. 검사(Host·계약 타입, Host·UI 테스트, 셸 `cargo test`)를 통과해야 빌드한다. Developer ID로 `ghost`와 `Ghost.app`에 서명하고, iPhone 앱은 팀 개발 프로필로 서명한 `Ghost.ipa`로 만든다(등록된 기기만 설치, push 권한 없음). `~/.tauri/ghost.key`로 셸 번들과 `ghost-release.json`에 서명해 `v<version>` 태그와 Release를 올린다. 키를 잃으면 설치된 Host와 앱이 더는 업데이트를 받지 못한다.
4. 설치는 Ghost 앱의 설정 › 업데이트 「설치」 또는 Owner API(`host.json`의 토큰)로 `POST /api/update/check` 뒤 `POST /api/update/install {"version"}`. Host가 받은 묶음의 해시·파일·`ghost version`을 확인해 `releases/<version>-<commit>`에 두고, 진행 중 대화·실행이 없을 때 `backups/pre-<version>-<commit>-<ms>/`에 백업한 뒤 `current`를 원자 교체하고 정상 종료한다. launchd가 새 릴리스를 띄운다. 유휴가 오지 않으면 `waiting`에 머문다. 끊지 말고 차단 사유로 보고하고, 필요하면 `POST /api/update/cancel`.
5. `GET /api/update`의 `lastResult`가 `installed`인지, health 버전·준비 상태·기존 Ghost·대화·맡긴 일 보존을 Owner API로 확인한다. 운영 루트에는 `ghost doctor`를 실행하지 않는다. **설치된 Ghost 앱**에서 바뀐 화면을 실제로 연다. 셸 버전을 올린 릴리스는 같은 화면의 「앱 업데이트」로 앱을 바꾸고 다시 연 뒤 확인한다. iPhone 빌드를 올린 릴리스는 iPhone 앱의 「앱 업데이트」(이전 셸이면 Mac 설정 › 업데이트 › iPhone 앱의 QR 코드)로 설치하고, 설치 확인은 iPhone에서 소유자가 누른다.
6. 새 Host가 세 번 연속 뜨지 못하면 launcher가 저장 형식 지문이 같은 경우에만 이전 릴리스로 되돌리고 `rolled_back`을 남긴다. 지문이 다르면 `failed`로 남기고 되돌리지 않는다. 데이터 복원·파괴적 마이그레이션·secrets 복원은 별도 승인이 필요하다. 수동으로 되돌릴 때는 `current`를 이전 릴리스로 바꾸고 `launchctl kickstart -k gui/$(id -u)/com.a7.ghost`. 버전·백업·검증 결과를 이 문서에 기록한다.

브랜치 푸시가 실패해도 Release를 올릴 수 있으면 운영 반영은 진행한다. 푸시 실패를 숨기거나 완료로 간주하지 않고 미전송 커밋과 원격 차단 사유를 따로 보고한다. GitHub에 Release를 올릴 수 없으면 `dist/release/<version>/`에 검증한 묶음을 보존하고 차단 사유를 보고한다.

### 브라우저·메일·문자 연결

- 대화의 **브라우저 화면**은 Mac·iPhone에서 같은 세션을 표시한다. Obscura 화면에서 처음 조작하면 안전한 Chrome으로 전환하고 그 첫 입력은 재생하지 않는다. 새 화면에서 다시 선택한다. `browser_handoff`는 전환 후 질문을 띄운다. **Mac 창으로 열기**는 실제 Chrome 창이며, CAPTCHA·패스키는 소유자가 처리한다. Obscura에서 쿠키·URL·화면 크기만 옮기고 DOM·localStorage는 옮기지 않는다.
- **메일 → 메일 계정 연결**에서 공용 연결 설정을 연다. Gmail·iCloud·Naver·Daum 프리셋이나 직접 IMAP/SMTP, 등록한 Outlook OAuth2를 지원한다. IMAP은 TLS, SMTP는 465 암시적 TLS 또는 587 STARTTLS다. Gmail·iCloud는 제공자 앱 비밀번호가 필요하다. 기존 Google OAuth 연결은 계정 식별·Drive용이지 Gmail 메일 권한이 아니다. 주 계정 비밀번호나 임의 OAuth 클라이언트로 우회하지 않는다.
- 메일 쓰기·답장·전달은 소유자가 앱에서 직접 보낸다. Ghost의 메일 도구는 별도 허용이며, `mail_send`는 수신인·제목·본문 전체 승인 뒤 전송한다. 전송 결과가 불명확하면 같은 요청의 상태만 확인하고 새 요청으로 재발송하지 않는다. 전송 뒤 목록을 다시 읽으며, **메일 새로고침**으로 이후 도착한 메일을 확인할 수 있다.
- `host_message_codes`는 Mac 도구 허용에 더해 실행 중인 Host의 **전체 디스크 접근 권한**이 필요하다. iPhone의 SMS를 받으려면 같은 Apple 계정의 Mac으로 **문자 메시지 전달**을 켠다. Messages DB는 읽기 전용이며, 권한을 우회하거나 DB/WAL을 따로 복사해 읽지 않는다.
- 카드·이름·전화·주소·상세주소·우편번호는 **금고**에 저장한다. 카드 채우기는 사이트·금액·끝 네 자리·입력 항목을 묶어서 승인하고, 구매 버튼은 별도로 승인한다. 새 연락처 필드 보존을 위해 저장 지문에 `/browser-vault-2`를 넣으므로 이전 지문으로의 자동 롤백은 하지 않는다.
- 자동 로그인 저장은 페이지의 필드 표기만 믿지 않는다. 카드 번호처럼 보이는 12–19자리 값은 로그인 정보로 저장하지 않고, 3–8자리 숫자형 비밀번호는 CVC·인증번호와 구분할 수 없어 제외한다. 실제 숫자 ID·PIN은 **금고**의 보안 양식에 직접 저장한다. 카드 입력 뒤에는 모델 스크린샷 차단과 숫자 형식 변경 마스킹을 유지한다.

Obscura를 켤 때는 운영 설정의 기존 `browser` 항목에
`"obscura": {"executable": "~/.local/share/ghost/current/obscura", "loginOrigins": []}`를
추가한다. `loginOrigins`에는 검증한 로그인 주소의 정확한 HTTPS origin만 넣는다.
운영 전에는 설치 사본의 절대 경로를 `GHOST_TEST_OBSCURA`와
`GHOST_TEST_AGENT_BROWSER`에 넣어 `bun test apps/ghost-host/test/browser.test.ts`를 실행한다.

PC 조작은 릴리스의 `Ghost Control.app`·`agent-desktop` 1.2.0·Geist 0.5.0을 자동 감지한다. 끄려면 `config.json`에 `"desktop": null`을 넣는다. 개발 사본은 `"desktop": {"control": "/절대경로/Ghost Control.app", "agentDesktop": "/절대경로/agent-desktop", "geist": "/절대경로/geist"}`로 지정한다. `stage-desktop.sh`는 Geist 저장소의 고정 커밋 `f6254cc`만 빌드하며 미커밋 편집은 포함하지 않는다(`GEIST_REPO`로 저장소 위치 지정).

처음에는 설치된 `Ghost Control.app/Contents/MacOS/ghost-control permissions --request`를 실행하고 시스템 설정에서 **Ghost Control**의 손쉬운 사용과 화면 기록을 승인한다. 앱은 권한 확인 전에 LaunchServices에 등록된다. 등록이 없으면 macOS가 승인을 저장하고도 설정 목록에서 숨기는 `kLSApplicationNotFoundErr`가 발생한다. 같은 번들 ID·Developer ID로 다시 빌드한 사본과 별도 launchd 작업에서 두 권한이 유지되는 것을 확인했다. 테스트용 ad-hoc 빌드는 별도 번들 ID를 써서 운영 권한을 덮어쓰지 않는다.

Ghost 설정에서 **PC 조작** 도구와 **PC 직접 실행**을 함께 허용해야 한다. 화면과 입력은 실제 로그인한 사용자의 앱에 적용된다. 구조 읽기·일반 입력은 agent-desktop의 접근성 조작, 캔버스·좌표 입력은 Geist의 전경 조작이다. `desktop_press`는 앱 대상 키 입력이며 의미 기반 전달을 보장하지 않는다. 다른 Space의 창을 강제로 앞으로 가져오지 않는다. 물리 입력은 사용자의 포인터·키보드를 공유한다. 비밀번호·카드 입력은 브라우저 금고 경로를 쓴다.

Geist worker의 IPC는 실행 파일 identity를 기준으로 나뉘므로 Host마다 `<root>/desktop/runtime/geist-*`에 전용 실행 파일을 APFS clone으로 만든다. 정상 종료가 확인되면 해당 사본을 제거한다. 강제 종료나 정리 실패 뒤에는 복구를 위해 보존하고, 다음 헬퍼는 새 사본을 쓴다.

PC 통합 검증(2026-11-10): 전용 임시 창에서 Host 도구 → 효과 원장 → 서명 헬퍼 → agent-desktop/Geist 경로로 한글 값 채우기, 체크박스 변경, 화면 JPEG와 좌표 클릭 결과를 재관찰했다. Geist의 실제 키보드 한글 입력도 확인했다. 격리 Host가 제공하는 설정 화면에서 **PC 조작 16/16**과 **PC 직접 실행** 저장을 Owner API로 확인했다. PC 검사 20개·100개 단언과 타입 검사를 통과했다. 독립 검토의 출력 파이프 정리 제한·종료 단축키 일관성·다른 Space 창 거부를 반영했다. 물리 클릭은 전달 성공만으로 앱 반영을 단정하지 않는다. 시험 창은 첫 클릭이 활성화만 한 경우가 있어, 명시적 창 포커스 뒤 새 화면에서 클릭하고 결과를 확인했다.


## 현재 설치 (2026-11-10)

| 항목 | 값 |
| --- | --- |
| LaunchAgent | `com.a7.ghost`(`ghost service install`이 씀) → `~/.local/share/ghost/bin/ghost-launch`(업데이트 롤백 가드, `GHOST_SERVICE=launchd`) → `~/.local/share/ghost/current/ghost serve`. infra `scripts/ghost-run.sh`는 더 쓰지 않는다 |
| 실행 파일 | `~/.local/bin/ghost` → `~/.local/share/ghost/current/ghost`, `current` → `releases/2.4.6-189b707`(GitHub Release `v2.4.6`, Developer ID 서명, `agent-browser` 0.41.2·Obscura 0.2.6 포함, iPhone `Ghost.ipa` 0.1.0 (9) 동봉). 업데이트 토큰 `secrets/update-github.json`, 상태 `update/` |
| 상태 루트 | `~/Library/Application Support/Ghost` (`config.json`: 포트 62062, `publicOrigin` `https://macstudio.tail1d0d8d.ts.net:8443`, Apple container 샌드박스, Oxibrain, `reach`(`~/.local/bin/agent-reach`), `browser`(`~/.local/share/ghost/current/agent-browser`), `skills.roots` `~/.agents/skills`, `mac.roots` `~/Workspace/Projects` + `mac.watch`(Mac 관리 Ghost, 5분)). 금고 `vault/`(0700, key 0600), 브라우저 상태 `browser/` |
| 기기 origin | `tailscale serve`의 `:8443` → `127.0.0.1:62062` |
| Mac 앱 | `~/Applications/Ghost.app` 0.2.2(Developer ID 서명, 공증 없음, Host를 거친 자체 업데이트), `console.json`은 `root`만 읽는다(남은 `host_mode` 키는 무시). 데스크톱 아바타 상태·위치는 `~/.config/ghost/companion.json` |
| 중지됨 | `com.a7.ghost-gateway`(disabled), 구형 worker LaunchAgent, `dev.garden.macfra.agent`(2026-11-08 Ghost `Mac 관리`로 이전, disabled) |
| 백업 | infra restic이 `ghost backup`(ghost-backup/2)으로 스냅숏을 만든다 |

Ghost별 모델·대체 모델·스킬·도구는 아래 "Ghost 팀 상시 작업 설정"을 따른다. 기본 모델은 MiniMax `MiniMax-M3.1-Flash`이고, Oxibrain 기억은 `memory.spaces`의 `*` 항목(`pc-infra`)으로 모든 Ghost가 쓴다.

### 브라우저·금고·메일 격리 검증 — 2026-11-11

- 운영과 다른 상태 루트·포트를 사용했다. Obscura의 1280×720 JPEG 스트림, 인증 없는 요청의 401, 정적 페이지에 재접속한 클라이언트의 프레임 수신을 확인했다. 한글 폰트를 제공해 로그인 화면의 한글도 실제 이미지에서 확인했다.
- 실제 Chrome에서 `browser_fill_card` → 소유자 승인 → 번호·월·연도·CVC·소유자명 채우기를 확인했다. 승인 전에는 모든 입력란이 비었고 구매 버튼은 누르지 않았다. 카드 번호는 승인·효과 원장과 SQLite 평문에 없었다. 허용한 Ghost의 실제 `vault_list` → `browser_fill`로 이름·전화·이메일·주소·상세주소·우편번호 여섯 값을 정확히 채우고, 허용하지 않은 Ghost의 비공개와 다시 열기 뒤 보존도 확인했다.
- 카드 유효기간 `12` 마스킹이 요소 ID `e12`까지 바꾸는 연동 결함을 수정했다. 원문 전체의 비밀 매칭과 렌더러가 기록한 UTF-16 구조 범위를 분리해 실제 참조·중첩 위치는 보존하고, 페이지가 위조한 참조 모양은 예외로 취급하지 않는다. 잘못된 선택자의 예외 객체를 요소로 사용하던 native 경로도 입력 전에 거부한다. 카드 승인 뒤 같은 문서의 폼 교체·여섯 연락처 입력, 분리/초점 전환 거부, iframe·열린/닫힌 중첩 shadow·contenteditable 입력을 실제 Chrome에서 확인했다. 고정 소스와 실제 dashboard의 빌드, attribution Rust 회귀 2개도 통과했다.
- 실제 TLS IMAP/SMTP 시험 서버에서 한글 본문·첨부·읽음/안읽음·보관·휴지통·보낸편지함 사본을 확인했다. 앱에서 답장의 제목을 고치고 숨은참조를 넣어 한 번 전송했으며, 받은 메일과 보낸편지함에서 그 제목을 확인했다. 전송 뒤 목록 새로고침과 별도 **메일 새로고침**을 제공한다. 시험 CA는 시험 프로세스에만 전달했고 전역 신뢰 설정은 바꾸지 않았다.
- 실제 메일 도구 경로에서도 읽기는 Seen을 바꾸지 않았고, 전체 본문·숨은참조가 담긴 승인 전에는 SMTP 전송이 없었다. 승인 뒤 실제 도착과 완료 효과를 확인했고, 승인 전 메일 도구를 철회하면 전송이 거부됐다. 모델은 호출하지 않은 격리 Core에서 도구·승인·원장·실제 서버를 연결한 검증이다.
- SMTP 587 STARTTLS의 실제 암호화 소켓에서 업그레이드 뒤 AUTH와 DATA 1회 전송을 확인했다. TLS 미지원·거절·협상 실패·신뢰하지 않은 인증서·호스트명 불일치는 AUTH/DATA와 승인 뒤 쓰기 콜백을 실행하지 않았다(프로토콜 회귀 8개 통과). Nodemailer의 초기 연결 옵션이 아니라 업그레이드 후 `secure` 상태를 확인한다.
- HTML 메일은 meta refresh·base·link를 제거한 뒤 신뢰한 CSP와 빈 sandbox를 적용한다. 실제 Chrome과 WebKit 27.2에서 원격 이미지·iframe·stylesheet·preload·preconnect·CSS import가 든 메일을 열어 자동 HTTP 요청과 탐색이 없고, 본문·작성한 스타일·일반 텍스트 기본 표시가 유지되는 것을 확인했다. 전송 응답 유실 때 같은 요청만 조회하는 흐름과 검증 거절 뒤 초안 보존도 통과했다.
- 실제 Chrome에서 393×852·`maxTouchPoints=5`·`pointer: coarse`인 전화 UI의 터치 초안 입력·글자 보내기·Enter로 시험 로그인 폼을 완료했다. 필드 선택은 의미 기반 Owner 키 API를 썼다. 정확한 HTTPS origin·사용자명·`hasPassword`만 있는 금고 메타데이터를 확인했고, 1280×900 데스크톱 패널도 새 크기와 일치하는 디코드 프레임을 기다린 뒤 화면을 검사했다. 지연된 메타데이터 캡처 뒤 새 프레임 요청과 입력 거절 뒤 재접속은 입력을 재생하지 않는다.
- Chrome 자체 CSS viewport JPEG는 530×480 → 356×700 → 980×520 크기를 독립 디코더로 확인했다. 1920×1200의 1 MiB 초과 JPEG도 전달됐고 정적 화면 4초에 2프레임으로 캡처 피드백 반복이 없었다.
- 실제 Google·iCloud 계정 연결, 실제 CAPTCHA 통과, 실물 iPhone 키보드·네이티브 셸 입력을 검증한 것은 아니다.
- Messages는 macOS가 실제 DB 접근을 거부해 실제 문자 수신을 검증하지 못했다. 코드 추출은 NSArchiver 한글/영문 fixture·라이브 WAL·일반 SMS 제외 검사로 확인했다. 전체 디스크 접근과 iPhone 문자 전달은 소유자 설정이 필요하다.

### 팀 생성·환경 적응·도구 실패 수정 — 2026-11-10

- 운영 Pi 기록을 읽기 전용으로 분석한 시점의 오늘 도구 호출은 9,629건, 오류는 3,026건이었다. 승인 대기 효과가 같은 대화의 모든 쓰기를 막은 오류가 1,420건(22개 대화), 산출물 경로 추측이 648건, `host_read` 12KB 제한이 141건이었다. 오늘 생성된 맡긴 일은 완료 38·실패 42·취소 17개였고 실패 중 31개가 마감 초과였다. 하나의 Mac 읽기 작업은 `tail -n +61` 승인 때문에 샌드박스 쓰기를 965번 거절당했다. 별도로 일반 Markdown 문서의 본문이 빈 문자열로 반환되는 실제 버그를 확인했다.
- 메인은 `ghost_create`로 역할에 맞는 Ghost를 만들고 팀원의 설정을 고친다. 각 Ghost는 `self_adapt`로 페르소나와 분리된 환경 메모를 유지하고, 부족한 도구·PC 실행은 `capability_request`로 요청한다. 메모는 설정의 **환경 적응**에서 편집·되돌리기 가능하다. Mac 권한은 시간이 지나도 자동 허용되지 않으며, 거절 문장을 허용으로 읽거나 답변 재전송이 소유자의 후속 철회를 되돌리지 않도록 회귀 검사를 넣었다.
- 승인만 기다리는 제안은 다른 효과를 막지 않고, 완료할 때 사용하지 않은 제안은 철회한다. 읽기 명령의 정상 argv, 프로젝트 `data/` 같은 일반 경로, 큰 파일의 줄 페이지를 지원한다. 비밀·개인 경로·상태 루트·재귀 grep의 비밀 파일 제외는 유지한다. `tail -c` 바이트 조각 읽기는 비밀 탐지를 피해갈 수 있어 자동 실행하지 않는다. 문서 참조의 이름·경로 차이를 해석하고, 산출물·웹 오류에 실제 다음 경로를 제시한다.
- 격리 상태 루트·포트 62287의 실제 GLM Flash: 메인이 `배포 확인` Ghost를 만들고 검사·메모 수정, 팀원의 권한 요청→메인 거절→재요청→소유자 허용→같은 대화의 `self_adapt` 성공을 확인했다. 실제 명령 실행은 하지 않았다. 같은 Host의 웹 UI에서 메모 저장→재로드 후 보존→되돌리기를 확인했다. 시험 Host·브라우저·자격 사본은 제거했다.
- 독립 검토의 실제 응답 메타데이터: 메인·권한·환경 적응(Claude 작성)은 Codex, Host 가드·승인(Core, Codex 작성)은 Claude Sonnet이 조사하고 GLM이 최종 지적을 전달했으며 메인이 각 지적을 확인했다. 문서·오류 경로(GLM 작성)는 지정 역할 대신 실제로 실행된 Codex가 검토했다. 거절 해석·철회 뒤 재부여·다른 대화의 요청 대기 누락, 미해결 효과 대사 뒤 대기 고착, grep 구분자, 문서 ID 충돌·범위 밖 경로·다른 큰 파일의 영향 등 확정 지적을 고쳤다. 관련 Host 검사 194 통과·3 생략, UI 타입·빌드와 관련 단위 검사 17 통과, 팀 화면 8개 시각 검사와 관련 기준 이미지 12개 갱신을 확인했다.
- 릴리스 검사: Host 733 통과·9 생략, UI 182 통과, Rust 21 통과, 타입·빌드·Developer ID 서명 및 매니페스트 검증 통과. 첫 패키징은 새 worktree의 Tauri CLI 부재로 멈춰 의존성을 설치했다. 재실행 때 드러난 기존 검사 비결정성(메인 Ghost의 무작위 첫 wake가 다른 Ghost의 제출 hook을 호출, 실제 launcher 자식 프로세스 4회에 5초 한도)을 격리·수정한 뒤 전체 검사를 통과했다. 네이티브 셸은 기존 0.2.2이며 공증은 기존 릴리스와 같이 생략했다.
- 배포: [v2.3.0](https://github.com/a7garden/ghost/releases/tag/v2.3.0), 소스 `db54109`, `main` 통합·GitHub/Gitea 일반 푸시 완료. 유휴와 PID 86925·62062 리스너·운영 DB 루트를 확인한 뒤 Owner API 자체 업데이트로 2.2.1 → 2.3.0을 설치했다(81초, 백업 `backups/pre-2.3.0-db54109-1794318201083/`). `lastResult: installed`, 새 PID 3573, health 2.3.0·runtime ready, 설치 실행 파일의 `codesign --verify --strict` 통과. 설치 직전 Ghost 26·대화 207·맡긴 일 154와 모든 대기 결정 id를 보존했다. 결정 snapshot은 최근 100개 완료 항목과 대기를 합친 유한 목록이라, 해소된 요청 때문에 오래된 완료 항목 3개가 snapshot 밖으로 이동했다.
- 설치된 Mac 앱을 비활성 실행했으나 관측한 창은 접근 직전 사라져 네이티브 입력 검증은 못 했다(강제 전면 이동 없음). 운영 Host가 제공하는 실제 설정 화면의 **역할 지시 → 환경 적응 → 스킬** 배치를 열어 확인했고 콘솔 오류가 없었다. 운영 설정을 검증용으로 저장하지 않았다. 되돌리기는 유휴에서 이전 `releases/2.2.1-4d63665`를 사용한다. 저장 형식은 동일하며 새 환경 메모 설정은 이전 Host가 무시한다.

### ScrollRail 통일 — 2026-11-10

- `v2.2.1`(`4d63665`)을 GitHub Release로 게시하고 Owner API 자체 업데이트로 2.2.0 → 2.2.1을 설치했다. `lastResult: installed`, health 2.2.1, runtime ready. Ghost 25·대화 206·맡긴 일 154의 기존 id를 모두 보존했다. 저장 형식과 Mac/iPhone 셸 버전은 바뀌지 않았다. Developer ID 서명 검증 통과, 공증은 기존과 같이 생략했다.
- 마우스·트랙패드의 기본 스크롤바를 숨기고 기존 ScrollRail을 나머지 스크롤 영역에도 적용했다. 포인터·직접 스크롤에 위치 막대가 나타나고 자동 따라가기에는 깨우지 않는다. 가로/세로 끌기·휠, 검색 목록을 끌 때 닫히지 않음, 대화 레일 위 휠이 최신 메시지로 튕기지 않음을 확인했다. 터치는 시스템 표시를 유지한다.
- 검사: Host 707 통과·9 생략, UI 179 통과, Rust 21 통과, 타입·빌드 통과. 전용 Playwright 2 통과, 다른 공급자 리뷰의 휠 의도 전달 누락 1건 수정. 전체 데스크톱 Playwright는 34 통과·76 실패: 확인한 실패에는 오래된 UI 스냅숏과 중복 `status` 선택자가 포함된다. 관련 없는 기준 이미지를 일괄 갱신하지 않았다.
- 설치된 앱을 종료·재실행해 새 UI를 받게 했다. 새 창은 잠시 보였으나 실제 스크롤 검사 시 창이 없어 네이티브 입력 검증은 완료하지 못했다(강제 전면 이동 없음). 운영 Host가 제공하는 UI에서는 실제 휠 뒤 scrollTop 260, native gutter 0, ScrollRail active를 확인하고 화면을 검사했다.
- 되돌리기: 유휴 상태에서 `current`를 `releases/2.2.0-873134c`로 바꿔 launchd를 재시작한다. 데이터·자격 복원은 필요 없다.

### iPhone 앱 OTA 업데이트 — 2026-11-10

- Release에 팀 개발 프로필(`iOS Team Provisioning Profile: io.a7garden.ghost`, 등록 기기 3대, 2027-11-04 만료)로 서명한 `Ghost.ipa`를 넣는다. Host가 15분 토큰으로 공개 origin에서 설치 페이지·OTA 매니페스트·sha256을 검증한 IPA를 준다. 빌드 9부터 iPhone 앱 안의 「앱 업데이트」로 설치하고, 그 전 셸(현재 iPhone의 빌드 8)은 Mac 설정 › 업데이트 › iPhone 앱의 QR 코드를 카메라로 찍어 Safari에서 「설치」한다.
- 운영 Host는 Owner API로 2.1.2 → 2.2.0을 자체 업데이트했다(20초, 백업 `backups/pre-2.2.0-873134c-*`). 공개 origin `https://macstudio.tail1d0d8d.ts.net:8443`에서 링크 발급, `application/xml` 매니페스트, 매니페스트 sha256과 일치하는 IPA(328,355 bytes), CSP가 붙은 설치 페이지, 잘못된 토큰 404를 확인했다. Mac 앱에서 `0.1.0 (9)`와 QR 코드가 뜬다. iPhone에서의 실제 설치 확인(시스템 설치 창 탭)은 소유자가 해야 한다.
- 알림: 앱은 서명 프로필의 `aps-environment`로 APNs 환경(sandbox/production)을 정한다. Xcode가 팀 W5SAS95CBV를 `Personal Team`(무료)으로 보고 Push 기능 추가를 거부하므로, OTA 빌드에는 push 권한이 없다. 멤버십을 확인하거나 갱신하고, APNs 키(`.p8`)를 만든 뒤 `config.json`에 `apns`를 넣어야 알림이 동작한다. 무료 팀으로 남으면 새로 발급하는 개발 프로필은 7일 뒤 만료된다.

### GitHub Release 자체 업데이트 도입 — 2026-11-10

- Host가 GitHub Release를 확인해 소유자가 「설치」를 누르면 스스로 교체한다. 앱은 Host의 루프백 경로로 셸 업데이트를 받는다. 셸의 managed 모드는 없앴다. 구조는 [architecture](architecture.md#releases-and-updates), 절차는 위 "개발 변경의 자동 운영 반영"을 따른다.
- 서명: Host와 앱은 키체인의 Developer ID Application(W5SAS95CBV)으로 서명한다. 업데이트 매니페스트와 앱 묶음은 `~/.tauri/ghost.key`로 서명한다. 비밀번호 없는 키이며 공개 키는 `tauri.conf.json`과 Host 빌드에 박혀 있다. 이 키를 잃으면 설치된 Host·앱이 더는 업데이트를 받지 못하므로 별도 백업이 필요하다.
- `v2.1.0` 전환은 손으로 했다(이전 Host에는 업데이트 기능이 없었다). 백업은 `backups/pre-2.1.0-9669474-1794313953000/`(`ghost-backup/2` complete, secrets·config·artifacts·console·이전 plist·이전 `Ghost.app`) 뒤 `current`를 원자 교체하고 `ghost service install`. 이때 `launchctl bootout`이 이전 Host의 종료를 기다리지 않아 bootstrap이 EIO로 실패했고, 서비스가 약 15초 내려가 있었다. 손으로 bootstrap해 복구했고, 2.1.1에서 언로드를 기다리고 bootstrap을 재시도하도록 고쳤다.
- 자체 업데이트 검증: 격리 루트·포트에서 launcher 루프로 2.1.0 → 2.1.1을 받았다(받기·검증 11초, 재기동 3초, 60초 뒤 `installed`). 운영은 Owner API로 2.1.0 → 2.1.1을, 설치된 앱의 설정 › 업데이트 「설치」로 2.1.1 → 2.1.2를 받았다. 각각 백업 `backups/pre-2.1.1-03763ab-*`, `backups/pre-2.1.2-9fd86d8-*`가 남았다. 다운타임은 약 2초였고 Ghost 25·대화 206·맡긴 일 154를 보존했다.
- 앱 0.2.0은 손으로 설치했다. 0.2.1·0.2.2는 앱 안의 「설치」로 받았다. 0.2.1은 재시작 뒤 Dock에서 다시 열기 전까지 창이 보이지 않았고, 0.2.2부터 LaunchServices로 다시 열어 창이 바로 뜬다.
- 업데이트 토큰은 소유자의 `gh` 토큰(`repo`·`admin:org` 등 넓은 범위)을 넣었다. `a7garden/ghost` 내용 읽기만 허용한 fine-grained 토큰으로 바꾸려면 설정 › 업데이트 › GitHub 토큰에서 바꾼다.
- 되돌릴 때는 `current`를 이전 릴리스로 바꾸고 `launchctl kickstart -k gui/$(id -u)/com.a7.ghost`. 2.1.x·2.2.0은 저장 형식 지문(`ledger-7/pi-durable-1.1.0/vault-1`)이 같다. 업데이트 기능 이전으로 돌아가려면 `releases/20261110-bun-a0b941e`와 백업한 plist(infra `ghost-run.sh`)를 복원한다.

### 기본 Ghost 호버 반응·움직임 줄이기 운영 반영 — 2026-11-10

- 마우스를 올리면 살짝 눌리고(세로 0.94–0.96) 눈을 0.72로 가늘게 뜨며 커서를 본다. 올려 둔 동안 2.6–5.2초마다 작게 흔들리고, 떠나면 튕긴 뒤 정면으로 돌아온다. 터치의 enter/leave는 무시한다. 둘러보기 간격을 늘리고 고개 돌릴 때의 출렁임을 줄였다. 0.25px 아래의 남은 움직임은 끝내서, 30px 24명 목록에서 동시에 움직이는 수가 평균 8.5에서 3.05로, 움직이는 프레임 비율이 36%에서 13%로 줄었다(`main` `f041ef0`, 릴리스 브랜치 `a0b941e`).
- `releases/20261110-bun-a0b941e`: `ghost`·`agent-browser`는 `a7fd413`과 바이트가 같고 UI 95개 파일 해시가 일치한다. UI 테스트 146개·빌드, 실제 마우스 호버·동작 줄이기(전부 정지)·터치 무시를 브라우저에서 확인했다.
- 백업 `backups/pre-20261110-bun-a0b941e-1794311271200/`(`ghost-backup/2`, complete, 금고 포함) 후 유휴에서 전환했다. PID 95868 → 4154, `provider minimax is ready`, 기존 Ghost·대화·맡긴 일·결정 식별자 보존, health·공개 origin 200, 제공 번들 해시 일치, Mac 앱 external 재실행(PID 4250). 운영 UI의 60px 초상이 호버 때 눈을 0.72로 가늘게 떴다. 데스크톱 아바타 창의 호버는 Ghost 창에 가려 확인하지 못했다.
- 되돌릴 때는 `current`를 `releases/20261110-bun-a7fd413`으로 원자 교체하고 Host를 정상 재기동한다. 대기 중인 후보는 `f041ef0`도 포함해 다시 빌드한다.

### 말랑한 기본 Ghost 운영 반영 — 2026-11-10

- 몸에 감쇠가 약한 납작함 스프링을 더했다. 누르면 웅크렸다가 늘어나며 뛰고, 착지 뒤 몇 번 출렁인다. 고개를 돌리면 윗부분이 뒤따라 흔들리고, 56px 이상은 숨을 쉰다(`main` `b7707c2`, 릴리스 브랜치 `release/ghost-life-20261110`의 `a7fd413`).
- `releases/20261110-bun-a7fd413`: `ghost`·`agent-browser`는 `3f5459a`(= `eeeeb02`)와 바이트가 같고 UI 95개 파일 해시가 일치한다. UI 테스트 146개·빌드, 별도 루트·포트에서 health와 누를 때 세로 배율 0.85–1.11을 확인했다.
- 유휴에서 백업 `backups/pre-20261110-bun-a7fd413-1794310574754/`(`ghost-backup/2`, complete, 금고 포함) 후 전환했다. PID 93704 → 95868, `provider minimax is ready`, Ghost 25·대화 199·맡긴 일 149·결정 139 보존, health·공개 origin 200, 제공 번들 해시 일치, Mac 앱 external 재실행(PID 96029). 운영 UI의 60px 초상이 숨쉬기(0.98–1.01)로 움직였다.
- 되돌릴 때는 `current`를 `releases/20261110-bun-3f5459a`로 원자 교체하고 Host를 정상 재기동한다. 저장 형식 변경은 없다. 대기 중인 후보는 `b7707c2`도 포함해 다시 빌드한다.

### 기본 Ghost 생동감 운영 반영 — 2026-11-10

- 기본 Ghost가 눈을 깜빡이고, 고개를 돌려 둘러보며 몸을 기울인다. 56px 이상은 가까운 포인터를 쳐다보고, 누르면 깡충 뛴다. 28px 미만, 애니메이션 끄기, 동작 줄이기에서는 정지한다(`main` `69a9641`).
- 운영판 `eeeeb02`에 이 커밋만 얹은 `3f5459a`(브랜치 `release/ghost-life-20261110`)로 `releases/20261110-bun-3f5459a`를 만들었다. `ghost`·`agent-browser`는 `eeeeb02`와 바이트가 같고, UI 95개 파일 해시가 빌드 원본과 일치한다(`release.json`). UI 테스트 146개·빌드, 별도 루트·포트(62219)의 설치 사본에서 health와 움직이는 초상을 확인했다.
- 대화 2건이 끝나 유휴가 된 뒤 백업 `backups/pre-20261110-bun-3f5459a-1794310261967/`(`ghost-backup/2`, complete, 원장·Pi·금고 DB와 key, artifacts·secrets·config·console 설정)을 만들고 전환했다. PID 57727 → 93704, 단일 리스너, `provider minimax is ready`, Ghost 25·대화 199·맡긴 일 149·결정 139 식별자 보존, health·공개 origin 200, 제공 번들 해시 일치. Mac 앱은 external 모드로 다시 실행했다(PID 93828). 운영 UI의 Ghost 설정에서 30px 이상 초상 24개가 모두 움직였다. 데스크톱 아바타는 Ghost 창 아래에 가려 있어 화면으로 보지 못했다.
- 되돌릴 때는 유휴를 확인하고 `current`를 `releases/20261110-bun-eeeeb02`로 원자 교체한 뒤 Host를 정상 재기동한다. 저장 형식 변경은 없다. 대기 중인 Obscura(`90bc06b`)·모바일 대화 탭(`15d245e`) 후보에는 이 UI가 없으므로, 전환 전에 `69a9641`을 포함해 다시 빌드한다.

### Obscura 릴리스 후보 — 2026-11-10

- `releases/20261110-bun-90bc06b`에 Host, UI, `agent-browser` 0.41.2, 공식 Obscura 0.2.6 arm64 및 라이선스를 준비했다. `release.json`의 191개 파일 해시와 설치 사본을 별도 상태 루트·포트에서 확인했다.
- 격리 CDP, 가짜 볼트 입력, 앱 내 인계와 한글 입력, 네트워크 및 파일 접근 제한을 확인했다. 브라우저 UI 검사 8개와 기존 Chrome 헤드리스 검사 3개를 통과했다. Host 전체 검사에서 남은 두 API 효과 경합 실패는 기존 `0166573`에서도 재현됐다.
- 운영에 실행 중인 맡긴 일과 대화가 있어 전환을 대기한다. 이후 `current`는 `20261110-bun-3f5459a`(기본 Ghost 생동감)로 바뀌었으므로 이 후보는 `69a9641`을 포함해 다시 빌드해야 한다. 유휴 시점에 위 운영 절차로 백업하고 `browser.obscura`를 설정한 뒤 전환한다. 초기 `loginOrigins`는 비워 둔다.

### 모바일 대화 탭 릴리스 대기 — 2026-11-10

- 모바일 하단의 **대화**에서 메인과 각 Ghost를 찾아 바로 대화로 이동한다. 홈에서 메인에게 바로 메시지를 쓰는 흐름은 유지한다.
- 현재 운영판 `c572f91`에 이번 UI만 얹은 `releases/20261110-bun-15d245e`를 준비했다(소스 브랜치 `release/mobile-conversations-20261110`). Host와 고정 브라우저 바이너리는 운영판과 바이트가 같고, UI 95개 파일의 해시를 검증했다. UI 테스트 146개, 관련 iPhone 브라우저 테스트 21개, 설치 후보의 별도 루트·포트에서 대화 열기와 뒤로 가기가 통과했다.
- Owner API에서 맡긴 일 1건과 대화 1건이 계속 실행 중으로 표시됐다. 운영 링크는 `20261110-bun-c572f91`에 두었다. 전환은 유휴 확인과 백업 후 진행한다. 실제 iPhone은 연결되지 않아 기기 검수는 남았다.

### Ghost 스스로 일하기 운영 반영 — 2026-11-10

- 소유자 지적: 정해 둔 시각에 프롬프트를 돌리는 반복 작업·예약 활동은 크론과 다르지 않다. 메인이 일정을 잡아 주거나 각 Ghost가 스스로 판단해 움직여야 상시 구동·자율이다.
- 코드(`c572f91`): 모든 Ghost가 직접 대화에서 `plan_next`로 다음에 언제 무엇을 볼지와 지켜볼 프로젝트를 정한다. Host는 그 시각이나 지켜보는 프로젝트의 새 커밋에 `[Autonomous wake]`로 깨우고, Ghost가 조사·제안·스스로 시작한 일(`work_create initiative`, Ghost가 검토)·소유자에게 말하기·`[quiet]` 중에서 고른다. 메인은 매번 팀원 계획을 보고 일을 맡기거나 계획을 잡아 주며(`plan_next ghost_id`), 팀원의 스스로 일하기를 켜고 끈다. Ghost 설정에 스위치와 다음 계획이 보인다. 계획은 `settings`의 `autonomy:<ghostId>` 행이라 원장 마이그레이션이 없다. 깨움은 보내기 전에 기록하고 같은 id로 재시도한다. 하루 12회·동시 2개 한도. 먼저 말 걸기 알림은 실행이 끝난 뒤의 마지막 답으로 보내 도구 앞 설명이 알림으로 가지 않는다.
- 검사: Host 616 통과·7 생략(경쟁·재시작·충돌 복구·반복 위치 포함 자율 9개), UI 146 통과·빌드, 브라우저 시각 160 통과(팀 설정 기준 이미지 4장 갱신, 다음 계획 시각은 `<time>` 마스크). 백업 사본 루트에서 실제 MiniMax로 메인·리서치 자율 깨움을 확인했다: 메인은 팀 결과를 묶어 말을 걸고 스스로 다음 시각을 잡았고, 리서치는 멈춘 조사를 취소하고 좁힌 일을 스스로 다시 맡긴 뒤 트윌룸을 지켜보도록 계획하고 `[quiet]`로 끝냈다. Claude 작성분을 Codex 계열 교차 검토로 4회 확인해 P1(보류 중 갱신 덮어쓰기, 동시 한도, 재시작 슬롯)과 P2(깨움 식별자, 반복 위치, 거절 시 계획 보존, 날짜 계산, 긴 실행의 알림 조회)를 고쳤다.
- 운영 데이터: 고정 시각 반복 작업 5개와 예약 자동 활동 7개(아침 브리핑, AI 도구 변화, 심층 조사, 경쟁 동향, 공개면 점검, Talking Stage 기획, 기억 정리)를 삭제했다. PR 변화로 움직이는 트윌룸·트윌룸 스튜디오 PR 검토만 남겼다. 메인 페르소나의 "아침 브리핑" 문장을 스스로 깨어날 때마다 팀을 보고 움직이는 문장으로 바꿨다. 고성능 모델을 쓰는 `심층`은 스스로 일하기를 껐다(맡길 때만 움직임). 나머지 22개 활성 Ghost의 첫 계획은 배포 직후 2시간 안에 흩어 잡혔다.
- 설치: `releases/20261110-bun-c572f91`, Host SHA-256 `c05aadd0…`, UI 95개 파일, `agent-browser` 복사. 백업 `backups/pre-20261110-bun-c572f91-1794264229262/`(complete). PID 46001 → 16242, Ghost 25·대화 67·맡긴 일 59·결정 30 보존, health 200, Mac 앱 재실행. 배포 뒤 첫 실제 깨움에서 레퍼런스는 Talking Stage 레퍼런스 분석을 스스로 맡기고 다음 시각을 잡았고, Mac 관리는 읽기 확인을 바로 돌려 백업 공백을 보고했다(두 건 모두 마지막 답이 소식 알림으로 감). iPhone14에는 같은 셸을 빌드 7(`0.1.0 (7)`, 개인 팀 W5SAS95CBV, push 권한 없음)로 다시 설치해 실행했다. 되돌릴 때는 `current`를 `releases/20261110-bun-2024f08`로 바꾸고 Mac 앱·iPhone을 다시 열어 새 스냅숏부터 받게 한다(이전 UI는 `autonomy` 이벤트를 모른다). 이전 릴리스는 `autonomy:*` 설정 행을 무시하고, 삭제한 반복 작업·활동은 위 백업이나 소유자 API로 다시 만든다.

### Ghost 팀 상시 작업 설정·운영 반영 — 2026-11-10

- 소유자 요청: Ghost들이 스스로 일하고 먼저 말을 걸며 승인 요청을 줄인다. 상시 구동은 5시간마다 회복되는 MiniMax·GLM flash를, 무거운 과업만 고성능 모델을 쓴다. 웹·프로젝트·PC 접근이 일의 걸림돌이 되지 않게 하고, 사용자가 복잡하게 설정할 필요가 없게 한다.
- 원인: 반복 작업·자동 활동·연결이 0개라 Mac 관리(watch)만 움직였다. 승인 19건 중 14건이 로그 `cat`·`tail`, `ls`·`find`, `git status/remote` 같은 읽기 확인이었다. 5개 Ghost는 웹 도구가 없었고, 여러 페르소나가 "웹에 접근할 수 없다"고 소개했다.
- 운영 데이터(소유자 API, 이전 값은 `~/.local/share/ghost/backups/ghost-config-before-standing-work-20261109.json`): 모든 Ghost를 `MiniMax-M3.1-Flash`(메인·리서치·경쟁 분석·보안 점검·패널·Mac 관리는 thinking high)와 대체 `glm-5.3-flash` → `gpt-6-luna`로 바꿨다. 기본 모델도 `MiniMax-M3.1-Flash`. 무거운 과업 전용 `심층`(gpt-6.1-sol → gpt-6-luna → MiniMax flash)을 새로 만들고 메인 페르소나에 위임 기준을 넣었다. 모든 Ghost에 호스트 도구를 뺀 선택 도구 50개 전부를 주었다(호스트 도구는 Mac 관리·보안 점검만). 페르소나의 "저장소를 못 본다/웹 없음" 문장을 Space·웹 기준으로 고쳤다.
- 프로젝트 Space 9개(Ghost, 트윌룸, 트윌룸 스튜디오, Talking Stage, 인프라, 에이전트 오케스트라, Garden UI, Oximemo, Ascent; 노드 프로젝트는 `docs/`만). 연결: GitHub `a7garden`(gh 토큰). mini Gitea는 공개 주소가 Cloudflare Access 뒤에 있고 tailnet IP는 Ghost 네트워크 가드가 막아 연결하지 않았다. agent-reach는 X·YouTube·GitHub·web이 동작하고 Reddit은 추가했지만 현재 상류 오류다. iCloud 메일은 개인 메일을 외부 모델에 넘기는 일이라 연결하지 않았다.
- 자동 활동 9개(모두 컨테이너, 외부 동작 deny): 아침 브리핑과 제안(메인, 매일 08:30, 3시간, 항상 보고·위임 2건), AI 도구 변화 브리핑(07:30), 프로젝트 심층 조사(리서치, 13:00, 요일별 프로젝트), 주간 경쟁 동향(월 10:00), 주간 공개면 점검(수 11:00, 수동 점검만), Talking Stage 주간 기획(목 14:00), 주간 기억 정리 제안(일 09:00), 트윌룸·트윌룸 스튜디오 PR 검토(15분 폴링, 댓글 없음). 먼저 말 걸기 반복 작업 5개: 메인 매일 09:00, 기획 화 19:00, 디자이너 수 16:00, SNS 금 17:00, 경쟁 분석 목 18:00. 첫 수동 실행에서 AI 소식·심층 조사·경쟁 동향이 1차 출처가 달린 결과를 냈다.
- 코드(`b1ffd94`, `bd975e5`, `0263253`, `2024f08`): 읽기 전용 호스트 확인은 승인 없이 바로 실행(상태 루트·비밀·개인정보 경로 거부, GitHub 한정 `ls-remote`, 줄 단위 출력, 범위 밖은 승인으로 돌아감). 모든 대화에 자율 판단·질문 묶기·다음 할 일 제안 지침, 실시간 웹·프로젝트 문서 지침. 예약된 깨움에 대한 Ghost의 첫 답은 `message` 알림(먼저 말 걸기). 메인이 다른 Ghost에게 호스트 도구·PC 직접 실행을 허용할 수 있고 그때마다 소유자 알림이 같은 트랜잭션에 남는다. 프로젝트별 Ghost 권한 설정을 없앴다(원장 열은 `'[]'`, 마이그레이션 없음). 대화·홈·맡기기에서 `#프로젝트`로 언급하고 프로젝트 화면에서 바로 대화·맡기기를 시작한다. Work에서도 Space를 읽는다. iPhone UI 점검(대화형 블록, 터치 컨트롤, 중복 제목, HTML 미리보기 높이·전체 화면, 대화 알림 종류).
- 검사: 계약·Host 타입 검사, Host 606 통과·7 생략, UI 145 통과·빌드, 브라우저 시각 156 통과(감사 기준 이미지 포함). 독립 검토: 읽기 전용 확인·HTML(Codex 작성)은 Claude가 P1 2건(상태 루트·바이트 단위 출력으로 비밀 노출)과 P2를 찾아 고쳤다. 메인 허용·먼저 말 걸기·지침(Claude 작성)은 Codex가 검토했고 원자성·문서를 고쳤다. 프로젝트(Codex 작성)는 Claude 검토에서 P3 3건만 나와 고쳤다. 검토 중 소유자 토큰 일부가 검토 모델 출력에 나타나 첫 배포에서 토큰을 교체했다(Mac 앱은 재실행해 새 토큰을 읽는다).
- 첫 배포 `20261110-bun-0263253`은 시작 직후 이벤트 루프가 멈췄다. launchd에서 재현: 새 바이너리는 macOS 개인정보 보호 결정이 없어서, 읽기 전용 확인이 `~/Library/Mail`·`Safari` 등을 `realpath` 하면 전체 디스크 접근 동의를 기다리며 막혔다. `20261109-bun-bd931d0`로 되돌린 뒤, 보호 경로를 실제로 건드리기 전에 이름만으로 거부하게 고친 `2024f08`을 launchd 재현에서 확인하고 다시 배포했다. 실패한 릴리스 디렉터리는 사용하지 않는다.
- 설치: `releases/20261110-bun-2024f08`, Host SHA-256 `e9881f5f…`, UI 94개 파일 일치, `agent-browser` 복사. 백업 `backups/pre-20261110-bun-2024f08-1794241250707/`(`ghost-backup/2`, complete). PID 32865 → 46001, Ghost 25·대화 67·맡긴 일 59·결정 28 식별자 보존, health·공개 origin 200, 제공 UI에 새 번들. Mac 앱은 external 모드로 재실행했다(PID 46305). 오래 멈춰 있던 twillroom 읽기 확인 승인 1건은 새 정책에 맞춰 승인해 정리했다.
- 되돌릴 때는 `current`를 `releases/20261109-bun-bd931d0`으로 바꿔 LaunchAgent를 재시작하고 Mac 앱을 다시 연다. 스키마 변경은 없다. 이전 릴리스에서는 Space 접근이 다시 Ghost별 권한(지금은 빈 목록)으로 읽혀 Space를 보지 못한다. 운영 데이터(모델·도구·활동·반복 작업·Space)는 소유자 API로 되돌린다.

### iPhone 웹 UI 셸·기기 소유자 동등 권한 운영 반영 — 2026-11-09

- 소유자 결정: iPhone은 하위 호환이 아니라 또 하나의 접속 방식이다. iPhone 앱은 Host가 제공하는 웹 UI를 WKWebView로 여는 셸이 되고, 페어링·Keychain 토큰·알림 권한·APNs·알림 탭 이동·첫 로드/연결 불가 화면만 네이티브로 남긴다. 페어링한 기기는 기기 관리(페어링 시작, 기기 이름 변경, 다른 기기 해제)를 뺀 소유자 동등 권한을 가진다. 기기는 스스로 해제할 수 있다. 기기 관리 예외는 격리 경계가 아니다(기기가 PC 실행을 허용할 수 있으므로). 웹 UI에 모바일 레이어(하단 독, 키보드 위 입력창, 하단 시트, 터치 메뉴, 설정 목록/상세, 이 기기 알림 설정)를 더했다. 원장 스키마는 바꾸지 않았다(기기별 알림 설정은 `settings` 키 `device.alerts:<id>`).
- 소스: `main`을 `autonomy-integrated-20261109`와 병합한 뒤(`dfccbd8`, `f1227fa`) `bd931d0`. 검사: 계약·Host 타입 검사, Host 582 통과·7 생략, UI 137 통과·빌드, 브라우저 시각·기능 82 통과(데스크톱 기준 이미지 불변, 모바일·iPhone 기준 갱신), iOS core 20 통과, 시뮬레이터 UI 테스트(페어링 화면, 연결 불가, 격리 Host에 페어링한 셸의 홈·확인할 일·맡긴 일·설정·이 기기 및 대화 입력창-키보드) 통과. 독립 검토: Host·계약(GLM 작성)은 Claude Opus, 웹 UI(Codex 작성)는 Claude, iPhone 셸(Claude 작성)은 Codex가 검토했고 P0·P1 없음. 지적된 P2·P3(셸 준비 상태·APNs 재등록·IPv6 origin·이전 연결의 401, 데스크톱 메뉴·검색·Tauri 좁은 창·시트 포커스 등)는 수정했다.
- 설치: `releases/20261109-bun-bd931d0`, Host SHA-256 `150692e8…`, UI 93개 파일 원본/사본 일치, `agent-browser` SHA-256 `19680f06…`(이전 릴리스에서 복사, `release.json`에 전체 해시). 백업 `backups/pre-20261109-bun-bd931d0-1794228611238/`(`ghost-backup/2`, complete). 13시간 전부터 대화가 멈춘 채 `running`으로 남은 맡긴 일 `71a1acf3…`(twillroom 푸시 상태 확인)은 진행 중인 실행이 없어(대화 busy false, live running false) 유휴로 판단했다. 설치 사본을 별도 루트·포트에서 실행해 health·UI를 확인한 뒤 `current`를 원자 교체하고 정상 재기동했다(PID 26240 → 31736). 단일 리스너·새 실행 경로·준비 상태, Ghost 24·대화 41·맡긴 일 40·결정 18 식별자 보존, 공개 origin health와 토큰 비주입, 제공 UI 번들 일치를 확인했다.
- 처음 설치 사본에는 `agent-browser`가 빠져 `current/agent-browser`가 약 3분간 없었다. 같은 해시의 고정 바이너리를 새 릴리스에 복사해 복구했다(브라우저는 호출 시점에 실행 파일을 연다). 다음 릴리스도 `ghost`·`ui/`와 함께 `agent-browser`를 넣어야 한다.
- Mac 앱은 external 모드로 다시 열었지만 화면이 잠겨 있어(활성 디스플레이 없음) 실제 창 확인은 하지 못했다. iPhone14에는 빌드 6을 설치했다(개인 팀, 알림 권한 없이 서명). 운영 Host에는 아직 페어링한 기기가 없다.
- 되돌릴 때는 `current`를 `releases/20261109-bun-2bf4792`로 바꿔 LaunchAgent를 정상 재시작한다. 스키마·자격 형식은 그대로라 DB·secrets 복원은 필요 없다. 이전 릴리스는 이 기간에 연결한 기기를 기기 명령만 보낼 수 있는 기기로 읽는다.

### 자동 활동·PC 직접 실행 운영 반영 — 2026-11-09

- 소스 `2bf4792`는 자동 활동 구현과 운영 `cd1527b`의 브라우저·금고·협업 및 전체 Ghost 기기 접근 정책을 합친 검증본이다. [구조와 권한 경계](architecture.md#standing-activities-not-an-always-thinking-agent), [설정 방법](#자동-활동과-pc-실행)을 따른다. Ghost별 상시 VM이나 LLM 하트비트 대신 Host 감지 → 한도가 있는 맡긴 일을 사용한다.
- 검사: 계약·Host 타입 검사, Host 578 통과·5 생략(4,118 assertions), 실제 Chrome 검사 4 통과, UI 128 통과·타입/빌드, 브라우저 시각·기능 61 통과. 실제 Pi와 PC 파일·셸로 실패 → 같은 맡긴 일/대화 재개 → 새 OS 바이트 읽기·쓰기·실행·산출물 수용을 검증했다. 의심했던 환경 캐시 문제는 재현되지 않았고 런타임 우회 수정은 하지 않았다.
- 독립 검토: Codex 작성 통합 Core·실행 환경·UI는 Claude, Claude 작성 계약·API·문서는 Codex가 검토했다. 실제 응답 메타데이터로 vendor 차이를 확인했다. 통합 검토의 확정 지적은 없다. 그 전 실제 실행에서 찾은 승인 뒤 대기 고착과 자동 활동 결과의 직접 대화 권한 확장 등은 구현·회귀·실제 실행으로 수정했다.
- 격리된 실제 모델: PC 권한 전 거절·허용 뒤 정확한 cwd의 파일/셸·산출물 수용, Apple container의 Host 파일 비가시성과 원본 보존, 로컬 Gitea 및 엄격한 TLS IMAP/SMTP 원본 읽기 → 유휴 승인 대기(전송 0회) → 승인 후 정확히 1회 댓글/회신 → 완료를 확인했다. 중복 감지·변경된 head/UID·중지·수동 답글 대상 고정도 확인했다. 실제 메일 계정이나 외부 수신자에게 보내지 않았다.
- 공식 Manus 문서 조사 뒤 240초 상대 다음 점검을 저장하고, 유휴 확인 후 Host를 정상 종료·재시작했다. 동일한 실행·시각·비교 기준이 남았고 자기 점검이 정확히 한 번 완료됐다(전체 2회); 변경 없음 결과는 알림 없이 종료했다. 실제 브라우저의 제목/본문 관측이 검토자의 `evidence_read`에 전달되는 것도 확인했다. 시험 원장·Pi·모델 캐시에서 제공자 자격 값의 일치가 0건이었다.
- 설치: `releases/20261109-bun-2bf4792`, Host SHA-256 `1bfe723f…`, UI 93개 파일 원본/사본 일치, `agent-browser` SHA-256 `19680f06…` 보존(`release.json`에 전체 해시). 백업 `backups/pre-autonomy-20261109-1794158897180/`: `db/backup.json`은 `ghost-backup/2`, complete, 원장 스키마 6·두 DB 및 금고 DB/키의 무결성·해시 확인. 부속 상태 34개 파일과 console 설정의 바이트·권한도 확인했다.
- 설치 사본을 자격·Mac watch·기억 연동을 끈 운영 백업 사본에서 실행했다. 스키마 6→7, Ghost 24·대화 40·맡긴 일 39와 질문·수정 이력 보존, 금고 API 200·제공 UI 바이트 일치를 확인했다. 모델 자격을 의도적으로 복사하지 않아 이 복원 검사의 모델 준비 상태는 false였고, 실제 모델 실행은 별도 새 루트에서 검증했다.
- 유휴에서 `current`를 원자적 rename으로 교체·대상 확인 후 기존 Host에 `SIGTERM`을 보냈다(PID 57107→26240). 새 `host.json` 파일 이벤트로 재기동을 관측했다. 단일 62062 리스너·새 실행 경로·운영 DB 루트·스키마 7·모델 준비 상태·health/공개 origin/금고 API 200, 기존 Ghost·대화·맡긴 일·결정·기기 식별자와 모델·도구·자격·소유자 토큰·console 설정 보존을 확인했다. PC 권한·연결 계정·활동 규칙은 자동 부여/생성하지 않았다.
- 설치된 Mac 앱은 external 모드에서 정상 종료·비활성 재실행했다(PID 54752→28423). 셸 번들은 교체하지 않았다. 새 창은 `accessible:false`, `is_focused:false`여서 네이티브 클릭은 확인하지 않았고 앞으로 강제 이동하지 않았다. 운영 Host가 제공하는 실제 UI에서 자동 활동 생성 양식(PC 미허용 상태), 연결 계정 탭을 열고 저장 없이 닫았다.
- Git: 전용 브랜치는 일반 푸시했다. canonical `main`의 기존 미커밋 기기 알림 작업과 겹쳐 `git merge --ff-only`가 거절됐으므로 그 변경은 stage/commit/stash/reset하지 않았다. `main`은 미통합이며 검증 소스는 `autonomy-integrated-20261109`에 보존한다.
- 되돌리기: 이전 `cd1527b`와 스키마 6 백업을 보존했다. 스키마 6 Host는 7을 거절하므로 링크만 되돌리지 않는다. 데이터·자격 복원은 별도 소유자 승인이 필요하다.


### 브라우저·금고·협업 개선 운영 반영 — 2026-11-09

- 설계: [agent-capabilities](agent-capabilities.md). Host 브라우저(agent-browser + Chrome, Host 출구 프록시, 결제·전송은 승인), Ghost 금고(Shade 모델 포팅, 보안 입력 양식, 값은 모델·원장에 남지 않음), 자식→부모 질문(`ask_parent`/`answer_child`), 판정 근거·수정 범위, 자식 검사, 교훈 전달, 효과 도구가 있는 라운드의 순차 실행. 원장 마이그레이션 6(`work_questions`, `works.revise_history`·`question_nudges`).
- 검사: Host 468개 중 462 통과·6 생략(실제 Chrome 4개는 `GHOST_BROWSER_SMOKE=1`로 따로 통과: 공개 페이지·프록시 거절·Ghost별 로그인 복원, WebRTC UDP 0패킷, 스크린샷 잠금, 인계 후 마지막 페이지 복원), 타입 검사, UI 114개·빌드, 시각/기능 53개. 독립 검토: 협업·금고·브라우저(Codex 작성)는 Claude, UI(GLM 작성)는 Claude Opus, 통합 코드(Claude 작성)는 Codex가 검토했다. P1 4건(WebRTC UDP 우회, 업로드·다운로드 경로 경쟁, 보안 양식 `kind` 누락, 저장 실패 대화상자 고착)과 P2·P3를 고치고 회귀 검사를 더했다.
- 실제 모델(운영 사본 위 격리 루트): 브라우저로 example.com→IANA 이동, 보안 양식 요청→금고 경로 답변(일반 답변은 409)→the-internet 로그인 성공(`[redacted]` 표시), 카드 채우기 승인 대기→승인 후 입력, 인계 창 열림→답변 후 이어가기, 자식의 `ask_parent`→부모 `answer_child`→검사·검토 통과. 원장·Pi·금고 DB에서 시험 비밀번호·카드 번호가 발견되지 않았다(사이트 본문에 원래 적힌 데모 비밀번호만 Pi 기록에 있음).
- 설치: `releases/20261109-bun-eff8fba`로 먼저 전환한 뒤, `/tmp` 정리로 소켓 디렉터리가 사라져도 다시 만드는 수정을 더한 `releases/20261109-bun-cd1527b`로 다시 전환했다. Host 원본·사본 해시 일치, `agent-browser`는 upstream 공개 SHA-256(`19680f06…`)과 같다. 설치 사본을 운영 백업 사본 위 임시 루트·포트에서 실행해 스키마 6, health, 금고 API, UI, 실제 모델의 네이버 열기를 확인했다.
- 백업: `backups/pre-capabilities-20261109-eff8fba-1794151213000/`(스키마 5, artifacts·secrets·config·모델 캐시·console) 와 `backups/pre-cd1527b-20261109-1794151565000/`(스키마 6, 금고 DB·키 포함). 두 번 모두 유휴(바쁜 대화·진행 중 맡긴 일 0)를 확인하고 전환했다.
- 사고: 첫 전환에서 링크 교체 명령(`mv -h`)이 실패한 채 재기동 신호가 나가, 이전 실행 파일이 새 config의 `browser` 키를 거부하고 원장을 열기 전에 종료했다. 곧바로 `os.replace`로 링크를 바꿨고 launchd가 새 Host를 띄웠다. 데이터 변경은 없었다. 이후 전환은 `os.replace`만 쓴다.
- 운영 확인: 단일 리스너, 새 실행 경로, 스키마 6, 준비 상태, Ghost 24·대화 40·맡긴 일 39 식별자 보존, 금고 API 200, 제공 UI 번들 일치, 설정 › 금고 탭을 운영 웹 UI에서 열었다. 활성 Ghost 22명에게 브라우저·금고 도구를 부여했다(소유자 지시: 넓은 권한). 운영 대화에 검증 메시지는 보내지 않았다.
- Mac 앱은 external 모드로 정상 종료 후 다시 열었다. 화면이 꺼져 있어(CoreGraphics 활성 디스플레이 없음) 네이티브 창의 화면 확인은 하지 못했고, 같은 Host가 제공하는 웹 UI로 대신 확인했다.
- 되돌리기: 스키마 6은 이전 실행 파일이 거부한다. 이전 릴리스로 돌아가려면 `config.json`에서 `browser` 키를 빼고 `pre-capabilities-…` 백업(스키마 5)을 복원해야 하며, 이는 소유자 승인이 필요하다. 같은 스키마 안의 되돌리기는 `current`를 `releases/20261109-bun-eff8fba`로 바꾸면 된다.

### 기기 범위 제거·한 단계 페어링 운영 반영 — 2026-11-08

- 소유자 결정: 연결된 iPhone은 고른 Ghost로 제한하지 않는다. 기기 Ghost/대화 권한을 계약·Host·웹 UI·iPhone에서 없앴다. 기기는 소유자 전용 모음(반복 작업·Space·제공자·다른 기기·샌드박스)을 제외한 모든 Ghost·대화·맡긴 일·결정·알림을 보고, 기기용 명령만 보낸다. 철회가 통제 수단이다. `device.pairing_start`는 필드가 없고, 기기 이름은 휴대전화가 claim에 보낸 이름이다. 원장 스키마는 바꾸지 않았다(`devices.grants`·`pairings.grants` 열은 `'[]'`로 남겨 이전 릴리스가 원장을 열 수 있다).
- 검사: Host 397개 중 395 통과·2 생략, 타입 검사, UI 82개·빌드, 계약 타입 검사, iOS core 44개·시뮬레이터 UI 13개. 격리 Host(임시 루트·62199)와 시뮬레이터에서 딥링크 페어링→기기 자체 이름 등록→페어링 뒤 만든 Ghost까지 목록 표시→대화 열기를 확인했다. 독립 검토: Host·계약·웹(Codex 작성)은 Claude, iPhone(Claude 작성)은 Codex가 검토했고 P0–P2 지적은 없었다. 지적된 문서 한 줄과 기존 재시도 이름 문제는 고쳤다.
- 소스 `1fde344`를 `releases/20261108-bun-1fde344`에 설치했다. Host 원본·사본, UI 93개 파일 해시 일치, 설치 사본을 별도 루트·포트에서 실행해 health·UI 제공을 확인했다. 백업 `~/.local/share/ghost/backups/pre-20261108-bun-1fde344-1794149284782/`(`ghost-backup/2`, `complete: true`, artifacts·secrets·config·모델 캐시·console 설정 포함). 유휴 확인 뒤 `current`를 원자 교체하고 정상 재기동했다(PID 23039 → 31957). 단일 리스너·새 실행 경로·운영 DB·준비 상태와 Ghost 24·대화 40·맡긴 일 39·결정 9의 식별자 보존을 확인했다. 공개 origin health 200, 제공 UI 번들이 설치 사본과 같다.
- 설치된 `Ghost.app`을 정상 종료 후 external 모드로 다시 열어 설정 › 기기에서 새 화면(`기기 연결`, 권한 편집 없음)을 확인했다. 운영 페어링 코드는 만들지 않았다. iPhone14에는 빌드 5를 설치했다(개인 팀, 알림 권한 없이 서명). 운영 Host에는 아직 연결된 기기가 없다.
- 되돌릴 때는 `current`를 `releases/20261108-bun-570c27d`로 바꿔 LaunchAgent를 정상 재시작한다. 스키마·자격 형식은 그대로라 DB·secrets 복원은 필요 없다. 이전 릴리스에서는 이 기간에 연결한 기기의 권한이 `[]`로 읽혀 아무 Ghost도 보이지 않는다.

### 실행 안전성 보강 운영 반영 — 2026-11-08

- 상태 루트의 SQLite 소유권 잠금, 동기 API 변경·성공 기록의 원자적 커밋, 비동기 요청 신원·효과 기록, 두 DB를 함께 동결하는 백업을 검증했다. 원장 마이그레이션 5는 `requests.state`만 추가한다. 스키마 4 실행 파일로 직접 되돌릴 수 없으며 데이터·자격 복원은 별도 승인이 필요하다.
- 검사: Host·계약 타입 검사, Host 테스트 395개 통과·1개 생략(`GHOST_TEST_CONTAINER=1`, 1,927 assertions), 독립 실행 파일 빌드. 실제 CLI에서 동일 루트의 두 번째 Host 거절, 실행 중 백업·별도 루트 복원 후 Ghost 식별자 보존을 확인했다.
- 새 컴파일 Host와 격리된 실제 `glm-5.3`·Apple container 업무로 실행 중 `SIGKILL`→효과 대사→완료(append 1회), 취소→재시작 후 취소 유지·컨테이너 해제, 실패→동일 맡긴 일 재개→완료를 확인했다(전체 48.66초). 임시 상태·자격·컨테이너를 제거했다. 이 검사는 설치판의 장기 실업무나 실물 iPhone 수용을 대신하지 않는다.
- 독립 검토: 명령·원장은 Codex 작성→Claude 검토, 잠금·백업·종료 경로는 GLM 초안·Codex 복구→Claude Opus 검토. 명령 검토의 승인 대기 때문에 소유자 자격 삭제·문서 저장·샌드박스 제어가 막히던 P2를 별도 API 효과 범위로 고치고 재현·회귀 검사를 통과했다. 잠금·백업 검토의 P0/P1/P2 지적은 없다.
- 구현 `7ce91f4`를 병행 UI·네이티브 변경과 합친 `570c27d`를 `releases/20261108-bun-570c27d`에 설치했다. Host 원본·설치 사본 해시가 일치하고, UI 93개 파일은 이전 운영 `338dd06`과 바이트가 같다. 네이티브 셸은 교체하지 않았다. 설치 사본도 별도 상태 루트에서 실행해 health·UI·번들 바이트를 확인했다.
- 전환 전 백업 `~/.local/share/ghost/backups/pre-durability-20261108-bun-570c27d-1794139196552/`: `db/backup.json`은 `ghost-backup/2`, `complete: true`, 두 DB 무결성·해시 확인, 원장 스키마 4. artifacts·secrets·config·모델 캐시·console 설정을 보관했다. 상태 루트에 `skills/`는 없고, 설정된 외부 스킬 루트는 변경하지 않았다.
- 유휴·이전 실행 경로·리스너·DB 루트·링크·config·자격을 재확인한 뒤 원자적으로 전환하고 정상 재기동했다(PID 16460 → 23039). 새 경로의 단일 리스너·운영 DB·health 200·제공자 준비 상태와 스키마 5를 확인했다. Ghost 24·대화 40·맡긴 일 39의 모든 식별자, 소유자 토큰, config·console 설정 및 자격 파일 3개의 바이트를 보존했다.
- 설치된 `~/Applications/Ghost.app`을 정상 종료하고 external 모드로 다시 실행했다(PID 27071). 실제 설치 경로와 메인 대화의 AX 화면 준비를 확인했다. 운영 제공 UI의 `main-Bgsl9EkZ.js`도 보존한 설치 바이트와 일치한다. 검증용 운영 메시지나 모델 설정은 저장하지 않았다.
- 이전 `338dd06` 릴리스와 스키마 4 백업은 보존했다. 이제 이전 실행 파일로 링크만 되돌리면 스키마 검증에서 거절된다. 이전 상태로 복원하려면 별도 소유자 승인이 필요하다.

### 펫에 붙는 대화창 운영 반영 — 2026-11-08

- 소스 `338dd06`(main; 운영 `fb34f1f`의 설정·모델 카탈로그·파일 읽기 시트 등을 유지)을 `releases/20261108-bun-338dd06`에 설치했다. 펫 클릭 지연·두 번 클릭 구분을 없애고, 400×440 대화면을 펫의 실제 SVG 그림·상태 말풍선 위에 붙인다. 투명 창의 여백은 앵커에서 빼고, 몸통 중심으로 꼬리를 맞춘다. 구석에서는 같은 모니터 작업 영역 안쪽으로 이동하며, 위 공간이 모자라면 높이를 줄인 뒤 최소 높이도 안 되면 아래로 펼친다. 표시 영역은 companion 전용 IPC로 전달하고 메모리에만 보관한다.
- 검사: Host 353개 통과·2개 생략 및 타입 검사, UI 84개·타입 검사·빌드, Rust 24개·fmt·clippy `-D warnings`, Tauri 번들 빌드. 격리 Host·브라우저에서 Enter 전송, Shift+Enter 줄바꿈, 실패 시 초안 보존, Ghost 전환 시 이전 대화·초안 제거, 사라진 대상의 기본 대화 복구를 확인했다. 독립 검토의 대상 정규화·macOS 이전 화면 배율 참조 두 지적을 수정했고, 추가 그림 앵커·권한 경계 검토에는 지적이 없었다.
- 격리 네이티브 앱의 실제 펫 버튼 경로로 왼쪽·오른쪽 아래 구석의 창 위치와 꼬리 정렬을 화면에서 확인했다. 검사 중 소유자의 Safari 전환으로 정상 포커스 상실 닫기가 빨리 발생해, 화면 검수에는 닫기 직전 디버거 중단점도 사용했다. 닫기 규칙은 바꾸지 않았다. 혼합 배율·음수 모니터 좌표·부족한 위 공간·크기 변경 시 앵커 무효화는 네이티브 테스트로 검증했다.
- Host 원본/설치 사본 및 UI 93개 파일 해시가 일치한다. 설치 사본 Host·UI를 자격 없는 별도 상태 루트·모의 제공자에서 실행해 실제 메시지 왕복을 확인했고, 서명한 셸의 external 프로브도 같은 Host 연결을 확인했다. 새 앱은 기존 로컬 방식인 ad-hoc 서명이며 `codesign --verify --strict`와 아이콘 원본 일치를 확인했다.
- 백업 `~/.local/share/ghost/backups/pre-pet-20261108-338dd06-1794138526515/`: `db/backup.json`은 `ghost-backup/2`, `complete: true`, 두 DB 무결성 확인. 상태 부속 파일·console 설정과 이전 앱(`Ghost.app`, 교체 직전 원본 `Ghost.original.app`)을 보관했다. 유휴·이전 링크 재확인 뒤 `current`를 원자적으로 교체하고 Host를 정상 재기동했다(PID 4892 → 16460). 단일 리스너·새 실행 경로·운영 DB·준비 상태, Ghost 24·대화 40·맡긴 일 39의 모든 식별자와 config·secrets 바이트 보존을 확인했다.
- 설치된 `~/Applications/Ghost.app`을 external 모드로 실행하고 실제 `⌘⇧G` 입력으로 운영 대화를 열어, 머리 바로 위의 짧은 간격·오른쪽 구석의 안쪽 정렬·새 대화 UI를 화면 캡처로 확인했다. 운영 메시지나 모델 설정은 저장하지 않았다. 기존 대화 본문은 이 작은 창에서 계속 텍스트로 표시한다.
- 되돌릴 때는 앱을 정상 종료하고 `current`를 `releases/20261108-bun-fb34f1f`로 바꿔 LaunchAgent를 정상 재시작한 뒤, 백업의 `Ghost.app`을 설치 경로로 복원한다. 저장 형식·자격 형식 변경은 없으므로 DB나 secrets 복원은 필요 없다.

### 설정 레이아웃·모델 폴백 경로 운영 반영 — 2026-11-08

- 소스 `fb34f1f`(main; 설정 `4161737`, 검색 복구 `79b46d0`, 모델 우선 배치 `caa5fec`와 병행 모델 카탈로그·대화 결정·제목 표시줄 여백 통합)을 `releases/20261108-bun-fb34f1f`에 설치했다. 설정 메뉴 폭·공통 섹션 표면을 통일하고 검색 가능한 작은 roster, 연결된 기본/대체 모델 경로, 모델 검색·중복 선택 방지·순서/삭제 조작을 제공한다. 긴 역할 지시는 모델 뒤에, 상태·메인 지정·삭제는 운영 섹션에 두며 스킬·도구 선택은 유지했다. 셸·저장 형식 변경은 없다.
- 검사: Host 타입 검사·테스트 353개(+2 생략)·컴파일, UI 타입 검사·빌드·테스트 84개, Playwright 35개 통과. 격리 Host에서 모델 추가·교체·순서·상속의 재접속 후 보존, 실패 시 기존 값 유지·자동 재전송 없음, 키보드 탐색과 도구·스킬 저장을 확인했다. 밝게/어둡게·1280/390px 화면을 점검했다. 독립 Codex 검토의 검색 임계값(8→7명) 복구 지적은 수정 전 실패·수정 후 통과 브라우저 회귀로 보존했다.
- 백업 `~/.local/share/ghost/backups/pre-settings-20261108-bun-fb34f1f/`: `ghost-backup/2`, `complete: true`, 생성 시각 `1794137541083`, DB 해시·두 DB `integrity_check` ok, artifacts·skills·secrets·config 권한 유지 복사. Host 원본/사본과 UI 93개 파일 해시 일치. 자격·Mac watch 설정을 복사하지 않은 임시 루트에서 백업 DB로 설치 바이너리·새 UI·기존 식별자 보존을 확인했다.
- 유휴 재확인 후 `current`를 원자적으로 교체하고 Host를 정상 재기동했다(PID 1416 → 4892). 단일 리스너·실행 경로·운영 DB·준비 상태, Ghost 24·대화 40·맡긴 일 39의 식별자와 config·secrets 바이트 보존을 확인했다. 설치 앱(external)을 정상 재실행해 실제 모델 경로와 선택기의 `GPT-6` 검색·이미 사용 중인 모델 표시를 확인하고 저장하지 않고 닫았다. 운영 모델 설정은 그대로다. 임시 Host·브라우저는 종료했다.
- 되돌릴 때는 `current`를 `releases/20261108-bun-7b5e80a`로 교체하고 LaunchAgent를 정상 재시작한다. 데이터·인증 복원은 필요 없다.

### 동적 모델 카탈로그 운영 반영 — 2026-11-08

- 구현 `23d83e1`을 병행 중인 파일 읽기 시트·사이드바와 통합한 `3a21717`을 `releases/20261108-bun-3a21717`에 설치했다. Host와 UI 93개 파일의 설치 사본 해시가 빌드 원본과 일치했다. 분리 루트의 설치 실행 파일에서 health·카탈로그·실제 제공 UI 바이트를 확인했다. 원장 마이그레이션은 없다.
- 표준 제공자는 models.dev의 접점별 활성 모델을 자동 노출한다. Codex는 계정의 모델 API를 별도로 조회한다. 마지막 성공 메타데이터를 캐시하고 6시간 뒤 갱신하며, 저장된 모델 지정·대체 모델·인증은 바꾸지 않는다. 새 MiniMax의 필수 adaptive thinking도 `reasoning_options` 선언으로 처리한다.
- 검사: Host 353개 통과·2개 생략, 계약·Host 타입 검사·실행 파일 빌드, 통합 UI 87개·타입 검사·빌드, 시각 회귀 32개 통과. 서로 다른 제공자의 코드 검토에서 접점 판별·캐시 쓰기 복구·구독 전용 모델 필터·오류 스트림 정리 4건을 수정했다. 분리된 실제 모델 실행에서 GLM Flash·MiniMax M3.1 Flash(`끔` 선택)·M3(`높음` 선택)가 모두 HTTP 200과 계산 결과 `56`을 반환했다.
- 백업 `~/.local/share/ghost/backups/pre-model-catalog-20261108-release/`: `ghost-backup/2`, `complete: true`, 두 DB 무결성 확인, artifacts·secrets·config 사본. 유휴 확인 후 `4cba876`에서 원자적으로 전환하고 Host를 정상 재기동했다(PID 90046 → 97048). 단일 리스너·준비 상태, Ghost 24·대화 40·맡긴 일 39, 저장된 제공자 목록·기본 모델·config 및 인증 파일의 바이트 보존을 확인했다.
- 설치 앱을 external 모드로 새로 읽어 GLM 3종과 MiniMax 3종(기존 Preview 포함)을 확인했다. 네이티브 AX 입력은 거부되어 직접 입력 검증은 같은 운영 UI의 격리 브라우저로 수행했다: 수동 ID 추가→삭제→취소, 기본 모델 선택기에 새 모델 표시, 콘솔 오류 없음. 검증용 ID는 저장하지 않았고 브라우저와 임시 Host를 종료했다.
- 후속 병행 릴리스 `7b5e80a`·`fb34f1f`에도 이 구현이 포함됨을 Git 조상 관계와 운영 API에서 확인했다. 이 기능만 되돌릴 때 기준은 `4cba876`이지만 이후 UI 변경도 빠지므로, 현재 릴리스의 되돌리기 절차를 먼저 따른다. 생성된 `models.json`·`codex-models.json`은 권위 있는 사용자 데이터가 아닌 메타데이터 캐시다.
### 제목 표시줄 아래 패널 위 여백 운영 반영 — 2026-11-08

- 소스 `7b5e80a`(main; 메인 시트의 위 여백 8px — 그 전에는 `margin: 0 8px 8px 0`로 패널 윗변이 제목 표시줄에 바로 붙어 가려진 것처럼 보였다)를 `releases/20261108-bun-7b5e80a`에 설치했다. Host는 당시 운영 `3a21717` 것과 같은 바이트를 복사했다. UI 93개 파일 해시 일치, 백업 DB 사본 위 임시 루트·포트에서 health·새 번들(`main-CD6BUIiB.js`) 확인.
- 검사: UI 테스트 87개·타입 검사·빌드, 시각 회귀(전체 통과; 병행 작업의 Playwright 실행과 임시 루트 충돌로 몇 차례 재실행 후 최종 35개 통과). 설치 앱 창을 영역 캡처로 확인: 패널 윗변이 제목 표시줄 아래 20px쯤에 온전히 보이고 오른쪽 둥근 모서리가 그대로 그려진다.
- 백업 `~/.local/share/ghost/backups/pre-title-gap-20261108-bun-7b5e80a/`: `ghost-backup/2`, `complete: true`, 두 DB `integrity_check` ok. 유휴 확인 후 원자적으로 전환하고 정상 재기동했다(PID 97048 → 1416). 단일 리스너·준비 상태, Ghost 24·대화 40·맡긴 일 39, config 보존 확인.
- 병행 작업 안내: `releases/20261108-bun-bbded27`(521e661) 스테이징이 이 릴리스 아래 커밋 기반이다. 다음 배포는 main 선두(`7b5e80a` 이상)에서 다시 빌드해야 이 여백이 유지된다. 되돌릴 때는 `current`를 `releases/20261108-bun-3a21717`로 교체한다. 저장 형식 변화는 없다.

### 고정 roster·Ghost 풀 사이드바 운영 반영 — 2026-11-08

- 소스 `4cba876`(main; 사이드바 roster를 `고정`(메인 + 고정한 Ghost)과 `Ghost` 풀로 분리, 풀은 스크롤에 붙는 그룹 헤더에서 접고, 접힌 풀은 확인 필요·열린 대화 Ghost만 노출, 8줄 이상 펼치면 필터)을 `releases/20261108-bun-4cba876`에 설치했다. Host는 운영 `36fe9a4` 것과 같은 바이트를 복사했다(이후 Host·계약 변경 없음). UI 93개 파일 해시 일치, 백업 DB 사본 위 임시 루트·포트에서 health·새 번들(`main-D4UOwVyj.js`) 확인.
- 검사: UI 테스트 87개(roster 분리·헤더 접기·접힌 풀의 예외 노출·핀 순서 갱신)·타입 검사·빌드, 시각 회귀 32개(사이드바가 있는 화면 기준 갱신 후 통과). 격리 Host·브라우저에서 고정 그룹·접힌 풀 헤더 `(1)` 표시를 확인했다.
- 백업 `~/.local/share/ghost/backups/pre-pinned-roster-20261108-bun-4cba876/`: `ghost-backup/2`, `complete: true`, 두 DB `integrity_check` ok, artifacts·secrets·skills·config 복사. 유휴 확인 후 원자적으로 전환하고 정상 재기동했다(PID 87287 → 90046). 단일 리스너·준비 상태, Ghost 24·대화 40·맡긴 일 39, config 보존 확인. 설치 앱에서 `고정`(메인)·`Ghost 목록 펼치기 (21)`·진행 중 Ghost 노출을 확인했다.
- 되돌릴 때는 `current`를 `releases/20261108-bun-36fe9a4`로 교체하고 LaunchAgent를 정상 재시작한다. 저장 형식 변화는 없다(고정·펼침 상태는 브라우저 localStorage).

### 파일 읽기 시트 운영 반영 — 2026-11-08

- 소스 `36fe9a4`(main)의 파일 뷰어를 `releases/20261108-bun-36fe9a4`에 설치했다. 병행 중인 사이드바·오버레이 변경을 제외한 분리 작업 트리에서 빌드했고, 운영 Host는 `bdec231`과 같은 바이트를 복사했다. UI 93개 파일 해시 일치, 백업 DB 사본 위 별도 루트·포트에서 설치 사본의 health·기존 식별자·새 번들(`main-_QbmLPm5.js`) 응답을 확인했다.
- UI 테스트 90개·타입 검사·빌드, 뷰어 브라우저 회귀 4개 통과: Markdown 안전 표시·각주 이동·원문/복사/다운로드 바이트 보존, SVG 실제 디코딩·빈 파일·바이너리 저장, 긴 줄 접기·대용량 줄 번호 제한, 불러오는 중 닫기/다시 열기와 URL 회수. 기존 시각 회귀 28개도 구현 중 통과했다. 통합 실행은 다른 작업의 고정 임시 루트 사용과 충돌해 Host가 끊겼으므로, 최종 뷰어 회귀는 별도 `TMPDIR`에서 검증했다.
- 독립 Codex 검토에서 지적한 SVG의 XML 오분류와 줄 번호 메모리 증폭을 수정했다. Chrome·설치된 Mac 셸에서 합성 Markdown·PDF 실제 표시를 확인했고, Mac의 저장 파일이 원본 바이트와 같음을 확인했다. 밝게/어둡게·1440/390px 읽기 화면과 좁은 원문 화면도 확인했다. 문서·DB·인증 저장 형식 변화는 없다.
- 백업 `~/.local/share/ghost/backups/pre-file-sheet-20261108-bun-36fe9a4/`: `db/`는 `ghost-backup/2`, `complete: true`, 생성 시각 `1794136237212`, 두 DB `integrity_check` ok. artifacts·skills·secrets·config를 권한 유지 복사했다.
- 유휴(바쁜 대화·진행 중 Work 0), 이전 링크와 config 해시를 다시 확인한 뒤 원자적으로 전환하고 Host를 정상 재기동했다(PID 63667 → 87287). 새 경로의 단일 리스너·운영 DB·준비 상태, Ghost 24·대화 40·맡긴 일 39의 모든 식별자와 config 보존을 확인했다. 설치 앱(external)을 새로 띄워 기존 `3D 아트 위임 확인`의 `result.py`가 넓은 시트·줄 번호·복사/저장·줄 접기로 열리는 것을 창 캡처로 확인했다. 셸 번들은 교체하지 않았다.
- 되돌릴 때는 `current`를 `releases/20261108-bun-bdec231`로 교체하고 LaunchAgent를 정상 재시작한다. 데이터 복원은 필요 없다.

### 스레드 카드·작성기 개선 운영 반영 — 2026-11-08

- 소스 `bdec231`(main; `f9bfa2c` 위에 끝난 스레드 카드 접기·질문 카드 바로 답하기, 작성기 `/` 명령·`@` Ghost 위임·모델 칩 축약)을 `releases/20261108-bun-bdec231`에 설치했다. Host를 main에서 다시 컴파일했다(바이트가 `f9bfa2c` 빌드와 다름, `bdec231`의 Host 소스는 `f9bfa2c`와 같지만 빌드 시점 차이). UI 93개 파일 해시가 빌드 원본과 일치한다. 설치 사본을 백업 DB 사본 위 임시 루트·포트에서 두 번 실행했다: 기본 config와 운영 `config.json` 사본(`reach`·`skills`·`mac` 포함) 모두 health·새 번들 응답.
- 검사: Host 테스트 328개(+2 생략)·타입 검사, UI 테스트 90개·타입 검사·빌드, 시각 회귀 28개(대화 화면 4장 갱신 후 통과). 격리 Host·브라우저에서 `/` 목록·한글 필터(`/파` → 첨부), `@` 목록에서 Ghost 선택 → 맡기기 토큰에 수신자 표시, 진행 중 카드의 질문과 답변 칩(누르면 결정 해결·카드 정리), 끝난 카드 한 줄 접힘(52px)과 결과 줄 분리를 확인했다.
- 백업: `~/.local/share/ghost/backups/pre-thread-fold-20261108-bun-bdec231/`, `ghost-backup/2`, `complete: true`, 두 DB `integrity_check` ok, artifacts·secrets·skills·config 복사. 전환 직전 `current`가 여전히 `f9bfa2c`이고 `config.json` 변경 시각이 19:08 그대로임을 확인했다.
- 유휴(바쁜 대화·진행 중 Work 0) 확인 후 `current`를 원자적으로 교체하고 Host를 정상 재기동했다(PID 54254 → 63667). 단일 리스너·실행 경로·준비 상태(`provider zai-coding is ready`), Ghost 24·대화 40·맡긴 일 39, config 바이트 보존을 확인했다. 설치 앱(external)을 다시 띄워 메인 대화에서 뒤로/앞으로 단추와 끝난 스레드들이 한 줄로 접힌 것을 확인했다(대화 기록이 길어 접근성 트리에서 하단 작성기는 잘렸다 — 별도 브라우저 확인으로 대체).
- 되돌릴 때는 `current`를 `releases/20261108-bun-f9bfa2c`로 교체하고 LaunchAgent를 정상 재시작한다. 저장 형식 변화는 없다.

### Ghost 팀 인프라 운영 반영 — 2026-11-08

- 소스 `fa25e91`(브랜치 `ghost-team`: `d1dbfc1` 계약·원장, `adf1742` 기능, `a95b11e` 리뷰 수정, `b149db1` main 병합, `a71402d`·`fa25e91` UI)을 `releases/20261108-bun-fa25e91`에 설치했다. 먼저 `a71402d`를 설치해 확인한 뒤 실행 승인 카드의 중복 문구만 고친 `fa25e91`로 다시 바꿨다. 원장은 마이그레이션 4(`ghosts.fallbacks`·`skills`·`deleted_at`)로 `user_version` 4가 됐다. 이전 Host는 이 열과 새 config 키를 읽지 못한다.
- 기능: 웹 조사(`web_search`·`web_read`·`reach`, agent-reach 읽기 전용), Ghost별 스킬(`~/.agents/skills`의 SKILL.md를 지시문에 포함, `skill_read`, `GET /api/skills`), Ghost별 대체 모델(최대 3개, 재시도 가능한 오류·한도·쿼터·자격 없음일 때 다음 모델로 같은 턴 이어가기), Mac 도구(`host_*` 읽기 7종 + 승인형 `host_command_propose`)와 `mac.watch` 상주 점검, 위임 개선(자기 위임 거부, `reviewer_ghost_id`, 동료 목록에 모델·image·web·host 표시, 변경 시 목록 갱신), Ghost 삭제(`ghost.delete`, 은퇴 Ghost만, 기록은 tombstone), 사이드바(8명 이상이면 주요 Ghost + `+N` 펼침·검색·고정, 은퇴·삭제 숨김).
- 검사: Host 328개(+2 생략: Apple container, CI 환경의 실제 du), 타입 검사, UI 88개, `tsc -b`, 시각 회귀 28개(team·work 8장은 기대한 변경으로 갱신). 독립 검토: 대체 모델·Mac 도구(Codex 작성 → Claude 검토), 웹·스킬·위임(GLM 작성 → Claude Opus 검토), 계약·삭제(Claude 작성 → Codex 검토). 지적 P1 2건·P2 13건을 고치고 회귀 테스트를 더했다. 같은 검토에서 남은 P3: agent-reach가 띄운 자식 프로세스는 Bun에 프로세스 그룹 종료가 없어 `REACH_API_SUPERVISED=1`로만 감독한다. 삭제 시 연결된 iPhone 화면은 다음 스냅숏까지 남는다(요청은 거부됨).
- 백업: `~/.local/share/ghost/backups/pre-team-20261108-a71402d/`(`ghost-backup/2`, `complete: true`, 두 DB `integrity_check` ok, artifacts·secrets·config 복사, 직전 Ghost 설정 `ghosts-before-v3.json`). 설치 사본을 백업 DB 사본 위 임시 루트·포트에서 실행해 health·`user_version` 4·Ghost 24·대화 40·맡긴 일 39·`/api/skills` 25개를 확인했다.
- 유휴(바쁜 대화·진행 중 Work 0) 확인 후 config에 `reach`·`skills`·`mac`을 넣고 `current`를 원자적으로 교체해 Host를 정상 재기동했다(PID 26248 → 43570 → 49085). 단일 리스너·실행 경로·준비 상태(`provider zai-coding is ready`)를 확인했다. 운영 실측: 리서치가 `web_search`로 실제 결과를 가져왔고, 3D 아트가 `skill_read`를 썼다. Mac 관리는 첫 점검 기준 검토를 받아 host 도구로 `com.a7.infra.git-sync` 마지막 실행 실패(exit 1)를 찾고, 읽기 전용 `cat` 실행 승인을 요청했다(소유자 결정 대기). 재기동 뒤 일일 검토가 중복되지 않았다. 설치 앱(external)에서 `+20` 사이드바와 실행 승인 카드를 창 캡처로 확인했다.
- 로스터 정리: `specialist-engineering`·`specialist-operations` 삭제(tombstone). 활성 22개. Codex `gpt-6.1-sol`(대체: `gpt-6-luna` → `glm-5.3`): 메인·디자이너·3D 아트·플레이테스터·콘셉트·보안 점검. Codex `gpt-6-luna`(대체: `glm-5.3` → MiniMax): 레퍼런스. MiniMax(대체: `glm-5.3` → `gpt-6-luna`): 사용량·이슈 정리. 나머지 GLM `glm-5.3`(대체: MiniMax → `gpt-6-luna`). 웹 도구는 고객 응대·밸런스·플레이테스터·사용량·기억 관리를 뺀 Ghost, Mac 읽기 도구는 보안 점검, Mac 전체 도구는 Mac 관리만 가진다. 스킬: 메인·패널·하네스 회고·사용량 `agent-orchestra`(하네스 회고는 `agent-harness-construction`·`agent-introspection-debugging` 추가), 디자이너·콘텐츠 작가·SNS·고객 응대·레퍼런스 `anti-slop`, 3D 아트 `blender-general`·`tripo`·`game-asset-studio`, 기획·플레이테스터·밸런스 `game-dev-workflow`, 콘셉트 `anti-slop`·`pixel-art-aseprite`·`game-asset-studio`, 문서 작가 `anti-slop`·`a7garden-blog`·`portable-document-contract`, 리서치·경쟁 분석·AI 소식·이슈 정리 `agent-reach`, 보안 점검·Mac 관리 `pc-infra`. 웹을 얻은 Ghost의 역할 지시에서 "웹에 접근하지 못한다"를 지웠다.
- Macfra: 상주 에이전트 `dev.garden.macfra.agent`를 `launchctl bootout` 후 `launchctl disable`로 껐다(plist와 앱은 그대로). Macfra의 메일 승인 경로는 옮기지 않았고, 승인은 Ghost 앱·iPhone의 실행 승인으로 한다. 되살릴 때는 `launchctl enable gui/$(id -u)/dev.garden.macfra.agent && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.garden.macfra.agent.plist`.
- 통합: `ghost-team`과 `main`의 `1e87198`(제목 표시줄 탐색·사이드바 스크롤 레일)·`ed2f526`을 합친 `f9bfa2c`를 `main`에 fast-forward로 올리고 `releases/20261108-bun-f9bfa2c`에 설치했다. 사이드바는 `1e87198`의 스크롤 프레임·레일 안에 주요 Ghost + `+N` 접기를 넣었다. Host 328개·UI 90개·`tsc -b`·시각 회귀 28개(team·work 8장 갱신) 통과, 백업 `backups/pre-merge-20261108-f9bfa2c/`(두 DB `integrity_check` ok, config 사본), 임시 루트 시험 실행 후 유휴에서 전환(PID 51934 → 54254)했다. 설치 앱에서 제목 표시줄 뒤로/앞으로와 `+20` 사이드바를 창 캡처로 확인했다.
- 되돌리기: `current`를 `releases/20261108-bun-fa25e91`(같은 Host·스키마, `1e87198` UI 제외)로 바꾼다. 마이그레이션 4 이전 릴리스(`5bbeacb`, `1e87198`)는 원장 `user_version` 4를 거부하고 새 config 키(`reach`·`skills`·`mac`)도 거부하므로, 그쪽으로 되돌리려면 `config.json`과 두 DB를 `backups/pre-team-20261108-a71402d/`로 복원해야 하고 그 사이의 변경을 잃는다. 데이터 복원이므로 별도 승인을 받는다.

### 제목 표시줄 탐색·사이드바 스크롤 릴리스 대기, 잘못된 전환 복구 — 2026-11-08

- `main`의 `1e87198`(제목 표시줄 뒤로/앞으로·breadcrumb, 사이드바 roster 스크롤·레일, 스레드 패널 열고 닫기 애니메이션, 빈 대화의 초상 제거)을 `releases/20261108-bun-1e87198`에 설치·검증했다(UI 93개 파일 해시 일치, 임시 루트 시험 실행, 백업 `backups/pre-title-nav-20261108-bun-1e87198/`, `ghost-backup/2` complete, 두 DB `integrity_check` ok).
- 전환 1분 전(19:16 KST) `wt/ghost-team` 작업이 `releases/20261108-bun-fa25e91`을 배포하고 운영 `config.json`에 `reach`·`skills`·`mac`을 추가한 것을 확인하지 않고 `current`를 `1e87198`로 바꿨다. `main`의 Host는 `reach`를 모르는 키로 거부해 재기동하지 못했다(`config.json: unknown key reach`, 약 2분 중단).
- `current`를 원자적으로 `releases/20261108-bun-fa25e91`로 되돌리자 LaunchAgent가 Host를 다시 띄웠다(PID 51934). health·준비 상태(`provider zai-coding is ready`), Ghost 24·대화 40·맡긴 일 39를 확인했다. 데이터·설정 파일은 바꾸지 않았다.
- `1e87198`은 `ghost-team`과 합쳐질 때까지 대기 중이다. 두 브랜치가 `WorkspaceSidebar.tsx`·`compositions.css`·`App.tsx`를 함께 바꿨으므로 통합 빌드를 검증한 뒤에 배포한다. 전환 직전에는 `current`의 대상과 `config.json` 변경 시각을 다시 확인한다.

### 사람이 읽는 보고·참조 표식·대화 지도 스크롤 운영 반영 — 2026-11-08

- 소스 `176d1d6`(+ 후속 UI `e82cf30` 줄인 id의 고유 접두 해석, `5bbeacb` 코드 스팬 id의 괄호 흡수)를 `releases/20261108-bun-5bbeacb`에 설치했다. Host 변경은 직접 대화·작업 지시문(`OWNER_VOICE`: 소유자에게는 id·해시·바이트·종료 코드·도구 이름 없이 결과부터 말하기, 보고를 되풀이하지 않기, `complete` 요약 첫 문장과 `ask_owner` 질문도 사람용)뿐이고 계약·DB 스키마·셸은 그대로다. 컴파일 Host는 `176d1d6` 빌드를 그대로 썼고(이후 Host·계약 변경 없음, 바이트 일치) UI 93개 파일 해시가 빌드 원본과 일치한다. 설치 사본을 백업 DB 사본 위 임시 루트·포트에서 실행해 health·새 번들을 확인했다.
- UI: 끝난 Work의 보고와 위임 결과는 스레드 카드에서 돌아오는 OutcomeLine(상태 색 갈고리·알약, 파일 칩, 실패 사유)으로, 다른 Host 깨움은 한국어 한 줄 + 접힌 원문으로 보인다. 담당·판정·걸린 시간·식별자·크기·해시는 Peek(호버·키보드 포커스, 클릭 복사)로 옮겼다. 응답 본문의 UUID·줄인 id·해시는 RefMark(Work 상태 표식은 스레드를 열고, Ghost 얼굴, 파일 아이콘, 그 밖은 #)로 바뀐다. 대화 스크롤은 TranscriptRail(가는 thumb, 소유자 발화·스레드·돌아온 Work 눈금, 호버 이름·클릭 이동·끌기 탐색)로, 그 밖의 스크롤바는 트랙 없는 알약으로 바꿨다.
- 검사: Host 테스트 246개(+1 생략)·타입 검사, UI 테스트 71개(참조 분리·괄호 흡수·깨움 해석 추가)·타입 검사·빌드, 시각 회귀 28개(대화 화면 4개 기준 갱신 후 재통과; 모의 제공자가 보고 응답에 Work id를 되풀이해 표식 렌더링을 고정). 격리 Host·브라우저에서 Peek 호버, 표식 클릭 → 스레드 패널, 레일 눈금 호버·클릭 이동, thumb 끌기(77 → 0, 놓은 뒤 최신 따라가기로 튀지 않음)를 확인했다.
- 백업: `~/.local/share/ghost/backups/pre-human-reports-20261108-bun-{176d1d6,e82cf30,5bbeacb}/`, 각각 `ghost-backup/2`, `complete: true`, 두 DB `integrity_check` ok, artifacts·secrets·config 복사. 마지막 시각 `2026-11-08T09:48Z` 전후(`created_ms` 1794131315049).
- 유휴(바쁜 대화·진행 중 Work 0) 확인 후 세 번 `current`를 원자적으로 교체하고 Host를 정상 재기동했다(PID 39276 → 20886 → 23268 → 26248). 실행 파일·운영 DB·단일 리스너·준비 상태(`provider zai-coding is ready`), Ghost 23·대화 39·맡긴 일 39, config·secrets 보존을 확인했다. 설치 앱(external)을 정상 종료·백그라운드 재실행하고 메인 대화를 열어, 운영 데이터의 `3D 아트 위임 확인` 보고가 OutcomeLine + `result.py` 칩으로, 기존 응답의 id·해시·줄인 id가 표식으로 보이는 것을 창 캡처로 확인했다.
- 되돌릴 때는 `current`를 `releases/20261108-bun-9db4166`으로 교체하고 LaunchAgent를 정상 재시작한다. 저장 형식 변화는 없다.

### Ghost 설정·입력창 + 메뉴·첨부·데스크톱 아바타 운영 반영 — 2026-11-08

- 소스 `9db4166`의 Host·UI·Mac 셸을 `releases/20261108-bun-9db4166`에 설치했다. 계약·DB 스키마는 그대로다. 새 Owner API `POST /api/artifacts`(첨부 업로드, 20 MiB, 소유자 전용)와 첨부 내용의 모델 전달(이미지: 모델 카탈로그상 이미지 입력 모델만, 파일 4 MiB·메시지 8 MiB / 텍스트: 파일 100 KiB·메시지 200 KiB, 넘치면 생략 사유 표시)이 추가됐다. 컴파일 Host 바이트와 UI 93개 파일 해시가 빌드 원본과 일치한다. 설치 사본을 백업 DB 사본 위 임시 루트·포트에서 실행해 health·UI·`companion.html`·첨부 업로드 응답을 확인했다.
- UI: 설정의 아바타 보관함과 창 안 펫을 없애고 `데스크톱 아바타` 탭을 추가했다. 꾸미기는 모습만 다루고 이름·메인·상태·모델·역할·도구·샌드박스는 새 Ghost 설정 시트로 옮겼다. 입력창 왼쪽 아래 + 메뉴(사진·파일 첨부·일로 맡기기·나중에 보내기), 모델 선택은 보내기 옆. 프로젝트 화면을 새 구성 요소로 다시 짰다.
- Mac 셸: 투명·항상 위·모든 Space의 `companion` 창, 위치·표시 상태 저장, 기본 메뉴, 메인 창 닫기 시 숨김·Dock 재열기. 앱을 정상 종료(`quit`)한 뒤 임시 서명한 새 번들로 교체했고 `codesign --verify --strict` 통과, 아이콘 원본 일치. 이전 앱은 백업의 `Ghost.app`.
- 검사: Host 테스트 246개(+1 생략)·타입 검사, UI 테스트 63개·타입 검사·빌드, 시각 회귀 28개(홈·대화·Ghost 설정·프로젝트 기준 갱신 후 재통과), Rust fmt·clippy·테스트 12개, 격리 Host에서 첨부 업로드→전송→모델 요청, 일로 맡기기, 나중에 보내기, Ghost 설정 도구·상태 변경, 빌드 번들 데스크톱 아바타(표시·클릭·드래그·재실행 위치·설정 손상 시 기동·메인 창 복구) 확인. 독립 검토(첨부: Claude, 셸: Claude) 지적 P1 3건·P2 3건 반영.
- 백업: `~/.local/share/ghost/backups/pre-ghost-settings-20261108-9db4166/`, `ghost-backup/2`, `complete: true`, 두 DB `integrity_check` ok, artifacts·secrets·config 복사, 이전 `Ghost.app` 사본 서명 유효. 시각 `2026-11-07T16:09Z`.
- 유휴 확인 후 `current`를 원자적으로 교체하고 Host를 정상 재기동했다(PID 3071 → 39276). 실행 파일·준비 상태, Ghost 4·대화 9·맡긴 일 32, config·secrets 보존 확인. 새 앱에서 설정 → 데스크톱 아바타를 켜 데스크톱 오른쪽 아래에 `primary`가 상태 말풍선과 함께 뜨는 것을 화면 캡처로 확인하고 다시 껐다(기본값 꺼짐 유지).
- 되돌릴 때는 `current`를 `releases/20261108-bun-79bd394`로 교체하고 LaunchAgent를 정상 재시작하며, 앱을 종료하고 백업의 `Ghost.app`으로 바꾼다. 저장 형식 변화는 없다(업로드한 첨부 바이트는 artifacts에 남는다).

### Ghost 팀 구성 — 2026-11-08

- 소유자 요청으로 omp 오케스트레이션 역할과 실제 사용 패턴을 기준으로 Owner API에서 재구성했다. 릴리스 변경은 없다.
- 사용 패턴: 사용자 프롬프트가 있는 Codex 루트 세션 529개(보관 `archived_sessions/*.jsonl.zst` 409개 포함)와 omp 세션 110개, 모두 639개를 세션 단위로 분류했다(`zai/glm-5.3-flash` 분류기, 근사치). 코드 구현 169, UI/UX 디자인 109, 게임 기획 79, 에이전트·하네스 설정 79, 3D·Blender·Tripo 64, 인프라 58, 리뷰·QA 28, 리서치 23, 글 12, 픽셀 3.
- 활성: `메인`(기본, `codex/gpt-6.1-sol` high, 기존 도구 전부, 위임·검토·omp로 넘길 일 분류), `디자이너`(UI/UX 설계·스크린샷 검수·안티슬롭 문구 검수), `3D 아트`(에셋 설계·미실행 bpy 스크립트·Tripo 구분·렌더 검수), `기획`(게임 목표·성장·시스템·콘텐츠·월드). 디자이너·3D 아트는 시각 판단에 이미지 입력이 필요해 `codex/gpt-6.1-sol`, 기획은 `zai-coding/glm-5.3` high. 세 Ghost 모두 `delegate`·`schedule_*`·`ghost_list`·`memory_retain`이 없다.
- 은퇴: `specialist-engineering`·`specialist-operations`. Ghost 삭제 명령은 없어 `retired`로 둔다.
- 직접 수행하는 Ghost를 두지 않은 일: 코드 구현, 인프라 조작, 하네스 설정 변경, 픽셀 아트, 웹 조사. Work 샌드박스는 네트워크가 없고 이미지에 `python3`·`node`·`git`·`jq`·Blender가 없으며(perl·awk·sed·coreutils만) 저장소·호스트·앱에 닿지 않는다. 이런 일은 omp 세션에 남긴다. 아래 확장의 리서치·하네스 회고 등은 첨부 자료 분석까지만 한다.
- 검토 경계: GLM(텍스트 전용)·MiniMax는 이미지 입력이 없고 Anthropic 제공자가 없어, Codex가 만든 시각 결과의 검토도 Codex(메인)가 한다. 이 검토를 다른 vendor의 독립 검토로 치지 않는다. 기획(GLM)의 결과는 메인(Codex)이 검토하므로 vendor가 갈린다.
- 메인 직접 대화(`01a146f5-42fa-…`)에는 소유자가 고른 대화 모델 `zai-coding/glm-5.3`이 남아 있어 그 대화는 GLM으로 답한다. 메인의 Work·검토는 Ghost 모델(Codex)을 쓴다.
- 확인: 디자이너 직접 대화에 UI 스크린샷을 첨부해 화면 속 문구를 그대로 인용한 지적을 받았다(이미지 파트 1, `codex/gpt-6.1-sol`). 메인 Work가 3D 아트에게 bpy 스크립트를 위임 → 메인 검토 통과(미실행임을 확인) → 루트 Work가 `artifact_contains` 검사로 `done`. 앞선 작가 위임 확인에서는 하위 Work가 `zai-coding/glm-5.3`이었다. 모든 확인에서 오류 0건.
- 확장(같은 날, 소유자 요청 "모두 고스트로"): `ashishpatel26/500-AI-Agents-Projects`에서 고른 아이디어 17개를 Ghost로 만들었다. 은퇴했던 `작가`는 `문서 작가`, `specialist-research`는 `리서치`로 바꿔 다시 켰다.
  - Codex `gpt-6.1-sol`(이미지 입력·강한 판단): 플레이테스터, 콘셉트, 보안 점검. Codex `gpt-6-luna`: 레퍼런스. MiniMax `MiniMax-M3.1-Flash-Preview`: 사용량, 이슈 정리. 나머지 GLM `glm-5.3`: 패널, 콘텐츠 작가, 밸런스, SNS, 고객 응대, 경쟁 분석, 하네스 회고, 기억 관리, AI 소식, 문서 작가, 리서치.
  - 도구는 기획과 같은 16개다. `패널`만 `delegate`를 더 가져 같은 질문을 Codex Ghost와 GLM Ghost에 따로 맡기고 비교한다. 메인 페르소나는 동료 목록의 첫 줄 역할로 위임 대상을 고르도록 바꿨다.
  - 웹·호스트가 필요한 역할(리서치, 경쟁 분석, AI 소식, 이슈 정리, 하네스 회고, 사용량, 보안 점검)은 소유자가 첨부한 자료로만 일하고, 웹·호스트가 필요한 부분은 확인 필요로 남긴다고 페르소나에 적었다. 콘셉트는 이미지 생성 도구가 없어 시안 브리프와 비평만 한다.
  - 확인: 새로 만들거나 바꾼 Ghost 17개가 직접 대화에서 역할과 못 하는 일을 답했고, `pi.db` 메타데이터로 각 Ghost가 지정한 제공자·모델로 응답했다(MiniMax와 Luna는 Ghost에서 처음 사용). 패널 Work가 디자이너(Codex)와 기획(GLM)에 따로 위임 → 각 하위 결과를 패널이 검토 통과 → `artifact_contains` 검사로 `done`.
  - 운영 위험: GLM 대화 12개를 동시에 깨우자 `zai-coding`이 429를 돌려줬고 Pi 재시도로 모두 응답했다(대화마다 오류 엔트리 3건). GLM Ghost를 한꺼번에 많이 돌리면 응답이 늦어진다.
- 되돌릴 때는 `~/.local/share/ghost/backups/pre-roster-20261108/`의 `ghosts-before-v3.json`(확장 직전), `ghosts-before-v2.json`(디자이너·3D 아트 추가 직전), `ghosts-before.json`(첫 재구성 직전) 중 하나의 이름·페르소나·모델·상태·도구로 `ghost.update`를 보내고, 그 시점에 없던 Ghost는 `retired`로 바꾼다.

### Ghost 배경 제거 운영 반영 — 2026-11-08

- 소유자 결정: Ghost에는 배경이 없다. 소스 `79bd394`의 UI를 `releases/20261108-bun-79bd394`에 설치했다(꾸미기의 배경 줄·아바타 배경색 선택·초상 배경 제거, 저장된 `look.background`는 무시). Host는 `0a7ca7c`과 소스·바이트가 같아 그대로 복사했고 UI 85개 파일 해시가 빌드 원본과 일치한다. 운영 Ghost 4개의 `look.background`는 이미 모두 비어 있어 데이터 변경은 없다.
- 검사: UI 테스트 69개·타입 검사·빌드, 시각 회귀 28개 통과. 설치 사본을 백업 DB 사본 위 임시 루트·포트에서 실행해 health·UI 응답을 확인했다.
- 백업: `~/.local/share/ghost/backups/pre-no-background-20261108-79bd394/`, `ghost-backup/2`, `complete: true`, 두 DB `integrity_check` ok, artifacts·secrets·config 복사. 시각 `2026-11-07T15:22Z`.
- 유휴 확인 후 `current`를 원자적으로 교체하고 Host를 정상 재기동했다(PID 96122 → 3071). 실행 파일·준비 상태, Ghost 4·대화 9·맡긴 일 32, config·secrets 보존을 확인했다. 설치 앱에서 꾸미기를 열어 배경 줄이 없는 것을 확인하고 닫았다.
- 되돌릴 때는 `current`를 `releases/20261108-bun-0a7ca7c`로 교체하고 LaunchAgent를 정상 재시작한다.

### 채팅 다듬기·기억 직렬화·위임 표시 운영 반영 — 2026-11-08

- 소스 `0a7ca7c`의 Host·UI를 `releases/20261108-bun-0a7ca7c`에 설치했다. 계약·DB 스키마·셸은 그대로다. 컴파일 Host 바이트와 UI 85개 파일 해시가 빌드 원본과 일치한다. 설치 사본을 백업 DB 사본 위 임시 루트·포트에서(메모리 설정 없이) 실행해 실제 `primary` 대화가 새 렌더링으로 열리고 모델 칩 `glm-5.3`의 아랫부분이 잘리지 않는 것을 확인했다.
- 원인 조사(운영 DB 사본): 도구 결과 13건 중 실패 4건. `memory_search` 1건은 한 응답의 병렬 호출 두 개 중 두 번째가 Oxibrain 저장소 잠금에 걸린 것이고, `present_ui` 3건은 차트 `points`를 최상위에 둔 2건과 비교표 열에 행 제목을 넣은 1건이다. 기억 작업을 한 줄로 직렬화하고 각 자식 프로세스를 다음 실행 전에 회수(SIGTERM, 2초 뒤 SIGKILL, 4초 상한)하도록 고쳤고, `present_ui` 설명·오류에 형식 규칙을 넣었다. 운영 config 변경은 없다.
- 협업 점검: 운영에서 위임은 한 번도 일어나지 않았다(Work 32개 모두 루트). 작업 대화에는 `delegate`만 있고 `ghost_list`가 없어 유효한 `ghost_id`를 알 수 없었으므로, `delegate`를 가진 Ghost의 작업 지시에 활성 동료 목록을 넣었다. UI는 위임 이벤트 줄, 스레드 카드의 위임 Ghost, `위임 결과 대기`, Work 페이지 작업 대화의 실시간 표시를 추가했다. 작업 중 Ghost 간 메시지 채널은 아직 없다.
- 검사: Host 테스트 239개(+1 생략)·타입 검사, UI 테스트 69개·타입 검사·빌드, 시각 회귀 28개(대화 화면 4개 기준 갱신 후 재통과), 격리 Host·모의 제공자에서 스트리밍·우클릭 메뉴·꾸미기 무작위 저장·위임 표시 확인. 독립 검토(기억 직렬화: Claude, 위임 목록·종료 처리: Codex) 결과 P2 한 건(회수 대기 상한)을 반영했다.
- 백업: `~/.local/share/ghost/backups/pre-chat-polish-20261108-0a7ca7c/`, `ghost-backup/2`, `complete: true`, 두 DB `integrity_check` ok, artifacts·secrets·config 복사·비교. 시각 `2026-11-07T15:05Z` 전후.
- 유휴(바쁜 대화·진행 중 Work 0) 확인 후 `current`를 원자적으로 교체하고 Host를 정상 재기동했다(PID 67594 → 96122). 실행 파일·운영 DB·단일 리스너·준비 상태(`provider zai-coding is ready`), Ghost 4·대화 9·맡긴 일 32·프로젝트 0, config·secrets 보존을 확인했다. 설치 앱(external)이 새 UI로 다시 읽혔고, 접근성 클릭으로 `primary` 대화 → 프로필 → 꾸미기 대화상자(무작위 포함)를 열어 확인한 뒤 바꾸지 않고 닫았다.
- 되돌릴 때는 `current`를 `releases/20261107-bun-f4f05fb`로 교체하고 LaunchAgent를 정상 재시작한다. 저장 형식 변화는 없다.

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
models.json   codex-models.json (자동 갱신 메타데이터 캐시)
artifacts/sha256/…   skills/…   secrets/<provider>.json (0600)   sandboxes/<ghost>/<work>/workspace
```

`config.json`은 `publicOrigin`, `uiDir`, `sandbox`(`local` 또는 `apple-container`), `memory`(Oxibrain; `spaces`는 Ghost id → space, `*`는 나머지 모든 Ghost), `apns`를 담는다. 환경 변수는 `GHOST_ROOT`, `GHOST_PORT`, `GHOST_HOST`, `GHOST_PUBLIC_ORIGIN`, `GHOST_UI_DIR`만 읽는다.


## 승인 대기와 반복 실행 (2026-11-10)

- 맡긴 일 `c54a2f86`의 반복 모델 턴만 소유자 API로 중단했다. 원래 승인 요청과 작업을 보존한 채 `waiting`으로 전환됐다.
- `main`의 `6cf135e`, `87b78e9`를 당시 운영판 `c572f91`에 적용해 `releases/20261110-bun-eeeeb02`를 만들었다. 승인 대기 작업의 다음 모델 호출을 막고, 결정 결과는 기존 제출 ID로 재개한다. 진전 없이 같은 결과가 이어진 도구 라운드는 8회에서 턴을 끝낸다. Ghost가 생성한 맡긴 일의 기본 기한은 90분이며 기존 기한 연장은 소유자 작업 수정에서 한다.
- 배포 후보 Host 테스트 621개 통과, 6개 건너뜀, 타입 검사 및 격리된 루트에서 health·인증 API·UI 확인. 백업 `backups/pre-20261110-bun-eeeeb02-1794307084578/`의 원장·Pi·금고 DB 무결성을 검증했다. 전환 후 PID 16242 → 57727, 단일 리스너, 모델 준비, 기존 데이터 ID와 대상 작업의 승인 대기를 확인했다.
- 설치된 Mac 앱의 external Host 프로브가 새 PID에 연결됐다. 브라우저에서 실제 작업 상세와 승인 대기를 확인했다. 현재 Mac 창의 접근성 상호작용은 확인할 수 없었다. 되돌릴 때는 유휴를 확인하고 `current`를 `releases/20261110-bun-c572f91`로 원자적으로 전환한 뒤 Host를 정상 재기동한다.

## 확인

```sh
curl -fsS http://127.0.0.1:62062/api/health
```

실행 중 Host의 준비 상태는 인증된 `GET /api/state`로 확인한다. `ghost doctor`는 DB와 엔진을 열기 때문에 운영 루트에 쓰지 않는다. 필요하면 별도 임시 상태 루트에만 실행한다.

## 제공자 설정

웹·Mac UI에서 **설정 → 모델 → 제공자 추가**를 열고 OpenAI, Anthropic, Google Gemini, Z.AI Coding Plan, MiniMax 또는 OpenAI 호환 서버를 선택한다. 구현 변경은 위의 자동 운영 반영 절차로 설치한다.

- 기본 이름·ID·주소를 채워 준다. API 키를 저장하면 해당 공식 접점의 모델이 대화·Ghost 모델 선택기에 자동으로 나타난다. 제공자 설정에서 모델을 하나씩 켤 필요는 없다. **API 키 발급**은 각 제공자의 공식 키 관리 페이지를 연다.
- 모델은 [models.dev](https://models.dev/api.json)에서 자동 갱신한다. 기동 시와 매시간 확인하며, 마지막 성공 후 6시간이 지나면 다시 가져온다. 신규 호환 모델은 Ghost 코드 수정·재배포 없이 반영된다. Z.AI Coding Plan과 일반 API 목록은 구분한다. 목록은 계정의 실제 호출 권한을 보증하지 않는다. OpenAI 호환 서버·사용자 지정 주소는 모델 ID를 직접 등록한다.
- **고급 설정**에서 이름·내부 ID·API 형식·서버 주소를 바꾼다. 기존 ID는 고정이며, 같은 제공자를 추가하면 새 ID를 배정한다. API 형식을 바꿀 때는 새 API 키를 입력하거나 기존 인증 정보를 명시적으로 삭제한다.
- 기존 제공자를 저장할 때 API 키를 비워 두면 저장된 인증을 유지한다. 직접 추가한 모델과 기존 모델 지정은 보존하며, 알려진 ID의 이미지 입력·추론·컨텍스트·출력 한도는 최신 카탈로그를 따른다. 직접 추가한 ID는 제공자 설정에서 삭제할 수 있다.
- 저장 후 **기본 모델** 또는 Ghost별 모델을 선택한다. 인증 상태 표시는 키/OAuth의 저장 여부이며 실제 모델 호출 성공을 뜻하지 않는다.
- 네트워크·카탈로그 오류가 나면 마지막 성공 목록을 계속 사용하고, 캐시가 없으면 설치된 SDK 목록을 사용한다. `models.json`은 공개 API 메타데이터, `codex-models.json`은 해시된 계정 식별자에 묶인 구독 모델 메타데이터다. 토큰과 원격 지시문은 캐시에 저장하지 않는다.
- 추론 방식도 카탈로그 선언을 따른다. 추론을 끌 수 없는 모델에서 `끔`을 선택하면 저장된 설정은 유지하되 실제 요청은 지원되는 최저 추론 수준으로 보낸다. MiniMax의 adaptive thinking도 모델 이름별 코드 없이 처리한다.

설정 흐름은 [OpenCode의 제공자 선택·인증·모델 선택](https://github.com/anomalyco/opencode/blob/21bf6b493b76efcf3769ade999f05163760d61af/packages/app/src/settings/providers/providers.tsx)과 [Cherry Studio의 기본 주소·모델 목록](https://docs.cherryai.com.cn/docs/en-us/pre-basic/providers/openrouter.md)을 참고했다. 외부 앱의 코드나 시각 자산은 복사하지 않았다.

## OpenAI OAuth

**설정 → 모델 → 제공자 추가 → OpenAI**에서 **ChatGPT 구독 → ChatGPT로 로그인**을 누른다. 서버 주소는 비워 둔다. 표시된 코드를 **인증 페이지 열기**에서 입력하고 승인한다. 계정에서 기기 코드 로그인을 허용해야 한다. 로그인 뒤에는 해당 계정의 Codex 모델 목록을 자동 조회한다.

Mac 앱의 **인증 페이지 열기**·**API 키 발급**과 대화의 웹 링크는 기본 브라우저로 연다. 웹뷰의 Host 전용 이동 제한은 유지하며, 네이티브 명령은 HTTP(S) 주소만 허용한다. 열기에 실패하면 링크 옆에 오류를 표시하고 다시 누를 수 있다. 일반 웹 브라우저의 링크 동작은 바꾸지 않는다.

로그인 완료 후 기본 모델 또는 Ghost의 모델로 해당 제공자를 선택한다. ChatGPT OAuth는 Codex 경로를 사용하며 일반 OpenAI API 키와 별개다. 지원 모델·구독·조직 정책은 해당 계정의 허용 범위를 따른다.

인증 정보는 Host의 `secrets/<provider>.json`에만 저장한다(0600). 만료 전 자동 갱신하며 새로고침 토큰도 원자적으로 교체한다. 로그인 취소는 기존 인증 정보를 유지한다. 로그아웃은 제공자 설정의 **고급 설정 → 저장된 인증 정보 삭제**를 선택한 뒤 저장한다. API 키로 전환하려면 인증 방법을 **API 키**로 바꾸고 새 키를 입력해 저장한다. Host를 재시작하면 미완료 로그인만 다시 시작해야 한다.

## 자동 활동과 PC 실행

1. **설정 → 연결 계정**에서 GitHub/Gitea 토큰 또는 IMAP/SMTP 앱 암호를 저장하고 연결을 확인한다. 값은 다시 표시하지 않는다. SMTP는 implicit TLS 또는 STARTTLS를 요구하며 연결 검사는 메일을 보내지 않는다. 운영 메일·PR을 시험 대상으로 자동 선택하지 않는다.
2. **설정 → 자동 활동**에서 Ghost, 예약/PR/메일 원본, 조건, 지시·완료 기준, 도구, 실행 환경, 시간·일일·동시 한도와 알림을 설정한다. PR 댓글·메일 회신은 금지/승인/허용 중 고른다. 이는 원본에 묶인 답글 정책이며 일반 브라우저·PC 명령을 격리하지 않는다.
3. PC를 쓰려면 **Ghost 설정 → PC 직접 실행**을 별도로 허용하고 맡긴 일/활동에서 PC와 절대 cwd를 고른다. cwd 밖 파일·네트워크·자격에도 OS 권한으로 접근할 수 있다. 기존 Ghost는 자동 허용되지 않는다. 컨테이너 선택은 드라이버가 없어도 PC로 대체하지 않으며, 셸 없이 격리 파일/API 작업만 가능하다.
4. 시험 실행 뒤 기록·보류 사유·오류·한도를 확인한다. 읽기 전용 시험은 운영 커서를 진행하거나 원본에 답글을 보내지 않는다. 일시 중지는 새 실행만 막고, 실행도 중지하는 선택과 **모두 중지**는 하위 맡긴 일과 프로세스까지 취소한다.
5. 계정 주소·자격 교체는 기존 실행 권한을 끊는다. 새 자격 입력 또는 저장 자격 제거를 명시하고 연결을 다시 확인한다. 이름만 바꾸면 커서와 자격은 보존한다. 결과가 불명확한 전송은 다시 누르지 말고 효과를 대사한다.

원장 마이그레이션 7은 운영 마이그레이션 6의 질문·수정 이력을 유지하고 PC 권한·Work 실행 범위·`connections`·`activities`·`activity_runs`를 추가한다. 스키마 6 Host로 링크만 되돌리면 원장을 거절한다. 스키마 6 백업과 이전 릴리스는 보존하며 데이터 복원은 별도 소유자 승인이 필요하다.


## 원장 스키마 5와 요청 재시도

동기 API 명령은 원장 변경·이벤트·성공 기록을 한 트랜잭션으로 저장한다. 비동기 명령은 I/O 전에 요청 ID·주체·명령 해시를 `pending`으로 보존하고, 기존 Pi 제출 ID나 효과 기록으로 재시도를 처리한다. 명령 본문과 자격은 요청 기록에 저장하지 않는다. 외부 결과가 불명확하면 소유자 확인을 요구하며, 확인했다는 사실만으로 API 성공 응답을 만들어 내지 않는다.

마이그레이션 5는 `requests.state`를 추가한다. 기존 성공 기록은 `done`이 되고, 미완료 요청은 30일 정리 대상에서 제외된다. 스키마 4 Host는 업그레이드된 원장을 거절한다. 배포 전 백업과 이전 릴리스를 보존하되, 업그레이드 뒤 이전 실행 파일로 링크만 되돌리지 않는다. 데이터·자격 복원은 별도 소유자 승인이 필요하다.

## 백업

`ghost backup <빈 디렉터리>`는 두 DB 모두에 SQLite writer 잠금을 확보한 뒤 `VACUUM INTO`로 복사한다. 두 사본이 끝나면 잠금을 풀고 무결성·해시를 검증한 뒤 `ghost-backup/2` manifest를 마지막에 쓴다. Host를 재시작하지 않지만 복사 중 쓰기와 이를 기다리는 API는 지연될 수 있다. 복사가 Host의 5초 busy timeout을 넘으면 쓰기가 `SQLITE_BUSY`로 실패할 수도 있으므로 배포 백업은 유휴 상태에서 수행한다. 잠금을 확보하지 못하거나 복사가 실패하면 완료 manifest를 만들지 않는다.

`ghost backup`은 금고가 있으면 `vault/vault.db`의 일관된 사본·무결성·해시와 `vault/key`(0600)도 manifest에 담는다. 금고는 원장과 공유 트랜잭션을 쓰지 않는다. `artifacts/`, `skills/`, `secrets/` 전체, `config.json`과 앱 console 설정은 권한 유지로 별도 보관한다. 브라우저 로그인 상태는 이 DB 백업에 포함되지 않는 소모성 상태다. `lock.db`는 복구 입력이 아니며 같은 루트의 두 번째 Host·`doctor`·`import`는 거절된다. 운영 점검은 Owner API를 쓴다.

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
