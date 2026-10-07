# Ghost 최초 단위 요구사항 — 기록

이 문서는 최초 bounded core 단위의 범위와 수용 조건을 보존한다. 현재 프로젝트의 목적·전체 구조·UI·도구·프로토콜·운영 요구사항은 [전체 시스템 설계 — ADR 011](adr-011-ghost-host-control.md)을 기준으로 한다. 아래의 “No UI, scheduler, daemon”은 최초 단위의 범위이며 현재 시스템의 기능 금지나 완료 상태를 뜻하지 않는다.

Ghost is one enduring identity with independent sessions and tasks. A single headless Rust executable can run many profiles; each profile owns a UUID, SQLite database, policy, memory references, inbox, outbox and activity records. Persist before acknowledging submissions. Restore identity and queued work after restart, while quarantining work with ambiguous external results. One writer per profile.

This first unit implements profile create/list, session create/status, task submit/status/cancel, bounded run, durable message correlation and native filesystem tools under explicit local approval. Default provider is deterministic mock: no real LLM credentials or model weights. Two profiles, concurrent questions, restart recovery, deny, cancellation and duplicate effects are acceptance criteria.

Cassette user notes remain the common source; oxibrain search will be reused through an adapter. Knock and FARM compose ghosts later. No UI, company simulation, scheduler, daemon, payments or external sharing in v1.

Bundle Tokio, reqwest with rustls, and rusqlite with SQLite into the executable. Shell/git/browser/stdio MCP and local inference are optional capabilities with separately disclosed dependencies. Model weights are data, API connectivity is connectivity. Neither is an undeclared interpreter requirement. Release OS/CPU builds remain future verification.

Approval records carry operation and canonical path scope, revocation and audit. Agent recommendations never grant authority. Persistent unique message IDs reject conflicting replay. External effect attempts are durably recorded before execution. Unknown outcomes require reconciliation rather than automatic replay.
