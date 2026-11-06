# Ghost UI decisions

- The independent unit is **Ghost**. OpenAI Dots, OpenDots, and OpenMuse are references, not product terminology.
- Every Ghost has the same durable runtime; mark only the default entry point. A request starts from **새 요청**, addressed to the default Ghost; delegation happens between Ghosts, not by the owner picking a recipient first.
- A work deep link preserves its exact goal, work and conversation while opening the detail. Ghost creation and activation require an explicit owner action; a pasted route never authorizes registration. Retired submit/steer operations must not appear as working actions.
- Page headings name the destination. Do not append promotional subtitles, rhetorical slogans, English eyebrow labels, or companionship copy. Show actual state and actionable labels. Help belongs beside a field or in an empty/error state when needed.
- Collaboration reflects persisted delegation lineage. Group parallel tasks by their generation parent, show the requesting and receiving Ghosts, preserve failure/uncertainty, and link to both conversation and protocol history. Do not invent a connected team graph from all profiles.
- Example data is explicitly labeled and kept separate from the host. No fake live terminal, browser, voice call, or model execution.
- Keep this package independent from the Rust host and the existing embedded UI. Concurrent backend and integrations work must be preserved.
- Keep the current Ghost icon, per the latest owner instruction.

## Garden components — 2026-11-06

The console uses Garden (`garden.json`, `vendor/garden`) for its components only:
Garden's shadcn/ui-style, Radix-backed `@garden/ui` controls, styled with Tailwind 4
utilities bound to Garden's generated tokens. The layout stays Ghost's own (recorded
exception `shell.layout`, `docs/decisions/0003-ghost-owns-its-layout.md`). There is no
app-level control library or global stylesheet beyond `src/app.css` (root sizing) and
`src/pets/pets.css` (avatar sprites).

`src/components/AppFrame.tsx` draws one sidebar beside one main region:

- 홈 with the pending-decision count: a composer to the default Ghost, 확인 필요, 진행 중,
  프로젝트 and a link to 모든 일.
- Ghosts, default first. The open Ghost expands into 대화 · 맡은 일 · package views ·
  이전 대화.
- 프로젝트 (document spaces) and 새 프로젝트.
- 설정 at the bottom (팀 · 모델 · 확장 · 호스트 · 화면 · 아바타); host trouble shows there
  only when the host is not connected.

The title bar names the location and opens command search (`⌘K`, also `⌘P`). Below 56rem
the sidebar opens from the title bar menu. Theme follows the `.dark` class on `<html>`.

Earlier designs (Docket console, dashboard of 2026-11-04) are history:
[redesign report](../../docs/dashboard-redesign-2026-11-04.md),
[review surface design](../../docs/ghost-conversation-review-surfaces.md).
