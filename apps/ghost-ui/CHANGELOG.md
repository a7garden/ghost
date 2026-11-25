# Changelog

## 미출시

- 모든 Ghost와 코딩 에이전트가 기본 지침을 함께 받는다. 글은 답부터 꺼내고 em dash나 장식용 기호, 이모지 없이 평범한 문장부호로 쓴다. UI를 만들 때는 기본 버튼과 카드를 조립하는 대신 내용의 구조에 맞는 컴포넌트를 새로 디자인하되 조작은 익숙하게 둔다. 코드는 가장 작은 변경과 한 번의 좁은 검사로, 읽기는 필요한 범위만 병렬로 해서 토큰을 아낀다. 시스템 지침은 지침, 메모리, 범위와 첨부의 세 구획으로 나뉘어 메모리나 첨부가 바뀔 때 지침 전체가 다시 실리지 않는다. 근거는 `docs/agent-conduct.md`에 있다.
- Ghost의 답이 더 짧고 덜 꾸며진다. 모르는 부분은 가장 그럴듯한 경우로 답하고 그 가정을 밝힌 뒤 끝내며, 「알려주시면 더 맞춰 드릴게요」 같은 맺음말과 대화 답마다 붙던 「다음 단계」가 빠졌다. 대화 답은 문단으로 쓰고 짧은 답에는 제목을 달지 않는다. 체크리스트 항목은 굵은 항목, 콜론, 결과 순서라 em dash가 끼지 않는다. 브라우저 도구 설명의 중복을 걷어 브라우저를 쓰는 대화의 요청마다 약 4,700토큰이 줄었다. 실제 모델로 잰 비교는 `docs/agent-conduct.md`에 있다.
- 코딩 작업대가 「프로젝트 → 에이전트」가 되었다. 코딩의 스페이스는 프로젝트로 옮겨지고(같은 폴더의 프로젝트, 없으면 새 프로젝트), Ghost가 띄운 에이전트도 그 프로젝트 아래에 Ghost의 얼굴과 함께 보인다. 넓은 화면에서는 에이전트를 최대 3개까지 나란히 열고(⌘클릭·「옆에 열기」·끌어 놓기) 경계를 끌어 너비를 바꾼다. 앱 사이드바(⌘\)와 프로젝트 목록(⌘B)을 접을 수 있다.
- 새 에이전트는 모달 없이 지시 한 줄로 시작한다. 작업 폴더·worktree·모델은 컴포저의 칩으로 고르고, 첫 지시가 이름이 된다. 패널 머리는 한 줄이고 이름은 눌러서 바로 바꾼다. 모델 칩은 보내기 옆에 있다.
- 오케스트레이션의 「하네스 가져오기」가 omp·Claude Code·Codex 설정에서 가져올 항목을 골라 편집에 합친다.
- 터미널은 터미널 버튼을 눌러야 열리는 보조 서랍이다. 숨겨도 셸이 살아 있다. 휴대전화에서는 머리가 한 줄이고 터미널이 화면 전체를 쓴다.
- 버튼을 다시 디자인했다. 서비스 행의 「연결」·「계정 추가」를 비롯해 목록에 항목을 더하는 버튼(목표·문서·폴더·모델 제공자·대체 모델·에이전트·스페이스 추가 등)은 상자 없이 점선 `+` 슬롯과 글자로 보이고, 마우스를 올리면 슬롯이 채워진다. 기본·삭제 버튼에는 윗면 하이라이트가 들어가고 글자는 한 단계 굵어졌으며, 누르면 줄어드는 대신 1px 내려앉는다.
- 업데이트가 저절로 된다. 새 버전을 찾으면 Host가 받아 두고 대화·코딩 작업이 끝나는 대로 백업한 뒤 설치하고 다시 시작한다. 데스크톱 앱 업데이트도 Host가 최신이 된 뒤 스스로 설치하고(버전마다 한 번), Host가 새 버전으로 돌아오면 화면이 알아서 새로 불러온다. 취소했거나 설치에 실패한 버전, 시작하지 못해 되돌린 버전은 다시 자동으로 시도하지 않고 설정에서 직접 설치할 수 있다. 「새 버전 자동 설치」를 끄면 예전처럼 알림만 온다. iPhone 앱은 기기가 직접 묻기 때문에 계속 손으로 설치한다.
- 설정 › 업데이트에서 진행 상태가 따로 끼어드는 줄 없이 「최신 버전」 줄 안에서 바뀐다. 자동 업데이트 중에는 상단 설치 안내 띠가 잠깐 떴다 사라지지 않는다.

- 프로젝트 화면을 한 번 더 손봤다. 대화 맨 위에 「진행 중 N · 확인할 일 N」 띠가 있어 누르면 그 자리에서 진행 중인 일이 펼쳐지고, 대화창의 결정 카드·스레드·일정은 이 프로젝트의 것만 보인다. 맡긴 일 줄 오른쪽에는 진행 단계가 붙고, 문서는 넓은 화면에서 목록 옆에 편집기가 제자리로 열린다(저장하지 않은 변경이 있으면 먼저 묻는다).
- 프로젝트 설정은 한 페이지에서 값 옆에서 바로 고치고 바꾸면 저장된다. 자동 활동·승인 규칙·작업량 한도·성과와 비용·변경 기록은 「고급」 줄을 눌러 들어간다. 성과와 비용은 완료·반려·진행 중을 한 띠로 보이고 값이 없는 줄은 숨긴다. 승인 규칙은 이 프로젝트만의 규칙과 전체에서 상속한 규칙을 나눈다.
- 프로젝트 목록은 기다리는 일이 많은 순으로 서고, 줄 끝에 진행 중 개수와 확인 필요 배지가 보인다. 「일 맡기기」는 외곽선 버튼이 되었고 휴대전화에서는 탭 줄의 아이콘으로 접힌다. 「붙임」은 프로젝트 설정에서 「함께 읽을 자료」로 부른다.
- herdr 연동을 걷었다. 코딩 탭은 항상 작업대로 열리고, `code_run`·`code_agents`는 내장 세션만 쓴다. omp·Claude Code·Codex는 새 패널의 「에이전트」나 터미널에서 직접 실행한다. 터미널 글자 크기 조절이 작업대 터미널에 들어왔다.

