# Private controller and watchdog checkpoint — 2026-10-02

Ghost now connects the pinned actual OxiBrowser private controller to its fixture-only host. New actual local-child tests validate handoff, host fixture actions, all-tab resume barriers and independent watchdog/recovery. This is a library fixture checkpoint; there is no user UI, production approval path, real human input or Ghosts v1 release. [ADR](adr-007-browser-private-control.md), [runtime/source pin](evidence/handoff-pin.json).

## Implemented boundary

The new src/browser/handoff.rs module requires browser-handoff-fixtures (which implies browser-local-e2e/browser-fixtures and optional cached libc). browser_control_fixture grants are separate from fake and old real-local grants. Bind profile/session/anchor task/operations, executable SHA/path and exact loopback origin. The anchor is explicitly a queued fixture-only task binding; a production workflow/lease dispatcher is not implemented. If its status changes, the watchdog stops this child.

Create an anonymous AF_UNIX socketpair. Only the child endpoint loses CLOEXEC in pre_exec; the parent immediately drops that endpoint after spawn. The host endpoint is private, cannot be serialized, supplied through BrowserCommand or obtained from a page/model response. A trusted owner-bound fixture control object authorizes handoff/resume/fixture actions. That API distinction is not human authentication, and it does not isolate another process with the same OS privileges.

Separate bounded reader threads continuously drain agent stdout and the private control FD, including during human_owned. Exact JSON-RPC IDs, session/task/controlEpoch and Rust hostState bindings are checked. Agent activity tasks retain their separate canonical task/effect/outbox lineage while child metadata binds to the anchor. Control/activity intents and admitted phase/epoch are saved before bytes; activity success commits canonical effect/task/outbox plus controller receipt/state in the same SQLite transaction. Control transitions commit receipt/state together. Pending agent completion settles before applying a handoff acknowledgement, even if its FD acknowledgement is dequeued first.

All agent mutation and observation are blocked while pausing/human_owned. Resume clears every ref, tracks fresh observations of each open tab, and releases only after all successful snapshots; a new empty inventory releases the zero-tab case. Old agent receipts cannot cross epochs; an identical historical host ACK returns old data without changing current state. Changed IDs and reused handoff IDs fail before dispatch. Status projection comes from current validated host state, never a historical receipt or page text.

An independent watcher holds only the actual owned Child handle and a read-only SQLite policy connection. It watches deadlines/cancellation, EOF/queue failure, exact grant revocation and anchor status without requiring host tick calls. No attach or signal by historical PID. Kill/reap is attempted independently, bounded to 500ms; host reader joins have a shared 1s budget. Without confirmed reap, the active child ledger stays set and refuses fresh launch/reconciliation. Shutdown/error makes pending work uncertain and blocks restart; missing DB writes are errors, never synthetic success. Reopen closes stale ownership, marks pending control uncertain and uses canonical effect/outbox recovery. Only explicit trusted do_not_replay acknowledgement can admit a new empty child. No old effect, FD, tab or resume authority is restored.

The real children retain the selected-Mac per-origin sandbox: deny network except the exact fixture port, deny listed credential/global configuration directories and Projects writes. The policy file now remains until this owned process ends, avoiding a spawn/open race. The real test hosts use clean environments rather than an additional outer sandbox, because macOS rejects different nested policies. Existing regressions retain their configuration/public-network sandbox. Other filesystem reads remain allowed; this is not a portable or complete filesystem sandbox. No persistent security setting changes.

## Actual acceptance

Fourteen cases in tests/browser_handoff.rs run against the actual pinned CLI, not a mock controller:

- Handoff/host fixture fill and click/resume across two tabs; synthetic human_input=false; all-tab barrier, old refs after fresh observation and old epoch receipts denied.
- Historical duplicate ACKs across later handoffs never roll epoch back; changed payload/reused handoff ID denied; zero-tab inventory barrier.
- Held HTTP navigation during pause, pending identical duplicate and agent admission denied; wait on host FD still drains/settles agent output before transfer.
- Held host fixture operation prevents early resume/second operation and shares one effect for identical duplicate.
- Independent host watchdog with 200ms budget stops the actual child whose wire deadline is deliberately 30s; no host polling required; old UNKNOWN never replayed after manual fresh launch.
- Cancellation stops only the owned child and leaves the second Ghost usable.
- Private control EOF, idle and pending, fails closed.
- Owned actual browser crash and fresh scope after explicit reconciliation preserve uncertain effect and reject old handles/requests.
- Grant revocation, idle human ownership and pending handoff, is enforced independently without host ticks.
- An actual response with injected expired admission deadline is rejected as late; it never commits success. This is deadline fault injection, not a fabricated browser response.
- Cross-Ghost trusted control/anchor/grant/handle denial, strict page command input and page approval/epoch strings remaining untrusted.
- Final controller and activity commit failures roll back success and leave one uncertain task/effect/outbox where applicable.
- A separate actual host subprocess is killed after durable activity/handoff intent and a held HTTP request; reopened state is closed/uncertain, with one recovery outbox and no retransmission.
- Control phase persistence failure before bytes stops the child and reconciles ownership to closed; no pending ownership success survives.

