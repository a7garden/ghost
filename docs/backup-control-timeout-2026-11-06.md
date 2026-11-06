# 이슈: Host 백업이 control 제한시간을 넘고 `workspace.db`가 급증함

기준: 2026-11-06. 상태: 열림. 발견 경로: infra `com.a7.infra.backup` 실패 조사 ([infra HANDOFF](../../infra/HANDOFF.md), infra `057412f`).

## 증상

- 11-05·11-06 정기 백업이 `ghost: Resource temporarily unavailable (os error 35)`로 실패했다. 11-04 이후 Restic 스냅숏이 없었다.
- 원인은 잠금 충돌이 아니다. `ghost control send`의 소켓 read timeout(60초)이 만료되면 macOS가 `EAGAIN`(35)을 돌려준다.
- 운영 Host(`~/Library/Application Support/Ghost`)의 백업은 약 73초 걸린다. 15:02:06 → 15:03:19로 재현했다. Host는 CLI가 끊긴 뒤에도 백업을 끝내고 `backup.json`에 `complete: true`를 기록한다.
- infra는 현재 우회 경로로 복구했다. `infra/scripts/ghost-backup-snapshot.py`가 CLI 시간 초과 후 manifest 완료를 최대 30분 기다리고 SHA-256을 검증한다. Ghost 쪽 원인은 그대로다.

## 문제 1. control client 고정 60초 제한

- `src/control/client.rs:13` `IO_TIMEOUT = 60s`가 모든 control 요청의 read/write에 적용된다(`:97-98`).
- 백업처럼 DB 크기에 비례해 길어지는 작업도 같은 제한을 받는다. 제한을 넘으면 CLI는 실패로 끝나지만 Host의 효과는 완료된다. 호출자는 결과를 알 수 없다.

수용 조건: 긴 작업이 CLI 실패와 Host 성공으로 갈라지지 않는다. 예를 들어 작업별 제한, 진행 응답 또는 작업 ID 반환 후 완료 조회 중 하나로 처리한다. 결과가 불명확할 때 재실행하지 않는 기존 원칙을 유지한다.

## 문제 2. 백업 내내 Host 전역 잠금 유지

- `src/host/operations.rs:94` `backup()`이 `app.lock()`을 잡은 채 다음을 모두 수행한다: 프로필별 `ghost.db`와 `durable.db` 복사, `workspace.db` 복사(`:126`), 파일마다 `PRAGMA integrity_check`(`integrity`, `:46`), SHA-256 계산, fsync.
- `sqlite_backup`은 `run_to_completion(128, 5ms)`로 단계별로 복사하지만, 바깥에서 Host 잠금을 잡고 있다. 따라서 약 73초 동안 다른 Host 요청이 대기할 수 있다. `[INFERENCE]` 요청 대기 시간은 측정하지 않았다.

수용 조건: 일관 snapshot을 유지하면서 integrity·digest·fsync를 잠금 밖으로 옮긴다. 백업 중 일반 요청의 지연을 측정해 기록한다.

## 문제 3. `workspace.db` 급증: `lifetime_commands` 응답 누적

크기 추이: 11-01 29MB → 11-04 44.6MB → 11-06 372MB(381,870,080 bytes).

11-06 사본을 `dbstat`로 측정한 결과:

| 객체 | 크기 |
| --- | --- |
| `lifetime_commands` | 359.4MB |
| `lifetime_delivery_receipts` | 2.5MB |
| 그 외 | 각 1MB 미만 |

- `lifetime_commands`는 13,474행이다. `request`는 합계 5.9MB이고 `response`가 316.9MB다. 행당 평균 약 24KB, 최대 42KB다.
- 가장 큰 응답은 `"summary":"canonical conversation history inspected"`와 긴 `object_refs` 목록이다. 대화 이력 조회 결과 전체가 command 응답(멱등 재생용으로 추정)에 그대로 저장되는 것으로 보인다. `[INFERENCE]` 저장 목적과 보존 기간은 코드로 확인하지 않았다.
- 급증 시점은 11-04·11-05 설치 이후다. 이력 조회가 반복되는 경로(예: 지속 과업 스레드, 대시보드 polling)와 연관이 있는지 확인해야 한다.

수용 조건: 읽기 전용 조회 응답을 전체 저장하지 않거나 크기·보존 기간 상한을 둔다. 기존 행은 멱등성 계약을 깨지 않는 범위에서 정리하고, 정리 전후 크기와 재생 동작을 기록한다.

## 범위와 주의

- 운영 Host 교체·재시작과 DB 정리는 설치 승인 범위에서 진행한다. 운영 DB에서 행을 직접 지우지 않는다.
- 문제 1이 해결되면 infra의 대기 우회 경로를 단순화할 수 있다. infra 쪽 변경은 그때 별도로 한다.
