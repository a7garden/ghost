# Pi producer profiles

Ghost executes its own Pi tools. A producer profile selects an Owner-accepted,
digest-pinned guest image; it does not introduce another worker or scheduler.
Omitting the new configuration retains the original Ubuntu producer policy.
The independent verifier continues to use its separately pinned image and
read-only input mount.

## Acceptance and selection

The existing private Pi configuration can contain `accepted_producer_profiles`.
Each entry has `manifest` and `runtime_facts`. The manifest identifies the profile
revision, exact image index and platform manifest, shell and fixed isolation
policy. `image_config_digest` is Owner-declared provenance, not a value observed
from the CLI's decoded image configuration.

`AppleContainerBackend::probe_producer_profile` executes only the fixed JSON and
sandbox probe. Its receipt binds the manifest, probe, CLI executable/version,
UID/GID and typed observation. It checks Python standard-library computation,
nested JSON round trips, non-root identity, a read-only root, Work write/readback,
denied outside writes and loopback-only interfaces. A successful probe is evidence;
the private Owner configuration supplies acceptance. The receipt is not an
attestation against the machine Owner.

A route's optional `producer_profile_ref` selects the accepted
`{namespace, id, revision, digest}`. Models cannot register or select profiles,
images, computers, credentials or network policies. An accepted revision cannot
silently acquire another manifest or receipt. Changed acceptance requires a new
revision.

The exact cached image reference, sole OS/architecture candidate, selected child
digest and platform are checked before execution. Missing or ambiguous cache
entries fail before `container run`. The pinned CLI has no explicit
`--pull=never` option; the cache preflight does not eliminate a concurrent
cache-deletion race. No image-pull or fallback command is introduced.
New producer-profile runs use the CLI's `--progress none` so transport progress
does not pollute probe stderr. Legacy producer and verifier argv remain unchanged;
probe acceptance still requires empty stderr and the exact typed observation.

## Work and recovery

The original assignment transaction seals the accepted profile and acceptance
digest with the Work, assignment, revisions, epoch and execution identity. Its
context reference includes this required pin. The external Pi context descriptor
retains its existing seven-field contract.

Environment observations and producer execution resolve the same original pin.
Later route changes affect new admissions. Historical contexts remain on the
original Ubuntu policy; they are never backfilled from today's selection.
Missing or changed required context, profile or execution bindings fail closed.
Existing effect receipts remain stored; an unresolved effect is not retried under
a different profile.

Provisioned bots store and restore their exact profile reference. Candidate
evaluation must use the candidate's pinned profile. Current grants, cancellation,
deadlines, authority epochs and effect-replay guards still apply.

## Verification

Pure tests cover immutable catalog revisions, old/new admission, missing or
tampered pins, cross-Work access, execution bindings, cancellation, saved child
profiles and descriptor/argv agreement. The fixed probe and generic JSON
publication tests are opt-in physical checks. They do not run model inference.

The generic publication tests require a genuine probe receipt, use the same
program on distinct nested JSON inputs, and pass the resulting artifact through
the unchanged independent verifier. Their controller coordinates are explicitly
controlled test inputs; they do not prove Pi SDK scheduling or A04 bot quality.
Source acceptance is separate from installed-service cutover.

The 2026-10-25 parent verification passed Rust421/421 (28 opt-in ignored),
Pi context regressions12/12, the real fixed probe1/1 and physical JSON tests2/2.
Evidence is infra `.verification/pi-engine-implementation-20261024/json-profile/result.json`.
The initial progress-related probe failures and their bounded diagnosis are retained
there alongside the successful receipt and independent verification results.

The actual A04 fixture also accepts paired
`GHOST_PI_A04_PRODUCER_PROFILE_RECEIPT` and
`GHOST_PI_A04_PRODUCER_PROFILE_SHA256` inputs. Before admitting any Work it
installs private Owner configuration, binds the real workspace, and verifies
the original configuration/profile across cold reopen and all six execution
roles. Neither variable alone is sufficient. Absent both, the historical
fixture keeps its original environment.

Two subsequent actual profile trials failed the historical120s settlement
bound. The first published an offline-matching artifact without Host acceptance;
the second command exited1 with `KeyError: 'content'`. They prove neither a
ready bot nor two successful reuses. The separate functional observation
scenario passed the final source regressions (Node224/224, Rust430/430 and
controller19/19) with a clean13719-file source/runtime/input fence. Its first
actual trial is terminal failed: the seed was independently accepted, but the
candidate evaluation response was truncated and readiness was not established.
The same profile, oracle, effect authority and model/callback/delivery limits
were preserved; no automatic retry is authorized.
