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

## 2026-10-25 bounded source-retirement checkpoint

Public `GuestModelBroker::start` now retires before authorization, configuration,
filesystem or thread effects. Independent review compared the original thirteen
assertions exactly with the preserved private `cfg(test)` fixture. TypeScript
public CLI/export entry points retire before input, auth or OMP import. Public
production-retirement tests passed5/5 in0.17s; full Node230/230 passed7.661s,
including three TypeScript retirement traps, and full Rust460/460 passed106.52s
with31 ignored. These checks do not complete environment/operator cleanup,
installed release transition or P3 cutover.

The scalar source-ref path separately passed focused Rust7/7: Host derives the
exact original Work, the registered legacy schema remains available, and only
the selected model-wire schema copy is narrowed. The new cold ABI proof uses a
controlled SDK fixture and explicit test-owned resume; production cold Owner
inference remains paused. Initial and corrected fixture logs are preserved in
infra `native-outcomes/scalar-source-ref-node-abi-bound-focused.log` and
`scalar-source-ref-node-abi-bound-corrected-focused.log`.

The13730-file fence was clean before/after the final build; approval
`d68d01d7f43f38e4e42ec190cb40de2a86a20171b9902d5f9ee5fc708f5942ea` binds
binary `4ba0f0d601491c1cf8aa4e571d9993cfdfa23e71ca4e3e9aa29b4d0d1691f4c9`.
One new post-scalar A04 trial `223450-108d7c56` was launched with original
worker53670/test53673 recorded running at launch. Its acceptance is unproved;
the same original attempt is observed with frozen source and no automatic
retry. No operational inventory, SDK/DB open, build, model or native operation
was run for this documentation update. The overall goal remains incomplete.

The same original `223450-108d7c56` later terminated failed101/218.71s
(controller223.106025s), superseding the launch status. Approved source/input/runtime
remained unchanged; secondary errors are empty and parent verified53670/53673
missing. No automatic retry or test/worker kill is recorded. The seed was accepted
with seven effects; candidate/evaluation admission was reached, while evaluation
remained running with four effects. Final call26 had prompt15626 and131 requested/
completed output tokens with `finish_reason=length`/`output_truncated`; an earlier
HTTP500 is separately observed and its backend cause is unknown. This is not a
completed root-cause diagnosis or A04 acceptance. The460/230/5 source-check passes
above do not complete environment/operator cleanup, installed P3 transition or
the overall goal. Original attempt evidence is preserved; a new compact
`parent-terminal-summary.json` records the terminal checkpoint.

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
