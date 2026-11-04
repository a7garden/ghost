# Ghost에서 Agent Orchestra 사용하기

Agent Orchestra의 공통 업무 규칙과 분야별 지침은 Ghost의 기존 스킬 저장소와 Pi 업무 세션에서 쓸 수 있다. 지침의 원본은 Orchestra에서 관리한다. Ghost Host가 업무 수명, 권한, 실행 환경과 수용을 관리한다. [Orchestra 공통 계약](../../agent-orchestra/skill/agent-orchestra/references/shared-defaults.md)

| 영역 | Ghost에서 적용되는 경로 | 이식 경계 |
| --- | --- | --- |
| 접수와 책임 | 기본 Ghost가 대화에서 업무를 만들고 위임, 취합, 보고를 맡는다. 기본 Ghost의 접수 턴부터 작업 유형, 위임 범위, 확인 조건, 보고 책임을 적용한다. | 업무에 등록한 전체 스킬 판본은 별도로 Pi Work에 전달된다. |
| 위임 | 담당 Ghost, 계약, 실행 공간, 의존성 및 대기·재개를 Host가 추적한다. 자식 업무의 `acceptance_spec.delegation_allowed`를 `false`로 지정하면 Host가 해당 업무의 재위임과 판본 변경을 통한 권한 확대를 거부한다. | 동일 파일의 단일 작성자 원칙은 브리프와 산출물 취합에 적용한다. 실행 공간의 격리는 프로젝트 전체 파일 잠금과 별개다. 정해진 위임 계약에는 이 제한이 사전에 들어 있어야 한다. |
| 라우팅 | Pi가 작업 유형을 제안하면 Host가 접수 시점의 승인된 모델·effort를 고정한다. Codex와 지원되는 Z.AI 모델의 기본 매핑은 `orch route --json --caller ghost`에서 추출한다. | 승인된 작성 공급자 안에서 배정한다. 다른 공급자를 쓰는 Orchestra 경로는 별도로 설정하며, 미설정 유형은 대화 기본 경로를 사용한다. |
| 검증과 리뷰 | 승인된 공개 업무는 다른 공급자의 Pi가 원본 산출물과 현재 요구사항을 독립 리뷰한다. Host는 산출물 해시, 실행과 요구사항 판본에 리뷰를 묶고, 기존의 독립된 필수 검증도 통과해야 자동으로 수용한다. 리뷰만 통과하면 소유자의 수용을 기다린다. | 리뷰어 승인과 공개 범위가 유효해야 한다. 검증할 증거가 부족하거나 리뷰에 실패하면 수용 대기로 남긴다. |
| 도구와 분야별 흐름 | 공통 계약, 작업자 계약, 선택한 `game`, `desktop-app`, `research` 지침을 Pi 업무에서 참조할 수 있다. 실행은 승인된 작업 공간의 파일·셸 도구와 격리 브라우저 경로를 쓴다. | `agent-desktop`과 특수 도구는 각자 별도 권한과 실행 연결이 필요하다. 분야를 선택해도 Host 화면이나 계정 권한은 생기지 않는다. |
| 복구와 기록 | 같은 실행의 영수증과 취소·권한 울타리로 미확정 동작을 보호한다. 업무 스레드에 상태와 결과를 연결한다. | Orchestra의 통합 실행·비용 원장이나 승인된 Oxibrain 기록과의 자동 연동은 별도다. |

## 작업 경로와 독립 리뷰

기본 Ghost는 대화에서 새 업무를 접수할 때 Host가 제시한 유형 중 하나를 고른다. 질문과 후속 대화는 해당 턴의 목적에 맞게 처리한다. 업무 시작 알림, 산출물 게시 알림, 최종 수용 보고를 구분한다. 같은 업무를 다시 열면 기존 실행과 판본을 확인한다.

기본 Ghost의 기존 대화가 보호돼 있다면 **새 공개 대화**로 기록이 없는 별도 대화를 연다. 이 대화의 모델을 지정한 뒤 **대화 모델 → 독립 리뷰**에서 키가 등록된 Z.AI 또는 MiniMax를 골라 전송을 허용한다. 작성 공급자와 다른 공급자만 선택할 수 있다. 설정한 뒤 새로 접수하는 공개 업무에 적용된다. 같은 Bun 번들의 일회성 Pi 리뷰 모드는 공개 요구사항, 단일 UTF-8 산출물, Host가 확인한 공개 실행 사실(합계 최대 48 KiB)을 받고 도구 없이 검토한다. 실행 사실에는 성공한 도구 호출 수, 하위 산출물 해시, 수용과 부모의 대기 재개·재확인이 포함된다. 리뷰에는 대화 기록, 로컬 스킬, 명령 본문, 파일 경로가 포함되지 않는다. 통과와 실패 판정은 원래 대화의 Ghost 보고에 연결된다. 보호된 업무는 기존 로컬 실행과 검증 경로를 따른다.