- 로그인 핸드오프가 로그인에 맞춰졌다. 카드가 지금 보는 사이트에 저장된 로그인을 보여주고, 입력할 칸을 누른 뒤 「아이디」「비밀번호」「인증 코드」 중 하나를 누르면 Host가 그 값을 칸에 넣는다. 값은 화면이나 대화로 오가지 않는다. 직접 로그인하면 카드에 금고에 저장했다는 줄이 나타난다.
- Shade에 저장된 로그인은 핸드오프 카드에서 「가져오기」로 이 Ghost의 금고에 옮겨 쓴다. 직접 로그인한 새 로그인은 Shade가 에이전트 쓰기를 허용하면 Shade에도 저장된다(설정 › 금고에서 끌 수 있다). Shade가 잠겨 있거나 에이전트 접근이 꺼져 있으면 그 이유를 한 줄로 알려 준다.
- 연결 계정이 로그인 중심으로 바뀌었다. 이메일은 주소만 치면 서버·포트·보안 방식을 Host가 찾고(주요 서비스, 회사 도메인의 자동 설정, MX), 비밀번호만 남는다. 찾지 못한 서버만 「서버 설정」이 저절로 열린다.
- 이미 연결한 서비스는 「연결됨」으로 보이고 계정이 그 아래에 모이며, 「계정 추가」로 더 연결한다. 이 Mac의 GitHub CLI에 로그인된 계정은 한 번에 연결한다.
- 통화 지연을 줄였다. 통화를 거는 동안 대화를 미리 불러오고, 맥락이 길면 첫 마디 전에 압축해 둔다. 통화 중 답은 추론 수준을 낮게 해 첫 마디가 빨리 나온다. 「네, 확인해 볼게요.」처럼 문장이 끝나면 다음 글자를 기다리지 않고 바로 읽는다.
- `https://ghost.a7garden.com/go`로 들어가면 Tailscale이 켜진 기기는 `ts.net` 주소로 자동 이동해 코드 없이 들어오고, 꺼진 기기는 이메일 코드 로그인으로 간다. Chrome은 처음 한 번 로컬 네트워크 접근 허용을 물을 수 있다.
- 설정을 사람이 읽을 수 있게 다시 정리했다. 왼쪽 목록이 「Ghost와 일」·「연결과 기기」·「앱」으로 나뉘고, 자주 쓰지 않는 기계적인 항목(승인 규칙·변경 기록·작업량 한도·성과와 비용·모델 조합·외부 도구 서버)은 「고급」 아래 접혀 있다. 「호스트」는 「연결 상태」가 됐다.
- 「승인 규칙」은 규칙마다 한 문장으로 읽힌다(「브라우저 클릭 · 되돌릴 수 없는 일 → 막기」). 처음부터 있는 규칙 40여 개는 접힌 「기본 안전 규칙」에 모였고, 규칙 추가 양식은 도구 무늬·대상 ID 같은 말 대신 행동·대상·처리를 고르는 질문으로 바뀌었다. 저장하기 전에 규칙이 어떻게 읽히는지 미리 본다.
- 「변경 기록」은 JSON 대신 「내가 프로젝트를 만들었습니다」 같은 문장과 바뀐 항목(이전 → 이후)을 보인다. 원문은 「기술 정보」에 있다. 되돌리기는 그대로다.
- 「작업량 한도」, 「성과와 비용」, 「모델 조합」(예전 「모델 자리」), 「외부 도구 서버」, 「연결 상태」는 각 항목이 무엇을 정하는지 한 문장으로 말하고 같은 설정 행 모양을 쓴다. 개발자용 「추가 도구 무늬」는 Ghost 설정의 「고급」 안으로 접혔다.
- 불러오는 동안 「불러오는 중…」 문구 대신 내용 모양의 스켈레톤(`SkeletonText`·`SkeletonRows`·`SkeletonChat`)이 보인다. 대화 기록, 금고, 문서, 변경 목록, 설정, 폴더 선택, 데스크톱 앱의 첫 화면까지 같다. 화면 낭독기에는 같은 문구가 그대로 읽히고, 움직임 줄이기를 켜면 반짝임이 멈춘다.
- Tailscale이 켜진 기기에서 `https://macstudio.tail1d0d8d.ts.net:8443`을 열면 코드나 페어링 없이 소유자로 바로 들어온다. 허용한 Tailscale 계정만 되고, 다른 사이트나 같은 Mac의 다른 tailscale 서비스 포트에서 보낸 요청은 로그인으로 쓰이지 않는다. `ghost.a7garden.com`은 그대로 이메일 코드다.
- 프로젝트 화면을 다시 설계했다. 이름·받을 Ghost·폴더와 탭이 두 줄 머리에 모이고, 대화는 머리 아래를 가득 채우며 대화 도구(프로필·전화·스레드·일정)가 같은 줄로 올라왔다. 위쪽의 큰 빈 공간과 이중 스크롤이 없어졌다. 받을 Ghost가 있으면 프로젝트는 대화로 열린다.
- 프로젝트 탭이 아홉에서 넷(대화·맡긴 일·문서·목표)으로 줄었고 설정이 따로 있다. 결정은 맡긴 일 위의 「확인할 일」로 합쳤고, 계기·규칙·계측·구성 기록은 설정 안의 자동 활동·승인 규칙·성과와 비용·변경 기록으로 이름을 바꿔 옮겼다. 전체 설정과 명령 검색의 이름도 같다.
- 프로젝트 목록 줄에 받을 Ghost, 진행 중인 일 수, 확인 필요 건수가 보인다.
- 통화가 전화처럼 바뀌었다. 통화 화면은 지금 하는 일(듣는 중·받아쓰는 중·생각하는 중·작업하는 중·말하는 중)을 목소리 크기에 맞춰 보여주고, 말한 내용이 대화 기록으로 이어진다. 내 말은 받아쓰는 즉시 나타난다.
- 추론이나 작업이 필요해도 먼저 한마디로 답하고 일한다. 이 Mac 통화는 도구를 쓰기 전에 하려는 일을 먼저 말하고, 실시간 통화는 위임 전에 한 문장으로 알리며 20초를 넘기는 작업은 아직 하는 중이라고 알려준다.
- 설정 › 음성의 목소리 목록에서 목소리마다 들어볼 수 있다. 고르는 것과 듣는 것은 따로 눌린다. 실시간 목소리는 처음 한 번만 짧게 생성하고 이후에는 저장해 둔 샘플을 재생한다.
- iPhone 통화는 수화기(귀에 대면 화면이 꺼짐)와 스피커 중 고른다. 기본은 수화기이며 고른 경로를 기억한다. 통화 중에는 화면이 저절로 잠기지 않는다. 앱 업데이트(iPhone 빌드 17)가 필요하다.

- 다음 메시지 제안이 선택지 목록 대신 입력창 안의 회색 초안 한 줄로 나온다. Tab이나 →로 입력창에 넣고, ↑ ↓나 「1/3」 카운터로 다른 제안을 본다. 터치에서는 오른쪽 버튼으로 넣고, 글자를 누르면 그대로 입력창에 초점이 간다. 제안을 바꿔도 입력창 높이는 변하지 않는다.

- 스페이스·프로젝트·코딩 세션·자동 활동의 폴더를 경로 입력 대신 폴더 선택으로 고른다. 홈과 자주 쓰는 폴더로 바로 가고, git 저장소는 아이콘으로 구분하며, 자격 증명 폴더는 목록에 나오지 않는다. 앱·브라우저·iPhone이 같은 선택기를 쓴다.

- 코딩 세션의 터미널 명령이 자기 worktree의 자기 브랜치에 한해 `git add`·`commit`·`merge --ff-only`를 승인 없이 한다. hooks, config, 다른 브랜치, worktree의 `commondir`·`gitdir`는 계속 읽기 전용이고, 세션 worktree의 git 메타데이터가 바뀌면 Host의 git 호출이 거부한다.

