# Ghost UI

2026-10-18: **설정 → 모델**의 주 Ghost 제공자 등록·기본값과 대화별 모델·추론 수준, 이미지 생성은 [등록 모델 계약](../../docs/registered-models-2026-10-18.md)을 따른다. 이 경로의 API 키는 브라우저 저장소에 보관하지 않고 Host에 직접 저장한다. 아래 기존 console/SDK 인증 예시는 별도 호환 경로다.

Ghost와의 대화를 중심으로 여러 Ghost, 협업, 승인, 작업, 문서를 다루는 웹 UI입니다. 제품 용어는 Ghost로 통일합니다. 역할과 상태는 보여 주되, 페이지 제목 아래에 홍보성 부제를 붙이지 않습니다. 현재 Ghost 아이콘을 유지합니다.

메뉴와 상태 안내의 용어는 [UI 용어 기준](../../docs/ui-terminology.md)을 따릅니다. 공통 이름은 `src/uiText.ts`에서 관리합니다.

## 구조와 UI 기준

Garden 프레임워크(`garden.json`, `vendor/garden`)에서 컴포넌트만 채택했습니다. 컨트롤은 Garden의 shadcn/ui 방식 컴포넌트(`@garden/ui`, Radix 기반)를 사용하고, 색과 간격은 Tailwind 4와 Garden 토큰으로 지정합니다. 화면 배치는 Garden 표준 레이아웃이 아니라 Ghost의 기존 구조를 유지합니다(`docs/decisions/0003-ghost-owns-its-layout.md`).

사이드바는 홈(확인 필요 개수), Ghost 목록(기본 Ghost 우선, 열린 Ghost 아래에 대화 · 맡은 일 · 전용 화면 · 이전 대화), 프로젝트, 설정 순서입니다. 확인할 일 · 맡긴 일 · 협업은 홈과 명령 검색(`⌘K`/`⌘P`)에서 엽니다.

## 실행

Node.js 22.12 이상 또는 24 이상에서 실행합니다.

### 실제 콘솔

프로젝트 루트에서 `cargo build --features workspace-ui`를 실행하고, 이 폴더에서
`bun install && bun run build`를 실행한 뒤 `bun run console`로 시작합니다.
Rust 호스트와 이 React UI를 함께 실행하며 기본 UI 주소는
`http://127.0.0.1:62062`입니다. 콘솔 프로세스를 종료하면 두 자식 프로세스도
종료합니다. 브라우저를 닫는 것은 호스트 실행에 영향을 주지 않습니다.

`~/.config/ghost/console.json`에 다음과 같이 **경로와 모델만** 보관합니다.
환경변수 `GHOST_ROOT`, `GHOST_MODEL`, `GHOST_AUTH_FILE`, `PORT`로 덮어쓸 수 있고,
별도 설정 파일은 `GHOST_CONSOLE_CONFIG`, 바이너리는 `GHOST_BIN`으로 지정합니다.

```json
{
  "root": "/absolute/path/to/ghost-state",
  "model": "zai/glm-5.1",
  "auth_file": "/absolute/private/path/zai-auth.json",
  "port": 62062
}
```

인증 파일은 프로젝트 밖에 소유자만 읽는 권한(`0600`)으로 저장합니다.
SDK 인증 형식은 `{"version":1,"providers":{"zai":{"api_key":"YOUR_KEY"}}}`입니다.
키를 프런트엔드 환경변수, 콘솔 설정 JSON, 브라우저에 전달하지 않습니다.
`zai/*`는 이 호스트에서 Coding Plan 전용 주소를 사용합니다.
호출 모델과 서버가 실제 반환하는 모델은 다를 수 있습니다.
실제 호출 결과와 수정 이력은 [Z.ai E2E 기록](../../docs/zai-live-e2e-2026-10-03.md)에 있습니다.

### UI만 미리보기

```sh
cd apps/ghost-ui
bun install
bun run dev
```

미리보기는 `http://127.0.0.1:5178`입니다. 기본값은 **예시 모드**이며 브라우저에 예시 상태를 저장합니다. 실제 모델이나 외부 도구를 실행하지 않습니다. 공유하거나 새로 고친 경로 링크(`/spaces/...`, `/ghosts/...`, `/work` 등)는 시작 시 해시 라우트로 변환되어 해당 화면으로 열립니다.

이미 실행 중인 Ghost 호스트에 연결하려면, 호스트의 루트 디렉터리를 지정해 UI 서버를 시작합니다.

```sh
GHOST_ROOT=/absolute/path/to/ghost-workspace bun run dev
```

호스트는 해당 루트에 `.ghost-control.json`을 제공해야 합니다. 연결에 실패해도 예시 모드로 자동 전환하지 않습니다. 빌드한 UI는 `bun run build` 후 `bun run serve`로 실행합니다. 동일한 `GHOST_ROOT` 설정을 지원합니다.

## 펫과 아바타

**설정 → 아바타** 또는 대화 화면의 Ghost 아바타를 누릅니다. `⌘ ,` / `Ctrl ,`로 설정을 열 수도 있습니다.

