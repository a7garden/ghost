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

## 현재 설치 (2026-11-08)

| 항목 | 값 |
| --- | --- |
| LaunchAgent | `com.a7.ghost` → `~/Workspace/Projects/infra/scripts/ghost-run.sh` → `~/.local/bin/ghost serve` |
| 실행 파일 | `~/.local/bin/ghost` → `~/.local/share/ghost/current/ghost`, `current` → `releases/20261108-bun-4cba876` (`main`, UI는 같은 디렉터리의 `ui/`) |
| 상태 루트 | `~/Library/Application Support/Ghost` (`config.json`: 포트 62062, `publicOrigin` `https://macstudio.tail1d0d8d.ts.net:8443`, Apple container 샌드박스, Oxibrain, `reach`(`~/.local/bin/agent-reach`), `skills.roots` `~/.agents/skills`, `mac.roots` `~/Workspace/Projects` + `mac.watch`(Mac 관리 Ghost, 5분)) |
| 기기 origin | `tailscale serve`의 `:8443` → `127.0.0.1:62062` |
| Mac 앱 | `~/Applications/Ghost.app`(`9db4166` 셸: 데스크톱 아바타 창 포함, 임시 서명), `console.json` = `{host_mode: external, root}`, 데스크톱 아바타 상태·위치는 `~/.config/ghost/companion.json` |
| 중지됨 | `com.a7.ghost-gateway`(disabled), 구형 worker LaunchAgent, `dev.garden.macfra.agent`(2026-11-08 Ghost `Mac 관리`로 이전, disabled) |
| 백업 | infra restic이 `ghost backup`(ghost-backup/2)으로 스냅숏을 만든다 |

Ghost별 모델·대체 모델·스킬·도구는 아래 "Ghost 팀 인프라 운영 반영"의 로스터 항목을 따른다. 기본 모델은 Z.AI `glm-5.3`이고, Oxibrain 기억은 `memory.spaces`의 `*` 항목(`pc-infra`)으로 모든 Ghost가 쓴다.

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
