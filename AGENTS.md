# Ghost repository guidance

## Execution architecture

Every Ghost is the same kind of independently identifiable, durable bot, with its own tool allow-list. The default Ghost is the entry point and, only in direct conversations, may inspect and configure other non-default Ghosts. It cannot configure itself or change the default designation; those remain owner-only. Since 2026-11-07 the host is one Bun/TypeScript process (`apps/ghost-host`) that runs every conversation in-process on Pi Durable; read [the architecture](docs/architecture.md) before changing it and keep its principles: every wake is a deterministic-id submission, effects are journaled before I/O and never replayed, capability is the intersection of conversation kind, Ghost tool permissions and integration grants, widened only by the owner's per-Ghost permissions (a grant removes the question, never the effect journal), reads are not journaled. The production Mac runs it since 2026-11-07; [local operations](docs/local-operations.md) records the installed release and the rollback path.

The native iPhone app must support direct conversation, delegation, approval, results and reconnect without Telegram, Slack or another messenger. A paired device reaches every Ghost (owner decision 2026-11-08), but may send only device commands; revocation is the control.

## Product scope

See [current goals and scope](docs/current-priorities.md) for the product entry point and remaining acceptance boundaries. Dated migration plans are historical evidence, not an independent backlog.

Use **맡긴 일** for work assigned to Ghost. Keep execution time limits, durable scheduling, work resumption, and completion notifications. There is no personal planner or calendar.

## Local operations

- Use the canonical checkout at `~/Workspace/Projects/ghost` and integrate verified changes into `main`. Use temporary worktrees for isolation and consolidate or archive them after verification.
- Keep one operating Host for the production state root. The installed desktop app uses external Host mode. Development and tests always use a separate state root (`GHOST_ROOT`) and port; the host refuses to open a pre-Bun state root in place.
- Before operating on a process, verify its path, listener, and state root. Close test apps and their servers when done. See [local operations](docs/local-operations.md) for checks and recovery.
- Owner standing authorization: after every verified, persistent Ghost implementation change, deploy it to the installed production Mac app in the same task without asking again. Deployment and checking the actual installed app are completion criteria; do not stop at "built" or "not deployed." Documentation-only changes with no runtime effect do not require a release.
- For Host/UI changes, install a versioned Host + UI release, atomically switch `~/.local/share/ghost/current`, gracefully restart the single production Host and refresh the installed app in external mode. Replace `~/Applications/Ghost.app` only when its native shell changes; then follow the existing signing/release checks.
- Before cutover, verify the production process/listener/state root, make a verified consistent backup and retain the previous release. Wait for active conversations and work to become idle; do not interrupt them or run a second Host against the production root. If it cannot become idle, leave the verified release staged and report that blocker. Check health, runtime readiness, preserved state and the changed installed UI afterward using the owner API, not `ghost doctor` against production. On failure, restore the previous release link only when stored formats remain backward-readable; destructive data/credential restoration or migration still requires separate owner approval.
- A remote Git push failure does not prevent a verified local production update. Preserve the local commit and rollback artifacts, complete reachable deployment work, and report the unsynced commit/blocker explicitly. This authorization is for verified releases, not a watcher that installs unverified edits.
- If the installed app window is inaccessible in the current Space, do not force it forward. Complete safe Host/UI deployment, verify the owner API and served UI, and report the remaining native interaction-verification limit separately.

## Durable user documents

- The Ghost document plane is PDC 2. New documents use `pdc-markdown/1` by default or `pdc-html/1` when authored HTML structure matters.
- Before changing durable document storage, discovery, parsing, rendering, linking, editing, indexing, or migration, read the personal `portable-document-contract` skill and follow [the Ghost PDC adoption plan](docs/pdc-adoption.md).
- PDC 1 Djot and HTML remain readable legacy inputs. Do not rewrite them in place or bulk-convert any existing document. Migration requires a separate target, verified backup, a loss report, and explicit owner approval.
- Repository documentation, prompts, logs, generated previews, and database-only records are outside PDC unless explicitly promoted into the shared document plane.
