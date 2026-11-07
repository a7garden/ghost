/**
 * Ledger migrations, applied in order inside one transaction each.
 * `PRAGMA user_version` records how many have run. Append only.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1 */ `
  CREATE TABLE ghosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    persona TEXT NOT NULL,
    look TEXT NOT NULL,
    model TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('active','paused','retired')),
    direct_conversation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX ghosts_one_default ON ghosts(is_default) WHERE is_default = 1;

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    ghost_id TEXT NOT NULL REFERENCES ghosts(id),
    kind TEXT NOT NULL CHECK (kind IN ('direct','work','review')),
    work_id TEXT,
    title TEXT NOT NULL,
    privacy TEXT NOT NULL CHECK (privacy IN ('public','private','local')),
    model TEXT,
    busy INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    pi_conversation_id TEXT UNIQUE
  );
  CREATE INDEX conversations_by_ghost ON conversations(ghost_id, kind);
  CREATE UNIQUE INDEX conversations_one_work ON conversations(work_id, kind) WHERE work_id IS NOT NULL;

  CREATE TABLE works (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES works(id),
    root_id TEXT NOT NULL,
    ghost_id TEXT NOT NULL REFERENCES ghosts(id),
    origin_conversation_id TEXT NOT NULL REFERENCES conversations(id),
    conversation_id TEXT REFERENCES conversations(id),
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    acceptance TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running','waiting','verifying','blocked','done','failed','cancelled')),
    revision INTEGER NOT NULL,
    revisions_used INTEGER NOT NULL DEFAULT 0,
    idle_nudges INTEGER NOT NULL DEFAULT 0,
    reported_at INTEGER,
    deadline_at INTEGER,
    result TEXT,
    verdict TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX works_by_parent ON works(parent_id);
  CREATE INDEX works_by_state ON works(state, updated_at);
  CREATE INDEX works_by_ghost ON works(ghost_id, updated_at);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ghost_id TEXT NOT NULL REFERENCES ghosts(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    work_id TEXT REFERENCES works(id),
    effect_id TEXT,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    options TEXT NOT NULL,
    proposal TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','answered','cancelled')),
    answer TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    followed_up_at INTEGER
  );
  CREATE INDEX decisions_by_state ON decisions(state, created_at);
  CREATE INDEX decisions_by_work ON decisions(work_id);

  CREATE TABLE effects (
    id TEXT PRIMARY KEY,
    work_id TEXT REFERENCES works(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    call_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','done','unknown','denied')),
    result TEXT,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    UNIQUE (conversation_id, call_id)
  );
  CREATE INDEX effects_by_work ON effects(work_id);
  CREATE INDEX effects_by_state ON effects(state);

  CREATE TABLE artifacts (
    digest TEXT NOT NULL,
    work_id TEXT REFERENCES works(id),
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (digest, work_id, name)
  );
  CREATE INDEX artifacts_by_work ON artifacts(work_id);

  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    ghost_id TEXT NOT NULL REFERENCES ghosts(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    prompt TEXT NOT NULL,
    spec TEXT NOT NULL,
    next_at INTEGER,
    state TEXT NOT NULL CHECK (state IN ('active','paused','done')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX schedules_due ON schedules(state, next_at);

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ghost_id TEXT,
    conversation_id TEXT,
    work_id TEXT,
    decision_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    pushed_at INTEGER
  );
  CREATE INDEX notifications_recent ON notifications(created_at);
  CREATE INDEX notifications_unpushed ON notifications(pushed_at) WHERE pushed_at IS NULL;

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    grants TEXT NOT NULL,
    push_token TEXT,
    push_environment TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE pairings (
    code_hash TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    grants TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    device_id TEXT
  );

  CREATE TABLE spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    grants TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE avatars (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    image_digest TEXT NOT NULL,
    design TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT,
    models TEXT NOT NULL,
    local INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    digest TEXT NOT NULL,
    outcome TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX events_at ON events(at);
  `,
];
