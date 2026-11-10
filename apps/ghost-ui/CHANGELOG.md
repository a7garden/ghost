# Changelog

## Unreleased

- 데스크톱 펫의 잘리는 상태 말풍선을 짧은 일 건수로 바꿨다. 호버하거나 누르면
  확인할 일과 진행 중인 모든 맡긴 일을 제목·상태 목록으로 펼치고, 해당 항목을 바로 연다.
  긴 제목은 줄바꿈하고 많은 일은 스크롤한다. 화면 가장자리의 위치 복원과 끌기 중 펼침 방지도 포함한다.
- 기본 스크롤바를 없앴다. 마우스·트랙패드에서는 모든 스크롤 영역(홈, 설정, 스레드, 파일,
  결정 카드, 코드 블록, 검색·메뉴 목록)이 대화와 같은 ScrollRail을 쓴다. 포인터를 올리거나
  직접 스크롤하면 가장자리에 위치 막대가 나타나고, 끌거나 누르거나 휠로 움직인다. 가로로
  넘치는 영역은 아래쪽에 같은 막대가 생긴다. 터치는 시스템 표시를 유지한다.
- 기본 Ghost가 살아 움직인다. 눈을 깜빡이고(가끔 두 번), 고개를 돌려 둘러보며 몸을 그쪽으로
  기울인다. 56px 이상의 초상은 가까운 포인터를 따라 쳐다본다. 누르면 깡충 뛰며 깜빡인다.
  56px 미만은 쉬는 동안 다음 동작까지 프레임을 쓰지 않는다. 28px 미만의 목록 아바타, 애니메이션 끄기,
  동작 줄이기 설정에서는 정지한다. 안경은 얼굴과 함께 움직이고, 꾸미기 미리보기도 움직인다.
- 기본 Ghost의 몸이 말랑해졌다. 누르면 웅크렸다가 늘어나며 뛰고, 착지하면 납작해졌다가
  몇 번 출렁이며 멈춘다. 고개를 돌릴 때 윗부분이 뒤따라 흔들리고, 큰 초상은 천천히 숨을 쉰다.
- 마우스를 올리면 기본 Ghost가 살짝 눌리며 눈을 가늘게 뜨고 커서를 본다. 올려 둔 동안 가끔
  몸을 흔들고, 떠나면 튕기듯 돌아와 잠시 뒤 정면을 본다. 터치에는 반응하지 않는다. 둘러보기 간격을
  늘리고 고개 돌릴 때의 출렁임을 줄여, 24명이 모인 목록에서 동시에 움직이는 수가 평균 8.5에서 3으로 줄었다.
- 최신 메시지 버튼은 불투명한 표면을 사용해 어두운 테마에서도 HTML·이미지 위의 글자가
  흐려지지 않는다.
- iPhone UI 점검: 금고·자동 활동·연결 계정의 위치 제목을 바로잡고 설정의 중복 제목을
  줄였다. 스위치·체크박스는 모양을 늘리지 않고 44px 터치 영역을 제공하고, 꾸미기의
  색상은 찌그러지지 않는 44px 원으로 표시한다.
- 대화의 차트 글자와 범례를 터치 화면에 맞추고 비교 표의 첫 열을 고정했다.
  선택·입력 응답은 넓은 버튼과 키보드 위 전송 영역을 사용한다. 정적 HTML은 내용을
  측정해 높이를 맞추며 크기 조절 손잡이 대신 전체 화면 보기를 제공한다. 스타일·이미지가
  있는 HTML은 잘못된 축소 측정 대신 380px 읽기 영역을 사용한다. 불투명 샌드박스·리소스
  차단 CSP·일반 메시지 전송 경로는 유지한다.
- Ghost가 먼저 보낸 대화는 홈과 확인할 일에서 초상·이름·첫 문장으로 열 수 있다.
  iPhone 알림 설정에 대화를 추가하고 네 종류를 2×2로 배치했다.
- 데스크톱·iPhone의 모든 설정, 문서 편집기, 결정 종류, 실시간 대화와 도구 기록,
  대화형 응답 전송·수정·키보드·전체 화면에 시각 회귀 검사를 추가했다.
