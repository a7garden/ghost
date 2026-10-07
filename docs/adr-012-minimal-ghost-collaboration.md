# ADR 012 — 최소 Ghost와 협업·복구 계약

2026-10-03. [ADR 011](adr-011-ghost-host-control.md)의 구조를 유지하며 이번 구현과 검증 결과를 구체화한다. OpenDots의 기준 소스는 `b01ac1f6a903e5e56c119d960901353ac0a3d171`이다. 기능 수만으로 제품의 우위를 판정하지 않는다.

## 기본 단위와 경계

Ghost는 UUID, 역할, 현재 정책, 책임, 독립 대화, 실행 기록을 유지한다. Rust 호스트가 수명과 실행을 관리하고 `oxicode-durable`이 commit·복구·취소를 맡는다. SDK는 모델·자격증명 해석을 맡는다. UI와 선택형 문서·기억·컴퓨터·채널 어댑터는 이 단위의 소비자다.

기본 headless 빌드는 UI·문서 파서·기억 client·채널 없이 실행한다. 편의 feature `workspace-ui`는 웹 UI와 네 어댑터를 포함한다. 브라우저 fixture 실행파일과 테스트용 endpoint는 배포용 설정과 분리한다. JavaScript는 UI에 사용하고 실행·정책·저장·협업 핵심은 Rust로 구현한다.

운영자 명령, 모델 도구, 외부 관찰의 권한은 구분한다. 역할·프롬프트·도구 반환값·협업 메시지는 권한을 부여하지 않는다. 작업을 수신한 Ghost의 현재 권한과 모든 발신자의 현재 권한을 함께 검사한다. private memory는 다른 Ghost를 통한 위임에 제공하지 않는다.

## `ghost-collaboration/1`

공개 Rust payload는 `src/domain/protocol.rs`에 정의한다. 메시지는 `protocol`, `message_id`, `correlation_id`, `sequence`, `from`, `to`, `created_ms`, `event`를 가진다. 순서는 협업 요청별로 증가한다. ID와 payload가 같은 재전송은 기존 메시지 ID·시각·순서를 반환하며, 다른 payload 또는 발신·수신 경로는 거부한다.

| 메시지 | 의미 |
| --- | --- |
| `requested` | 수신 전 저장한 지시와 owned/background 선택 |
| `accepted` | 수신 Ghost에 실제 접수한 대화·작업 ID |
| `progress` | committed phase 또는 수신자의 명시적 진행 보고 |
| `result` | 완료·실패·취소·불확실 상태와 결과·근거 참조 |
| `cancel_requested` | 소유자 또는 owned 부모의 중단 의도 |
| `cancel_receipt` | 확인된 작업 상태와 따로 확인할 불확실 효과 |

명령 로그와 실행 기록을 projection해 메시지를 저장한다. 접수 ACK를 잃어도 effect key와 수신자의 저장된 입력 ID로 같은 작업을 찾는다. 재시작은 owned 작업을 보존하고 명시적 부모 취소는 owned 자식으로 전달한다. background 선택은 부모 종료 뒤의 지속을 허용하지만 현재 권한 검사는 계속 적용한다.

취소는 rollback이 아니다. 확인되지 않은 외부 효과는 `uncertain`으로 남긴다. 같은 취소 결과는 중복 저장하지 않고, reconciliation 뒤에 결과가 달라지면 새 영수증을 추가한다. 이전 기록은 바꾸지 않는다.

소유자는 인증된 Control API의 `collaboration_messages`로 sequence cursor 이후 최대 200개를 조회하고 `cancel_delegation`으로 중단한다. UI도 이 명령을 사용한다. 이 버전은 **한 호스트 내부 Ghost 간 협업 계약**이다. 별도 호스트 연합·원격 다중 사용자 인증·A2A 호환을 구현했다고 보지 않는다.

## 복구와 저장

