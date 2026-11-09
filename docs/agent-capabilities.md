# Agent capabilities: browser, vault, collaboration (2026-11-08)

Design record for the capability release that lets Ghosts act on real websites, use the owner's credentials without seeing them, and collaborate with fewer owner interruptions. [Architecture](architecture.md) keeps the principles; this document records the decisions and contracts behind them.

## Decisions

| Area | Decision | Rejected and why |
|---|---|---|
| Browser engine | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) (Apache-2.0, Rust CLI, already pinned by the owner's `agent-ui` at 0.41.2) driving the installed Google Chrome | Playwright MCP/CLI: origin filters are explicitly not a security boundary. chrome-devtools-mcp: no secret path, URL patterns only. browser-use / Stagehand: an LLM inside the primary interface. Lightpanda: AGPL, no persistent login, no visible window. OxiBrowser (owner's engine): its Ghost lane contract fits, but it claims no production-site compatibility, has no screenshots and keeps no login; Korean sites (Korail, 정부24, 쿠팡) need Chrome. |
| Network containment | A host-owned egress proxy. Chrome gets `--proxy-server=<proxy>` and `--proxy-bypass-list=<-loopback>`; the proxy resolves each destination, refuses loopback, private, link-local, CGNAT, ULA, multicast, NAT64/6to4-embedded private addresses, `localhost`, `*.local`, `*.internal`, `*.ts.net`, fails closed on unparsable addresses, and connects to the address it checked (no DNS rebinding). WebRTC is the one path around an HTTP proxy: review showed `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` alone still let a page send STUN to `127.0.0.1` over UDP, so a host init script removes the WebRTC constructors in every frame and the flag stays as a second layer. Spike: navigation and page `fetch()` to `127.0.0.1`/`localhost` were refused while `https://example.com` loaded. | agent-browser `--allowed-domains`: an allowlist, cannot express "public internet", and is incompatible with saved login state. An outer `sandbox-exec` profile around Chrome: not attempted in this release; Chrome applies its own seatbelt sandbox and nesting was not validated. |
| Sessions | One agent-browser session per conversation (own tabs and refs), `--restore ghost-<id>` per Ghost (cookies and storage shared by that Ghost's conversations, last writer wins), encrypted with a host key. The child runs with `HOME=<root>/browser/home` and a namespace, so the owner's own agent-browser state and plugins are never read. | One shared session per Ghost: concurrent conversations would fight over tabs. |
| Approvals | By blast radius. Reads and ordinary page actions run and are journaled as effects. `browser_propose` (purchase, payment, sending a message, deleting, legal submission) and every card-field fill open an `approve_effect`; the host performs the click or fill only after approval, only if the page URL is unchanged and the element still has the role and name the owner saw. Host commands keep their own approval. As defense in depth, `browser_click` and Enter/Space presses on an element whose accessible name looks like pay, order, delete, send, submit and their Korean equivalents are refused with a pointer to `browser_propose`; this name guard is a heuristic, not a payment authorization boundary. The real money boundary is that card values exist only in the vault and every card fill needs approval; a site's own stored payment method behind a renamed button remains a residual risk. | Per-click approval (unusable); confidence scores (the model controls them). |
| Secret exposure after a fill | Fill values travel only over stdin and are registered per browser session (memory only): later text results redact the value and its URL-, form-, HTML- and JSON-encoded forms. After a card or secret-value fill, screenshots are refused until the session closes; after a password fill, until that tab's URL changes. A password goes only into a password field; login and secret fields only on the item's exact origin, never in frames. | Persisting a redaction list (would store secrets). |
| Vault | A Ghost-owned vault ported from Shade's core model: kinds `login`, `card`, `contact`, `secret`; canonical https origins (Shade `normalize_origin`); generated passwords (Shade `generate`); encrypted version history; Apple/Chrome CSV import; TOTP seeds. AES-256-GCM per item under a host key at `<root>/vault/key` (0600); store at `<root>/vault/vault.db`, outside the ledger and its event feed. Secrets are write-only. Grants are per Ghost. | Calling Shade's CLI: whole-vault grant only and values returned to the caller. Shade stays a separate app for later. |
| Secure form | `vault_request` opens a `question` decision with `proposal.secureForm`; the owner answers in the app's secure form, which posts to the vault API. The ordinary answer path refuses these decisions for every principal, so a value can never be typed into chat. The iPhone hosts the same web UI, so it answers through the same secure form. | A new decision kind: clients decode kinds strictly and a native form would duplicate the web UI. |
| Handoff | `browser_handoff` reopens the session as a visible Chrome window on the Mac with the same login state and opens a `question` decision with `proposal.browserHandoff`; when the owner answers, the window closes and the next command runs headless with the saved state. | Streaming viewer: more surface than the owner needs on the same Mac. |
| Collaboration | A child asks its delegating Ghost first (`ask_parent` → parent `answer_child`); only the parent escalates to the owner. Reviewer verdicts carry `evidence` and `scope`; `revise` sends both. A delegate may give its child deterministic `checks`: for a child they gate review (fail → revise without review, pass → review); for a root Work owner checks still decide. Revision history travels with the outcome report so the parent or origin conversation can retain the lesson. | A peer messaging channel; automatic memory writes. |
| Desktop control | Not mounted in this release. [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) (pinned by `agent-ui`) is the right tool, but macOS grants Accessibility to the responsible process: probed under launchd on 2026-11-08 it reported `accessibility: denied` and `screen_recording: denied`. The Host runs from a LaunchAgent with an ad-hoc signed binary whose path changes every release, so a grant would not survive a release. Mounting it needs a stable, separately granted launcher and the owner's one-time grant in System Settings. | Driving the owner's desktop from the Host without that grant (impossible) or through pointer input (takes the owner's pointer). |
| Shared host guard | The host/IP guard moved from `web.ts` to `integrations/netguard.ts`, shared by `web_read`, `reach` and the egress proxy. Moving it fixed an IPv6 expansion bug: `::1` and IPv4-mapped loopback (`::ffff:127.0.0.1`) were misclassified as public. | — |

## Model-facing tools

All browser and vault tools are selectable and part of the default allow-list for new Ghosts; host tools stay explicit. Page-derived text is untrusted evidence and is wrapped in agent-browser content boundaries.

| Tool | Kind | Effect |
|---|---|---|
| `browser_open {url}` | direct, work | navigation (read); http(s) only, same host guard as `web_read` |
| `browser_snapshot {interactive?, selector?}` | direct, work | accessibility tree with `@eN` refs, bounded |
| `browser_screenshot {full_page?}` | direct, work | image content for image-capable models, otherwise a stored path |
| `browser_read {ref?}` | direct, work | visible text, bounded |
| `browser_click {ref}` · `browser_fill {ref, text}` · `browser_type {ref, text}` · `browser_press {key}` · `browser_select {ref, values}` · `browser_check {ref, checked}` | direct, work | journaled effect |
| `browser_scroll {direction, amount?}` · `browser_navigate {action}` · `browser_tabs {action, index?, url?}` · `browser_wait {ms?, text?, ref?}` | direct, work | read (tab close/new are journaled) |
| `browser_upload {ref, path}` · `browser_download {ref, name}` | work | journaled; files only inside the Work workspace (`downloads/`) |
| `browser_propose {ref, title, reason}` | direct, work | `approve_effect`; the host clicks after approval |
| `browser_handoff {reason}` | direct, work | visible window + owner question |
| `browser_fill_secret {ref, item_id, field}` | direct, work | journaled; value from the vault through stdin; card fields need approval; origin of the page must equal the item origin for login/secret fields |
| `browser_close {}` | direct, work | ends the session |
| `vault_list {origin?, kind?}` | direct, work | metadata of granted items |
| `vault_request {kind, origin?, title?, reason}` | direct, work | secure-form question; the new item is granted to the asking Ghost |
| `vault_generate_login {origin, username, title?}` | direct, work | new login with a generated password, never shown |
| `ask_parent {question}` | child work | lifecycle; the child waits for the answer |
| `answer_child {question_id, answer}` | parent work | lifecycle |

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

## Storage and operations

- Ledger migration 6 adds `work_questions` and a revision history column on `works`; the vault is a separate file. A previous Host refuses ledger 6, so rollback after cutover needs the pre-cutover backup.
- Config: `browser: { executable, chrome?, idleTimeoutMinutes? }`. Without it the browser tools are left out; the vault has no config.
- `ghost backup` copies `vault/vault.db` (consistent `VACUUM INTO`, integrity-checked) and `vault/key` when present. Browser login state under `<root>/browser` is not backed up: losing it only means signing in again.
- Browser files: uploads are copied with no-follow reads from the Work workspace into `<root>/browser/staging` (≤ 32 MiB each) and Chrome reads only the staged copy; downloads land in `<root>/browser/downloads/<session>` (≤ 64 MiB and 32 files per session) and are copied into the workspace with no-follow, create-only writes. Screenshots are read into the result (≤ 8 MiB) and deleted. Staging and downloads are removed when the session closes and at host shutdown.
