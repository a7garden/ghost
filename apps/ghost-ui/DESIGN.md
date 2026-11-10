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
  roster stays a glanceable list — in two groups: **고정** (the default Ghost plus the owner's
  pins, set from a row's context menu) and the **Ghost pool**, folded from its own header,
  which sticks while scrolling; a folded pool still admits the Ghosts that need the owner or
  hold the conversation on screen, and an expanded pool past eight rows grows a filter.
  프로젝트 with 새 프로젝트. 설정 at the bottom; host trouble shows
  there only when the host is not connected. The three destinations and 설정 stay put; only
  the roster and projects scroll, under sticky group labels, fading out while more follows, with
  a ScrollRail marking Ghosts that are working or need the owner. Opening a Ghost from
  elsewhere brings its row into view.
- Title bar: back/forward (`⌘[` `⌘]`, positions kept in history state) and the page's trail on
  the left — section, then the thing inside it, then the open thread and the threads it was
  delegated from (`src/features/crumbs.ts`); every step above the page goes up to it. Below
  760px only back and the page remain. The activity island sits in the center, command search
  (`⌘K`) on the right; it also hands off work, creates a Ghost or project and finds pending
  decisions and live Work by title. Shortcut labels follow the platform (`src/ui/keys.ts`):
  Ctrl on Windows, where Alt+←/→ also walk history. Below 56rem the sidebar opens from the title bar menu.

Theme follows the `.dark` class on `<html>`.

Earlier designs (Docket console, dashboard of 2026-11-04, the first app-owned shell) are
history: [redesign report](../../docs/dashboard-redesign-2026-11-04.md),
[review surface design](../../docs/ghost-conversation-review-surfaces.md).

## Visual language — 2026-11-07

Surfaces are neutral and layered (page → sheet → card → raised), separated by soft
shadows rather than borders. Color is reserved for agent state, each with a mark, an
ink and a tint in `src/ui/theme.css`: signal blue for a Ghost actually working, amber for
anything waiting on the owner, red for failure, green for an accepted result. Inter and
JetBrains Mono remain; mono marks tool names, commands and times. Hangul falls through to
Pretendard Variable (2026-11-09), which matches Inter's metrics and keeps the 450–650 weight
steps on every platform. Shortcut keys share one look: a canvas key on a hairline, mono 11px.

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
- **Companion work shelf** — the desktop pet carries a short count, not a clipped Work title.
  Hover or press unfolds one roster above it: owner decisions first, then all its live Works,
  each with a wrapping title and a quiet state. Rows open their actual destination in the main
  window. The native frame grows only while open, restores its collapsed position at screen
  edges, and never resizes mid-drag. The pet remains the chat/drag target, separate from the rows.
- **OutcomeLine** — a Work coming back where its thread card branched off: a return hook
  in the state color, a state-tinted pill (glyph, title, 완료/실패) that opens the thread, the
  files as chips and a failure's reason. Report and 위임 결과 wakes render as this line.
- **Peek** — technical facts (assignee, verdict source, duration, id, size, hash) kept off the
  surface and shown on pointer rest or keyboard focus; copyable values copy on click. Touch
  has no hover, so the element's own action leads to the full page instead.
- **RefMark** — an id or digest a Ghost wrote into prose (`src/components/refs.ts` finds
  them outside code blocks and links) shows what it points at: a Work's state glyph that opens
  it, a Ghost's face, a file icon, else a quiet #. The value itself is behind a Peek.
- **ScrollRail** (`src/ui/scroll-rail.tsx`) — the app's only scrollbar, drawn as a map of what
  it scrolls: a hairline thumb and ticks for every `data-rail` element inside — in the
  conversation the owner's turns, thread cards and outcomes, in the sidebar Ghosts that are
  working or need the owner — in their state color. Hover names a tick, click jumps, drag
  scrubs, wheel over it scrolls. It shows with the pointer or the owner's own scrolling, never
  for auto-follow. Native scrollbars are hidden on fine pointers; `ScrollRails`, mounted once
  per window, puts a bare rail (vertical or horizontal) on every other scroller under the
  pointer or just scrolled. Touch keeps the platform's own indicator.

Feature-level compositions:

- **Hand-off composer** (home): a recipient token and a 대화/맡기기 switch inside the
  composer. 맡기기 unfolds 완료 기준 and 기한 in place and sends `work.create`; nothing
  becomes a 맡긴 일 unless the owner chose it. Like the conversation composer it has the
  + menu bottom-left (files) and the model beside send.
- **Decision deck** (home, 확인할 일, conversations): pending decisions stacked oldest-first,
  the top one fully actionable. A card waiting on the owner carries an amber hairline around its
  whole edge, never a stripe on one side. Questions answer with numbered tiles (digit keys) or free text;
  approvals show the exact request; results arrive as a receipt with files and the
  completion criteria (`⌘↵` approves). 수정 요청 on a result, an effect to reconcile or a
  document review opens a reason field first (`D`), and the reason reaches the Ghost. An
  approval for a command whose risk speaks of loss, a browser commit click or a protected card
  fill arms on the first press and approves on a second within 4s.
  ←/→ page the deck; a resolved card leaves a short spoken and visible acknowledgement.
  확인할 일 lists every pending item beside the stack.
  A conversation docks its own above the composer: every pending decision of its Ghost (what
  the sidebar row announces) and those of threads begun there; a single card drops the deck
  head and a long card scrolls inside under its pinned answer buttons; the card takes only what a short window
  leaves after the transcript and composer. Work detail and the thread panel resolve their own in place.
- **Work cancellation** (`src/components/ConfirmDialog.tsx`): the dialog states the consequence,
  names the action on the confirmation button and shows a failed cancellation in place.
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
- **File sheet** (`ArtifactPreview`): one wide, quiet reading surface over the conversation,
  without a second inset card or background blur. File identity and copy/save/close stay
  above the scroll area; type/size stay below it. Markdown offers underline-style 읽기/원문
  views, a 668px body measure and 15px/1.85 text; source uses a separate non-copyable gutter
  and optional wrapping. The gutter disappears when wrapping or over 10,000 lines, never
  truncating source. Remote Markdown images remain opt-in links and raw HTML stays literal.
  SVG uses an image decoder; PDF uses the browser's native PDF view, never an HTML preview.
  Other binary files offer save instead of an empty frame. Requests and blob URLs belong to
  each opening; dismissing a pending request cannot update a later opening. Escape/outside
  dismissal returns keyboard focus to the initiating file.

Motion stays short and purposeful: pages rise in, list rows cascade once, the owner's
message and a starting reply rise in (a finished reply replaces its live article without a
second entrance), disclosures unfold, cards lift on hover and press in on click. Reduced
motion stops all of it.

## Conversation — 2026-11-07

Each Ghost keeps one durable conversation, like Dots: there is no "new conversation" action.
The Ghost floats as a round button at the top center (its presence ring; it opens the
profile and look editor) and content fades beneath it. Work the conversation spins off
appears as **thread cards** at the moment it started, kept live (state glyph, carrier,
lifecycle); a card waiting on the owner is answered from the decision deck above the composer.
A settled thread folds to one quiet line — its OutcomeLine returns beneath it, so the
branch stays readable without saying the result twice; when nothing came between them, the
outcome alone draws the branch and the folded line is dropped. Opening a card or a thread from the
thread button (top right) brings the
**thread panel** beside the conversation (over it below 64rem, `?thread=` in the URL):
status and lifecycle, its decisions resolved in place, delegated threads, and the
carrier's work conversation streaming live. Editing and cancelling stay on the full
맡긴 일 page. The panel opens by growing its width so the conversation eases aside while its
content slides in from the edge, and closes the same way in reverse (over the conversation it
slides). Direct conversations kept from before stay reachable as 이전 대화. An empty
conversation shows the Ghost's name and starters only; its portrait already floats above.
Host wakes (reports, child results, decision answers, schedules, verdicts) render as quiet
event lines, never as the owner's bubble. The host writes them for the receiving Ghost; the
transcript reads them for the owner (`src/components/wake.ts`): one Korean line, the Ghost's
exact text folded beneath, and a settled Work as its OutcomeLine. Ghosts themselves are told
to talk to the owner without ids, digests or tool mechanics (host `tools/index.ts`
`OWNER_VOICE`); RefMark is the guard when they still do.

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
or a chosen time and sends `schedule.create`. Typing `/` as the whole draft offers the same
actions by keyboard (Korean words match too); `@` lists the Ghosts and hands the message to
the chosen one as a 맡긴 일 addressed to it, reported back into this conversation. The model
chip names the model; its provider is the tooltip. Model choice, cancel and send sit bottom right.
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
wins). Everything else about a Ghost lives in **Ghost 설정** (설정 → Ghost): a compact
portrait-and-name roster (searchable from eight Ghosts), then the selected Ghost's name
edited in place, model route, 역할 지시, skills and grouped tool switch-pills. The route stays
above potentially long role instructions so model settings remain immediately reachable. A group's
label toggles its tools. State, default designation, the PC 직접 실행 grant and retired-Ghost deletion live in a
separate 운영 group; the main Ghost shows its locked active state instead of disabled
choices. The sandbox keeps its two-step reset. New Ghosts start on the same sheet.
There is no avatar library: stored sprite avatars stay selectable in 꾸미기, nothing creates new ones.

