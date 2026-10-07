//! Ghosts coordination core: one bounded, one-level delegation workflow with
//! exactly two worker assignments owned by an existing Ghost. The coordinator
//! journal (`root/ghosts/manager.db`) is execution-core state, not UI state;
//! each worker Ghost SQLite remains the source of its tasks/inbox/outbox and
//! journal results are validated copies linked by IDs. No networking, no new
//! auth, no A2A/rmcp engine, no shared global conversation, no cross-DB
//! atomicity is promised.

use anyhow::{anyhow, bail, Context, Result};
use fs2::FileExt;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use crate::protocol::{self, DelegationEnvelope};
use crate::provider::Provider;
use crate::run_task;
use crate::store::{validate_name, ProfileStore, Task};

fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string()
}

fn is_symlink(p: &Path) -> bool {
    p.symlink_metadata()
        .map(|m| m.is_symlink())
        .unwrap_or(false)
}

/// Durable receiver message key namespaced by BOTH sender UUID and message id
/// so the same message_id from different senders can never collide. The
/// worker store's own per-profile message_id uniqueness is untouched; this
/// key is what gets stored as the worker task's message id.
pub fn namespaced_message_key(sender_uuid: &str, message_id: &str) -> String {
    json!({"sender": sender_uuid, "message_id": message_id}).to_string()
}

