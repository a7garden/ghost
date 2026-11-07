# Ghost UI decisions

- The independent unit is **Ghost**. OpenAI Dots, OpenDots, and OpenMuse are references, not product terminology.
- Every Ghost has the same durable runtime; mark only the default entry point. A request starts from the home composer or 일 맡기기, addressed to the default Ghost; delegation happens between Ghosts as child Work, not by the owner picking a recipient first.
- The host contract (`@ghost/contract`) is the only API reference; the UI owns no second vocabulary for entities, commands or events.
- Page headings name the destination. Do not append promotional subtitles, rhetorical slogans, English eyebrow labels, or companionship copy. Show actual state and actionable labels. Help belongs beside a field or in an empty/error state when needed.
- Example data is explicitly labeled and kept separate from the host. No fake live terminal, model execution, or simulated streams.
- The app icon is the round Ghost (approved face) with the blue working arc on a light tile; sources live in `apps/ghost-desktop/src-tauri/brand-source/`. The in-app built-in Ghost portrait uses the same face; see Ghost portraits below.

## App-owned UI

The React application owns its controls, compositions and theme in `src/ui`.
Accessible primitives use Radix directly. Tailwind utilities consume the app's
own light/dark theme; source Markdown editing lives in `src/editor`.
The desktop shell and process supervision belong to `apps/ghost-desktop`.

`src/components/AppFrame.tsx` draws the window: a quiet sidebar on the page tone and the
destination on an inset sheet (rounded, card shadow) beside it.

- Sidebar: 홈 · 확인할 일 (pending decisions, amber count) · 맡긴 일 (live count), then
  Ghosts as presence rows — portrait in its state ring, name, and a one-line "now" (the
  question waiting on the owner, the Work in progress, or 응답 중) and its live Work count.
  A row only opens the Ghost's conversation; there are no per-Ghost submenus, so the
  roster stays a glanceable list. 프로젝트 with 새 프로젝트. 설정 at the bottom; host trouble shows
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

Text tiers meet WCAG AA: ink2/ink3 are 74%/61% ink in light and 70%/53% in dark, so
secondary and meta text keep 4.5:1 on page, canvas and surface; ink4 is decoration only.
Until a provider can run Ghosts, home leads with a setup card instead of a warning banner;
other pages keep the banner with a 모델 설정 action. The default model's reasoning level
(끔·낮음·중간·높음) is set beside it in 설정 → 모델.

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
  becomes a 맡긴 일 unless the owner chose it. Like the conversation composer it has the
  + menu bottom-left (files) and the model beside send.
- **Decision deck** (home, 확인할 일): pending decisions stacked oldest-first, the top one
  fully actionable. Questions answer with numbered tiles (digit keys) or free text;
  approvals show the exact request; results arrive as a receipt with files and the
  completion criteria (`⌘↵` approves). 확인할 일 lists every pending item beside the stack.
  Work detail resolves its own decisions in place.
- **Tool trail** (conversations): consecutive tool results fold into one line of chips;
  opening it shows each call's output on a thread. Live tools tick in at the end; the
  composer edge carries a travelling signal while the Ghost responds: a comet on the edge,
  a soft glow behind it and a faint steady ring.
- **Collaboration**: a `delegate` result reads as a 위임 event line (Ghost · title), and a
  child's report as 위임 결과. Thread cards list every Ghost working under the thread with
  its live state; a Work waiting on children reads 위임 결과 대기. The Work page's work
  conversation streams live like the thread panel.
- **Work detail**: lifecycle track, the delegation map (parents above, children below)
  and the effect timeline beside the brief, criteria and result receipt.
- **Context menus**: right-click a message to copy it, its selected text or a link, quote
  it into the reply (assistant) or bring it back into the composer (owner); a thread card
  opens its thread or Work page; a sidebar Ghost opens its conversation, 맡긴 일 or
  settings. Text fields keep the system menu.

Motion stays short and purposeful: pages rise in, list rows cascade once, the owner's
message and a starting reply rise in (a finished reply replaces its live article without a
second entrance), disclosures unfold, cards lift on hover and press in on click. Reduced
motion stops all of it.