- 모델 호출과 안전한 읽기는 committed context에서 재개한다. 외부 변경의 ACK가 없으면 자동 재전송하지 않는다.
- 검토 대기와 owned 위임 대기는 저장되며 다른 대화의 실행 슬롯을 막지 않는다. 동시에 실행할 작업 수는 Ghost별 정책으로 제한한다.
- 저장소 오류는 해당 Ghost에 표시한다. 소유자의 `recover_profile`은 그 Ghost의 runner와 timer를 중단·join하고 committed 상태를 다시 읽는다. 실제 write commit까지 성공해야 복구 성공을 반환한다. 다른 Ghost는 계속 실행한다.
- durable schema 2는 행을 나누어 immutable history를 다시 쓰지 않는다. 다만 commit의 encoding과 snapshot clone은 보존된 history 양에 비례하는 비용이 남는다.
- online backup은 SQLite별 무결성·SHA-256을 기록한다. 여러 DB 전체의 원자적 snapshot은 아니다. 외부 PDC Space·asset 원본은 복사하지 않고 manifest에 표시한다. restore는 새 root에만 허용한다.

## 문서와 사람의 확인

세션의 사용자 지침에 따라 새 문서는 PDC 1 Djot/HTML이다. 기존 PDC 2 Markdown/HTML은 원문을 보존해 읽고 편집한다. 일괄 변환은 하지 않는다. 문서 UUID, 원문 hash, unknown metadata와 inline HTML 구조를 보존하고 CAS 충돌 시 소유자에게 현재 원문을 보여준다.

모델은 저장을 제안한다. 승인 intent를 먼저 저장하고 파일 변경 뒤 결과를 기록한다. 재시작 시 approved write의 planned hash와 실제 원문이 일치하면 저장을 다시 실행하지 않고 영수증을 복구한다. 저장 이벤트는 검토 ID별로 한 번 발생하고 이미 저장된 승인 재조회가 wake 시각을 바꾸지 않는다.

브라우저 초안과 미확인 명령 ID는 workspace UUID 아래 저장한다. 서버 접수 중 추가 입력한 초안을 지우지 않는다. HTML 미리보기는 sandbox iframe과 제한된 CSP 안에서 렌더링한다. asset은 content hash를 검사하고 문서·블록 참조의 해석 오류는 화면에 표시한다.

## 검증과 출시 조건

[검증 manifest](evidence/minimal-ghost-verification-2026-10-03.json)는 소스 hash·실행파일 hash·로그·fixture 출처를 기록한다. Ghost 전체 직렬 검증 169개, 기본 빌드 검증 73개, Oxicode durable·SDK 검증 473개가 통과했다. SDK의 기존 문서 예제 3개는 ignored 상태다. 이 숫자는 독립 테스트 집합마다 기록하며 합산해 기능 수로 해석하지 않는다.

브라우저 fixture의 최초 병렬 실행에서는 12초 startup gate가 초과되었다. startup gate와 실패 시 owned process 정리를 보강했고 해당 14개를 병렬로 다시 실행해 통과했다. operation deadline과 production 권한은 완화하지 않았다. Ghost 전체 feature의 엄격한 Clippy도 통과했다.

실제 UI에서 PDC 저장, 문서·대화 초안의 새로고침 복원, 설정·영수증 화면을 확인했다. Slack·음성·컴퓨터·Brain은 anonymous HTTP 또는 실제 stdio child로 계약·취소·ACK 유실을 검증했다. 실계정 provider, 유료 음성, Slack 계정, Docker/OpenBot, production Brain은 연결 검증되지 않았다.

제품 전체의 완료 조건은 실계정 연결 검증, 대규모 history 성능, 다른 OS 검증, sibling 의존성의 배포용 고정·번들, 서명된 release와 운영 내구성 검증이다. 현재 결과는 로컬 최소 단위의 구현·검증 완료 checkpoint이며 OpenDots 전체보다 우수하다는 판정은 보류한다.
