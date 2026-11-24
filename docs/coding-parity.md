# herdr 동등성 체크리스트

herdr 연동을 걷는 판단의 근거다([작업대](coding-workbench.md) 목표 2026-11-24). 항목마다 herdr에서 소유자가 하던 일, 내장 작업대의 대응, 증거, 상태를 적는다. 상태는 `동등`·`대체`(다른 방식으로 같은 결과)·`차이`(의도한 다름, 소유자가 받아들여야 함)·`공백`(할 일)이다. **herdr를 걷는 조건: `공백` 0개, `차이`는 소유자가 항목별로 승인, 「소유자 확인」 열이 모두 채워짐.**

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

## 공백 해소

진행 중인 항목은 구현·검증 뒤 이 표를 갱신한다. 아래는 이번 라운드(Host 2.31.0 예정)의 범위이며 상태 열은 증거가 생길 때만 바꾼다.

## herdr 철거 전 남은 일

1. 소유자가 「소유자 확인」 열을 설치한 앱에서 채운다(실물 Mac 창과 iPhone).
2. `차이` 항목을 하나씩 승인하거나 공백으로 되돌린다.
3. herdr 화면·`/api/herdr/*`·`code_run`의 herdr 실행·`coding_runs`의 pane 열을 걷는 별도 결정과 이행 계획(PDC·원장 호환 확인 포함).
