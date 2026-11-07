# Ghost Portable Document Contract adoption

## Role and data boundary

Ghost reads and writes user-authored documents in owner-registered Spaces. The file in the Space is canonical; Ghost lists, reads, previews and proposes edits. Work receipts, proposals, caches, previews and settings stay outside the document plane.

## Current implementation (`apps/ghost-host/src/integrations/documents.ts`)

- New pages are PDC 2 Markdown (`.md`, `pdc-markdown/1`) by default or PDC 2 HTML (`.html`, `pdc-html/1`) when requested.
- The reader classifies PDC 2 and PDC 1 Djot/HTML. PDC 1 and unmarked legacy files are readable and read-only; writes are refused in the adapter (`legacy_document_read_only`), not only in the UI.
- Edits keep the page's body profile and use source-hash compare-before-replace (`external_change_conflict`). Writes go through a temp file and rename; the first write initialises `.pdc/vault.json` without rewriting existing documents.
- Two writers share that path: the owner's `document.save` from the UI, and a Ghost's `document_propose`, which only opens a `document_review` decision. Nothing is written until the owner approves it, and approval re-checks the Space grant and the hash.
- Ghost tools see only Spaces granted to that Ghost, in direct conversations; retrieved text is untrusted data.
- The shared conformance corpus (`pdc-document-conformance/2` revision 2, and the legacy v1 corpus revision 3) is vendored under `apps/ghost-host/test/fixtures/` and run by `test/pdc-corpus.test.ts`; a revision bump fails the suite. `pdc-query/1` `.base` cases are not a claimed Ghost surface and are skipped by id.

## Staged work

1. Keep PDC 2-only new writes and PDC 1 read-only guards across every writer.
2. Owner-controlled recovery of deleted documents without changing source identity.
3. Relative and wiki link resolution, and visible parser diagnostics.
4. Any migration creates a separate PDC 2 target after a verified backup and a machine-readable loss report, and replaces a source only after the owner accepts that report.

No existing Space is bulk-converted.
