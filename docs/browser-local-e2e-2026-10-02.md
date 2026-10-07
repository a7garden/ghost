# Actual OxiBrowser local-fixture checkpoint — 2026-10-02

The actual pinned OxiBrowser CLI ran as owned sandboxed children against empty local fixtures. [Decision and limitations](adr-006-browser-local-e2e.md), [runtime/source pin](evidence/browser-e2e-pin.json), [post-validation contract review](evidence/browser-e2e-upstream-review.json). Ghosts v1 is not released.

Only Cargo.toml and src/browser.rs product sources changed; tests/browser_local_e2e.rs adds nine real-child cases. Cargo.lock, every original core/provider/collaboration/fake-browser test, original provider/core implementation and four previous dist artifacts remain byte-preserved. This folder is not a Git repository; evidence uses SHA snapshots, not git diff. Existing native fixture blocking fix from the prior unit is unchanged.

## Actual acceptance

1. Empty tab inventory; navigate local HTML; snapshot → ref fill → snapshot → ref click → snapshot. Rust-generated synthetic event metadata is untrusted result data and human_input=false. Password targets are omitted. Heading becomes Ghost E2E and Count 1. Identical durable replay does not increment again; changed task/request binding fails.
2. Navigation invalidates old observations; stale, cross-tab and closed-tab references fail before forwarding.
3. Fake grants cannot launch real children. Revocation, file/public/foreign-origin/userinfo targets deny before HTTP traffic.
4. Two Ghosts own distinct children, identities and session/ref namespaces. Cross-profile/ref access fails; stopping one leaves the other usable.
5. Cancel and timeout stop their child, preserve uncertain effect, block automatic restart and duplicate dispatch. Manual trusted acknowledgement admits a new empty child without replaying old work.
6. Injected actual owned-child death after stdin write leaves UNKNOWN/uncertain effects; duplicates never execute them again.
7. Local click mutates then throws; mayHaveActed is uncertain, with restart blocked.
8. Actual success followed by an injected outbox commit failure recovers pending intent as uncertain and emits one recovery outbox without another child/effect.
9. Actual redirect to a second loopback port is blocked by the child OS policy; that server receives zero requests.

At most two temporary owned browsers at a time, finite loopback servers, serial tests, offline -j1 builds. No model/browser daemon or model download.

## Final verification

| Configuration | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| default | 47 | 0 | 0 |
| browser-local-e2e | 77 = original 47 + fake 21 + actual 9 | 0 | 0 |
| oxicode-engine,native-fixtures,browser-local-e2e | 96 = original 66 + fake 21 + actual 9 | 0 | 0 |
| cargo fmt --check | passed | — | — |
| default offline build | passed | — | — |
| cleared-environment base CLI smoke | passed | — | — |

The original cases/assertions were all exercised in applicable feature sets; default fixture targets intentionally have zero tests because fixture APIs are absent, with no ignored test. Tests were compiled by Cargo and executed by the audited serial harness; [harness](evidence/browser-e2e-run-tests.py) and per-configuration build/test logs are in evidence. GHOST_E2E_PIN must explicitly identify the existing immutable fixture copy; a missing pin fails the real tests, rather than skipping. cargo --no-run does not alone establish a pass; runtime logs supply that evidence.

Existing regressions ran inside their old temporary configuration/network sandbox. Real E2E host used only PATH/LANG/test-thread/pin environment and no outer sandbox; each owned real child applied the narrow per-origin sandbox. Initial actual single-path test failed from nested sandbox denial, diagnosed with bounded initialize/empty-env probes, then passed with the per-child layout. The product permission boundary was not relaxed. Both failure and final success logs are retained. JSON audit scope was clarified after the local/combined runs to distinguish test host and child containment; no test result was changed.

New default development artifact: dist/ghost-local-browser-macos-arm64, Mach-O arm64, 8,880,840 bytes, SHA-256 `0b923c3ae654285b14437addb61a4f199f2b66bcb7459200906e3ea27f953796`. macOS libSystem/libiconv only. No Node/Bun/Python/Cargo/browser executable required by this base binary; those tools were only development/test harnesses. Cleared-environment smoke verifies two identities, mock delegation/artifact provenance, process-to-process persistence, dedup, cancellation, outbox and no live provider receipt. Actual browser tests are feature-gated library tests, not a browser CLI command in the base artifact. This is an unsigned debug development artifact; release/other-platform/signing validation is not run.

## Source evolution and remaining work

The runtime SHA and separately read source hashes were fixed before validation. Upstream MCP/handoff/source changed during the unit; the tested runtime was not replaced. [Post-review hashes](evidence/browser-e2e-upstream-review.json) record that difference. Latest docs state the no-control-FD agent contract remains supported, but the new task-bound private FD/epoch ownership mode needs a separate Ghost supervisor unit. The upstream 138 tests are reported evidence, not tests reproduced by Ghost. No live ownership transfer, real user UI or script/network freeze is claimed.

No current-unit blocker remains. Not run: current upstream controlled-mode runtime, real websites/login/accounts/cookies, actual model/provider calls, signing/other OS, production launch/UI, private-FD handoff/watchdog, financial/sharing or deployment. Next work is the bounded host-controlled handoff boundary, then separately approved live credential/provider integration and packaging; Cassette/oxibrain/Knock/FARM and judge calibration remain the existing backlog.

Other projects were read-only, including OxiBrowser and optional Oxicode SDK. No git remote/push/PR/merge/deploy, persistent security/access change, secret reads/copies or OMP call in this unit. Model record: local configured gpt-6.1-sol; effective turn model not independently verified. No capacity failure, Astra fallback, duplicate task or external model handoff occurred.
