# Ghost UI decisions

- The independent unit is **Ghost**. OpenAI Dots, OpenDots, and OpenMuse are references, not product terminology.
- Every Ghost has the same durable runtime; mark only the default entry point. A request starts from the home composer or 일 맡기기, addressed to the default Ghost; delegation happens between Ghosts as child Work, not by the owner picking a recipient first.
- The host contract (`@ghost/contract`) is the only API reference; the UI owns no second vocabulary for entities, commands or events.
- Page headings name the destination. Do not append promotional subtitles, rhetorical slogans, English eyebrow labels, or companionship copy. Show actual state and actionable labels. Help belongs beside a field or in an empty/error state when needed.
- Example data is explicitly labeled and kept separate from the host. No fake live terminal, model execution, or simulated streams.
- Keep the current Ghost icon, per the latest owner instruction.

## App-owned UI

The React application owns its controls, compositions and theme in `src/ui`.
Accessible primitives use Radix directly. Tailwind utilities consume the app's
own light/dark theme; source Markdown editing lives in `src/editor`.
The desktop shell and process supervision belong to `apps/ghost-desktop`.

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

Direct chat keeps a 760px reading column, trailing owner bubbles and
open assistant prose. The local header exposes history and new conversation;
the dock holds the auto-growing composer, model selection, send and cancel.
Suggestions populate and focus the draft. Conversation identity resets local
transcript/draft state so switching history never shows another conversation's
messages or sends its draft accidentally.

Assistant text uses GFM Markdown, including scrollable code/tables and copy
actions; owner text and ordinary tool output remain literal. Completed tools use inline
disclosures. Raw HTML is inert, only explicit HTTP(S)/mailto destinations open
externally, and image URLs are opt-in links, never automatic image requests.
Footnotes navigate within their own message without changing the app hash route;
relative paths have no transcript document base and remain plain text.
Rendering never rewrites the existing transcript or document storage.
Interactive responses create new owner messages only through the normal send command.

## Interactive responses

`present_ui` is a direct-conversation response format, available even when optional
action tools are disabled. Valid `ghost-ui/1` tool results render inline in web/Mac
chat; malformed, unknown-version and failed results retain the ordinary readable
tool disclosure. iOS and the chat overlay retain text-only answers.

The model chooses ordinary Markdown or text, bar/line charts, comparisons, choices,
forms and static HTML. Charts offer chart/data views rather than duplicating data.
Native controls own user interaction. Choice replies contain only visible labels
and descriptions; forms submit their displayed fields. Neither is an approval or
a privileged command, and messages sent during a run remain ordinary follow-ups.

Form values, selection and delivery state are tab-scoped in `sessionStorage`,
keyed by conversation, immutable tool message and block identity. Refresh/reconnect
keeps this state in the same tab; it is not a cross-device or browser-restart draft
store. Uncertain delivery can retry the same request ID without a duplicate wake.
The normal composer draft is independent of widget submissions.

HTML uses an explicit static-tag/attribute allow-list, an opaque sandboxed iframe
and a resource-blocking CSP. Scripts, links, metadata refresh, forms, nested frames,
SVG/MathML and remote assets are not supported. Source view is escaped text.
There is no postMessage bridge, arbitrary JavaScript or direct Host access.
