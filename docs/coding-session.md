# 코딩 세션 (Ghost 내장 코딩 에이전트)

소유자 결정 2026-11-23. Ghost가 비서이자 코딩 에이전트다. 코딩 하네스로 Pi(`@earendil-works/pi-coding-agent` 1.6.0)를 Host 프로세스에 SDK로 임베드하고, 소유자는 앱에서 직접, Ghost는 도구로 같은 세션을 다룬다. herdr 연동([coding-execution.md](coding-execution.md))은 폐기하지 않는다: herdr 터미널 에이전트(omp·Claude Code·Codex)는 그대로 열 수 있고, 내장 세션은 그와 나란히 있는 또 하나의 실행기다. `coding-execution.md`의 "Host는 별도 코딩 실행기를 띄우지 않는다"는 이 결정으로 대체한다.

## 구조

| 구성 | 책임 |
| --- | --- |
| `CodingSessions` (`apps/ghost-host/src/coding/`) | Pi `AgentSession` 생성·복원·프롬프트·중단, 이벤트를 `CodingItem`으로 정규화, 대화상자 대기, 도구 경계, 서브에이전트 오케스트레이션, worktree 격리 |
| 원장 `coding_sessions` | 세션 메타(`CodingSession`), 소유 맡긴 일, 마지막 보고한 턴. 정본 기록은 Pi 세션 파일 `<root>/coding-sessions/<id>/session.jsonl` |
| API `/api/coding/sessions…` | 앱의 유일한 접점. 이벤트는 SSE |
| Ghost 도구 | `code_run`·`code_agents`는 내장 세션도 시작·조회·후속 지시한다. 완료 보고는 맡긴 일의 원래 대화로 결정적 id로 돌아온다 |
| 앱 | 코딩 탭의 세션 화면: 기록·도구 카드(diff)·이미지 첨부·대화상자·목업 선택·변경 보기 |

## 불변식

1. **세션은 맡긴 일이 아니다.** 소유자가 직접 연 세션은 Ghost 없이 완결된다. Ghost가 연 세션은 맡긴 일에 묶이며 기존 `complete` → 검사 → 검토 → 수용 순서를 그대로 거친다. 에이전트의 말은 주장이고 git에서 읽은 변경은 관측이다.
2. **시작은 효과, 관찰은 읽기, 완료 보고는 대화 깨움.** `code_run`은 프롬프트가 접수되면 반환한다. 턴 하나를 기다리는 도구 호출은 없다.
3. **쓰기 격리.** 저장소 세션은 Host가 만든 worktree와 브랜치에서만 일한다. 파일 도구는 cwd 밖 경로를 거절한다. `bash`는 macOS seatbelt(`sandbox/seatbelt.ts`)로 쓰기를 cwd·임시 디렉터리·패키지 캐시에 가두고 네트워크는 연다. 그 밖의 실행은 `approval` 대화상자로 소유자가 건별로 허용한다. worktree·브랜치는 세션을 닫거나 취소해도 지우지 않는다.
4. **재시작은 턴을 재실행하지 않는다.** Pi는 턴 중간을 저널하지 않는다. Host가 `working`인 세션을 두고 내려가면 재시작 뒤 그 세션은 `failed`(알림: "Host가 다시 시작되어 턴이 중단되었습니다")이고, 소유자나 Ghost가 새 프롬프트로 이어간다. Ghost 보고는 "불확실"로 간다. 중단된 턴의 프롬프트를 자동 재전송하지 않는다.
5. **Host 업데이트는 `working`·`waiting` 세션을 busy로 센다.** 기존 업데이트의 idle 대기를 따른다. 소유자는 세션을 중단해 업데이트를 풀 수 있다.
6. **자격과 모델은 Ghost의 것이다.** Pi는 `~/.pi`를 읽지 않는다. 자격은 Ghost의 `secrets/`(pi-ai `CredentialStore`), 설정은 메모리 안, 세션 파일은 상태 루트 아래다.
7. **내장 세션의 모델 호출은 Ghost 대화와 같은 제공자 경로를 쓴다.** 소유자가 고른 모델 선택이 앱 설정과 어긋나지 않는다.
8. **도구 출력은 신뢰하지 않는 자료다.** 모델 맥락으로 복제하는 것은 Pi가 하며, Ghost 대화에 넣는 보고는 제한된 크기로 줄인다.

## 오케스트레이션 (`subagent` 도구)

Pi 확장(인라인 factory)으로 `subagent` 도구를 더한다. 같은 프로세스 안에서 자식 `AgentSession`을 만든다(컴파일된 Host에는 `pi` CLI가 없다).

