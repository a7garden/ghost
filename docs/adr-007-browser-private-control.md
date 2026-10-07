# ADR-007 — fixture-only private controller and owned-child watchdog

2026-10-02. The authorized unit connects the latest OxiBrowser anonymous AF_UNIX controller to Ghost, using explicit trusted fixture input only. There is no user UI/login, production approval path, new network listener, persistent access setting or browser repository write. The base binary does not expose this constructor.

Add a separate browser-handoff-fixtures feature and controlled host module. Retain every existing 96 regression and old pinned runtime. Pin the new task/session/epoch runtime separately; build correspondence with source is not independently established. Controlled children use the existing exact loopback-origin temporary Mac containment and clear environment. Grants are a distinct browser_control_fixture capability bound to profile/session/anchor task/operations/runtime/origin. The anchor is a queued fixture-only task binding, not a completed workflow dispatcher.

The host exclusively owns one anonymous socketpair endpoint; only the child endpoint loses CLOEXEC in this spawn and is dropped in the parent immediately afterwards. Agent stdin/page JSON cannot invoke host transitions. TrustedFixtureControl is a private owner-bound fixture capability, not a proof of human authentication. Agent activities remain separate canonical tasks/effects/outbox, with their anchor correlation explicitly recorded.

Separate bounded continuously running readers drain agent stdout and the private controller. Control and activity intent persist before bytes; phase/epoch/pending operations are host-owned journal state. Historical control acknowledgements cannot roll current phase/epoch back. A handoff is not applied until the admitted operation receipt settles; pause/human admission blocks all agent work. Resume clears every ref and requires fresh snapshots for all known open tabs, or fresh empty inventory for zero tabs. No background script/network freeze is claimed.

An independent host thread holds only the owned Child handle. It enforces response deadlines/cancellation, EOF/protocol queue failure, grant revocation and anchor scope. It never attaches/signals bare historical PIDs. Missing/late/malformed receipts, cancel/crash/EOF/revoke or failed final persistence stop the child and make pending intent uncertain. Reopen reconciliation marks stale control state closed, blocks the session and never retransmits. Explicit trusted do_not_replay reconciliation can allow a new empty child; old refs, pending ownership and old effect success are never reconstructed.

Acceptance uses two finite local browsers at most and held/released HTTP gates for races: full handoff/human fixture/resume/all-tab refresh; wrong owner and page authority injection; historical/conflicting duplicates; pending-operation transfer and resume race; owned-only watchdog timeout/cancel/EOF/crash/revoke; late acknowledgement; process restart and final commit loss. Actual user confirmation, UI, OS input, real sites/credentials and deployment remain unvalidated.


Completed fixture checkpoint: [results](browser-handoff-2026-10-02.md), default47 /
no-SDK91 / full110 passed. Control phase/epoch final commit is transactional;
unknown work is terminal and never automatically retried. Actual user input/UI
validation remains a separate next unit. Every shutdown preserves the active-child
block until owned process reap is confirmed. Source/runtime pins, failed probes,
old source/test preservation and the base standalone artifact are in evidence.
