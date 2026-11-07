# ghost-ui

Ghost 호스트가 서브하는 웹 UI. 하나의 Bun 프로세스(`apps/ghost-host`)가 같은 포트에서
HTTP API와 이 빌드(`dist/`)를 서브하고, UI는 `src/host/client.ts`의 `HostClient` 하나로만
호스트와 통신한다. 소유자 토큰은 호스트가 loopback 요청에 한해 `index.html`에 주입하는
`window.__GHOST_TOKEN__`으로 받는다.

## 개발

상태 루트를 지정해 Vite dev 서버를 연다. dev 서버는 `$GHOST_ROOT/host.json`에서 포트와
소유자 토큰을 읽고, `/api` 요청에 Authorization 헤더를 서버 쪽에서 붙인다. 기본 상태
루트(`~/Library/Application Support/Ghost`)는 개발에 쓰지 않는다.

```sh
GHOST_ROOT=$(mktemp -d) GHOST_PORT=0 bun apps/ghost-host/src/main.ts serve
GHOST_ROOT=<위 루트> cd apps/ghost-ui && bun run dev
```

## 빌드와 테스트

```sh
bun install
bun run build   # tsc -b && vite build → dist/ (호스트가 GHOST_UI_DIR로 서브)
bun run test    # vitest run
bun run test:visual         # Playwright 시각 회귀 (빌드 후 실행)
bun run test:visual:update  # 기준 스크린샷 재생성
```

빌드와 vitest는 호스트를 필요로 하지 않는다. dev 서버만 `GHOST_ROOT`를 요구한다.

## 시각 회귀 (`e2e/`)

`@playwright/test`가 시스템 Google Chrome(`channel: 'chrome'`, 별도 브라우저 내려받기 없음)으로
`e2e/visual.spec.ts`의 일곱 화면(홈 · 확인할 일 · 맡긴 일 · 작업 상세 · Ghost 대화 · 설정 팀 ·
프로젝트)을 1440x900 / 390x844, 라이트·다크로 찍는다. 기준 이미지는 `e2e/__screenshots__/`에
커밋하며, `bun run test:visual:update`로 다시 만든다.

- 전역 셋업(`e2e/global-setup.ts`)이 임시 상태 루트에 격리 호스트를 소스에서 띄우고
  (`GHOST_ROOT`·`GHOST_PORT=0`·`GHOST_UI_DIR=dist`), 같은 프로세스의 OpenAI 호환 목 제공자
  (`e2e/mock-provider.ts`)를 `openai_compatible` 제공자로 등록한 뒤 소유자 API로 결정적 데이터를
  심는다: 서로 다른 look의 Ghost 셋, 대화 몇 턴, ask_owner 질문(대기), 완료·검증 대기 Work 하나씩,
  임시 폴더 위 프로젝트와 문서 두 개. 토큰은 `$GHOST_ROOT/host.json`에서 읽는다.
- 각 화면은 `page.clock.setFixedTime`으로 브라우저 시계를 시드 종료 시각으로 고정하고, 상대 시간
  텍스트(`<time>` 요소)와 대화 이벤트 줄(보고 안에 Work 무작위 id가 보임)은 마스크한다. 판정
  스탬프의 절대 시각은 비례 폭 숫자라 마스크 대신 주입 CSS로 숨긴다. 애니메이션·캐럿은 끄고
  `ghost-ui:preferences`로 테마를 고정한다.
- 글로벌 티어다운(`e2e/global-teardown.ts`)이 호스트를 종료하고 목 서버를 닫으며 임시 디렉터리를
  지운다. 실행 상태 파일은 무시되는 `e2e/.run/`에 기록된다.

## 구조

- `src/host/` — 데이터 계층 전부. `HostClient`(읽기·명령·아티팩트·SSE), `HostStore`
  (스냅샷 + `applyEvent` 업서트/삭제 + 마지막 seq로 재접속), `HostProvider`/`useHost`.
- `src/components/`, `src/features/` — 앱 셸과 사이드바, 홈 대시보드, Ghost 대화,
  맡긴 일 목록·상세, 확인할 일(결정·알림), 호스트 설정.
- `src/pets/` — 아바타·모델·표시 설정과 작업실 펫.
- `src/ui/` — 앱이 소유하는 접근성 컨트롤·레이아웃·테마. React/Radix/Tailwind를 직접 사용한다.
- `src/editor/` — 원문을 정본으로 유지하는 CodeMirror/Atomic 문서 편집기.
- `src/overlay/` — 데스크톱 앱의 오버레이. 기본 Ghost의 기본 대화로 `message.send`한다.
- `@ghost/contract`는 tsconfig `paths`와 vite `resolve.alias`로
  `packages/ghost-contract/src`을 직접 가리킨다. 계약 타입은 UI의 유일한 API 참조다.

UI 문구는 `docs/ui-terminology.md`를 따른다. 맡긴 일(Work), 확인할 일(Inbox),
반복 작업(Schedule) 같은 용어는 `src/uiText.ts`에서 가져온다.