## Settings

Ghost · 모델 · 금고 · 기기 · 반복 작업 · 자동 활동 · 연결 계정 · 호스트 · 화면, plus **데스크톱 아바타** inside the Mac app.
화면 picks the theme from three little windows painted in their own palette. 데스크톱
아바타 controls the Ghost that floats on the desktop above other apps (see the desktop shell).

Settings share a 164px secondary rail, an editor-width content column and the same
`SettingsGroup` header/body surface (`src/ui/settings.css`). The rail becomes horizontal
at 700px and keeps the selected item in view. Ghost sections reuse those groups rather
than wrapping individual controls in competing cards.

The **model route** is one connected sequence: effective primary, then at most three
numbered alternatives. Each step keeps its model and provider together; alternatives
carry their reorder/remove controls. Search stays inside the chooser; already-used
models cannot be selected again. Primary-model inheritance is distinct from removing
an alternative. A route edit waits for its save before the next edit; failures keep the
stored route and show a sticky error, with no automatic replay.

**자동 활동** is the owner's standing delegation per Ghost: one form owns brief, completion
criteria, source (일정 · PR · 메일 with its filters), tools narrowed to the Ghost's Work-capable grants
(browser and vault included; direct-only activity proposals and documents excluded),
execution (컨테이너 by default; 이 Mac needs the Ghost's PC grant and an actual folder),
and the policy limits. Saving is the activation — no activation follows from chat. Rows
lead with state: next run, last run (건너뜀·변경 없음 included), last error as its own
line, and a 연결 없음 mark when the source's account was deleted. A budget/concurrency
deferral is waiting, not failure: a 대기 badge plus reason and retry time, kept apart
from lastError; repeated genuine failures auto-pause on the host side and 재개 is the
owner's reset. 시험 is the read-only
dry run; it never writes or moves cursors, and its runs still land in history. PR 댓글·메일 회신
labels only the bound source reply/comment policy. Selected browser/Host tools retain
independent authority: browser tools keep their separate browser/vault approval rules,
not confinement by this setting. Sandbox and PC file/shell tools are also outside it.
Automatic outcomes are data in Work results, history and notifications, not new actionable
direct-conversation turns. Successful unchanged results can be quiet; skipped oversized
mail remains visible with a reason and an attention notification rather than a false summary.
Deleted activities' retained runs remain reachable in 삭제된 활동 실행 기록, including
skipped reasons and links to surviving Work. Run timestamps expose the exact instant
and self-check reasons remain visible. Pause/stop errors stay inside their open dialog.


**연결 계정** keeps credentials one-way: the secret field is blank on every open, stored
secrets never return to the screen, and a changed endpoint or account forces re-entry or
explicit removal — only a name-only edit preserves the credential. 테스트 reports under
its row; errors are distinct from an empty list.
Failed saves keep the dialog and typed draft. SMTP 암시적 TLS distinguishes TLS at
connect from mandatory STARTTLS; neither transport disables certificate verification.

Ghost 설정's 운영 group carries **PC 직접 실행**: an explicit owner grant whose warning
states that shell reaches the whole Mac and network: the grant is not a jail or
PR/mail approval enforcement boundary.
일 맡기기 shows 이 Mac with an actual cwd field only for granted Ghosts.
Work detail shows its explicit execution environment and PC cwd, with a route back to
automatic activities for bound runs. Paired devices still see every Ghost; there is no
per-Ghost device grant editor.
Work conversations retain the previous-message pager and show read failures rather than
presenting a failed history request as an empty conversation.

Visual captures mask the existing project folder breadcrumb, whose title contains its
actual private temporary path. Test-only fixed mask geometry keeps random TMPDIR names
out of baselines without changing runtime paths or product rendering.

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
