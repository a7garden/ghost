-- Coordinator-owned canonical owner/advisory turns; original receipts are immutable.
CREATE TABLE IF NOT EXISTS lifetime_turns (
 id TEXT PRIMARY KEY,
 ghost_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence > 0),
 sender_kind TEXT NOT NULL,
 sender_ref TEXT NOT NULL,
 text TEXT NOT NULL,
 privacy TEXT NOT NULL CHECK(privacy IN ('public','private','local_only')),
 kind TEXT NOT NULL CHECK(kind IN ('user','assistant_advisory','host_fact')),
 source_turn_id TEXT REFERENCES lifetime_turns(id),
 attachments TEXT NOT NULL CHECK(json_valid(attachments)),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
 UNIQUE(ghost_id,conversation_id,sequence));
CREATE INDEX IF NOT EXISTS lifetime_turn_history ON lifetime_turns(ghost_id,conversation_id,sequence);
CREATE TABLE IF NOT EXISTS lifetime_conversation_disclosure (
 ghost_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 privacy TEXT NOT NULL CHECK(privacy IN ('public','private','local_only')),
 PRIMARY KEY(ghost_id,conversation_id));
CREATE TABLE IF NOT EXISTS lifetime_turn_goals (
 turn_id TEXT NOT NULL REFERENCES lifetime_turns(id),
 goal_id TEXT NOT NULL UNIQUE REFERENCES lifetime_goals(id),
 PRIMARY KEY(turn_id,goal_id));
-- Normalize current binding identity, not cached historical responses or SDK IDs.
UPDATE lifetime_bindings SET runtime_kind='pi-durable' WHERE runtime_kind='pi';
