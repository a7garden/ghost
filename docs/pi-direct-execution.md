# Direct Pi execution

Source implementation, 2026-10-24. This document does not describe an installed service cutover.

The optional [versioned producer profiles](producer-profiles.md) add Owner-accepted
JSON runtime facts and immutable per-Work environment pins. Existing configurations
retain the legacy producer policy.

The canonical assignment runs in the assigned Ghost's Pi GenerationTask. `read`, `write`, `edit`, `bash`, `publish_artifact`, and an explicitly accepted scoped browser call the Host directly. The Host does not submit a second model task or start an OMP agent.

For an Apple-container Work that advertises `coding_tools: pi-durable/1`,
ordinary file and shell calls use the pinned Pi coding handlers. Their execution
environment calls the existing Host authority and Work sandbox. Pi selects lines
from a bounded Host snapshot and computes text edits. The Host checks the
source digest at write time and applies the change atomically. JSON summaries,
sealed commands, publication and browser approval use the Host contracts.
Earlier Host offers continue to use their original tool path.

## Environment

An operator-selected private JSON file is selected with `GHOST_PI_COMPUTERS_CONFIG`:

```json
{
  "registry_root": "/absolute/private/computer-registry",
  "container_cli": "/opt/homebrew/bin/container",
  "accepted_capabilities": ["persistent_filesystem", "shell"],
  "routes": [{
    "ghost_id": "existing-ghost-uuid",
    "computer_id": "existing-or-new-computer-id",
    "privacy_classes": ["public"],
    "deadline_ms": 300000
  }]
}
```

The Pi configuration has no OMP package, runner, model shim, or worker socket. It cannot be enabled together with `GHOST_LIFETIME_NATIVE_WORKERS_CONFIG`. The existing registry backend identity remains a historical storage key so home ownership, privacy provenance, authority epochs, and process/collection leases remain enforceable. Previously registered worker origins remain available for historical artifact reads and cleanup.

The Apple container backend uses its existing pinned Ubuntu image. A shell sees only the exact Work snapshot mounted at `/workspace`, a read-only guest root, no DNS, and network `none`; it does not mount the Host home, credentials, browser profile, or persistent Ghost home. File tools use canonical task paths and no-follow descriptor operations. Ordinary write/read content is bounded at 64 KiB; publication and staged artifact inputs are bounded at 1 MiB. This initial environment is a task snapshot capability, not general access to the owner's repositories.

Optional `browser` configuration uses the existing owned-browser format and explicit browser/human-control acceptance. Public profiles enforce per-request public network confinement; declared private profiles require protected route classes and local Pi inference. Browser operations carry the exact Work execution lease and use a distinct per-Work profile below the accepted registry profile. A different authoritative writer is refused rather than stopped. Work completion stops its exact browser session before releasing its home lease. Every profile belongs to one Work execution.

Bot provisioning may select only `pi-default/1`, inherited from the issuing Ghost's already accepted Pi route. The Host derives a deterministic fresh computer identity and home from the new Ghost UUID. It inherits neither a browser grant nor a broader privacy class. Provisioning runs outside the Host transaction, journals the exact route, and verifies the same binding on retry/reopen.

## Binding and effects

Schemas 15–16 add `lifetime_pi_executions` and `lifetime_pi_effects`. A Work binds to its Ghost, canonical assignment, Pi GenerationTask, current authority epoch, computer, privacy, skill refs, child artifact snapshot, and deadline. Existing Work execution handles, including unresolved legacy attempts, cannot be admitted into Pi again.

`work.execute` accepts only assignment/work identities, generation/task/call identities, operation/arguments, and their canonical input digest. Ghost and conversation identity come from the authenticated callback scope. The Host derives the execution ID and filesystem root. A successful response contains a matching receipt with all those identities and the observed result.

The receipt is committed as `pending` before external I/O. Reusing an identity with different bytes conflicts. A completed call returns its original response. Any pending or unknown effect blocks other call IDs in that execution, including after database reopen; an unknown shell effect is never rerun just because Pi restored a checkpoint. Errors distinguish known stopped/not-started process states when that evidence is available, without treating process termination as proof that its earlier effects did not occur.

Browser `click`, `type`, `key`, and `scroll` first persist a `waiting_owner` receipt before proposing an exact action. Every mutation requires the observed target ref and snapshot identity; the Owner sees the normalized operation, URL, target role/name, and typed value. The original callback polls the same action identity. Only a known no-effect wait can resume, after current authority/epoch, Work, privacy, computer lease, memory lineage, and live DOM target checks. The Host commits `pending` before consuming the approval and issuing the raw effect. A crash from that point blocks replay, including after changed call IDs. Denial, stale target, cancellation, or grant withdrawal closes the unexecuted wait with a bound no-effect denial. Waiting time is excluded from the active execution budget. A Host restart that loses its live DOM observation requires a fresh question rather than reusing old target consent.

Current authority, Work currency/cancellation, computer leases, privacy, and deadline are checked before effects; the existing container backend rechecks authorization while a command runs. A completed external effect is recorded before a revoked result is withheld from Pi. Cancellation of Pi Work does not enqueue an OMP control. Unresolved cancellation/effect recovery remains conservative and requires reconciliation before another attempt.

Skills are pinned before assignment inference by Work/requirement/owner revision and loaded from immutable digest-addressed revisions. Child inputs are the current graph's exact accepted artifact refs. The Host reopens and hashes the original immutable artifact store before staging binary bytes under `input-<SHA256(child-work-id)>-<artifact-digest>`. Existing staged input tampering is refused. A latest-by-name lookup is never used.