- 백업에 코딩 세션 기록(대화와 첨부 이미지)이 포함된다. 체크아웃은 저장소의 브랜치에 있어 제외한다.
- 대화·도구를 실행하는 Pi 엔진을 1.6.0으로 올렸다.
- 코딩 탭에서 내장 코딩 세션을 열어 작업을 지시하고, 이미지 첨부·승인·목업 선택·파일 변경 확인을 한 화면에서 할 수 있다.
- 설정 › 코딩에서 내장 세션의 기본값과 Pi 패키지를 관리한다. 세션마다 설정을 바꾸고, 맥락 사용량을 확인하거나 바로 압축할 수 있다.
- 코딩 › 오케스트레이션에서 에이전트, 모델 대체 순서와 위임 연결을 편집할 수 있다. 전체 또는 세션별로 위임을 끄고, omp 구성을 미리 본 뒤 가져올 수 있다.
- 코딩 작업대가 스페이스·탭·분할 배치를 기억한다. 세션과 터미널을 나란히 열 수 있고, 휴대전화에서는 패널을 바꿔 본다. 기존 herdr 화면은 별도 메뉴에서 연다.
- 작업대 터미널은 연결이 끊겨도 실행을 계속한다. 다시 연결하면 남은 출력을 읽을 수 있고, omp·Claude·Codex·Pi가 작업을 마치거나 답을 기다리면 코딩 알림 설정에 따라 알려준다.
- Ghost에게 전화를 걸 수 있다. 대화 위쪽의 전화 버튼으로 통화를 시작하고, 말하면 Ghost가 같은 대화에서 답을 소리로 들려준다. 설정 › 음성에서 실시간(OpenAI GPT-Live, API 키 필요)과 이 Mac의 로컬 음성 중 엔진을 고른다. 통화 중 끼어들 수 있고, 통화 기록은 대화에 남는다. 한 번에 한 통화, 15분 제한. iPhone 앱은 마이크 권한을 요청한다(iPhone 빌드 15).
- 로컬 통화는 이 Mac 안에서 처리한다. 받아쓰기는 macOS 내장 음성 인식(Apple SpeechAnalyzer), 말하기는 Supertonic 3이며 목소리를 여성·남성 5종에서 고른다. 숫자와 단위는 읽을 수 있는 말로 바꿔 읽는다.
- Ghost가 떠 있는 herdr 에이전트와 결과를 읽고, 코딩을 맡긴 뒤 대화를 붙잡지 않고 기다린다. 코딩 패널과 담당 맡긴 일을 서로 열 수 있다. 완료 보고는 같은 맡긴 일로 돌아오며 에이전트의 주장과 Host의 변경 관측을 구분한다.
- 코딩에서 herdr의 스페이스·탭·패널을 관리하고, 셸이나 에이전트의 실시간 터미널에 직접 입력할 수 있다. 「기록」으로 이전 출력을 읽고, 휴대전화에서는 터미널 키로 선택지를 고를 수 있다.
- omp의 대화·모델·생각 수준·승인 방식을 선택해 시작할 수 있다. 패널에서 색상 기록과 Git 변경을 읽고, 셸 명령이나 파일을 보낼 수 있다. 입력을 기다리는 에이전트는 코딩 메뉴에 표시된다.
- 코딩 첫 화면에서 입력이 필요한 에이전트부터 보고 바로 답할 수 있다. 패널에 에이전트 대화와 접어 둔 작업 단계가 표시되며, 휴대전화 터미널 키는 한 줄로 정리했다.
- 설정 › 모델에서 Claude·Codex·Z.AI·MiniMax 구독의 사용량(5시간·주간 등)과 초기화 시각을 볼 수 있다. Claude는 이 Mac의 Claude Code 로그인에서 읽으며, 사용량을 제공하지 않는 제공자는 나오지 않는다.

## 2.28.1

- 휴대전화 앱에서 키보드 위의 시스템 보조 막대(^ v ✓)를 없앴다. 대화 영역을 아래로 끌면 키보드가 닫히고, 입력창은 키보드 바로 위에서 그만큼 넓게 쓴다. 앱 업데이트(iPhone 빌드 16)가 필요하다.

## 2.27.1

- 코딩 화면을 한 줄 머리로 줄였다. 보기 전환은 아이콘만 쓰고, 상태 줄·디렉터리 줄·탭 줄이 없어졌다. 입력창의 「스티어링」 표시와 작업 중 테두리 빛도 없앴다(설정은 그대로 동작한다).
- 첨부는 입력창 위의 썸네일로 보인다. 이미지는 이제 omp와 Claude에 실제 이미지로 전달된다(이전에는 파일 경로 글자만 갔다).
- 끝난 에이전트의 셸 패널에 「이어서 시작」「새로 시작」이 한 번에 뜬다. 목록의 `+`는 최근 디렉터리를 골라 바로 에이전트를 여는 메뉴이고, 전체 폼은 「새 스페이스…」에 있다.
- 코딩 탭에 들어가면 마지막에 쓰던 에이전트가 바로 열린다. 보낸 메시지는 바로 대화에 흐리게 나타나고 실패하면 다시 보내거나 입력창으로 되돌린다.
- 에이전트가 끝나거나 종료될 때도 푸시로 알린다(설정에서 「답이 필요할 때만」·「끔」 선택 가능). 알림을 누르면 해당 패널이 열리고, 사라진 패널이면 코딩 목록이 열린다.
- 모델을 바꾼 뒤 보낸 메시지가 새 모델로 간다.
- 대화 탭은 메인 Ghost의 대화를 바로 연다. 대화 도구는 한 묶음으로 모았고, 확인 요청이 길어도 답하는 버튼이 화면 밖으로 밀리지 않는다.

## 2.26.2

- 휴대전화 앱에서 키보드가 올라와도 하단 탭이 입력창을 가리고 입력창 높이 조정이 적용되지 않던 문제를 고쳤다. 입력창이 키보드 바로 위에 온전히 보인다.

## 2.26.1

- Claude의 모델 목록에 기본·Opus·Sonnet·Haiku·opusplan·`[1m]` 별칭과, 이 Mac에서 실제로 써 온 모델 ID가 모두 나온다.
- 슬래시 명령의 결과가 대화 보기에 그 자리에서 나온다(예: `/compact`의 안내, Claude의 `/context`). 모델 선택창처럼 키 입력을 기다리는 명령은 터미널 보기로 넘어간다. 결과 블록의 「터미널에서 보기」로 원래 화면을 볼 수 있다.
- omp 19.1에서는 `/model <이름>`이 명령이 아니라 일반 대화로 전달되던 문제를 고쳤다. Host가 `/switch <이름>`으로 바꿔 보내며, 바뀐 모델이 입력창에 바로 반영된다.

## 2.26.0

- 코딩의 omp·Claude 패널은 터미널 보기에서도 후속 지시 입력창이 보여, 대화로 바꾸지 않고 바로 답할 수 있다. 터미널 도구 막대의 중단 버튼은 입력창의 중단 하나로 합쳤다.
- 입력창에서 모델을 바꾼다. 대화의 현재 모델이 입력창 아래에 보이고, 누르면 목록에서 골라 `/model`을 대신 입력한다. 터미널에서 `/model`로 바꿔도 표시가 따라온다. 일하는 동안에는 바꿀 수 없다.
- `/`를 치면 에이전트가 받는 슬래시 명령(omp는 실행 중인 omp가 알려 주는 목록, Claude는 내장 명령과 사용자·프로젝트 명령 파일)이 목록으로 뜬다. 고르면 입력창에 채우기만 하고, 보낸 명령의 결과는 터미널 보기에서 이어서 본다.
- 탭·분할·셸의 에이전트 시작은 메뉴에서 한 번에 만든다(기본 에이전트, 질문 없음). 이름·디렉터리·옵션을 정하려면 「… 옵션」을 쓴다. 새 스페이스는 마지막에 쓴 디렉터리를 채워 연다.

## 2.25.3

- 대화 보기가 없는 에이전트(omp·Claude 외)의 코딩 패널에서는 터미널 보기에서도 후속 지시 입력창이 보인다.

## 2.25.2

- Ghost 대화와 코딩 입력창을 좁은 화면에 맞췄다. 확인 요청과 입력창 사이에 여백을 두고, 진행 중 테두리가 잘리지 않도록 했다. 키보드를 띄운 채 긴 글이나 첨부를 보더라도 입력 버튼이 아래에 남는다.
- 첨부 미리보기의 삭제 버튼이 썸네일과 실패 문구를 가리지 않는다. 코딩의 다음 지시 제안은 구분선으로 묶이고, 데스크톱의 「최신 메시지」 버튼은 본문 글자를 덮지 않는다.