#[derive(Serialize, Debug, Clone)]
pub struct WorkerSpec {
    pub profile: String,
    pub role: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct ParentSpec {
    pub request_id: String,
    pub owner_profile: String,
    pub title: String,
    pub workers: Vec<WorkerSpec>,
}

struct LockGuard(fs::File);
impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

pub struct Coordinator {
    conn: Connection,
    _lock: LockGuard,
    root: PathBuf,
    /// Fresh per process open; independent of enduring Ghost UUIDs.
    process_instance_id: String,
}

#[derive(Debug, Clone)]
struct ParentRow {
    id: i64,
    uuid: String,
    request_id: String,
    owner_profile: String,
    owner_uuid: String,
    title: String,
    status: String,
    aggregate: Option<String>,
    cancel_requested: i64,
}

#[derive(Debug, Clone)]
struct ChildRow {
    id: i64,
    seq: i64,
    delegation_id: String,
    role: String,
    worker_profile: String,
    worker_uuid: String,
    envelope: String,
    message_key: String,
    session_uuid: Option<String>,
    task_uuid: Option<String>,
    delivery_state: String,
    worker_status: Option<String>,
    artifact: Option<String>,
    cancel_state: String,
    last_error: Option<String>,
    attempt_id: Option<String>,
    process_instance_id: Option<String>,
}

const SCHEMA: &str = r#"
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS parents(
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  owner_profile TEXT NOT NULL,
  owner_uuid TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  aggregate TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_uuid, request_id)
);
CREATE TABLE IF NOT EXISTS children(
  id INTEGER PRIMARY KEY,
  parent_id INTEGER NOT NULL REFERENCES parents(id),
  seq INTEGER NOT NULL,
  delegation_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  worker_profile TEXT NOT NULL,
  worker_uuid TEXT NOT NULL,
  envelope TEXT NOT NULL,
  message_key TEXT NOT NULL,
  session_uuid TEXT,
  task_uuid TEXT,
  delivery_state TEXT NOT NULL DEFAULT 'pending',
  worker_status TEXT,
  artifact TEXT,
  cancel_state TEXT NOT NULL DEFAULT 'none',
  last_error TEXT,
  attempt_id TEXT,
  process_instance_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;

/// Read profile identity from the existing profile DB read-only: no recovery,
/// no grant mutation, no accidental profile creation. Rejects symlinked
/// profiles directory, profile state directory and database so identity can
/// never be aliased or retargeted.
fn read_identity(root: &Path, profile: &str) -> Result<(String, String)> {
    validate_name(profile)?;
    let profiles_dir = root.join("profiles");
    if is_symlink(&profiles_dir) {
        bail!("profiles directory must not be a symlink");
    }
    let dir = profiles_dir.join(profile);
    if is_symlink(&dir) {
        bail!("profile state directory must not be a symlink");
    }
    let db = dir.join("ghost.db");
    if is_symlink(&db) {
        bail!("profile database must not be a symlink");
    }
    if !db.is_file() {
        bail!("profile '{}' not found", profile);
    }
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("reading identity of '{}'", profile))?;
    let row = conn
        .query_row("SELECT uuid, persona FROM meta WHERE id=1", [], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .optional()?;
    match row {
        Some((uuid, persona)) => Ok((uuid, persona)),
        None => bail!("profile '{}' has no identity row", profile),
    }
}

fn child_env(ch: &ChildRow) -> Result<DelegationEnvelope> {
    serde_json::from_str(&ch.envelope).context("corrupt envelope in journal")
}

impl Coordinator {
    /// Open (or create) the coordinator journal under `root/ghosts`, holding
    /// an exclusive fs2 writer lock for this coordinator's lifetime. Symlinked
    /// journal paths are rejected BEFORE any directory creation or write.
    pub fn open(root: &Path) -> Result<Coordinator> {
        let root_c = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let ghosts_dir = root_c.join("ghosts");
        if is_symlink(&ghosts_dir) {
            bail!("ghosts directory must not be a symlink");
        }
        let db_path = ghosts_dir.join("manager.db");
        if is_symlink(&db_path) {
            bail!("coordinator journal must not be a symlink");
        }
        fs::create_dir_all(&ghosts_dir).context("creating ghosts directory")?;
        let lock_path = ghosts_dir.join("manager.lock");
        if is_symlink(&lock_path) {
            bail!("coordinator lock file path must not be a symlink");
        }
        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)
            .with_context(|| format!("opening {}", lock_path.display()))?;
        lock_file
            .try_lock_exclusive()
            .map_err(|_| anyhow!("coordinator journal is locked by another writer"))?;
        let conn = Connection::open(&db_path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Coordinator {
            conn,
            _lock: LockGuard(lock_file),
            root: root_c,
            process_instance_id: uuid::Uuid::new_v4().to_string(),
        })
    }

    /// Public for deterministic fault-injection tests only (e.g. a trigger on
    /// the exact ACK update of `task_uuid`). Normal code never mutates the
    /// journal outside the coordinator methods.
    pub fn journal_conn(&self) -> &Connection {
        &self.conn
    }

    fn parent_by_uuid(&self, uuid: &str) -> Result<Option<ParentRow>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, uuid, request_id, owner_profile, owner_uuid, title, status, aggregate, cancel_requested \
                 FROM parents WHERE uuid=?1",
                params![uuid],
                ParentRow::from_row,
            )
            .optional()?)
    }

    fn children(&self, parent_id: i64) -> Result<Vec<ChildRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, seq, delegation_id, role, worker_profile, worker_uuid, envelope, message_key, \
             session_uuid, task_uuid, delivery_state, worker_status, artifact, cancel_state, last_error, \
             attempt_id, process_instance_id FROM children WHERE parent_id=?1 ORDER BY seq",
        )?;
        let rows = stmt.query_map(params![parent_id], ChildRow::from_row)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    fn child_by_id(&self, id: i64) -> Result<Option<ChildRow>> {
        Ok(self.children_by_id(id)?.into_iter().next())
    }

    fn children_by_id(&self, id: i64) -> Result<Vec<ChildRow>> {
        let parent_id: i64 = self.conn.query_row(
            "SELECT parent_id FROM children WHERE id=?1",
            params![id],
            |r| r.get(0),
        )?;
        Ok(self
            .children(parent_id)?
            .into_iter()
            .filter(|c| c.id == id)
            .collect())
    }

    /// Prevalidate EVERY child (and current host identities) before any
    /// dispatch or cancellation side effect: a corrupt second envelope must
    /// make the whole pass fail closed with zero provider calls.
    fn prevalidate(&self, parent: &ParentRow, children: &[ChildRow]) -> Result<()> {
        if children.len() != 2 {
            bail!("workflow must carry exactly two worker assignments");
        }
        let (owner_uuid_now, _) = read_identity(&self.root, &parent.owner_profile)?;
        if owner_uuid_now != parent.owner_uuid {
            bail!(
                "owner profile '{}' identity drifted from the recorded owner UUID; failing closed",
                parent.owner_profile
            );
        }
        let mut uuids: Vec<String> = Vec::new();
        let mut owner_included = false;
        for ch in children {
            let env = child_env(ch)?;
            protocol::validate(&env)?;
            if env.workflow_id != parent.uuid
                || env.root_task_id != parent.uuid
                || env.parent_task_id != parent.uuid
            {
                bail!("envelope lineage does not match the parent workflow; failing closed");
            }
            if env.delegation_id != ch.delegation_id {
                bail!("envelope delegation id does not match the child record; failing closed");
            }
            if env.sender_uuid != parent.owner_uuid {
                bail!("envelope sender does not match parent owner identity; rejecting");
            }
            if env.recipient_uuid != ch.worker_uuid {
                bail!("recipient identity drift detected; refusing to redirect work");
            }
            if env.role != ch.role {
                bail!("envelope role does not match the child record; failing closed");
            }
            if env.objective != parent.title {
                bail!("envelope objective does not match the parent title; failing closed");
            }
            let expected_prompt = format!("[role:{}] {}", ch.role, parent.title);
            if env.task_prompt != expected_prompt {
                bail!("envelope task prompt is not the host-derived role prompt; failing closed");
            }
            if ch.message_key != namespaced_message_key(&parent.owner_uuid, &env.message_id) {
                bail!("child message key is not the sender-namespaced key; failing closed");
            }
            let (worker_uuid_now, _) = read_identity(&self.root, &ch.worker_profile)?;
            if worker_uuid_now != ch.worker_uuid {
                bail!(
                    "worker profile '{}' identity drifted from the recorded worker UUID; failing closed",
                    ch.worker_profile
                );
            }
            if worker_uuid_now == parent.owner_uuid {
                owner_included = true;
            }
            uuids.push(worker_uuid_now);
        }
        if uuids[0] == uuids[1] {
            bail!("the two workers must be distinct identities (UUIDs)");
        }
        let roles: Vec<&str> = children.iter().map(|c| c.role.as_str()).collect();
        if roles[0] == roles[1] {
            bail!("the two roles must be distinct");
        }
        if !owner_included {
            bail!("the owner must be one of the two workers");
        }
        Ok(())
    }

    /// Revalidate the durable selected worker task against the journal child
    /// before any execution or cancellation side effect. Prevents an ACKed
    /// journal task_uuid pointing at an unrelated (e.g. permitted-write) task.
    fn validate_selected_task(
        &self,
        ch: &ChildRow,
        store: &ProfileStore,
        task: &Task,
    ) -> Result<()> {
        if store.uuid != ch.worker_uuid {
            bail!(
                "opened worker store identity does not match the recorded worker UUID; failing closed"
            );
        }
        let task_uuid = ch
            .task_uuid
            .as_deref()
            .ok_or_else(|| anyhow!("acked child missing task uuid"))?;
        if task.uuid != task_uuid {
            bail!("selected worker task uuid does not match the ACKed journal pointer; failing closed");
        }
        if ch.session_uuid.as_deref() != Some(task.session_id.as_str()) {
            bail!("selected worker task session does not match the ACKed journal session; failing closed");
        }
        if task.message_id != ch.message_key {
            bail!("selected worker task message id is not the expected namespaced key; failing closed");
        }
        let env = child_env(ch)?;
        if task.prompt != env.task_prompt {
            bail!("selected worker task prompt differs from the envelope prompt; failing closed");
        }
        if task.read_path.is_some() || task.write_path.is_some() || task.write_content.is_some() {
            bail!("delegated worker task carries filesystem actions; failing closed");
        }
        if store.session(&task.session_id)?.is_none() {
            bail!("selected worker task session no longer exists; failing closed");
        }
        Ok(())
    }

    /// Create a parent request with exactly two unique worker assignments; the
    /// owner must be one of them. Exact replay of (owner_uuid, request_id)
    /// returns the same parent after comparing current identities (UUIDs)
    /// against the saved record; a conflicting spec is rejected.
    pub fn create(&self, spec: &ParentSpec) -> Result<String> {
        validate_name(&spec.owner_profile)?;
        if spec.request_id.trim().is_empty() {
            bail!("request_id must not be empty");
        }
        if spec.title.trim().is_empty() {
            bail!("title must not be empty");
        }
        if spec.workers.len() != 2 {
            bail!("exactly two worker assignments are required");
        }
        if spec.workers[0].profile == spec.workers[1].profile {
            bail!("the two workers must be different profiles/UUIDs");
        }
        if spec.workers[0].role == spec.workers[1].role {
            bail!("the two roles must differ");
        }
        for w in &spec.workers {
            validate_name(&w.profile)?;
            if w.role.trim().is_empty() {
                bail!("role must not be empty");
            }
        }
        if !spec.workers.iter().any(|w| w.profile == spec.owner_profile) {
            bail!("the owner must be one of the two workers");
        }
        let (owner_uuid, _persona) = read_identity(&self.root, &spec.owner_profile)?;
        // Compare two ACTUAL UUIDs, not only profile names.
        let (uuid0, _) = read_identity(&self.root, &spec.workers[0].profile)?;
        let (uuid1, _) = read_identity(&self.root, &spec.workers[1].profile)?;
        if uuid0 == uuid1 {
            bail!("the two workers must be different profiles/UUIDs");
        }

        self.conn.execute("BEGIN IMMEDIATE", [])?;
        let res = (|| -> Result<String> {
            if let Some(existing) = self
                .conn
                .query_row(
                    "SELECT uuid FROM parents WHERE owner_uuid=?1 AND request_id=?2",
                    params![owner_uuid, spec.request_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                // Replay: compare immutable spec (title + ordered workers with
                // CURRENT identity UUIDs; drift fails closed).
                let p = self
                    .parent_by_uuid(&existing)?
                    .ok_or_else(|| anyhow!("journal inconsistent"))?;
                if p.title != spec.title {
                    bail!("request_id '{}' already used with a different objective; refusing conflicting reuse", spec.request_id);
                }
                let kids = self.children(p.id)?;
                let current = [uuid0, uuid1];
                let same =
                    kids.len() == spec.workers.len()
                        && kids.iter().zip(&spec.workers).zip(current.iter()).all(
                            |((c, w), cu)| {
                                c.worker_profile == w.profile
                                    && c.role == w.role
                                    && c.worker_uuid == *cu
                            },
                        );
                if !same {
                    bail!("request_id '{}' already used with different workers or drifted identities; refusing conflicting reuse", spec.request_id);
                }
                return Ok(existing);
            }
            if self
                .conn
                .query_row(
                    "SELECT uuid FROM parents WHERE request_id=?1 AND owner_profile=?2 LIMIT 1",
                    params![spec.request_id, spec.owner_profile],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .is_some()
            {
                bail!(
                    "request_id '{}' already used under a different owner identity; refusing reuse",
                    spec.request_id
                );
            }
            let parent_uuid = uuid::Uuid::new_v4().to_string();
            let t = now();
            self.conn.execute(
                "INSERT INTO parents(uuid, request_id, owner_profile, owner_uuid, title, status, cancel_requested, created_at, updated_at) \
                 VALUES(?1,?2,?3,?4,?5,'pending',0,?6,?6)",
                params![
                    parent_uuid,
                    spec.request_id,
                    spec.owner_profile,
                    owner_uuid,
                    spec.title,
                    t
                ],
            )?;
            let parent_id = self.conn.last_insert_rowid();
            let worker_uuids = [uuid0, uuid1];
            for (seq, w) in spec.workers.iter().enumerate() {
                let worker_uuid = worker_uuids[seq].clone();
                let envelope = DelegationEnvelope {
                    version: protocol::PROTOCOL_VERSION,
                    workflow_id: parent_uuid.clone(),
                    root_task_id: parent_uuid.clone(),
                    parent_task_id: parent_uuid.clone(),
                    delegation_id: uuid::Uuid::new_v4().to_string(),
                    sender_uuid: owner_uuid.clone(),
                    recipient_uuid: worker_uuid.clone(),
                    message_id: uuid::Uuid::new_v4().to_string(),
                    role: w.role.clone(),
                    capability_ceiling: protocol::text_only_ceiling(),
                    objective: spec.title.clone(),
                    task_prompt: format!("[role:{}] {}", w.role, spec.title),
                };
                protocol::validate(&envelope)
                    .with_context(|| format!("worker '{}' envelope invalid", w.profile))?;
                let key = namespaced_message_key(&owner_uuid, &envelope.message_id);
                self.conn.execute(
                    "INSERT INTO children(parent_id, seq, delegation_id, role, worker_profile, worker_uuid, envelope, message_key, delivery_state, cancel_state, created_at, updated_at) \
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'pending','none',?9,?9)",
                    params![
                        parent_id,
                        seq as i64,
                        envelope.delegation_id,
                        w.role,
                        w.profile,
                        worker_uuid,
                        serde_json::to_string(&envelope)?,
                        key,
                        t
                    ],
                )?;
            }
            Ok(parent_uuid)
        })();
        match res {
            Ok(uuid) => {
                self.conn.execute("COMMIT", [])?;
                Ok(uuid)
            }
            Err(e) => {
                self.conn.execute("ROLLBACK", [])?;
                Err(e)
            }
        }
    }

    /// One bounded pass: prevalidate everything, deliver at most once per
    /// child, execute at most one real queued worker task per child, harvest
    /// strictly correlated results, then aggregate. Repeated runs never
    /// duplicate worker tasks, outbox rows, attempts or results.
    pub fn run(&self, workflow: &str, provider: &dyn Provider) -> Result<Value> {
        let parent = self
            .parent_by_uuid(workflow)?
            .ok_or_else(|| anyhow!("workflow '{}' not found", workflow))?;
        let children = self.children(parent.id)?;
        // ALL children are prevalidated (envelopes + live identities) BEFORE
        // any dispatch or cancellation side effect.
        self.prevalidate(&parent, &children)?;
        // A rejected delivery terminates this parent. Reopening it may read
        // its durable partial results but must not start remaining work.
        if parent.status == "failed"
            && children
                .iter()
                .any(|child| child.delivery_state == "rejected")
        {
            return self.snapshot_value(workflow);
        }
        for ch in children {
            if parent.cancel_requested != 0 {
                self.propagate_cancel_child(&ch)?;
                continue;
            }
            let mut ch = ch;
            if ch.delivery_state == "pending" {
                let delivered = match self.deliver(&ch) {
                    Ok(delivered) => delivered,
                    Err(error) => {
                        // Rejection is durable before the error is returned.
                        // Report the failed parent and retain any independently
                        // completed sibling artifact without retrying work.
                        if self
                            .child_by_id(ch.id)?
                            .is_some_and(|child| child.delivery_state == "rejected")
                        {
                            self.aggregate(&parent)
                                .context("persisting parent status after delivery rejection")?;
                        }
                        return Err(error);
                    }
                };
                if !delivered {
                    continue; // busy/unavailable: explicit pending, other worker proceeds
                }
                ch = self
                    .child_by_id(ch.id)?
                    .ok_or_else(|| anyhow!("journal inconsistent after ACK"))?;
            }
            if ch.delivery_state == "acked" {
                self.execute_and_harvest(&ch, provider)?;
            }
        }
        self.aggregate(&parent)?;
        self.snapshot_value(workflow)
    }

    /// Persisted-intent delivery. Returns Ok(true) when ACKed. An orphan
    /// session from a failed post-submit coordinator update is tolerable; the
    /// stable namespaced key dedups on the next run. Returns Ok(false) when
    /// the worker is busy/locked (stays pending).
    fn deliver(&self, ch: &ChildRow) -> Result<bool> {
        let store = match ProfileStore::open_profile(&self.root, &ch.worker_profile) {
            Ok(s) => s,
            Err(e) => {
                self.set_child_error(ch.id, &format!("worker busy or unavailable: {}", e))?;
                return Ok(false);
            }
        };
        if store.uuid != ch.worker_uuid {
            self.set_child_error(ch.id, "worker store identity drift detected")?;
            bail!("worker store identity drift detected; refusing to redirect work");
        }
        let env = child_env(ch)?;
        let existing = store.task_by_message(&ch.message_key)?;
        let (session_uuid, task_uuid) = match existing {
            Some(t) => {
                // A preexisting task with this key (e.g. after a lost ACK or a
                // forged inbox payload) must exactly match the expected
                // prompt/session identity and carry no filesystem action;
                // otherwise fail closed WITHOUT touching the payload.
                let ok = t.prompt == env.task_prompt
                    && t.read_path.is_none()
                    && t.write_path.is_none()
                    && t.write_content.is_none()
                    && store.session(&t.session_id)?.is_some();
                if !ok {
                    self.conn.execute(
                        "UPDATE children SET delivery_state='rejected', last_error=?2, updated_at=?3 WHERE id=?1",
                        params![ch.id, "existing inbox payload differs from expected spec; failing closed", now()],
                    )?;
                    bail!("existing inbox payload for key does not match expected spec; failing closed");
                }
                (t.session_id.clone(), t.uuid.clone())
            }
            None => {
                let session = store.create_session()?;
                match store.submit(
                    &session.uuid,
                    &ch.message_key,
                    &env.task_prompt,
                    None,
                    None,
                    None,
                ) {
                    Ok((t, _created)) => (session.uuid.clone(), t.uuid.clone()),
                    Err(e) => {
                        bail!("worker submit failed after session creation (unused orphan session tolerable): {}", e)
                    }
                }
            }
        };
        // ACK: only after the worker inbox commit. Accepted, NOT completed.
        // This exact UPDATE is the deterministic fault-injection point.
        self.conn
            .execute(
                "UPDATE children SET session_uuid=?1, task_uuid=?2, delivery_state='acked', last_error=NULL, updated_at=?3 \
                 WHERE id=?4 AND delivery_state='pending'",
                params![session_uuid, task_uuid, now(), ch.id],
            )
            .context("coordinator ACK transaction failed after worker inbox commit (recoverable; rerun will dedup)")?;
        Ok(true)
    }

    /// Execute only the selected delegated worker task (never drain unrelated
    /// queued tasks) and harvest its correlated outbox result into the journal.
    fn execute_and_harvest(&self, ch: &ChildRow, provider: &dyn Provider) -> Result<()> {
        let store = match ProfileStore::open_profile(&self.root, &ch.worker_profile) {
            Ok(s) => s,
            Err(e) => {
                self.set_child_error(ch.id, &format!("worker busy or unavailable: {}", e))?;
                return Ok(());
            }
        };
        let task_uuid = ch
            .task_uuid
            .clone()
            .ok_or_else(|| anyhow!("acked child missing task uuid"))?;
        let Some(task) = store.task(&task_uuid)? else {
            self.set_child_error(ch.id, "worker task disappeared")?;
            return Ok(());
        };
        // Revalidate the durable selected task against the journal child.
        self.validate_selected_task(ch, &store, &task)?;
        let task = match task.status.as_str() {
            "queued" => {
                // Persist attempt + this coordinator process instance BEFORE
                // the real execution; a harvested terminal result creates no
                // new attempt.
                let attempt_id = uuid::Uuid::new_v4().to_string();
                self.conn.execute(
                    "UPDATE children SET attempt_id=?1, process_instance_id=?2, updated_at=?3 WHERE id=?4",
                    params![attempt_id, self.process_instance_id, now(), ch.id],
                )?;
                let _ = run_task(&store, provider, task.id)?;
                store
                    .task(&task_uuid)?
                    .ok_or_else(|| anyhow!("worker task disappeared after execution"))?
            }
            // Terminal states are only harvested; 'running' cannot survive a
            // profile open (recovery marks it uncertain with no rerun).
            _ => task,
        };
        // Refresh the child row AFTER persisting the attempt so harvest
        // provenance records the persisted attempt/process ids.
        let ch = self
            .child_by_id(ch.id)?
            .ok_or_else(|| anyhow!("journal inconsistent after attempt persist"))?;
        self.record_child_result(&ch, &task, &store)
    }

    /// Harvest: result + assignment status + artifact stored in one
    /// coordinator transaction. REQUIRES exactly one correlated worker
    /// outbox receipt (profile/task/session/key); there is NO fallback to
    /// task.status/output when the receipt is missing or corrupt — the pass
    /// fails closed with no artifact and no root completion.
    fn record_child_result(&self, ch: &ChildRow, task: &Task, store: &ProfileStore) -> Result<()> {
        let receipts: Vec<_> = store
            .outbox()?
            .into_iter()
            .filter(|o| {
                o.task_uuid == task.uuid
                    && o.session_id == task.session_id
                    && o.message_id == ch.message_key
                    && o.profile_uuid == ch.worker_uuid
            })
            .collect();
        if receipts.len() != 1 {
            self.set_child_error(
                ch.id,
                "missing or ambiguous correlated worker receipt; failing closed",
            )?;
            bail!(
                "expected exactly one correlated worker receipt for task {}; failing closed",
                task.uuid
            );
        }
        let r = &receipts[0];
        if r.status != task.status {
            self.set_child_error(ch.id, "worker receipt status disagrees with task status")?;
            bail!(
                "worker receipt status '{}' disagrees with task status '{}'; failing closed",
                r.status,
                task.status
            );
        }
        let content = match task.status.as_str() {
            "completed" => {
                let Some(c) = r.content.clone() else {
                    self.set_child_error(ch.id, "completed receipt missing content")?;
                    bail!("completed worker receipt has no content; failing closed");
                };
                if task.output.as_deref() != Some(c.as_str()) {
                    self.set_child_error(ch.id, "completed receipt content mismatch")?;
                    bail!("completed worker receipt content does not match task output; failing closed");
                }
                c
            }
            _ => r.content.clone().unwrap_or_default(),
        };
        let artifact = if task.status == "completed" {
            let env = child_env(ch)?;
            Some(protocol::make_artifact(
                &env.workflow_id,
                &env.root_task_id,
                &ch.delegation_id,
                &task.uuid,
                &ch.worker_uuid,
                &ch.role,
                &content,
                &format!(
                    "worker_profile={} session={} message_key={} attempt_id={} process_instance_id={}",
                    ch.worker_profile,
                    task.session_id,
                    ch.message_key,
                    ch.attempt_id.clone().unwrap_or_default(),
                    ch.process_instance_id.clone().unwrap_or_default()
                ),
            ))
        } else {
            None
        };
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE children SET worker_status=?1, artifact=?2, updated_at=?3 WHERE id=?4",
            params![
                task.status,
                artifact.as_ref().map(|a| serde_json::to_string(a).unwrap()),
                now(),
                ch.id
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn set_child_error(&self, id: i64, msg: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE children SET last_error=?1, updated_at=?2 WHERE id=?3",
            params![msg, now(), id],
        )?;
        Ok(())
    }

    /// Compute and durably store the root aggregate. Completion REQUIRES
    /// exactly two structurally valid artifacts whose lineage/profile/task/
    /// role/media fields all match the journal; a null or mismatched artifact
    /// never yields completion. A partial artifact is kept if the other
    /// worker failed or is uncertain; uncertain outranks failed.
    fn aggregate(&self, parent: &ParentRow) -> Result<()> {
        let children = self.children(parent.id)?;
        let eff = |c: &ChildRow| -> String {
            if let Some(s) = &c.worker_status {
                return s.clone();
            }
            if c.delivery_state == "rejected" {
                "failed".to_string()
            } else {
                "pending".to_string()
            }
        };
        let statuses: Vec<String> = children.iter().map(eff).collect();
        let status = if parent.cancel_requested != 0 {
            "cancelled"
        } else if statuses.iter().any(|s| s == "uncertain") {
            "uncertain"
        } else if statuses
            .iter()
            .any(|s| s == "failed" || s == "denied" || s == "rejected")
        {
            "failed"
        } else if statuses.iter().all(|s| s == "completed") {
            "completed"
        } else {
            "running"
        };
        if status == "completed" && parent.aggregate.is_none() {
            if children.len() != 2 {
                bail!("completion requires exactly two children; failing closed");
            }
            let mut results = Vec::new();
            for c in &children {
                let a: protocol::Artifact = match c.artifact.as_deref() {
                    Some(s) => serde_json::from_str(s).map_err(|_| {
                        anyhow!("child artifact is corrupt; refusing root completion")
                    })?,
                    None => bail!("completed child has no artifact; refusing root completion"),
                };
                let task_uuid = c.task_uuid.as_deref().ok_or_else(|| {
                    anyhow!("completed child missing task uuid; refusing root completion")
                })?;
                if a.workflow_id != parent.uuid
                    || a.root_task_id != parent.uuid
                    || a.delegation_id != c.delegation_id
                    || a.task_uuid != task_uuid
                    || a.profile_uuid != c.worker_uuid
                    || a.role != c.role
                    || a.media_type != protocol::MEDIA_TYPE_TEXT
                    || a.sha256 != protocol::sha256_hex(&a.content)
                {
                    bail!("child artifact lineage/hash mismatch; refusing root completion");
                }
                results.push(json!({
                    "seq": c.seq,
                    "role": c.role,
                    "delegation_id": c.delegation_id,
                    "profile_uuid": c.worker_uuid,
                    "worker_profile": c.worker_profile,
                    "task_uuid": c.task_uuid,
                    "session_uuid": c.session_uuid,
                    "sha256": a.sha256,
                    "content": a.content,
                }));
            }
            let aggregate = json!({
                "workflow_id": parent.uuid,
                "objective": parent.title,
                "owner_profile": parent.owner_profile,
                "owner_uuid": parent.owner_uuid,
                "results": results,
            })
            .to_string();
            let tx = self.conn.unchecked_transaction()?;
            tx.execute(
                "UPDATE parents SET status=?1, aggregate=?2, updated_at=?3 WHERE id=?4 AND aggregate IS NULL",
                params![status, aggregate, now(), parent.id],
            )?;
            tx.commit()?;
        } else {
            if status == "completed" {
                // Aggregate already persisted: status stays completed.
            }
            self.conn.execute(
                "UPDATE parents SET status=?1, updated_at=?2 WHERE id=?3",
                params![status, now(), parent.id],
            )?;
        }
        Ok(())
    }

    /// Atomically persist parent cancellation BEFORE bounded child
    /// propagation. No new delegated provider execution after cancel.
    pub fn cancel(&self, workflow: &str) -> Result<Value> {
        let parent = self
            .parent_by_uuid(workflow)?
            .ok_or_else(|| anyhow!("workflow '{}' not found", workflow))?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE parents SET cancel_requested=1, status='cancelled', updated_at=?1 WHERE id=?2",
            params![now(), parent.id],
        )?;
        tx.commit()?;
        for ch in self.children(parent.id)? {
            self.propagate_cancel_child(&ch)?;
        }
        self.snapshot_value(workflow)
    }

    /// Bounded per-child cancellation. Never cancels unrelated worker tasks,
    /// never rewrites prior terminal evidence, never stops external processes.
    /// A LOST ACK (pending journal child whose worker task was durably
    /// persisted) is recovered by looking up the immutable namespaced message
    /// key, validating the payload, adopting the durable task/session, ACKing
    /// and then cancelling exactly that task. A forged payload is rejected
    /// untouched; a truly absent task means cancellation without creation.
    fn propagate_cancel_child(&self, ch: &ChildRow) -> Result<()> {
        if ch.delivery_state == "rejected" {
            self.conn.execute(
                "UPDATE children SET cancel_state='cancelled', worker_status=COALESCE(worker_status,'cancelled'), updated_at=?1 WHERE id=?2",
                params![now(), ch.id],
            )?;
            return Ok(());
        }
        if ch.delivery_state == "pending" {
            let store = ProfileStore::open_profile(&self.root, &ch.worker_profile).ok();
            if let Some(store) = store {
                if store.uuid != ch.worker_uuid {
                    self.set_child_error(ch.id, "worker store identity drift detected")?;
                    bail!("worker store identity drift detected; refusing to cancel");
                }
                if let Some(t) = store.task_by_message(&ch.message_key)? {
                    let env = child_env(ch)?;
                    let ok = env.recipient_uuid == ch.worker_uuid
                        && t.prompt == env.task_prompt
                        && t.read_path.is_none()
                        && t.write_path.is_none()
                        && t.write_content.is_none()
                        && store.session(&t.session_id)?.is_some();
                    if !ok {
                        // Rejected forged payload must NOT be touched.
                        self.conn.execute(
                            "UPDATE children SET delivery_state='rejected', last_error=?2, updated_at=?3 WHERE id=?1",
                            params![ch.id, "existing inbox payload differs from expected spec; failing closed", now()],
                        )?;
                        bail!("existing inbox payload for key does not match expected spec; failing closed");
                    }
                    // Adopt the durable task/session (lost ACK) then cancel it.
                    self.conn.execute(
                        "UPDATE children SET session_uuid=?1, task_uuid=?2, delivery_state='acked', last_error=NULL, updated_at=?3 \
                         WHERE id=?4 AND delivery_state='pending'",
                        params![t.session_id, t.uuid, now(), ch.id],
                    )?;
                    let adopted = self
                        .child_by_id(ch.id)?
                        .ok_or_else(|| anyhow!("journal inconsistent after adoption"))?;
                    drop(store);
                    return self.cancel_acked(&adopted);
                }
                // Truly absent: cancelled WITHOUT creating a worker task.
                self.conn.execute(
                    "UPDATE children SET cancel_state='cancelled', worker_status=COALESCE(worker_status,'cancelled'), updated_at=?1 WHERE id=?2",
                    params![now(), ch.id],
                )?;
                return Ok(());
            }
            // Busy worker: parent stays cancelled; later run reconciles.
            self.conn.execute(
                "UPDATE children SET cancel_state='pending_cancel', updated_at=?1 WHERE id=?2",
                params![now(), ch.id],
            )?;
            return Ok(());
        }
        if ch.delivery_state != "acked" {
            return Ok(());
        }
        self.cancel_acked(ch)
    }

    /// Cancel/reconcile one ACKed child. The selected durable task is
    /// revalidated first: an ACKed corrupt task pointer can never cancel or
    /// execute an unrelated (permitted write) task.
    fn cancel_acked(&self, ch: &ChildRow) -> Result<()> {
        let task_uuid = match &ch.task_uuid {
            Some(t) => t.clone(),
            None => return Ok(()),
        };
        let store = match ProfileStore::open_profile(&self.root, &ch.worker_profile) {
            Ok(s) => s,
            Err(_) => {
                self.conn.execute(
                    "UPDATE children SET cancel_state='pending_cancel', updated_at=?1 WHERE id=?2",
                    params![now(), ch.id],
                )?;
                return Ok(());
            }
        };
        let Some(task) = store.task(&task_uuid)? else {
            return Ok(());
        };
        if let Err(e) = self.validate_selected_task(ch, &store, &task) {
            // Fail closed: record the reason, never touch the pointed-at task.
            self.set_child_error(ch.id, &format!("cancellation revalidation failed: {}", e))?;
            return Ok(());
        }
        match task.status.as_str() {
            "queued" => {
                match store.cancel(&task_uuid) {
                    Ok(t) => {
                        self.record_child_result(ch, &t, &store)?;
                        self.conn.execute(
                            "UPDATE children SET cancel_state='reconciled', updated_at=?1 WHERE id=?2",
                            params![now(), ch.id],
                        )?;
                    }
                    Err(_) => {
                        self.conn.execute(
                            "UPDATE children SET cancel_state='pending_cancel', updated_at=?1 WHERE id=?2",
                            params![now(), ch.id],
                        )?;
                    }
                }
                Ok(())
            }
            // Completed/failed/uncertain/cancelled stay visible as-is.
            _ => {
                self.record_child_result(ch, &task, &store)?;
                self.conn.execute(
                    "UPDATE children SET cancel_state='reconciled', updated_at=?1 WHERE id=?2",
                    params![now(), ch.id],
                )?;
                Ok(())
            }
        }
    }

    pub fn list(&self) -> Result<Vec<Value>> {
        let mut stmt = self
            .conn
            .prepare("SELECT uuid, request_id, owner_profile, status, cancel_requested FROM parents ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(json!({
                "workflow": r.get::<_, String>(0)?,
                "request_id": r.get::<_, String>(1)?,
                "owner_profile": r.get::<_, String>(2)?,
                "status": r.get::<_, String>(3)?,
                "cancel_requested": r.get::<_, i64>(4)?,
            }))
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    fn snapshot_value(&self, workflow: &str) -> Result<Value> {
        let parent = self
            .parent_by_uuid(workflow)?
            .ok_or_else(|| anyhow!("workflow '{}' not found", workflow))?;
        Ok(parent_json(&parent, &self.children(parent.id)?))
    }
}

