# Bot candidate provisioning

The source Host supports a bounded creation path through its authenticated
Owner lifetime control surface and a bounded authenticated conversation intent.
It creates a new persistent Ghost identity;
there is no worker agent, new daemon, credential copy, or private history clone.
The installed release is unchanged.

## Owner commands

All commands use the existing lifetime envelope, authority epoch, payload
digest and exact command receipt. A model callback cannot impersonate Owner.

1. `bot.evaluation_profile.configure` takes `fixtures` with two to eight distinct
   `{id,input,expected_output}` cases and the usual expected revision. These are
   an independently selected Owner test set. The response returns the fixed
   execution and acceptance policy references needed by a definition. Candidate
   requests cannot set fixtures, verifier code or the evaluation profile.
2. `bot.prepare` takes `display_name`, B1 `DefinitionContent` as `content`, and a
   bounded `source_work_ids` list. An instruction/skill reference's namespace is
   its existing source Ghost UUID; the Host resolves the exact active revision
   and immutable bytes from that Ghost's skill store. The candidate seals these
   selected assets, source references, policy, test profile, planned UUID,
   conversation and operation identity. Preparation grants no resources.
3. `bot.evaluate` takes `candidate_id` and `candidate_digest`. It admits a real
   Goal/Work on the Host-selected active primary Ghost. Its prompt contains the
   pinned candidate instruction/skill bytes, new fixture inputs and their canonical
   input digests as transport metadata, while
   expected outputs stay in the Host. The existing Pi execution path produces
   and publishes `bot-evaluation.json`. The Host independently verifies the real
   published bytes against the withheld outputs and fixed current verifier/policy
   before accepting the Work. The Owner acceptance path is also available.
   Assignment inspection verifies the exact generated
   prompt and original Owner receipt, not a model-supplied digest claim.
4. `bot.provision` uses the same candidate references. It verifies the accepted
   artifact's actual bytes and exact held-out outputs, journals the stable
   operation, creates/reopens the planned empty profile, and provisions a
   dedicated native Pi home through the already accepted `pi-default/1` profile.
   It queues one durable `conversation.ensure` command. Repeating this operation
   recovers the same profile, home and runtime command.
5. `bot.activate` uses the same candidate references. It rechecks evaluation,
   current policy/epoch, home route and resource receipts, and waits for the
   actual Pi acknowledgment. Only then does one journal transaction install the
   definition and change the new registry row from draining to active. A failed
   definition pointer write leaves no active registry row.

`bot.candidate.inspect` returns the candidate's definition and current operation
receipts. `bot.discover` accepts `required_capabilities` and returns ready,
currently available bots with purpose and input/output contracts, or `no_fit`.
The existing scoped Pi `registry.inspect` also exposes `ready_bots`; external
model routes receive only public candidate metadata. Credentials, private
memory, source bytes and filesystem locators are excluded from discovery.
New Work admissions pin the same bot's definition and candidate instruction
bytes. Updating a source skill cannot replace an old Work's bytes. Asset
privacy joins the assignment privacy before first inference and tool offer.

## Boundaries

The initial evaluator checks exact expected JSON outputs for independent input
cases, plus the existing independent acceptance checks. It does not claim a
universal semantic quality evaluator. Owner definition lifecycle commands use
this same fixed evaluation and readiness path, as described below.

