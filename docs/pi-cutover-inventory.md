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
