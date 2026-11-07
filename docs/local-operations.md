# Ghost 로컬 운영

## 구성

| 역할 | 진입점 |
| --- | --- |
| Host | `ghost serve` 한 프로세스. 상태 루트(`~/Library/Application Support/Ghost`)의 단일 writer이고 API·웹 UI·기기 연결을 같은 포트(기본 `127.0.0.1:62062`)에서 제공한다. |
| Mac 앱 | `~/Applications/Ghost.app`. `~/.config/ghost/console.json`의 `host_mode: external`이면 상태 루트의 `host.json`을 읽어 실행 중인 Host에 붙는다. `managed`이면 앱에 들어 있는 Host를 직접 띄운다. |
| iPhone | 페어링한 기기가 Host의 공개 origin(`publicOrigin`, TLS 리버스 프록시)으로 직접 접속한다. 별도 Gateway는 없다. |

## 현재 설치 (2026-11-07)

| 항목 | 값 |
| --- | --- |
| LaunchAgent | `com.a7.ghost` → `~/Workspace/Projects/infra/scripts/ghost-run.sh` → `~/.local/bin/ghost serve` |
| 실행 파일 | `~/.local/bin/ghost` → `~/.local/share/ghost/current/ghost`, `current` → `releases/20261107-bun-74cd0fb` (UI는 같은 디렉터리의 `ui/`) |
| 상태 루트 | `~/Library/Application Support/Ghost` (`config.json`: 포트 62062, `publicOrigin` `https://macstudio.tail1d0d8d.ts.net:8443`, Apple container 샌드박스, Oxibrain) |
| 기기 origin | `tailscale serve`의 `:8443` → `127.0.0.1:62062` |
| Mac 앱 | `~/Applications/Ghost.app`, `console.json` = `{host_mode: external, root}` |
| 중지됨 | `com.a7.ghost-gateway`(disabled), 구형 worker LaunchAgent |
| 백업 | infra restic이 `ghost backup`(ghost-backup/2)으로 스냅숏을 만든다 |

모든 Ghost와 대화는 기본 모델(Z.AI `glm-5.3`)을 따르고, Oxibrain 기억은 `memory.spaces`의 `*` 항목(`pc-infra`)으로 모든 Ghost가 쓴다.

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
ghost doctor
```

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
