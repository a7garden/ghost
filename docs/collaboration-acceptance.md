# Ghosts 협업 단위 수용 계약

원래 `tests/acceptance.rs`의 24/25 테스트와 기존 profile/session/task 문법을 보존한다. 별도의 fixture와 `tests/collaboration.rs`를 사용한다. runtime provider는 mock뿐이며 -j1로 검증한다.

| 경로 | 확인할 결과 |
|---|---|
| 두 Ghost / 한 상위 과업 | 지속 UUID·persona·정책 유지, 별도 session, 역할 분담, 상위 owner가 결과 취합 |
| 내부 protocol | version, sender/recipient, root/parent/delegation/task/message ID 검증; sender+message dedup |
| 실행 metadata | identity/session/task와 별도 attempt/process ID; adapter metadata가 identity를 대체하지 않음 |
| 결과 | 실제 receiver outbox 검증, task·media·hash·lineage provenance를 가진 artifact와 병합 |
| 권한 축소 | text-only 위임에서 파일/HTTP/shell/MCP/금융 권한이 생기지 않고 기존 grants 유지 |
| 선택 실행 | worker의 다른 queued task를 실행하거나 취소하지 않음 |
| 중복 | 동일 parent와 delivery 재전달은 동일 과업; 충돌 payload는 fail closed |
| ACK 전 중단 | worker inbox가 commit됐지만 coordinator ACK가 실패하면 재시작 후 같은 message/task 채택 |
| 대기 중 중단 | 완료 부분 결과를 재수집; running worker는 uncertain이며 자동 재실행하지 않음 |
| failure | 한 worker 실패 시 다른 worker의 artifact를 유지하고 상위 상태 failed/uncertain |
| cancel | 부모 cancel을 먼저 저장, 미전달 work는 시작하지 않음, busy worker는 pending cancel 후 명시 run에서 조정 |
| 관리 조회 | 공개 read-only snapshot, writer lock 중에도 조회, 파일 생성·상태 복구·DB 편집 없음 |
| CLI reconnect | 별도 프로세스 submit/run/status로 실제 저장 결과 재조회 |

SQLite trigger 기반 fault injection과 close/reopen은 결정적 crash window 검증이다. 아직 없는 socket transport의 실제 kill/reconnect나 event stream replay를 수행했다고 주장하지 않는다. 프로세스별 실행은 OS sandbox와 다르다.

## 거부 및 독립 실행 계약 — 2026-10-02

모든 위임 envelope와 현재 host identity는 dispatch 전에 검증한다. 이 검증이 실패하면 어떤 worker도 실행하지 않는다. Receiver에 이미 있는 inbox payload는 해당 worker의 실행/취소 직전에 검증하며, 위조 task를 실행하거나 취소하지 않는다. 서로 다른 profile 활동은 하나의 실행 트랜잭션이 아니므로 먼저 검증된 정상 sibling의 텍스트 활동은 이미 완료돼 있을 수 있다.

Delivery가 rejected가 되면 오류를 반환하기 전에 부모 failed 상태를 저장하고 완료 sibling의 artifact를 그대로 보존한다. 두 번째 결과가 없으면 성공 aggregate를 만들지 않는다. 거부로 실패한 부모의 재시작/재호출은 미시작 sibling을 새로 시작하거나 완료 sibling을 다시 실행하지 않으며, 부모 취소는 위조된 inbox task에 영향을 주지 않는다. 수용 테스트는 두 worker 순서에서 provider UUID별 호출, 실제 write grant가 있는 위조 task의 queued 상태·빈 outbox/effects·파일 미생성, 부분 결과와 공개 CLI 상태, 재시작/취소를 검증한다. 기존 보안 계약 및 envelope zero-call 회귀는 유지한다.