## Conversation — 2026-11-07

Each Ghost keeps one durable conversation, like Dots: there is no "new conversation" action.
The Ghost floats as a round button at the top center (its presence ring; it opens the
profile and look editor) and content fades beneath it. Work the conversation spins off
appears as **thread cards** at the moment it started, kept live (state glyph, carrier,
lifecycle). Opening a card or a thread from the thread button (top right) brings the
**thread panel** beside the conversation (over it below 64rem, `?thread=` in the URL):
status and lifecycle, its decisions resolved in place, delegated threads, and the
carrier's work conversation streaming live. Editing and cancelling stay on the full
맡긴 일 page. Direct conversations kept from before stay reachable as 이전 대화.
Host wakes (reports, child results, decision answers, schedules, verdicts) render as quiet
event lines, never as the owner's bubble.

Reasoning the provider streams shows as a disclosure above the reply: while thinking it
stays open, names the newest step and shows the latest lines; once text arrives it folds
to 생각 과정. Streamed text advances at an even pace (a few characters per frame, faster
with backlog), each arriving word fades up out of a soft blur, and a breathing dot follows
the newest word. Assistant text reads at 15px/1.7; tables are quiet cards with row
hairlines. Sending a message always follows the latest turn; only the owner's own
scrolling (wheel, touch, pointer, keys) stops following, never a layout shift.
The dock holds the auto-growing composer (its running edge circles all four sides). Bottom
left is **+**: its actions unfold upward one after another (사진·파일 첨부, 일로 맡기기, 나중에
보내기) while the + turns into ×. Files also arrive by drop or paste; each uploads at once
(`POST /api/artifacts`) and waits above the text as a thumbnail or file card, then goes with
`message.send`. 일로 맡기기 puts a 맡기기 token over the text with 완료 기준 and 기한 and sends
`work.create` into this conversation; 나중에 보내기 offers 1시간 뒤 · 오늘 저녁 6시 · 내일 아침 9시
or a chosen time and sends `schedule.create`. Model choice, cancel and send sit bottom right.
Suggestions populate and focus the draft. Conversation
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

## Ghost portraits

The built-in portrait carries the approved face. `look.shape` picks the body (round, egg,
squircle, sheet); every body shares the round body's top and width so accents sit alike.
`look.face` picks the eyes (bars, dots, arcs, tall) and `look.mark` one accent: halo,
antenna, sprout, ring, spark, crown, ears, horns and the headphone band are drawn in the
body color; bow, headphone cups and glasses are worn in front in the face color with a
body-color outline so they read on any surface. Ghosts have no background tile (owner
decision, 2026-11-08): portraits sit directly on the page, and a stored `look.background`
is neither shown nor editable. `look.body` takes any color from a twelve-hue
palette or a custom one; a Ghost that never chose gets a stable hue from its id so agents
read apart. 꾸미기 is only the look: it opens in its own dialog from the portrait, with a
floating preview that pops on every change and a 무작위 shuffle, then picture choices whose
legend names the current pick; choices show at once and save behind the preview (the newest
wins). Everything else about a Ghost lives in **Ghost 설정** (설정 → Ghost): a portrait roster,
then the chosen Ghost as one sheet — the name edited in place as the heading, 메인으로 지정,
a 활성/일시정지/은퇴 capsule, the model as a card, 역할 지시 as a growing note, tools as
switch-pills grouped by purpose (a group's label toggles it) and the sandbox as a status strip
with a two-step reset. New Ghosts start as the same sheet. There is no avatar library: stored
sprite avatars stay selectable in 꾸미기, nothing creates new ones.

## Settings

Ghost · 모델 · 기기 · 반복 작업 · 호스트 · 화면, plus **데스크톱 아바타** inside the Mac app.
화면 picks the theme from three little windows painted in their own palette. 데스크톱
아바타 controls the Ghost that floats on the desktop above other apps (see the desktop shell).

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
