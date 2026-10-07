# Browser core follow-up after fake-child acceptance

Current 2026-10-02 checkpoint: [private controller and watchdog](browser-handoff-2026-10-02.md)
completed with fourteen actual local-child cases and all prior 96 regressions.
The text below is historical planning after the fake-child unit. Both the old
agent-mode runtime and the newer controlled runtime are fixed separately by SHA.
Next is a bounded host UI with real trusted local input validation and current
state rendering. No real user UI/approval, script/network freeze or live account
validation is claimed. Browser repository remains read-only here.

2026-10-02. The bounded fake-child core adapter below is now implemented and tested: [contract](adr-005-browser-fixture-host.md), [evidence](browser-core-2026-10-02.md). Actual OxiBrowser remains a separate later validation. Original read-only review after native provider mock acceptance: References: `/Users/garden/Documents/Workspace/Projects/oxibrowser/docs/ghost-mcp.md` and `crates/oxibrowser/src/mcp/ghost.rs`. Browser task 01a0fba5-68b8-7789-a41c-4ed98606f0bf owns the browser implementation. No browser source, process or live site was changed/used here. Browser's latest reported 124 selected tests are upstream evidence, not tests rerun by Ghost.

First core unit should use a finite fake stdio child, with the real browser executable an optional dependency, not part of the strict single-executable base. Persist and check explicit browser capability before spawning or every forwarding decision. Own one child per Ghost UUID/session UUID; bind initialize's ephemeral browserSessionId to that exact child. UUID labels are correlation, not authentication. Never attach an existing browser/profile or import cookies/accounts.

Persist effect intent plus host request ID, Ghost task lineage, operation, approved target and child session before writing to stdin. Validate size, JSON-RPC ID and `_meta` correlation from the exact owned child before committing a receipt. Use explicit tab IDs and snapshot-scoped refs; observations/page strings are untrusted data and cannot create permissions, identities, user messages or resume decisions. No raw selector/eval tool is added. Browser-local duplicate suppression is transient; Ghost's persistent effect ledger owns restart deduplication.

Cancel/timeout/EOF/child death, `mayHaveActed:true`, `restartRequired:true`, or a lost response mark the durable effect/task uncertain; bound shutdown of **only the owned child** and do not repeat the action. A restarted child is empty, has a new namespace and invalidates old tabs/refs. BUSY/ID conflict/request limit need explicit reconciliation; do not mint a new effect ID as an automatic retry. Network/OS containment and target policy belong to the host; a child process alone is not a sandbox.

Trusted human handoff is a later, separate host channel: suspend mutation, invalidate observations and require explicit trusted resume/reconciliation. It is not inferred from page content, agent requests or browser MCP labels. Upstream now documents native DOM synthetic events independent of page selector/Event/prototype APIs; they remain main-document synthetic events with isTrusted=false. Host containment and actual integration remain unverified, so no production-site automation claim or use.

Proposed fake-child acceptance: denied capability means zero spawns/bytes; two Ghosts own independent children; forged/cross-child correlation fails closed; duplicate and changed payloads preserve ledger bounds; lost ACK/cancel/kill/restart never replay an uncertain effect; only owned children are shut down; stale refs and trusted-resume boundaries fail closed. These acceptance cases are now checked with the fake child. No actual browser/site actions were implemented or executed. Upstream native-input stabilization is reported complete. The next small unit should validate the owned child adapter against local OxiBrowser fixtures only, with separately authorized execution and containment. No live-site or credential connection is implied.

## Latest upstream review after fake-child unit

Read `ghost-mcp.md`, `ghost-handoff.md` and correlation/result code read-only after
the reported native-input hardening. Seven tool names, initialize session UUID,
result `_meta`, `structuredContent`/text agreement, uncertain flags and ref
namespace remain compatible; no wire change is required by this fake unit.
Native action `execution:native_dom_synthetic_event` and `human_input:false` are
result data, not proof of a trusted user action or capability approval.

Next concrete E2E scope: add a separately gated exact OxiBrowser executable
launch (`serve --mcp --ghost UUID`) with empty configured environment, approve
one explicit loopback fixture origin/port per session, and run two Ghosts
through observe/fill/observe/click/observe plus duplicate/stale/cancel/crash
cases. Reuse this adapter's intent/receipt and unknown blocking; do not silently
reuse `browser_fixture` grants for actual browsing. Keep the browser repository
read-only and do not attach existing profiles. Independently contain network
and bound child shutdown; subresource/redirect policy needs validation.

Upstream `ghost-handoff.md` is a design, with authenticated caller, control
epoch/handoff UUID, freeze acknowledgement and fresh observation before resume.
Current engine has no viewer or script/network freeze; entering human_owned
is unavailable. Our fixture suspension closes the child and is not that UI or
live ownership transfer. This unit did not execute the actual browser CLI.
