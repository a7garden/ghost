# Native provider mock checkpoint — 2026-10-02

This bounded unit is implemented and executable, but Ghosts v1 is not released. OpenAI/Z.ai preset objects share the native text stream adapter; only public dummy loopback fixtures were used. No actual credentials, API calls, new services, persistent security settings, browser writes, deployment or additional OMP calls.

User-authorized direct Sol development followed the initial OMP work. Recorded local configuration is `gpt-6.1-sol`; the effective runtime model of this turn could not be independently verified. No unapproved fallback/handoff is claimed. The earlier OMP total remains 7 finite calls/256,149 reported tokens; this unit adds zero OMP calls. See prior recovery evidence for the explicit approval record.

## Implemented and checked

- Exact endpoint approval and model selection, explicit in-memory credential object without env/file discovery, redirect/proxy/retry disabled, checked DNS pinning, conservative public-address filtering. Live DNS/TLS/API/plan compatibility was not exercised.
- Bounded SSE text/usage normalization, multiline and split UTF-8, exact credential-value redaction even across deltas, categorical errors excluding raw error bodies. Two concurrent Ghost calls keep separate identity/session/task/attempt correlation and persisted outbox/receipts.
- Pre-dispatch cancellation causes zero HTTP requests. Dispatch cancellation, deadline, 5xx, redirect, malformed/incomplete stream, bound violations and stream-observer DB failure are uncertain with no automatic replay. Redirect destination sees zero requests. Authentication/rate-limit errors are definitive failures.
- Durable ordered events and advisory reported token counts; task/outbox/audit/final receipt commit atomically. Injected terminal commit failure leaves running; close/reopen recovers uncertain without resending. Receipt CLI works on native fixture tasks; standalone mock tasks return no native receipt.
- Existing filesystem grants/effect policy remains authoritative. Native text cannot grant write permission. No provider function/tool execution is added.

## Actual verification

All builds were offline, `-j1`; all test binaries ran serially in a temporary macOS sandbox with credential environment variables removed and global Codex/MCP/engine config access denied. A documentation-address socket guard proved public network denial (EPERM). Extended profiles allowed loopback only; the default profile denied all networking. No persistent sandbox/settings were changed.

| Configuration | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| default | 47 = existing 43 + policy 4 | 0 | 0 |
| native-fixtures | 65 = existing 43 + policy 4 + HTTP 18 | 0 | 0 |
| oxicode-engine,native-fixtures | 66 = existing 44 + policy 4 + HTTP 18 | 0 | 0 |
| cargo fmt --check | passed | — | — |
| default offline build | passed | — | — |
| cleared-environment standalone CLI smoke | passed | — | — |

The unchanged optional SDK test ran and passed; it was not skipped. Default builds deliberately compile the HTTP fixture test target with zero tests because the fixture constructor is absent. Optional SDK alone was not rerun as a separate feature combination; its complete existing 44-test set passed in the combined configuration.

Initial native compilation caught an Option handling error in the new test harness; fixed before execution. The first HTTP run passed 14 of the original 15 tests and failed one permission-summary assertion. A single-test rerun passed; exact cause was not established. The fixture's 900 ms server lifetime was replaced with a bounded 3 s initial wait/250 ms post-response window, diagnostic context was added, and three meaningful failure/usage cases were added. Final extended runs passed 18/18 HTTP tests in both configurations. This is fixture evidence, not a claim about live provider reliability. The package feature audit initially expected `[]`; Cargo reports the empty `default` feature as `["default"]`, corrected without product changes. Logs retain the first failed checkpoint.

`Cargo.lock`, `src/store.rs`, `src/tools.rs`, `src/judge.rs`, `src/collaboration.rs`, `tests/acceptance.rs`, and `tests/collaboration.rs` match their pre-unit SHA-256 snapshots byte-for-byte. This directory has no Git repository, so git diff/status verification is unavailable; no Git repository was created. Formatting and source hash verification were performed instead.

Artifact: `dist/ghost-native-macos-arm64`, default-feature development Mach-O arm64, 8,882,936 bytes, SHA-256 `de036d26ae8450d3c4723093467dbad78c94c78df5beb992527ce73649f0760c`. Links only macOS libSystem and libiconv per otool. No Node/Bun/Python/Cargo is required to execute the binary. Python was used only as a local verification harness. Both previous dist binaries are preserved. This is a macOS development artifact, not release signing/notarization or other-OS certification.

Evidence is in `docs/evidence/native-*`: final suite logs/audits, first failed checkpoint, sandbox profile, build feature audit, integrity record and standalone smoke audit. Temporary orchestration/build JSON is under the selected task workspace; no secrets are in deliverables.

## Remaining work

Trusted hidden credential input/explicit connection consent/revocable lifecycle; a user-facing native execution path; live provider compatibility under separately authorized minimum requests; canonical dialogue/tool history/compaction; Cassette and oxibrain provenance; local judge calibration/native embedding; SDK path portability and release packaging remain unfinished. Real cost/quota/billing are unknown. Production DNS pinning/TLS and hostile concurrent filesystem races were not end-to-end tested here.

The read-only browser review produced [the proposed core adapter](browser-core-next.md). Its next bounded unit should exercise capability checks, owned fake child, durable intent/receipt correlation and uncertain reconciliation. Human handoff/resume and actual browser actions are later work; OxiBrowser's reported test results were not rerun here. No UI/company simulation/scheduler or live-site automation was added.
