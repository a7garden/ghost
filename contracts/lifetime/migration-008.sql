-- Host schema 8 permits several receiver intents per authoritative command.
-- Existing outbox IDs, payloads, ACK state and correlated receipts are preserved.
-- Run once, inside the Host migration transaction, with foreign_keys enabled.
CREATE TABLE lifetime_outbox_next (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 command_id TEXT NOT NULL REFERENCES lifetime_commands(command_id),
 target TEXT NOT NULL,
 delivery_ref TEXT NOT NULL,
 payload TEXT NOT NULL,
 acknowledged INTEGER NOT NULL DEFAULT 0,
 UNIQUE(command_id,target,delivery_ref));
INSERT INTO lifetime_outbox_next(id,command_id,target,delivery_ref,payload,acknowledged)
 SELECT id,command_id,target,json_extract(payload,'$.command_id'),payload,acknowledged
 FROM lifetime_outbox;
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='lifetime_outbox'),0))
 WHERE name='lifetime_outbox_next';
CREATE TABLE lifetime_delivery_receipts_next (
 outbox_id INTEGER PRIMARY KEY REFERENCES lifetime_outbox_next(id),
 receiver_command_id TEXT NOT NULL UNIQUE,
 receipt_digest TEXT NOT NULL,
 payload TEXT NOT NULL);
INSERT INTO lifetime_delivery_receipts_next SELECT * FROM lifetime_delivery_receipts;
DROP TABLE lifetime_delivery_receipts;
DROP TABLE lifetime_outbox;
ALTER TABLE lifetime_outbox_next RENAME TO lifetime_outbox;
ALTER TABLE lifetime_delivery_receipts_next RENAME TO lifetime_delivery_receipts;