- 역할: `scout`(읽기 전용: read·grep·find·ls, 압축된 맥락 반환), `worker`(전체 도구, 같은 worktree), `reviewer`(읽기 전용, diff 검토). 역할마다 짧은 시스템 지시와 도구 목록을 코드로 정의한다.
- 호출 형태: `{tasks:[{role, task}]}`(병렬, 최대 4개, 도구 호출 하나) 또는 `{chain:[{role, task}]}`(앞 단계의 결과가 `{previous}`로 다음에 들어감).
- 자식은 `subagent`를 쓰지 못한다(깊이 1). 자식 하나의 턴·토큰에 상한을 둔다.
- 자식의 각 도구 호출은 `tool` 항목의 `subagent`로 이어지고, 자식 하나는 `subagent` 항목 하나로 보인다. 부모 세션의 중단은 자식을 모두 중단한다.
- 같은 worktree에 쓰는 worker는 동시에 하나만 허용한다(병렬은 읽기 전용 역할에만).

## 소유자에게 묻기 (지능형 UI)

Pi 확장 UI 컨텍스트(`ctx.ui.select/confirm/input`)와 확장이 등록하는 도구를 `CodingDialog`로 받는다. 세션은 대화상자가 열려 있는 동안 `waiting`이고 소유자의 답이 오면 턴을 잇는다.

- `ask_owner_choices`(확장 도구): `{title, message?, options:[{id,label,description?,image?,html?}], allowText?}`. 목업 선택에 쓴다. `image`는 cwd 안의 이미지 경로, `html`은 cwd 안의 HTML 파일(스크립트·네트워크 없는 샌드박스 iframe 미리보기).
- `ctx.ui.confirm/select/input`은 각각 `confirm/select/input`으로 간다.
- 이미지를 주고받는다: 소유자가 붙인 이미지는 프롬프트의 `images`로 Pi에 가고(`ImageContent`), 에이전트가 만든 이미지(스크린샷·생성물)는 `tool` 항목의 `images`로 보이며 `GET …/file`로 서빙한다. 파일 서빙은 cwd와 세션 artifacts 밖을 거절한다.
- Ghost는 대화상자에 답하지 않는다. 대화상자는 소유자의 것이다(기존 규칙: 모델 도구에 다이얼로그 응답을 노출하지 않는다). 대화상자가 열린 세션을 Ghost 보고는 "소유자 응답 대기"로 알린다.

## Ghost 도구

- `code_agents`: 내장 세션 목록(상태·cwd·branch·소유 맡긴 일)과 herdr 에이전트를 함께 보여준다. `session`을 주면 그 세션의 최근 기록·변경·주장 대 관측을 제한된 크기로 읽는다.
- `code_run {repo | session, task, agent?, branch?}`: `agent`를 생략하거나 `ghost`면 내장 세션. `repo`면 새 세션(새 worktree·브랜치), `session`이면 후속 지시(`steer`는 작업 중, 아니면 `prompt`). `omp`·`claude`·`codex`는 지금까지처럼 herdr.
- 재시도 한도(한 시도에서 지시 최대 네 턴)·소유 독점(세션 하나에 열린 턴 하나)·Work 예산·권한 규칙은 [coding-execution.md](coding-execution.md)와 같다.
- 완료 보고는 `session:<id>:turn:<n>` 결정적 id로 원래 대화에 한 번 들어간다. 소유자가 직접 연 세션은 보고하지 않는다.

## 수용 기준

- 소유자가 앱에서 세션을 열고 프롬프트를 보내면 기록이 스트리밍되고, 도구 카드에 diff가 보이며, 이미지를 붙여 보낼 수 있다.
- 에이전트가 `ask_owner_choices`로 목업 두 개를 보여주면 앱에 이미지 격자나 HTML 미리보기가 뜨고, 소유자의 선택이 같은 턴을 이어간다.
- `subagent` 병렬 `scout` 두 개가 돌고 각각이 항목으로 보이며, 중단하면 모두 멈춘다.
- cwd 밖 쓰기(파일 도구·bash)가 거절되고, 승인 대화상자의 허용 한 번이 그 호출만 연다.
- Ghost가 `code_run`으로 세션을 열고, 턴이 끝나면 맡긴 일 대화가 한 번 깨어나며, Ghost는 변경 관측(diff)과 직접 실행한 검사를 확인한 뒤 기존 검증 경로로 결과를 낸다.
- Host 재시작 뒤 `working`이던 세션은 `failed`와 알림이 남고 재전송되지 않으며, 새 프롬프트가 같은 Pi 세션 기록 위에서 이어진다.
- herdr 연동 화면과 도구는 그대로 동작한다.
