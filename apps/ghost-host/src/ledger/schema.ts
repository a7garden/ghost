import type { GhostTool } from "@ghost/contract";

/** The selectable tools when migration 3 was written. Migrations are immutable; later tools are opt-in. */
export const MIGRATION_3_TOOLS: readonly GhostTool[] = [
  "work_create", "work_list", "work_inspect", "work_update", "work_cancel", "schedule_create", "schedule_list", "schedule_cancel",
  "ghost_list", "read", "write", "edit", "bash", "publish_artifact", "delegate", "memory_search", "memory_recall", "memory_retain",
  "document_spaces", "document_list", "document_read", "document_propose",
];

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
    grants TEXT NOT NULL, -- Unused since 2026-11-08; kept so the previous release stays readable.
    push_token TEXT,
    push_environment TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE pairings (
    code_hash TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    grants TEXT NOT NULL, -- Unused since 2026-11-08; kept so the previous release stays readable.
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
  /* 2: no privacy tiers or local providers; every configured provider runs everything */ `
  ALTER TABLE conversations DROP COLUMN privacy;
  ALTER TABLE providers DROP COLUMN local;
  `,
  /* 3: explicit per-Ghost tool allow-lists; established Ghosts keep the full set they effectively had (frozen: the tool list as of migration 3) */ `
  ALTER TABLE ghosts ADD COLUMN tools TEXT NOT NULL DEFAULT '${JSON.stringify(MIGRATION_3_TOOLS)}';
  `,
  /* 4: per-Ghost model fallbacks and skills; deleted Ghosts stay as tombstones for their past Works */ `
  ALTER TABLE ghosts ADD COLUMN fallbacks TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE ghosts ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE ghosts ADD COLUMN deleted_at INTEGER;
  `,
  /* 5: reserve API identities before asynchronous effects; old receipts are complete */ `
  ALTER TABLE requests ADD COLUMN state TEXT NOT NULL DEFAULT 'done' CHECK (state IN ('pending', 'done'));
  `,
  /* 6: parent-first questions and bounded internal revision lessons */ `
  ALTER TABLE works ADD COLUMN revise_history TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE works ADD COLUMN question_nudges INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE work_questions (
    id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES works(id),
    parent_work_id TEXT NOT NULL REFERENCES works(id),
    question TEXT NOT NULL,
    answer TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending','answered','cancelled')),
    created_at INTEGER NOT NULL,
    answered_at INTEGER,
    submitted_at INTEGER,
    answer_submitted_at INTEGER,
    nudge_count INTEGER NOT NULL DEFAULT 0,
    cancellation_reason TEXT,
    cancellation_submitted_at INTEGER
  );
  CREATE INDEX work_questions_by_work ON work_questions(work_id, state);
  CREATE INDEX work_questions_by_parent ON work_questions(parent_work_id, state);
  `,
];