impl ParentRow {
    fn from_row(r: &rusqlite::Row) -> rusqlite::Result<ParentRow> {
        Ok(ParentRow {
            id: r.get(0)?,
            uuid: r.get(1)?,
            request_id: r.get(2)?,
            owner_profile: r.get(3)?,
            owner_uuid: r.get(4)?,
            title: r.get(5)?,
            status: r.get(6)?,
            aggregate: r.get(7)?,
            cancel_requested: r.get(8)?,
        })
    }
}

impl ChildRow {
    fn from_row(r: &rusqlite::Row) -> rusqlite::Result<ChildRow> {
        Ok(ChildRow {
            id: r.get(0)?,
            seq: r.get(1)?,
            delegation_id: r.get(2)?,
            role: r.get(3)?,
            worker_profile: r.get(4)?,
            worker_uuid: r.get(5)?,
            envelope: r.get(6)?,
            message_key: r.get(7)?,
            session_uuid: r.get(8)?,
            task_uuid: r.get(9)?,
            delivery_state: r.get(10)?,
            worker_status: r.get(11)?,
            artifact: r.get(12)?,
            cancel_state: r.get(13)?,
            last_error: r.get(14)?,
            attempt_id: r.get(15)?,
            process_instance_id: r.get(16)?,
        })
    }
}