- Ghost별로 아바타를 선택하고 저장합니다. 선택은 사이드바, 대화, 검토와 협업 화면에 함께 반영됩니다.
- **아바타 만들기 → 직접 만들기**에서 색, 형태, 표정, 장식을 조합합니다. 로컬 캔버스 제작기로서 별도 모델/API 없이 동작합니다. 원본은 복사해서 수정할 수 있습니다.
- **가져오기**는 투명 PNG/WebP 스프라이트(최대 4 MiB)를 검증합니다. Codex 펫 v1은 1536×1872, v2는 1536×2288입니다. 셀은 192×208, 8열이며 필요한 프레임 수는 `[6,8,8,4,5,8,6,6,6]`, v2는 마지막 두 행에 8개씩의 시선 프레임을 추가합니다. 빈 칸, 빠진 동작, 불투명 배경을 거부합니다.
- **Codex용 내보내기**는 `pet.json`과 원본 스프라이트를 담은 ZIP입니다. 압축을 푼 폴더를 Codex 설정 → 펫에서 여는 펫 폴더(기본 `~/.codex/pets/`)에 넣고 선택합니다. 새 아바타는 v2로 생성합니다. Codex 계정 라이브러리를 변경하거나 자동 동기화하지 않습니다.
- **작업실에 펫 표시**를 켜면 선택한 Ghost의 대화로 이동하는 작은 펫이 나타납니다. 브라우저 창 안에서 표시됩니다. **화면**에서 시스템/밝게/어둡게 테마와 애니메이션을 선택합니다. 시스템의 동작 줄이기도 따릅니다.

호스트 모드는 아바타와 Ghost별 선택을 Rust 호스트의 `workspace.db`에 저장합니다. 예시 모드는 IndexedDB에 보관하며, 기존 예시 localStorage를 읽어 이어갑니다. 큰 이미지의 미확인 요청도 IndexedDB에 보관해 같은 요청 ID로 재시도합니다. 테마와 펫 표시 설정은 브라우저별입니다.

호스트 owner API는 `create_avatar`, `read_avatar`, `set_profile_avatar`, `delete_avatar`를 제공합니다. 선택 변경에는 현재 `avatar_version`을 보내며 충돌은 거부합니다. 사용 중인 아바타는 삭제할 수 없습니다. 스냅샷에는 작은 메타데이터만 포함되고, 이미지는 필요할 때 읽습니다. 아바타 업로드만 8 MiB 명령 봉투를 허용하고 일반 명령은 기존 1 MiB 한도를 유지합니다. 새 API를 사용하려면 최신 호스트 바이너리로 재시작해야 합니다.

규격 근거: 2026-10-03 설치된 Codex desktop의 펫 로더·렌더러, [공식 설정 안내](https://learn.chatgpt.com/docs/reference/settings), [공식 펫 설치 링크 규격](https://learn.chatgpt.com/docs/reference/commands). 캐릭터는 Ghost의 원본 캔버스 코드이며 Codex의 이미지 에셋은 복사하지 않았습니다.

## 프로젝트 경계

같은 저장소 안에서 프런트엔드 패키지를 분리합니다. Rust 크레이트로 만들 필요는 없습니다.

- `src/`: React 화면, 상태 정규화, 명령 재시도, 명시적인 예시 데이터.
- `server/bridge.mjs`: 브라우저와 Rust의 네이티브 `/api/v1` 사이를 연결하는 루프백 전용 브리지. 호스트의 HMAC 증명을 확인한 뒤 인증 정보를 사용하며, 네이티브 토큰은 브라우저에 전달하지 않습니다.
- Rust 호스트: 실행, 권한, 영속 상태, 협업 프로토콜의 소유자. 기존 내장 UI와 별개로 유지합니다.

협업은 저장된 위임 관계에서 요청한 Ghost, 참여 Ghost, 결과 수신처를 보여 줍니다. 각 위임의 대화와 요청·수락·진행·결과 기록을 열 수 있습니다. 협업 요청 폼은 기존 대화 명령으로 요청을 전달하며, 호스트가 실제로 만든 위임만 협업 화면에 나타납니다. 연결된 전체 Ghost를 임의로 하나의 팀으로 표시하지 않습니다.

**협업 → 작업 구조**에서는 작업별 담당 Ghost와 요청 내용을 지정하고 선행 작업의 성공·실패 조건을 연결합니다. 연결 없는 작업은 병렬로 시작하며, 여러 선행 작업이 있으면 모든 조건을 충족해야 시작합니다. 저장, 실행, 취소와 작업별 대화·결과 조회를 지원합니다. 실행 기록에는 시작 당시 구조 버전이 보존됩니다. 예시 모드는 구조 편집·저장만 지원합니다. 최신 호스트가 필요하며, 자세한 실행·복구 규칙은 [작업 구조](../../docs/orchestration.md)에 있습니다.

문서 공간은 기존 Host의 읽기 및 검토 API를 사용하며 **프로젝트**에 표시합니다. Ghost에 맡긴 작업은 **일**에서 확인합니다. 이전 플래너 링크도 이 화면으로 연결됩니다. MCP와 패키지 설정은 **설정 → 확장**에서 관리합니다.

## 검증

```sh
bun run test
bun run build
bun run garden:doctor
node scripts/verify-host.mjs
```

호스트 검증 스크립트는 기존 `target/debug/ghost` 바이너리를 사용하며, `GHOST_BIN`으로 경로를 바꿀 수 있습니다. 임시 루트와 mock 모델에서 실행한 뒤 자신이 만든 호스트와 데이터만 정리합니다. 외부 모델·연동 서비스의 종단 간 동작 검증은 포함하지 않습니다.

`evidence/`에는 브라우저 캡처, 확인한 흐름, 격리된 호스트 검증 결과가 있습니다.

참고: [OpenAI Dots](https://learn.chatgpt.com/docs/dots), [OpenDots](https://github.com/CopilotKit/OpenDots), [OpenMuse](https://github.com/CopilotKit/openmuse). 외부 UI 에셋은 복사하지 않았습니다.
