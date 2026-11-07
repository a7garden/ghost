# Changelog

## Unreleased

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
- Adopted the Garden framework for its components (`garden.json`, `vendor/garden` 0.1.0).
  Controls come from `@garden/ui` (shadcn/ui-style, Radix-backed); color and spacing use
  Tailwind 4 with Garden tokens. Removed `@garden/arc`, the Docket/liquid-glass
  stylesheets and the page-local control CSS. The layout stays Ghost's own sidebar and
  main region (recorded `shell.layout` exception).
- The package manager is bun.
