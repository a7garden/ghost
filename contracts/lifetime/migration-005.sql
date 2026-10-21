-- Expand-only migration; the coordinator applies this in the existing workspace DB.
CREATE TABLE IF NOT EXISTS lifetime_bindings (
 conversation_id TEXT PRIMARY KEY, ghost_id TEXT NOT NULL, runtime_kind TEXT NOT NULL,
 runtime_release TEXT NOT NULL, storage_ref TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lifetime_goals (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 1),
 requirement_digest TEXT NOT NULL, accountable_ghost TEXT NOT NULL, reply_conversation TEXT NOT NULL,
 privacy TEXT NOT NULL CHECK(privacy IN ('public','private','local_only')), state TEXT NOT NULL,
 payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lifetime_work (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES lifetime_goals(id),
 goal_revision INTEGER NOT NULL CHECK(goal_revision >= 1), owner TEXT NOT NULL,
 owner_revision INTEGER NOT NULL CHECK(owner_revision >= 1), state TEXT NOT NULL,
 execution_id TEXT UNIQUE, cancellation TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lifetime_commands (
 command_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL, actor_ref TEXT NOT NULL,
 authority_epoch INTEGER NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lifetime_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL REFERENCES lifetime_commands(command_id),
 target TEXT NOT NULL, payload TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
 UNIQUE(command_id,target));
CREATE TABLE IF NOT EXISTS lifetime_inbox (
 producer TEXT NOT NULL, epoch INTEGER NOT NULL, sequence INTEGER NOT NULL,
 payload_digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(producer,epoch,sequence));
CREATE TABLE IF NOT EXISTS lifetime_results (
 execution_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES lifetime_work(id),
 goal_revision INTEGER NOT NULL, payload_digest TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lifetime_acceptances (
 work_id TEXT PRIMARY KEY REFERENCES lifetime_work(id), goal_revision INTEGER NOT NULL,
 artifact_digest TEXT NOT NULL, verifier_revision TEXT NOT NULL, payload TEXT NOT NULL);