Memory is optional and explicitly reported as degraded `optional_unbound` when
no profile is declared. Owner definitions may reference an exact immutable
memory-profile revision and digest. Required memory prevents activation until
current policy and live scoped authentication succeed; optional unavailable
memory is explicitly degraded. Owner `bot.creation.plan` supports selecting
future metadata without creating resources or permissions. See
[Work memory](work-memory.md#immutable-definition-profiles-and-future-bot-planning)
for the planning/configuration and validation contract. Creation never copies
an Owner or source Ghost's private bindings. Browser capability is not inherited
by `pi-default/1`. Unsupported capability requirements stay blocked.

A committed authenticated Owner turn matching the bounded direct creation
grammar (for example, `이걸 봇으로 만들어줘`) authorizes only creation under the
issuer Ghost's existing grants. The Host binds the original command digest, exact
source text, turn identity, epoch and create-only request revision to one immutable
candidate. Quoted examples, negation, conditional/future requests and
assistant/tool/retrieved text cannot create this capability. Unsupported wording
is rejected. Model text claiming approval grants no authority.

The model calls `bot_prepare` and `bot_evaluate` for the same Host-issued
candidate. The successful scoped evaluation admission arms completion of that
authenticated create-only request; a separate `bot_activate` call is idempotent
and optional. The Owner evaluation-only API never arms activation. The model
finishes the Owner turn with the truthful pending state. The existing Host driver
rechecks the original uncancelled intent and advances evaluation and provisioning after that
turn releases the Ghost. It does not grant models Owner authority or add another
scheduler. The candidate remains absent from ready discovery until actual
evaluation, home, runtime and registry activation succeed.

## Verification

The module's offline fixtures exercise immutable candidates and independent
verifier selection, real Goal/Work admission and assignment-origin validation,
actual scoped file publication/result/independent Host acceptance, held-out artifact byte
verification, real profile/home creation, a real Node Pi context acknowledgment,
activation rollback, same-ID retry and fixed identity reuse on new Work inputs.
These fixtures do not demonstrate a live model completing the evaluation or
claim product/UI rollout, all B4/B5 acceptance, or deployment.

An ignored opt-in local-model test, `real_local_model_conversation_creates_and_reuses_one_bot_twice`, uses `GHOST_PI_RUN_LIVE_BOT_CANARY=1`, a disposable Host, the explicitly pinned loopback Dyno model and the existing physical container service. Its bridge clears inherited environment credentials and never discovers another provider or installed Host. Passing this fixture is a source canary, not installed product/UI rollout.

On 2026-10-24 the opt-in synthetic conversational canary passed in 124.34 seconds
with 24 calls to the explicitly pinned local Qwen model and no external provider
calls. The actual model prepared and evaluated the candidate from a committed
Owner conversation, the Host independently accepted its held-out artifact, and
real home/runtime readiness preceded activation. Two different subsequent Work
inputs used that same Ghost and immutable candidate, produced fresh artifacts,
and independently passed exact byte verification. Ready discovery and a browser
capability no-fit were also checked. This validates the synthetic creation/reuse
mechanism, not product-comparison quality, autonomous semantic roster selection,
the UI, cold recovery, or an installed rollout.

A prior live candidate was correctly rejected: its generated procedure changed
the requested scalar output into serialized JSON objects. The fixed evaluator
remained unchanged; the successful canary clarified the Owner recipe with a
separate scalar example. Failed candidate and evaluation evidence was preserved.
This is an observed candidate-generation quality limitation. Failed evaluation
marks the operation failed and prevents activation. Failed and ready states now
append one durable Host fact to the original creation conversation.

## Bounded repair

Only the exact failed evaluation's authenticated Work report may receive a
fresh `bot_repair` capability. It names the candidate ID/digest, candidate
revision and remaining Host-owned budget. The runtime rechecks it before every
callback and never persists it as authority. Owner and assignment turns do not
offer this tool; reports still have no general Owner creation or mutation tools.

`bot.repair` accepts that bound report ID and only candidate ID, digest and
replacement instruction text. The Host derives everything else from the
original authenticated create-only intent. At most two repairs are allowed.
Each produces a new immutable candidate and evaluation Work while retaining
the same planned Ghost, profile, conversation and provisioning operation. It
preserves the original contracts, capabilities, source scope, privacy, skill
assets, evaluator and verification policy. A repair cannot add memory bindings,
credentials, browser access or other grants. Old failures and Work pins remain
readable. Cancelled intent removes current repair authority without erasing the
immutable historical report.

Offline Host tests exercise failed output publication, visible failure,
same-ID/reopen receipts, superseded and forged report rejection, cancellation,
the two-repair limit, and independently accepted repair followed by real Pi
context readiness and one active registry identity. Pi Harness tests exercise
report-only exposure, live revocation before callback and no authority revival
on reopen. A real local model repairing a failed candidate has not yet been
demonstrated by this repair test slice.


## Owner lifecycle and scoped status

`bot.update.prepare` takes `ghost_id`, the exact selected `definition_ref`
(`ghost_id`, `revision`, `digest`), and replacement `instructions`. It preserves
identity, contracts, capabilities, source scope, and other pinned assets. The
Host admits real evaluation Work under the current fixed profile; the selected
definition changes only after independent acceptance and actual current native
and Pi runtime readiness. The pointer switch compares the original revision.
Concurrent candidates cannot overwrite a revision accepted in the meantime.
Existing Work retains its original immutable definition and asset bytes.

`bot.clone.prepare` takes the same exact source reference and `display_name`.
It creates one stable new identity, profile, home and conversation through the
same evaluation/provisioning path. It copies only the explicitly selected
immutable definition assets. It does not clone conversation history,
credentials, memory bindings or source Work references. Required memory remains
blocked until separately authorized exact provisioning is available. Both
commands require actual authenticated Owner envelopes; model callbacks have no
corresponding Owner authority. Lost acknowledgments and journal reopen replay
the original candidate and evaluation receipt.

`bot.lifecycle.inspect` takes `ghost_id`. Its `revision` is informational;
`expected_revision` is the exact nullable CAS value for `bot.lifecycle.set`.
The first state has `expected_revision: null`; later states return a positive
revision. `bot.lifecycle.set` takes `ghost_id` and `mode` (`active`, `paused`,
`retired`), with that CAS value in the outer envelope. Pause denies new Work
admissions and the first execution of queued Work. Already bound Work continues
under its existing permissions. Resume requires a current revision; retirement
cannot be reversed through the ordinary active toggle. None of these states
erases identity, selected definitions, pinned Work, published artifacts or
historical results. The registry's transport mode remains separate.

`bot.surface.inspect` takes exactly `ghost_id` and `conversation_id` for the
selected registered Owner conversation. This is an uncached, authority-guarded
read that remains available with dispatch disabled. It returns per-source-turn
candidate operations and a roster limited to that exact source pair and the
selected identity, including paused/retired metadata. It never returns a global
roster, instruction bytes, credentials or private history. At most the newest
128 candidate records are projected, with explicit `truncated` status. Each
roster row has its exact selected `definition_ref`, `lifecycle_revision`, and
nullable `lifecycle_expected_revision`. `admission_allowed` joins selected
independently evaluated definition, current epoch/policy, lifecycle state and
actual native home availability. Provider credentials and consent remain checked
before model calls; this status does not fabricate a model credential probe.

Offline lifecycle tests use actual scoped effects, independent evaluation and
real Node Pi context acknowledgments. They check update CAS and old Work pins,
concurrent update rejection, clone retry/reopen without credential/history
copying, pause/resume/retire admission boundaries, and fresh selected-source
status while dispatch is off. These tests do not establish live-model update,
clone, or repair quality, nor an installed rollout.

Accepted immutable definition/evaluation evidence survives a Host authority epoch
change when the verifier and policy remain exact. Its original creation epoch
is retained as history, not reused as execution capability. Current Host,
callback, home binding and privacy checks still fence stale execution. The
reopen regression explicitly accepts the real registry's next epoch with CAS,
reopens the same journal/home, denies old callbacks, and executes fresh Work
under the current authority; a policy change removes readiness. It adds no
production automatic home rebind or permission change.
