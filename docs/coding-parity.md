# herdr 동등성 체크리스트

내장 [작업대](coding-workbench.md)로 전환하고 herdr 연동을 제거한 결정의 근거를 보관한다. 2026-11-24에 소유자가 아래 `차이` 네 항목과 herdr 연동 제거를 모두 승인했다. 설치된 Mac 앱과 iPhone에서의 직접 확인은 소유자가 생략했으므로 「소유자 확인」 열은 비워 둔다.

아래 표는 결정 당시의 비교 기록이다. `동등`은 같은 동작, `대체`는 다른 방식으로 같은 결과, `차이`는 승인한 의도적 차이, `공백→진행`은 당시 작업 범위로 넘긴 항목이다.

## 구조와 배치

| 항목 | 내장 대응 | 증거 | 상태 | 소유자 확인 |
| --- | --- | --- | --- | --- |
| 스페이스·탭·패널 만들기·이름 변경·삭제 | 작업대 스페이스·탭·패널 | `workbench/service.ts`, `workbench.test.ts`, `e2e/workbench.spec.ts` | 동등 | |
| 패널 가로·세로 분할, 크기 조절, 이동, 닫기, 단축키 | `WorkbenchCanvas`, 드래그 교환·키보드 | `layout.ts`, e2e | 동등 | |
| 배치가 새로고침·재시작 뒤 복원 | 원장 설정 `workbench.*` | `workbench.test.ts` | 동등 | |
| 저장소 worktree 스페이스 | 새 스페이스의 worktree 시작 | 아래 「공백 해소」 | 공백→진행 | |
| 스페이스의 git 변경 보기 | 스페이스 변경 패널 | 아래 「공백 해소」 | 공백→진행 | |
| 모바일 패널 전환 | 컴팩트 전환 막대 | `WorkbenchCanvas`, e2e | 동등 | |

## 터미널

| 항목 | 내장 대응 | 증거 | 상태 | 소유자 확인 |
| --- | --- | --- | --- | --- |
| 색·TUI·커서·크기 조절·스크롤백 20,000행 | Bun PTY + xterm.js | `TerminalPane.tsx`, `terminals.test.ts` | 동등 | |
| 한글 조합 입력·붙여넣기·모바일 키 막대·수정 키·글자 크기 | herdr 터미널과 같은 키 막대·입력 코드 공유 | `HerdrTerminalControls`, `herdrMobileInput` | 동등 | |
| 끊겼다 재접속 | 재생 버퍼, 지수 대기 재연결 | `terminal/replay.ts`, `TerminalPaneProtocol.test.ts` | 동등 | |
| 터미널이 Host 재시작 뒤 살아 있음 | 없음. 패널을 닫거나 Host가 재시작되면 PTY 종료, 패널은 「터미널 다시 열기」 | `coding-workbench.md` 개념 | 차이 | |
| 작업 중 에이전트가 있으면 업데이트가 기다림 | 터미널 busy 계산 | 아래 「공백 해소」 | 공백→진행 | |
| 닫을 때 확인 | 터미널 패널 닫기 확인 | `Workbench.tsx` | 동등 | |

## 에이전트 시작과 관찰

| 항목 | 내장 대응 | 증거 | 상태 | 소유자 확인 |
| --- | --- | --- | --- | --- |
| 에이전트 종류를 골라 패널에서 시작(omp·Claude Code·Codex·pi) | 새 패널 「에이전트」 | 아래 「공백 해소」 | 공백→진행 | |
| omp 시작 옵션: 이어서·대화 고르기·모델·생각 수준·승인 방식 | 같은 시작 양식 | 아래 「공백 해소」 | 공백→진행 | |
| 에이전트 종료·입력 대기 감지와 알림 | `TerminalActivity`, `terminal/notify.ts`, 작업대 주의 표시 | `terminals.test.ts`, `WorkbenchAttention.ts` | 동등 | |
| 막힌 에이전트의 선택지 카드로 답하기(herdr ask) | 터미널에서 직접 답한다. 감지는 알림에만 쓴다 | `activity.ts` | 차이 | |
| 에이전트 기록을 대화 화면으로 보기(herdr chat) | 내장 세션은 구조화된 기록 화면. 터미널 에이전트는 터미널로 본다 | `CodingSessionTranscript.tsx` | 차이 | |
| 상태별 받은함(입력 필요→작업 중→완료) | 스페이스·탭·패널의 주의 표시. 전체 받은함은 없다 | `WorkbenchAttention.ts` | 차이 | |

## 내장 세션 (herdr에 없던 것 포함)

| 항목 | 내장 대응 | 증거 | 상태 | 소유자 확인 |
| --- | --- | --- | --- | --- |
| 지시·방향 수정·후속 지시 예약·이미지 첨부 | 세션 작성기 | `CodingSessionComposer.tsx`, `coding-embedded.test.ts` | 동등 | |
| 도구 카드의 diff, 변경 보기 | 세션 변경 보기 | `CodingSessionChanges.tsx` | 동등 | |
| 권한 대화상자·목업 선택 | `CodingDialog`, `ask_owner_choices` | `coding/dialogs.ts` | 동등 | |
| 모델·생각 수준·자동 압축·재시도·확장 | 세션 설정, Pi 설정 | `pi-config.test.ts` | 동등 | |
| 하위 에이전트와 omp 역할 구성 | 오케스트레이션 화면과 가져오기 | `orchestration.test.ts` | 동등 | |
| omp 슬래시 명령 목록·`/switch` | 내장 세션에는 해당 없음(설정 화면이 대신) | | 대체 | |
| 쓰기 격리 | worktree + seatbelt, 밖은 건별 승인 | `coding-git-sandbox.test.ts` | 동등(herdr는 격리 없음) | |

## Ghost 연동

| 항목 | 내장 대응 | 증거 | 상태 | 소유자 확인 |
| --- | --- | --- | --- | --- |
| `code_run`·`code_agents`로 내장 세션 시작·조회·후속 | 같은 도구 | `coding-embedded.test.ts`, 운영 accepted run 3건 | 동등 | |
| 맡긴 일 상세에서 실행 화면으로 이동 | 세션 딥링크 | 아래 「공백 해소」 | 공백→진행 | |
| 완료 보고가 담당 대화로 한 번 돌아옴 | `session:<id>:turn:<n>` | `coding-embedded.test.ts` | 동등 | |
| 취소·회수·예산 정지가 실행을 중단 | 세션 중단 | `coding-embedded.test.ts` | 동등 | |

## 당시 작업 범위

worktree 스페이스, 스페이스의 Git 변경 보기, 터미널 에이전트의 업데이트 대기, 에이전트 시작 양식과 omp 옵션, 맡긴 일에서 내장 세션 열기가 이 전환의 구현 범위였다. 기존 원장의 패널·터미널 식별자는 과거 실행을 읽을 수 있도록 보존했다.
