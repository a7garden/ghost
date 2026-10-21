-- Host schema 13 correlates one canonical advisory with an existing authoritative
-- Pi report outbox. Preserve every prior intent, ACK, turn and acceptance.
CREATE TABLE IF NOT EXISTS lifetime_report_replies (
 report_id TEXT PRIMARY KEY,
 outbox_id INTEGER NOT NULL UNIQUE REFERENCES lifetime_outbox(id),
 reply_turn_id TEXT NOT NULL UNIQUE REFERENCES lifetime_turns(id),
 text_digest TEXT NOT NULL);
