# Browser core fake-child checkpoint — 2026-10-02

Bounded core adapter completed against a Rust fake child. Ghosts v1 is not released; actual OxiBrowser execution, real sites, human viewer/freeze and credential access were not tested or enabled. [Contract](adr-005-browser-fixture-host.md), [next local integration scope](browser-core-next.md).

Implemented in `src/browser.rs`; finite child fixture in `tests/fixtures/browser_child.rs`; acceptance in `tests/browser_core.rs`. Cargo adds fixture-only feature/bin plus cached Tokio process/io features, and lib exports the module. No main CLI/provider/core store implementation was changed. This is a library adapter; there is no production browser launch or browser CLI command.

## Verified behavior

- Missing/revoked/session/operation grants stop before spawn or forwarding; no child environment inheritance, separate process handles and UUID scopes for two Ghosts, one owner per session. Shutting one child does not terminate another Ghost's child.
- Persist task/effect/request intent before stdin; exact receipt/correlation/content validation; explicit tab/latest snapshot ref handling; stale, closed, cross-tab and cross-child refs rejected before bytes. Reobserve after an action.
- Durable identical request replay emits no effect; changed ID payload fails. New request ID cannot rerun an attempted task. Cancellation/timeout/crash/EOF/forged or oversized responses/mayHaveActed produce uncertain and terminate only the owned child. Late replies cannot complete another task.
- Cancelled/unknown sessions cannot spawn again without separately trusted reconciliation. Explicit fixture reconciliation records do_not_replay and preserves old uncertain effects; fresh child has new scope and no old refs. Actual host subprocess kill recovers a pending intent and outbox without PID attach/replay.
- Fault injection validates atomic intent and terminal task/effect/receipt/outbox commits, including effect update count mismatch. Page approval/user/resume strings remain untrusted result data and cannot enter the trusted control route. Fixture handoff closes the child and suspends admissions; it is not human_owned or a frozen-page viewer.

## Actual tests and artifact

All Cargo builds were offline `-j1`; test binaries ran serially in temporary macOS sandbox profiles denying global Codex/MCP/engine configuration and credential environment inheritance. The default/fake-child profile denies all network. Combined profile allows loopback for existing native HTTP fixtures only and proves public network denial with an EPERM documentation-address guard. Nothing changes persistent security settings.

| Configuration | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| default | 47 | 0 | 0 |
| browser-fixtures | 68 = existing 47 + browser 21 | 0 | 0 |
| oxicode-engine,native-fixtures,browser-fixtures | 87 = existing 66 + browser 21 | 0 | 0 |
| cargo fmt --check | passed | — | — |
| default offline build | passed | — | — |
| cleared-environment standalone CLI smoke | passed | — | — |

All existing 43/44 core/SDK and 18 native HTTP cases ran in the applicable configurations, with no case skipped. Default browser/native fixture targets intentionally contain zero tests because fixture constructors are absent. Standalone smoke verifies the original profile/collaboration/dedup/cancel/receipt CLI across fresh processes; browser execution is verified by the feature-gated fake-child tests, not a new default CLI command.

Development artifact: `dist/ghost-browser-core-macos-arm64`, Mach-O arm64, 8,880,840 bytes, SHA-256 `b62923eb08ccee6192dc167da5c9044a6d33dd28e9351f1bf277f53962988a05`. Only macOS libSystem/libiconv dynamic links; no Node/Bun/Python/Cargo or fixture executable required to run the default artifact. All previous dist binaries remain byte-preserved. No signing/notarization or other-platform verification.

## Intermediate failures and precise fixes

The initial 20 browser tests passed. Review added exact effect update count checking and its fault case. The first SDK combination then passed 20/21 browser tests but failed an overly strict expectation of no child environment keys: macOS frameworks add __CF_USER_TEXT_ENCODING even after env_clear. The test now injects a public parent sentinel, verifies it/HOME/PATH/auth/config keys are absent, and permits only that OS runtime key on macOS. No inheritance filter or product boundary was weakened.

Native tests were not initially modified. Subsequent full combinations intermittently failed native permission, limit-category or captured-request assertions, although the isolated permission recheck passed. A guessed half-close/read-timeout change did not fix it and was reverted. A finite loopback Rust probe proved the selected macOS accepted socket remained nonblocking after a nonblocking listener accept: first read returned WouldBlock in 0 ms despite a read timeout; explicitly setting blocking made the read succeed. The existing fixture had treated that WouldBlock as EOF and could respond to an incomplete/empty request. The final native helper change is exactly a comment plus `stream.set_nonblocking(false)` on accept. All 18 cases/assertions and every provider source byte remain unchanged. The final full 87-test run passed. Intermediate failed logs, probe source/result and minimal diff are retained in evidence.

`Cargo.lock`, original store/tools/judge/collaboration/provider sources and core/collaboration/native-policy tests are byte-preserved. `src/lib.rs` only gains the browser module export. `tests/native_provider.rs` differs only by the verified fixture blocking flag; no acceptance assertion was changed. This directory has no Git repository, so no git diff/status claim is made; SHA snapshots, the minimal helper diff and formatting were verified. No repository was created, no Git remote/push/PR/merge/deploy, other project writes, services, model loads, secrets or additional OMP calls occurred.

Configured local model record remains gpt-6.1-sol; this turn's effective runtime model is not independently verified. No fallback/other task/model handoff was used. This unit adds zero OMP calls.

## Latest upstream contract and unverified work

After the fake unit, read latest OxiBrowser ghost-mcp.md/ghost-handoff.md/result correlation source. Its reported 124 tests were not rerun. Envelope, seven tools, initialize namespace, result correlation and unknown/ref contracts remain compatible; no wire change is required by this fixture unit. Native DOM synthetic execution metadata is result data, not evidence of a human approval. The upstream engine still lacks human viewer/script-network freeze and OS input/full web compatibility.

Next proposed small unit: separately gated real OxiBrowser launch with a scoped explicit loopback origin, empty configured environment and host containment; two Ghost observe/fill/click flows plus stale/dedup/cancel/crash against local fixtures only. Real browser grants must not reuse fixture grants. Its trusted control epoch/authentication/viewer/freeze design is later work. No actual OxiBrowser process, browser tests, real site, account/cookie/credential, release/deployment, financial or external sharing action was performed here. No blocker remains for the completed fake-child unit.
