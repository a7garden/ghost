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
```

빌드와 vitest는 호스트를 필요로 하지 않는다. dev 서버만 `GHOST_ROOT`를 요구한다.

## 구조

- `src/host/` — 데이터 계층 전부. `HostClient`(읽기·명령·아티팩트·SSE), `HostStore`
  (스냅샷 + `applyEvent` 업서트/삭제 + 마지막 seq로 재접속), `HostProvider`/`useHost`.
- `src/components/`, `src/features/` — 앱 셸과 사이드바, 홈 대시보드, Ghost 대화,
  맡긴 일 목록·상세, 확인할 일(결정·알림), 호스트 설정.
- `src/pets/` — 아바타·모델·표시 설정과 작업실 펫.
- `src/overlay/` — 데스크톱 앱의 오버레이. 기본 Ghost의 기본 대화로 `message.send`한다.
- `@ghost/contract`는 tsconfig `paths`와 vite `resolve.alias`로
  `packages/ghost-contract/src`을 직접 가리킨다. 계약 타입은 UI의 유일한 API 참조다.

UI 문구는 `docs/ui-terminology.md`를 따른다. 맡긴 일(Work), 확인할 일(Inbox),
반복 작업(Schedule) 같은 용어는 `src/uiText.ts`에서 가져온다.