Finite loopback fixtures use explicit held/released condition-variable gates for races. Polls only check watchdog completion and bounded helper readiness. At most two temporary owned browsers; no unrelated service/browser process was controlled.

## Final verification

| Configuration | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| default | 47 | 0 | 0 |
| browser-handoff-fixtures | 91 = prior 77 + new 14 | 0 | 0 |
| oxicode-engine,native-fixtures,browser-handoff-fixtures | 110 = prior 96 + new 14 | 0 | 0 |
| cargo fmt --check / default offline build | passed | — | — |
| base cleared-environment standalone CLI smoke | passed | — | — |

All builds are offline -j1 and all test binaries serial. Cargo --no-run supplies executables; [harness](evidence/handoff-run-tests.py) executes them and preserves per-target logs/audits. Fixture targets have zero tests in the default feature-off configuration, with none ignored. Both old and new runtime pins are explicit environment inputs; a missing pin fails, rather than skipping.

No original test case/assertion changed. Original store/provider/collaboration/tools/judge/CLI sources remain byte-preserved. src/browser.rs changes only strict command deserialization, extraction of unchanged per-child sandbox generation and canonical completion transaction helper, and feature-gated controller export. Cargo changes optional libc/feature metadata; no SDK or browser repository change/build. The directory has no Git repository; SHA records supply the preservation evidence.

New default development artifact: dist/ghost-handoff-checkpoint-macos-arm64, Mach-O arm64, 8,880,840 bytes, SHA-256 `90c88a52fa31609ee2c58629978229844280a6e78a7faddc85ca2b27359af2a0`. Dynamic links are macOS libSystem/libiconv only; no Node/Bun/Python/Cargo/browser executable required by this base binary. All five earlier dist binaries are byte-preserved. Cleared-environment standalone smoke passed with two identities, process-to-process persistence, mock delegation/artifact provenance, dedup, cancel and outbox. Actual controlled browsing is a feature-gated library test, not a CLI command in this base artifact. Signing/release/other-platform verification is not run.

## Intermediate failures and remaining scope

An initial relative staging path failed before writing a test file and was corrected. First real launch failed because the ephemeral sandbox file was deleted immediately after spawn, before sandbox-exec opened it; keeping its owned lifecycle fixed launch. Next real flow conservatively became uncertain on browser_tabs: actual tabs are strings, not objects; parser was corrected from the read source contract. The first complete new suite passed 12/13 and caught internally tagged Serde unit variants silently ignoring extra fields despite deny_unknown_fields. Explicit whole-map validation now rejects extra fields for every command. Existing serialization is preserved. Failed logs and final passes remain evidence; no permission policy or failed assertion was relaxed. Review also added the before-bytes persistence fault case.

The fixed controlled runtime is SHA-256 065c1b7413246a0f1afba41ab3be088c048df352bdf72680f5cf98bc1b5e9f9e (238,655,704 bytes), separate from the prior actual-E2E pin. Runtime copy/source hashes are checked independently; exact binary-to-source build correspondence is not established. Upstream's 138 selected tests are reported evidence and were not rerun or counted here. No wire/contract change was needed from the browser team.

Not run: real user confirmation or UI approval, human viewer/OS input, actual websites/login/cookies/credentials/providers, signing/release/other OS, production supervisor/lease integration. scriptsFrozen/networkFrozen remain false; background scripts/network can continue. Fixture controls and test fault methods are absent from the default artifact. The SHA cache and selected-Mac filesystem containment retain ADR-006 limits. This unit does not establish authenticated production control or script/network freeze.

Next bounded unit is a host-owned UI around this tested state machine, with actual trusted local input validation, current-state rendering and the continuing scripts/network indicator. Live provider/credential and packaging work remain separate; Cassette/oxibrain/Knock/FARM/judge backlog is unchanged. No current-unit blocker remains after final verification.

No additional OMP/provider calls, secrets reads/copies, external account/share/deploy, Git remote/push/PR/merge, persistent access/security changes or other project writes. Configured model record remains gpt-6.1-sol; effective turn model is not independently verified. No capacity failure, Astra fallback or duplicate model task.
