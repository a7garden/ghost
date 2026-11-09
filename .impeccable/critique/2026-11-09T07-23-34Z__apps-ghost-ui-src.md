---
target: UX 감사 ghost-ui
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:D:\\workspace\\ghost\\apps\\ghost-ui\\src"
timestamp: 2026-11-09T07-23-34Z
slug: apps-ghost-ui-src
---
# Ghost UI UX 감사 (2026-11-09)
Method: dual-agent. 실화면은 빈 첫 실행 홈만 확인.

| # | 휴리스틱 | 점수 |
|---|---|---|
| 1 | 시스템 상태 | 3 |
| 2 | 현실과 일치 | 3 |
| 3 | 통제와 자유 | 2 |
| 4 | 일관성 | 2 |
| 5 | 오류 예방 | 2 |
| 6 | 인지 | 3 |
| 7 | 효율 | 3 |
| 8 | 미니멀 | 3 |
| 9 | 오류 회복 | 2 |
| 10 | 도움말 | 2 |
| 합계 | | 25/40 |

## 우선 문제
- [P1] 수정 요청에 사유를 보낼 수 없다 — features/Decision.tsx:55 decisionCommand 가 deny 의 answer 를 버린다. 두 단계 사유 입력으로.
- [P1] 권한 확대·되돌릴 수 없는 동작이 한 번에, 확인 방식 다섯 갈래 — 모두 허용(GhostPermissions.tsx:106), 그룹 머리글(GhostSettings.tsx:432), 은퇴(:324-330), 일 취소(WorkViews.tsx:153, WorkDetail.tsx:323). 확인 컴포넌트 하나 + 일 취소 되돌리기 토스트.
- [P1] CapabilityBoard 낙관적 토글이 실패해도 롤백 안 함 — GhostSettings.tsx:418-424.
- [P2] 읽기 실패를 「찾을 수 없습니다」로 — WorkDetail.tsx:38, ThreadPanel.tsx:43. 404 와 연결 오류 구분 + 다시 시도.
- [P2] 자원 숫자 입력이 입력 도중 잠김 — GhostPermissions.tsx:133-136. blur/Enter 커밋.

## 페르소나
- Alex: Ctrl+P 가 팔레트(command-palette.tsx:87), 팔레트는 이동만, 거절 단축키·덱 키보드 이동·일괄 처리 없음, 숫자 두 번이면 두 결정에 답, Windows 에 ⌘ 표기.
- Sam: LifecycleTrack aria-label 에 상태 없음, HoldButton 안내 없음, radiogroup 화살표 없음, 새 결정 알림 없음.
- Riley: 파일 첨부 시 맡기기 말없이 비활성, 제목 256자 말없이 자름, 소식 무한·처리한 결정 8개 컷, 「이미 처리된 결정」이 오류 스타일, ThreadPanel Esc 가 입력 중에도 닫음.

## 감지기
소스 10건 중 실제 2(pets look-pop 키프레임 튕김, decision 줄은 의도). 렌더 홈 1건 nested-cards(경계선). 콘솔 오류 없음.
