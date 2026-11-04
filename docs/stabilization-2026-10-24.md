# 접수와 재시작 복구 안정화

2026-10-24 KST. Host·네 native worker에 `stabilized-7e1b5ce9c882b6e9`를 적용했다. Pi bundle·UI/gateway·모델/권한·기기 연결은 유지했다. 상세 근거·복귀는 [infra 실행 보고](../../infra/reports/2026-10-24/ghost-stabilization.md)와 infra `.verification/stabilization-20261024/`다.

Pi의 `same_id` 접수 오류와 채널 유실을 원 command ID로만 복구하며2/4/8/16/32초 backoff와6회 한도를 둔다. 시작 실패 뒤 다시 기동하고 handshake는10초로 제한한다. 이미 실행된 worker·불명 효과·정책 거부를 새 작업으로 재실행하지 않는다. queued·미실행·미취소 assignment만 정해진 전달 진단을 재검사하며 source·scope·revision·authority·graph 검사는 유지한다. 성공 ACK와 해당 blocker 해제는 원자적이다. 전달 오류가 기존 정책 blocker를 덮어쓰지 않는다.

실제 broker 프로세스의 시작 실패·응답 없는 handshake·일시 거절·ACK 유실을 주입해 원 admission1을 확인했다. Rust 전체 superset505/0/ignored4, 최종 배포 feature driver7, assignment13, Pi46과 infra13을 통과했다. 운영 빌드는 `lifetime workspace-ui`이며 실제 `run --ui`의 격리 preflight도 통과했다. OxiBrain client path dependency는 현재 정본0.21.0과 정렬했다.

원 대기 Work가 같은 ID/revision에서 completed로 진행했다. 새 대화의 정확한 응답, 새 실제 bash/read/publish34-byte 파일·독립 검수2·accepted·같은 Primary 보고2를 확인했다. 최종 Host 재시작 후 turn42/report16과 원 failed4, accepted 업무 및 native 실행1→1을 보존했다. 실제 폰·음성·APNs·mini 정본 전환·7/30일 관찰의 증거는 아니다.
