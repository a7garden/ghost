-- Additive lifetime collaboration state. Existing identity and work rows are preserved.
CREATE TABLE IF NOT EXISTS lifetime_registry (
 ghost_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('primary','specialist')),
 conversation_id TEXT NOT NULL UNIQUE, roles TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('active','draining')));
CREATE UNIQUE INDEX IF NOT EXISTS lifetime_one_primary ON lifetime_registry(kind) WHERE kind='primary';
CREATE TABLE IF NOT EXISTS lifetime_mailbox (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, sender_id TEXT NOT NULL,
 message_id TEXT NOT NULL, recipient_id TEXT NOT NULL REFERENCES lifetime_registry(ghost_id),
 payload_digest TEXT NOT NULL, privacy TEXT NOT NULL CHECK(privacy IN ('public','private','local_only')),
 payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','transport_accepted','client_seen')),
 UNIQUE(sender_id,message_id,recipient_id));
CREATE TABLE IF NOT EXISTS lifetime_notifications (
 id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 work_id TEXT NOT NULL REFERENCES lifetime_work(id), goal_revision INTEGER NOT NULL,
 event_kind TEXT NOT NULL CHECK(event_kind IN ('result','acceptance')),
 state TEXT NOT NULL CHECK(state IN ('pending','transport_accepted','client_seen')),
 UNIQUE(recipient_id,work_id,goal_revision,event_kind));
