# Ghost Mobile

The native iPhone client shares Ghost's quiet neutral identity. The 2026-11-04 owner direction keeps direct conversation central and makes every Ghost accessible without an external messenger. The 2026-11-08 port brings the web/Mac agent surface to the phone with components drawn for touch rather than stock lists: the roster, threads that branch and return, a docked decision deck and a hand-off composer.

## Structure

대화 opens on the Ghost roster: `고정` (the default Ghost and phone-local pins) and the `Ghost` pool, folded from its sticky header but always showing Ghosts that need the owner or are working. Each row reads presence the way the web does (확인 필요 + decision heading, 응답 중, the running Work's title, a failure for a day). Retired and deleted Ghosts never appear. A row opens that Ghost's one durable conversation; older direct conversations stay reachable from the thread sheet. The work list uses Index First: root Works with their delegated children on a branch line, filterable by Ghost. Owner decisions, unresolved requests and result notifications share the third destination, 소식, whose tab carries the pending-decision count. Settings, scope details and recovery diagnostics open on demand. No marketing hero, fake device chrome, website footer or fabricated activity.

The existing web design's repeated Workbench structure does not govern this native app. These screens share one system rather than rotating themes per destination.

## Theme and tokens

Neutral layered surfaces follow the shipped web/Mac language: canvas `#fafaf9`, white cards and soft shadows; dark canvas `#121214` and cards `#18181b`. Color describes state, not decoration: signal blue working, amber needs owner, red failed, green accepted. Each state also has a distinct glyph (ring, travelling arc, pause bars, half disc, exclamation, check, cross, slash). SwiftUI's `GhostStyle` is the runtime token authority; `tokens.css` mirrors its light/dark values. Use SF system type with Dynamic Type and monospaced type only in disclosed technical details.

Primary buttons use explicit ink/on-ink tokens, including their disabled state, rather than the system's inferred label color. Approval requests and receipt criteria wrap completely; they never truncate the operation or acceptance conditions.

Spacing: 4/8/12/16/20/24/32. Primary controls have at least44pt hit targets. Messages use open assistant text and a distinct trailing user bubble; the Ghost's face lives once in the header, not beside every reply. No nested card grids, gradients, decorative orbs, invented counters or technical UUIDs in the default conversation: an id or digest a Ghost writes reads as the thing it names (a Work by state mark and title, a Ghost by name, a file by name), and only an unknown id keeps a six-character head that copies on tap.

The in-app Ghost portrait keeps the approved two bar eyes and small round mouth on a selectable body: `look.shape` selects round/egg/squircle/sheet (unset renders round). `look.face` selects bars/dots/arcs/tall and `look.mark` selects none/halo/antenna/sprout/ring/spark/crown/bow/ears/horns/headphones/glasses. Shape and accessory geometry uses the web renderer's 1000-unit space and 100…900 viewport. Behind-body marks use the body color; front bows, headphone cups and glasses use the face color with the same strokes and layering as the web. Unknown options decode as unset. The twelve body colors and stable default hue match the web palette; the id hash wraps UInt32 over UTF-16 code units. A travelling blue arc marks working; an amber ring with a notch marks owner attention. The app icon is the round Ghost with the blue working arc, sourced from `apps/ghost-desktop/src-tauri/brand-source/Ghost-round-ios.svg`.

## Interaction

The composer stays above the keyboard and system tab bar. Sending preserves the existing durable draft/receipt contract; a lost acknowledgment remains unresolved and is never silently retried. Earlier-message reading must not jump when refresh brings new content; `이전 메시지` loads older pages in place. The header shows the Ghost's face and presence; its branch button opens the thread sheet (live and settled threads, earlier conversations, 맡긴 일 전체). The composer's `+`, `/` and `@` turn a message into a 맡긴 일 for this or another Ghost, with completion criteria and an optional deadline, reporting back to this conversation. The phone omits what the host reserves for the owner: attachment upload, the model chip and send-later. Their original authority and disclosure guards remain enforced.

Work summaries distinguish running, produced, accepted, failed and unconfirmed. Completion is not acceptance. Approval details must still show the exact operation, destination, input and target before any decision. Technical facts can be disclosed within the relevant detail rather than injected into every default screen.

There is one durable conversation per Ghost; existing older conversations remain reachable and no new-conversation action is added. Host-origin wakes are quiet event lines in the owner's language whose exact text unfolds on tap; a `delegate` result reads as a 위임 line. Streamed reasoning stays open as 생각 중 with its newest step, then folds to 생각 과정 when reply text arrives. Consecutive tool results fold into one trail of tool chips. A Work begun here hangs from the conversation as a thread card: live, it shows carrier, state, lifecycle and the Ghosts it delegated to; settled, it folds to one line, and its return arrives below as an outcome line (tinted state pill, failure reason or result files) whose audit facts sit behind a long press. Tapping a thread, outcome or Work mark opens the thread sheet at that Work. Work headers show the 접수 · 진행 · 검증 · 완료 lifecycle.

Pending decisions of this Ghost and of every thread begun in the conversation, at any depth, dock above the composer as a stack: the oldest card on top and actionable, the rest peeking behind, foldable to a slim bar. Decision cards follow their kind: numbered question options with an inline answer, the full exact request for approvals (a host command shows reason, `cwd $ command` and risk once), a result receipt containing the summary, files and completion criteria, and the proposed page for document review. Command and confirmation semantics remain unchanged. A result file opens in a focused reading sheet (읽기/원문 for Markdown, line numbers and wrapping for source, save through the share sheet) that still renders untrusted bytes inertly.

Every action states its real outcome: sending, stopping a response, cancelling or resuming a Work, resolving a decision, and reading a notification each show their own disabled, loading, error, offline, empty, pending and settled states. Nothing promises a route the host does not serve, and success is shown in place, without celebratory toasts.

## Motion and accessibility

Use native navigation and short opacity/press transitions, no page-load animation. Honor Reduce Motion. Maintain Dynamic Type, VoiceOver labels, selected-state semantics, meaningful focus, contrast and safe areas. Verify compact phone widths, the actual iPhone14, larger phone/tablet widths and dark mode. Preserve the existing app bundle/Keychain on device reinstall.

## Pairing and reach

A paired phone reaches every Ghost (owner decision, 2026-11-08): pairing has no Ghost or
conversation choice, and a Ghost created later appears on the phone at once. The host
still limits the phone to device commands and never sends it owner-only collections;
revoking the device on the PC is the control. Display actual Ghost names, not raw IDs as
default navigation labels.

The connect screen is one decision: scan the QR the PC shows under 설정 › 기기 › 기기 연결,
drawn as that path rather than a sentence. Typing the server and code is the fallback in
a sheet (uppercase, spaces dropped, the address checked before the sheet closes). The
phone names itself at claim; the name is editable before connecting. Connecting, an
interrupted claim (send again unchanged or start over) and a failure each replace the
action area instead of stacking warnings. The phone validates the origin and code before
claiming, then stores the issued device credential.

Switching keeps each draft in its original pair, clears pending attachment selection,
and restores the chosen conversation after reopening. An uncertain send remains tied
to its original request and cannot become a fresh send to another Ghost. Provider
selection errors lock apply until a fresh read; tentative consent resets on reconnect.

The app talks directly to the paired host API on one origin. There is no separate
relay process and no external messenger dependency. APNs hardware acceptance and
actual installed-device rollout remain separate from simulator UI verification.
