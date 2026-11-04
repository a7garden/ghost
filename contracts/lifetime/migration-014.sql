-- Additive: permit the briefing notification event kind for Owner-approved
-- wake schedules (G06). The table is rebuilt with every existing row copied
-- unchanged; work_id remains a real lifetime_work reference (the wake fires a
-- briefing Goal whose terminal Work result carries the notification), so no
-- foreign-key semantics are repurposed. The notification event kind is derived
-- from the durable wake run ledger, not from acceptance_spec JSON.
CREATE TABLE IF NOT EXISTS lifetime_notifications_v14 (
 id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 work_id TEXT NOT NULL REFERENCES lifetime_work(id), goal_revision INTEGER NOT NULL,
 event_kind TEXT NOT NULL CHECK(event_kind IN ('result','acceptance','briefing')),
 state TEXT NOT NULL CHECK(state IN ('pending','transport_accepted','client_seen')),
 UNIQUE(recipient_id,work_id,goal_revision,event_kind));
INSERT INTO lifetime_notifications_v14
 SELECT id,recipient_id,conversation_id,work_id,goal_revision,event_kind,state FROM lifetime_notifications;
DROP TABLE lifetime_notifications;
ALTER TABLE lifetime_notifications_v14 RENAME TO lifetime_notifications;
