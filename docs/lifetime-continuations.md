# Optional memory continuations

Generated-experience indexing and source-view publication retain their existing
Host outboxes, command identities, retry counters, authority checks, and receipts.
The lifetime driver observes one bounded in-flight job for each continuation.
It does not await their native I/O before delivering unrelated Pi commands.
There is no second scheduler or alternate retry owner.

Each operation keeps its existing 30-second total bound. An unavailable or stuck
index leaves the original experience `written_index_pending` with its reason,
page UUID, source hash, and bytes intact. Memory-dependent stages remain blocked
or pending; nondependent Work can receive its normal Pi delivery. Recovery
reconciles the same source rather than creating a replacement experience.
Publication uncertainty likewise remains attached to the original occurrence.

Continuation tasks use the Host's existing task tracking. Normal driver exit
cancels and joins its jobs. Host shutdown also cancels and joins the actual jobs
when it aborts the driver itself. Only a continuation's own finished task is
removed from tracking; repeated empty passes do not grow a retained task list.
Current epoch, grants, source identity, and destination checks still fence every
native operation and its completion.

The real-driver regression uses controlled Pi and memory transports. It starts
a ten-second index proof wait before admitting another Ghost's Work, requires
the actual `PiProcess` receiver acknowledgement within three seconds, and checks
that the dependent experience remains pending. After driver stop and Host journal
reopen, the same page is indexed once and the original receiver receipt is
unchanged. A separate phase invokes actual Host shutdown during the native wait
and checks task/child cleanup. This is driver/reconciliation evidence, not model
inference, a full cold Host restore, or installed-service acceptance.

Scope failures continue to carry their existing per-space partial/freshness
metadata. This change does not establish a complete three-space or full-brain
outage acceptance matrix. Exact document proof still fails closed when the
reader reports global skipped-file diagnostics; unrelated-root availability
under those diagnostics remains a separate limitation.