fn parent_json(p: &ParentRow, children: &[ChildRow]) -> Value {
    json!({
        "workflow": p.uuid,
        "request_id": p.request_id,
        "objective": p.title,
        "owner_profile": p.owner_profile,
        "owner_uuid": p.owner_uuid,
        "status": p.status,
        "cancel_requested": p.cancel_requested != 0,
        "aggregate": serde_json::from_str::<Value>(p.aggregate.as_deref().unwrap_or("null")).unwrap_or(Value::Null),
        "children": children.iter().map(|c| json!({
            "seq": c.seq,
            "delegation_id": c.delegation_id,
            "role": c.role,
            "worker_profile": c.worker_profile,
            "worker_uuid": c.worker_uuid,
            "message_key": c.message_key,
            "delivery_state": c.delivery_state,
            "session_uuid": c.session_uuid,
            "task_uuid": c.task_uuid,
            "worker_status": c.worker_status,
            "cancel_state": c.cancel_state,
            "last_error": c.last_error,
            "attempt_id": c.attempt_id,
            "process_instance_id": c.process_instance_id,
            "artifact": serde_json::from_str::<Value>(c.artifact.as_deref().unwrap_or("null")).unwrap_or(Value::Null),
        })).collect::<Vec<_>>(),
    })
}

fn open_journal_readonly(root: &Path) -> Result<Connection> {
    let ghosts = root.join("ghosts");
    if is_symlink(&ghosts) {
        bail!("ghosts directory must not be a symlink");
    }
    let db = ghosts.join("manager.db");
    if is_symlink(&db) {
        bail!("coordinator journal must not be a symlink");
    }
    if !db.is_file() {
        bail!(
            "no coordinator journal at {} (nothing is created by a read-only API)",
            db.display()
        );
    }
    Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("opening {} read-only", db.display()))
}

