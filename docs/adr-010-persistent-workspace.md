# ADR 010: persistent local workspace

Historical implementation decision. [ADR 011 — Ghost 전체 시스템 설계](adr-011-ghost-host-control.md) now defines the headless host, control API, optional adapters, UI direction, and implementation status. The runtime descriptions and remaining-feature list below describe this earlier checkpoint.

The `workspace-ui` feature connects the oxicode durable execution plane to a
single-owner loopback workspace. `ghost serve` opens existing real profiles;
an empty workspace lets the owner create profiles through the UI. No fixture
profiles or simulated waiting times are inserted. Each conversation selects a
catalog model or an explicitly labelled offline mock. Credentials stay in the
server's existing oxicode provider resolver and are not accepted by the browser.

Each profile has one worker that calls bounded `Runtime::drive` repeatedly,
including persisted retry delays. Submission, steering, follow-ups,
cancellation, compaction and child/tool progress use that same runtime. HTTP
reads only project committed state; neither polling nor an open tab is required
to execute work. A streamed response can be cancelled while other HTTP actions
remain available. Interrupted text is preserved with an interruption label.

The host owns a root `workspace.lock` and SQLite `workspace.db` in addition to
existing per-profile locks and stores. Root command intents are committed before
cross-store changes. Exact command retries return the recorded response; changed
payloads on the same request ID are rejected. An intent with no committed
response after interruption requires inspection rather than automatic replay
of a permission change. Successful core conversation creation also accepts an
owner-assigned UUID. No cross-database atomic transaction is claimed.

Timers persist their profile UUID, conversation ID, instruction, interval,
next occurrence and last task ID. An occurrence submits a follow-up using
`schedule:<timer-id>:<scheduled-time>` before advancing the timer. If the
runtime commit succeeds but timer acknowledgement is lost, recovery reuses the
same input. Busy or uncertain conversations defer dispatch. After a late run,
the next occurrence is scheduled from the current time, so downtime does not
create a backlog. Intervals are 60 seconds to one year. Pause stops future
dispatch; cancelling already submitted work is a separate owner action.

File tools are opt-in per conversation and still require current per-profile
directory grants. The UI can grant or revoke read/create-new authority and
record a definitive result for uncertain effects. Reconciliation never repeats
the tool. Existing Ghost-root protection and host revalidation remain in force.
This is a local single-owner trust boundary, not a multi-user authentication
system or a new OS sandbox.

HTTP binds only 127.0.0.1 with exact Host, Origin, same-origin fetch checks,
random HttpOnly/SameSite session cookies and CSRF validation. The fixed-route
parser enforces body/header/deadline limits; it is shared with the existing
fixture host without enabling browser fixture constructors in this feature.
The embedded frontend uses textContent rather than executing model/page HTML.
Transient network failures retain request IDs for retries within the page.

The new journal, timer instructions and model transcripts are execution data;
this unit introduces no durable user-authored document plane. Spaces/Pages must
use the personal Portable Document Contract when implemented.

Verification includes subprocess HTTP tests for actual profile/conversation
persistence, independent background execution, command receipts across restart,
owner isolation, grants/revocation and timer persistence. Controlled-provider
tests verify committed streamed text and owner cancellation. Timer tests cover
lost acknowledgements, invalid intervals and pause/resume. Browser interactions
and 320/375/414/768px layout checks are recorded separately from Rust tests.

Remaining OpenDots gaps: live-provider connected-service validation; production
computer/browser and shell integration; Spaces/Pages and review-before-save;
cross-profile durable delegation; long-term memory/learning; voice and channels;
OS autostart, packaging, scale limits and long-running operational verification.
The existing browser fixtures and legacy collaboration are not connected to this
workspace. This does not establish full pi-durable compatibility or Dots parity.
