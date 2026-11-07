# Ghost repository guidance

## Execution architecture

Every Ghost is the same kind of independently identifiable, durable bot. One Ghost is the default entry point; it has no other special capability. Since 2026-11-07 the host is one Bun/TypeScript process (`apps/ghost-host`) that runs every conversation in-process on Pi Durable; read [the architecture](docs/architecture.md) before changing it and keep its principles: every wake is a deterministic-id submission, effects are journaled before I/O and never replayed, capability comes from the conversation kind, reads are not journaled. The production Mac runs it since 2026-11-07; [local operations](docs/local-operations.md) records the installed release and the rollback path.

The native iPhone app must support direct conversation, delegation, approval, results and reconnect without Telegram, Slack or another messenger. Device grants remain explicit and scoped to the reviewed Ghost/conversation pairs.

## Product scope

See [current goals and scope](docs/current-priorities.md) for the product entry point and remaining acceptance boundaries. Dated migration plans are historical evidence, not an independent backlog.

Use **맡긴 일** for work assigned to Ghost. Keep execution time limits, durable scheduling, work resumption, and completion notifications. There is no personal planner or calendar.

## Local operations

- Use the canonical checkout at `~/Workspace/Projects/ghost` and integrate verified changes into `main`. Use temporary worktrees for isolation and consolidate or archive them after verification.
- Keep one operating Host for the production state root. The installed desktop app uses external Host mode. Development and tests always use a separate state root (`GHOST_ROOT`) and port; the host refuses to open a pre-Bun state root in place.
- Before operating on a process, verify its path, listener, and state root. Close test apps and their servers when done. See [local operations](docs/local-operations.md) for checks and recovery.

## Durable user documents

- The Ghost document plane is PDC 2. New documents use `pdc-markdown/1` by default or `pdc-html/1` when authored HTML structure matters.
- Before changing durable document storage, discovery, parsing, rendering, linking, editing, indexing, or migration, read the personal `portable-document-contract` skill and follow [the Ghost PDC adoption plan](docs/pdc-adoption.md).
- PDC 1 Djot and HTML remain readable legacy inputs. Do not rewrite them in place or bulk-convert any existing document. Migration requires a separate target, verified backup, a loss report, and explicit owner approval.
- Repository documentation, prompts, logs, generated previews, and database-only records are outside PDC unless explicitly promoted into the shared document plane.