소유자 API `POST /api/v1/inference/settings`의 `set_orchestra`는 현재 `version`, `ghost_id`, `conversation_id`, `profile`을 받는다. `profile.routes`는 작업 유형에서 `{provider,model,effort}`로 가는 맵이고 `profile.reviewer`는 같은 형태의 선택 또는 `null`이다. 경로 지정은 해당 대화가 승인한 작성 공급자 안에서만 유효하다. `profile: null`은 대화의 Orchestra 설정을 지운다. 설정을 해제하거나 바꾸면 이전 승인이 철회된다. 다음 업무 판본에는 그때의 승인 상태가 적용된다. 등록 업무 계약은 기존 검증과 공개 범위를 따른다. 진행 중 리뷰의 권한이 사라지면 현재 업무를 자동 수용하지 않는다. 소유자는 기존 수용 권한으로 별도 결정을 내릴 수 있다. 응답을 확인하지 못한 동일 리뷰는 자동 재요청하지 않는다. 이전 Host로 복귀할 때는 해당 버전이 리뷰 대기를 처리하지 못하므로 먼저 진행 중인 리뷰 업무를 마무리하거나 취소한다.

지원되는 기본 경로를 최신 Orchestra 레지스트리에서 다시 만들 수 있다.

```sh
python3 scripts/export-orchestra-routes.py > contracts/lifetime/orchestra-routes.json
```

## 스킬 내보내기

정본 Ghost 저장소에서 신뢰하는 로컬 Orchestra 소스를 지정한다. 분야는 반복해서 선택할 수 있다. 분야를 생략하면 공통 업무 흐름을 쓴다.

```sh
orchestra_export_dir=$(mktemp -d)
orchestra_skill="$orchestra_export_dir/SKILL.md"
python3 scripts/export-orchestra-skill.py \
  --orchestra-root ../agent-orchestra \
  --flow research --flow desktop-app > "$orchestra_skill"
```

내보낸 파일에는 `orch context --caller ghost`의 workflow/selection fingerprint와 실제로 담긴 각 지침의 SHA-256이 들어간다. 작업자 계약은 위임받은 자식 업무에만 적용한다. CLI가 발견한 프로젝트·개인 지침 파일은 따라 읽지 않는다. 분야 문서가 가리키는 외부 도구와 스킬은 대상 업무의 별도 기능으로 취급한다. 같은 원본과 분야 순서는 같은 바이트를 만든다.

소유자가 산출물을 검토한 뒤, 별도 상태 루트 또는 승인된 유지보수 창에서 기존 Ghost 스킬 명령으로 가져온다.

```sh
ghost --root DIR skill add PROFILE agent-orchestra --file "$orchestra_skill"
```

스킬은 `local_only`로 분류한다. 대상 Ghost에 로컬 추론·실행 경로를 지정하고 대화의 전송 범위를 **이 기기에서만**으로 선택해 업무를 시작한다. 대상 프로필만 선택해 설치하며, 여러 Ghost에 공유하려면 [카탈로그와 평가 기반 도입 경로](shared-skills.md)를 사용한다. 새 원본은 다시 내보내고 기존 `skill replace --version N` 경로로 교체한다. 새 Pi 배정을 기록하는 시점에 업무의 스킬 해시를 고정한다. Pi가 대기 중인 업무를 처음 읽기 전에 스킬을 교체해도 접수 당시 판본을 사용한다. 비활성화는 이후 배정에 적용된다. 이미 고정된 업무에서 스킬을 회수하려면 해당 업무를 먼저 종료한다. 스킬 삭제로 판본 파일이 사라진 업무는 실행이 차단된다. 운영 Host와 같은 상태 루트를 별도 CLI 프로세스로 동시에 쓰지 않는다.

## 격리 검증

로컬 Bun 번들과 내보낸 파일을 준비한 뒤 실제 Rust Host와 Pi SDK 경로를 테스트한다. 번들은 이전에 확인한 동일한 Pi 소스에서 만들 수 있다.

```sh
GHOST_TEST_BUNDLED_PI=/absolute/isolated/ghost-pi \
GHOST_TEST_ORCHESTRA_SKILL="$orchestra_skill" \
  cargo test --locked --features 'lifetime memory documents' --lib \
    bundled_bun_applies_exported_orchestra_skill_in_scoped_work -- --ignored
cargo test --locked --features 'lifetime memory documents' --test lifetime_host_graph
```

격리 검증은 로컬 테스트 모델에 도달한 스킬 바이트와 해시, 파일 작성·재확인·게시, Host 수용을 확인한다. 모델이 실제 업무를 얼마나 잘 수행하는지, 운영 설치판이나 외부 공급자 리뷰가 준비됐는지는 별도 확인 대상이다.


접수, 업무별 추론, 별도 공급자 리뷰, 기본 대화 최종 보고를 한 경로에서 검증하는 Bun 시험도 있다. 격리된 Host와 실제 Pi SDK를 사용한다. 테스트 엔트리는 두 공급자의 응답만 가로채며 외부 모델 호출과 실제 API 키를 사용하지 않는다.

```sh
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  --outfile /tmp/ghost-orchestra-e2e-pi apps/ghost-durable/test/fixtures/orchestra-bun-main.mjs
GHOST_TEST_ORCHESTRA_BUN=/tmp/ghost-orchestra-e2e-pi \
  cargo test --locked --features 'lifetime memory documents' --lib \
    bundled_bun_orchestra_intake_routes_reviews_and_reports -- --ignored
```
