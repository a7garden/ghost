# Ghost repository guidance

## Execution architecture

Every Ghost is the same kind of independently identifiable, durable bot. Pi Durable is built into each Ghost, including direct conversation, work and recovery. One Ghost is selected as the default entry point; it does not have a unique durability tier. The protocol kinds `primary` and `specialist` are existing registry/default-role metadata, not separate runtime capabilities. The owner confirmed this model on 2026-11-04. The owner previously shelved the proposed migration of all Ghosts to OMP SDK. Pi Durable owns the canonical conversations. On this Mac the installed Host release runs Pi work with the legacy worker agents disabled. Check the actual installed release before making assumptions about the SDK worker path.

The native iPhone app must support direct conversation, delegation, approval, results and reconnect without Telegram, Slack or another messenger. Device grants remain explicit and scoped to the reviewed Ghost/conversation pairs.

## Product scope

See [current goals and scope](docs/current-priorities.md) for the product entry point and remaining acceptance boundaries. Dated migration plans are historical evidence, not an independent backlog.

Use **맡긴 일** for work assigned to Ghost. Keep execution time limits, durable scheduling, work resumption, and completion notifications. The desktop no longer offers a personal planner or Google Calendar/Tasks presets. Preserve prior planner records and Host protocol compatibility.

## Local operations

- Use the canonical checkout at `~/Workspace/Projects/ghost` and integrate verified changes into `main`. Use temporary worktrees for isolation and consolidate or archive them after verification.
- Keep one operating Host for the production state root. The installed desktop app uses external Host mode. Keep Gateway and local inference attached to that Host. Use a separate state root and loopback ports for fixture runs.
- Before operating on a process, verify its path, listener, and state root. Close test apps and their servers when done. See [local operations](docs/local-operations.md) for checks and recovery.

## Durable user documents

- The Ghost document plane is PDC 2. New documents use `pdc-markdown/1` by default or `pdc-html/1` when authored HTML structure matters.
- Before changing durable document storage, discovery, parsing, rendering, linking, editing, indexing, or migration, read the personal `portable-document-contract` skill and follow [the Ghost PDC adoption plan](docs/pdc-adoption.md).
- PDC 1 Djot and HTML remain readable legacy inputs. Do not rewrite them in place or bulk-convert any existing document. Migration requires a separate target, verified backup, a loss report, and explicit owner approval.
- Repository documentation, prompts, logs, generated previews, and database-only records are outside PDC unless explicitly promoted into the shared document plane.