## 2.25.1

- 터미널 보기의 도구를 하나의 막대로 묶었다. 「직접 조작」은 키보드 아이콘 토글이 되어 켜진 상태가 보이고 다시 누르면 끝난다. 글자 크기·작업 중단과 높이·색이 같으며, 휴대전화에서는 아이콘만 나와 제목 줄을 침범하지 않는다.
- 보기가 하나뿐인 셸 패널에서는 쓸모없는 한 칸짜리 탭을 없앴다. 터미널에서 Shift+Esc는 이 막대로 나온다.
- 승인을 기다리는 에이전트의 대화 보기에는 잠긴 입력창 대신 승인 카드만 보인다.
- 목록의 패널 행에서 「⋯」가 제목 줄에 맞는다.

## 2.25.0

- 코딩 입력창을 새로 만들었다. 대화 보기에서만 나오며, 에이전트가 일하는 중에도 보낼 수 있다. omp는 설정 › 코딩 › 「작업 중 보내기」에서 고른 대로 스티어링(지금 작업에 바로 전달)이나 대기열(끝난 뒤 전달)로 가고, ⌥Enter는 다른 방식으로 한 번 보낸다. 다른 에이전트는 자기 Enter 동작을 따른다.
- 터미널·변경 보기에서는 하단 입력창을 없앴다. 터미널은 직접 입력하고, 휴대전화는 터미널 키 줄을 쓴다.
- 「Esc」 버튼 대신 정지 아이콘(작업 중단)을 쓴다. 입력창 안과 터미널 보기 머리에 일하는 동안만 나온다.
- 답이 끝나면 보낼 만한 다음 메시지를 입력창 위에 띄운다(코딩의 omp·Claude 대화와 Ghost 대화). Tab이나 탭으로 입력창에 넣을 뿐 보내지 않는다. 설정 › 모델에서 끄거나 제안 모델을 고를 수 있다. 제안마다 요청이 한 번 더 나간다.

## 2.24.4

- 휴대전화 터미널의 가로 스크롤을 없앴다. `Esc`, `Tab`, `↑`, `↓`, `Enter`는 바로 누르고, 나머지는 `…`에서 고른다. `Ctrl`이나 `Alt`가 다음 입력을 기다리는 동안에는 `…` 자리에 해당 키 이름이 표시된다.

## 2.24.3

- 휴대전화 Ghost 대화에서 프로필·안건·스레드를 뒤로 가기와 같은 줄에 놓았다. 대화 첫 줄 위를 가리던 그라데이션을 없앴다.
- 터미널의 별도 「폰 크기로 맞추기」를 없앴다. Ghost가 만든 패널은 자동으로 맞고, 다른 곳에서 연 패널은 「직접 조작」을 선택하기 전까지 원격 크기를 건드리지 않는다. 다른 기기가 조작 중이면 먼저 확인한다.
- 코딩 대화에서는 연속된 작업만 묶어 답변 순서를 지킨다. 같은 작업은 횟수로 표시하고, 실패는 내역을 펼치지 않아도 보인다. 앱의 접기·펼치기 표시는 삼각형 대신 `+`와 `−`를 쓴다.
- 새 코딩 스페이스는 경로·설치된 에이전트·첫 지시로 시작한다. 기본은 격리된 새 워크트리다. 직접 쓰기나 승인 생략을 선택하면 옵션을 닫아도 표시가 남는다.

## 2.24.2

- 휴대전화 홈에는 가장 오래 기다린 확인 한 건만 펼쳐 두고, 나머지는 제목 옆에서 연다. 대화에서는 확인 요청을 한 줄로 접어 메시지와 입력창을 가리지 않는다. 열었다가 접어도 작성 중인 답은 남는다.
- 대화 목록 위에서 작업실로 들어가 프로젝트·목표·메일·맡긴 일을 찾을 수 있다. 프로젝트의 아홉 섹션은 한 줄에서 바꾸고, 설정은 이름으로 검색한다. 담당 Ghost와 메일함을 바꿀 때도 필터가 목록을 한 줄 더 밀어내지 않는다.

## 2.11.1 — 2026-11-17

- Mac 관리 Ghost가 `ls`·`du`·`grep`·`find` 같은 읽기 전용 명령마다 소유자에게 승인을 요청하던 문제를 고쳤다. 2.11.0의 정책 기준이 직접 읽기를 거절당한(비공개 경로·프로젝트 밖 검색) 모든 Mac 명령을 되돌릴 수 없는 쓰기로 보아 메인 검토와 자동 대기를 건너뛰었다. 이제 Host가 읽기 전용 형태임을 직접 확인한 명령은 이전처럼 메인 Ghost가 먼저 검토하고, 소유자의 자동 대기(기본 30분) 뒤에 진행한다. 모델이 적은 위험 설명은 판정에 쓰지 않는다.
- 읽기 전용 형태로 확인되지 않은 명령(삭제·이동, `git config --list` 등)은 계속 소유자의 승인을 기다린다. 밖으로 나가는 `git ls-remote`는 같은 대화가 비공개 데이터와 외부 입력을 함께 다뤘을 때만 소유자가 정한다.

## 2.11.0 — 2026-11-16

- 프로젝트가 맡긴 일·결정·목표·자동 활동이 귀속되는 단위가 됐다. 이전의 「공간」은 「프로젝트」로 이름이 바뀌었고, 기존 문서 금고와 ID는 그대로 이어진다. 프로젝트는 경로·문서 금고·맥락 문서·받을 Ghost·상태·한도를 묶으며 PC 권한은 주지 않는다. 프로젝트에 속하지 않은 일과 목표도 그대로 쓴다.
- 프로젝트 화면에 대화 · 목표 · 맡긴 일 · 결정 · 문서 · 계기 · 규칙 · 계측 · 구성 기록이 있다. 계기는 예약·프로젝트 커밋·연결 계정 조회처럼 일을 시작시키는 조건이고, 규칙은 허용·거절·검토 정책이다. 설정 변경은 기록되고 되돌릴 수 있다.
- 목표는 팀 전체 또는 한 프로젝트의 것이다. 목표 화면은 프로젝트별로 묶어 보이고, 프로젝트의 「목표」 탭에서 그 프로젝트의 목표를 추가·수정한다. 열린 목표 한도는 팀과 프로젝트마다 따로 센다(프로젝트 한도로 조정). 한도가 차면 추가 창에서 이유를 알려 주고, 어느 곳이든 자리가 있으면 버튼은 열려 있다.
- 홈과 맡긴 일 목록의 줄에 일이 속한 프로젝트 이름이 보인다.
- 일은 Mac의 작업 공간에서 Work마다 격리된 경계(Seatbelt) 안에서 실행한다. 모델 한도 대기, 실행 예산, 반복 호출 방지, 설정에서 고르는 한도로 장기 실행이 끊기지 않게 했다.
- 효과를 허용·거절·검토하는 정책 규칙을 저장하고 실행 직전에 다시 확인한다. 연결한 MCP 서버의 도구는 필요할 때 불러온다.
- 문서 도구의 이름을 「프로젝트 문서」로 바꿨다. 표 미리보기의 접근성 단축키 안내가 `Enter Scope`로 잘못 바뀌어 있던 것을 `Enter Space`로 바로잡았다.

## 2.10.2 — 2026-11-12

