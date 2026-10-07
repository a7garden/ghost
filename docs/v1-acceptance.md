# Ghosts v1 수용 계획 — 출시 완료 조건

Ghost는 지속 identity 한 단위이고 Ghosts는 여러 Ghost의 대화·역할·공동 과업을 관리하는 새 앱이다. dots/muse는 대화, 후속 질문, 위임, 상태 조회의 사용자 경험 참고다. 내부 구현을 추측하거나 기존 Knock/FARM/Garden/ASCENT를 변경하지 않는다. 현재 headless CLI와 mock 검증은 아래 첫 단계만 충족하며 v1 출시 완료가 아니다.

| 단계 | 통과 조건 | 현재 범위 |
|---|---|---|
| 1 독립 core | 둘 이상의 UUID/persona/session/task/정책 복원, writer 배제, durable inbox/outbox, uncertain 격리 | 첫 단위 검증 완료 |
| 2 협업 과업 | 소유자·역할·text-only 위임, artifact 취합, ACK 실패·취소·중복·부분 실패·재조회 실제 검증 | bounded mock 협업 19개 수용 검증 완료; recovery-2026-10-02 참조 |
| 3 실제 대화/자료 | provider 별 요청 correlation/시간 제한/실패 처리, canonical conversation/tool 결과/compaction 복원, Cassette 원본 adapter와 oxibrain 검색 provenance | native OpenAI/Z.ai text/usage/cancel/receipt의 loopback mock 완료; 실제 대화·자료/compaction은 미구현 |
| 4 사용자 직접 연결 | provider 선택 및 비밀 숨김 직접 입력, 검증 동의·최소 요청, 안전한 저장/철회, credential 없는 상태 명확 표시 | 설계만; 실제 키 설정 없음 |
| 5 관리 앱 | 기존 Ghost 선택/생성, 대화·후속 질문·새 과업·역할 배정·실제 진행/부분 결과·취소·재연결을 공개 API로 처리 | embedded local MockProvider fixture UI/HTTP 구현 및114 회귀 완료; 실제 화면/GPU 검증 대기, 일반 관리앱·roles·reconnect 미구현 |
| 6 이식/배포 | SDK 경로 의존 제거/고정, OS/CPU별 단일 바이너리, 사용자 데이터 migration/export/복구, 권한 경계·앱 서명/공증 검증 | macOS arm64 개발 빌드만 |

각 후속 단계는 작은 유한 코드 작업과 실제 빌드/수용 테스트를 거친다. 초기 OMP 작업 뒤 사용자 명시 승인 “ghost도 sol 6.1로 해도 돼. 중요한거니까”에 따라 recovery/native 단위는 Sol 직접 개발로 진행했다. 추가 OMP 호출은 없다. 개발용 OMP는 배포 런타임 의존성이 아니다. 자격증명이나 LLM 응답을 공유 대화/로그로 가져오지 않는다. 모델 가중치는 별도 데이터이며 LocalJudge는 허용 후보 추천만 한다. Laya 한국어 calibration, native static ONNX embedding은 후보 평가부터 하고 다운로드/상주 로딩은 이번 범위에 없다.

## 사용자 직접 비밀 입력 계약 (후속, 아직 명령 없음)

기본 Ghost는 mock이고 안전한 credential 입력 UI/숨김 terminal prompt/Keychain bridge는 아직 없다. optional oxicode adapter는 with_auth port를 연결하지 않으므로 SDK의 builtin provider 환경변수 fallback을 이용할 수 있는 소스 경로만 확인했다. OPENAI_API_KEY, ANTHROPIC_API_KEY 이름은 SDK catalog와 factory에서 확인했다. 이 사실은 실 API 성공이나 전체 provider 설정 지원을 뜻하지 않는다. zai의 catalog key는 ZHIPU_API_KEY이며 별도 legacy resolver의 ZAI_API_KEY와 차이가 있어 검증 전 안내하지 않는다. 첨부 token/기존 OMP 비밀을 대신 등록하지 않는다.

후속 UI 또는 숨김 입력은 사용자가 직접 provider를 선택하고 값을 입력하게 한다. 값은 CLI 인수/history, stdout/stderr, SQLite task/artifact/audit, 모델 prompt, telemetry에 남기지 않는다. 검증 버튼은 선택 provider endpoint/모델 및 소모를 보여주고 명시 동의 후 최소 요청 하나만 수행한다. 오류는 분류와 조치만 보여주며 response/header/URL에 비밀이 섞이는지 검사한다. 최초 영구 저장은 별도 승인된 OS credential store 설계와 삭제/철회 수용 테스트가 필요하다. 아직 없는 입력 명령을 만들어 안내하지 않는다.

## 앱 경계와 복구

UI는 공개 snapshot/list 및 후속 command/event API를 사용하며 SQLite 직접 편집, provider credential 취득, 실행 상태 단독 소유를 하지 않는다. 첫 transport는 private Unix socket 또는 인증된 loopback이고 중단·재연결·event cursor 복원을 실제 검증한다. 현재 SQLite fault injection/close-reopen이 socket kill/replay 테스트를 대신했다고 주장하지 않는다. 공유 과업은 lineage/artifact로 연결하고 Ghost별 대화를 독립 보존한다.

범위가 좁은 권한 승인, 취소, expiry, 철회 및 불명 결과 수동 조정을 사용자 흐름에 포함한다. 프로세스 분리는 OS sandbox가 아니며 hostile concurrent filesystem 변경에 대한 handle-relative open 강화가 남아 있다. 금융 결정/결제/외부 공유는 기본 권한에 포함하지 않는다. 서비스/24시간 scheduler는 별도 Garden 작업에 맡기고 여기서 중복 생성하지 않는다.
