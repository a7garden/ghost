> 2026-11-06 구조 정리: 모든 Ghost는 같은 Pi Durable 봇이며 하나가 기본 진입점이다. 데스크톱 탐색은 홈(입력창·확인 필요·진행 중·프로젝트)·대화(Ghost 목록, 기본 Ghost 우선)·프로젝트·설정(팀·모델·확장·호스트·화면·아바타)이다. 타이틀바 Ghost 전환 메뉴는 없앴고 타이틀바는 현재 위치와 명령 검색만 둔다. 네이티브 SwiftUI iPhone 클라이언트는 이번 정리에서 바꾸지 않았다. 아래 Tauri 공용 iOS 셸은 전환 설계/Preview다. [이전 설계와 검증](dashboard-redesign-2026-11-04.md).

# Ghost 패키지와 공용 앱

2026-11-04 설계안. 각 Ghost 패키지에는 작성자가 직접 만든 화면을 포함할 수 있다. 모바일의 제품 화면은 데스크톱과 같은 스택으로 통합한다. 현재 구현과 목표 설치 계약을 구분한다.

## 현재 구현

Mac 콘솔의 **설정 → 팀 → 패키지 추가** 또는 명령 검색의 **패키지 추가…**에서 서명된 파일을 검사하고 현재 작업실의 Ghost에 연결한다. 콘솔은 ZIP 항목·Ed25519 서명·파일 SHA-256을 검증하고, 미리보기에서 확인한 digest와 실제 연결 대상이 일치할 때만 바인딩을 저장한다. 신뢰 키는 `~/.config/ghost/package-publishers.json`의 `{ "publisher": "PEM 공개키" }` 매핑에서 읽는다. 콘솔 설정의 `package_trust`로 신뢰 파일의 절대 경로를 지정할 수 있다. 보관된 패키지는 해당 Host 루트의 `ui-packages/` 아래에 있다.

패키지에는 `agent/definition.json` (`ghost-agent/1`)과 `agent/instructions.md`가 필요하다. 첫 로더는 이 파일의 무결성을 확인하고, 실제 Ghost 역할과 실행 권한은 기존 Host 정의를 사용한다. 별도 설치 UUID를 만드는 자동 프로비저닝과 패키지 런타임 활성화는 아래 목표 계약에 남아 있다.

전용 화면은 `ui/workspace.json`에 기록한 순서로 표시한다. UI가 없으면 Mac에는 대화만, iPhone에는 **대화 · 확인할 일**을 표시한다. iPhone의 **작업실**은 화면 하나를 곧바로 열고 여러 화면을 고를 때 목록을 연다. 마지막 화면과 초상화 색상은 현재 기기에 Ghost별로 저장한다. **초상화 색상**에서 기본 Ghost의 본체와 둥근 배경의 색을 따로 고른다. 두 항목은 프리셋·색상 선택기·HEX 입력을 지원한다. 이미지 아바타에는 배경색을 적용한다.

Mac 타이틀바는 현재 위치와 명령 검색만 둔다. 사이드바는 홈, Ghost별 대화(기본 Ghost를 맨 위에 둔다), 프로젝트, 설정 순서다. 대화 중인 Ghost에 전용 화면이 있으면 그 Ghost 항목 아래에 붙인다. 확인할 일과 맡긴 일은 홈의 섹션과 **모든 일**, 명령 검색에서 연다. 공용 웹 셸의 모바일 하단 탭은 **홈 · 대화 · 프로젝트**(전용 화면이 있으면 **작업실** 추가)다. 메뉴와 탭 전환의 움직임은 시스템의 동작 줄이기 설정을 따른다.

### 패키지 제작

1. 작업 폴더의 `package.json`에 `id` (`publisher/package-id`), `name`, `version` (`1.0.0`)을 쓴다.
2. 커스텀 화면은 SDK를 `npm install /path/to/ghost/apps/ghost-ui/sdk`로 설치하고 Vite에서 `base: './'`로 빌드해 `ui/dist/`에 넣는다. 화면이 없으면 `ui/`를 생략한다.
3. `node apps/ghost-ui/scripts/pack-ghost.mjs PACKAGE_DIR OUTPUT.ghost ED25519_PRIVATE_KEY.pem`으로 패키지를 만든다.

```ts
import { connectGhostUI } from '@ghost/ui-sdk';

const ghost = await connectGhostUI();
render(ghost.view.id);
changeViewButton.onclick = () => ghost.navigate('checks');
```