- 맡긴 일 화면은 필요한 정보만 보인다. 수정 횟수, 상태 줄의 결과 자료, 판정의 근거·수정 범위, 컨테이너 실행 환경, 위임 칸의 상위 일과 현재 일, 실행 기록의 도구 이름과 「완료」 표시를 뺐다. 결과 자료는 결과 칸에만, 완료 기준은 결과 확인 카드가 없을 때 상태 줄에만 있다.
- 끝난 일에는 진행 막대와 기한을 그리지 않고 「N분 전 끝남」을 보인다. 실패한 단계가 진행으로 잘못 보이던 문제가 없어졌다. 목록 줄에서도 진행 막대를 뺐다.
- 멈춘 이유를 한국어로 보인다(「기한이 지났습니다」 등). 판정으로 끝난 일은 이유를 한 줄로 말하고, 판정 사유는 결과 칸에만 둔다.
- 메인 Ghost가 대신 수락하거나 수정을 요청한 결과는 판정한 쪽을 「메인 Ghost」로 표시하고 메인의 확인 내용을 사유로 보인다(이전에는 「사용자 확인」).
- 수정 진행 중에는 지난 판정만 보이고, 판정받은 이전 결과는 감춘다.
- 기다리는 일은 하위 일·질문·결정을 가리지 않고 「응답 대기」로 읽는다.

## 2.10.0 — 2026-11-12

- 결과 확인 카드는 메인 Ghost의 요약을 본문으로 보여 주고, 맡긴 일의 전문 보고·결과 자료·완료 기준은 「전문 보기」에 접어 둔다. 결과 확인에는 추천을 붙이지 않고 「추천대로 처리」에서도 빠진다.
- 확인 카드의 종류 표시(아이콘과 종류 이름)가 카드의 유일한 색이다. 결과·문서는 잉크, 질문·브라우저 대기는 주황, 실행 승인·금고 요청은 빨강이며, 급한 카드가 차분한 카드보다 앞에 선다.
- 확인할 일 목록의 줄에 자동 처리 마감(「마감 N분」)을 표시하고, iPhone에서 줄을 왼쪽으로 밀거나 데스크톱에서 `L`을 눌러 나중에로 보낸다. 접어도 건수는 그대로다.
- 보낸 메시지가 곧바로 대화에 올라간다. 연결이 끊긴 동안 쓴 메시지는 기다렸다가 연결이 돌아오면 순서대로 보내고, 실패한 메시지는 그 자리에서 「다시 보내기 · 버리기」를 고른다.
- 앱이 백그라운드에서 돌아올 때 「연결 끊김」이 깜빡이지 않는다. 처음 4초는 표시하지 않고, 그 뒤 「재연결 중…」, 20초가 지나야 「연결 끊김」과 「다시 연결」을 보인다. 마지막 화면을 기기에 보관해 앱을 열면 실제 내용부터 그린다.
- Ghost는 매 턴 Host가 붙인 현재 시각을 기준으로 「지금」을 말하고, 소유자에게 보이는 응답에 em dash를 쓰지 않는다.
- 메인 Ghost는 결과 보고와 완료 기준이 함께 있는 결과 확인만 대신 처리하며, 수정 요청 사유를 담당 Ghost에게 그대로 전한다.

## 2.9.0 — 2026-11-12

- `https://ghost.a7garden.com`에서 웹으로 Ghost를 쓴다. Cloudflare Access 이메일 인증코드로 소유자만 들어오고, Host가 Access 로그인 토큰과 이메일을 다시 확인한다.
- 웹 로그인 세션이 끝나면 화면이 연결 오류에 머무르지 않고 다시 로그인 화면으로 넘어간다.

## 2.7.2 — 2026-11-11

- Ghost의 노란 띠·초상 테두리는 지금 답할 결정이나 차단된 맡긴 일이 있을 때만 표시한다. 종료된 실패 작업은 하위 작업을 포함해 현재 확인 요청으로 표시하지 않으며, 실패 기록과 알림은 그대로 보존한다.
- 2.7.1의 worktree 산출물 경로 수정과 브라우저 오류 분류 개선을 함께 배포한다.

## 2.4.5 — 2026-11-11

- 연결 계정을 서비스 목록과 아이콘 그리드로 바꿨다. 주요 메일은 서버·포트 선택 없이 계정 주소와 앱 비밀번호로 등록하며, 직접 서버 설정도 유지한다.
- Google·Outlook·X·Notion·Slack은 OAuth 앱을 처음 한 번 설정한 뒤 서비스 로그인·동의로 계정을 추가한다. Google은 Drive 파일 읽기를 선택할 수 있으며 메일 계정은 별도로 연결한다.
- 목록에 없는 서비스도 Ghost에게 연결을 맡길 수 있다. 발급한 키는 브라우저 발급 화면이나 금고에서 모델에 노출하지 않고 등록·인증 확인한다. API 접근은 Ghost별로 허용하고 외부 쓰기는 별도 확인한다.

## 2.5.0 후보 — 2026-11-10, R2 수용·배포 대기

- 기억 저장·검색·정리를 Host 안에 탑재했다. 외부 Oxibrain 프로세스나 기억 관리 Ghost를 사용하지 않는다.
- Ghost별 개인 메모, 팀 공유 기억, 소유자 프로필을 구분하고 대화 원문을 한국어로 검색한다.
- Ghost 설정에서 기억을 편집·삭제하고 이전 버전과 자동 정리 결과를 확인한다. 동시 편집이 충돌해도 초안은 보존한다.

## 2.4.5 — 2026-11-11

- 연결 계정을 서비스 목록과 아이콘 그리드로 바꿨다. 주요 메일은 서버·포트 선택 없이 계정 주소와 앱 비밀번호로 등록하며, 직접 서버 설정도 유지한다.
- Google·Outlook·X·Notion·Slack은 OAuth 앱을 처음 한 번 설정한 뒤 서비스 로그인·동의로 계정을 추가한다. Google은 Drive 파일 읽기를 선택할 수 있으며 메일 계정은 별도로 연결한다.
- 목록에 없는 서비스도 Ghost에게 연결을 맡길 수 있다. 발급한 키는 브라우저 발급 화면이나 금고에서 모델에 노출하지 않고 등록·인증 확인한다. API 접근은 Ghost별로 허용하고 외부 쓰기는 별도 확인한다.
## 2.3.1 — 2026-11-10

- 제안된 문서를 원문 텍스트 대신 읽기 화면으로 연다. Markdown 제목·표·목록·코드를
  렌더링하고 원문으로 전환할 수 있다. HTML 제안은 기존의 정제된 샌드박스
  미리보기를 사용한다. 승인 전 저장이나 문서 변환은 하지 않는다.
- 비교·선택·입력의 수고를 줄일 때 긴 설명보다 `present_ui`를 우선 선택하도록
  직접 대화 지침을 바꿨다. 승인 절차와 일반 메시지의 경계는 유지한다.