## Optional JSON read summary

`read` defaults to the existing text view. Use that view for complete input values or raw output values that need inspection. An explicit summary request accepts only `path` and `view`; it cannot be combined with `offset` or `limit`:

```json
{"path":"answer.json","view":"json_summary"}
```

The Host uses the existing read grant and effect scope to read the complete bounded UTF-8 snapshot, up to64 KiB, and computes its full-file digest before text line normalization. The `ghost-json-summary/1` result reports full-file byte count/SHA256, full JSON parse status, bounded type/shape information and an available pinned schema check. Shape output has at most eight entries,48-byte UTF-8 keys and96-byte paths; the summary is bounded at1536 bytes and declares its limits/truncation. It returns no raw scalar values, expected answers or verifier code.

Schema checks use only the exact original Owner-pinned output schema for the declared output path. Bot evaluation instead requires the verified original evaluation origin, candidate/case identity checks and the original candidate source output schema. The original schema root is retained for references. An unavailable schema is reported explicitly; valid parsing or shape/schema agreement does not publish, semantically verify or accept an artifact. `publish_artifact`, completion and independent acceptance remain separate actions.

A known parse or schema failure returns an error with a completed read receipt; it does not create an unknown-effect fence. Replay preserves the recorded result and still checks current authority, cancellation and tampering before delivery. Default text reads, historical receipts, original Goal rendering/input pins, model caps and privacy boundaries retain their existing behavior.

This optional mode has focused source and controlled SDK transport proof. Actual model completion and end-to-end native acceptance are pending; the previous actual A04 trial remains failed.

## Immutable delegation contracts

An authenticated Owner may seal `acceptance_spec.delegation_contracts`, an array of at most eight exact objects with `target_ghost_id`, `prompt`, `acceptance_spec`, and `artifact_refs`. Model-authored Goal text does not issue authority. The Host exposes references in `work.inspect` under `data.delegation_contracts`; each reference binds the current parent Work/owner revision and root Goal revision/requirement digest to those exact bytes.

A model selects `{parent_work_id, contract_ref}` for `work.delegate`. The Host resolves the sealed target, prompt, acceptance specification and artifact refs under its writer lock; the model never copies those bytes back into arguments. Mixed reference/freeform fields, null/forged references, changed revisions, and operations-policy mismatches are refused before admission. Existing graph budgets, privacy, target memory audience and fresh source-authentication gates still apply. Original command retries reuse the original admission receipt. Canonical child inspection verifies the reference's exact committed source.

The independent verifier recognizes the exact Owner-sealed contract only for a reference-backed admission. Freeform delegation remains available with its existing review/explicit-verifier semantics; copying text from a contract does not manufacture reference authority. This avoids making reliable delegation depend on a model reproducing quotes, whitespace, or instruction delimiters.

## Completion and acceptance

`work.execution.complete` checks the original GenerationTask binding and every unresolved effect, independently rehashes publications, and projects the existing `work.result` contract. Completion alone does not accept the Goal.

The narrow deterministic verifier supports Owner-sealed expectations:

```json
{
  "required_checks": ["artifact_sha256", "artifact_content"],
  "verifier": {
    "kind": "pi-artifact/1",
    "artifact_path": "answer.txt",
    "expected_sha256": "64-lowercase-hex-characters"
  }
}
```

The expected digest must originate in a committed authenticated Owner Goal admission/update, not a producer's claim or a model-authored `goal.create`. The evaluator identifies the exact publication path and compares independently reopened bytes with that expectation. Optional `command` and `expected_stdout` require an original successful shell receipt matching the exact command and stdout; they support `command_success` and `command_stdout` checks. Unknown required checks, missing expectations, and mismatches remain completed pending independent review. Hash integrity alone is not semantic acceptance.

A model-delegated child's verifier is authorized only when the current Owner-sealed root specification includes an exact `delegation_verifiers` entry containing `target_ghost_id`, SHA-256 `prompt_digest`, and the same `verifier` object. This prevents a child or its parent model from inventing its own passing expectations. Existing acceptance policy/revision checks and dependency release apply normally. The Owner `work.verify` action can recover deterministic verification after restart; it is outside the Pi model action space.

## Legacy cutover

Both live Host ingress paths retire fresh OMP admission/steering. An exact previously committed Owner receipt is readable without another execution. The driver refuses pending worker submit/steer intents, so an old unacknowledged submission cannot start an OMP process during cutover. Historical command interpretation, result observation, exact process cleanup, journals, receipts, and artifact reads remain compatibility paths. The pure lifetime ledger interpreter is not a live admission surface.

Use the read-only [cutover audit](../scripts/audit-pi-cutover.py) to inventory unresolved legacy execution and outbox state before a separately recorded operational transition. Source changes do not authorize service restart, installed data migration, or deletion.

## Exact verifier command recipe

When the current Work has an Owner-authorized `pi-artifact/1` verifier command, `work.inspect` exposes one `command_recipes` entry named `verifier-command`. `bash` accepts either `{command, timeout?}` or `{command_ref, timeout?}`. The reference selects the original sealed bytes; it does not add a new acceptance-spec language or grant shell authority.

The Host resolves the scoped reference under the admission writer transaction and stores an immutable resolution with the original execution/task/call identity, arguments, and input digest before the pending shell intent. The original reference arguments remain in the effect receipt. Replay revalidates current authority and the exact resolution; unresolved intents remain blocked. Independent verification compares the bound command with the Owner's exact expectation and checks the original observed exit code and stdout. Raw commands remain supported.
