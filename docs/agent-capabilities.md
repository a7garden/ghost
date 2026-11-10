# Agent capabilities: browser, vault, collaboration (2026-11-08)

Design record for the capability release that lets Ghosts act on real websites, use the owner's credentials without seeing them, and collaborate with fewer owner interruptions. [Architecture](architecture.md) keeps the principles; this document records the decisions and contracts behind them.

## Decisions

| Area | Decision | Rejected and why |
|---|---|---|
| Browser engine | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) (Apache-2.0, Rust CLI, already pinned by the owner's `agent-ui` at 0.41.2) driving the installed Google Chrome | Playwright MCP/CLI: origin filters are explicitly not a security boundary. chrome-devtools-mcp: no secret path, URL patterns only. browser-use / Stagehand: an LLM inside the primary interface. Lightpanda: AGPL, no persistent login, no visible window. OxiBrowser (owner's engine): its Ghost lane contract fits, but it claims no production-site compatibility, has no screenshots and keeps no login; Korean sites (Korail, 정부24, 쿠팡) need Chrome. |
| Network containment | A host-owned egress proxy. Chrome gets `--proxy-server=<proxy>` and `--proxy-bypass-list=<-loopback>`; the proxy resolves each destination, refuses loopback, private, link-local, CGNAT, ULA, multicast, NAT64/6to4-embedded private addresses, `localhost`, `*.local`, `*.internal`, `*.ts.net`, fails closed on unparsable addresses, and connects to the address it checked (no DNS rebinding). WebRTC is the one path around an HTTP proxy: review showed `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` alone still let a page send STUN to `127.0.0.1` over UDP, so a host init script removes the WebRTC constructors in every frame and the flag stays as a second layer. Spike: navigation and page `fetch()` to `127.0.0.1`/`localhost` were refused while `https://example.com` loaded. | agent-browser `--allowed-domains`: an allowlist, cannot express "public internet", and is incompatible with saved login state. An outer `sandbox-exec` profile around Chrome: not attempted in this release; Chrome applies its own seatbelt sandbox and nesting was not validated. |
| Sessions | One agent-browser session per conversation (own tabs and refs), `--restore ghost-<id>` per Ghost (cookies and storage shared by that Ghost's conversations, last writer wins), encrypted with a host key. The child runs with `HOME=<root>/browser/home` and a namespace, so the owner's own agent-browser state and plugins are never read. | One shared session per Ghost: concurrent conversations would fight over tabs. |
| Approvals | By blast radius. Reads and ordinary page actions run and are journaled as effects. `browser_propose` (purchase, payment, sending a message, deleting, legal submission) and every card-field fill open an `approve_effect`; the host performs the click or fill only after approval, only if the page URL is unchanged and the element still has the role and name the owner saw. Host commands keep their own approval. As defense in depth, `browser_click` and Enter/Space presses on an element whose accessible name looks like pay, order, delete, send, submit and their Korean equivalents are refused with a pointer to `browser_propose`; this name guard is a heuristic, not a payment authorization boundary. The real money boundary is that card values exist only in the vault and every card fill needs approval; a site's own stored payment method behind a renamed button remains a residual risk. Since 2026-11-10 the host also reads page facts itself (`FACTS_SCRIPT`: checkout/payment URL or text signals and the shown total): on a checkout step every click and Enter/Space is refused toward `browser_propose` whatever the button is called, unreadable facts count as a checkout, and an approval carries the merchant and total the host read; the executor re-reads both right before the click and refuses if the site or total changed. A page can still hide these signals, so this narrows the residual risk rather than closing it. | Per-click approval (unusable); confidence scores (the model controls them). |
| Secret exposure after a fill | Fill values travel only over stdin and are registered per browser session (memory only): later text results redact the value and its URL-, form-, HTML- and JSON-encoded forms. After a card or secret-value fill, screenshots are refused until the session closes; after a password fill, until that tab's URL changes. A password goes only into a password field; login and secret fields only on the item's exact origin, never in frames. | Persisting a redaction list (would store secrets). |
| Vault | A Ghost-owned vault ported from Shade's core model: kinds `login`, `card`, `contact`, `secret`; canonical https origins (Shade `normalize_origin`); generated passwords (Shade `generate`); encrypted version history; Apple/Chrome CSV import; TOTP seeds. AES-256-GCM per item under a host key at `<root>/vault/key` (0600); store at `<root>/vault/vault.db`, outside the ledger and its event feed. Secrets are write-only. Grants are per Ghost. | Calling Shade's CLI: whole-vault grant only and values returned to the caller. Shade stays a separate app for later. |
| Secure form | `vault_request` opens a `question` decision with `proposal.secureForm`; the owner answers in the app's secure form, which posts to the vault API. The ordinary answer path refuses these decisions for every principal, so a value can never be typed into chat. The iPhone hosts the same web UI, so it answers through the same secure form. | A new decision kind: clients decode kinds strictly and a native form would duplicate the web UI. |
| Handoff | `browser_handoff` opens a `question` with `proposal.browserHandoff.live` and holds off Ghost browser calls until the owner answers. The owner uses the same live browser panel from the Mac or a paired phone; after the answer the Ghost takes a fresh snapshot and continues on the page the owner left. A Mac-window handoff closes and resumes headlessly. Owner frames are not model screenshots: they show the owner's page without model redaction. | The earlier 1.5-second screenshot polling path is replaced by the authenticated live stream below. |
| Collaboration | A child asks its delegating Ghost first (`ask_parent` → parent `answer_child`); only the parent escalates to the owner. Reviewer verdicts carry `evidence` and `scope`; `revise` sends both. A delegate may give its child deterministic `checks`: for a child they gate review (fail → revise without review, pass → review); for a root Work owner checks still decide. Revision history travels with the outcome report so the parent or origin conversation can retain the lesson. | A peer messaging channel; automatic memory writes. |
| Desktop control | Not mounted in this release. [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) (pinned by `agent-ui`) is the right tool, but macOS grants Accessibility to the responsible process: probed under launchd on 2026-11-08 it reported `accessibility: denied` and `screen_recording: denied`. The Host runs from a LaunchAgent with an ad-hoc signed binary whose path changes every release, so a grant would not survive a release. Mounting it needs a stable, separately granted launcher and the owner's one-time grant in System Settings. | Driving the owner's desktop from the Host without that grant (impossible) or through pointer input (takes the owner's pointer). |
| Shared host guard | The host/IP guard moved from `web.ts` to `integrations/netguard.ts`, shared by `web_read`, `reach` and the egress proxy. Moving it fixed an IPv6 expansion bug: `::1` and IPv4-mapped loopback (`::ffff:127.0.0.1`) were misclassified as public. | — |
| Live browser (2026-11-10) | Owner request "코덱스 내 브라우저처럼": the owner watches and drives any conversation's browser session at any time, not only during a handoff. agent-browser's per-session screencast stream (one localhost WebSocket per session; browser Origins are refused with 403) carries JPEG frames and CDP mouse/keyboard input. The Host holds one upstream connection per session, fans frames out to at most four owner clients as NDJSON over an authenticated `fetch` stream (the UI's bearer token cannot ride a browser WebSocket), and forwards validated input. Obscura renders natively (v0.2.6 screencast, mouse/key input, cookies), so the same stream works for both engines. After owner input the Ghost's next browser call is told to take a fresh snapshot. | Polling screenshots per input (three CLI spawns per tap, 1.5 s frames). A Tauri webview on third-party pages: would leave Ghost's proxy, login state and redaction, and not reach the iPhone. |
| Mac window for Obscura | Opening an Obscura session as a Mac window migrates it to Chrome: cookies are read over Obscura's CDP, imported into the Ghost's Chrome session and the page reopens headed. The session stays Chrome, so those cookies join the Ghost's saved Chrome login state. | Keeping Obscura headed: it has no window. |
| Login capture | When the owner signs in through the live view or a Mac window, the Host reads the https top-level page's password field and the matching username field over stdin `eval` and saves them as an owner vault login (exact origin + username; a changed password becomes a new encrypted version) granted to that Ghost, only once the login looks successful (the field is gone, the URL changed, or the owner finished the handoff). The owner gets a notification without the password; the Ghost gets the item id. Values stay in memory until then and are registered for redaction. | Browser password managers (outside Ghost's vault and grants). Asking after every login (the owner asked for automatic saving). |
| Whole-card fill | `browser_fill_card` fills number, expiry (or month/year inputs and selects), CVC and name after one `approve_effect` that shows merchant and total read by the Host; `browser_fill_secret` no longer takes card fields. | One approval per card field (four cards per checkout). |
| Message codes | `host_message_codes` reads recent incoming verification codes from `~/Library/Messages/chat.db` through a read-only SQLite connection, including committed WAL rows. Text comes from `message.text` or the first `attributedBody` NSString. Verification-specific context is required; bulk-SMS markers and postcodes do not qualify. Explicit host-tool grant and Full Disk Access are required; SMS also need iPhone Text Message Forwarding. | `immutable=1` ignores WAL; separately copying a live DB and WAL cannot guarantee consistency. If SQLite admission fails, the tool reports the permission/restart prerequisite instead. |
| Mail client | Owner-registered IMAP/SMTP connections (app passwords: Gmail, iCloud, Naver, Daum) are browsable in the app's 메일 view and usable by Ghosts granted `mail_*` tools. Reads use `BODY.PEEK`; flag/move/archive/trash are journaled; every Ghost send waits for the owner's approval showing recipients and the whole body, and an uncertain send is never repeated. Mail tools are not in a new Ghost's default allow-list. | Gmail/Outlook OAuth: needs the owner's own OAuth client; Outlook.com no longer accepts IMAP passwords, so it is not offered. |

## Model-facing tools

The Apple Silicon Host can ship Obscura as a second browser. Choose
`browser_open { url, engine: "obscura" }` for a conversation's first browser
open. Close the session before selecting a different engine. The Host starts
the official binary under a macOS sandbox with an authenticated loopback CDP
listener and network access to the Host proxy port. Obscura supports the app's
live browser handoff. Its sessions are memory-only and require a fresh login
after closing or expiry. For vault input the exact HTTPS origin must appear
in `browser.obscura.loginOrigins` in addition to the existing Ghost and vault
grants. The Obscura route accepts login fields. Use the existing browser for
cards and file transfers.

All browser and vault tools are selectable and part of the default allow-list for new Ghosts; host and mail tools stay explicit. Page-derived text is untrusted evidence and is wrapped in agent-browser content boundaries.

| Tool | Kind | Effect |
|---|---|---|
| `browser_open {url}` | direct, work | navigation (read); http(s) only, same host guard as `web_read` |
| `browser_snapshot {interactive?, selector?}` | direct, work | accessibility tree with `@eN` refs, bounded |
| `browser_screenshot {full_page?}` | direct, work | image content for image-capable models, otherwise a stored path |
| `browser_read {ref?}` | direct, work | visible text, bounded |
| `browser_click {ref}` · `browser_fill {ref, text}` · `browser_type {ref, text}` · `browser_press {key}` · `browser_select {ref, values}` · `browser_check {ref, checked}` | direct, work | journaled effect |
| `browser_scroll {direction, amount?}` · `browser_navigate {action}` · `browser_tabs {action, index?, url?}` · `browser_wait {ms?, text?, ref?}` | direct, work | read (tab close/new are journaled) |
| `browser_upload {ref, path}` · `browser_download {ref, name}` | work | journaled; files only inside the Work workspace (`downloads/`) |
| `browser_propose {ref, title, reason}` | direct, work | `approve_effect` showing the host-read merchant and total; the host clicks after approval only if the page, element, site and total are unchanged |
| `browser_handoff {reason}` | direct, work | live owner question; the owner drives the session from any device or opens it as a Mac window |
| `browser_fill_secret {ref, item_id, field}` | direct, work | journaled; `field` = username/password/totp/value; value from the vault through stdin; page origin must equal the item's origin or an owner-set `extraOrigins` entry |
| `browser_fill_card {item_id, number_ref, expiry_ref?, expiry_month_ref?, expiry_year_ref?, cvc_ref?, name_ref?}` | direct, work | one approval for the selected card fields; page, merchant and total rechecked before filling |
| `browser_close {}` | direct, work | ends the session |
| `vault_list {origin?, kind?}` | direct, work | metadata of granted items |
| `vault_request {kind, origin?, title?, reason}` | direct, work | secure-form question; the new item is granted to the asking Ghost |
| `vault_generate_login {origin, username, title?}` | direct, work | new login with a generated password, never shown |
| `ask_parent {question}` | child work | lifecycle; the child waits for the answer |
| `answer_child {question_id, answer}` | parent work | lifecycle |
| `host_message_codes {within_minutes?, sender_contains?}` | direct, work | read-only incoming verification codes, at most 10, from the last 1–60 minutes (default 10); explicit Mac tool grant |
| `mail_search {account?, mailbox?, query?, unread_only?, limit?}` | direct, work | lists accounts/mailboxes or searches messages; no read flags changed |
| `mail_read {account, mailbox, uid}` | direct, work | bounded message text as untrusted content; no read flags changed |
| `mail_update {account, mailbox, uids, action, target?}` | direct, work | journaled seen/unseen/flag/unflag/archive/trash/move |
| `mail_send {account, to, cc?, bcc?, subject, text, reply_to?}` | direct, work | owner-approved send/reply; uncertain SMTP outcomes are never replayed |

## Owner API (vault)

Every authenticated principal (owner token and paired devices); values are accepted, never returned.

| Route | Body / result |
|---|---|
| `GET /api/vault/items` | `{ items: VaultItem[] }` (expired one-time items are pruned) |
| `POST /api/vault/items` | `{ id?, kind, title, origin?, username?, password?, totp?, card?: {number, expiry, cvc, name}, contact?, value?, hints?, ghostIds? }` → `VaultItem` |
| `PATCH /api/vault/items/:id` | same fields, omitted = unchanged; `password`/`totp`/`card`/`value` replace and keep the previous version encrypted |
| `DELETE /api/vault/items/:id` | removes the item and its history |
| `POST /api/vault/import` | `{ csv }` (Apple Passwords or Chrome export) → `{ imported, skipped, rejected }`. Imports https logins with their username, password and a valid Apple `OTPAuth` seed; identical origin+username+password rows are skipped, a different password for the same login is kept as its own item. Notes and unknown columns are not imported (Ghost has no recovery-source archive like Shade's) |
| `POST /api/vault/requests/:decisionId` | secure-form answer: item fields + `save: boolean`; resolves the decision with metadata only. `save:false` makes a one-time item that expires after 24 h |

## Owner API (browser and mail)

All routes use the existing bearer authentication for the owner and paired devices. Responses and streams are `no-store`.

| Route | Purpose |
|---|---|
| `GET /api/browser/sessions` | active session identities, engine, Mac-window state and pending handoff decision |
| `GET /api/browser/sessions/:conversationId/live?fps=8` | NDJSON stream of JPEG frames, page metadata and session end; 1–15 fps, at most four viewers |
| `POST /api/browser/sessions/:conversationId/input` | one validated mouse, key, text or navigation event |
| `POST /api/browser/sessions/:conversationId/window` | visible Mac Chrome; an Obscura session migrates with cookies |
| `GET /api/mail/accounts` | configured mail accounts with credentials |
| `GET /api/mail/:connectionId/mailboxes` | mailbox paths, special-use roles and counts |
| `GET /api/mail/:connectionId/messages?mailbox=&q=&before=&limit=` | newest-first UID pagination, up to 100 per page |
| `GET /api/mail/:connectionId/message?mailbox=&uid=` | parsed message without setting Seen; raw-message cap 25 MiB |
| `GET /api/mail/:connectionId/attachment?mailbox=&uid=&part=` | bounded attachment download |
| `POST /api/commands` → `mail.send` | recipients, subject, body and optional reply reference; durable request identity prevents duplicate sends |
| `POST /api/commands` → `mail.update` | mailbox, UIDs and seen/unseen/flag/unflag/archive/trash/move action |

## Storage and operations

- Ledger migration 6 adds `work_questions` and a revision history column on `works`; the vault is a separate file. A previous Host refuses ledger 6, so rollback after cutover needs the pre-cutover backup.
- Card-fill authority is a transactional data-only startup cutover, marked once by `settings["browser:card-fill-cutover:1"]`: a Ghost, Work scope or Activity with `browser_fill_secret` also receives `browser_fill_card`; unrelated or empty allow-lists do not. Later owner revocation is preserved on restart. This avoids renumbering unrelated schema migrations on concurrent release lines. Pending old per-field card approvals are declined and must be proposed again as a whole-card fill. `/browser-vault-2` in the update storage fingerprint prevents automatic rollback to an older client that cannot preserve the new contact fields.
- Config: `browser: { executable, chrome?, idleTimeoutMinutes?, obscura?: { executable, loginOrigins? } }`. Without it the browser tools are left out; the vault has no config. Obscura receives only a private cached copy of the Mac's `AppleSDGothicNeo.ttc` via `--font-dir`, with a narrow read-only sandbox grant; this supplies Korean glyphs without loading all system fonts or distributing Apple's font.
- `ghost backup` copies `vault/vault.db` (consistent `VACUUM INTO`, integrity-checked) and `vault/key` when present. Browser login state under `<root>/browser` is not backed up: losing it only means signing in again.
- Browser files: uploads are copied with no-follow reads from the Work workspace into `<root>/browser/staging` (≤ 32 MiB each) and Chrome reads only the staged copy; downloads land in `<root>/browser/downloads/<session>` (≤ 64 MiB and 32 files per session) and are copied into the workspace with no-follow, create-only writes. Screenshots are read into the result (≤ 8 MiB) and deleted. Staging and downloads are removed when the session closes and at host shutdown.

## External prerequisites

- [Obscura v0.2.6](https://github.com/h4ckf0r0day/obscura/tree/v0.2.6#rendering) includes native screenshots and screencasting in the pinned rendering archive. Its independent layout/Web APIs differ from Chrome; a visible Mac window transfers cookies to Chrome rather than pretending Obscura has a native window.
- [Apple Text Message Forwarding](https://support.apple.com/en-us/102545) must send SMS to this Mac. Messages access additionally needs the owner's Full Disk Access grant for the running Host; a tool grant cannot bypass macOS privacy permissions.
- Gmail and iCloud connections use provider-issued app passwords, not the owner's main password. OAuth is not configured by inventing a Google/Microsoft client identity. Account setup stays in the app's write-only connection form.
