# ADR 009: oxicode durable conversations

The next integration is the persistent `workspace-ui` host described in
[ADR 010](adr-010-persistent-workspace.md). It adds a separate non-fixture UI
and timer service; the original fixture UI remains available for its tests.

This is an initial runtime and SDK/CLI integration. It does not complete the
Dots product or establish full pi-durable parity. The existing UI and
multi-profile collaboration still use their previous execution paths. Live
model requests and long-running production behavior have not been validated.
The recorded 507 passing cases include 481 existing regression cases and 26
new cases; one new case is a subprocess crash helper. See
[the scoped verification record](evidence/durable-implementation.json).

Ghost uses the opt-in `durable-runtime` feature (`oxicode-engine` enables it)
and consumes `oxicode_sdk::durable`. The reusable oxicode-durable crate owns
conversations, inbox semantics, model/tool checkpoints, compaction, persistent
children and committed-state observation. Ghost owns profile UUID/persona,
current grants, protected state paths, actual file access and business effect
identities. No default oxicode agent tools or secondary agent loop are used by
this conversation path.

Each profile stores new conversation execution state in `durable.db`. Existing
`ghost.db` task/outbox and collaboration APIs retain their v1 behavior. There is
no bulk migration or deletion. The profile writer lock remains held while
driving a conversation; another CLI process cannot mutate that profile then.
Applications can use cloned Session handles within the owning process to
submit/steer/cancel concurrently and watch committed state.

Ghost read/write capabilities are explicit. `--tools` advertises read_file,
write_file and analysis-only durable_delegate. Actual filesystem access still
requires current owner grants. Planning checks grants, paths and protected
root state; execution checks again. Writes use the existing create-new,
sync-all implementation. Filesystem TOCTOU assumptions remain those in
`src/tools.rs`. Child conversations have no inherited filesystem tools.

Write keys are profile UUID plus the canonical create-new target; repeating a
write with another model call ID reuses the committed result. Different
arguments on that key are rejected. Read keys are per tool task and are replay
safe observations. These receipts live in durable.db, and Ghost's audit also
records the host attempt/result; legacy effect rows remain for legacy tasks.
An interrupted write is uncertain and blocks continuation until the owner
reconciles it. Cancellation cannot prove that an already started external
effect did not happen.

The execution database, model messages, summaries and runtime JSON are not a
user-authored document plane. A future notes/pages feature must use the personal
Portable Document Contract; this implementation does not choose a canonical
document format or migrate existing user files.

## Commands

Build with `cargo build --features durable-runtime`. A minimal offline run:

```sh
ghost --root /path/to/state profile create alice --persona 'Research assistant'
ghost --root /path/to/state conversation create alice
# Use the returned conversation_id as CONVERSATION below.
ghost --root /path/to/state conversation submit alice CONVERSATION --request-id first --prompt 'Hello'
ghost --root /path/to/state conversation run alice
ghost --root /path/to/state conversation status alice CONVERSATION
ghost --root /path/to/state conversation compact alice CONVERSATION --request-id compact-1
ghost --root /path/to/state conversation run alice
```

Create with `--model PROVIDER/MODEL` for an actual configured provider, and
`--tools` to advertise tools. Input `--kind steer` attaches to active work;
`--kind follow-up` queues the next generation. `conversation spawn` creates an
analysis-only child (`--background` detaches its lifecycle). `conversation
cancel` cancels an owned task tree. `conversation events --after REVISION`
reads commit metadata. `conversation reconcile PROFILE EFFECT_KEY --result-json
JSON` accepts a definitive ToolOutput (`status`, `summary`, `next_actions`,
`artifacts`, `content`) after the owner verifies the real effect. Reconciliation
never issues another write.

All run commands take a bounded `--steps` budget. Model turn/time/retry and
compaction limits are also configurable through AgentConfig. Actual model
responses and filesystem sandbox guarantees remain separate from offline
mock/crash tests.
