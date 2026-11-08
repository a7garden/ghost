# Changelog

## Unreleased

- 금고 (설정 → 금고): the owner's vault item list — kind, origin, username, card
  ••••last4/expiry, per-Ghost grants and one-time expiry — with add/edit/delete.
  Secret fields stay write-only: an empty field keeps the stored value, stored secrets
  read as 저장됨 and never as a value; a password generator fills 20 random characters;
  Apple Passwords/Chrome CSV import reports 가져옴·건너뜀·거부됨 counts.
- A question carrying `proposal.secureForm` renders the secure form for its kind
  (login·card·contact·secret fields, the requested origin and reason, 금고에 저장 checked
  by default) and answers through `POST /api/vault/requests/:decisionId` only — the chat
  answer path refuses these decisions. A `browserHandoff` question explains the waiting
  Chrome window on this Mac, shows its url and reason, and offers 다 했어요 next to 거부.
- Work verdicts show 근거 (what the reviewer observed) and 수정 범위 (what a revision may
  change) whenever the verdict records them.
- Ghost 설정 도구 권한: the new browser tools group as 브라우저 and the vault tools as 금고,
  each with Korean labels; every contract tool is labeled, so none falls to 기타.
- Conversations answer their own decisions: a Ghost's pending questions, approvals and result
  reviews — including those from its older conversations and from threads begun there — sit
  above the composer, so opening a Ghost that needs you no longer means going to 확인할 일.
- Settings: slimmer navigation and shared section surfaces. Ghost selection is a compact,
  searchable roster; model, role and capabilities precede separate operating controls.
- Model fallbacks form a connected route with provider names, search, reorder/remove
  actions and duplicate-choice prevention. Failed edits preserve the saved order.
- Models: standard providers expose refreshed models.dev catalogs automatically; ChatGPT
  subscriptions discover account models from Codex. Cached metadata keeps offline selection
  working, and manual model entries stay editable without saving the automatic catalog.
- Files open on a broad reading sheet instead of inside a small generic dialog. Markdown
  has 읽기/원문 views, document typography and local footnote navigation; source files have
  line numbers and optional wrapping. Copy and save preserve the original content.
  Images (including SVG), PDFs, empty files and unsupported binary files keep distinct
  presentations; the sheet adapts to narrow screens and restores focus on dismissal.
- Sidebar roster: a 고정 group (the default Ghost plus pinned ones) and a Ghost pool below it.
  The pool folds from its own header — sticky while scrolling, so folding no longer means
  hunting for a button at the bottom — and a folded pool still shows the Ghosts that need you
  or hold the open conversation. Pin from a Ghost's context menu.
- Thread cards: a settled thread folds to one quiet line (its outcome line already returns
  beneath it); a thread waiting on the owner is answered from the conversation's dock.
- Composer: `/` opens the composer's actions by keyboard (Korean words match), `@` hands the
  message to a chosen Ghost as a 맡긴 일 addressed to it; the model chip names the model and
  keeps its provider in the tooltip.
- Title bar: back/forward (`⌘[` `⌘]`) and a breadcrumb trail — section, the thing inside it,
  the open thread and the threads it came from; each step goes up to it.
- Sidebar: destinations and 설정 stay put; the roster scrolls under sticky labels, fades out
  while more follows, and a rail marks Ghosts that are working or need you. Opening a Ghost
  brings its row into view.
- The thread panel grows open beside the conversation and closes in reverse.
- The empty conversation no longer repeats the Ghost's portrait.
- Reports read like a person: a returned Work is an outcome line hooked to its thread card
  (state, title, files as chips, a failure's reason); who judged it, how long it took and its
  id wait behind a hover (Peek). Other host wakes are one line in Korean with the Ghost's
  exact text folded beneath.
- Ids and digests a Ghost writes into prose become marks: a Work's state glyph (opens its
  thread), a Ghost's face, a file icon, or a quiet # — the exact value is a hover away and
  copies on click. Code blocks and links stay exact.
- The conversation's scrollbar is a map: a hairline thumb plus ticks for the owner's turns,
  threads and returned Work in their state color; hover a tick for its name, click to jump,
  drag to scrub. Elsewhere scrollbars are trackless pills that show with the pointer.
- Composer: + menu bottom-left unfolds 사진·파일 첨부, 일로 맡기기 and 나중에 보내기; files
  upload on add, drop or paste and travel with `message.send`; the model chip moved beside
  send.
- 꾸미기 is only the look. Ghost 설정 keeps the editable name, role note, ordered model
  route, skill/tool pills and sandbox strip; state and default designation live in 운영.
- Removed the avatar library (creation, Codex import/export) and the in-window pet;
  설정 → 데스크톱 아바타 controls the desktop Ghost in the Mac app. 화면 picks themes from
  painted previews.
- Ghosts have no background: the 배경 row, the avatar 배경색 picker and portrait tiles are
  gone; a stored `look.background` is ignored.
- Chat reading pass: 15px/1.7 assistant text, tighter heading/list rhythm, tables as quiet
  cards with row hairlines, lighter code blocks, aligned tool trails.
- Streaming: text advances at an even pace, arriving words fade up out of a blur and a
  breathing dot follows the newest word; a finished reply no longer fades in twice.
- The composer's running edge is a comet with a soft glow over a faint steady ring.
- Model chip text no longer clips descenders (`glm-5.3`).
- Right-click menus on messages (copy, copy selection/link, quote into reply, reuse own
  message), thread cards and sidebar Ghosts.
- Motion: pages rise in, list rows cascade, cards lift and press, disclosures unfold.
- 꾸미기 opens in a dialog with a floating preview, 무작위 shuffle and instant choices.
- Collaboration is visible: 위임 event lines, delegated Ghosts on thread cards, 위임 결과
  대기 state, and a live work conversation on the Work page.

- Ghost variations: four body shapes (`look.shape`: round, egg, squircle, sheet) and six
  more accessories (crown, bow, cat ears, horns, headphones, glasses); the look editor gains
  a 모양 row. New app icon: the round Ghost with the blue working arc (Mac and iPhone).
- Threads open in a panel beside the conversation (`?thread=`): status, lifecycle,
  decisions resolved in place, delegated threads and the live work conversation.
- Secondary and meta text now meet WCAG AA in both themes (ink2/ink3 retuned; audited
  on home, 확인할 일, 맡긴 일, work detail, conversation and model settings).
- Removed the display-wide Ghost color preference; colors live only in each Ghost's look,
  and the avatar library previews the Ghost's own look.
- Home shows a setup card while no provider can run Ghosts; other pages' warning banner
  links to model settings. The default model's reasoning level is selectable.

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