/// Public read-only application-boundary API over the journal only. Never
/// creates directories or a database, never takes the writer lock, never runs
/// recovery or touches policy; worker states shown are clearly the
/// last-harvested journal copies. Parent and children are read within one
/// read transaction; a symlinked journal path is rejected.
pub fn snapshot(root: &Path, workflow: &str) -> Result<Value> {
    let conn = open_journal_readonly(root)?;
    let tx = conn.unchecked_transaction()?;
    let parent = tx
        .query_row(
            "SELECT id, uuid, request_id, owner_profile, owner_uuid, title, status, aggregate, cancel_requested \
             FROM parents WHERE uuid=?1",
            params![workflow],
            ParentRow::from_row,
        )
        .optional()?
        .ok_or_else(|| anyhow!("workflow '{}' not found", workflow))?;
    let mut stmt = tx.prepare(
        "SELECT id, seq, delegation_id, role, worker_profile, worker_uuid, '', message_key, \
         session_uuid, task_uuid, delivery_state, worker_status, artifact, cancel_state, last_error, \
         attempt_id, process_instance_id FROM children WHERE parent_id=?1 ORDER BY seq",
    )?;
    let rows = stmt.query_map(params![parent.id], ChildRow::from_row)?;
    let children = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    tx.commit()?;
    Ok(parent_json(&parent, &children))
}

/// Public read-only workflow listing over the journal only: works while a
/// writer holds the coordinator lock, never creates anything, and errors
/// when no journal exists.
pub fn list(root: &Path) -> Result<Vec<Value>> {
    let conn = open_journal_readonly(root)?;
    let tx = conn.unchecked_transaction()?;
    let mut stmt = tx.prepare(
        "SELECT uuid, request_id, owner_profile, status, cancel_requested FROM parents ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(json!({
            "workflow": r.get::<_, String>(0)?,
            "request_id": r.get::<_, String>(1)?,
            "owner_profile": r.get::<_, String>(2)?,
            "status": r.get::<_, String>(3)?,
            "cancel_requested": r.get::<_, i64>(4)?,
        }))
    })?;
    let out = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    tx.commit()?;
    Ok(out)
}
