# Temporal memory queries

`memory_search`, `memory_recall`, and `work_memory_recall` accept optional
`as_of`, `known_at`, and `planes`. Ghost forwards them to the existing Oxibrain
query engine; it does not implement another temporal memory store.

- `as_of`: valid time, as an exact signed integer of Unix epoch milliseconds.
- `known_at`: knowledge/transaction time in the same representation. Native
  Oxibrain rejects times later than the request, so Ghost rejects them too.
- `planes`: a unique nonempty selection of `memory` and/or `documents`.

JSON timestamps must be safe integers in −9,007,199,254,740,991 through
9,007,199,254,740,991, within the native signed 64-bit range. Strings, null,
fractions, and rounded numbers are invalid; they never become the current time.
Temporal requests with no explicit plane default to `memory`. Current requests
without a plane keep the engine's existing default. Model tools and the Host
still derive the actual Ghost, Work, spaces, credentials, and disclosure scope.

Document revision reads are a different contract. An explicit temporal request
including `documents`, even alongside `memory`, returns
`unsupported_temporal_scope` for the documents plane. It does not return a
partial current document answer. Malformed scope returns
`invalid_temporal_scope`. The adapter also checks the live native tool schema
before temporal dispatch; an older engine without the supported fields returns
an explicit unsupported result instead of ignoring them.

Successful scoped results preserve each space's native evidence, frontier,
freshness, and partial metadata alongside the requested `query_scope`.
`global_snapshot: false` makes clear that independently queried spaces are not
one atomic global snapshot. Existing current-authentication and disclosure gates
still run before and after queries and before the context is reused.

Retrieval can establish which historical source was returned or that no evidence
was known at a requested time. It does not establish that a model abstains from
an unknown answer; model answer quality remains a separate acceptance check.
