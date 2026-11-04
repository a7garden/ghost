# Work memory and generated experience

The Host pins explicit shared read grants at Work admission. No bot identity,
definition, skill, task text, or model argument grants engine authority. A definition
may select only an exact, already Owner-configured profile. The existing
scoped Oxibrain adapter and document writer remain the memory and document owners.

An authenticated Owner selects `work.memory.profile.configure` with `ghost_id`,
`binding_ids`, `required`, and optional `experience_space_id`. The command uses
`expected_revision: null` for the first profile and the previous profile revision
for an update. Only configured `shared` read bindings may be selected. Profile
updates affect future Work that uses the current-head compatibility path. A Work
with a pinned bot definition resolves that definition's exact memory-profile
revision and digest, even after the profile head changes. Admission and owner/Goal
revision changes snapshot the selection in the same journal transaction. Inspect/dispatch never fill
an old missing pin. A compatibility `work.memory.bind` can bind only a queued
Work with no committed assignment and no execution. It cannot modify an already
published assignment.

A required missing or revoked grant blocks before inference and before effects.
An optional absent grant exposes no memory tools and ordinary Work continues.
Configured Work memory raises assignment privacy to at least private before
provider selection. Protected Work needs the accepted local model and computer
route. Delegated children keep only bindings whose complete space set is inside
the parent's pinned read set. Memory-derived delegation also requires the target's
independent Owner-selected read profile to cover every parent source space; a
missing profile blocks delegation. Such a child requires fresh authentication
before inference even when its configured profile was optional. Parent permission/revocation is rechecked through
bounded ancestry; delegation supplies no document write destination.

The Pi-only callbacks are `work.memory.context.inspect`, `work.memory.recall`,
and `work.memory.record`. Host derives the exact Goal and owner revision from the
authenticated assignment, Work, and committed source. Runtime supplies the outer
Ghost/conversation/assignment/Work identities, never the model. Recall accepts
`query` and optional total `token_budget` from 128 through 2048. It queries only
the pinned shared bindings, preserves original per-source evidence, and never
falls back to the Ghost's personal memory. All bindings authenticate freshly
before and after result delivery.

The runtime keeps separate Work context provenance. Required admission and every
successful recall persist an immutable Host lineage stamp. Memory-derived direct
effects and completion must carry the original `work_memory_context_revision`
outside model arguments. Fresh engine authentication and a writer-lock check run
before admission and receipt replay. Work delegation, waits, and Pi admission use
the same outer stamp guard before coordination changes or cached receipt replay.
A revoke never rewrites a prior effect
receipt or invents rollback. Host-generated result reports omit producer prose
when this lineage exists, so a fresh Owner/report turn cannot regain Work source
bytes by reading a copied summary.

## Immutable definition profiles and future bot planning

Profile configuration returns `profile_ref` with the exact Ghost UUID as
`namespace`, `id: "work-memory"`, positive `revision`, and the canonical metadata
`digest`. Configuration archives both prior and new revisions in the existing
Host journal; it does not copy credentials or create a Space. The Owner-only,
uncached `work.memory.profile.inspect` read takes `ghost_id` and returns the
current reference, required flag and bounded counts. Historical references never
resolve an unrelated or later head. A pre-history head can be read only when its
exact revision and digest match; inspection performs no migration.

A new bot can declare this reference in Owner `bot.prepare` content. Before
preparation, Owner `bot.creation.plan` takes `creation_command_id` and returns
only the deterministic candidate, Ghost and conversation IDs. It writes no
reservation, profile, permission or command receipt. An Owner can configure
future metadata with `work.memory.profile.configure`, the planned `ghost_id` and
optional `creation_command_id`. This records an immutable selection for that
same Owner creation command and rejects a conflicting reservation. Selected
shared bindings must already exist in the scoped adapter configuration. The
future Ghost's memory policy stays default-denied; a model cannot select this
field, create a grant, or inherit the source Ghost's personal memory.

Normal provisioning creates the profile and native home and receives the exact
original Pi context ACK. The Owner can then enable memory through the existing
profile policy control. Required memory remains blocked with a specific reason
until the existing scoped adapter authenticates every selected binding. Optional
unavailable memory is explicitly `degraded` and supplies no read permission.
The scoped Owner roster shows declared memory's state and reason.

The existing lifetime driver owns at most one memory-validation continuation,
with a 30-second deadline for its whole bounded batch and a durable per-attempt
cursor. An outstanding authentication never blocks normal dispatch. Shutdown
aborts and awaits it. Authentication runs outside the journal writer; callbacks
and receipt commit recheck the candidate, epoch, dispatch state, policy and
binding configuration. Canceled/retired or replaced candidates cannot acquire a
new proof. Current proofs refresh at most every 30 seconds; a metadata, policy,
epoch or eligibility change invalidates them immediately. This receipt records
the last successful authentication, not a lease across engines. Every required
Work inference, source delivery and effect still performs the existing fresh
engine checks, including revocation without a configuration change.

Component tests exercise this complete Owner path with a controlled scoped
engine protocol fixture and a real local Pi ACK, immutable v1 selection after a
v2 head, revoked/expired authentication, policy changes during authentication,
optional degraded state and full-batch hang fairness. They do not claim a native
Oxibrain composite restore into a new root. That requires the existing recovery
bundle, coordinated Oxibrain backup and explicit post-restore reauthorization.

## Experience outbox

Record accepts `summary` (1–16384 UTF-8 bytes), `limitations` (up to 8192 bytes),
and 1–8 unique current `artifact_digests`. A writable Space private to exactly the
Work owner must already be explicitly selected in the pinned profile. Model
arguments cannot select the destination, author, trust, source, or permission.
Only artifacts actually published by this exact Pi execution are eligible.

The journal freezes one candidate per exact Work revision/owner revision/attempt.
Same-ID retries and a new call after a lost ACK recover the original UUID; a
changed candidate is rejected for reconciliation. The existing lifetime driver
processes one due entry per pass with bounded retries and a 30-second driver
timeout. Cancellation retains the durable attempt and planned source; the next
due run reconciles the same UUID and bytes before any retry. It waits for independent
Work acceptance and retains the accepted artifact, verifies published source
bytes, then freezes readable generated prose, Host-derived author/Work/Goal/
attempt/artifact references and verification outcome. The exact UUIDv7, timestamp,
PDC Markdown source and SHA-256 are durable before the atomic document write.

The writer rechecks the full epoch, dispatch, accepted attempt, original memory
stamp, grant, and private destination under the same writer lock as filesystem
creation. Identical bytes recover a lost ACK; different existing bytes become a
conflict and are never overwritten. Index confirmation uses Oxibrain's scoped native `document_source.inspect` read
on the existing documents plane. It requires the frozen raw SHA-256, exact
canonical destination file, source revision, root generation and a fresh bounded
reconcile; matching UUIDs in another root, stale sources or ambiguous roots do
not count. No path metadata enters model context. A missing root/index stays
`written_index_pending`; Host does not register a root, ingest a session, declare
an assertion, or promote generated summaries into episodes.

Owner `work.experience.inspect` accepts `work_id` and returns candidate identities,
states, planned hashes, and retry reasons. A changed authority epoch requires
explicit `work.experience.resume` with `work_id`, `experience_id`, and the current
Goal revision. It preserves original lineage, UUID and frozen bytes/hash while
recording a separate current writer authorization and incrementing its durable
generation. Async writer checkpoints use that generation as a CAS fence, so an
older job cannot overwrite recovery. It cannot revive a revoked
Work grant, expand the destination, or replace an edited file. This is source
implementation, not an installed configuration or a claim of live memory writes.
