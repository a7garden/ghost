# Ghost repository guidance

## Execution architecture

Each Ghost is an independently identifiable bot. The master Ghost assigns work to other Ghosts and owns acceptance and reporting. The owner subsequently shelved the proposed migration of all Ghosts to OMP SDK. Pi Durable owns the canonical conversations. On this Mac the installed Host release runs Pi work with the legacy worker agents disabled. Check the actual installed release before making assumptions about the SDK worker path.

## Local operations

- Use the canonical checkout at `~/Workspace/Projects/ghost` and integrate verified changes into `main`. Use temporary worktrees for isolation and consolidate or archive them after verification.
- Keep one operating Host for the production state root. The installed desktop app uses external Host mode. Keep Gateway and local inference attached to that Host. Use a separate state root and loopback ports for fixture runs.
- Before operating on a process, verify its path, listener, and state root. Close test apps and their servers when done. See [local operations](docs/local-operations.md) for checks and recovery.

## Durable user documents

- The Ghost document plane is PDC 2. New documents use `pdc-markdown/1` by default or `pdc-html/1` when authored HTML structure matters.
- Before changing durable document storage, discovery, parsing, rendering, linking, editing, indexing, or migration, read the personal `portable-document-contract` skill and follow [the Ghost PDC adoption plan](docs/pdc-adoption.md).
- PDC 1 Djot and HTML remain readable legacy inputs. Do not rewrite them in place or bulk-convert any existing document. Migration requires a separate target, verified backup, a loss report, and explicit owner approval.
- Repository documentation, prompts, logs, generated previews, and database-only records are outside PDC unless explicitly promoted into the shared document plane.
