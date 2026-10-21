-- Controller lifecycle is separate from immutable Owner/advisory turns.
CREATE TABLE IF NOT EXISTS lifetime_turn_runs (
 turn_id TEXT PRIMARY KEY REFERENCES lifetime_turns(id),
 ghost_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','answered','failed','cancelled','effect_unknown')),
 cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
 cancel_command_id TEXT,
 submission_id TEXT,
 entry_id TEXT,
 reason_code TEXT,
 latest_status_command_id TEXT,
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0));
CREATE INDEX IF NOT EXISTS lifetime_turn_runs_pair ON lifetime_turn_runs(ghost_id,conversation_id,created_at_ms);
-- No prior turn is guessed queued or submitted again. Real SDK reconciliation
-- may later resolve an unknown outcome using its original committed identity.
INSERT INTO lifetime_turn_runs(turn_id,ghost_id,conversation_id,state,created_at_ms,updated_at_ms)
 SELECT t.id,t.ghost_id,t.conversation_id,
 CASE WHEN EXISTS(SELECT 1 FROM lifetime_turns r WHERE r.source_turn_id=t.id AND r.kind='assistant_advisory')
      THEN 'answered' ELSE 'effect_unknown' END,
 t.created_at_ms,t.created_at_ms
 FROM lifetime_turns t WHERE t.kind='user' AND t.sender_kind='owner' AND t.sender_ref='owner'
 ON CONFLICT(turn_id) DO NOTHING;