- [릴리스](https://github.com/a7garden/ghost/releases/tag/v2.3.1) 소스 `93ebdd7`.
  Host 733 통과·9 생략, UI 184 통과, Rust 21 통과, 타입·빌드·서명·매니페스트 검증 통과.
  격리 Host의 데스크톱·390px 화면에서 문서 읽기/원문 전환과 HTML 격리를 확인했다.
  운영 업데이트는 진행 중인 대화 4개 때문에 `waiting`으로 남았다(운영판 2.3.0).
  대화를 중단하지 않았으며 유휴 시 자체 설치를 기다린다. 설치 후 실제 앱 확인은 미완료다.

## Unreleased

- 확인할 일을 카드 덱에서 한 줄 목록으로 바꿨다. 줄마다 추천 답 · 메인에게 · 나중에를 바로 누르고,
  줄을 누르면 그 자리에서 전체 카드가 펼쳐진다. 소식과 처리한 결정은 접어서 아래에 둔다.
- 추천대로 처리: 추천이 붙은 되돌릴 수 있는 결정을 목록에서 골라 한 번에 처리한다.
  금고 요청 · 브라우저 대기 · 손실 위험 명령은 들어오지 않는다.
- 메인에게 맡기기: 되돌릴 수 있는 결정을 메인 Ghost에게 넘겨 바로 정하게 한다(`decision.delegate`).
  메인이 정하지 못하면 의견을 달아 다시 확인할 일로 돌아온다. 맡긴 동안은 배지 · 홈 · 펫 수에서 빠진다.
- 나중에: 이 기기에서 그 결정을 대기열 맨 뒤로 보낸다. 홈 · 대화의 카드 덱에서도 `L` 로 된다.

- 데스크톱 펫의 잘리는 상태 말풍선을 짧은 일 건수로 바꿨다. 호버하거나 누르면
  확인할 일과 진행 중인 모든 맡긴 일을 제목·상태 목록으로 펼치고, 해당 항목을 바로 연다.
  긴 제목은 줄바꿈하고 많은 일은 스크롤한다. 화면 가장자리의 위치 복원과 끌기 중 펼침 방지도 포함한다.
- 확인·제안 UI를 질문과 선택 중심으로 바꿨다. 장식용 카드 겹침과 중첩된 상자를 없애고,
  질문은 행 전체를 눌러 답한다. 직접 답하기는 필요할 때 펼친다. 여러 요청은 제목이 보이는
  대기열에서 고르며 채팅·홈·확인할 일·맡긴 일에서 같은 UI를 쓴다.
  채팅에서는 긴 근거만 스크롤하고 질문과 응답 영역은 남긴다. 실행 대상·명령·위험,
  자동 처리 조건, 위험 요청의 두 번 확인과 금고 전용 입력 경로는 유지한다.
- 채팅 안의 선택 양식도 개별 상자 대신 한 목록으로 묶었다. 선택지와 설명의 정렬을 맞추고,
  전송·수정·오류를 같은 영역에 둔다. 선택만으로 전송하지 않으며 재시도 식별자와 입력 보존은 유지한다.
- 기본 스크롤바를 없앴다. 마우스·트랙패드에서는 모든 스크롤 영역(홈, 설정, 스레드, 파일,
  결정 카드, 코드 블록, 검색·메뉴 목록)이 대화와 같은 ScrollRail을 쓴다. 포인터를 올리거나
  직접 스크롤하면 가장자리에 위치 막대가 나타나고, 끌거나 누르거나 휠로 움직인다. 가로로
  넘치는 영역은 아래쪽에 같은 막대가 생긴다. 터치는 시스템 표시를 유지한다.
- 기본 Ghost가 살아 움직인다. 눈을 깜빡이고(가끔 두 번), 고개를 돌려 둘러보며 몸을 그쪽으로
  기울인다. 56px 이상의 초상은 가까운 포인터를 따라 쳐다본다. 누르면 깡충 뛰며 깜빡인다.
  56px 미만은 쉬는 동안 다음 동작까지 프레임을 쓰지 않는다. 28px 미만의 목록 아바타, 애니메이션 끄기,
  동작 줄이기 설정에서는 정지한다. 안경은 얼굴과 함께 움직이고, 꾸미기 미리보기도 움직인다.
- 기본 Ghost의 몸이 말랑해졌다. 누르면 웅크렸다가 늘어나며 뛰고, 착지하면 납작해졌다가
  몇 번 출렁이며 멈춘다. 고개를 돌릴 때 윗부분이 뒤따라 흔들리고, 큰 초상은 천천히 숨을 쉰다.
- 마우스를 올리면 기본 Ghost가 살짝 눌리며 눈을 가늘게 뜨고 커서를 본다. 올려 둔 동안 가끔
  몸을 흔들고, 떠나면 튕기듯 돌아와 잠시 뒤 정면을 본다. 터치에는 반응하지 않는다. 둘러보기 간격을
  늘리고 고개 돌릴 때의 출렁임을 줄여, 24명이 모인 목록에서 동시에 움직이는 수가 평균 8.5에서 3으로 줄었다.
- 최신 메시지 버튼은 불투명한 표면을 사용해 어두운 테마에서도 HTML·이미지 위의 글자가
  흐려지지 않는다.
- iPhone UI 점검: 금고·자동 활동·연결 계정의 위치 제목을 바로잡고 설정의 중복 제목을
  줄였다. 스위치·체크박스는 모양을 늘리지 않고 44px 터치 영역을 제공하고, 꾸미기의
  색상은 찌그러지지 않는 44px 원으로 표시한다.
- 대화의 차트 글자와 범례를 터치 화면에 맞추고 비교 표의 첫 열을 고정했다.
  선택·입력 응답은 넓은 버튼과 키보드 위 전송 영역을 사용한다. 정적 HTML은 내용을
  측정해 높이를 맞추며 크기 조절 손잡이 대신 전체 화면 보기를 제공한다. 스타일·이미지가
  있는 HTML은 잘못된 축소 측정 대신 380px 읽기 영역을 사용한다. 불투명 샌드박스·리소스
  차단 CSP·일반 메시지 전송 경로는 유지한다.
- Ghost가 먼저 보낸 대화는 홈과 확인할 일에서 초상·이름·첫 문장으로 열 수 있다.
  iPhone 알림 설정에 대화를 추가하고 네 종류를 2×2로 배치했다.
- 데스크톱·iPhone의 모든 설정, 문서 편집기, 결정 종류, 실시간 대화와 도구 기록,
  대화형 응답 전송·수정·키보드·전체 화면에 시각 회귀 검사를 추가했다.
- 프로젝트별 Ghost 접근 설정을 없앴다. 모든 활성 Ghost가 프로젝트 문서를 읽고 수정안을 제안하며, 실제 저장은 기존 소유자 검토를 거친다.
- 대화·홈·맡기기 작성창에서 `#`로 프로젝트를 골라 함께 보낸다. 대화 기록에는 프로젝트 칩이 남고, Ghost는 답하기 전에 해당 문서를 읽도록 안내받는다.
- 프로젝트 화면에서 바로 대화를 시작하거나, 프로젝트를 포함해 Ghost에게 일을 맡긴다.
- iPhone은 같은 웹 UI를 연다. 56rem 아래에서는 하단의 홈·받은 일·맡긴 일·작업실·설정으로
  이동하고, 대화와 상세 화면은 본문에 자리를 내준다. 터치 메뉴·적응형 시트·키보드 높이에
  맞는 작성창을 공유 컴포넌트에서 제공한다. 데스크톱 레이아웃은 유지한다.
- iOS 셸은 알림 진입·복귀·테마·연결 해제를 웹 UI와 연결한다. 기기 설정은 이 기기의
  알림 권한과 종류별·Ghost별 알림을 관리하며, 빠른 설정 변경도 순서대로 저장한다.
- 좁은 화면의 제목·뒤로 가기는 상단에 모으고, 메시지 메뉴는 복사 옆으로 옮겨 본문 너비를
  유지한다. 기기 알림 카드와 Ghost 목록은 같은 여백과 왼쪽 정렬로 다듬었다. 맡긴 일은
  상태 선택과 일 맡기기를 한 줄에 놓고, 필터는 작은 알약 모양에 넉넉한 터치 영역을 둔다.
- 좁은 Mac 앱 창은 기존 제목 표시줄·창 끌기·전체 메뉴를 유지한다. 검색의 Enter는 터치에서만
  키보드를 닫고, 시트 손잡이는 키보드 초점을 차지하지 않는다.
- 금고 (설정 → 금고): the owner's vault item list — kind, origin, username, card
  ••••last4/expiry, per-Ghost grants and one-time expiry — with add/edit/delete.
  Secret fields stay write-only: an empty field keeps the stored value, stored secrets
  read as 저장됨 and never as a value; a password generator fills 20 random characters;
  Apple Passwords/Chrome CSV import reports 가져옴·건너뜀·거부됨 counts.
- A question carrying `proposal.secureForm` renders the secure form for its kind
  (login·card·contact·secret fields, the requested origin and reason, 금고에 저장 checked
  by default) and answers through `POST /api/vault/requests/:decisionId` only — the chat
  answer path refuses these decisions. A `browserHandoff` question explains the waiting
  Chrome window on this Mac, shows its url and reason, and offers 다 했어요 next to 거부.
- Work verdicts show 근거 (what the reviewer observed) and 수정 범위 (what a revision may
  change) whenever the verdict records them.
- Ghost 설정 도구 권한: the new browser tools group as 브라우저 and the vault tools as 금고,
  each with Korean labels; every contract tool is labeled, so none falls to 기타.
- 자동 활동: per-Ghost standing activities live in 설정 → 자동 활동. The owner writes
  the brief, completion criteria and source (일정, PR filters, mail filters), picks tools
  from what the Ghost already has, sets limits (runs/day, concurrency, timeout, self-check
  interval) and the bound source policy (PR 댓글·메일 회신: 거부 · 승인 후 실행 · 허용) — nothing
  activates before a save. Rows show the next run, the last run's state, skipped/changed
  marks and the last error; per-row 실행 runs once, 시험 dry-runs (no writes, cursor left
  alone — the run itself still lands in history), pause offers to stop the running 맡긴 일
  too, and 모두 멈추기 pauses every enabled activity's future auto runs and cancels the
  currently running 맡긴 일. Run history lists each run with its watched item and opens its Work.
- 연결 계정: GitHub·Gitea tokens and IMAP mail accounts are owner settings with
  create/edit/test/delete. Secrets start blank every time and are never shown again; a
  name-only edit keeps the stored credential, changing endpoint or account requires
  retyping it or removing it explicitly; test results appear under their row, distinct
  from an empty list.
- PC 직접 실행: Ghost 설정 → 운영 carries the owner-only unrestricted-PC grant with a
  warning that shell affects the whole Mac and network and is not confined by PR/mail
  approval policy. 일 맡기기 offers 이 Mac — with the actual working folder — only for granted
  Ghosts; container stays the default.
- Ghosts can carry the 활동 제안 tool pill (`activity_propose`): a proposal for the owner,
  never an activation.
- A deferred activity (budget, concurrency) reads as 대기 on its row — the reason and the
  retry time as ordinary waiting text, separate from the red last error. The host
  auto-pauses an activity after repeated genuine failures; the row's 재개 is the owner's
  reset and restarts the schedule.
- Automatic activity outcomes stay in Work results, run history and notifications; they
  do not wake an unrestricted direct-conversation turn. Successful no-change runs stay quiet.
- Failed account saves keep the dialog and typed fields. Activity edits retain exact
  cadence and second precision; SMTP distinguishes implicit TLS from required STARTTLS.
- Activity tools retain granted browser/vault capabilities and document reads but exclude direct-only proposals.
  PR 댓글·메일 회신 applies only to bound mail replies/PR comments,
  not generic browser actions or file/shell tools. Selected browser/Host tools retain
  their independent authority; browser/vault keep their separate approvals, and the PC
  grant is not a jail or approval-enforcement boundary.
- Deleted activities' retained runs stay visible; run history exposes self-check reasons,
  and pause/stop failures remain inside the confirmation dialog. Work detail shows its
  explicit execution environment and PC folder.
  Work conversations expose older-message paging and keep read errors visible.
- Visual tests mask the actual temporary project breadcrumb with stable test-only geometry,
  rather than depending on a particular TMPDIR path.

- Conversations answer their own decisions: a Ghost's pending questions, approvals and result
  reviews — including those from its older conversations and from threads begun there — sit
  above the composer, so opening a Ghost that needs you no longer means going to 확인할 일.
- Settings: slimmer navigation and shared section surfaces. Ghost selection is a compact,
  searchable roster; model, role and capabilities precede separate operating controls.
- Model fallbacks form a connected route with provider names, search, reorder/remove
  actions and duplicate-choice prevention. Failed edits preserve the saved order.
- Models: standard providers expose refreshed models.dev catalogs automatically; ChatGPT
  subscriptions discover account models from Codex. Cached metadata keeps offline selection
  working, and manual model entries stay editable without saving the automatic catalog.
- Files open on a broad reading sheet instead of inside a small generic dialog. Markdown
  has 읽기/원문 views, document typography and local footnote navigation; source files have
  line numbers and optional wrapping. Copy and save preserve the original content.
  Images (including SVG), PDFs, empty files and unsupported binary files keep distinct
  presentations; the sheet adapts to narrow screens and restores focus on dismissal.
- Sidebar roster: a 고정 group (the default Ghost plus pinned ones) and a Ghost pool below it.
  The pool folds from its own header — sticky while scrolling, so folding no longer means
  hunting for a button at the bottom — and a folded pool still shows the Ghosts that need you
  or hold the open conversation. Pin from a Ghost's context menu.
- Thread cards: a settled thread folds to one quiet line (its outcome line already returns
  beneath it); a thread waiting on the owner is answered from the conversation's dock.
- Composer: `/` opens the composer's actions by keyboard (Korean words match), `@` hands the
  message to a chosen Ghost as a 맡긴 일 addressed to it; the model chip names the model and
  keeps its provider in the tooltip.
- Title bar: back/forward (`⌘[` `⌘]`) and a breadcrumb trail — section, the thing inside it,
  the open thread and the threads it came from; each step goes up to it.
- Sidebar: destinations and 설정 stay put; the roster scrolls under sticky labels, fades out
  while more follows, and a rail marks Ghosts that are working or need you. Opening a Ghost
  brings its row into view.
- The thread panel grows open beside the conversation and closes in reverse.
- The empty conversation no longer repeats the Ghost's portrait.
- Reports read like a person: a returned Work is an outcome line hooked to its thread card
  (state, title, files as chips, a failure's reason); who judged it, how long it took and its
  id wait behind a hover (Peek). Other host wakes are one line in Korean with the Ghost's
  exact text folded beneath.
- Ids and digests a Ghost writes into prose become marks: a Work's state glyph (opens its
  thread), a Ghost's face, a file icon, or a quiet # — the exact value is a hover away and
  copies on click. Code blocks and links stay exact.
- The conversation's scrollbar is a map: a hairline thumb plus ticks for the owner's turns,
  threads and returned Work in their state color; hover a tick for its name, click to jump,
  drag to scrub. Elsewhere scrollbars are trackless pills that show with the pointer.
- Composer: + menu bottom-left unfolds 사진·파일 첨부, 일로 맡기기 and 나중에 보내기; files
  upload on add, drop or paste and travel with `message.send`; the model chip moved beside
  send.
- 꾸미기 is only the look. Ghost 설정 keeps the editable name, role note, ordered model
  route, skill/tool pills and sandbox strip; state and default designation live in 운영.
- Removed the avatar library (creation, Codex import/export) and the in-window pet;
  설정 → 데스크톱 아바타 controls the desktop Ghost in the Mac app. 화면 picks themes from
  painted previews.
- Ghosts have no background: the 배경 row, the avatar 배경색 picker and portrait tiles are
  gone; a stored `look.background` is ignored.
- Chat reading pass: 15px/1.7 assistant text, tighter heading/list rhythm, tables as quiet
  cards with row hairlines, lighter code blocks, aligned tool trails.
- Streaming: text advances at an even pace, arriving words fade up out of a blur and a
  breathing dot follows the newest word; a finished reply no longer fades in twice.
- The composer's running edge is a comet with a soft glow over a faint steady ring.
- Model chip text no longer clips descenders (`glm-5.3`).
- Right-click menus on messages (copy, copy selection/link, quote into reply, reuse own
  message), thread cards and sidebar Ghosts.
- Motion: pages rise in, list rows cascade, cards lift and press, disclosures unfold.
- 꾸미기 opens in a dialog with a floating preview, 무작위 shuffle and instant choices.
- Collaboration is visible: 위임 event lines, delegated Ghosts on thread cards, 위임 결과
  대기 state, and a live work conversation on the Work page.

- Ghost variations: four body shapes (`look.shape`: round, egg, squircle, sheet) and six
  more accessories (crown, bow, cat ears, horns, headphones, glasses); the look editor gains
  a 모양 row. New app icon: the round Ghost with the blue working arc (Mac and iPhone).
- Threads open in a panel beside the conversation (`?thread=`): status, lifecycle,
  decisions resolved in place, delegated threads and the live work conversation.
- Secondary and meta text now meet WCAG AA in both themes (ink2/ink3 retuned; audited
  on home, 확인할 일, 맡긴 일, work detail, conversation and model settings).
- Removed the display-wide Ghost color preference; colors live only in each Ghost's look,
  and the avatar library previews the Ghost's own look.
- Home shows a setup card while no provider can run Ghosts; other pages' warning banner
  links to model settings. The default model's reasoning level is selectable.

- One durable conversation per Ghost: removed 새 대화 and the conversation switcher;
  the home composer talks into that conversation. Work it spins off shows as live
  thread cards where it started and in a thread list; older direct conversations stay
  readable there. The Ghost's profile is a floating round button at the top center.
  Host wakes render as event lines instead of owner bubbles.
- Streamed model reasoning shows live above the reply and folds into 생각 과정
  (`Message.thinking`, `Live.thinking` in the contract).
- Sending follows the latest turn again; layout shifts no longer stop following.
  The composer's running edge now circles the top side too.
- The built-in Ghost is round with the same face, with eye styles, one accent mark and a
  twelve-hue palette (`look.face`, `look.mark`); unset colors get a stable per-Ghost hue.
- Creating a project asks only for the folder (name follows it), lands on the project
  and shows host errors inline; grants are edited on the project page.

- Removed the per-Ghost sidebar submenus (맡긴 일 · 이전 대화). Ghost rows are a flat
  presence roster with a live Work count; conversation history lives in the header
  switcher (기본 대화 pinned, distinct names for untitled conversations, relative times,
  search past eight) and the header 맡긴 일 button shows the live count.

- Redesigned the whole app around supervising agents. New visual language (neutral
  layered surfaces; color only for agent state, each with its own glyph shape) and
  purpose-built components: presence rings with a live "now" line per Ghost, an activity
  island in the title bar, state glyphs, lifecycle tracks, work lanes with delegation
  branches, a decision deck (numbered answer tiles, exact-request approvals, result
  receipts, keyboard resolution), an addressed hand-off composer whose 맡기기 mode adds
  completion criteria and deadline in place, tool trails in transcripts, a composer edge
  that signals a running reply, and a work detail with delegation map and effect timeline.
  확인할 일 joins the sidebar; work detail resolves its own decisions. 일 맡기기 accepts
  completion criteria. Editing a deadline now shows local time instead of UTC.
  The dev server proxy now actually reaches `$GHOST_ROOT`'s host.

- Added model-generated interactive responses through the direct-only `present_ui`
  capability: bar/line charts with exact-data view, comparisons, choices, forms and
  isolated static HTML. UI actions send ordinary owner messages, retain tab-scoped
  input state and reuse request IDs after uncertain delivery. Presentations survive
  host restarts in the existing Pi tool journal; no new database or permissions.
  HTML is sanitized, scriptless and navigation-free with no remote resources.

- Made UI controls, theme, source Markdown editing and desktop process supervision
  app-owned. Removed external framework snapshots, workspace dependencies, sync
  commands and adoption instructions. Retained source-editor previews, keyboard
  behavior, document-byte preservation, safe HTML isolation and host lifecycle.

- Redesigned chat around the reading column: trailing owner bubbles, rendered
  assistant Markdown, scrollable code/tables, message/code copy, inline tool
  disclosures and explicit streaming/cancel state. Added direct history/new-chat
  actions, focused draft suggestions and conversation-local view state.
  Warning banners now keep their natural height.
  Untrusted HTML/URLs stay inert; images never load automatically. Footnotes stay
  inside their message instead of opening a broken hash route.

- Added per-Ghost tool allow-lists and agent settings for role instructions and tools.
  The current main Ghost may inspect/configure other non-main Ghosts only from direct
  conversations; self-configuration and changing the main designation remain owner-only.
  Optional tools are filtered from model requests and checked against current permissions
  on execution, including stale calls. Unsaved owner toggles preserve concurrent changes
  to untouched tool permissions.

- Moved to the new host contract: one Bun host process (`apps/ghost-host`), one HTTP API
  (`@ghost/contract`). `src/host/` owns the whole data layer now — `HostClient`
  (`/api/state`, transcript pages, commands, artifact bytes, SSE), `HostStore` (snapshot +
  `applyEvent` upserts/removals + reconnect with the last seq), and `HostProvider`/`useHost`.
- Deleted the old data layer and retired features: `src/client/**`, `src/lifetime/**`,
  routing/orchestration/collaboration/planner/integrations/package workspace/plugin
  approvals/memory source review/legacy transcript/voice, `server/**` (bridge),
  `scripts/console.mjs`·`serve.mjs` and the demo fixtures that modeled the old snapshot.
- 홈: hand-off composer (`message.send` into the Ghost's conversation, or `work.create`),
  Ghost cards, 확인 필요 (pending decisions) and 진행 중 (live Work).
- Ghost conversation: transcript pages with older-page loading, live partial text/tools via
  the store, `message.send`/`message.cancel`, new conversation (`conversation.create`),
  model per conversation (`conversation.update`).
- 맡긴 일: list plus detail with the work tree, effects, verdict, artifacts preview,
  `work.update` edit, cancel and resume, and the read-only work conversation.
- 확인할 일: decisions with per-kind resolution (`decision.resolve`) and notifications with
  mark-read (`notification.read`).
- Sidebar: 홈 · Ghosts (default first, foldable: 맡긴 일 · 이전 대화) · 프로젝트 · 설정.
  Settings sections: 팀 · 기기 · 반복 작업 · 호스트 (+ the pets' 모델 · 화면 · 아바타).
- `@ghost/contract` resolves through tsconfig `paths` and a Vite alias straight to
  `packages/ghost-contract/src`; dev proxies `/api` to the host from `$GHOST_ROOT/host.json`
  and adds the owner Authorization header server-side. Production output is `dist/`, served
  by the host.
- The overlay sends `message.send` into the default Ghost's direct conversation.
- The package manager is bun.
