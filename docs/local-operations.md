# Ghost 로컬 운영

## 구성

| 역할 | 진입점 |
| --- | --- |
| Host | `ghost serve` 한 프로세스. 상태 루트(`~/Library/Application Support/Ghost`)의 단일 writer이고 API·웹 UI·기기 연결을 같은 포트(기본 `127.0.0.1:62062`)에서 제공한다. |
| Mac 앱 | `~/Applications/Ghost.app`. `~/.config/ghost/console.json`의 `host_mode: external`이면 상태 루트의 `host.json`을 읽어 실행 중인 Host에 붙는다. `managed`이면 앱에 들어 있는 Host를 직접 띄운다. |
| iPhone | 페어링한 기기가 Host의 공개 origin(`publicOrigin`, TLS 리버스 프록시)으로 직접 접속한다. 별도 Gateway는 없다. |

상태 루트:

```
ledger.db   pi.db   host.json (0600)   config.json (선택)
artifacts/sha256/…   skills/…   secrets/<provider>.json (0600)   sandboxes/<ghost>/<work>/workspace
```

`config.json`은 `publicOrigin`, `uiDir`, `sandbox`(`local` 또는 `apple-container`), `memory`(Oxibrain), `apns`를 담는다. 환경 변수는 `GHOST_ROOT`, `GHOST_PORT`, `GHOST_HOST`, `GHOST_PUBLIC_ORIGIN`, `GHOST_UI_DIR`만 읽는다.

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
