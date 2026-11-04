# Owner-approved source views

Ghost uses Oxibrain source-view publication for selected excerpts and re-citation.
The normal common-memory binding stays Read-only. Publication requires a separate
explicit Host capability and an authenticated Owner command for the exact source,
selected bytes, range, and destination. Pi tools cannot publish or supply tokens.

Set `GHOST_BRAIN_PUBLICATIONS` to a regular JSON file of at most 64 KiB:

```json
{
  "version": 1,
  "capabilities": [{
    "id": "publish-to-common",
    "ghost_id": "registered-ghost-id",
    "origin_space": "own-space",
    "destination_space": "common",
    "origin_token_env": "PUBLICATION_ORIGIN_READ",
    "destination_token_env": "PUBLICATION_COMMON_WRITE",
    "policy_revision": 1
  }]
}
```

The two environment handles resolve separate, current credentials. Each token
must cover exactly its named space and capability, with no predicate/entity
filters: origin Read and destination Write. Values stay inside the authenticated
adapter. Requests, receipts, model tools, and diagnostics do not carry them.
The existing engine executable/directory and scoped recipient bindings remain
explicit configuration; publication never creates an implicit Own grant.

Use the existing authenticated `ghost control send --file command.json` Owner
ingress and its versioned command envelope. Every command body contains
`method`, `ghost_id`, and the actual registered `conversation_id`:

| Method | Additional body fields | Expected revision |
| --- | --- | --- |
| `memory.publication.sources` | none | none |
| `memory.publication.prepare` | `capability_id`, opaque `source_ref`, selected UTF-8 `bytes`, `range: {start,end}` | none |
| `memory.publication.commit` | `publication_ref` | prepared intent revision |
| `memory.publication.inspect` | `publication_ref` | none |
| `memory.publication.resume` | `publication_ref` | current unresolved intent revision |
| `memory.publication.withdraw` | original confirmed `publication_ref` | current intent revision |
| `memory.publication.profile.configure` | `references: [{publication_ref,binding_id}]` | current profile revision; absent for first profile |

Source handles bind the exact source revision, engine occurrence, and content
digest. Publication and document handles also bind their actual view revision or
canonical PDC UUID, source digest, and registered locator. A correction requires
a fresh selection. Source discovery is bounded to the selected Ghost and
conversation, its indexed experiences, and explicitly pinned recipient views.
A Ghost with only Shared Read can re-cite an independently accessible parent
view using a separately approved destination capability.

Preparation returns a reviewable intent with the source handle, destination,
range, and selected-byte digest. Commit schedules that immutable intent in the
existing Host lifetime driver. The Host freezes a stable engine occurrence and
request before dispatch. Lost acknowledgements reconcile the same occurrence;
they never create a new ingest or publication. Host SQLite reopen and an engine
backup/restore preserve this relationship. Changed credential handles, values,
or policy block retry until explicitly reconciled; transparent token-rotation
recovery is not supported. Withdrawal needs current destination Write and the
original approved receipt; revoked origin Read does not prevent withdrawal.

Recipients need an independent current Shared Read binding and an Owner-selected
reference profile. Work pins that profile at admission. Pi exposes only
`source_view_list` and `source_view_read`, using opaque references. Returned views
contain audience-safe citations, selected bytes, a view-relative range, revision,
state, and uncertainty. They do not expose the private source root or locator,
and are neither extractable Primary material nor independent supporting evidence.

The Host and durable Pi context retain exact dependencies across continuation,
reopen, and compaction. Current authority and source state are checked before
inference, tool effects, verification, acceptance, and reply/cached-result delivery.
Correction, withdrawal, redaction, or an unverifiable grant blocks reuse. A tool
effect that already completed keeps its original receipt; revoked derived output
is withheld and the effect is not dispatched again. Delegation requires current
target grants and propagates dependencies before child inference and parent wake.

Re-citation preserves the original source family. Source correction redaction
accepts only the original source episode plus engine-proved publication
declarations in the reviewed closure; concurrent copy growth invalidates the
plan. Ordinary extra source episodes remain a blocker. Publication-derived Work
experience candidates keep provenance but remain explicitly blocked from PDC
write/index until the engine supports derived-document lineage. Ordinary Work
experience ingestion is unchanged.

The isolated native integration test exercises actual Oxibrain processes,
separate credentials, two Host Ghost identities, Owner intents, same-occurrence
recovery, and source-view lifecycle. Its file tools use the fixture sandbox, and
it performs no model inference or deployment. It does not establish a deployed
cross-Ghost model acceptance result.
