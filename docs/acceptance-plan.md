# Acceptance plan

Run Cargo with `-j1`; no service stops, daemon, weights or real inference. Tests use temporary directories and deterministic providers.

| Scenario | Required evidence |
|---|---|
| Two enduring ghosts | Different UUIDs, profile databases, personas, session/task records after reopen |
| Concurrent questions | Distinct message/task/session correlation, bounded per-profile writers |
| Process restart | Submit then process exit then run/status in a fresh binary process |
| Duplicate writer | Second owner denied; reacquisition after owner exits |
| Fail closed | No grants means denied; no external file created |
| Scoped approval | Native fixture read/write only in approved directory; revocation survives reopen |
| Path boundary | Traversal, sibling-prefix, symlink escape rejected |
| Duplicate message | Exact replay returns same task; conflicting payload rejected |
| Duplicate effect | Two runs and repeated submissions yield one effect and one outbox result |
| Unknown outcome | Durable started/running record becomes uncertain; no replay on next run |
| Cancel | Terminal cancellation persists and run skips it |
| Engine boundary | Default mock has no credential/network dependency; optional SDK compiles without live calls |
| LocalJudge | Allowed-candidate-only recommendation or abstain; no policy authority |

A journal cannot atomically commit filesystem or remote effects together with SQLite. The guarantee is no automatic second attempt after an uncertain first attempt, not universal exactly-once delivery. Manual reconciliation and durable outbox delivery acknowledgements remain separate follow-up work.
