# Explicit scoped memory bindings

`GHOST_BRAIN_BINDINGS` optionally names a small regular JSON file owned by the
Host operator. Leaving it unset preserves the scalar owner-to-space map. The
scalar `GHOST_BRAIN_SPACE_MAP` remains the only own-source write destination;
the adapter never infers project/common access or creates a space.

The following example is configuration shape only. It grants nothing until the
operator provides actual scoped credentials and explicitly installs the file.

```json
{
  "version": 1,
  "owners": {
    "01930000-0000-7000-8000-000000000001": [
      {
        "id": "own",
        "grant_ref": "own-source",
        "kind": "own",
        "spaces": ["personal"],
        "capabilities": ["read", "ingest", "redact"],
        "policy_revision": 1
      },
      {
        "id": "project",
        "grant_ref": "project-read",
        "kind": "shared",
        "spaces": ["project"],
        "capabilities": ["read"],
        "policy_revision": 1
      }
    ]
  },
  "grants": {
    "own-source": "GHOST_BRAIN_TOKEN_OWN",
    "project-read": "GHOST_BRAIN_TOKEN_PROJECT_READ"
  }
}
```

Grant values name Host environment variables; token bytes never appear in this
file, model arguments, discovery responses or policy stamps. Own contribution
and shared read bindings require distinct credentials. Shared bindings accept
only Read; own bindings must contain exactly the scalar mapped own space.
Unknown fields, duplicate owner/grant keys, ambiguous spaces and invalid policy
revisions are rejected. At most eight bindings and eight spaces are admitted per
Ghost; the file is bounded to 64 KiB.

Every explicit binding authenticates a fresh caller-owned Oxibrain session.
Its complete non-secret authenticated Scope must exactly match the configured
capability set and visible space IDs. Admin, Sample and TrustedIngest cannot
hide behind a read-only `tools/list`. Servers omitting Scope metadata are refused
for this optional integration. The existing legacy scalar path does not require
the new metadata. No engine or live store is upgraded merely by this code.

Reads run sequentially under the existing adapter lock. They split the total
recall token budget and search/session result limits across spaces, preserve
each engine response and its freshness/partial metadata, and retain scoped
evidence reference, revision, view, range and uncertainty. Ranks from separate
spaces are never compared. A failed scope is reported as partial; a changed or
revoked authority after successful retrieval withholds the result. Responses are
bounded without silently truncating source evidence.

Own-source writes use the existing Host source occurrence ledger and the own
binding's Ingest grant. Correction additionally requires Redact. Shared read
sessions never perform these operations. Configured sessions are discarded
after operations and successful results are reauthenticated before delivery.
If a write's authority can no longer be verified, its original receipt becomes
an unresolved result for the caller; the adapter never claims rollback or
re-ingests it under another source ID.

## Context and reply provenance

Authenticated `memory.context.inspect` returns an opaque `context_revision`
and `memory_permitted`. Its stamp binds Ghost, Host authority, disclosure,
current memory permission, configured binding revisions and private credential
fingerprints. A permitted context inspection freshly authenticates all exact
bindings, so engine token revocation is visible even when configuration is
unchanged. The current permission result remains inspectable after revocation.

Memory capabilities and successful tool results carry the same Host stamp.
The Host records metadata-only per-turn lineage in its existing workspace
journal before returning memory results. A memory-derived `conversation.reply`
must carry `memory_context_revision`; the Host revalidates it before cached
command-receipt replay and again under the writer lock before projection.
Unstamped ordinary turns retain their existing callback shape. Revocation does
not erase an earlier reply receipt or undo an already admitted memory write.

Pi owns persistent source/derived-context tracking, compaction refusal and
discarding contaminated history before a later clean Owner turn. These Host
checks alone do not establish that Pi context has been invalidated. Work-scoped
memory, generated experience documents and source-view publication are separate
B3/B6 work; this integration grants no Owner memory to specialist assignments.

Synthetic stdio tests cover scoped markers and full evidence, total budgets,
partial failures, own-write occurrence idempotency, shared-write refusal,
hidden capability refusal, token/config revocation and guarded reply replay.
Operational installation, real private-memory/provider acceptance and cold
restoration of the entire product remain separate acceptance evidence.
