# Ghost repository guidance

## Execution architecture

Each Ghost is an independently identifiable bot. The master Ghost assigns work to other Ghosts and owns acceptance and reporting. The owner subsequently shelved the proposed migration of all Ghosts to OMP SDK. The installed architecture uses Pi Durable for canonical conversations and retains its existing OMP SDK worker path. Finish and verify the current Ghost workflows, and distinguish source capabilities from what is deployed.

## Durable user documents

- The Ghost document plane is PDC 2. New documents use `pdc-markdown/1` by default or `pdc-html/1` when authored HTML structure matters.
- Before changing durable document storage, discovery, parsing, rendering, linking, editing, indexing, or migration, read the personal `portable-document-contract` skill and follow [the Ghost PDC adoption plan](docs/pdc-adoption.md).
- PDC 1 Djot and HTML remain readable legacy inputs. Do not rewrite them in place or bulk-convert any existing document. Migration requires a separate target, verified backup, a loss report, and explicit owner approval.
- Repository documentation, prompts, logs, generated previews, and database-only records are outside PDC unless explicitly promoted into the shared document plane.