- 프로젝트별 Ghost 접근 설정을 없앴다. 모든 활성 Ghost가 프로젝트 문서를 읽고 수정안을 제안하며, 실제 저장은 기존 소유자 검토를 거친다.
- 대화·홈·맡기기 작성창에서 `#`로 프로젝트를 골라 함께 보낸다. 대화 기록에는 프로젝트 칩이 남고, Ghost는 답하기 전에 해당 문서를 읽도록 안내받는다.
- 프로젝트 화면에서 바로 대화를 시작하거나, 프로젝트를 포함해 Ghost에게 일을 맡긴다.
- iPhone은 같은 웹 UI를 연다. 56rem 아래에서는 하단의 홈·받은 일·맡긴 일·작업실·설정으로
  이동하고, 대화와 상세 화면은 본문에 자리를 내준다. 터치 메뉴·적응형 시트·키보드 높이에
  맞는 작성창을 공유 컴포넌트에서 제공한다. 데스크톱 레이아웃은 유지한다.
- iOS 셸은 알림 진입·복귀·테마·연결 해제를 웹 UI와 연결한다. 기기 설정은 이 기기의
  알림 권한과 종류별·Ghost별 알림을 관리하며, 빠른 설정 변경도 순서대로 저장한다.
- 좁은 화면의 제목·뒤로 가기는 상단에 모으고, 메시지 메뉴는 복사 옆으로 옮겨 본문 너비를
  유지한다. 기기 알림 카드와 Ghost 목록은 같은 여백과 왼쪽 정렬로 다듬었다. 맡긴 일은
  상태 선택과 일 맡기기를 한 줄에 놓고, 필터는 작은 알약 모양에 넉넉한 터치 영역을 둔다.
- 좁은 Mac 앱 창은 기존 제목 표시줄·창 끌기·전체 메뉴를 유지한다. 검색의 Enter는 터치에서만
  키보드를 닫고, 시트 손잡이는 키보드 초점을 차지하지 않는다.
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
- 자동 활동: per-Ghost standing activities live in 설정 → 자동 활동. The owner writes
  the brief, completion criteria and source (일정, PR filters, mail filters), picks tools
  from what the Ghost already has, sets limits (runs/day, concurrency, timeout, self-check
  interval) and the bound source policy (PR 댓글·메일 회신: 거부 · 승인 후 실행 · 허용) — nothing
  activates before a save. Rows show the next run, the last run's state, skipped/changed
  marks and the last error; per-row 실행 runs once, 시험 dry-runs (no writes, cursor left
  alone — the run itself still lands in history), pause offers to stop the running 맡긴 일
  too, and 모두 멈추기 pauses every enabled activity's future auto runs and cancels the
  currently running 맡긴 일. Run history lists each run with its watched item and opens its Work.
- 연결 계정: GitHub·Gitea tokens and IMAP mail accounts are owner settings with
  create/edit/test/delete. Secrets start blank every time and are never shown again; a
  name-only edit keeps the stored credential, changing endpoint or account requires
  retyping it or removing it explicitly; test results appear under their row, distinct
  from an empty list.
- PC 직접 실행: Ghost 설정 → 운영 carries the owner-only unrestricted-PC grant with a
  warning that shell affects the whole Mac and network and is not confined by PR/mail
  approval policy. 일 맡기기 offers 이 Mac — with the actual working folder — only for granted
  Ghosts; container stays the default.
- Ghosts can carry the 활동 제안 tool pill (`activity_propose`): a proposal for the owner,
  never an activation.
- A deferred activity (budget, concurrency) reads as 대기 on its row — the reason and the
  retry time as ordinary waiting text, separate from the red last error. The host
  auto-pauses an activity after repeated genuine failures; the row's 재개 is the owner's
  reset and restarts the schedule.
- Automatic activity outcomes stay in Work results, run history and notifications; they
  do not wake an unrestricted direct-conversation turn. Successful no-change runs stay quiet.
- Failed account saves keep the dialog and typed fields. Activity edits retain exact
  cadence and second precision; SMTP distinguishes implicit TLS from required STARTTLS.
- Activity tools retain granted browser/vault capabilities and document reads but exclude direct-only proposals.
  PR 댓글·메일 회신 applies only to bound mail replies/PR comments,
  not generic browser actions or file/shell tools. Selected browser/Host tools retain
  their independent authority; browser/vault keep their separate approvals, and the PC
  grant is not a jail or approval-enforcement boundary.
- Deleted activities' retained runs stay visible; run history exposes self-check reasons,
  and pause/stop failures remain inside the confirmation dialog. Work detail shows its
  explicit execution environment and PC folder.
  Work conversations expose older-message paging and keep read errors visible.
- Visual tests mask the actual temporary project breadcrumb with stable test-only geometry,
  rather than depending on a particular TMPDIR path.

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
