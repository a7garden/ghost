# ADR-006 — pinned OxiBrowser local-fixture integration

2026-10-02. Extend the owned-child host from ADR-005 against one fixed actual OxiBrowser CLI artifact and local HTML fixtures. This is a selected-Mac test adapter, gated by `browser-local-e2e`, which implies `browser-fixtures`. The base single Rust executable has neither this launch constructor nor a browser CLI command. An actual browser executable and macOS sandbox-exec are explicit optional dependencies.

## Scoped authority and launch

Real fixture grants use `browser_local_fixture`, separate from `browser_fixture`. Persist profile/session/operation scope plus approved HTTP origin, canonical executable path and SHA in SQLite. Check active grant and exact binding before spawn, and active operation scope before forwarding. Page/agent data cannot construct trusted fixture control. This test host authority is not a human authentication mechanism.

The selected origin is exactly `http://127.0.0.1:<explicit unprivileged port>`; no userinfo/query/fragment in an origin. Navigation allows that origin and about:blank, rejects file/public/foreign-origin URLs before forwarding. Use direct argv `sandbox-exec -f <ephemeral policy> <pinned executable> serve --mcp --ghost <profile UUID> --allow-private-ips`, env_clear, null stderr, owned Child handles, empty tabs and no existing profile attachment. No shell, login, cookie import, user credentials or control FD.

Each child applies a temporary macOS network-deny profile with only the exact fixture port allowed. Listed global configuration/credential directories are read/write denied, and the Projects tree is write denied. An actual redirect to another loopback port was denied with zero requests at the foreign server. This does not establish a portable or complete filesystem sandbox: other reads remain permitted; paths are specific to this selected Mac. Background page scripts can still run at the approved origin. No persistent access settings change.

The trusted local test host runs with a minimal clean environment and reviewed fixture code. It has no additional outer OS sandbox. macOS rejected a different nested sandbox profile (exit 71), so that outer layer is retained for the existing regressions but not for the real E2E test host. The real children retain their narrower per-child sandbox. Audit fields distinguish these scopes.

## Fixed runtime and durable effects

The pin is [evidence/browser-e2e-pin.json](evidence/browser-e2e-pin.json): SHA-256 `3c9d646000703ee219a6fbf18bbe6d32e6c73efb074be3b4ec78fb6bbab1fb62`, 238,655,688 bytes. Copy/hash consistency was checked; the copy lives outside the Ghost repository. Initialize reports MCP 2024-11-05 and oxibrowser-ghost 0.25.0. Source/contract files are pinned separately by SHA; binary-to-source build correspondence was not independently verified. Source is evolving, so no latest-source validation is claimed for the fixed runtime.

Pin verification streams SHA and uses an in-process path/size/mtime cache for the trusted owned fixture copy. This is not a hostile-file TOCTOU or production signature solution. No OxiBrowser build or repository write occurs here.

Reuse the existing intent-before-stdin and transactional receipt/effect/outbox path. Real actions keep host task/request/profile/session/child correlation, reobserve after action, reject stale/cross-tab/cross-child refs, preserve durable identical replay and block changed IDs. Cancellation, timeout, owned child death, mayHaveActed, redirect denial or lost final commit produce uncertain outcomes; stop only the owned child and block restart. Separately trusted do_not_replay reconciliation can admit a fresh empty child, preserving old uncertain effects. No automatic retry or task-ID substitution.

## Current handoff difference

Upstream now reports a task-bound inherited anonymous AF_UNIX private controller and 138 selected passing tests; those upstream tests were not rerun here. Without a control descriptor its old agent contract remains. Controlled mode additionally requires exact browserSessionId/ghostTaskId/controlEpoch metadata, independent host-channel ownership and fresh snapshots of every open tab after resume. Our fixed runtime and this adapter do not use that channel or implement the state machine. Fixture stop/resume remains a different, closed-child lifecycle.

Next separate host unit would need private descriptor inheritance, task-bound ownership, continuous stdout draining, durable host epoch/handoff reconciliation, an independent watchdog and trusted real user input. scriptsFrozen and networkFrozen remain false upstream; no viewer, OS input or freeze claim. Do not add these to this completed unit or duplicate browser repository work.
