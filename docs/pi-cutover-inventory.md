# Pi cutover inventory

`scripts/audit-pi-cutover.py` reads explicit Host and legacy worker journals.
It does not open them through the application migration code, dispatch work,
restart processes, change receipts, or authorize deployment. It emits metadata,
not prompts, tool arguments, response bodies, session paths, or credentials.

```sh
python3 scripts/audit-pi-cutover.py --host-db /absolute/workspace.db \
  --worker-db /absolute/original-worker-a/worker.db \
  --worker-db /absolute/original-worker-b/worker.db
```

Use Python 3. Every worker journal must be supplied explicitly, including
original hosts of migrated executions; directory scanning cannot establish
ownership. Exit 0 means no issue was found in the supplied database inventory.
Exit 2 means reconciliation remains necessary. `cutover_authorized` is always
false. A clean report is not P3 completion.

The report rejects unresolved legacy effects and commands, unacknowledged
worker outbox items, uncollected/non-exited execution rows, pending cancellation,
missing original journals, duplicate IDs, orphan executions, and identities
simultaneously admitted as Pi and legacy. Collected results remain readable;
the tool never deletes historical receipts or artifacts. Missing effect tables
or unsupported schemas require explicit historical reconciliation.

Each SQLite read has a transaction; the report is not one atomic snapshot of
all stores. Before operational cutover, admission must be fenced and all writer
process identities independently checked, then the inventory repeated. Artifact
integrity, backup/restore, legacy result reading, and the OMP-free release's real
provider/browser/container acceptance remain separate required evidence. Do not
automatically replay a blocked execution through Pi.

The isolated fixtures in `tests/test_pi_cutover_audit.py` verify inventory
decisions and unchanged database bytes. They do not exercise production process
fencing or prove that an omitted journal does not exist.

## Preserve historical worker receipts

Use `--preserve-history` when retiring the legacy workers without advancing
their ACKs. In this mode the audit verifies the worker admission's digest and
its exact Host work revision, the worker's terminal event, the corresponding
Host result receipt at the same epoch and sequence, and the original artifact
bytes. A never-started failure requires the original pre-start event sequence,
no process identity or prompt intent, and zero tool receipts. A stale Work
requires a superseding goal revision and a matching historical terminal
receipt. It stays stale in the Host journal and remains ineligible for
acceptance or replay. Pending commands, effects, cancellation or worker
deliveries still block. Historical closures are evidence in the output and
leave both journals intact.

1. Run the inventory while live to identify gaps. Supply all four original
   worker journals or the complete set for the installation being migrated.
2. Fence admission and quiesce the Host and workers. Verify independently
   that original writers and any active processes are stopped. Repeat the
   same inventory against the original journal paths and archive the output.
   Artifact locators are validated against those original paths.
3. Make verified private backups of the stopped journals, artifacts, computer
   registry, runtime state and configuration. Record the scope and how to
   restore the release and state. Keep the original worker evidence; ACK
   advancement would prune noncritical events.
4. Verify compatibility of the release, its bundled Pi runtime, persisted
   deliveries, computer bindings and provider privacy routes before starting
   it. Start only the new Host and verify a new owner-scoped job including a
   restart, effect counts, acceptance and final report. Keep the original
   workers stopped until the outcome is known.

`inventory_clear` covers the supplied legacy inventory. It does not authorize
cutover, fence running writers, or check pending Pi deliveries.
