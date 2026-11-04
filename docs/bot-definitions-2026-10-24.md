# Bot definitions and Work pins

The source now supports versioned definitions for an existing registered Ghost.
This is B1 definition storage and admission pinning, not bot provisioning or a
deployment result. Ghost uses Pi as its execution engine; these records introduce
no execution process, scheduler, memory engine or resource grant.

`host::bots::BotDefinition::new` creates a definition with the existing lifetime
canonical SHA-256 calculation. The digest binds the Ghost UUID, revision and
content. Content records purpose, input/output contracts, instruction, acceptance,
execution and optional memory profile references, required capabilities and
explicit skill revision references. References retain namespace, ID, revision
and digest. Deserialized definitions are checked again before use.

## Authenticated Owner API

The existing `Command::Lifetime` control surface accepts:

- `bot.definition.update`: body fields are `method` and `definition`.
  `expected_revision` is absent for initial revision 1; later updates require the
  currently selected revision and advance exactly once. The Host verifies the
  actual profile and the lifetime handler requires its registered identity.
- `bot.definition.inspect`: body fields are `method`, `ghost_id`, and optional
  `revision`. Omitting revision reads the selected definition. Inspection is
  read-only and works with dispatch disabled at the current authority epoch.

Both commands use existing authority fences and command receipts. An exact
command replay returns its original result. An update with stale revision or a
different body under an existing command ID cannot replace an earlier revision.
The selected definition is not evidence that its referenced resources exist or
are ready. Responses explicitly report `readiness: not_evaluated` and
`grants_changed: false`; policy, registry mode and profile persona are unchanged.
Updating a definition cannot clone a Ghost or copy private resources.

## Journal and Work ownership

The existing workspace database stores `bot_definition_v1`,
`bot_definition_active_v1` and `bot_definition_work_pin_v1` objects. Immutable
revision insertion, pointer CAS and the command receipt commit in the lifetime
transaction. No additional database or schema migration is introduced.

New Work admission records the selected definition in the same transaction.
The pin includes Work identity, goal revision, owner revision and Ghost identity.
An explicit new Work revision may select the current definition; ordinary status
updates and reads cannot. Exact revision bytes are resolved and checked by digest.
An older definition remains available after a newer revision is selected.

A new Work admitted without a definition gets an explicit empty pin. Existing
Work without any pin keeps its legacy behavior. Neither becomes associated with
a definition merely because one is selected later. Admission does not rewrite
existing UUIDs, conversations, personas, homes or historical Work records.

## Current boundaries

The pure `adapters::memory_bindings` compatibility parser validates the existing
scalar owner-to-space map, rejects duplicate owner keys, and resolves only the
original mapped space and an explicit subset of Host-authenticated capabilities.
The optional [scoped adapter integration](scoped-memory-bindings.md) resolves
explicit credentials and uses fresh narrow sessions for read composition and
own-source effects. It never discovers or grants project/common access. The
pure compatibility parser remains independent of that transport. End-to-end
B2 acceptance still requires Pi context invalidation and the corresponding
integration evidence.

Definition validation does not resolve instruction/skill/profile references,
evaluate candidates, provision resources or activate a new bot. B4 readiness,
B5 shared catalogue adoption/rollback and B6 source-view publication remain
separate work. Experience documents continue to require the existing PDC writer;
definition metadata and Work pins are execution records outside that document
plane.
