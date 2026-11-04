# Ghost에서 Agent Orchestra 사용하기

Agent Orchestra의 공통 업무 규칙과 분야별 지침은 Ghost의 기존 스킬 저장소와 Pi 업무 세션에서 쓸 수 있다. 지침의 원본은 Orchestra에서 관리한다. Ghost Host가 업무 수명, 권한, 실행 환경과 수용을 관리한다. [Orchestra 공통 계약](../../agent-orchestra/skill/agent-orchestra/references/shared-defaults.md)

| 영역 | Ghost에서 적용되는 경로 | 이식 경계 |
| --- | --- | --- |
| 접수와 책임 | 기본 Ghost가 대화에서 업무를 만들고 위임, 취합, 보고를 맡는다. 업무에 지정된 스킬 판본은 Pi 실행에 전달된다. | 일반 대화의 접수 턴에 업무 스킬을 주입하는 경로는 별도다. |
| 위임 | 담당 Ghost, 계약, 실행 공간, 의존성 및 대기·재개를 Host가 추적한다. 자식 업무의 `acceptance_spec.delegation_allowed`를 `false`로 지정하면 Host가 해당 업무의 재위임과 판본 변경을 통한 권한 확대를 거부한다. | 동일 파일의 단일 작성자 원칙은 브리프와 산출물 취합에 적용한다. 실행 공간의 격리는 프로젝트 전체 파일 잠금과 별개다. 정해진 위임 계약에는 이 제한이 사전에 들어 있어야 한다. |
| 라우팅 | Ghost별로 승인된 Pi 모델과 권한을 사용한다. | `orch route --json --caller ghost`는 미리보기다. 작업 유형별 모델·effort 자동 배정, 공급자 대체와 패널 실행에는 별도 Host 어댑터가 필요하다. |
| 검증과 리뷰 | 산출물 해시, 실행 증거, 독립된 결정적 검증과 소유자 수용을 구분한다. | R2의 타사 모델 리뷰에는 실제 작성자·리뷰어 공급자, 동일 산출물과 판본, 읽기 전용 입력, 리뷰 라운드를 Host가 묶어야 한다. 현재 위임의 문자열 참조는 리뷰어에게 검증된 원본을 전달하는 권한이 아니다. |
| 도구와 분야별 흐름 | 공통 계약, 작업자 계약, 선택한 `game`, `desktop-app`, `research` 지침을 Pi 업무에서 참조할 수 있다. 실행은 승인된 작업 공간의 파일·셸 도구와 격리 브라우저 경로를 쓴다. | `agent-desktop`과 특수 도구는 각자 별도 권한과 실행 연결이 필요하다. 분야를 선택해도 Host 화면이나 계정 권한은 생기지 않는다. |
| 복구와 기록 | 같은 실행의 영수증과 취소·권한 울타리로 미확정 동작을 보호한다. 업무 스레드에 상태와 결과를 연결한다. | Orchestra의 통합 실행·비용 원장이나 승인된 Oxibrain 기록과의 자동 연동은 별도다. |

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
