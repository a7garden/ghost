# Ghost Portable Document Contract adoption

## Role and data boundary

Ghost reads and writes user-authored documents in owner-selected Spaces. The file
in the Space is canonical; Ghost reviews, indexes, previews, and references it.
Task receipts, proposals, caches, generated previews, and application settings
remain outside the document plane.

## Current implementation

- New documents are written as PDC 2 Markdown (`.md`, `pdc-markdown/1`) by
  default or PDC 2 HTML (`.html`, `pdc-html/1`) when requested.
- The parser reads PDC 2 and PDC 1 Djot/HTML. PDC 1 and unmarked legacy files
  are exposed as read-only source; they are not rendered into a converted
  preview. Write attempts are rejected in the shared adapter, not only disabled
  in a UI.
- Existing canonical PDC 2 edits retain their body profile and use source-hash
  compare-before-replace. New writes initialize `.pdc/vault.json` without
  rewriting existing documents.
- `pdc-markdown/1` previews use Garden's document measure, type scale, semantic
  light/dark palette, and code, quote, and table treatment inside the existing
  empty-sandbox frame. PDC HTML previews keep their authored layout and styles.
  Review drafts and read-only source fallbacks use the compact source treatment
  from Garden's read-only document surface.
- This adopts Garden's presentation contract only. Ghost does not currently use
  `@garden/editor`; source-preserving editing, Garden syntax extensions,
  property projection, embeds, and wiki navigation remain future host work. The
  editor package depends on Garden monorepo workspace packages and is not
  imported across repositories as an unpinned workspace dependency.
- Ghost currently resolves managed assets and `pdc:` document links. This is a
  partial reader, not a claim of full PDC 2 linking, wiki-link, and recovery UI
  conformance.
- The adapter test suite runs the pinned shared conformance corpus
  (`pdc-document-conformance/2`, revision 2) from the canonical
  `portable-document-contract` repository: reader classification and legacy
  readability for every file case, duplicate-document-id set detection, and the
  operation laws Ghost claims — byte-identical no-op writes, metadata patches
  against the shared expected bytes, and `external_change_conflict` on
  compare-before-replace. Mutator cases for PDC 1 sources are asserted as
  Ghost's documented `legacy_document_read_only` refusal, because the Ghost
  mutator role covers canonical PDC 2 bodies only. `pdc-query/1` `.base` files
  are not a claimed Ghost surface; fenced `base` blocks are preserved as
  source. A corpus revision bump fails the suite until the expectations are
  updated with the normative change.

## Lifetime Primary documents

The opt-in lifetime runtime exposes scoped document list/read/review/inspect
tools only on the local inference route and only for Spaces currently granted
to that Ghost. Hosted/public inference does not receive document bodies or
document tools. Retrieved source remains untrusted data.

Proposals bind the real Owner turn, Ghost/conversation, authority epoch and
request digest; no synthetic Task is created. A new page omits `page_id` and
`expected_hash`; an existing-page update supplies the freshly read target ID
and hash. Reading a page as source does not make it an edit target.

Only the existing Owner review/CAS path writes files. The Owner modal identifies
new-page creation versus an existing-page update. Approval rechecks current
Space access, cancellation, epoch, expiry and the target hash; revoked grants
and external edits do not permit overwriting.

The 2026-10-14 isolated real Qwen/Primary/UI smoke declined a mistargeted update,
saved a separate new PDC2 page only after UI approval, refused an actual
concurrent-Owner-edit CAS conflict, and refused saving after the Space grant
was revoked. Receipts live under
`.lifetime-canary/pdc-primary-2026-10-12T153511594Z/ui-*-evidence.json`.
The same original root then cold reopened under the corrected frozen Host with
all four answered turns, eight entries, zero Goals, decisions, grant and file
hashes unchanged. The actual lifetime UI shows one saved and three declined
cards without mutation buttons. Receipt and pixel proof:
`cold-history-fixed-acceptance-v2-20261014.json` and
`ui-document-history-cold-v2-20261014.png` in that same canary.
The prior snapshot omission is preserved in
`cold-reopen-before-history-fix-20261014.json`; this bounded Primary/PDC
acceptance is not production cutover or Google/OAuth acceptance.

## Staged work

1. Keep PDC 2-only new writes and PDC 1 read-only guards across every writer.
2. Keep deleted documents discoverable in the UI and add owner-controlled
   recovery without changing source identity.
3. Complete relative/wiki link resolution, visible parser diagnostics, and
   round-trip preservation against the pinned shared PDC 2 revision 2 corpus.
   Reader classification, legacy readability, duplicate-id sets, lossless
   no-op and metadata patches, and external-change conflicts are pinned by
   the shared corpus suite; link resolution, wiki links, and visible parser
   diagnostics beyond preview annotations remain host work.
4. If migration is needed, create a separate PDC 2 target after a verified
   backup and produce a machine-readable loss report. Replace a source only
   after the owner reviews and explicitly accepts that report.

No existing Space is bulk-converted by this plan.
