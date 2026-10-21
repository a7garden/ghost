-- Host schema 6 adds auditable receiver ACKs; wire contract revision 1 is unchanged.
-- Existing acknowledged intents are not reset or blindly redispatched.
CREATE TABLE IF NOT EXISTS lifetime_delivery_receipts (
 outbox_id INTEGER PRIMARY KEY REFERENCES lifetime_outbox(id),
 receiver_command_id TEXT NOT NULL UNIQUE,
 receipt_digest TEXT NOT NULL,
 payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lifetime_verification_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 verifier_revision TEXT NOT NULL,
 policy_revision INTEGER NOT NULL CHECK(policy_revision>=1));
INSERT OR IGNORE INTO lifetime_verification_policy(singleton,verifier_revision,policy_revision)
 VALUES(1,'ghost-artifact-verifier/1',1);
