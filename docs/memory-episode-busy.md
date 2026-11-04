# Original memory episode retries

An Oxi writer lock can prevent an episode attempt before its transaction starts.
Ghost accepts only the strict `oxibrain.episode-write/1` result through
`BrainClient::call_episode_tool`: correlated JSON-RPC ID, exact original nonce,
authorized space, arguments/content digests and note occurrence or session ID.
It never classifies a generic error string as proof. The native proof concerns
this attempt's episode only; a source-registry write may already have committed.

The Ghost source ledger is version 3. Each `prepared -> sent` transition writes
a new opaque `attempt_nonce` before native I/O and sends the same value in MCP
parameter metadata outside model arguments. A verified busy result can change
only the exact `sent` row with that nonce and original source identity back to
`prepared`, after rechecking current source authority. The nonce is retained in
the prepared row. A later explicit retry rotates it; a delayed earlier proof
cannot reset the later attempt, an unknown state, or a recorded episode.
Failed compare-and-swap leaves the actual state intact and reconciles it.

The Host returns `memory_busy`, `retry_class:same_id`, and the original receipt
with `status:prepared`. `retry_original_memory_command` means the exact original
envelope/source/occurrence, not a fresh operation ID or an automatic loop.
Legacy servers, malformed evidence, transport loss and errors after the commit
boundary remain `effect_unknown` and require original-episode reconciliation.
No raw native receipt or previously committed Host response is rewritten.

Opening a version-1 or version-2 source ledger adds the nullable nonce column in
one transaction. Every original row/field is retained; old `sent` and unknown
rows keep `NULL` and gain no retry authority. Legacy prepared rows can begin a
new explicit attempt. There is no downgrade migration: old binaries reject
version 3. Do not remove the nonce column or restore a pre-upgrade receipt file
over newer native episode commits. Rollback requires a coordinated, verified
ledger/engine recovery point or forward-compatible code, with original episode
reconciliation before further writes. This source change does not modify an
installed process or its ledger.