SDK 1.0은 현재 화면의 `id`, `label`, `route`와 선언된 화면 간 이동을 제공한다. `requests: []`를 사용한다. 대화·업무 데이터 접근과 실행 권한은 이후 Host SDK 계약에서 추가한다. 테스트용 TSX는 [package-workspace](../apps/ghost-ui/tests/fixtures/package-workspace/)에 있다.

### iOS Preview 재현

Ghost Preview는 Mac과 같은 React·TSX 번들을 실행하는 Tauri 앱이다. 기본 주소는 Mac 시뮬레이터의 테스트 콘솔 `http://127.0.0.1:65179/`다. Xcode 27에서는 `rustup component add llvm-tools`를 설치한다.

```sh
npm --prefix apps/ghost-ui run build
fixture_dir=$(mktemp -d)
node apps/ghost-ui/tests/prepare-packages.mjs "$fixture_dir"
GHOST_PACKAGE_ROOT="$fixture_dir/store" GHOST_PACKAGE_TRUST="$fixture_dir/trust.json" PORT=65179 node apps/ghost-ui/scripts/serve.mjs &
node apps/ghost-ui/tests/prepare-packages.mjs "$fixture_dir" http://127.0.0.1:65179
npm --prefix apps/ghost-desktop run ios:preview -- 'iPhone 18 Pro'
```

[시뮬레이터 UI 테스트](../apps/ghost-desktop/tests/ios-package-preview/)는 이미 설치된 Preview 앱과 같은 픽스처 콘솔을 사용한다. 테스트 폴더를 임시 디렉터리로 복사해 `xcodegen generate`와 `xcodebuild -scheme GhostPackagePreviewTests -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -parallel-testing-enabled NO test`로 실행한다. 실기기 검증에는 별도 서명된 Preview 앱과 테스트 데이터만 제공하는 로컬 개발 주소를 사용한다. 운영 iPhone 앱의 다중 Ghost 페어링과 권한 동기화는 이후 연결 단계다.

### 검증 기록

- Mac 네이티브 Tauri 앱의 별도 테스트 Host에서 Sage(0), Milo(1), Nova(2)를 열었다. Nova의 두 TSX 화면과 마지막 화면 복원을 확인했다. `.ghost` 파일 입력에서 미리보기를 거쳐 다른 테스트 Ghost에 연결하고 화면을 여는 경로도 통과했다.
- iPhone 14(iOS 18.7)에서 서명한 Ghost Preview를 설치하고 동일한 세 패키지를 열었다. 두 커스텀 화면의 SDK 연결과 Ghost별 마지막 화면 복원이 한 WebView 세션에서 완료됐다.
- iPhone 18 Pro(iOS 27) 시뮬레이터의 XCUITest에서 하단 메뉴, 프레임 내부 버튼, 선언된 SDK 화면 이동, 부모 문서·Host 요청 차단을 확인했다. Rust Host에서는 생성 재시도와 재시작 뒤 같은 Ghost ID를 보존하는 회귀 테스트가 통과했다.

## 참고한 배포 방식

