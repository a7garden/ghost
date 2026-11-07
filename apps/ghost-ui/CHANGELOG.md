# Changelog

## Unreleased

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
