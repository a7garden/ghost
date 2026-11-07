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

`src/components/AppFrame.tsx` draws the window: a quiet sidebar on the page tone and the
destination on an inset sheet (rounded, card shadow) beside it.

- Sidebar: 홈 · 확인할 일 (pending decisions, amber count) · 맡긴 일 (live count), then
  Ghosts as presence rows — portrait in its state ring, name, and a one-line "now" (the
  question waiting on the owner, the Work in progress, or 응답 중). The open Ghost unfolds
  into 맡긴 일 · 이전 대화. 프로젝트 with 새 프로젝트. 설정 at the bottom; host trouble shows
  there only when the host is not connected.
- Title bar: location on the left, the activity island in the center, command search
  (`⌘K`) on the right. Below 56rem the sidebar opens from the title bar menu.

Theme follows the `.dark` class on `<html>`.

Earlier designs (Docket console, dashboard of 2026-11-04, the first app-owned shell) are
history: [redesign report](../../docs/dashboard-redesign-2026-11-04.md),
[review surface design](../../docs/ghost-conversation-review-surfaces.md).

## Visual language — 2026-11-07

Surfaces are neutral and layered (page → sheet → card → raised), separated by soft
shadows rather than borders. Color is reserved for agent state, each with a mark, an
ink and a tint in `src/ui/theme.css`: signal blue for a Ghost actually working, amber for
anything waiting on the owner, red for failure, green for an accepted result. Inter and
JetBrains Mono remain; mono marks tool names, commands and times.

Component styles live in the `components` cascade layer (`src/ui/compositions.css`,
`src/app.css`, `src/components/agent/agent.css`) so Tailwind utilities passed through
`className` win. `src/main.tsx` imports global CSS first; that import declares the layer
order component stylesheets join.

## Agent components

Built for supervising agents instead of reusing generic cards and badges
(`src/components/agent/`):

- **PresenceAvatar** — portrait inside a state ring: a travelling arc while the Ghost
  works, a steady amber ring with a notch when it needs the owner, nothing when idle.
- **StateGlyph** — one shape per Work state (hollow ring, spinning arc, pause bars, half
  disc, exclamation, check, cross, slash) so state never relies on color alone.
  `workGlyph` reads a live Work with a pending decision as 확인 필요.
- **LifecycleTrack** — four segments 접수 · 진행 · 검증 · 완료; the current one carries
  the state color and a sheen only while the Ghost is moving.
- **WorkLane** — a Work as a lane (glyph, title, assignee, time, compact track) with
  delegated children hanging on a branch line.
- **ActivityIsland** — the workspace pulse in the title bar: faces of active Ghosts and
  amber/blue counts; silent when nothing moves; opens into every live item.

Feature-level compositions:

- **Hand-off composer** (home): a recipient token and a 대화/맡기기 switch inside the
  composer. 맡기기 unfolds 완료 기준 and 기한 in place and sends `work.create`; nothing
  becomes a 맡긴 일 unless the owner chose it.
- **Decision deck** (home, 확인할 일): pending decisions stacked oldest-first, the top one
  fully actionable. Questions answer with numbered tiles (digit keys) or free text;
  approvals show the exact request; results arrive as a receipt with files and the
  completion criteria (`⌘↵` approves). 확인할 일 lists every pending item beside the stack.
  Work detail resolves its own decisions in place.
- **Tool trail** (conversations): consecutive tool results fold into one line of chips;
  opening it shows each call's output on a thread. Live tools tick in at the end; the
  composer edge carries a travelling signal while the Ghost responds.
- **Work detail**: lifecycle track, the delegation map (parents above, children below)
  and the effect timeline beside the brief, criteria and result receipt.

## Conversation — 2026-11-07

Direct chat keeps a 720px reading column, trailing owner bubbles and open assistant
prose. The header shows the Ghost's presence portrait (opening its profile), its name and
the conversation title, which switches between earlier conversations or starts a new one
in place; 맡긴 일 and 새 대화 sit at the right. The dock holds the auto-growing composer,
model selection, send and cancel. Suggestions populate and focus the draft. Conversation
identity resets local transcript/draft state so switching history never shows another
conversation's messages or sends its draft accidentally.

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