Grok Bot의 공식 흐름은 템플릿 미리보기에서 설치를 선택하면 받는 사람의 계정에 새 Bot을 만드는 방식이다. 공식 문서는 공개 템플릿에 프로필·설명·스킬·루틴이 포함된다고 설명한다. 공개 설치용 파일 명세는 확인하지 못했다. [Grok Bot 템플릿](https://docs.x.ai/grok-bot/bots#share-a-bot)

배포자가 공개한 `create_bot_share_json.args.json` 예제에서 `profile`, `skills`, `routines`, `plugins`, `memory`, `gettingStarted`를 확인했다. My Bot Farm의 다운로드용 GAF JSON은 유사한 구성에 `format`·`version`을 붙이고 Grok용 레시피를 별도로 만든다. Hermes의 `grok-bot-export.json`은 프롬프트를 받은 Bot이 만드는 이관용 JSON이다. 각각 제작자가 공개한 예제와 연동 방식이다. [Grok 템플릿 예제](https://github.com/komalamee/Grok-NP_residency-tracker/blob/main/bot/create_bot_share_json.args.json), [GAF 배포 예제](https://www.mybot.farm/agents/grant-research), [Hermes 가져오기](https://hermes-agent.nousresearch.com/docs/plugins/agent-importers)

## 파일 하나에 Ghost 하나

배포 파일 `engineering-1.0.0.ghost`는 ZIP 컨테이너다. 개발할 때는 같은 구조를 폴더로 열어 화면을 미리 보고, 배포 시 파일 하나로 묶는다.

```text
engineering-1.0.0.ghost
├── manifest.json          패키지 ID·버전·호환성·권한 요청·파일 해시
├── agent/
│   ├── definition.json    역할·실행 입력과 출력·위임 계약
│   ├── instructions.md    역할 지시
│   ├── skills/           명시적으로 포함한 재사용 스킬
│   └── routines.json     설치 시 일시정지되는 루틴 정의
├── ui/                   전용 화면이 있는 패키지에서 포함
│   ├── workspace.json    화면 진입점·탭·SDK 버전·요청 권한
│   ├── src/              작성자용 React·TSX 소스, 선택 포함
│   └── dist/             빌드한 HTML·JS·CSS·아이콘 등 자산
└── signature.ed25519     배포자 서명
```

- **패키지**는 `publisher/package-id`, 버전, 매니페스트 해시로 식별한다. 매니페스트에 형식 버전, 지원 Host·UI 계약, 필요한 권한과 선택 권한, 모든 payload 파일의 크기와 SHA-256을 둔다. 서명은 매니페스트 원본 바이트에 걸고 파일 해시는 압축을 푼 각 파일의 원본 바이트를 검증한다.
- **설치한 Ghost**는 Host가 부여한 별도 UUID로 식별한다. 같은 패키지를 두 번 설치해도 이름·대화·기억·권한·초상화 배경색이 독립적이다. 패키지의 권한 요청은 설치 미리보기에 표시하고, 실제 프로젝트·연결 앱·기억 공간과의 바인딩은 Owner가 정한다. 자격 증명·대화·개인 기억·기존 기기 연결은 배포 파일 밖에 둔다.
- **실행 판본**은 Ghost UUID의 기존 정의 판본·digest와 패키지 및 UI digest를 연결한다. 업데이트는 설치 UUID와 Owner가 고른 초상화 배경색을 보존한다. 기존 Work는 접수 당시 정의를 계속 사용하고, 이전 UI 판본 또는 호환 읽기 전용 렌더러로 해당 작업을 검토한다. [기존 정의 판본](bot-definitions-2026-10-24.md)
- **위임**은 패키지가 선언한 능력과 입력·출력 계약으로 연결한다. 주 Ghost는 Host가 사용 가능하다고 확인한 설치 Ghost에 맡기고 같은 대화에 결과를 보고한다. 직접 전환하면 동일한 담당 Ghost의 작업 화면이 열린다. 주 Ghost 지정과 위임 권한은 Host의 Owner 설정이다.

## Ghost별 화면을 만드는 방법

작성자는 `ui/src/Workspace.tsx`에서 자기 Ghost의 화면을 React로 구현한다. 독자적인 레이아웃, 컴포넌트, 폼, 그래프, 로컬 상태와 상호작용을 만들 수 있다. 공유 디자인 토큰과 컴포넌트는 선택해서 사용한다. 제작 단계에서 TypeScript 검사를 별도로 실행하고 Vite로 `ui/dist/`를 빌드한다. 설치한 앱은 검증된 동일한 HTML·JS·CSS 번들을 macOS와 iOS에서 실행한다. TypeScript 소스는 편집 가능한 패키지로 배포할 때 함께 실을 수 있다. [Vite TypeScript 지원](https://vite.dev/guide/features.html#typescript)

`ui/workspace.json`은 커스텀 화면을 공용 셸에 연결한다. 패키지 작성자가 정한 탭과 진입 경로를 등록하고, UI 구현은 번들에서 가져온다.

```json
{
  "schema": "ghost-workspace/1",
  "sdk": "ghost-ui-sdk/1",
  "entry": "dist/index.html",
  "appearance": { "portraitBackground": "sky" },
  "defaultView": "changes",
  "views": [
    { "id": "changes", "label": "변경 내역", "route": "/changes" },
    { "id": "checks", "label": "검증", "route": "/checks" }
  ],
  "requests": ["work.change_set.read/1", "work.verification.read/1", "review.open/1"]
}
```

공통 셸은 Ghost 대화 목록, 명령 팔레트, 대화, 공용 승인함과 돌아가기 링크를 맡는다. 개발 Ghost는 변경 파일 비교와 테스트 진행을 연결하고, 조사 Ghost는 주장에 해당하는 출처를 여는 전용 화면을 구성할 수 있다. 공통 셸은 현재 Ghost, 작업, 기기 크기와 색상 토큰을 SDK로 전달한다. 사용자가 고른 초상화 배경색은 `owner × ghost_id` 환경설정으로 동기화하고 패키지 업데이트 뒤에도 유지한다. 이 설정은 화면에 표시되는 해당 Ghost의 초상화 배경에만 적용한다. 현재 브라우저별 플러그인 설정은 개인 선택값의 이관 대상으로 다룬다. [현재 렌더러 등록](../apps/ghost-ui/src/plugins/registry.ts)

패키지 UI는 버전이 명시된 `@ghost/ui-sdk`를 통해 조회와 동작을 요청한다. 공용 셸이 생성한 채널을 설치된 Ghost UUID, UI digest, 선택한 Work, 기기 권한에 묶는다. Host는 그 범위와 현재 판본을 기준으로 요청을 확인한다. 승인이나 외부 효과가 필요한 요청은 공용 검토 화면에서 사용자에게 대상과 범위를 보여준다. 패키지 UI를 열 수 없으면 공용 대화와 읽기 전용 상세로 접근할 수 있다. [기존 검토 화면 계약](ghost-conversation-review-surfaces.md)

배포 파일의 스킬과 UI는 별도 권한으로 처리한다. 스킬은 Host가 검토한 실행 환경에서만 사용한다. UI는 셸과 분리된 실행 영역에 로드한다. 공통 구현 후보는 스크립트만 허용하고 `allow-same-origin`을 부여하지 않는 sandbox iframe과 인스턴스별 메시지 채널이다. 앱 셸이 자산 응답에 CSP를 적용하고, 프레임 이동과 외부 자원 요청도 앱이 통제한다. Tauri IPC·파일·키체인·Host 토큰은 공용 셸만 접근한다. macOS와 iOS WebKit에서 직접 IPC 호출, 프레임 이동, 외부 요청, 다른 Ghost ID 위조를 막는지 확인하기 전에는 실제 사용자 데이터를 커스텀 UI로 전달하지 않는다. [HTML iframe 격리](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox), [Tauri 권한 모델](https://v2.tauri.app/security/capabilities/)

App Store의 다운로드형 패키지는 2.5.2와 4.7 적용을 검토한다. 4.7 적용 시 앱에 포함되지 않은 개별 소프트웨어에 데이터를 전달하거나 개인정보 권한을 공유하는 데 사용자 동의가 필요하다. 네이티브 API 노출에도 별도 조건이 있다. 동일 번들을 Mac과 iPhone에서 구동하는 기술 검증과, 외부 다운로드를 허용하는 App Store 배포 검증은 별도 수용 조건이다. [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/#mini-apps-mini-games-streaming-games-chatbots-and-plug-ins)

## 메뉴 구성

| 위치 | 항목과 동작 |
| --- | --- |
| 설정 → 팀 | 주 Ghost를 맨 위에 두고 설치 Ghost를 보여준다. 각 Ghost의 대화·관리·**초상화 색상**과 Owner용 **패키지 추가**, **새 Ghost**를 둔다. 파일이나 링크를 열면 설치 미리보기로 연결한다. |
| macOS 사이드바 | **홈 · 대화 · 프로젝트 · 설정**. 대화 중인 Ghost 아래에 그 Ghost의 `views`를 선언 순서대로 붙인다. |
| 모바일 하단 탐색(공용 웹 셸) | **홈 · 대화 · 프로젝트**를 사용하고, 현재 Ghost에 전용 화면이 있으면 **작업실**을 더한다. |
| 명령 팔레트 | macOS **⌘K**와 iPhone 상단 검색 버튼에서 연다. Ghost 이름·역할, 현재 Ghost의 화면, **확인할 일**, **모든 일**, **팀**, **초상화 색상**, **패키지 추가**, **설정**을 찾을 수 있다. 기기와 사용자의 권한에 맞는 항목을 제공한다. |

패키지는 `views[].id`·`label`·`route`로 자기 메뉴를 등록한다. 주 Ghost는 **조율**, 개발 Ghost는 **변경 내역 · 검증**, 조사 Ghost는 **근거 · 출처**, 운영 Ghost는 **점검 기록 · 실행 이력**을 제공할 수 있다. 패키지 메뉴 ID는 Ghost 내부에서 고유해야 하며 공용 메뉴 ID는 셸이 예약한다. 명령 팔레트는 이 항목을 화면 이동에 사용한다. `defaultView`는 해당 Ghost의 작업실을 처음 열거나 이전 메뉴가 업데이트에서 사라졌을 때 사용한다.

- **0개**면 패키지에서 `ui/`를 생략할 수 있다. 공용 대화를 열고 전용 메뉴와 iPhone의 **작업실** 항목을 숨긴다. 패키지에 UI 메타데이터만 있는 경우 `views: []`와 기본 화면 미지정을 같은 방식으로 처리한다.
- **1개**면 Mac 사이드바에 항목 하나를 표시한다. iPhone에서 **작업실**을 누르면 그 화면으로 바로 들어간다.
- **여러 개**면 선언된 순서대로 각각 메뉴에 표시한다. iPhone은 **작업실** 안에 같은 화면 선택 항목을 둔다.

직접 전환하면 Ghost별 마지막 화면과 초안을 복원한다. 위임 링크를 열면 그 Ghost의 지정된 Work와 화면으로 이동하며 **원래 대화로**가 출발 위치를 기억한다. 메뉴 선택은 `ghost_id + view_id`로 기록한다. 화면 주소나 메뉴 문구가 바뀌어도 같은 ID는 같은 화면으로 열리고, 사용자가 접근할 수 있는지는 Host가 다시 확인한다.

## 설치와 업데이트

1. 파일 또는 버전이 고정된 링크를 열면 이름·배포자·판본·미리보기·요청 권한을 표시한다. Host는 제한된 임시 저장소에서 크기·경로·중복·스키마·해시·서명을 검증한다. 패키지 안의 키 자체를 신뢰 근거로 사용하지 않는다.
2. Owner가 새 Ghost로 추가할지 기존 설치를 업데이트할지 선택하고 권한을 연결한다. 외부 Grok 계열 JSON을 지원할 경우 검토 가능한 초안으로만 변환한다. 루틴은 승인 후 별도로 켠다.
3. 기존 Ghost 후보 검수·준비·활성화 절차에 연결한다. Host가 패키지와 정의 판본을 함께 활성화하고 두 앱이 같은 판본을 받는다. 실패 시 이전 활성 포인터가 유효하고, 같은 설치 요청은 원래 영수증과 UUID를 되돌려준다. [기존 활성화 절차](bot-provisioning.md)

## 모바일과 데스크톱

| 층 | 공용 구조 |
| --- | --- |
| UI | 현재 `apps/ghost-ui`의 React·TypeScript·Vite를 공용 셸로 사용한다. Ghost별 TSX는 패키지에서 빌드한 동일한 번들을 양쪽에서 열고 화면 폭에 맞춰 배치한다. |
| 앱 셸 | macOS와 iOS에 Tauri 2를 사용한다. macOS의 창·단축키와 iOS의 안전 영역·키보드·공유 시트는 플랫폼 어댑터에 둔다. iOS의 Keychain·APNs·CallKit은 필요한 네이티브 연결부를 재사용한다. |
| 전송 | 공용 UI는 동일한 타입의 작업실 클라이언트를 사용한다. 데스크톱은 로컬 인증 브리지, iOS는 페어링된 HTTPS Gateway와 기기 토큰으로 Host에 연결한다. |
| 실행 | Ghost Host가 패키지 설치, UUID, Pi 대화, 업무 원장, 권한과 스킬 실행을 소유한다. 각 기기는 같은 승인된 UI 판본을 받는다. iOS는 데스크톱의 Node 감독기와 Host를 번들에 넣을 필요가 없다. |

Tauri는 같은 웹 프런트엔드를 데스크톱과 모바일에 사용하고 iOS 네이티브 연동을 플러그인으로 둘 수 있다. 현재 페어링은 주 Ghost와 그 대화 하나로 제한된다. 모바일 전환을 위해 Owner가 추가 Ghost·대화 쌍과 동작을 기기별로 승인하는 범위 모델과 취소·권한 검사가 먼저 필요하다. 모바일은 그 범위에 속하는 Ghost만 전환 목록에 표시한다. [Tauri 소개](https://v2.tauri.app/start/), [모바일 플러그인](https://v2.tauri.app/develop/plugins/develop-mobile/), [현재 페어링 구현](../apps/ghost-gateway/pairing.mjs#L158-L173)

## 첫 구현에서 확인할 일

1. 개발·조사 Ghost를 독립적인 TSX 화면이 들어 있는 두 패키지로 만든다. 브라우저와 격리 Host에서 설치 미리보기, 패키지 안에서만 정의한 상호작용, 개별 직접 대화와 위임 상세 왕복을 확인한다.
2. 각 UI 번들의 동일 digest를 macOS와 iOS에서 열어 화면·초상화 배경색·안건 ID가 일치하는지 확인한다. 권한 없는 Ghost의 목록·깊은 링크·동작과 UI 격리 우회를 거절하는 것도 확인한다.
3. 기존 iPhone 앱의 페어링, 대화별 초안, 첨부, 알림과 통화 경로를 실제 기기에서 이전·복귀 시험한 뒤 UI를 교체한다. 전환 시 기기 자격 증명이나 미확정 요청의 원래 ID를 자동으로 복제하거나 재전송하지 않는다. [현재 iPhone 계약](../apps/ghost-ios/README.md)
