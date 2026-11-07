# Ghost UI decisions

- The independent unit is **Ghost**. OpenAI Dots, OpenDots, and OpenMuse are references, not product terminology.
- Every Ghost has the same durable runtime; mark only the default entry point. A request starts from the home composer or 일 맡기기, addressed to the default Ghost; delegation happens between Ghosts as child Work, not by the owner picking a recipient first.
- The host contract (`@ghost/contract`) is the only API reference; the UI owns no second vocabulary for entities, commands or events.
- Page headings name the destination. Do not append promotional subtitles, rhetorical slogans, English eyebrow labels, or companionship copy. Show actual state and actionable labels. Help belongs beside a field or in an empty/error state when needed.
- Example data is explicitly labeled and kept separate from the host. No fake live terminal, model execution, or simulated streams.
- Keep the current Ghost icon, per the latest owner instruction.

## Garden components — 2026-11-06

The UI uses Garden (`garden.json`, `vendor/garden`) for its components only:
Garden's shadcn/ui-style, Radix-backed `@garden/ui` controls, styled with Tailwind 4
utilities bound to Garden's generated tokens. The layout stays Ghost's own (recorded
exception `shell.layout`, `docs/decisions/0003-ghost-owns-its-layout.md`). There is no
app-level control library or global stylesheet beyond `src/app.css` (root sizing) and
`src/pets/pets.css` (avatar sprites).

`src/components/AppFrame.tsx` draws one sidebar beside one main region:

- 홈 with the pending-decision count: a composer to the default Ghost, 확인 필요, 진행 중,
  프로젝트 and a link to 모든 일.
- Ghosts, default first. The open Ghost expands into 맡긴 일 · 이전 대화.
- 프로젝트 (document spaces) and 새 프로젝트.
- 설정 at the bottom (팀 · 기기 · 반복 작업 · 호스트 · 모델 · 화면 · 아바타); host trouble
  shows there only when the host is not connected.

The title bar names the location and opens command search (`⌘K`). Below 56rem the sidebar
opens from the title bar menu. Theme follows the `.dark` class on `<html>`.

Earlier designs (Docket console, dashboard of 2026-11-04) are history:
[redesign report](../../docs/dashboard-redesign-2026-11-04.md),
[review surface design](../../docs/ghost-conversation-review-surfaces.md).

## Conversation — 2026-11-07

Direct chat keeps Garden's 760px reading column, trailing owner bubbles and
open assistant prose. The local header exposes history and new conversation;
the dock holds the auto-growing composer, model selection, send and cancel.
Suggestions populate and focus the draft. Conversation identity resets local
transcript/draft state so switching history never shows another conversation's
messages or sends its draft accidentally.

Assistant text uses GFM Markdown, including scrollable code/tables and copy
actions; owner text and tool output remain literal. Completed tools use inline
disclosures. Raw HTML is inert, only explicit HTTP(S)/mailto destinations open
externally, and image URLs are opt-in links, never automatic image requests.
Footnotes navigate within their own message without changing the app hash route;
relative paths have no transcript document base and remain plain text.
All presentation is read-only over the existing transcript; document storage,
model execution and host permissions are unchanged.
