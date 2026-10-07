# 로컬 Ghost 실행과 복구

2026-10-03. [설계·검증 범위](adr-012-minimal-ghost-collaboration.md).

## 실행

개발 checkout에서 `ghost`, `oxicode`, `oximemo`, `oxibrain`은 같은 부모 폴더의 sibling이다. optional adapter에 필요한 source를 함께 준비한다. 현재 path 의존성은 배포용으로 고정된 번들이 아니다.

```sh
cargo build --features workspace-ui
target/debug/ghost doctor --model mock
target/debug/ghost --root /absolute/path/ghost-state serve --port 62062 --model mock
```

서버의 readiness 출력은 공개 UI 주소만 제공한다. 초기 모델 `mock`은 유료 요청을 하지 않는다. 기본 headless 실행은 `cargo run -- --root /absolute/path/ghost-state serve --headless`이다. UI를 닫아도 호스트가 실행 중이면 저장된 일을 처리한다. 종료 신호는 작업 취소와 다르다.

실제 모델은 SDK의 모델 selector를 사용한다. 표준 provider 환경 변수 또는 명시적 `GHOST_AUTH_FILE`로 자격증명을 제공한다. `doctor`는 모델 해석과 provider 생성만 확인하며 실제 API 호출 성공을 검증하지 않는다. 자격증명을 persona·프롬프트·명령 JSON에 넣지 않는다.

## 제어와 확인

```sh
target/debug/ghost --root /absolute/path/ghost-state control snapshot
target/debug/ghost --root /absolute/path/ghost-state control events PROFILE_UUID --after 0
target/debug/ghost --root /absolute/path/ghost-state control send --file command.json
```

소유자 명령은 아래와 같은 envelope이다. 응답을 잃으면 같은 payload와 같은 `request_id`로 확인한다. 이미 접수했으나 결과가 없는 명령을 자동 재실행하지 않는다.

```json
{
  "request_id": "01998aee-8000-7000-8000-000000000001",
  "command": {
    "type": "workspace",
    "action": {
      "type": "recover_profile",
      "profile_id": "PROFILE_UUID"
    }
  }
}
```

저장소 장애를 고친 뒤 UI의 ‘입력 복구 → 저장소 수정 후 Ghost 복구’ 또는 위 명령을 사용한다. 복구가 실패하면 storage 오류 상태를 유지한다. disk 수리 없이 무한 재시도하지 않는다. 외부 효과가 `uncertain`이면 실제 파일·서비스 영수증을 먼저 확인하고 해당 effect를 reconcile한다.

협업 로그 조회는 `{"type":"collaboration_messages","delegation_id":"EFFECT_KEY","after":0}`, 협업 취소는 `{"type":"cancel_delegation","delegation_id":"EFFECT_KEY","reason":"직접 확인한 중단 이유"}`를 workspace action에 넣는다. 조회 결과의 마지막 sequence를 다음 cursor로 사용한다.

## 백업과 서비스 설정

UI 설정의 ‘호스트 백업’ 또는 workspace action `{"type":"backup","destination":"/absolute/new/backup-folder"}`를 사용한다. 이미 존재하는 폴더에는 덮어쓰지 않는다. manifest의 `external_spaces`에 나온 문서·asset은 원래 PDC vault의 별도 백업 정책으로 보존한다.

```sh
target/debug/ghost --root /absolute/new/restored-state restore /absolute/backup-folder
target/debug/ghost --root /absolute/path/ghost-state service-spec --output /absolute/new/ghost.plist --platform launchd --headless
```

restore는 새 root만 사용한다. manifest가 complete이고 각 hash·SQLite integrity가 일치해야 한다. 복원 후 일반 실행으로 저장된 intent를 복구하며 불확실 효과는 계속 확인 대상으로 남는다. `service-spec`의 root는 존재하는 폴더여야 한다. launchd 또는 systemd 설정 파일을 생성하고 설치·자동 시작은 하지 않는다.

## 선택형 연동

| 연동 | 호스트 설정과 소유자 권한 |
| --- | --- |
| 기억 | `memory` feature, `GHOST_BRAIN_EXECUTABLE`, `GHOST_BRAIN_DIR`, 선택적 `GHOST_BRAIN_TOKEN`; Ghost의 memory 권한 |
| 컴퓨터 | `computer` feature와 OpenBot supervisor 설정; Ghost별 browser/shell 권한 및 backend capabilities |
| Slack | `channels` feature, `GHOST_SLACK_APP_TOKEN`, `GHOST_SLACK_BOT_TOKEN`; team/channel/user binding과 검토한 답장 발송 |
| 음성 | `channels` feature, `OPENAI_API_KEY`; Ghost의 voice 권한과 사용자의 마이크 입력 |
| MCP | 소유자가 설정한 stdio/HTTP integration, enabled와 허용 profile; credential 값 대신 환경 변수 이름 |

어댑터의 설정 존재는 연결 성공을 뜻하지 않는다. 음성·중단된 모델의 청구 비용은 보고된 usage와 다를 수 있다. 일일 요청 상한과 보고된 token/cost 상한은 admission 정책이며 청구액의 정확한 상한 보장은 아니다.

## 재검증

```sh
cargo test
cargo clippy --all-features --all-targets -- -D warnings
cargo fmt --check
```

전체 browser fixture suite는 macOS의 명시적 binary pin이 필요하다. `GHOST_E2E_PIN`, `GHOST_HANDOFF_PIN`, `GHOST_UI_PIN`을 검증한 pin JSON의 절대 경로로 설정한 뒤 `cargo test --all-features -- --test-threads=1`을 실행한다. 보존된 pin의 source/binary 대응을 독립 검증했다고 주장하지 않는다. 실계정 연동은 별도 확인이며 fixture 통과로 대체하지 않는다.
